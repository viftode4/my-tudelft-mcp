import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { chromium, type APIResponse, type Browser, type BrowserContext, type Route } from 'playwright';
import type { Auth } from '../src/auth.js';
import type { BrightspaceClient } from '../src/client.js';
import { Vault } from '../src/vault.js';
import { Collegerama, guardRecordingLogin, matchRecordingIdentity, recordingMetadata, recordingRequestAllowed } from '../src/collegerama.js';
import { record, type Row } from '../src/util.js';

const origin = 'https://brightspace.tudelft.nl', portal = 'https://collegeramavideoportal.tudelft.nl', connect = 'https://connect.surfconext.nl';
const id = '1111111111111111111111111111111111', url = portal + '/catalogue/example123/presentation/' + id + '?academicYear=2026-2027-example123';
const identity = { accountId: '42', uniqueName: 'student7', emails: [] as string[] };
const claims = { sub: 'provider-subject', schac_home_organization: 'tudelft.nl', uids: ['student7'], name: 'Student Name' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const metadata = () => ({ value: [{ Id: id, Title: 'Lecture one', Description: 'Published description', Duration: 123456, RecordDate: '2026-09-01T10:00:00Z', RecordDateLocal: '2026-09-01T12:00:00', ThumbnailUrl: portal + '/thumbnail?token=private-thumbnail', IsLive: false }] });
const providerState = () => ({ version: 1, brightspaceOrigin: origin, accountId: '42', providerOrigin: portal, authority: connect,
  accessToken: 'private-provider-token', expiresAt: Date.now() + 3600_000, subjectHash: hash(claims.sub), identityMethod: 'institutional_uid', savedAt: new Date().toISOString() });

function fixture() {
  const state = {
    accountId: '42', claims: { ...claims } as Row, topic: { Id: '456', Title: 'Recording', Url: url } as Row,
    toc: { Modules: [{ ModuleId: '1', Topics: [{ TopicId: '456' }], Modules: [] }] } as Row,
    memberships: [{ OrgUnit: { Id: 123 } }] as unknown[], provider: providerState() as Row | null, fingerprint: 'v1',
    calls: [] as { path: string; provider?: boolean; method?: string; authorization?: string }[], saved: [] as Row[], cleared: 0,
    payload: metadata() as unknown, providerStatus: 200, tokenExposed: true, browserClosed: 0, launchOptions: {} as Row,
    storageSeed: {} as Row, routes: [] as unknown[], afterUserinfo: undefined as (() => void) | undefined,
    afterMetadata: undefined as (() => void) | undefined, fetchFailure: false, passwordRequired: false, launches: 0,
  };
  const client = {
    config: { baseUrl: origin }, sessionIdentity: async () => state.accountId,
    list: async (_product: string, path: string) => { state.calls.push({ path }); return { items: structuredClone(state.memberships), complete: true }; },
    json: async (_product: string, path: string) => {
      state.calls.push({ path });
      if (path === 'users/whoami') return { Identifier: state.accountId, UniqueName: 'student7' };
      if (path === '123/content/toc') return structuredClone(state.toc);
      if (path === '123/content/topics/456') return structuredClone(state.topic);
      throw new Error('Unexpected API path.');
    },
  } as unknown as BrightspaceClient;
  const auth = { config: { baseUrl: origin, dataDir: 'not-used-by-mocked-vault', timeoutMs: 1000, maxFileBytes: 1000 },
    sso: async (accountId: string) => ({ accountId, cookies: [
      { domain: '.surfconext.nl', name: 'sso', value: 'private-sso' },
      { domain: 'login.tudelft.nl', name: 'idp', value: 'private-idp' },
    ], save: async (_cookies: unknown, preCommit: () => void) => { preCommit(); } }),
    session: async () => ({ origin, identity: { id: state.accountId, name: 'Do not copy this' }, bearer: 'private-brightspace-bearer',
      storage: { origins: [{ origin, localStorage: [{ name: 'private', value: 'private-storage' }] }], cookies: [
        { domain: 'brightspace.tudelft.nl', name: 'd2lSessionVal', value: 'private-brightspace-cookie' },
        { domain: '.surfconext.nl', name: 'sso', value: 'private-sso' },
        { domain: 'login.tudelft.nl', name: 'idp', value: 'private-idp' },
        { domain: 'unrelated.example', name: 'unrelated', value: 'private-unrelated' },
      ] } }),
  } as unknown as Auth;
  mock.method(Vault.prototype, 'load', async () => structuredClone(state.provider));
  mock.method(Vault.prototype, 'fingerprint', async () => state.provider ? state.fingerprint : null);
  mock.method(Vault.prototype, 'save', async (value: Row, expected: string | null) => {
    assert.equal(expected, state.provider ? state.fingerprint : null); state.saved.push(structuredClone(value)); state.provider = structuredClone(value); state.fingerprint += '-saved';
  });
  mock.method(Vault.prototype, 'clear', async () => { state.provider = null; state.fingerprint += '-cleared'; state.cleared++; });
  mock.method(globalThis, 'fetch', async (input: unknown, init: RequestInit) => {
    const target = new URL(String(input)); state.calls.push({ path: target.href, provider: true, method: init.method, authorization: record(init.headers).authorization as string });
    assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'GET');
    if (state.fetchFailure) throw new Error('Authorization: private-provider-token');
    if (target.href === connect + '/oidc/userinfo') { state.afterUserinfo?.(); return Response.json(state.claims, { status: state.providerStatus }); }
    if (target.href === portal + '/api/v1/nodes/example123/presentations/') { state.afterMetadata?.(); return Response.json(state.payload, { status: state.providerStatus }); }
    throw new Error('Unexpected provider request.');
  });
  const locator = { or() { return this; }, filter() { return this; }, first() { return this; }, count: async () => 1, click: async () => undefined };
  const page = { goto: async () => undefined, isClosed: () => state.browserClosed > 0, url: () => url,
    evaluate: async () => state.tokenExposed ? JSON.stringify({ access_token: 'private-provider-token', expires_at: Math.floor((Date.now() + 3600_000) / 1000), profile: { sub: claims.sub } }) : null,
    locator: () => ({ first() { return this; }, isVisible: async () => state.passwordRequired }),
    getByRole: () => locator, waitForTimeout: async () => { await immediate(); } };
  mock.method(chromium, 'launch', async (options: Row) => { state.launchOptions = options; state.launches++; return {
    close: async () => { state.browserClosed++; }, newContext: async (options: Row) => { state.storageSeed = options.storageState as Row; return {
      routeWebSocket: async () => undefined, route: async (_pattern: string, handler: unknown) => { state.routes.push(handler); }, newPage: async () => page,
      storageState: async () => ({ cookies: [], origins: [] }),
    }; },
  } as unknown as Browser; });
  return { state, client, auth, reader: new Collegerama(auth, client) };
}
afterEach(() => mock.restoreAll());
async function finished(reader: Collegerama): Promise<void> {
  for (let step = 0; step < 100 && reader.status().state === 'waiting'; step++) await immediate();
  assert.notEqual(reader.status().state, 'waiting');
}

test('matches only institutionally scoped identifiers or verified exact email, never display names', () => {
  assert.equal(matchRecordingIdentity(identity, claims), 'institutional_uid');
  assert.equal(matchRecordingIdentity(identity, { sub: 'x', eduperson_principal_name: 'STUDENT7@tudelft.nl' }), 'institutional_principal');
  assert.equal(matchRecordingIdentity(identity, { sub: 'x', email: 'student7@student.tudelft.nl', email_verified: true }), 'verified_institutional_email');
  assert.throws(() => matchRecordingIdentity({ ...identity, emails: ['someone@example.net'] }, { email: 'someone@example.net', email_verified: true }), { code: 'RECORDING_IDENTITY_UNVERIFIED' });
  assert.equal(matchRecordingIdentity({ ...identity, emails: ['s.name@tudelft.nl'] }, { sub: 'x', email: 's.name@tudelft.nl', email_verified: true }), 'verified_institutional_email');
  for (const candidate of [{ sub: 'x', name: 'student7', preferred_username: 'student7' }, { sub: 'x', uids: ['student7'] }, { sub: 'x', email: 'student7@tudelft.nl', email_verified: false }]) {
    assert.throws(() => matchRecordingIdentity(identity, candidate), { code: 'RECORDING_IDENTITY_UNVERIFIED' });
  }
  for (const candidate of [{ sub: 'x', uids: ['someone-else'], schac_home_organization: 'tudelft.nl' }, { sub: 'x', eduperson_principal_name: 'student7@other.example' }, { sub: 'x', uids: ['student7'], schac_home_organization: 'other.example' }]) {
    assert.throws(() => matchRecordingIdentity(identity, candidate), { code: 'RECORDING_ACCOUNT_MISMATCH' });
  }
});

test('unverified identity diagnostics contain safe claim field names and no values', () => {
  assert.throws(() => matchRecordingIdentity(identity, { sub: 'private-subject', name: 'private-name', preferred_username: 'private-name' }), (error: any) => {
    assert.equal(error.code, 'RECORDING_IDENTITY_UNVERIFIED'); assert.deepEqual(error.details.availableClaimNames, ['sub', 'name', 'preferred_username']);
    assert.equal(JSON.stringify(error).includes('private-'), false); return true;
  });
});

test('read verifies the current course and provider account before returning exact metadata only', async () => {
  const { reader, state } = fixture();
  const result = await reader.read('123', '456', { offset: 0, maxChars: 8 });
  assert.deepEqual(state.calls.filter(call => call.provider).map(call => call.path), [connect + '/oidc/userinfo', portal + '/api/v1/nodes/example123/presentations/']);
  assert.ok(state.calls.filter(call => call.provider).every(call => call.authorization === 'Bearer private-provider-token'));
  assert.equal(result.source, 'provider_api'); assert.equal(result.accountVerified, true); assert.equal(result.metadataVerified, true);
  assert.equal(record(result.metadata).id, id); assert.equal(record(result.metadata).durationMs, 123456);
  assert.equal(result.text, 'Lecture '); assert.equal(result.nextOffset, 8); assert.equal(result.complete, false); assert.equal(result.mediaBytesFetched, false);
  assert.equal(record(result.transcript).status, 'not_read'); assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('absent or incorrectly pinned provider state never produces an authenticated request', async () => {
  const { reader, state } = fixture();
  for (const provider of [null, { ...providerState(), accountId: '99' }, { ...providerState(), authority: 'https://other.example' }, { ...providerState(), providerOrigin: 'https://other.example' }]) {
    state.provider = provider; await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_AUTH_REQUIRED' });
  }
  assert.equal(state.calls.some(call => call.provider), false);
});

test('the active token subject and institutional identifier must both agree with the saved binding', async () => {
  const { reader, state } = fixture();
  for (const claim of [{ ...claims, sub: 'another-subject' }, { ...claims, uids: ['another-user'] }]) {
    state.claims = claim; await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_ACCOUNT_MISMATCH' });
  }
  assert.equal(state.calls.some(call => call.path.includes('/presentations/')), false);
});

test('missing membership, hidden/stale/duplicated outline topics and changed detail IDs prevent provider reads', async () => {
  const { reader, state } = fixture();
  state.memberships = [{ OrgUnit: { Id: 123 }, Access: { CanAccess: false } }]; await assert.rejects(reader.read('123', '456'), { code: 'COURSE_NOT_ENROLLED' });
  state.memberships = []; await assert.rejects(reader.read('123', '456'), { code: 'COURSE_NOT_ENROLLED' });
  state.memberships = [{ OrgUnit: { Id: 123 } }];
  for (const toc of [{ Modules: [] }, { Modules: [{ IsHidden: true, Topics: [{ TopicId: 456 }] }] }, { Modules: [{ Topics: [{ TopicId: 456 }, { TopicId: 456 }] }] }, { Modules: [{ Topics: [{ TopicId: 456, IsLocked: true }] }] }]) {
    state.toc = toc; await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_TARGET_UNVERIFIED' });
  }
  state.toc = { Modules: [{ Topics: [{ TopicId: 456 }] }] }; state.topic.Id = 999;
  await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_TARGET_UNVERIFIED' }); assert.equal(state.calls.some(call => call.provider), false);
});

test('only a unique observed portal presentation link can authorize a recording read', async () => {
  const { reader, state } = fixture();
  for (const value of [url.replace('collegeramavideoportal.tudelft.nl', 'collegeramavideoportal.tudelft.nl.evil.example'), url + '&token=secret', url + '&academicYear=other', portal + '/catalogue/example123', 'https://collegerama.tudelft.nl/Mediasite/Play/' + id]) {
    state.topic.Url = value; await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_TARGET_UNVERIFIED' });
  }
  state.topic = { Id: 456, Description: '<p><a href="' + url + '">Watch lecture</a></p>' };
  assert.equal((await reader.read('123', '456')).url, url);
  const validDescription = state.topic.Description;
  state.topic.Description = '<a href="https://example.net/">x</a>'.repeat(200) + validDescription;
  await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_TARGET_UNVERIFIED' });
  state.topic.Description = String(validDescription) + '<a href="' + url.replace(id, '11111111111111111111111111111111d') + '">Other lecture</a>';
  await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_TARGET_UNVERIFIED' });
});

test('account or provider-vault replacement during reads blocks further requests or returned content', async () => {
  const { reader, state } = fixture();
  state.afterUserinfo = () => { state.accountId = '99'; };
  await assert.rejects(reader.read('123', '456'), { code: 'ACCOUNT_CHANGED' });
  assert.equal(state.calls.some(call => call.path.includes('/presentations/')), false);
  state.accountId = '42'; state.afterUserinfo = undefined; state.afterMetadata = () => { state.fingerprint = 'replaced'; };
  await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_SESSION_CHANGED' });
});

test('provider failures are sanitized and only authentication failure gets one silent renewal', async () => {
  const { reader, state } = fixture();
  for (const [status, code] of [[401, 'RECORDING_AUTH_REQUIRED'], [302, 'RECORDING_AUTH_REQUIRED'], [403, 'RECORDING_PERMISSION_DENIED'], [500, 'RECORDING_UNAVAILABLE']] as const) {
    state.providerStatus = status; state.calls.length = 0; await assert.rejects(reader.read('123', '456'), { code });
    assert.equal(state.calls.filter(call => call.provider).length, status === 401 ? 2 : 1);
  }
  state.fetchFailure = true;
  await assert.rejects(reader.read('123', '456'), (error: any) => error.code === 'RECORDING_UNAVAILABLE' && !error.message.includes('private-'));
});

test('metadata parser uses exact presentation IDs, excludes authorization tickets and rejects duplicate/unknown shapes', () => {
  const payload = metadata(); payload.value[0] = { ...payload.value[0]!, authorizationTicket: 'private-ticket', Title: '<script>private-script</script>Lecture', Description: 'See https://school.example/?token=private-token' } as any;
  const result = recordingMetadata(payload, id); assert.equal(JSON.stringify(result).includes('private-'), false); assert.equal(result.title, 'Lecture');
  assert.throws(() => recordingMetadata({ value: [payload.value[0], payload.value[0]] }, id), { code: 'RECORDING_FORMAT_CHANGED' });
  assert.throws(() => recordingMetadata({ value: [] }, id), { code: 'RECORDING_NOT_FOUND' });
  assert.throws(() => recordingMetadata([], id), { code: 'RECORDING_FORMAT_CHANGED' });
  payload.value[0]!.ThumbnailUrl = portal + '/' + 'x'.repeat(5000);
  assert.equal(recordingMetadata(payload, id).thumbnailUrl, undefined);
});

test('metadata transport enforces streamed byte limits and rejects non-JSON responses', async () => {
  const { reader } = fixture(); let call = 0;
  mock.method(globalThis, 'fetch', async () => ++call === 1 ? Response.json(claims) : new Response('<html>private-body</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_FORMAT_CHANGED' });
  call = 0;
  mock.method(globalThis, 'fetch', async () => ++call === 1 ? Response.json(claims) : new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_LIMIT' });
});

test('browser request guard confines auth to the exact portal client and blocks service writes, media and foreign origins', () => {
  const authorize = new URL(connect + '/oidc/authorize');
  for (const [key, value] of Object.entries({ client_id: 'collegeramavideoportal.tudelft.nl-1', redirect_uri: portal + '/callback', response_type: 'code', scope: 'openid profile', state: 'session-state', code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
  assert.equal(recordingRequestAllowed(authorize, 'GET', 'document'), true);
  for (const [key, value] of [['client_id', 'other-app'], ['redirect_uri', 'https://evil.example/callback'], ['scope', 'openid profile email'], ['response_type', 'token'], ['code_challenge_method', 'plain']]) {
    const bad = new URL(authorize); bad.searchParams.set(key!, value!); assert.equal(recordingRequestAllowed(bad, 'GET', 'document'), false);
  }
  const token = new URLSearchParams({ grant_type: 'authorization_code', client_id: 'collegeramavideoportal.tudelft.nl-1', redirect_uri: portal + '/callback', code: 'private-code' });
  assert.equal(recordingRequestAllowed(new URL(connect + '/oidc/token'), 'POST', 'fetch', token.toString()), true);
  assert.equal(recordingRequestAllowed(new URL(connect + '/oidc/token'), 'POST', 'fetch', token.toString() + '&redirect_uri=https://evil.example/callback'), false);
  const duplicate = new URL(authorize); duplicate.searchParams.append('code_challenge_method', 'plain'); assert.equal(recordingRequestAllowed(duplicate, 'GET', 'document'), false);
  assert.equal(recordingRequestAllowed(new URL(connect + '/saml/callback'), 'POST', 'document', 'SAMLResponse=one&SAMLResponse=two'), false);
  assert.equal(recordingRequestAllowed(new URL('https://login.tudelft.nl/sso/SSO/Authenticate'), 'POST', 'document'), true);
  for (const [target, method, type] of [['https://evil.surfconext.nl/saml', 'POST', 'document'], [portal + '/api/v1/authorization-tickets/', 'POST', 'fetch'], [portal + '/api/v1/playlists/', 'POST', 'fetch'], [portal + '/api/v1/nodes/example123/presentations/', 'GET', 'fetch'], [portal + '/movie.mp4', 'GET', 'media'], [connect + '/logout', 'GET', 'document']]) {
    assert.equal(recordingRequestAllowed(new URL(target!), method!, type!), false);
  }
});

test('interactive login opens a visible browser and saves only verified, separate provider credentials', async () => {
  const { reader, state } = fixture(); state.provider = null;
  const status = await reader.beginLogin('123', '456'); assert.equal(status.state, 'waiting'); await finished(reader);
  assert.equal(reader.status().state, 'connected'); assert.equal(state.launchOptions.headless, false);
  assert.deepEqual((state.storageSeed.cookies as Row[]).map(cookie => cookie.domain), ['.surfconext.nl', 'login.tudelft.nl']); assert.deepEqual(state.storageSeed.origins, []);
  assert.equal(state.saved.length, 1); assert.equal(state.saved[0]!.accountId, '42'); assert.equal(state.saved[0]!.accessToken, 'private-provider-token');
  assert.equal(JSON.stringify(state.saved).includes('private-brightspace'), false); assert.equal('storage' in state.saved[0]!, false); assert.equal('id_token' in state.saved[0]!, false);
  assert.equal(JSON.stringify(reader.status()).includes('private-'), false); assert.ok(state.browserClosed > 0); await reader.close();
});

test('provider identity mismatch fails login without storing unbound credentials', async () => {
  const { reader, state } = fixture(); state.provider = null; state.claims = { ...claims, uids: ['another-user'] };
  await reader.beginLogin('123', '456'); await finished(reader);
  assert.equal(reader.status().state, 'failed'); assert.equal(reader.status().error?.code, 'RECORDING_ACCOUNT_MISMATCH'); assert.equal(state.saved.length, 0); await reader.close();
});

test('simultaneous starts share one interactive login and status cannot mutate the active state', async () => {
  const { reader, state } = fixture(); state.provider = null; state.tokenExposed = false;
  const [first, second] = await Promise.all([reader.beginLogin('123', '456'), reader.beginLogin('123', '456')]);
  assert.equal(first.state, 'waiting'); assert.equal(second.state, 'waiting');
  const returned = reader.status(); returned.state = 'connected'; assert.equal(reader.status().state, 'waiting');
  await immediate(); assert.equal(state.routes.length, 1); await reader.close(); assert.equal(state.saved.length, 0); assert.equal(reader.status().state, 'idle');
});

test('close during pending browser launch cancels the login without saving a session', async () => {
  const { reader, state } = fixture(); state.provider = null;
  let release!: (browser: Browser) => void, launched = false;
  mock.method(chromium, 'launch', async () => { launched = true; return new Promise<Browser>(resolve => { release = resolve; }); });
  await reader.beginLogin('123', '456'); for (let i = 0; i < 10 && !launched; i++) await immediate(); assert.equal(launched, true);
  const closing = reader.close(); release({ close: async () => { state.browserClosed++; } } as unknown as Browser); await closing;
  assert.equal(state.saved.length, 0); assert.ok(state.browserClosed > 0);
});

test('provider logout removes only its vault after cancelling login and never logs out Brightspace remotely', async () => {
  const { reader, state } = fixture(); await reader.logout();
  assert.equal(state.cleared, 1); assert.equal(state.provider, null); assert.equal(state.calls.some(call => call.provider), false); assert.equal(reader.status().state, 'idle');
});

test('invalid identifiers and offsets fail before account or provider requests', async () => {
  const { reader, state } = fixture();
  await assert.rejects(reader.read('../123', '456'), { code: 'INVALID_ID' });
  await assert.rejects(reader.read('123', '456', { offset: -1 }), { code: 'INVALID_RANGE' });
  await assert.rejects(reader.read('123', '456', { maxChars: 100001 }), { code: 'INVALID_RANGE' }); assert.equal(state.calls.length, 0);
});

test('closing during an awaited account check prevents a subsequent provider request', async () => {
  const { reader, client, state } = fixture();
  let release!: (value: string) => void, entered = false;
  mock.method(client, 'sessionIdentity', async () => { entered = true; return new Promise<string>(resolve => { release = resolve; }); });
  const checking = (reader as any).unchanged('42', 0);
  assert.equal(entered, true); await reader.close(); release('42');
  await assert.rejects(checking, { code: 'RECORDING_SESSION_CHANGED' });
  assert.equal(state.calls.some(call => call.provider), false);
});

test('user closing the headed page during identity verification cancels before saving', async () => {
  const { reader, state } = fixture(); state.provider = null;
  state.afterUserinfo = () => { state.browserClosed++; };
  await reader.beginLogin('123', '456'); await finished(reader);
  assert.equal(reader.status().error?.code, 'RECORDING_LOGIN_CANCELLED'); assert.equal(state.saved.length, 0);
  await reader.close();
});

async function guardedResponse(requestUrl: string, method: string, status: number, location: string, resourceType = 'document') {
  let handler!: (route: Route) => Promise<void>;
  const context = { route: async (_pattern: string, callback: typeof handler) => { handler = callback; } } as unknown as BrowserContext;
  let fetched = 0, disposed = 0, aborted = 0, fulfilled: Row | undefined;
  const state = await guardRecordingLogin(context, async () => undefined, async () => {
    fetched++; return { status: () => status, headers: () => ({ location }), dispose: async () => { disposed++; } } as unknown as APIResponse;
  });
  const route = { request: () => ({ url: () => requestUrl, method: () => method, resourceType: () => resourceType,
    postData: () => 'private-form-body', isNavigationRequest: () => resourceType === 'document', frame: () => ({ parentFrame: () => null }) }),
    abort: async () => { aborted++; }, fulfill: async (value: Row) => { fulfilled = value; } } as unknown as Route;
  await handler(route); return { state, fetched, disposed, aborted, fulfilled };
}

test('guard fetches an allowed request once and blocks foreign redirects before any destination request', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const result = await guardedResponse('https://login.tudelft.nl/sso/SSO/Authenticate', 'GET', status, 'https://evil.example/collect?secret=private-value');
    assert.equal(result.fetched, 1); assert.equal(result.disposed, 1); assert.equal(result.aborted, 1); assert.equal(result.fulfilled, undefined);
    assert.equal(result.state.failure?.code, 'RECORDING_LOGIN_BLOCKED'); assert.equal(JSON.stringify(result.state).includes('private-value'), false);
  }
  const foreign = await guardedResponse('https://evil.example/collect', 'POST', 200, '');
  assert.equal(foreign.fetched, 0); assert.equal(foreign.aborted, 1);
});

test('guard refuses POST-preserving and fetch redirects, allowing only fresh guarded document GET navigation', async () => {
  for (const status of [307, 308]) {
    const result = await guardedResponse('https://login.tudelft.nl/sso/SSO/Authenticate', 'POST', status, connect + '/saml/continue');
    assert.equal(result.fetched, 1); assert.equal(result.fulfilled, undefined); assert.equal(result.aborted, 1);
  }
  const fetchRedirect = await guardedResponse(connect + '/oidc/userinfo', 'GET', 302, portal + '/callback', 'fetch');
  assert.equal(fetchRedirect.fulfilled, undefined); assert.equal(fetchRedirect.aborted, 1);
  const allowed = await guardedResponse('https://login.tudelft.nl/sso/SSO/Authenticate', 'POST', 302, connect + '/saml/continue');
  assert.equal(allowed.aborted, 0); assert.equal(allowed.fulfilled?.status, 200);
  assert.equal(record(allowed.fulfilled?.headers)['referrer-policy'], 'no-referrer');
  assert.ok(String(allowed.fulfilled?.body).includes('location.replace(')); assert.equal(JSON.stringify(allowed.fulfilled).includes('private-form-body'), false);
});

test('default login guard disables redirect following and retries in the actual route fetch options', async () => {
  let handler!: (route: Route) => Promise<void>, options: Row | undefined;
  const context = { route: async (_pattern: string, callback: typeof handler) => { handler = callback; } } as unknown as BrowserContext;
  await guardRecordingLogin(context, async () => undefined);
  const route = { request: () => ({ url: () => portal + '/', method: () => 'GET', resourceType: () => 'document', isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }) }),
    fetch: async (value: Row) => { options = value; return { status: () => 200, dispose: async () => undefined }; },
    fulfill: async () => undefined, abort: async () => assert.fail('Allowed request was aborted.') } as unknown as Route;
  await handler(route);
  assert.equal(options?.maxRedirects, 0); assert.equal(options?.maxRetries, 0);
});

test('blocked login diagnostics expose only bounded origins, fixed path classes and protocol reasons', async () => {
  const foreign = await guardedResponse('https://login.tudelft.nl/sso/private-path-token?secret=private-query', 'POST', 302,
    'https://unknown.example/private-target-token?ticket=private-ticket#private-fragment');
  const details = record(foreign.state.failure?.details);
  assert.equal(details.reason, 'redirect_origin_not_allowed'); assert.equal(details.stage, 'redirect'); assert.equal(details.status, 302);
  assert.deepEqual(details.request, { origin: 'https://login.tudelft.nl', pathClass: 'university_login', method: 'POST', navigation: 'top' });
  assert.deepEqual(details.destination, { origin: 'https://unknown.example', pathClass: 'unclassified_path' });
  assert.equal(JSON.stringify(details).includes('private-'), false); assert.ok(JSON.stringify(details).length < 700);
  const invalidForm = await guardedResponse(connect + '/oidc/token?private-query', 'POST', 200, '', 'fetch');
  assert.equal(invalidForm.state.failure?.details?.reason, 'oidc_token_parameters');
  assert.equal(record(invalidForm.state.failure?.details?.request).pathClass, 'oidc_token');
  assert.equal(JSON.stringify(invalidForm.state.failure).includes('private-'), false); assert.equal(invalidForm.fetched, 0);
});

test('redirect diagnostics distinguish unsafe replay, non-navigation redirects and unknown auth POST routes', async () => {
  const replay = await guardedResponse('https://login.tudelft.nl/sso/SSO/Authenticate', 'POST', 307, connect + '/saml/private-path?secret=private-query');
  assert.equal(replay.state.failure?.details?.reason, 'redirect_would_preserve_post');
  assert.equal(record(replay.state.failure?.details?.destination).pathClass, 'surf_connect_saml');
  assert.equal(JSON.stringify(replay.state.failure).includes('private-'), false);
  const unknownPost = await guardedResponse('https://engine.surfconext.nl/private-path-token', 'POST', 200, '');
  assert.equal(unknownPost.state.failure?.details?.reason, 'unrecognized_surf_engine_post_path'); assert.equal(unknownPost.fetched, 0);
  const oversizedOrigin = await guardedResponse('https://' + 'x'.repeat(210) + '.example/private-path', 'POST', 200, '');
  assert.equal(record(oversizedOrigin.state.failure?.details?.request).origin, '[unrecognized origin]');
});

test('recording refresh without saved SSO stops before browser launch', async () => {
  const { reader, state, auth } = fixture(); state.provider!.expiresAt = Date.now() - 1;
  mock.method(auth, 'sso', async () => ({ cookies: [], save: async () => undefined }) as any);
  await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_AUTH_REQUIRED' });
  assert.equal(state.launches, 0); assert.equal(state.saved.length, 0);
  await reader.close();
});

test('expired recording access silently renews once for concurrent metadata reads', async () => {
  const { reader, state } = fixture(); state.provider!.expiresAt = Date.now() - 1;
  const results = await Promise.all([reader.read('123', '456'), reader.read('123', '456')]);
  assert.ok(results.every(result => result.metadataVerified));
  assert.equal(state.launches, 1); assert.equal(state.launchOptions.headless, true);
  assert.equal(state.saved.length, 1);
  await reader.close();
});

test('recording refresh stops at a password prompt and never opens a visible fallback', async () => {
  const { reader, state } = fixture(); state.provider!.expiresAt = Date.now() - 1;
  state.tokenExposed = false; state.passwordRequired = true;
  await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_AUTH_REQUIRED' });
  await assert.rejects(reader.read('123', '456'), { code: 'RECORDING_AUTH_REQUIRED' });
  assert.equal(state.launches, 1); assert.equal(state.launchOptions.headless, true);
  assert.equal(state.saved.length, 0);
  await reader.close();
});
