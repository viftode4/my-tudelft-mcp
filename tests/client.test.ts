import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { request, type APIRequestContext } from 'playwright';
import { BrightspaceClient } from '../src/client.js';
import type { Auth, Session } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { BrightspaceError } from '../src/errors.js';

const config: Config = { baseUrl: 'https://school.example', catalogUrl: 'https://catalog.example', dataDir: '', timeoutMs: 1000, maxFileBytes: 100 };
const response = (status: number, data: unknown = {}, headers: Record<string, string> = { 'content-type': 'application/json' }) => ({
  status: () => status, ok: () => status >= 200 && status < 300, headers: () => headers, json: async () => data, text: async () => typeof data === 'string' ? data : JSON.stringify(data), dispose: async () => {},
});
function fixture(get: (url: string, options: any) => Promise<unknown>, post: (url: string, options: any) => Promise<unknown> = async () => response(400)) {
  let session: Session = { origin: config.baseUrl, savedAt: 'initial', bearer: 'test-old-bearer', csrf: 'test-csrf', storage: { cookies: [], origins: [] } };
  const context = { get, post, storageState: async () => session.storage, dispose: async () => {} };
  mock.method(request, 'newContext', async () => context as unknown as APIRequestContext);
  mock.method(globalThis, 'fetch', async () => Response.json([{ ProductCode: 'lp', LatestVersion: '1.63' }, { ProductCode: 'le', LatestVersion: '1.97' }]));
  const auth = { session: async () => structuredClone(session), vault: { fingerprint: async () => session.savedAt + ':' + (session.identity?.id ?? ''), save: async (state: Session, expected?: string | null) => { if (expected !== undefined && expected !== session.savedAt + ':' + (session.identity?.id ?? '')) throw new BrightspaceError('ACCOUNT_CHANGED', 'Saved session changed.'); session = structuredClone(state); } } } as unknown as Auth;
  return { client: new BrightspaceClient(config, auth), auth, session: () => session };
}
afterEach(() => mock.restoreAll());

test('follows bookmark pagination and reports a real continuation when bounded', async () => {
  const requested: string[] = [];
  const { client } = fixture(async (url) => {
    requested.push(url);
    return response(200, { Items: [requested.length], PagingInfo: { HasMoreItems: true, Bookmark: `cursor-${requested.length}` } });
  });
  try {
    const result = await client.list('lp', 'enrollments/myenrollments/', { orgUnitTypeId: '3' }, 2);
    assert.deepEqual(result, { items: [1, 2], complete: false, nextBookmark: 'cursor-2' });
    assert.equal(new URL(requested[1]!).searchParams.get('bookmark'), 'cursor-1');
    assert.equal(new URL(requested[1]!).searchParams.get('orgUnitTypeId'), '3');
  } finally { await client.close(); }
});

test('follows ObjectListPage Next as a URL rather than a bookmark', async () => {
  const requested: string[] = [];
  const { client } = fixture(async (url) => {
    requested.push(url);
    return response(200, requested.length === 1 ? { Objects: [1], Next: '/d2l/api/le/1.97/123/quizzes/?page=2' } : { Objects: [2], Next: null });
  });
  try {
    assert.deepEqual(await client.list('le', '123/quizzes/'), { items: [1, 2], complete: true });
    assert.equal(requested[1], 'https://school.example/d2l/api/le/1.97/123/quizzes/?page=2');
  } finally { await client.close(); }
});

test('refuses pagination that would disclose authentication to another origin or a non-API route', async () => {
  for (const next of ['https://outside.example/collect', '/account/session']) {
    const calls: string[] = [];
    const { client } = fixture(async (url) => { calls.push(url); return response(200, { Objects: [1], Next: next }); });
    try {
      await assert.rejects(client.list('le', '123/quizzes/'), { code: next.startsWith('https:') ? 'EXTERNAL_RESOURCE' : 'INVALID_API_PATH' });
      assert.equal(calls.length, 1);
    } finally { await client.close(); mock.restoreAll(); }
  }
});

test('detects repeated pagination cursors', async () => {
  const { client } = fixture(async () => response(200, { Items: [1], PagingInfo: { HasMoreItems: true, Bookmark: 'same-cursor' } }));
  try { await assert.rejects(client.list('lp', 'enrollments/myenrollments/'), { code: 'PAGINATION_ERROR' }); }
  finally { await client.close(); }
});

test('confines API paths including encoded traversal', async () => {
  let calls = 0;
  const { client } = fixture(async () => { calls++; return response(200); });
  try {
    for (const path of ['../../../../account', '%2e%2e/users/whoami', 'users/whoami?secret=abc', 'users\\whoami']) {
      await assert.rejects(client.json('lp', path), { code: 'INVALID_API_PATH' });
    }
    assert.equal(calls, 0);
  } finally { await client.close(); }
});

test('concurrent expired API requests share a single token renewal', async () => {
  let renewals = 0;
  const { client, session } = fixture(async (_url, options) => response(options.headers.Authorization === 'Bearer test-renewed-bearer' ? 200 : 401, { Identifier: 123 }), async () => {
    renewals++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response(200, { access_token: 'test-renewed-bearer' });
  });
  try {
    const values = await Promise.all([client.json('lp', 'users/whoami'), client.json('lp', 'users/whoami')]);
    assert.equal(values.length, 2);
    assert.equal(renewals, 1);
    assert.equal(session().bearer, 'test-renewed-bearer');
  } finally { await client.close(); }
});

test('maps an HTML login response to reconnect without returning the page', async () => {
  const { client } = fixture(async () => response(200, '<html>login page</html>', { 'content-type': 'text/html' }));
  try { await assert.rejects(client.json('lp', 'users/whoami'), { code: 'AUTH_REQUIRED' }); }
  finally { await client.close(); }
});

test('never retries a submission with an unknown network or server outcome', async () => {
  for (const kind of ['network', 'server']) {
    let posts = 0;
    const { client } = fixture(async () => response(200), async (_url, options) => {
      posts++;
      assert.equal(options.maxRetries, 0);
      assert.equal(options.maxRedirects, 0);
      if (kind === 'network') throw new Error('sensitive transport details');
      return response(503);
    });
    try {
      await assert.rejects(client.postMultipart('le', '123/dropbox/folders/456/submissions/mysubmissions/', Buffer.from('test'), 'multipart/mixed; boundary=test'), { code: 'SUBMISSION_OUTCOME_UNKNOWN' });
      assert.equal(posts, 1);
    } finally { await client.close(); mock.restoreAll(); }
  }
});

test('returns the structured upload receipt', async () => {
  const { client } = fixture(async () => response(200), async () => response(201, { Id: 42 }));
  try { assert.deepEqual(await client.postMultipart('le', '123/dropbox/folders/456/submissions/mysubmissions/', Buffer.from('test'), 'multipart/mixed; boundary=test'), { status: 201, data: { Id: 42 } }); }
  finally { await client.close(); }
});

test('download blocks an external redirect before forwarding cookies', async () => {
  const { client, session } = fixture(async () => response(200));
  session().storage.cookies.push({ name: 'd2lSessionVal', value: 'test-cookie', domain: 'school.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (input: unknown, init: any) => {
    calls.push(String(input));
    assert.equal(init.headers.Cookie, 'd2lSessionVal=test-cookie');
    assert.equal(init.headers.Authorization, undefined);
    return new Response(null, { status: 302, headers: { location: 'https://outside.example/file.pdf' } });
  });
  try {
    await assert.rejects(client.download('/content/file.pdf'), { code: 'EXTERNAL_RESOURCE' });
    assert.equal(calls.length, 1);
  } finally { await client.close(); }
});

test('download enforces streaming byte limit when Content-Length is missing', async () => {
  const { client } = fixture(async () => response(200));
  mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(101), { headers: { 'content-type': 'application/pdf' } }));
  try { await assert.rejects(client.download('/content/file.pdf'), { code: 'FILE_TOO_LARGE' }); }
  finally { await client.close(); }
});


test('accepts an empty successful submission response for receipt verification', async () => {
  const { client } = fixture(async () => response(200), async (_url, options) => {
    assert.equal(options.headers['Content-Length'], '4');
    return response(200, '', {});
  });
  try { assert.deepEqual(await client.postMultipart('le', '123/dropbox/folders/456/submissions/mysubmissions/', Buffer.from('test'), 'multipart/mixed; boundary=test'), { status: 200, data: null }); }
  finally { await client.close(); }
});

test('redirects and HTML upload responses are ambiguous and never retried', async () => {
  for (const status of [200, 302]) {
    let calls = 0;
    const { client } = fixture(async () => response(200), async () => { calls++; return response(status, '<html>session</html>', { 'content-type': 'text/html' }); });
    try {
      await assert.rejects(client.postMultipart('le', '123/dropbox/folders/456/submissions/mysubmissions/', Buffer.from('test'), 'multipart/mixed; boundary=test'), { code: 'SUBMISSION_OUTCOME_UNKNOWN' });
      assert.equal(calls, 1);
    } finally { await client.close(); mock.restoreAll(); }
  }
});


test('external account replacement blocks cached API and write contexts until reset', async () => {
  let gets = 0, posts = 0;
  const { client, session } = fixture(async () => { gets++; return response(200, { Identifier: 1 }); }, async () => { posts++; return response(200, ''); });
  session().identity = { id: '1', name: 'First student' };
  try {
    assert.equal(await client.sessionIdentity(), '1');
    await client.json('lp', 'users/whoami');
    session().identity = { id: '2', name: 'Second student' }; session().savedAt = 'replacement';
    await assert.rejects(client.json('lp', 'users/whoami'), { code: 'ACCOUNT_CHANGED' });
    await assert.rejects(client.sessionIdentity(), { code: 'ACCOUNT_CHANGED' });
    await assert.rejects(client.postMultipart('le', '123/dropbox/folders/456/submissions/mysubmissions/', Buffer.from('test'), 'multipart/mixed; boundary=test'), { code: 'ACCOUNT_CHANGED' });
    assert.equal(gets, 1); assert.equal(posts, 0);
    await client.reset();
    assert.equal(await client.sessionIdentity(), '2');
  } finally { await client.close(); }
});

test('same-account vault renewal does not invalidate the bound course account', async () => {
  const { client, session } = fixture(async () => response(200, { Identifier: 1 }));
  session().identity = { id: '1', name: 'Student' };
  try {
    assert.equal(await client.sessionIdentity(), '1');
    session().savedAt = 'renewed';
    assert.equal(await client.sessionIdentity(), '1');
  } finally { await client.close(); }
});


test('an account change during an API response is rejected before exposing data', async () => {
  const { client, session } = fixture(async () => {
    session().identity = { id: '2', name: 'Replacement student' }; session().savedAt = 'replacement';
    return response(200, { privateCourseData: 'first-account' });
  });
  session().identity = { id: '1', name: 'First student' };
  try { await assert.rejects(client.json('lp', 'users/whoami'), { code: 'ACCOUNT_CHANGED' }); }
  finally { await client.close(); }
});

test('expired credentials cannot silently renew into a different saved account', async () => {
  let posts = 0;
  const { client, session } = fixture(async () => {
    session().identity = { id: '2', name: 'Replacement student' }; session().savedAt = 'replacement';
    return response(401);
  }, async () => { posts++; return response(200, { access_token: 'replacement-token' }); });
  session().identity = { id: '1', name: 'First student' };
  try {
    await assert.rejects(client.json('lp', 'users/whoami'), { code: 'ACCOUNT_CHANGED' });
    assert.equal(posts, 0);
  } finally { await client.close(); }
});


test('verified whoami repairs a browser-only session without another interactive login', async () => {
  const { client, session } = fixture(async () => response(200, { Identifier: 42, FirstName: 'Example', LastName: 'Student' }));
  const original = structuredClone(session());
  try {
    assert.equal(await client.sessionIdentity(), undefined);
    assert.deepEqual(await client.verifyIdentity(), { id: '42', name: 'Example Student' });
    assert.deepEqual(session(), { ...original, identity: { id: '42', name: 'Example Student' } });
    assert.equal(await client.sessionIdentity(), '42');
    await client.reset();
    assert.equal(await client.sessionIdentity(), '42');
  } finally { await client.close(); }
});

test('verifying an already bound account does not rewrite stored credentials', async () => {
  const { client, auth, session } = fixture(async () => response(200, { Identifier: 42, FirstName: 'Example', LastName: 'Student' }));
  session().identity = { id: '42', name: 'Example Student' };
  const save = mock.method(auth.vault, 'save', async () => { throw new Error('Existing credentials must remain untouched'); });
  try {
    assert.equal((await client.verifyIdentity()).id, '42');
    assert.equal(save.mock.callCount(), 0);
  } finally { await client.close(); }
});

test('malformed and conflicting API identities are never persisted', async () => {
  for (const invalid of [true, false]) {
    const { client, auth, session } = fixture(async () => response(200, invalid ? { unexpected: 'payload' } : { Identifier: 2 }));
    if (!invalid) session().identity = { id: '1', name: 'Original student' };
    const save = mock.method(auth.vault, 'save', async () => { throw new Error('Invalid identity must not be saved'); });
    try {
      await assert.rejects(client.verifyIdentity(), { code: invalid ? 'API_FORMAT_CHANGED' : 'ACCOUNT_CHANGED' });
      assert.equal(save.mock.callCount(), 0);
    } finally { await client.close(); mock.restoreAll(); }
  }
});

test('identity recovery cannot overwrite an external account replacement during persistence', async () => {
  const { client, auth, session } = fixture(async () => response(200, { Identifier: 1 }));
  const save = auth.vault.save.bind(auth.vault);
  mock.method(auth.vault, 'save', async (state: Session, expected?: string | null) => {
    session().identity = { id: '2', name: 'Replacement student' }; session().savedAt = 'replacement';
    await save(state, expected);
  });
  try {
    await assert.rejects(client.verifyIdentity(), { code: 'ACCOUNT_CHANGED' });
    assert.equal(session().identity?.id, '2');
    assert.equal(session().savedAt, 'replacement');
  } finally { await client.close(); }
});

test('failed identity persistence does not falsely bind the in-memory account', async () => {
  const { client, auth, session } = fixture(async () => response(200, { Identifier: 1 }));
  mock.method(auth.vault, 'save', async () => { throw new BrightspaceError('VAULT_ERROR', 'Test storage failure'); });
  try {
    await assert.rejects(client.verifyIdentity(), { code: 'VAULT_ERROR' });
    assert.equal(session().identity, undefined);
    assert.equal(await client.sessionIdentity(), undefined);
  } finally { await client.close(); }
});
