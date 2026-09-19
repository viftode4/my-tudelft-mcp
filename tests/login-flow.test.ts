import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { chromium } from 'playwright';
import { runLoginFlow, type LoginFlow } from '../src/login-flow.js';

interface Fake { launches: any[]; contexts: any[]; closed: number; sockets: number; pageClosed: boolean; password: boolean }

function fakeBrowser(state: Fake) {
  const page = {
    isClosed: () => state.pageClosed,
    url: () => 'https://example.test/',
    waitForTimeout: async () => undefined,
    locator: () => ({ first: () => ({ isVisible: async () => state.password }) }),
  };
  return {
    newContext: async (options: unknown) => {
      state.contexts.push(options);
      return {
        routeWebSocket: async () => { state.sockets++; },
        newPage: async () => page,
        on: () => undefined,
      };
    },
    close: async () => { state.closed++; },
  };
}

function flow(state: Fake, overrides: Partial<LoginFlow<string>> = {}): LoginFlow<string> {
  return {
    silent: false,
    storageState: { cookies: [], origins: [] },
    errors: {
      cancelled: { code: 'X_CANCELLED', message: 'cancelled' },
      timeout: { code: 'X_TIMEOUT', message: 'timeout' },
      authRequired: { code: 'X_AUTH_REQUIRED', message: 'auth required' },
    },
    check: async () => undefined,
    start: async () => undefined,
    probe: async () => undefined,
    ...overrides,
  };
}

function setup(): Fake {
  const state: Fake = { launches: [], contexts: [], closed: 0, sockets: 0, pageClosed: false, password: false };
  mock.method(chromium, 'launch', async (options: unknown) => { state.launches.push(options); return fakeBrowser(state) as never; });
  return state;
}

test('the runner returns the probe result and always closes the browser', async () => {
  const state = setup();
  let polls = 0;
  const seen: (unknown | undefined)[] = [];
  const result = await runLoginFlow(flow(state, {
    onBrowser: browser => seen.push(browser),
    probe: async () => ++polls >= 3 ? 'signed-in' : undefined,
  }));
  assert.equal(result, 'signed-in');
  assert.equal(polls, 3);
  assert.equal(state.closed, 1);
  assert.deepEqual(state.launches, [{ headless: false, channel: undefined }]);
  assert.equal(seen.length, 2); assert.notEqual(seen[0], undefined); assert.equal(seen[1], undefined);
  mock.restoreAll();
});

test('silent runs are headless, isolated when asked, and stop at a password page', async () => {
  const state = setup();
  state.password = true;
  await assert.rejects(runLoginFlow(flow(state, { silent: true, isolate: true, channel: 'chrome' })), { code: 'X_AUTH_REQUIRED' });
  assert.deepEqual(state.launches, [{ headless: true, channel: 'chrome' }]);
  assert.equal(state.sockets, 1);
  assert.equal(state.contexts[0].serviceWorkers, 'block');
  assert.equal(state.contexts[0].acceptDownloads, false);
  assert.equal(state.closed, 1);
  mock.restoreAll();
});

test('a closed window is reported as cancelled and an owner check aborts before the browser is used', async () => {
  const state = setup();
  state.pageClosed = true;
  await assert.rejects(runLoginFlow(flow(state)), { code: 'X_CANCELLED' });
  assert.equal(state.closed, 1);
  await assert.rejects(runLoginFlow(flow(state, { check: async () => { throw new Error('owner says no'); } })), /owner says no/);
  assert.equal(state.closed, 2);
  assert.equal(state.contexts.length, 1);
  mock.restoreAll();
});

test('the deadline maps to timeout for interactive runs and auth required for silent runs', async () => {
  const state = setup();
  await assert.rejects(runLoginFlow(flow(state, { interactiveMs: 1 })), { code: 'X_TIMEOUT' });
  await assert.rejects(runLoginFlow(flow(state, { silent: true, silentMs: 1 })), { code: 'X_AUTH_REQUIRED' });
  assert.equal(state.closed, 2);
  mock.restoreAll();
});

test('an installed Chrome or Edge is preferred over the bundled download, and the env override wins', async () => {
  const { detectBrowserChannel, loadConfig } = await import('../src/config.js');
  assert.equal(detectBrowserChannel('darwin', {}, path => path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'chrome');
  assert.equal(detectBrowserChannel('linux', {}, path => path === '/usr/bin/microsoft-edge'), 'msedge');
  assert.equal(detectBrowserChannel('win32', { PROGRAMFILES: 'P:' }, path => path.startsWith('P:') && path.endsWith('chrome.exe')), 'chrome');
  assert.equal(detectBrowserChannel('linux', {}, () => false), undefined);
  assert.equal(loadConfig({ BRIGHTSPACE_BROWSER_CHANNEL: 'chromium' }).browserChannel, 'chromium');
  assert.equal(loadConfig({ BRIGHTSPACE_BROWSER_CHANNEL: 'bundled' }).browserChannel, undefined);
  assert.equal(detectBrowserChannel('darwin', {}, () => false), undefined);
});
