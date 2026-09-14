import assert from 'node:assert/strict';
import test from 'node:test';
import { numericId, pageItems, plainText, safeSourceUrl, sameOriginUrl } from '../src/util.js';
const origin = 'https://brightspace.example';
test('authenticated URL resolution enforces host, protocol, credentials and port boundaries', () => {
  assert.equal(sameOriginUrl('/d2l/content/10', origin).href, origin + '/d2l/content/10');
  assert.equal(sameOriginUrl('https://brightspace.example:443/d2l/content/10', origin).origin, origin);
  for (const value of ['https://brightspace.example.evil.invalid/d2l/api', '//evil.invalid/path', 'http://brightspace.example/path',
    'https://student:password@brightspace.example/path', 'https://brightspace.example:8443/path',
    'https://brightspace.example@evil.invalid/path', 'javascript:alert(1)']) {
    assert.throws(() => sameOriginUrl(value, origin), { code: 'EXTERNAL_RESOURCE' });
  }
});
test('source URL redaction preserves legitimate course codes and bookmarks', () => {
  const value = safeSourceUrl('/d2l/content?courseCode=CSE1000&codeName=lecture&bookmark=120&code=oauthvalue&access_token=secret&oauth_signature=signed&SAMLResponse=assertion&X-Amz-Credential=credential&sessionId=session#token=secret', origin);
  const url = new URL(value!);
  assert.deepEqual([...url.searchParams.entries()], [['courseCode', 'CSE1000'], ['codeName', 'lecture'], ['bookmark', '120']]);
  assert.equal(url.hash, '');
  assert.equal(safeSourceUrl('https://student:password@example.invalid/path', origin), undefined);
  assert.equal(safeSourceUrl('data:text/html,secret', origin), undefined);
});
test('Brightspace bookmark cursors and ObjectListPage next URLs remain distinct', () => {
  const bookmark = pageItems({ PagingInfo: { HasMoreItems: true, Bookmark: 'opaque/course=2' }, Items: [{ Id: 1 }] });
  assert.equal(bookmark.bookmark, 'opaque/course=2'); assert.equal(bookmark.nextUrl, undefined); assert.equal(bookmark.hasMore, true);
  const next = 'https://brightspace.example/d2l/api/le/1.90/123/content/?bookmark=456';
  const objects = pageItems({ Next: next, Objects: [{ Id: 2 }] });
  assert.equal(objects.nextUrl, next); assert.equal(objects.bookmark, undefined); assert.equal(objects.hasMore, true);
  assert.equal(pageItems({ Next: null, Objects: [] }).hasMore, false);
  assert.deepEqual(pageItems([{ Id: 3 }]), { items: [{ Id: 3 }], hasMore: false });
  assert.throws(() => pageItems({ Objects: [], Next: { url: next } }), { code: 'API_FORMAT_CHANGED' });
  assert.throws(() => pageItems({ unexpected: [] }), { code: 'API_FORMAT_CHANGED' });
});
test('HTML extraction retains visible text and numeric IDs reject path injection', () => {
  assert.equal(plainText({ Html: '<p>Read &amp; prepare</p><script>hidden</script><p>Exercise 2</p>' }), 'Read & prepare\nExercise 2');
  assert.equal(numericId('000123'), '000123');
  for (const value of ['123/../../users', '1e3', 1.5, '', '-12']) assert.throws(() => numericId(value), { code: 'INVALID_ID' });
});

test('nested redirect URLs and launch credentials are redacted without erasing course metadata', () => {
  const nested = new URL('/course?courseCode=CSE1000&authorization_code=secret&jwt=secret&sig=secret', origin).href;
  const outer = new URL('/launch?CourseCode=CSE1000&authCode=secret&lti_message_hint=secret&ltik=secret', origin);
  outer.searchParams.set('returnUrl', nested);
  outer.searchParams.set('redirect', encodeURIComponent(nested));
  const sanitized = new URL(safeSourceUrl(outer.href, origin)!);
  assert.equal(sanitized.searchParams.get('CourseCode'), 'CSE1000');
  assert.equal(sanitized.searchParams.get('authCode'), null);
  assert.equal(sanitized.searchParams.get('ltik'), null);
  assert.equal(sanitized.searchParams.get('lti_message_hint'), null);
  for (const key of ['returnUrl', 'redirect']) {
    assert.equal(sanitized.searchParams.get(key), origin + '/course?courseCode=CSE1000');
  }
  assert.ok(!sanitized.href.includes('secret'));
});
