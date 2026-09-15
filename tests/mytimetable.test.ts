import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { MyTimetable, timetableFeedUrl } from '../src/mytimetable.js';
import { Vault } from '../src/vault.js';

const url = 'https://mytimetable.tudelft.nl/ical?synthetic-id&eu=private-student&h=private-signature';
const calendar = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:synthetic-event', 'SUMMARY:Synthetic lecture',
  'DTSTART:20261020T080000Z', 'DTEND:20261020T100000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const from = '2026-10-01T00:00:00Z', to = '2026-11-01T00:00:00Z';
afterEach(() => mock.restoreAll());

function fixture() {
  const state: any = { account: '42', saved: null, fingerprint: null, saves: 0, calls: [], status: 200, body: calendar,
    headers: { 'content-type': 'text/calendar; charset=utf-8' } };
  const reader = new MyTimetable({ baseUrl: 'https://brightspace.tudelft.nl', catalogUrl: 'https://brightspace-cc.tudelft.nl',
    dataDir: 'unused-timetable-test', timeoutMs: 1000, maxFileBytes: 100 }, {
    verifyIdentity: async () => ({ id: state.account, name: 'Synthetic student' }), sessionIdentity: async () => state.account,
  });
  mock.method(Vault.prototype, 'load', async () => state.saved);
  mock.method(Vault.prototype, 'fingerprint', async () => state.fingerprint);
  mock.method(Vault.prototype, 'save', async (value: any, fingerprint: any, preCommit: any) => {
    await state.beforeSave?.(); assert.equal(fingerprint, state.fingerprint); preCommit?.();
    state.saved = value; state.fingerprint = 'saved-' + ++state.saves;
  });
  mock.method(Vault.prototype, 'clear', async () => { state.saved = null; state.fingerprint = null; });
  mock.method(globalThis, 'fetch', async (raw: any, init: any) => {
    state.calls.push({ url: String(raw), init }); await state.afterFetch?.();
    if (state.fetchError) throw new Error('private-signature');
    return new Response(state.body, { status: state.status, headers: state.headers });
  });
  return { reader, state };
}

test('only the exact TU Delft HTTPS calendar subscription route is accepted', () => {
  assert.equal(timetableFeedUrl(url), url);
  assert.equal(timetableFeedUrl(url.replace('https:', 'webcal:')), url);
  for (const invalid of [url.replace('https:', 'http:'), url.replace('tudelft.nl', 'tudelft.nl.evil.example'),
    url.replace('/ical', '/schedule'), url.replace('https://', 'https://student:password@'), url + '#private',
    url + '&h=duplicate', url + '&value=%0d%0a', 'https://mytimetable.tudelft.nl/ical', url + '\n']) {
    assert.throws(() => timetableFeedUrl(invalid), (error: any) => {
      assert.equal(error.code, 'INVALID_TIMETABLE_FEED'); assert.equal(String(error).includes('private'), false); return true;
    });
  }
});

test('connect validates, binds and saves privately; reads are fresh and status has no network call', async () => {
  const { reader, state } = fixture();
  assert.equal((await reader.status()).configured, false);
  const connected = await reader.connect(url);
  assert.equal(connected.connected, true); assert.equal(connected.feedOwnership, 'student_supplied');
  assert.equal(state.saved.accountId, '42'); assert.equal(state.saved.feedUrl, url);
  const status = await reader.status(); assert.equal(status.configured, true); assert.equal(status.liveVerified, false);
  assert.equal(state.calls.length, 1);
  const result = await reader.events(from, to);
  assert.equal((result.items as any[])[0].localStart, '2026-10-20T10:00:00'); assert.equal(state.calls.length, 2);
  assert.equal(JSON.stringify({ connected, status, result }).includes('private-'), false);
  for (const call of state.calls) {
    assert.equal(call.init.method, 'GET'); assert.equal(call.init.redirect, 'manual');
    assert.deepEqual(call.init.headers, { accept: 'text/calendar' });
  }
  await reader.disconnect(); assert.equal(state.saved, null);
  await assert.rejects(reader.events(from, to), { code: 'TIMETABLE_NOT_CONNECTED' });
});

test('redirects, HTTP failures, non-calendar bodies and excessive feeds never replace a connection', async () => {
  const { reader, state } = fixture(); await reader.connect(url);
  for (const variant of [{ status: 302, headers: { location: 'https://evil.example/private' } }, { status: 403 },
    { status: 200, headers: { 'content-type': 'text/html' } },
    { status: 200, headers: { 'content-type': 'text/calendar', 'content-length': String(5 * 1024 * 1024) } },
    { status: 200, headers: { 'content-type': 'text/calendar' }, body: 'not a calendar private-signature' }]) {
    Object.assign(state, variant);
    await assert.rejects(reader.connect(url), (error: any) => {
      assert.match(error.code, /^TIMETABLE_/); assert.equal(String(error).includes('private-'), false); return true;
    });
    assert.equal(state.saves, 1);
  }
  assert.equal(state.calls.length, 6);
});

test('account changes during a fetch discard results and prevent saving', async () => {
  const { reader, state } = fixture();
  state.afterFetch = () => { state.account = 'other'; };
  await assert.rejects(reader.connect(url), { code: 'TIMETABLE_ACCOUNT_CHANGED' }); assert.equal(state.saves, 0);
});

test('saved feeds from another account cannot be used, and invalid input never fetches', async () => {
  const { reader, state } = fixture(); await reader.connect(url);
  state.account = 'other';
  await assert.rejects(reader.events(from, to), { code: 'TIMETABLE_NOT_CONNECTED' });
  await assert.rejects(reader.connect('https://evil.example/ical?private=1'), { code: 'INVALID_TIMETABLE_FEED' });
  await assert.rejects(reader.events(from, from), { code: 'INVALID_RANGE' });
  assert.equal(state.calls.length, 1);
});

test('shutdown at the vault commit boundary cancels a pending connection', async () => {
  const { reader, state } = fixture(); state.beforeSave = () => reader.close();
  await assert.rejects(reader.connect(url), { code: 'TIMETABLE_ACCOUNT_CHANGED' }); assert.equal(state.saves, 0);
});

test('replacement of a saved subscription while fetching discards stale output', async () => {
  const { reader, state } = fixture(); await reader.connect(url);
  state.afterFetch = () => { state.fingerprint = 'changed-elsewhere'; };
  await assert.rejects(reader.events(from, to), { code: 'TIMETABLE_ACCOUNT_CHANGED' });
});

test('network errors are sanitized and disconnect works after a session expires', async () => {
  const { reader, state } = fixture(); await reader.connect(url);
  state.fetchError = true;
  await assert.rejects(reader.events(from, to), (error: any) => {
    assert.equal(error.code, 'TIMETABLE_UNAVAILABLE'); assert.equal(String(error).includes('private-'), false); return true;
  });
  state.account = undefined;
  assert.equal((await reader.disconnect()).remoteSubscriptionRevoked, false); assert.equal(state.saved, null);
});
