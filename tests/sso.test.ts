import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { BrowserState } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { BrightspaceError } from '../src/errors.js';
import { SharedSso, ssoCookies } from '../src/sso.js';
import { Vault } from '../src/vault.js';

const config = { baseUrl: 'https://brightspace.tudelft.nl', dataDir: 'unused-sso-test-vault' } as Config;
const cookie = (domain = 'login.tudelft.nl', extra: Partial<BrowserState['cookies'][number]> = {}): BrowserState['cookies'][number] =>
  ({ domain, name: 'session', value: 'synthetic-sso', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax', ...extra });
afterEach(() => mock.restoreAll());
function fixture() {
  const state = { saved: null as any, fingerprint: null as string | null, writes: 0, preparing: undefined as (() => void) | undefined };
  mock.method(Vault.prototype, 'fingerprint', async () => state.fingerprint);
  mock.method(Vault.prototype, 'load', async () => structuredClone(state.saved));
  mock.method(Vault.prototype, 'save', async (value: unknown, expected?: string | null, preCommit?: () => void) => {
    state.preparing?.();
    if (expected !== undefined && expected !== state.fingerprint) throw new BrightspaceError('ACCOUNT_CHANGED', 'Synthetic concurrent update.');
    preCommit?.(); state.saved = structuredClone(value); state.fingerprint = 'saved-' + ++state.writes;
  });
  return { state, sso: new SharedSso(config) };
}

test('shared SSO retains only secure unexpired cookies on the exact TU/SURF domains', () => {
  const good = [cookie(), cookie('.surfconext.nl'), cookie('engine.surfconext.nl')];
  assert.deepEqual(ssoCookies([...good, cookie('.tudelft.nl'), cookie('my.tudelft.nl'), cookie('brightspace.tudelft.nl'),
    cookie('login.tudelft.nl.evil.example'), cookie('login.tudelft.nl', { secure: false }), cookie('login.tudelft.nl', { expires: 1 })]), good);
});

test('rotated shared SSO survives a new process and replaces the whole previous cookie snapshot', async () => {
  const { state, sso } = fixture();
  const initial = await sso.open('42', [cookie(), cookie('engine.surfconext.nl')]);
  const rotated = cookie('login.tudelft.nl', { value: 'synthetic-rotated' });
  await initial.save([rotated, cookie('my.tudelft.nl')], () => undefined);
  const next = await new SharedSso(config).open('42', [cookie(), cookie('engine.surfconext.nl')]);
  assert.deepEqual(next.cookies, [rotated]); assert.equal(state.saved.accountId, '42');
  assert.equal('storage' in state.saved, false); assert.equal('accessToken' in state.saved, false);
});

test('empty snapshots preserve cookie deletion and logout invalidates outstanding leases', async () => {
  const { sso } = fixture(); const old = await sso.open('42', [cookie()]);
  await sso.forget('42'); await old.save([cookie()], () => undefined);
  assert.deepEqual((await new SharedSso(config).open('42', [cookie()])).cookies, []);
});

test('a stale concurrent login cannot overwrite newer verified SSO', async () => {
  const { sso } = fixture();
  const first = await sso.open('42', []), second = await sso.open('42', []);
  const newer = cookie('login.tudelft.nl', { value: 'synthetic-newer' });
  await second.save([newer], () => undefined); await first.save([cookie()], () => undefined);
  assert.deepEqual((await sso.open('42', [])).cookies, [newer]);
});

test('SSO storage cannot be reused across accounts or university origins', async () => {
  const { state, sso } = fixture();
  await (await sso.open('42', [])).save([cookie()], () => undefined);
  await assert.rejects(sso.open('99', []), { code: 'SSO_ACCOUNT_UNVERIFIED' });
  state.saved.origin = 'https://other.example';
  await assert.rejects(sso.open('42', []), { code: 'SSO_ACCOUNT_UNVERIFIED' });
  await assert.rejects(new SharedSso({ ...config, baseUrl: 'https://other.example' }).open('42', []), { code: 'SSO_ACCOUNT_UNVERIFIED' });
});

test('cancellation at the encrypted write boundary prevents shared SSO persistence', async () => {
  const { state, sso } = fixture(); const lease = await sso.open('42', []); let cancelled = false;
  state.preparing = () => { cancelled = true; };
  await assert.rejects(lease.save([cookie()], () => { if (cancelled) throw new BrightspaceError('LOGIN_CANCELLED', 'Synthetic cancellation.'); }), { code: 'LOGIN_CANCELLED' });
  assert.equal(state.writes, 0);
});
