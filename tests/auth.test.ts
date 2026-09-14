import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { Auth, discoverVersions, extractIdentity, isBrightspaceHome, isUnsupportedSurfLogin } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { BrightspaceError } from '../src/errors.js';
import { setImmediate as immediate } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright';
const config: Config = { baseUrl: 'https://school.example', catalogUrl: 'https://catalog.example', dataDir: '', timeoutMs: 1000, maxFileBytes: 100 };
afterEach(() => mock.restoreAll());

test('accepts only a same-origin Brightspace home as the login landing page', () => {
  assert.equal(isBrightspaceHome('https://school.example/d2l/home', config.baseUrl), true);
  assert.equal(isBrightspaceHome('https://school.example/d2l/home/123', config.baseUrl), true);
  for (const url of ['https://other.example/d2l/home', 'https://school.example/d2l/home-pretend', 'https://school.example/d2l/login', 'https://name:password@school.example/d2l/home', 'bad input']) assert.equal(isBrightspaceHome(url, config.baseUrl), false);
});

test('identity verification requires a real identifier and keeps names optional', () => {
  assert.deepEqual(extractIdentity({ Identifier: 123, FirstName: 'Example', LastName: 'Student' }), { id: '123', name: 'Example Student' });
  assert.deepEqual(extractIdentity({ Identifier: '123' }), { id: '123', name: '' });
  for (const value of [null, [], {}, { Identifier: '' }, { Identifier: {} }, { Identifier: NaN }]) assert.equal(extractIdentity(value), undefined);
});

test('malformed version discovery fails with a safe actionable error', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ unexpected: 'secret-body' }));
  await assert.rejects(discoverVersions(config), { code: 'API_FORMAT_CHANGED' });
});

test('network failures do not expose sensitive transport diagnostics', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('Authorization: Bearer secret-body'); });
  await assert.rejects(discoverVersions(config), (error: any) => error.code === 'UNAVAILABLE' && !error.message.includes('secret-body'));
});

test('a stored session for another Brightspace origin is never reused', async () => {
  const auth = new Auth(config);
  mock.method(auth.vault, 'load', async () => ({ origin: 'https://other.example', storage: { cookies: [], origins: [] }, savedAt: '' }));
  await assert.rejects(auth.session(), { code: 'AUTH_REQUIRED' });
});


test('logout cancels login while browser launch is still pending', async () => {
  const auth = new Auth(config);
  mock.method(auth.vault, 'load', async () => null);
  mock.method(auth.vault, 'fingerprint', async () => null);
  let releaseBrowser!: (browser: Browser) => void;
  let launched = false, closed = 0;
  mock.method(chromium, 'launch', async () => { launched = true; return new Promise<Browser>((resolve) => { releaseBrowser = resolve; }); });
  auth.beginLogin();
  for (let step = 0; step < 5 && !launched; step++) await Promise.resolve();
  assert.equal(launched, true);
  const closing = auth.close();
  releaseBrowser({ close: async () => { closed++; } } as unknown as Browser);
  await closing;
  assert.equal(closed, 1);
  assert.equal(auth.status.state, 'failed');
  assert.match(auth.status.message, /cancelled/);
});

function loginFixture() {
  const saved = { origin: config.baseUrl, storage: { cookies: [{ name: 'old', value: 'synthetic-old', domain: 'school.example' }], origins: [] }, savedAt: 'previous', identity: { id: '42', name: 'Previous Student' } };
  const state = { saved: structuredClone(saved) as any, fingerprint: 'original', options: {} as any, saves: 0, closed: false,
    url: config.baseUrl + '/d2l/home', errorText: '', errorProbeNavigates: false, identity: { Identifier: '42', FirstName: 'Current', LastName: 'Student' } as any,
    beforeIdentity: undefined as (() => Promise<void>) | undefined, beforeCommit: undefined as (() => Promise<void>) | undefined };
  const auth = new Auth(config);
  mock.method(auth.vault, 'fingerprint', async () => state.fingerprint);
  mock.method(auth.vault, 'load', async () => structuredClone(state.saved));
  mock.method(auth.vault, 'save', async (value: any, expected?: string | null, preCommit?: () => void) => {
    await state.beforeCommit?.();
    if (expected !== state.fingerprint) throw new BrightspaceError('ACCOUNT_CHANGED', 'The saved session changed.');
    preCommit?.(); state.saved = structuredClone(value); state.fingerprint = 'saved'; state.saves++;
  });
  mock.method(globalThis, 'fetch', async () => Response.json([{ ProductCode: 'lp', LatestVersion: '1.0' }, { ProductCode: 'le', LatestVersion: '1.0' }]));
  const page = { url: () => state.url, isClosed: () => state.closed, goto: async () => undefined, waitForLoadState: async () => undefined,
    waitForTimeout: async () => { await immediate(); }, evaluate: async () => {
      if (state.url.includes('engine.surfconext.nl')) {
        if (state.errorProbeNavigates) { state.url = config.baseUrl + '/d2l/home'; throw new Error('Execution context destroyed while navigating a private-url.'); }
        return state.errorText;
      }
      return { bearer: 'synthetic-bearer' };
    } };
  mock.method(chromium, 'launch', async () => ({ close: async () => { state.closed = true; },
    newContext: async (options: any) => { state.options = options; return {
      newPage: async () => page, on: () => undefined,
      cookies: async () => [{ name: 'd2lSessionVal', value: 'synthetic-current', expires: -1 }],
      storageState: async () => ({ cookies: [{ name: 'current', value: 'synthetic-current', domain: 'school.example' }], origins: [] }),
      request: { get: async () => { await state.beforeIdentity?.(); return {
        ok: () => true, headers: () => ({ 'content-type': 'application/json' }), json: async () => state.identity, dispose: async () => undefined,
      }; } },
    }; },
  } as unknown as Browser));
  return { auth, state, saved };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let step = 0; step < 100 && !predicate(); step++) await immediate();
  assert.equal(predicate(), true);
}

test('fresh login creates a clean browser context and commits only a verified current account', async () => {
  const { auth, state } = loginFixture();
  assert.equal(auth.beginLogin('brightspace', { fresh: true }).state, 'waiting');
  assert.equal((await auth.waitForLogin()).state, 'connected');
  assert.equal(state.options.storageState, undefined); assert.equal(state.saves, 1); assert.equal(state.saved.identity.id, '42');
});

test('default login retains the existing storage reuse contract', async () => {
  const { auth, state, saved } = loginFixture();
  auth.beginLogin(); assert.equal((await auth.waitForLogin()).state, 'connected');
  assert.deepEqual(state.options.storageState, saved.storage); assert.equal(state.saves, 1);
});

test('SURF unsolicited-login detection requires the exact origin, endpoint and reported error classification', () => {
  const endpoint = 'https://engine.surfconext.nl/authentication/sp/consume-assertion';
  assert.equal(isUnsupportedSurfLogin(endpoint, 'Unsupported IdP-initiated request. private-account'), true);
  assert.equal(isUnsupportedSurfLogin(endpoint, 'EC66571: IdP initiated authentication is not supported.'), true);
  for (const reference of ['EC: 66571', 'EC:66571', 'EC 66571', 'EC:\n 66571']) {
    const reported = 'Your login request was initiated in a way that is not supported. This can happen without first starting a login from this application. ' + reference;
    assert.equal(isUnsupportedSurfLogin(endpoint, reported), true);
  }
  assert.equal(isUnsupportedSurfLogin(endpoint, 'EC: 66571 Your login request was initiated in a way that is not supported.'), false);
  for (const [url, body] of [[endpoint, 'EC66571'], [endpoint, 'Normal service login'], [endpoint.replace('engine.', 'evil.'), 'Unsupported IdP-initiated request'], [endpoint + '/other', 'Unsupported IdP-initiated request'], ['invalid-url', 'Unsupported IdP-initiated request']]) {
    assert.equal(isUnsupportedSurfLogin(url!, body!), false);
  }
  assert.equal(isUnsupportedSurfLogin(endpoint, 'x'.repeat(40_000) + 'Unsupported IdP-initiated request'), false);
});

test('the reported SURF failure stops promptly without echoing error-page account data or overwriting the session', async () => {
  const { auth, state, saved } = loginFixture();
  state.url = 'https://engine.surfconext.nl/authentication/sp/consume-assertion?secret=private-query';
  state.errorText = 'Your login request was initiated in a way that is not supported. This can happen without first starting a login from this application. EC: 66571 private-account private-claims';
  auth.beginLogin('brightspace', { fresh: true }); const status = await auth.waitForLogin();
  assert.equal(status.state, 'failed'); assert.match(status.message, /fresh login starting from Brightspace/);
  assert.equal(JSON.stringify(status).includes('private-'), false); assert.equal(state.saves, 0); assert.deepEqual(state.saved, saved); assert.equal(state.closed, true);
});

test('an unverified fresh account preserves the identified working session', async () => {
  const { auth, state, saved } = loginFixture(); state.identity = {};
  auth.beginLogin('brightspace', { fresh: true }); const status = await auth.waitForLogin();
  assert.equal(status.state, 'failed'); assert.match(status.message, /could not verify/); assert.equal(state.saves, 0); assert.deepEqual(state.saved, saved);
});

test('cancel during awaited identity verification keeps the previous session', async () => {
  const { auth, state, saved } = loginFixture(); let release!: () => void, verifying = false;
  state.beforeIdentity = () => { verifying = true; return new Promise<void>(resolve => { release = resolve; }); };
  auth.beginLogin('brightspace', { fresh: true }); await until(() => verifying);
  const closing = auth.close(); release(); await closing;
  assert.equal(auth.status.state, 'failed'); assert.equal(state.saves, 0); assert.deepEqual(state.saved, saved);
});

test('closing the page during verification prevents saving even without an explicit cancel call', async () => {
  const { auth, state, saved } = loginFixture();
  state.beforeIdentity = async () => { state.closed = true; };
  auth.beginLogin('brightspace', { fresh: true }); await auth.waitForLogin();
  assert.equal(auth.status.state, 'failed'); assert.equal(state.saves, 0); assert.deepEqual(state.saved, saved);
});

test('cancel during vault preparation is checked again at the commit boundary', async () => {
  const { auth, state, saved } = loginFixture(); let release!: () => void, preparing = false;
  state.beforeCommit = () => { preparing = true; return new Promise<void>(resolve => { release = resolve; }); };
  auth.beginLogin('brightspace', { fresh: true }); await until(() => preparing);
  const closing = auth.close(); release(); await closing;
  assert.equal(auth.status.state, 'failed'); assert.equal(state.saves, 0); assert.deepEqual(state.saved, saved);
});

test('a login cannot replace a newer session saved by another process while it was waiting', async () => {
  const { auth, state } = loginFixture();
  state.beforeIdentity = async () => { state.fingerprint = 'external-replacement'; state.saved = { ...state.saved, identity: { id: '99', name: 'Other Student' } }; };
  auth.beginLogin('brightspace', { fresh: true }); await auth.waitForLogin();
  assert.equal(auth.status.state, 'failed'); assert.equal(state.saves, 0); assert.equal(state.saved.identity.id, '99');
});

test('error-page observation tolerates a normal assertion redirect destroying the execution context', async () => {
  const { auth, state } = loginFixture();
  state.url = 'https://engine.surfconext.nl/authentication/sp/consume-assertion'; state.errorProbeNavigates = true;
  auth.beginLogin('brightspace', { fresh: true }); const status = await auth.waitForLogin();
  assert.equal(status.state, 'connected'); assert.equal(state.saves, 1); assert.equal(state.saved.identity.id, '42');
  assert.equal(JSON.stringify(status).includes('private-'), false);
});
