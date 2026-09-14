import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { CourseNavigation, normalizeCourseTools, observeCourseTools, resolveStudentCourse, type CourseClient } from '../src/course-navigation.js';
import type { BrightspaceClient } from '../src/client.js';
import type { BrowserReader } from '../src/browser.js';
import { BrightspaceError } from '../src/errors.js';

const origin = 'https://brightspace.tudelft.nl';
const membership = { OrgUnit: { Id: 123, Name: 'Example Course (2026/27 Q1)', Code: 'EX123+2026+1' }, Access: { CanAccess: true, IsActive: true } };
function client(overrides: Partial<CourseClient> = {}): CourseClient {
  return { config: { baseUrl: origin } as CourseClient['config'],
    json: async (_product, path) => {
      if (path === 'courses/123') throw new BrightspaceError('PERMISSION_DENIED', 'Course details restricted');
      if (path === 'enrollments/myenrollments/123') return membership;
      throw new Error('Unexpected API path');
    }, list: async () => assert.fail('A verified direct membership must not require listing other courses'), ...overrides };
}

test('course details permission failure falls back to exact own membership without scanning other courses', async () => {
  const course = await resolveStudentCourse(client(), '123');
  assert.equal(course.name, membership.OrgUnit.Name);
  assert.equal(course.code, membership.OrgUnit.Code);
  assert.equal(course.metadataSource, 'my_enrollments');
  assert.equal(course.courseDetailsError?.code, 'PERMISSION_DENIED');
});

test('available course metadata must identify the requested course exactly', async () => {
  const result = await resolveStudentCourse(client({ json: async () => ({ Identifier: '123', Name: 'Course', Code: 'EX123', Semester: { Name: '2026/27 Q1' }, Description: { Text: 'See https://resource.example/file?token=SECRET' } }) }), '123');
  assert.equal(result.metadataSource, 'course_api');
  assert.equal(result.semester, '2026/27 Q1');
  assert.doesNotMatch(result.description!, /SECRET|token=/);
  await assert.rejects(resolveStudentCourse(client({ json: async () => ({ Identifier: '124', Name: 'Different Course', Code: 'EX124' }) }), '123'), { code: 'API_FORMAT_CHANGED' });
});

test('malformed or inaccessible direct membership cannot authorize a course', async () => {
  for (const response of [{ ...membership, OrgUnit: { ...membership.OrgUnit, Id: 124 } }, { ...membership, Access: { CanAccess: false } }]) {
    const testClient = client({ json: async (_product, path) => { if (path.startsWith('courses/')) throw new BrightspaceError('PERMISSION_DENIED', 'Denied'); return response; } });
    await assert.rejects(resolveStudentCourse(testClient, '123'));
  }
});

test('unavailable direct membership uses only an exact entry in the paginated own list', async () => {
  const testClient = client({
    json: async () => { throw new BrightspaceError('PERMISSION_DENIED', 'Denied'); },
    list: async () => ({ items: [{ OrgUnit: { Id: 999, Name: 'Other', Code: 'OTHER' } }, membership], complete: true }),
  });
  assert.equal((await resolveStudentCourse(testClient, '123')).code, 'EX123+2026+1');
  testClient.list = async () => ({ items: [], complete: false });
  await assert.rejects(resolveStudentCourse(testClient, '123'), { code: 'PAGINATION_ERROR' });
  testClient.list = async () => ({ items: [], complete: true });
  await assert.rejects(resolveStudentCourse(testClient, '123'), { code: 'PERMISSION_DENIED' });
});

test('authentication failure never falls back to unrelated course data', async () => {
  const testClient = client({ json: async () => { throw new BrightspaceError('ACCOUNT_CHANGED', 'Account changed'); } });
  await assert.rejects(resolveStudentCourse(testClient, '123'), { code: 'ACCOUNT_CHANGED' });
});

test('navigation normalization keeps safe descriptors and omits clutter, duplicates, and other-course links', () => {
  const links = normalizeCourseTools([
    { title: 'Notifications', url: `${origin}/d2l/Notifications/Settings?ou=123`, location: 'navigation' },
    { title: 'Groups', url: `${origin}/d2l/lms/group/group_list.d2l?ou=123`, location: 'navigation' },
    { title: 'Groups', url: `${origin}/d2l/lms/group/group_list.d2l?ou=123`, location: 'navigation' },
    { title: 'Wrong Groups', url: `${origin}/d2l/lms/group/group_list.d2l?ou=999`, location: 'navigation' },
    { title: 'Study Guide', url: `${origin}/d2l/common/dialogs/quickLink/quickLink.d2l?ou=123&type=lti&rcode=observed&token=SECRET`, location: 'navigation' },
    { title: 'Recordings', url: 'https://video.example/lecture/1', location: 'navigation' },
  ], origin, '123');
  assert.equal(links.length, 3);
  assert.equal(links.find((link) => link.title === 'Groups')?.readCoursePageAvailable, true);
  const lti = links.find((link) => link.title === 'Study Guide')!;
  assert.equal(lti.requiresLaunch, true);
  assert.equal(lti.readCoursePageAvailable, false);
  assert.equal(lti.externalAuthentication, 'unknown');
  assert.doesNotMatch(lti.url, /SECRET|token=/);
  assert.equal(links.find((link) => link.title === 'Recordings')?.access, 'external_not_verified');
});

test('observed desktop and shadow-menu navigation resolves tools without launching linked services', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.route(`${origin}/d2l/home/123`, (route) => route.fulfill({ contentType: 'text/html', body: `
      <header><a href="/d2l/Notifications/Settings?ou=123">Notifications</a></header>
      <nav><div class="d2l-navigation-s-main-wrapper"><a href="/d2l/le/lessons/123">Content</a>
      <a href="/d2l/common/dialogs/quickLink/quickLink.d2l?ou=123&type=lti&rcode=observed">Study Guide</a>
      <d2l-menu-item-link></d2l-menu-item-link></div></nav>
      <main><a href="/d2l/le/calendar/123">Calendar</a><a href="https://research.example/paper">Course reading</a></main>
      <script>document.querySelector('d2l-menu-item-link').attachShadow({mode:'open'}).innerHTML='<a href="/d2l/lms/group/group_list.d2l?ou=123">Groups</a>';</script>` }));
    await page.goto(`${origin}/d2l/home/123`);
    const tools = await observeCourseTools(page, origin, '123');
    assert.deepEqual(tools.map((tool) => tool.key).sort(), ['calendar', 'content', 'groups', 'study_guide']);
    assert.equal(tools.find((tool) => tool.key === 'study_guide')?.access, 'launch_not_verified');
    assert.deepEqual(tools.find((tool) => tool.key === 'study_guide')?.suggestedTools, ['search_study_guide', 'get_study_guide']);
    assert.equal(requests.length, 1);
    await assert.rejects(observeCourseTools(page, origin, '999'), { code: 'COURSE_CHANGED' });

    let closed = 0;
    const fakeBrowser = { open: async () => ({ browser, page, close: async () => { closed++; } }) } as unknown as BrowserReader;
    const testClient = { ...client(), sessionIdentity: async () => '42' } as BrightspaceClient;
    const result = await new CourseNavigation(testClient, fakeBrowser).get('123');
    assert.equal(result.course.metadataSource, 'my_enrollments');
    assert.equal(result.linkedResources[0]?.url, 'https://research.example/paper');
    assert.equal(result.complete, false);
    assert.equal(closed, 1);
    let checks = 0;
    testClient.sessionIdentity = async () => String(checks++);
    await assert.rejects(new CourseNavigation(testClient, fakeBrowser).get('123'), { code: 'ACCOUNT_CHANGED' });
    assert.equal(closed, 2);
  } finally { await browser.close(); }
});
