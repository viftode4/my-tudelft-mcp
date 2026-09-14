import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { chromium, type APIResponse, type BrowserContext, type Route } from 'playwright';
import { MyTuDelft, guardMyTuLogin, matchMyTuIdentity, myTuRequestAllowed, officialGrade, officialGrades } from '../src/mytudelft.js';
import type { Auth } from '../src/auth.js';
import type { BrightspaceClient } from '../src/client.js';
import { BrightspaceError } from '../src/errors.js';
import { Vault } from '../src/vault.js';

const origin = 'https://my.tudelft.nl', api = origin + '/student/osiris';
const oauth = 'https://osi-auth-server-prd.osiris-link.nl', saml = 'https://osiris-saml.tudelft.nl';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Every account/result/value in these tests is synthetic.
const expected = { accountId: '42', studentNumbers: ['1234567'] };
const user = () => ({ studentnummer: 1234567, toegang_applicatie: 'J', naam: 'Synthetic Student', private_profile_field: 'private-profile' });
const row = () => ({ id_resultaat: 'synthetic-result-1', cursus: 'EXAMPLE1000', cursus_korte_naam: 'Synthetic Course', id_cursus: 'synthetic-course',
  toets: 'EX', toets_omschrijving: 'Synthetic exam', resultaat: '7.5', resultaat_omschrijving: 'Synthetic result',
  score: '15', score_omschrijving: 'Synthetic score', weging: 2, toetsdatum: '2026-01-01', mutatiedatum: '2026-01-02', secret: 'private-result-field' });
const saved = () => ({ version: 1, brightspaceOrigin: 'https://brightspace.tudelft.nl', accountId: '42', providerOrigin: origin,
  accessToken: 'private-mytu-token', expiresAt: Date.now() + 3600000, studentHash: hash('1234567'), identityMethod: 'institutional_student_number', savedAt: new Date().toISOString() });
afterEach(() => mock.restoreAll());

function fixture() {
  const state: any = { accountId: '42', studentNumber: '1234567', uniqueName: 'synthetic-netid', ownUserDenied: false,
    contact: {}, afterContact: undefined, provider: saved(), fingerprint: 'initial', user: user(),
    rows: { items: [row()], hasMore: false, offset: 0, limit: 25, count: 1 }, calls: [], saved: [], cleared: 0, browserClosed: 0,
    launchOptions: undefined, contextOptions: undefined, tokenExposed: true, routeHandler: undefined, afterIdentity: undefined, afterGrades: undefined,
    beforeSave: undefined, providerStatus: 200 };
  const client = { config: { baseUrl: 'https://brightspace.tudelft.nl' },
    sessionIdentity: async () => state.accountId,
    json: async (_product: string, path: string) => {
      if (path === 'users/whoami') return { Identifier: '42', UniqueName: state.uniqueName };
      assert.equal(path, 'users/42'); if (state.ownUserDenied) throw new BrightspaceError('PERMISSION_DENIED', 'Synthetic denied own-user profile.'); return { UserId: 42, OrgDefinedId: state.studentNumber };
    } } as unknown as BrightspaceClient;
  const auth = { config: { baseUrl: 'https://brightspace.tudelft.nl', dataDir: 'unused-mytu-test-vault', timeoutMs: 1000 } } as Auth;
  const reader = new MyTuDelft(auth, client);
  mock.method(Vault.prototype, 'fingerprint', async () => state.fingerprint);
  mock.method(Vault.prototype, 'load', async () => state.provider);
  mock.method(Vault.prototype, 'save', async (value: any, fingerprint: any, preCommit: any) => {
    assert.equal(fingerprint, state.fingerprint); await state.beforeSave?.(); preCommit?.(); state.saved.push(value); state.provider = value; state.fingerprint = 'saved';
  });
  mock.method(Vault.prototype, 'clear', async () => { state.cleared++; state.provider = null; });
  mock.method(globalThis, 'fetch', async (raw: any, init: any) => {
    const url = new URL(String(raw)); state.calls.push({ url, init });
    assert.equal(url.origin, origin); assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'GET');
    assert.equal(init.headers.authorization, 'Bearer private-mytu-token'); assert.equal('cookie' in init.headers, false);
    if (state.fetchFailure) throw Error('private-network-detail');
    if (state.providerStatus !== 200) return new Response('private-error-body', { status: state.providerStatus, headers: { location: 'https://evil.example/private-ticket' } });
    if (url.pathname.endsWith('/gebruiker')) { state.afterIdentity?.(); return Response.json(state.user); }
    if (url.pathname.endsWith('/student/contactgegevens')) { state.afterContact?.(); return Response.json(state.contact); }
    state.afterGrades?.();
    return Response.json(url.pathname.endsWith('/synthetic-result-1') ? row() : state.rows);
  });
  const page = { isClosed: () => state.browserClosed > 0,
    goto: async () => {
      if (!state.tokenExposed) return;
      const bytes = Buffer.from(JSON.stringify({ access_token: 'private-mytu-token', expires_in: 3600, token_type: 'bearer' }));
      const response = { status: () => 200, headers: () => ({ 'content-type': 'application/json' }), body: async () => bytes, dispose: async () => undefined };
      const route = { request: () => ({ url: () => api + '/token', method: () => 'POST', resourceType: () => 'fetch',
        postData: () => JSON.stringify({ code: 'private-authorization-code', redirect_uri: '' }), isNavigationRequest: () => false }),
        fetch: async () => response, fulfill: async () => undefined, abort: async () => undefined };
      await state.routeHandler(route);
    },
    waitForTimeout: async () => immediate() };
  const context = { route: async (_pattern: string, callback: any) => { state.routeHandler = callback; },
    routeWebSocket: async () => undefined, newPage: async () => page };
  mock.method(chromium, 'launch', async (options: any) => {
    state.launchOptions = options;
    return { newContext: async (options: any) => { state.contextOptions = options; return context; },
      close: async () => { state.browserClosed++; } } as any;
  });
  return { reader, state, client };
}
async function finished(reader: MyTuDelft) {
  for (let i = 0; i < 50 && reader.status().state === 'waiting'; i++) await immediate();
  assert.notEqual(reader.status().state, 'waiting');
}

test('institutional student number matches exactly and display names provide no account proof', () => {
  assert.equal(matchMyTuIdentity(expected, user()).method, 'institutional_student_number');
  assert.throws(() => matchMyTuIdentity(expected, { ...user(), studentnummer: 7654321 }), { code: 'MYTU_ACCOUNT_MISMATCH' });
  assert.throws(() => matchMyTuIdentity(expected, { naam: 'Synthetic Student', 'private-key-value!': 'private-value' }), (error: any) => {
    assert.equal(error.code, 'MYTU_IDENTITY_UNVERIFIED'); assert.deepEqual(error.details.availableIdentityFields, ['naam']); assert.equal(JSON.stringify(error).includes('private-'), false); return true;
  });
  assert.throws(() => matchMyTuIdentity({ ...expected, studentNumbers: [] }, user()), { code: 'MYTU_IDENTITY_UNVERIFIED' });
  assert.throws(() => matchMyTuIdentity(expected, { ...user(), toegang_applicatie: 'N' }), { code: 'MYTU_PERMISSION_DENIED' });
});

test('official grade normalization returns only observed allowlisted fields and exact identifiers', () => {
  const result = officialGrade(row(), 'synthetic-result-1');
  assert.equal(result.result, '7.5'); assert.equal(result.courseCode, 'EXAMPLE1000');
  assert.equal(result.sourceUrl, origin + '/resultaten/synthetic-result-1'); assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.throws(() => officialGrade(row(), 'different-result'), { code: 'MYTU_FORMAT_CHANGED' });
  assert.throws(() => officialGrade({ ...row(), id_resultaat: '../gebruiker' }), { code: 'MYTU_FORMAT_CHANGED' });
  assert.ok(String(officialGrade({ ...row(), cursus_korte_naam: 'x'.repeat(50000) }).courseName).length <= 1000);
});

test('pagination preserves official result provenance, reports continuation and rejects malformed pages', () => {
  const page = officialGrades({ items: Array.from({ length: 25 }, (_, i) => ({ ...row(), id_resultaat: 'synthetic-' + i })), hasMore: true, count: 30, limit: 25, offset: 0 }, 0, 25);
  assert.equal(page.source, 'official_osiris_api'); assert.equal(page.nextOffset, 25); assert.equal(page.complete, false);
  assert.equal(officialGrades({ items: [], hasMore: false }, 0, 25).complete, true);
  for (const payload of [{ items: [], hasMore: true }, { items: [row()] }, { items: [row(), row()], hasMore: false }, { items: [row()], hasMore: false, offset: 25 }]) {
    assert.throws(() => officialGrades(payload, 0, 25), { code: 'MYTU_FORMAT_CHANGED' });
  }
});

test('official grade read verifies both identities and uses only exact same-origin GET endpoints', async () => {
  const { reader, state } = fixture();
  const auth = await reader.checkAuth(); assert.equal(auth.connected, true); assert.equal(auth.accountVerified, true);
  const results = await reader.grades(); assert.equal(results.accountVerified, true); assert.equal((results.items as any[]).length, 1);
  const detail = await reader.grade('synthetic-result-1'); assert.equal((detail.item as any).id, 'synthetic-result-1');
  assert.ok(state.calls.some((call: any) => call.url.pathname.endsWith('/student/resultaten') && call.url.search === '?offset=0&limit=25'));
  assert.ok(state.calls.every((call: any) => call.init.headers.authorization === 'Bearer private-mytu-token'));
  assert.equal(JSON.stringify([auth, results, detail]).includes('private-'), false);
});

test('missing, expired, wrong-origin or wrong-account sessions prevent provider requests', async () => {
  const { reader, state } = fixture();
  for (const value of [null, { ...saved(), expiresAt: 0 }, { ...saved(), providerOrigin: 'https://evil.example' }, { ...saved(), accountId: '99' }]) {
    state.provider = value; await assert.rejects(reader.grades(), { code: 'MYTU_AUTH_REQUIRED' });
  }
  assert.equal(state.calls.length, 0);
});

test('provider identity mismatch and session replacement stop results before they are returned', async () => {
  const { reader, state } = fixture(); state.user.studentnummer = 7654321;
  await assert.rejects(reader.grades(), { code: 'MYTU_ACCOUNT_MISMATCH' }); assert.equal(state.calls.length, 1);
  state.user = user(); state.afterIdentity = () => { state.accountId = '99'; };
  await assert.rejects(reader.grades(), { code: 'ACCOUNT_CHANGED' }); assert.equal(state.calls.length, 2);
  state.accountId = '42'; state.afterIdentity = undefined; state.afterGrades = () => { state.fingerprint = 'external-replacement'; };
  await assert.rejects(reader.grades(), { code: 'MYTU_SESSION_CHANGED' });
});

test('provider redirects and HTTP failures are sanitized and never followed or retried', async () => {
  const { reader, state } = fixture();
  for (const [status, code] of [[302, 'MYTU_AUTH_REQUIRED'], [401, 'MYTU_AUTH_REQUIRED'], [403, 'MYTU_PERMISSION_DENIED'], [404, 'MYTU_NOT_FOUND'], [500, 'MYTU_UNAVAILABLE']] as const) {
    state.providerStatus = status; state.calls = [];
    await assert.rejects(reader.grades(), (error: any) => error.code === code && !JSON.stringify(error).includes('private-'));
    assert.equal(state.calls.length, 1);
  }
  state.fetchFailure = true;
  await assert.rejects(reader.grades(), (error: any) => error.code === 'MYTU_UNAVAILABLE' && !error.message.includes('private-'));
});

test('invalid range and identifiers fail before account or provider access', async () => {
  const { reader, state } = fixture();
  for (const options of [{ offset: -1 }, { offset: 1000001 }, { limit: 0 }, { limit: 101 }, { limit: 2.5 }]) await assert.rejects(reader.grades(options), { code: 'INVALID_RANGE' });
  await assert.rejects(reader.grade('../gebruiker'), { code: 'INVALID_ID' }); assert.equal(state.calls.length, 0);
});

test('guard accepts observed protocol routes and rejects other services, writes and callback substitutions', () => {
  const authorize = new URL(oauth + '/oauth/authorize?response_type=code&client_id=synthetic-client&redirect_uri=' + encodeURIComponent(origin + '/'));
  assert.equal(myTuRequestAllowed(authorize, 'GET', 'document'), true);
  const duplicate = new URL(authorize); duplicate.searchParams.append('redirect_uri', 'https://evil.example/');
  assert.equal(myTuRequestAllowed(duplicate, 'GET', 'document'), false);
  authorize.searchParams.set('redirect_uri', 'https://evil.example/'); assert.equal(myTuRequestAllowed(authorize, 'GET', 'document'), false);
  assert.equal(myTuRequestAllowed(new URL(api + '/token'), 'POST', 'fetch', JSON.stringify({ code: 'synthetic-code', redirect_uri: '' })), true);
  for (const body of [{ code: 'x', redirect_uri: 'https://evil.example/' }, { refresh_token: 'private-refresh' }, { code: 'x', redirect_uri: '', 'as-student': '7654321' }]) {
    assert.equal(myTuRequestAllowed(new URL(api + '/token'), 'POST', 'fetch', JSON.stringify(body)), false);
  }
  assert.equal(myTuRequestAllowed(new URL(saml + '/osirissaml/saml2/acs/osiris-student'), 'POST', 'document', 'SAMLResponse=synthetic&RelayState=synthetic'), true);
  assert.equal(myTuRequestAllowed(new URL(saml + '/osirissaml/saml2/acs/osiris-student'), 'POST', 'document', 'SAMLResponse=one&SAMLResponse=two'), false);
  for (const [url, method] of [['https://evil.example/', 'GET'], [api + '/student/inschrijvingen', 'POST'], [api + '/student/apparaten/1', 'PUT'], [origin + '/logout', 'GET']]) {
    assert.equal(myTuRequestAllowed(new URL(url!), method!, 'fetch', '{}'), false);
  }
});

async function guarded(method: string, location: string, status = 302, input = 'https://login.tudelft.nl/sso/SSO/Authenticate') {
  let handler!: (route: Route) => Promise<void>;
  const context = { route: async (_pattern: string, callback: typeof handler) => { handler = callback; } } as unknown as BrowserContext;
  let fetched = 0, aborted = 0, disposed = 0, fulfilled: any;
  const state = await guardMyTuLogin(context, async () => undefined, async () => undefined, async () => {
    fetched++; return { status: () => status, headers: () => ({ location }), dispose: async () => { disposed++; } } as unknown as APIResponse;
  });
  const route = { request: () => ({ url: () => input, method: () => method, resourceType: () => 'document', isNavigationRequest: () => true,
    frame: () => ({ parentFrame: () => null }), postData: () => 'private-form-body' }),
    abort: async () => { aborted++; }, fulfill: async (value: any) => { fulfilled = value; } } as unknown as Route;
  await handler(route); return { state, fetched, aborted, disposed, fulfilled };
}

test('redirect interception blocks foreign destinations and POST replays with safe diagnostics', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const result = await guarded('GET', 'https://evil.example/private-path?ticket=private-ticket', status);
    assert.equal(result.fetched, 1); assert.equal(result.aborted, 1); assert.equal(result.disposed, 1); assert.equal(result.fulfilled, undefined);
    assert.equal(result.state.failure?.code, 'MYTU_LOGIN_BLOCKED'); assert.equal(JSON.stringify(result.state).includes('private-'), false);
  }
  const replay = await guarded('POST', saml + '/osirissaml/continue', 307); assert.equal(replay.fulfilled, undefined); assert.equal(replay.state.failure?.details?.reason, 'redirect_would_preserve_post');
  const valid = await guarded('POST', saml + '/osirissaml/continue', 302);
  assert.equal(valid.fulfilled.status, 200); assert.equal(valid.fulfilled.headers['referrer-policy'], 'no-referrer'); assert.equal(valid.aborted, 0);
  const foreign = await guarded('POST', '', 200, 'https://evil.example/private'); assert.equal(foreign.fetched, 0);
});

test('login uses a clean visible browser and saves only verified provider credentials', async () => {
  const { reader, state } = fixture(); state.provider = null;
  assert.equal((await reader.beginLogin()).state, 'waiting'); await finished(reader);
  assert.equal(reader.status().state, 'connected'); assert.equal(state.launchOptions.headless, false);
  assert.equal('storageState' in state.contextOptions, false); assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].accountId, '42'); assert.equal(state.saved[0].studentHash, hash('1234567'));
  assert.equal(state.saved[0].accessToken, 'private-mytu-token'); assert.equal('storage' in state.saved[0], false);
  assert.equal(JSON.stringify(reader.status()).includes('private-'), false); assert.ok(state.browserClosed > 0); await reader.close();
});

test('failed provider identity leaves the previous encrypted session intact', async () => {
  const { reader, state } = fixture(); const previous = state.provider; state.user.studentnummer = 7654321;
  await reader.beginLogin(); await finished(reader);
  assert.equal(reader.status().state, 'failed'); assert.equal(reader.status().error?.code, 'MYTU_ACCOUNT_MISMATCH');
  assert.equal(state.saved.length, 0); assert.equal(state.provider, previous); await reader.close();
});

test('manual browser closure during identity or encryption prevents persistence', async () => {
  for (const phase of ['identity', 'save']) {
    mock.restoreAll(); const { reader, state } = fixture(); const previous = state.provider;
    if (phase === 'identity') state.afterIdentity = () => { state.browserClosed++; };
    else state.beforeSave = async () => { state.browserClosed++; };
    await reader.beginLogin(); await finished(reader);
    assert.equal(reader.status().error?.code, 'MYTU_LOGIN_CANCELLED'); assert.equal(state.saved.length, 0); assert.equal(state.provider, previous); await reader.close();
  }
});

test('concurrent starts share a login and close cancels a pending browser without saving', async () => {
  const { reader, state } = fixture(); state.tokenExposed = false;
  const [a, b] = await Promise.all([reader.beginLogin(), reader.beginLogin()]); assert.equal(a.state, 'waiting'); assert.equal(b.state, 'waiting');
  const external = reader.status(); external.state = 'connected'; assert.equal(reader.status().state, 'waiting');
  await immediate(); await reader.close(); assert.equal(state.saved.length, 0); assert.equal(reader.status().state, 'idle');
});

test('closing during an awaited account check fails before any provider request', async () => {
  const { reader, client, state } = fixture(); let release!: (value: string) => void;
  mock.method(client, 'sessionIdentity', async () => new Promise<string>(resolve => { release = resolve; }));
  const checking = (reader as any).active('42', 0); await reader.close(); release('42');
  await assert.rejects(checking, { code: 'MYTU_SESSION_CHANGED' }); assert.equal(state.calls.length, 0);
});

test('provider logout removes its own local vault without a remote logout or grade request', async () => {
  const { reader, state } = fixture(); await reader.logout(); assert.equal(state.cleared, 1); assert.equal(state.calls.length, 0);
  assert.equal(state.provider, null); assert.equal(reader.status().state, 'idle');
});

test('bounded provider transport rejects HTML and oversized JSON without returning bodies', async () => {
  const { reader } = fixture();
  mock.method(globalThis, 'fetch', async () => new Response('<html>private-content</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(reader.checkAuth(), { code: 'MYTU_FORMAT_CHANGED' });
  mock.method(globalThis, 'fetch', async () => new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(reader.checkAuth(), { code: 'MYTU_LIMIT' });
});


test('inconsistent Brightspace account identifiers cannot authorize a different My TU Delft student', async () => {
  const { reader, client, state } = fixture();
  mock.method(client, 'json', async (_product: string, path: string) => path === 'users/whoami'
    ? { Identifier: '42', OrgDefinedId: '1234567' } : { UserId: 99, OrgDefinedId: '1234567' });
  await assert.rejects(reader.grades(), { code: 'ACCOUNT_CHANGED' }); assert.equal(state.calls.length, 0);
  mock.method(client, 'json', async (_product: string, path: string) => path === 'users/whoami'
    ? { Identifier: '42', OrgDefinedId: '1234567' } : { UserId: 42, OrgDefinedId: '7654321' });
  await assert.rejects(reader.grades(), { code: 'MYTU_IDENTITY_UNVERIFIED' }); assert.equal(state.calls.length, 0);
});

test('duplicate token JSON protocol keys and unobserved GET token flows are rejected', () => {
  const token = new URL(api + '/token');
  assert.equal(myTuRequestAllowed(token, 'POST', 'fetch', '{"code":"x","redirect_uri":"https://evil.example/","redirect_uri":""}'), false);
  assert.equal(myTuRequestAllowed(token, 'POST', 'fetch', '{"code":"x","redirect_uri":"","redirect\\u005furi":""}'), false);
  assert.equal(myTuRequestAllowed(token, 'GET', 'fetch'), false);
  assert.equal(myTuRequestAllowed(new URL(api + '/token?code=private-code'), 'GET', 'fetch'), false);
});

test('short nonfinal pages and unsafe numeric result identifiers cannot silently skip or round results', () => {
  assert.throws(() => officialGrades({ items: [row()], hasMore: true }, 0, 25), { code: 'MYTU_FORMAT_CHANGED' });
  assert.throws(() => officialGrade({ ...row(), id_resultaat: Number.MAX_SAFE_INTEGER + 1 }), { code: 'MYTU_FORMAT_CHANGED' });
  assert.equal(officialGrade({ ...row(), id_resultaat: 17 }).id, '17');
});

test('beginLogin cannot open a new browser while close is awaiting shutdown', async () => {
  const { reader, state } = fixture(); let release!: () => void;
  (reader as any).browser = { close: async () => new Promise<void>(resolve => { release = resolve; }) };
  const closing = reader.close();
  await assert.rejects(reader.beginLogin(), { code: 'MYTU_SESSION_CHANGED' });
  release(); await closing; assert.equal(state.launchOptions, undefined); assert.equal(state.saved.length, 0);
});

test('beginLogin remains blocked through provider-vault removal and simultaneous logouts share completion', async () => {
  const { reader, state } = fixture(); let release!: () => void, clearing = false;
  mock.method(Vault.prototype, 'clear', async () => { clearing = true; return new Promise<void>(resolve => { release = resolve; }); });
  const first = reader.logout(), second = reader.logout();
  for (let i = 0; i < 10 && !clearing; i++) await immediate(); assert.equal(clearing, true);
  await assert.rejects(reader.beginLogin(), { code: 'MYTU_SESSION_CHANGED' });
  release(); await Promise.all([first, second]); assert.equal(state.launchOptions, undefined);
});


test('OSIRIS authorization accepts the observed bare-origin callback and only its equivalent root spelling', () => {
  const authorize = new URL(oauth + '/oauth/authorize');
  authorize.searchParams.set('response_type', 'code'); authorize.searchParams.set('client_id', 'synthetic-client');
  for (const callback of [origin, origin + '/']) {
    authorize.searchParams.set('redirect_uri', callback); assert.equal(myTuRequestAllowed(authorize, 'GET', 'document'), true);
  }
  for (const callback of [origin + '/login', origin + '/?next=elsewhere', origin + '/#private-fragment', origin + '.evil.example/', 'https://private-user@my.tudelft.nl/', 'http://my.tudelft.nl/']) {
    authorize.searchParams.set('redirect_uri', callback); assert.equal(myTuRequestAllowed(authorize, 'GET', 'document'), false);
  }
  authorize.searchParams.set('redirect_uri', origin); authorize.searchParams.append('redirect_uri', origin + '/');
  assert.equal(myTuRequestAllowed(authorize, 'GET', 'document'), false);
});


const institutional = 'synthetic.student@student.tudelft.nl';
const emailExpected = { accountId: '42', studentNumbers: [] as string[], institutionalEmail: institutional };
const contact = () => ({ e_mailadres: institutional, mag_e_mailadres_lezen: 'J', mag_e_mailadres_wijzigen: 'N',
  extern_emailadres: 'private-external@example.test', e_mailadres_aanmelding: 'private-application@example.test', adressen: ['private-address'] });
function emailFixture() {
  const result = fixture(); result.state.ownUserDenied = true; result.state.uniqueName = institutional;
  result.state.user.e_mailadres = institutional; result.state.contact = contact(); result.state.provider.identityMethod = 'institutional_email';
  return result;
}

test('strict email fallback requires the same full institutional main address and explicit read-only permissions', () => {
  const account = { ...user(), e_mailadres: institutional };
  assert.equal(matchMyTuIdentity(emailExpected, account, contact()).method, 'institutional_email');
  assert.equal(matchMyTuIdentity({ ...emailExpected, institutionalEmail: institutional.toUpperCase() },
    { ...account, e_mailadres: ' ' + institutional.toUpperCase() + ' ' }, contact()).method, 'institutional_email');
  for (const details of [{ ...contact(), mag_e_mailadres_lezen: 'N' }, { ...contact(), mag_e_mailadres_wijzigen: 'J' },
    { ...contact(), mag_e_mailadres_wijzigen: undefined }, { ...contact(), mag_e_mailadres_lezen: undefined },
    { ...contact(), e_mailadres: undefined }]) {
    assert.throws(() => matchMyTuIdentity(emailExpected, account, details), { code: 'MYTU_IDENTITY_UNVERIFIED' });
  }
  assert.throws(() => matchMyTuIdentity(emailExpected, { ...account, studentnummer: undefined }, contact()), { code: 'MYTU_IDENTITY_UNVERIFIED' });
  assert.throws(() => matchMyTuIdentity(emailExpected, account, { ...contact(), e_mailadres: 'someone.else@student.tudelft.nl' }), { code: 'MYTU_ACCOUNT_MISMATCH' });
});

test('email proof rejects external addresses, alias/domain guesses, missing main email and conflicting student numbers', () => {
  const account = { ...user(), e_mailadres: institutional };
  assert.throws(() => matchMyTuIdentity({ ...expected, institutionalEmail: institutional },
    { ...account, studentnummer: 7654321 }, contact()), { code: 'MYTU_ACCOUNT_MISMATCH' });
  assert.throws(() => matchMyTuIdentity(emailExpected, { ...account, e_mailadres: 'synthetic.student@tudelft.nl' }, contact()), { code: 'MYTU_ACCOUNT_MISMATCH' });
  assert.throws(() => matchMyTuIdentity(emailExpected, { ...account, e_mailadres: 'synthetic.student@student.tudelft.nl.evil.example' }, contact()), { code: 'MYTU_IDENTITY_UNVERIFIED' });
  assert.throws(() => matchMyTuIdentity({ ...emailExpected, institutionalEmail: 'synthetic@example.test' },
    { ...account, e_mailadres: 'synthetic@example.test' }, { ...contact(), e_mailadres: 'synthetic@example.test' }), { code: 'MYTU_IDENTITY_UNVERIFIED' });
  assert.throws(() => matchMyTuIdentity(emailExpected, { ...account, e_mailadres: undefined, extern_emailadres: institutional, e_mailadres_aanmelding: institutional }, contact()), { code: 'MYTU_IDENTITY_UNVERIFIED' });
  assert.throws(() => matchMyTuIdentity(emailExpected, account, { ...contact(), e_mailadres: undefined, extern_emailadres: institutional, e_mailadres_aanmelding: institutional }), { code: 'MYTU_IDENTITY_UNVERIFIED' });
});

test('a verified student-number match does not request contact details or require equal email aliases', async () => {
  const { reader, state } = fixture(); state.uniqueName = institutional; state.user.e_mailadres = 'different.alias@tudelft.nl';
  const result = await reader.checkAuth(); assert.equal(result.identityMethod, 'institutional_student_number');
  assert.equal(state.calls.length, 1); assert.equal(state.calls.some((call: any) => call.url.pathname.endsWith('/contactgegevens')), false);
});

test('email fallback verifies the own contact endpoint and stable account when Brightspace denies student-number lookup', async () => {
  const { reader, state } = emailFixture(); const result = await reader.checkAuth();
  assert.equal(result.identityMethod, 'institutional_email'); assert.equal(result.accountVerified, true);
  assert.deepEqual(state.calls.map((call: any) => call.url.pathname), ['/student/osiris/gebruiker', '/student/osiris/student/contactgegevens', '/student/osiris/gebruiker']);
  assert.equal(JSON.stringify(result).includes(institutional), false); assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('email login persists only the verified stable student hash and reports its real matching method', async () => {
  const { reader, state } = emailFixture(); state.provider = null;
  await reader.beginLogin(); await finished(reader);
  assert.equal(reader.status().state, 'connected'); assert.equal(reader.status().identityMethod, 'institutional_email');
  assert.ok(reader.status().message.includes('institutional email'));
  assert.equal(state.saved.length, 1); assert.equal(state.saved[0].studentHash, hash('1234567')); assert.equal(state.saved[0].identityMethod, 'institutional_email');
  assert.equal(JSON.stringify(state.saved).includes(institutional), false); assert.equal(JSON.stringify(state.saved).includes('private-address'), false);
  await reader.close();
});

test('unavailable or mismatching initial email and conflicting student number prevent unnecessary contact reads', async () => {
  const { reader, state } = emailFixture();
  state.user.e_mailadres = 'different@student.tudelft.nl';
  await assert.rejects(reader.checkAuth(), { code: 'MYTU_ACCOUNT_MISMATCH' });
  state.user.e_mailadres = institutional; state.uniqueName = 'synthetic-netid';
  await assert.rejects(reader.checkAuth(), { code: 'MYTU_IDENTITY_UNVERIFIED' });
  state.uniqueName = institutional; state.ownUserDenied = false; state.studentNumber = '7654321';
  await assert.rejects(reader.checkAuth(), { code: 'MYTU_ACCOUNT_MISMATCH' });
  assert.equal(state.calls.some((call: any) => call.url.pathname.endsWith('/contactgegevens')), false);
});

test('editable or conflicting main contact email fails closed without returning any result data', async () => {
  const { reader, state } = emailFixture(); state.contact.mag_e_mailadres_wijzigen = 'J';
  await assert.rejects(reader.grades(), { code: 'MYTU_IDENTITY_UNVERIFIED' });
  state.contact = contact(); state.contact.e_mailadres = 'different@student.tudelft.nl';
  await assert.rejects(reader.grades(), { code: 'MYTU_ACCOUNT_MISMATCH' });
  assert.equal(state.calls.some((call: any) => call.url.pathname.includes('/resultaten')), false);
});

test('provider student identity changes across email verification or saved use are rejected', async () => {
  const { reader, state } = emailFixture();
  state.afterContact = () => { state.user.studentnummer = 7654321; };
  await assert.rejects(reader.grades(), { code: 'MYTU_ACCOUNT_MISMATCH' });
  state.afterContact = undefined;
  await assert.rejects(reader.grades(), { code: 'MYTU_ACCOUNT_MISMATCH' });
  assert.equal(state.calls.some((call: any) => call.url.pathname.includes('/resultaten')), false);
});

test('account changes and user cancellation during contact verification stop the next read and persistence', async () => {
  const { reader, state } = emailFixture();
  state.afterContact = () => { state.accountId = '99'; };
  await assert.rejects(reader.grades(), { code: 'ACCOUNT_CHANGED' }); assert.equal(state.calls.length, 2);
  state.accountId = '42'; state.afterContact = () => { state.browserClosed++; }; state.provider = null; state.calls = [];
  await reader.beginLogin(); await finished(reader);
  assert.equal(reader.status().error?.code, 'MYTU_LOGIN_CANCELLED'); assert.equal(state.saved.length, 0); assert.equal(state.calls.length, 2);
  await reader.close();
});

test('contact details cannot be fetched with an arbitrary identity or query parameter', async () => {
  const { reader, state } = emailFixture();
  for (const path of ['/student/contactgegevens/1234567', '/student/contactgegevens?studentnummer=1234567', '/student/contactgegevens?offset=0&limit=25']) {
    await assert.rejects((reader as any).api(path, 'private-mytu-token'), { code: 'MYTU_TARGET_UNVERIFIED' });
  }
  assert.equal(state.calls.length, 0);
});
