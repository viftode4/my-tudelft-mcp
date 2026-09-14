import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chromium, request, type APIRequestContext, type Route } from 'playwright';
import { CourseServices, ServiceNavigationPolicy, discoverServiceLaunch, guardServiceNavigation, serviceStorageForBrightspace, studyGuidePublicHandoff, validateServiceForm, type CourseServiceLaunch } from '../src/course-services.js';
import type { PublicStudyGuide } from '../src/study-guide.js';
import type { BrightspaceClient } from '../src/client.js';
import type { BrowserReader } from '../src/browser.js';
import type { CourseToolLink } from '../src/course-navigation.js';
import { BrightspaceError } from '../src/errors.js';

const origin = 'https://brightspace.tudelft.nl', provider = 'https://group-self.lti.tudelft.nl';
const plan: CourseServiceLaunch = {
  service: 'group_self_enrollment', brightspaceOrigin: origin,
  course: { id: '123', name: 'Example Course (2026/27 Q1)', code: 'EX123+2026+1', url: `${origin}/d2l/home/123`, metadataSource: 'my_enrollments' },
  sourceUrl: `${origin}/d2l/common/dialogs/quickLink/quickLink.d2l?ou=123&type=lti&rcode=observed`,
  launchUrl: `${origin}/d2l/le/lti/123/toolLaunch/456/789?resourceCode=observed`,
  loginUrl: `${provider}/init/11111111-2222-4333-8444-555555555555/`, targetUrl: `${provider}/lti/launch/`,
};
const initial = { iss: origin, login_hint: 'SYNTHETIC_LOGIN_HINT', target_link_uri: plan.targetUrl, lti_deployment_id: 'deployment', client_id: 'client', lti_message_hint: 'SYNTHETIC_MESSAGE_HINT' };
const studyPlan: CourseServiceLaunch = { ...plan, service: 'study_guide', loginUrl: 'https://curriculum.tudelft.nl/lti/1.3/login', targetUrl: 'https://curriculum.tudelft.nl/lti/1.3/launch' };
const publicLink = 'https://studiegids.tudelft.nl/courses/deeplink?code=EX123&jaar=2026-2027&embedded=true';
function form(action: string, fields: Record<string, string>) {
  return `<form action="${action}" method="post">${Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${key}" value="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`).join('')}</form><script>document.forms[0].submit()</script>`;
}
const link = { title: 'Group Self Enrollment', kind: 'lti', url: plan.sourceUrl } as CourseToolLink;
function fakeRequest(wrapper: string, launch = form(plan.loginUrl, initial)) {
  const visited: string[] = [];
  return { visited, request: { get: async (url: string) => { visited.push(url); return { status: () => 200, ok: () => true, text: async () => url === plan.sourceUrl ? wrapper : launch, dispose: async () => {} }; } } as unknown as APIRequestContext };
}
const frameUrl = `${origin}/d2l/lti/orgUnit/123/link/456/componentLaunch?launchLocation=${encodeURIComponent(plan.launchUrl)}`;

test('exact observed wrapper and form resolve the same course, resource and provider without posting', async () => {
  const mock = fakeRequest(`<iframe src="${frameUrl}"></iframe>`);
  const found = await discoverServiceLaunch(mock.request, link, plan.course, plan.service, origin);
  assert.equal(found.targetUrl, plan.targetUrl);
  assert.deepEqual(mock.visited, [plan.sourceUrl, plan.launchUrl]);
  assert.doesNotMatch(JSON.stringify(found), /SYNTHETIC_LOGIN_HINT|SYNTHETIC_MESSAGE_HINT/);
});

test('foreign course frames, arbitrary launch destinations and duplicate scoping parameters fail closed', async () => {
  for (const badFrame of [frameUrl.replace('/123/', '/999/'), frameUrl.replace('/link/456/', '/link/999/'), frameUrl + '&launchLocation=' + encodeURIComponent(plan.launchUrl), frameUrl.replace(encodeURIComponent(plan.launchUrl), encodeURIComponent('https://evil.example/collect'))]) {
    const mock = fakeRequest(`<iframe src="${badFrame}"></iframe>`);
    await assert.rejects(discoverServiceLaunch(mock.request, link, plan.course, plan.service, origin), { code: 'UNSAFE_SERVICE_TARGET' });
    assert.equal(mock.visited.length, 1);
  }
  for (const suffix of ['&ou=999', '&OU=999', '&type=lti', '&rcode=different']) {
    const mock = fakeRequest(`<iframe src="${frameUrl}"></iframe>`);
    await assert.rejects(discoverServiceLaunch(mock.request, { ...link, url: link.url + suffix }, plan.course, plan.service, origin), { code: 'UNSAFE_SERVICE_TARGET' });
    assert.equal(mock.visited.length, 0);
  }
});

test('provider form accepts only observed OIDC fields and exact university launch destinations', () => {
  assert.equal(validateServiceForm(plan.service, form(plan.loginUrl, initial), plan.launchUrl, origin).loginUrl, plan.loginUrl);
  for (const html of [form('https://evil.example/collect', initial), form(plan.loginUrl, { ...initial, target_link_uri: 'https://evil.example/collect' }), form(plan.loginUrl, { ...initial, iss: 'https://evil.example' }), form(plan.loginUrl, { ...initial, password: 'secret' }), form(plan.loginUrl, initial).replace('</form>', '<input name="iss" value="other"></form>')]) assert.throws(() => validateServiceForm(plan.service, html, plan.launchUrl, origin));
  const studyForm = form('https://curriculum.tudelft.nl/lti/1.3/login', { ...initial, target_link_uri: 'https://tudelft-acc.sqill.it/lti/1.3/launch' });
  assert.equal(validateServiceForm('study_guide', studyForm, plan.launchUrl, origin).targetUrl, 'https://tudelft-acc.sqill.it/lti/1.3/launch');
});

test('only normal browser OIDC posts are accepted; mutations, peer rosters and token forwarding are rejected', () => {
  const policy = new ServiceNavigationPolicy(plan), type = 'application/x-www-form-urlencoded';
  assert.equal(policy.check(plan.loginUrl, 'POST', true, new URLSearchParams(initial).toString(), type).href, plan.loginUrl);
  assert.equal(policy.check(plan.targetUrl, 'POST', true, 'id_token=SYNTHETIC_TOKEN&state=SYNTHETIC_STATE', type).href, plan.targetUrl);
  for (const path of ['/join/4', '/%2565nroll/4', '/groups?enroll=4', '/groups?action=join', '/members/4', '/roster', '/logout']) assert.throws(() => policy.check(provider + path), { code: 'UNSAFE_SERVICE_ACTION' });
  for (const [url, method, navigation, body, contentType] of [
    ['https://evil.example/collect', 'POST', true, 'id_token=SYNTHETIC_TOKEN&state=SYNTHETIC_STATE', type],
    [provider + '/groups', 'POST', true, 'group=4', type], [plan.targetUrl, 'POST', false, 'id_token=x&state=y', type],
    [plan.targetUrl, 'POST', true, 'id_token=x&state=y&enroll=4', type], [plan.targetUrl, 'DELETE', true, '', type],
    [plan.loginUrl, 'POST', true, JSON.stringify(initial), 'application/json'],
  ] as const) assert.throws(() => policy.check(url, method, navigation, body, contentType));
  assert.throws(() => policy.check(`${origin}/d2l/lti/authenticate?redirect_uri=${encodeURIComponent('https://evil.example/callback')}`), { code: 'UNSAFE_SERVICE_TARGET' });
  assert.throws(() => policy.check(`${origin}/d2l/lti/authenticate?redirect_uri=${encodeURIComponent(plan.targetUrl)}&redirect_uri=${encodeURIComponent(plan.targetUrl)}`), { code: 'UNSAFE_SERVICE_TARGET' });
  assert.doesNotMatch(policy.redact('A reflected SYNTHETIC_TOKEN or SYNTHETIC_STATE or SYNTHETIC_LOGIN_HINT must not be returned.'), /SYNTHETIC_/);
});

test('initial session imports only Brightspace state and narrows university parent-domain cookies', () => {
  const cookie = { name: 'test', value: 'SYNTHETIC_COOKIE', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' as const };
  const scoped = serviceStorageForBrightspace({ cookies: [{ ...cookie, domain: '.tudelft.nl' }, { ...cookie, domain: 'login.microsoftonline.com' }, { ...cookie, domain: 'group-self.lti.tudelft.nl' }], origins: [{ origin, localStorage: [] }, { origin: provider, localStorage: [{ name: 'secret', value: 'old provider session' }] }] }, origin);
  assert.equal(scoped.cookies.length, 1);
  assert.equal(scoped.cookies[0]?.domain, 'brightspace.tudelft.nl');
  assert.deepEqual(scoped.origins, [{ origin, localStorage: [] }]);
});

test('missing numeric account identity fails before a browser or authenticated provider handoff', async () => {
  const client = { config: { baseUrl: origin }, json: async () => ({ Identifier: '123', Name: 'Example', Code: 'EX123' }), sessionIdentity: async () => undefined } as unknown as BrightspaceClient;
  const reader = { open: async () => assert.fail('No browser is opened for an unverified account') } as unknown as BrowserReader;
  await assert.rejects(new CourseServices(client, reader).read('123', 'group_self_enrollment'), { code: 'AUTH_REQUIRED' });
});

async function syntheticFlow(mode: 'normal' | 'external_redirect' | 'account_change' | 'provider_write' | 'post_redirect' | 'public_guide' | 'public_guide_acceptance') {
  const publicGuide = mode === 'public_guide' || mode === 'public_guide_acceptance';
  const flowPlan = mode === 'public_guide_acceptance' ? { ...studyPlan, targetUrl: 'https://tudelft-acc.sqill.it/lti/1.3/launch' } : publicGuide ? studyPlan : plan;
  const callbackUrl = mode === 'public_guide_acceptance' ? studyPlan.targetUrl : flowPlan.targetUrl;
  const flowInitial = { ...initial, target_link_uri: flowPlan.targetUrl };
  const visited: Array<{ url: string; method: string; cookie?: string }> = [];
  const authUrl = `${origin}/d2l/lti/authenticate?redirect_uri=${encodeURIComponent(callbackUrl)}&state=SYNTHETIC_STATE`;
  const server = createServer((req, res) => {
    const incoming = new URL(req.url!, 'http://localhost'), target = incoming.searchParams.get('target')!;
    res.setHeader('Content-Type', 'text/html');
    if (target === flowPlan.launchUrl) res.end(form(flowPlan.loginUrl, flowInitial));
    else if (target === flowPlan.loginUrl) { res.statusCode = mode === 'post_redirect' ? 307 : 302; res.setHeader('Location', mode === 'external_redirect' ? 'https://evil.example/collect' : authUrl); res.end(); }
    else if (target === authUrl) res.end(form(callbackUrl, { id_token: 'SYNTHETIC_TOKEN', state: 'SYNTHETIC_STATE' }));
    else if (target === callbackUrl) { res.statusCode = 302; res.setHeader('Location', publicGuide ? publicLink + '&not_found=https%3A%2F%2Fevil.example%2FSYNTHETIC_PRIVATE_FALLBACK' : provider + '/student/course/123'); res.end(); }
    else if (target === provider + '/student/course/123') res.end('<h1>EX123 Groups</h1><p>No open enrollment processes are available for this course.</p>' + (mode === 'provider_write' ? '<script>fetch("/groups",{method:"POST",body:"group=4"})</script>' : ''));
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`, transport = await request.newContext();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', storageState: serviceStorageForBrightspace({ cookies: [{ name: 'test', value: 'SYNTHETIC_COOKIE', domain: '.tudelft.nl', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'None' }], origins: [] }, origin) });
    let accountChecks = 0;
    const verify = async () => { accountChecks++; if (mode === 'account_change') throw new BrightspaceError('ACCOUNT_CHANGED', 'Changed'); };
    const fetchResponse = async (route: Route) => {
      const req = route.request();
      visited.push({ url: req.url(), method: req.method(), cookie: req.headers().cookie });
      // Test fixture transport is unauthenticated localhost only. Never forwards cookie headers.
      return transport.fetch(local + '/fixture?target=' + encodeURIComponent(req.url()), { method: req.method(), data: req.postData() ?? undefined, maxRedirects: 0 });
    };
    const guard = await guardServiceNavigation(context, flowPlan, verify, fetchResponse), page = await context.newPage();
    await page.goto(flowPlan.launchUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    for (let i = 0; i < 60 && !guard.failure && !guard.publicGuideHandoff && !await page.locator('h1').count(); i++) await page.waitForTimeout(50);
    if (mode === 'provider_write') for (let i = 0; i < 20 && !guard.failure; i++) await page.waitForTimeout(50);
    return { guard, visited, accountChecks, text: await page.locator('body').innerText().catch(() => '') };
  } finally { await browser.close(); await transport.dispose(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('synthetic browser follows real OIDC forms and separately guarded redirects without sending BS cookies to provider', async () => {
  const result = await syntheticFlow('normal');
  assert.equal(result.guard.failure, undefined);
  assert.match(result.text, /EX123 Groups/);
  assert.equal(result.accountChecks, 2);
  assert.equal(result.visited.filter((entry) => entry.method === 'POST').length, 2);
  assert.ok(result.visited.find((entry) => entry.url === plan.launchUrl)?.cookie?.includes('SYNTHETIC_COOKIE'));
  assert.ok(result.visited.filter((entry) => new URL(entry.url).origin === provider).every((entry) => !entry.cookie));
  assert.doesNotMatch(result.guard.redact('SYNTHETIC_TOKEN SYNTHETIC_STATE'), /SYNTHETIC_/);
});

test('external redirects and POST replay redirects are blocked before any unverified request is sent', async () => {
  for (const mode of ['external_redirect', 'post_redirect'] as const) {
    const result = await syntheticFlow(mode);
    assert.ok(result.guard.failure);
    assert.equal(result.visited.length, 2);
    assert.ok(result.visited.every((entry) => new URL(entry.url).origin !== 'https://evil.example'));
  }
});

test('account replacement prevents even the first provider authentication post', async () => {
  const result = await syntheticFlow('account_change');
  assert.equal(result.guard.failure?.code, 'ACCOUNT_CHANGED');
  assert.deepEqual(result.visited.map((entry) => entry.url), [plan.launchUrl]);
});

test('a provider background write is blocked instead of being mistaken for a read', async () => {
  const result = await syntheticFlow('provider_write');
  assert.equal(result.guard.failure?.code, 'UNSAFE_SERVICE_ACTION');
  assert.equal(result.visited.filter((entry) => entry.url === provider + '/groups').length, 0);
});

test('public Study Guide handoffs require the exact observed response, course and academic year', () => {
  const match = (url: string) => studyGuidePublicHandoff(studyPlan, studyPlan.targetUrl, 'POST', 302, new URL(url));
  assert.deepEqual(match(publicLink + '&not_found=search'), { url: publicLink, courseCode: 'EX123', academicYear: '2026-2027' });
  assert.deepEqual(match(publicLink + '&not_found=https%3A%2F%2Fevil.example%2FSYNTHETIC_PRIVATE_FALLBACK'), match(publicLink));
  for (const url of [publicLink.replace('EX123', 'OTHER123'), publicLink.replace('2026-2027', '2025-2026'), publicLink.replace('2026-2027', '2026'),
    publicLink.replace('embedded=true', 'embedded=false'), publicLink + '&code=EX123', publicLink + '&CODE=EX123', publicLink + '&jaar=2026-2027',
    publicLink + '&redirect_uri=https://evil.example', publicLink + '#SYNTHETIC_PRIVATE_FRAGMENT', publicLink.replace('studiegids.', 'name:secret@studiegids.')]) {
    assert.throws(() => match(url), { code: 'UNSAFE_SERVICE_TARGET' });
  }
  for (const [source, method, status] of [[studyPlan.loginUrl, 'POST', 302], [studyPlan.targetUrl, 'GET', 302], [studyPlan.targetUrl, 'POST', 307]] as const) {
    assert.equal(studyGuidePublicHandoff(studyPlan, source, method, status, new URL(publicLink)), undefined);
  }
  assert.equal(studyGuidePublicHandoff(plan, plan.targetUrl, 'POST', 302, new URL(publicLink)), undefined);
  assert.equal(match(publicLink.replace('/courses/deeplink', '/courses/other')), undefined);
  assert.equal(match(publicLink.replace('studiegids.tudelft.nl', 'evil.example')), undefined);
  assert.throws(() => studyGuidePublicHandoff({ ...studyPlan, course: { ...plan.course, code: 'EX123' } }, studyPlan.targetUrl, 'POST', 302, new URL(publicLink)), { code: 'UNSAFE_SERVICE_TARGET' });
  assert.throws(() => new ServiceNavigationPolicy(studyPlan).check(publicLink), { code: 'UNSAFE_SERVICE_TARGET' });
  assert.throws(() => new ServiceNavigationPolicy(plan).check('https://auth.brightspace.com/oauth2/auth'), { code: 'UNSAFE_SERVICE_TARGET' });
  const acceptancePlan = { ...studyPlan, targetUrl: 'https://tudelft-acc.sqill.it/lti/1.3/launch' }, policy = new ServiceNavigationPolicy(acceptancePlan);
  assert.equal(policy.publicStudyGuideHandoff(studyPlan.targetUrl, 'POST', 302, new URL(publicLink)), undefined);
  policy.check(`${origin}/d2l/lti/authenticate?redirect_uri=${encodeURIComponent(studyPlan.targetUrl)}`);
  assert.deepEqual(policy.publicStudyGuideHandoff(studyPlan.targetUrl, 'POST', 302, new URL(publicLink)), match(publicLink));
});

test('real synthetic Study Guide LTI stops before public navigation and discards the untrusted fallback', async () => {
  for (const mode of ['public_guide', 'public_guide_acceptance'] as const) {
    const result = await syntheticFlow(mode);
    assert.equal(result.guard.failure, undefined);
    assert.deepEqual(result.guard.publicGuideHandoff, { url: publicLink, courseCode: 'EX123', academicYear: '2026-2027' });
    assert.equal(result.visited.length, 4);
    assert.ok(result.visited.every(entry => !['https://studiegids.tudelft.nl', 'https://evil.example', 'https://auth.brightspace.com'].includes(new URL(entry.url).origin)));
    assert.ok(result.visited.filter(entry => new URL(entry.url).origin === 'https://curriculum.tudelft.nl').every(entry => !entry.cookie));
    assert.equal(JSON.stringify(result.guard.publicGuideHandoff).includes('SYNTHETIC_'), false);
  }
});

function publicReadFixture(mode: 'normal' | 'error' | 'wrong_course' | 'wrong_year' | 'account_change' = 'normal') {
  const events: string[] = [], calls: unknown[][] = [];
  let account = '42';
  const client = { config: { baseUrl: origin, timeoutMs: 1000 }, sessionIdentity: async () => account,
    json: async () => ({ Identifier: '123', Name: plan.course.name, Code: plan.course.code }) } as unknown as BrightspaceClient;
  const initialForm = form(studyPlan.loginUrl, { ...initial, target_link_uri: studyPlan.targetUrl });
  const request = fakeRequest(`<iframe src="${frameUrl}"></iframe>`, initialForm).request;
  const reader = { open: async () => ({ context: { request }, page: { url: () => plan.course.url,
    locator: () => ({ evaluateAll: async () => [{ title: 'Study Guide', url: plan.sourceUrl }] }) }, close: async () => { events.push('home_closed'); } }) } as unknown as BrowserReader;
  const guide = { getCourse: async (...args: unknown[]) => {
    calls.push(args); assert.deepEqual(events, ['home_closed', 'authenticated_context_closed']);
    if (mode === 'error') throw new BrightspaceError('NOT_FOUND', 'No exact public course was found.');
    if (mode === 'account_change') account = '99';
    return { authentication: 'anonymous', source: 'public_study_guide', course: { code: mode === 'wrong_course' ? 'OTHER123' : 'EX123', academicYear: mode === 'wrong_year' ? '2025-2026' : '2026-2027' }, sections: [{ text: 'Published learning objectives' }], complete: true };
  } } as unknown as Pick<PublicStudyGuide, 'getCourse'>;
  const service = new CourseServices(client, reader, async () => {
    events.push('authenticated_context_closed');
    return { source: 'public_guide_handoff', handoff: { url: publicLink, courseCode: 'EX123', academicYear: '2026-2027' }, blockedRequests: 0 };
  }, guide);
  return { service, calls };
}

test('public handoff reads exact anonymous course data after authenticated browsing ends, with an explicit source', async () => {
  const fixture = publicReadFixture(), result = await fixture.service.read('123', 'study_guide');
  assert.deepEqual(fixture.calls, [['EX123', '2026-2027', 'en']]);
  assert.equal(result.source, 'anonymous_public_study_guide');
  assert.equal('page' in result, false);
  assert.equal('authentication' in result && result.authentication, 'anonymous');
  assert.equal('academicYearVerified' in result && result.academicYearVerified, true);
  assert.equal(result.courseIdentityVerified, true);
});

test('public handoff propagates failed resolution and rejects changed course/year or account', async () => {
  for (const [mode, code] of [['error', 'NOT_FOUND'], ['wrong_course', 'COURSE_CHANGED'], ['wrong_year', 'COURSE_CHANGED'], ['account_change', 'ACCOUNT_CHANGED']] as const) {
    await assert.rejects(publicReadFixture(mode).service.read('123', 'study_guide'), { code });
  }
});
