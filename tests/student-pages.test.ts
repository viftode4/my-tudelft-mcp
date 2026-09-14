import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { BrightspaceClient } from '../src/client.js';
import { BrowserReader, type PageSnapshot } from '../src/browser.js';
import type { Auth } from '../src/auth.js';
import { chromium } from 'playwright';
import { CourseNavigation } from '../src/course-navigation.js';
import { StudentGroups } from '../src/groups.js';
import { StudentPages } from '../src/student-pages.js';
import { BrightspaceError } from '../src/errors.js';

const origin = 'https://school.example';
const progressUrl = origin + '/d2l/le/userprogress/42/123/Summary';
const lockerUrl = origin + '/d2l/lms/locker/group/group_locker.d2l?ou=123&grpId=456';
const tool = (url: string, extra = {}) => ({ key: 'progress', title: 'Progress', url, sourceUrl: origin + '/d2l/home/123', location: 'personal_menu', kind: 'brightspace', requiresLaunch: false, readCoursePageAvailable: true, ...extra });
const snapshot = (url: string): PageSnapshot => ({ title: 'Student page', url, text: 'Visible student information', truncated: false, links: [], media: [], buttons: [{ index: 0, label: 'Upload files' }], retrievedAt: '2026-09-14T12:00:00Z', source: 'browser' });

function fixture() {
  const state = {
    identity: '42' as string | undefined, reads: [] as string[], navigationReads: 0, membershipReads: 0,
    navigation: { course: { id: '123', name: 'Example Course', code: 'EX123' }, url: origin + '/d2l/home/123', tools: [tool(progressUrl)] },
    memberships: { myGroups: [{ id: '456', courseId: '123', categoryId: '789', name: 'Our group', code: 'G1', membership: 'enrolled' }], membershipComplete: true, url: origin + '/d2l/lms/group/user_group_list.d2l?ou=123' },
    page: snapshot(progressUrl),
  };
  const client = { config: { baseUrl: origin }, sessionIdentity: async () => state.identity } as BrightspaceClient;
  const browser = { read: async (url: string) => { state.reads.push(url); return structuredClone(state.page); } } as BrowserReader;
  mock.method(CourseNavigation.prototype, 'get', async (courseId: string) => { assert.equal(courseId, '123'); state.navigationReads++; return structuredClone(state.navigation) as never; });
  mock.method(StudentGroups.prototype, 'get', async (courseId: string) => { assert.equal(courseId, '123'); state.membershipReads++; return structuredClone(state.memberships) as never; });
  return { state, client, browser, pages: new StudentPages(client, browser) };
}
afterEach(() => mock.restoreAll());

test('progress reads only the exact observed current-student course summary and preserves partial coverage', async () => {
  const { state, pages } = fixture();
  state.navigation.tools = [tool(origin + '/d2l/le/userprogress/99/123/Summary'), tool(origin + '/d2l/le/userprogress/42/999/Summary'), tool(progressUrl)];
  state.page.links = [
    { title: 'Own grades', url: origin + '/d2l/le/userprogress/42/123/Grades' },
    { title: 'Peer grades', url: origin + '/d2l/le/userprogress/99/123/Grades' },
    { title: 'Other course', url: origin + '/d2l/le/userprogress/42/999/Grades' },
    { title: 'Peer query', url: origin + '/d2l/le/userprogress/42/123/Grades?userId=99' },
    { title: 'Roster', url: origin + '/d2l/lms/classlist/classlist.d2l?ou=123' },
  ];
  state.page.truncated = true;
  const result = await pages.progress('123');
  assert.deepEqual(state.reads, [progressUrl]);
  assert.equal(result.complete, false);
  assert.equal(result.snapshot.truncated, true);
  assert.equal(result.discoverySource, origin + '/d2l/home/123');
  assert.deepEqual(result.snapshot.links.map((link) => link.title), ['Own grades']);
  assert.equal('buttons' in result.snapshot, false);
  assert.equal('media' in result.snapshot, false);
});

test('progress never invents a route from another user, another course, an LTI launch or an unobserved link', async () => {
  const { state, pages } = fixture();
  for (const tools of [[], [tool(origin + '/d2l/le/userprogress/99/123/Summary')], [tool(origin + '/d2l/le/userprogress/42/999/Summary')], [tool(progressUrl, { requiresLaunch: true })], [tool(progressUrl, { location: 'navigation' })], [tool(progressUrl + '?userId=99')]]) {
    state.navigation.tools = tools;
    await assert.rejects(pages.progress('123'), { code: 'PROGRESS_UNAVAILABLE' });
  }
  assert.equal(state.reads.length, 0);
});

test('personal pages require a verified current identity before querying navigation or membership', async () => {
  const { state, pages } = fixture(); state.identity = undefined;
  await assert.rejects(pages.progress('123'), { code: 'AUTH_REQUIRED' });
  await assert.rejects(pages.groupLocker('123', '456'), { code: 'AUTH_REQUIRED' });
  assert.equal(state.navigationReads, 0); assert.equal(state.membershipReads, 0); assert.equal(state.reads.length, 0);
});

test('progress rejects a redirected peer or different-course summary before returning any page content', async () => {
  const { state, pages } = fixture();
  for (const url of [origin + '/d2l/le/userprogress/99/123/Summary', origin + '/d2l/le/userprogress/42/999/Summary', 'https://outside.example/d2l/le/userprogress/42/123/Summary']) {
    state.page.url = url;
    await assert.rejects(pages.progress('123'), { code: 'PROGRESS_UNVERIFIED' });
  }
});

test('account changes during discovery prevent reading and changes during retrieval prevent output', async () => {
  const { state, pages, browser } = fixture();
  mock.method(CourseNavigation.prototype, 'get', async () => { state.identity = '99'; return state.navigation as never; });
  await assert.rejects(pages.progress('123'), { code: 'ACCOUNT_CHANGED' });
  assert.equal(state.reads.length, 0);
  state.identity = '42';
  mock.method(CourseNavigation.prototype, 'get', async () => state.navigation as never);
  mock.method(browser, 'read', async () => { state.identity = '99'; return state.page; });
  await assert.rejects(pages.progress('123'), { code: 'ACCOUNT_CHANGED' });
});

test('group locker verifies exact own-group membership and returns only scoped read links', async () => {
  const { state, pages } = fixture(); state.page = snapshot(lockerUrl);
  state.page.links = [
    { title: 'Folder', url: lockerUrl + '&folderId=7' },
    { title: 'Another group', url: origin + '/d2l/lms/locker/group/group_locker.d2l?ou=123&grpId=457' },
    { title: 'Another course', url: origin + '/d2l/lms/locker/group/group_locker.d2l?ou=999&grpId=456' },
    { title: 'Upload', url: origin + '/d2l/lms/locker/group/upload_file.d2l?ou=123&grpId=456' },
    { title: 'Delete', url: origin + '/d2l/lms/locker/group/delete_file.d2l?ou=123&grpId=456' },
    { title: 'External', url: 'https://outside.example/file' },
    { title: 'Roster', url: origin + '/d2l/lms/group/group_members.d2l?ou=123&grpId=456' },
  ];
  const result = await pages.groupLocker('123', '456');
  assert.equal(state.membershipReads, 1); assert.deepEqual(state.reads, [lockerUrl]);
  assert.equal(result.membershipVerified, true); assert.equal(result.group.id, '456');
  assert.equal(result.complete, false); assert.deepEqual(result.snapshot.links.map((link) => link.title), ['Folder']);
  assert.match(result.scope, /File contents.*not retrieved/);
});

test('unverified or wrong-course group membership denies the locker before browser navigation', async () => {
  const { state, pages } = fixture(); state.page = snapshot(lockerUrl);
  state.memberships.myGroups = [];
  await assert.rejects(pages.groupLocker('123', '456'), { code: 'PERMISSION_DENIED' });
  state.memberships.membershipComplete = false;
  await assert.rejects(pages.groupLocker('123', '456'), { code: 'GROUP_MEMBERSHIP_UNVERIFIED' });
  state.memberships.myGroups = [{ id: '456', courseId: '999', categoryId: '789', name: 'Other course group', code: 'G1', membership: 'enrolled' }];
  await assert.rejects(pages.groupLocker('123', '456'), { code: 'GROUP_MEMBERSHIP_UNVERIFIED' });
  assert.equal(state.reads.length, 0);
});

test('partial group enumeration still permits an exact positively verified own membership', async () => {
  const { state, pages } = fixture(); state.memberships.membershipComplete = false; state.page = snapshot(lockerUrl);
  const result = await pages.groupLocker('123', '456');
  assert.equal(result.membershipVerified, true); assert.equal(result.complete, false);
});

test('locker redirects cannot change the verified group or course or duplicate scope parameters', async () => {
  const { state, pages } = fixture();
  for (const url of [lockerUrl.replace('grpId=456', 'grpId=457'), lockerUrl.replace('ou=123', 'ou=999'), lockerUrl + '&grpId=457']) {
    state.page = snapshot(url);
    await assert.rejects(pages.groupLocker('123', '456'), { code: 'GROUP_LOCKER_UNVERIFIED' });
  }
});

test('locker rejects account changes after membership checks and does not expose retrieved data', async () => {
  const { state, pages, browser } = fixture(); state.page = snapshot(lockerUrl);
  mock.method(browser, 'read', async () => { state.identity = '99'; return state.page; });
  await assert.rejects(pages.groupLocker('123', '456'), { code: 'ACCOUNT_CHANGED' });
});

test('safe descriptors and visible URL text omit authentication query material', async () => {
  const { state, pages } = fixture();
  state.page.text = 'More at https://school.example/resource?token=secret-value&chapter=2';
  state.page.links = [{ title: 'Own content', url: origin + '/d2l/le/userprogress/42/123/Content?token=secret-value&filter=all' }];
  const result = await pages.progress('123');
  assert.doesNotMatch(JSON.stringify(result), /secret-value|token=/);
  assert.match(result.snapshot.links[0]!.url, /filter=all/);
});

test('invalid IDs and denied membership requests never fall back to guessed page access', async () => {
  const { state, pages } = fixture();
  await assert.rejects(pages.progress('../123'), { code: 'INVALID_ID' });
  await assert.rejects(pages.groupLocker('123', '456?other=1'), { code: 'INVALID_ID' });
  mock.method(StudentGroups.prototype, 'get', async () => { throw new BrightspaceError('ACCOUNT_CHANGED', 'Session replaced'); });
  await assert.rejects(pages.groupLocker('123', '456'), { code: 'ACCOUNT_CHANGED' });
  assert.equal(state.reads.length, 0);
});

test('observed personal Progress sorting parameters are preserved without permitting another student selector', async () => {
  const { state, pages } = fixture();
  const observed = progressUrl + '?searchString=&sortField=LastName&sortDirection=0';
  state.navigation.tools = [tool(observed)]; state.page.url = observed;
  const result = await pages.progress('123');
  assert.deepEqual(state.reads, [observed]); assert.equal(result.url, observed);
  for (const unsafe of [observed + '&studentId=99', observed + '&sortDirection=1', progressUrl + '?searchString=another-student']) {
    state.navigation.tools = [tool(unsafe)];
    await assert.rejects(pages.progress('123'), { code: 'PROGRESS_UNAVAILABLE' });
  }
  assert.equal(state.reads.length, 1);
});

test('progress section reads require its exact observed link and expose available sections', async () => {
  const { state, pages, browser } = fixture();
  const contentUrl = origin + '/d2l/le/userprogress/42/123/Content/Details?searchString=&sortField=SortLastName&sortDirection=0';
  state.page.links = [{ title: 'Content', url: contentUrl }];
  mock.method(browser, 'read', async (url: string) => {
    state.reads.push(url);
    return url === progressUrl ? structuredClone(state.page) : { ...snapshot(contentUrl), text: 'Two course topics visited' };
  });
  const result = await pages.progress('123', 'content');
  assert.deepEqual(state.reads, [progressUrl, contentUrl]);
  assert.equal(result.section, 'content');
  assert.equal(result.summaryUrl, progressUrl);
  assert.equal(result.snapshot.text, 'Two course topics visited');
  assert.equal(result.complete, false);
  assert.deepEqual(result.availableSections, [{ section: 'content', title: 'Content', url: contentUrl }]);
});

test('progress section targets reject unobserved, ambiguous and unsafe source links before navigation', async () => {
  const { state, pages } = fixture();
  const own = origin + '/d2l/le/userprogress/42/123/Content/Details';
  const candidates = [[], [{ title: 'Content', url: own.replace('/42/', '/99/') }],
    [{ title: 'Content', url: own + '?userId=99' }], [{ title: 'Content', url: own + '?token=secret' }],
    [{ title: 'Content', url: own }, { title: 'Sorted content', url: own + '?sortDirection=1' }]];
  for (const links of candidates) {
    state.page.links = links;
    await assert.rejects(pages.progress('123', 'content'), { code: 'PROGRESS_SECTION_UNAVAILABLE' });
  }
  assert.ok(state.reads.every((url) => url === progressUrl));
  await assert.rejects(pages.progress('123', '__proto__' as never), { code: 'INVALID_ARGUMENT' });
});

test('selected progress sections reject cross-account, cross-course and different-section redirects', async () => {
  const { state, pages, browser } = fixture();
  const contentUrl = origin + '/d2l/le/userprogress/42/123/Content/Details';
  state.page.links = [{ title: 'Content', url: contentUrl }];
  let redirected = contentUrl;
  mock.method(browser, 'read', async (url: string) => url === progressUrl ? structuredClone(state.page) : snapshot(redirected));
  for (const url of [contentUrl.replace('/42/', '/99/'), contentUrl.replace('/123/', '/999/'), contentUrl.replace('/Content/', '/Grades/'), contentUrl + '?studentId=99']) {
    redirected = url;
    await assert.rejects(pages.progress('123', 'content'), { code: 'PROGRESS_UNVERIFIED' });
  }
});

test('account replacement during a progress section read prevents returning that section', async () => {
  const { state, pages, browser } = fixture();
  const contentUrl = origin + '/d2l/le/userprogress/42/123/Content/Details';
  state.page.links = [{ title: 'Content', url: contentUrl }];
  mock.method(browser, 'read', async (url: string) => {
    if (url === progressUrl) return structuredClone(state.page);
    state.identity = '99';
    return snapshot(contentUrl);
  });
  await assert.rejects(pages.progress('123', 'content'), { code: 'ACCOUNT_CHANGED' });
});

test('real browser checks original progress links and destination URLs before redaction, including frame links', async () => {
  const { state, client } = fixture();
  const browser = await chromium.launch({ headless: true });
  const reader = new BrowserReader({ config: { baseUrl: origin } } as Auth);
  const pages = new StudentPages(client, reader);
  const contentUrl = origin + '/d2l/le/userprogress/42/123/Content/Details';
  let mode: 'unsafe' | 'valid' | 'redirect' = 'unsafe';
  mock.method(reader, 'open', async (url: string) => {
    state.reads.push(url);
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
      const target = new URL(route.request().url());
      const body = target.pathname.endsWith('/Summary')
        ? target.searchParams.has('sortDirection')
          ? '<main><a href="' + origin + '/d2l/le/userprogress/42/123/Grades/Details?token=frame-secret">Grades</a></main>'
          : '<main><a href="' + contentUrl + (mode === 'unsafe' ? '?token=synthetic-secret' : '') + '">Content</a><iframe src="' + progressUrl + '?sortDirection=1"></iframe></main>'
        : '<main>Own section content</main>';
      await route.fulfill({ status: 200, contentType: 'text/html', body });
    });
    const page = await context.newPage();
    await page.goto(mode === 'redirect' && url === contentUrl ? url + '?token=destination-secret' : url, { waitUntil: 'networkidle' });
    return { browser, context, page, close: () => context.close() };
  });
  try {
    await assert.rejects(pages.progress('123', 'content'), { code: 'PROGRESS_SECTION_UNAVAILABLE' });
    assert.deepEqual(state.reads, [progressUrl]);
    mode = 'valid';
    const result = await pages.progress('123', 'content');
    assert.equal(result.snapshot.text, 'Own section content');
    assert.deepEqual(result.availableSections.map((item) => item.section), ['content']);
    assert.doesNotMatch(JSON.stringify(result), /secret|token=/);
    mode = 'redirect';
    await assert.rejects(pages.progress('123', 'content'), { code: 'PROGRESS_UNVERIFIED' });
  } finally { await browser.close(); }
});
