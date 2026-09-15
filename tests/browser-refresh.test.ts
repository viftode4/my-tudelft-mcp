import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import type { Auth } from '../src/auth.js';
import { BrowserReader } from '../src/browser.js';
import { BrightspaceError } from '../src/errors.js';

afterEach(() => mock.restoreAll());

for (const reconnects of [true, false]) {
  test(`course page expiry uses silent SSO only (renewal succeeds: ${reconnects})`, async () => {
    let renewed = false, renewals = 0, launches = 0, closed = 0;
    const origin = 'https://brightspace.tudelft.nl';
    const auth = {
      config: { baseUrl: origin, timeoutMs: 1000 },
      session: async () => ({ identity: { id: '42' }, storage: { cookies: [], origins: [] } }),
      renewSso: async (id: string) => { assert.equal(id, '42'); renewals++; renewed = reconnects; return renewed; },
    } as unknown as Auth;
    mock.method(chromium, 'launch', async options => {
      assert.equal(options?.headless, true); launches++;
      return { close: async () => { closed++; }, newContext: async () => ({ route: async () => undefined, newPage: async () => ({
        goto: async () => { if (!renewed) throw new BrightspaceError('AUTH_REQUIRED', 'Session expired'); },
        url: () => origin + '/d2l/home', waitForLoadState: async () => undefined,
      }) }) } as unknown as Browser;
    });
    const reader = new BrowserReader(auth);
    if (reconnects) { const page = await reader.open(origin + '/d2l/home'); await page.close(); }
    else await assert.rejects(reader.open(origin + '/d2l/home'), { code: 'AUTH_REQUIRED' });
    assert.equal(renewals, 1); assert.equal(launches, reconnects ? 2 : 1); assert.equal(closed, launches);
  });
}

test('course-page renewal rejects an account changed during the failed read', async () => {
  let accountId = '42', renewals = 0;
  const origin = 'https://brightspace.tudelft.nl';
  const auth = {
    config: { baseUrl: origin, timeoutMs: 1000 },
    session: async () => ({ identity: { id: accountId }, storage: { cookies: [], origins: [] } }),
    renewSso: async () => { renewals++; return true; },
  } as unknown as Auth;
  mock.method(chromium, 'launch', async () => ({ close: async () => undefined, newContext: async () => ({
    route: async () => undefined, newPage: async () => ({
      goto: async () => { accountId = '99'; throw new BrightspaceError('AUTH_REQUIRED', 'Expired'); },
    }),
  }) }) as unknown as Browser);
  await assert.rejects(new BrowserReader(auth).open(origin + '/d2l/home'), { code: 'ACCOUNT_CHANGED' });
  assert.equal(renewals, 0);
});
