import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type BrowserContext, type Route } from 'playwright';
import { Catalog, discoverCourseUrl, type CatalogCourse, type CourseInspection, type RegistrationBackend } from '../src/catalog.js';
import type { PageSnapshot } from '../src/browser.js';
import type { Auth } from '../src/auth.js';
import { BrowserReader, snapshotPage, browserStorageForOrigin, guardReadNavigation, validateReadPage } from '../src/browser.js';

const origin = 'https://brightspace.tudelft.nl';
const course: CatalogCourse = { id: '123', title: 'Example Course (2026/27 Q1)', code: 'EX123+2026+1', semester: '2026/27 Q1', url: `${origin}/d2l/le/discovery/view/course/123` };
const snapshot: PageSnapshot = { title: course.title, text: 'Enroll in Course', url: course.url, truncated: false, links: [], media: [], buttons: [], retrievedAt: new Date(0).toISOString(), source: 'browser' };

function setup() {
  let now = 1_000_000;
  const state = { account: '42', inspection: { course: { ...course }, snapshot, canEnroll: true } as CourseInspection, enrolled: false, clicks: 0, finishEnrollment: true, clickError: false, beforeInspect: undefined as (() => Promise<void>) | undefined, beforeEnroll: undefined as (() => Promise<void>) | undefined };
  const backend: RegistrationBackend = {
    accountId: async () => state.account,
    inspect: async () => { await state.beforeInspect?.(); return state.inspection; },
    enrolled: async () => state.enrolled,
    enroll: async (_course, assertCurrent) => { await state.beforeEnroll?.(); assertCurrent?.(); state.clicks++; if (state.clickError) throw new Error('transport error'); if (state.finishEnrollment) state.enrolled = true; },
  };
  const browser = { auth: { config: { baseUrl: origin } } } as BrowserReader;
  const catalog = new Catalog(browser, undefined, { backend, now: () => now, pause: async () => undefined });
  return { catalog, state, advance: (milliseconds: number) => { now += milliseconds; } };
}

test('registration accepts only exact Discover course URLs on the configured origin', () => {
  assert.equal(discoverCourseUrl(course.url, origin).id, '123');
  for (const url of ['https://evil.example/d2l/le/discovery/view/course/123', `${course.url}?enroll=true`, `${course.url}#different`, `${origin}/d2l/home/123`, `${origin}/d2l/le/discovery/view/course/123/enroll`, 'https://brightspace-cc.tudelft.nl/course/123/example']) {
    assert.throws(() => discoverCourseUrl(url, origin));
  }
});

test('prepare binds a five-minute confirmation to the exact course and never enrolls', async () => {
  const { catalog, state } = setup();
  const preview = await catalog.prepare(course.url);
  assert.equal(preview.status, 'confirmation_required');
  assert.deepEqual(preview.course, course);
  assert.equal(preview.confirmationToken?.length, 32);
  assert.equal(Date.parse(preview.expiresAt!), 1_300_000);
  assert.equal(state.clicks, 0);
});

test('a confirmation can be consumed only once even with concurrent calls', async () => {
  const { catalog, state } = setup();
  const token = (await catalog.prepare(course.url)).confirmationToken!;
  const results = await Promise.allSettled([catalog.confirm(token), catalog.confirm(token)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(state.clicks, 1);
});

test('expired and unknown confirmations cause no click', async () => {
  const { catalog, state, advance } = setup();
  const token = (await catalog.prepare(course.url)).confirmationToken!;
  advance(300_000);
  await assert.rejects(catalog.confirm(token), { code: 'INVALID_CONFIRMATION' });
  await assert.rejects(catalog.confirm('unknown'), { code: 'INVALID_CONFIRMATION' });
  assert.equal(state.clicks, 0);
});

test('account changes invalidate confirmation', async () => {
  const { catalog, state } = setup();
  const token = (await catalog.prepare(course.url)).confirmationToken!;
  state.account = '43';
  await assert.rejects(catalog.confirm(token), { code: 'ACCOUNT_CHANGED' });
  assert.equal(state.clicks, 0);
});

test('course and semester changes require a new preview', async () => {
  for (const change of [{ id: '124' }, { title: 'Another course' }, { code: 'EX123+2027+1' }, { semester: '2027/28 Q1' }]) {
    const { catalog, state } = setup();
    const token = (await catalog.prepare(course.url)).confirmationToken!;
    state.inspection = { ...state.inspection, course: { ...course, ...change } };
    await assert.rejects(catalog.confirm(token), { code: 'COURSE_CHANGED' });
    assert.equal(state.clicks, 0);
  }
});

test('already enrolled and approval-only courses never receive a write token', async () => {
  const { catalog, state } = setup();
  state.enrolled = true;
  assert.equal((await catalog.prepare(course.url)).status, 'already_enrolled');
  state.enrolled = false;
  state.inspection.canEnroll = false;
  const preview = await catalog.prepare(course.url);
  assert.equal(preview.status, 'unsupported');
  assert.equal(preview.confirmationToken, undefined);
  assert.equal(state.clicks, 0);
});

test('membership acquired after preview suppresses the click', async () => {
  const { catalog, state } = setup();
  const token = (await catalog.prepare(course.url)).confirmationToken!;
  state.enrolled = true;
  assert.equal((await catalog.confirm(token)).status, 'already_enrolled');
  assert.equal(state.clicks, 0);
});

test('success requires verified membership, not successful click or page text', async () => {
  const { catalog, state } = setup();
  state.finishEnrollment = false;
  state.inspection.snapshot = { ...snapshot, text: 'Successfully enrolled!' };
  const result = await catalog.confirm((await catalog.prepare(course.url)).confirmationToken!);
  assert.equal(result.status, 'unverified');
  assert.equal(state.clicks, 1);
});

test('uncertain write errors are never retried and consume the confirmation', async () => {
  const { catalog, state } = setup();
  state.clickError = true;
  const token = (await catalog.prepare(course.url)).confirmationToken!;
  assert.equal((await catalog.confirm(token)).status, 'unverified');
  await assert.rejects(catalog.confirm(token), { code: 'INVALID_CONFIRMATION' });
  assert.equal(state.clicks, 1);
});

test('close invalidates pending confirmations', async () => {
  const { catalog, state } = setup();
  const token = (await catalog.prepare(course.url)).confirmationToken!;
  await catalog.close();
  await assert.rejects(catalog.confirm(token), { code: 'INVALID_CONFIRMATION' });
  assert.equal(state.clicks, 0);
});

test('logout during asynchronous preparation cannot create a new token', async () => {
  const { catalog, state } = setup();
  state.beforeInspect = () => catalog.close();
  await assert.rejects(catalog.prepare(course.url), { code: 'INVALID_CONFIRMATION' });
  assert.equal(state.clicks, 0);
});

test('logout during confirmation preflight or final browser inspection prevents the click', async () => {
  for (const hook of ['beforeInspect', 'beforeEnroll'] as const) {
    const { catalog, state } = setup();
    const token = (await catalog.prepare(course.url)).confirmationToken!;
    state[hook] = () => catalog.close();
    await assert.rejects(catalog.confirm(token), { code: 'INVALID_CONFIRMATION' });
    assert.equal(state.clicks, 0);
  }
});

test('browser snapshots retain Discover shadow links while excluding credentials and closed dialogs', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(`${origin}/fixture`, (route) => route.fulfill({ contentType: 'text/html', body: `
      <main><course-list token="SECRET_ATTRIBUTE"></course-list>
      <input type="text" value="SECRET_INPUT"><textarea>SECRET_TEXTAREA</textarea>
      <d2l-dialog-confirm>FICTITIOUS_ENROLLMENT_SUCCESS</d2l-dialog-confirm>
      <script>document.querySelector('course-list').attachShadow({mode:'open'}).innerHTML =
        '<d2l-list-item-button label="Example course" href="/d2l/le/discovery/view/course/123"><span>Example course</span></d2l-list-item-button>';</script></main>` }));
    await page.goto(`${origin}/fixture`);
    const result = await snapshotPage(page, origin);
    assert.ok(result.links.some((link) => link.title === 'Example course' && link.url === course.url));
    assert.doesNotMatch(JSON.stringify(result), /SECRET_|FICTITIOUS_ENROLLMENT_SUCCESS/);
  } finally { await browser.close(); }
});

test('read navigation rejects encoded mutations, authentication, and graded attempts', () => {
  for (const path of ['/d2l/%6Cogout', '/d2l/%256cogout', '/d2l/resource?cmd=%64elete', '/d2l/lms/quizzing/user/quiz_attempt_page.d2l?ou=123', '/d2l/lms/quizzing/user/quiz_start.d2l', '/d2l/lp/auth/oauth2/token', '/d2l/login', '/d2l/%E0%A4%A']) {
    assert.throws(() => validateReadPage(`${origin}${path}`, origin));
  }
  assert.equal(validateReadPage(`${origin}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=123`, origin), `${origin}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=123`);
});

test('browser import excludes other services and identity-provider storage', () => {
  const makeCookie = (domain: string) => ({ name: domain, value: 'fixture', domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const });
  const result = browserStorageForOrigin({
    cookies: ['brightspace.tudelft.nl', '.tudelft.nl', 'login.tudelft.nl', 'brightspace-cc.tudelft.nl', 'evil-tudelft.nl'].map(makeCookie),
    origins: [origin, 'https://login.tudelft.nl', 'https://brightspace-cc.tudelft.nl'].map((entry) => ({ origin: entry, localStorage: [{ name: 'session', value: 'fixture' }] })),
  }, origin);
  assert.deepEqual(result.cookies.map((cookie) => cookie.domain), ['brightspace.tudelft.nl', '.tudelft.nl']);
  assert.deepEqual(result.origins.map((entry) => entry.origin), [origin]);
});

test('external HTTP redirects are inspected with automatic redirects disabled', async () => {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const context = { route: async (_pattern: string, callback: (route: Route) => Promise<void>) => { handler = callback; } } as unknown as BrowserContext;
  const guard = await guardReadNavigation(context, origin);
  let aborted = 0, fulfilled = 0;
  const route = {
    request: () => ({ isNavigationRequest: () => true, url: () => `${origin}/fixture`, method: () => 'GET' }),
    fetch: async (options: { maxRedirects: number }) => { assert.equal(options.maxRedirects, 0); return { status: () => 302, headers: () => ({ location: 'https://login.tudelft.nl/sso' }), dispose: async () => undefined }; },
    abort: async () => { aborted++; }, fulfill: async () => { fulfilled++; },
  } as unknown as Route;
  await handler!(route);
  assert.equal(aborted, 1);
  assert.equal(fulfilled, 0);
  assert.equal(guard.failures.get(`${origin}/fixture`)?.code, 'AUTH_REQUIRED');
});

test('browser guard aborts external iframe and popup document requests', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const guard = await guardReadNavigation(context, origin);
    const page = await context.newPage();
    await page.route(`${origin}/fixture`, (route) => route.fulfill({ contentType: 'text/html', body: '<main>Fixture</main>' }));
    await page.goto(`${origin}/fixture`);
    for (const [kind, url] of [['iframe', 'https://external.example/frame'], ['popup', 'https://external.example/popup']] as const) {
      const failed = context.waitForEvent('requestfailed', { predicate: (request) => request.url() === url });
      await page.evaluate(({ kind, url }) => {
        if (kind === 'popup') window.open(url);
        else { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }
      }, { kind, url });
      await failed;
      assert.equal(guard.failures.get(url)?.code, 'EXTERNAL_RESOURCE');
    }
    assert.equal(page.url(), `${origin}/fixture`);
  } finally { await browser.close(); }
});

test('the course reader includes same-origin iframe text and links while excluding external frame content', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const guard = await guardReadNavigation(context, origin);
    const page = await context.newPage();
    await page.route(`${origin}/fixture`, (route) => route.fulfill({ contentType: 'text/html', body: `<main>Course shell</main><iframe src="${origin}/embedded"></iframe><iframe src="https://external.example/private"></iframe>` }));
    await page.route(`${origin}/embedded`, (route) => route.fulfill({ contentType: 'text/html', body: `<main><p>SAME_ORIGIN_LECTURE_DESCRIPTION</p><a href="${origin}/lecture.pdf">Lecture PDF</a><input value="SECRET_FRAME_INPUT"></main>` }));
    await page.goto(`${origin}/fixture`);
    const reader = new BrowserReader({ config: { baseUrl: origin } } as Auth);
    reader.open = async () => ({ browser, context, page, close: async () => undefined });
    const result = await reader.read(`${origin}/fixture`);
    assert.equal(result.url, `${origin}/fixture`);
    assert.match(result.text, /SAME_ORIGIN_LECTURE_DESCRIPTION/);
    assert.ok(result.links.some((link) => link.url === `${origin}/lecture.pdf`));
    assert.doesNotMatch(JSON.stringify(result), /SECRET_FRAME_INPUT/);
    assert.equal(guard.failures.get('https://external.example/private')?.code, 'EXTERNAL_RESOURCE');
  } finally { await browser.close(); }
});

test('safe redirects are queued for separate guarded navigation instead of automatic browser following', async () => {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const context = { route: async (_pattern: string, callback: (route: Route) => Promise<void>) => { handler = callback; } } as unknown as BrowserContext;
  const guard = await guardReadNavigation(context, origin);
  let fulfilledStatus: number | undefined;
  await handler!({
    request: () => ({ isNavigationRequest: () => true, url: () => `${origin}/fixture`, method: () => 'GET' }),
    fetch: async () => ({ status: () => 302, headers: () => ({ location: '/d2l/le/lessons/123/topics/456' }), dispose: async () => undefined }),
    abort: async () => assert.fail('Safe redirects should settle before the next guarded navigation'),
    fulfill: async (response: { status: number }) => { fulfilledStatus = response.status; },
  } as unknown as Route);
  assert.equal(fulfilledStatus, 200);
  assert.equal(guard.redirects.get(`${origin}/fixture`), `${origin}/d2l/le/lessons/123/topics/456`);
});
