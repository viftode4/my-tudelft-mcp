import { load } from 'cheerio';
import { chromium, type APIRequestContext, type APIResponse, type BrowserContext, type Route } from 'playwright';
import type { BrightspaceClient } from './client.js';
import { BrowserReader, browserStorageForOrigin, snapshotPage, type PageSnapshot } from './browser.js';
import type { BrowserState } from './auth.js';
import { observeCourseTools, resolveStudentCourse, type CourseToolLink, type StudentCourseInfo } from './course-navigation.js';
import { BrightspaceError } from './errors.js';
import { PublicStudyGuide } from './study-guide.js';
import { numericId, safeSourceUrl } from './util.js';

export type CourseServiceName = 'study_guide' | 'group_self_enrollment';
const definitions = {
  study_guide: { title: 'Study Guide', provider: 'SQill', loginOrigin: 'https://curriculum.tudelft.nl', loginPath: /^\/lti\/1\.3\/login$/, targetOrigins: ['https://curriculum.tudelft.nl', 'https://tudelft-acc.sqill.it'], targetPath: /^\/lti\/1\.3\/launch$/ },
  group_self_enrollment: { title: 'Group Self Enrollment', provider: 'TU Delft Group Self Enrollment', loginOrigin: 'https://group-self.lti.tudelft.nl', loginPath: /^\/init\/[a-f0-9-]{36}\/$/, targetOrigins: ['https://group-self.lti.tudelft.nl'], targetPath: /^\/lti\/launch\/$/ },
} as const;

/** A short-lived launch plan, kept in memory only. Never return protocol query values. */
export interface CourseServiceLaunch {
  service: CourseServiceName; course: StudentCourseInfo; sourceUrl: string;
  brightspaceOrigin: string; launchUrl: string; loginUrl: string; targetUrl: string;
}
const initialFields = ['iss', 'login_hint', 'target_link_uri', 'lti_deployment_id', 'client_id', 'lti_message_hint'];

function strictUrl(input: string, base?: string): URL {
  let url: URL;
  try { url = new URL(input, base); } catch { throw new BrightspaceError('SERVICE_FORMAT_CHANGED', 'The course service returned an invalid URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The course service target must use HTTPS without embedded credentials.');
  return url;
}
function targetAllowed(service: CourseServiceName, url: URL): boolean {
  const definition = definitions[service];
  return (definition.targetOrigins as readonly string[]).includes(url.origin) && definition.targetPath.test(url.pathname) && !url.search && !url.hash;
}
function rejectDuplicateParameters(url: URL): void {
  const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
  if (new Set(names).size !== names.length) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The service URL contains ambiguous duplicate parameters.');
}

export interface PublicStudyGuideHandoff { url: string; courseCode: string; academicYear: string; }

/** The observed Study Guide transition carries public course filters, not login credentials. */
export function studyGuidePublicHandoff(plan: CourseServiceLaunch, sourceUrl: string, method: string, status: number, target: URL): PublicStudyGuideHandoff | undefined {
  if (plan.service !== 'study_guide' || method !== 'POST' || status !== 302
    || target.origin !== 'https://studiegids.tudelft.nl' || target.pathname !== '/courses/deeplink') return undefined;
  const callback = strictUrl(sourceUrl);
  if (!targetAllowed(plan.service, callback) || ![new URL(plan.loginUrl).origin, new URL(plan.targetUrl).origin].includes(callback.origin)) return undefined;
  const verified = strictUrl(target.href);
  rejectDuplicateParameters(verified);
  const course = /^([A-Z0-9][A-Z0-9_-]{1,31})\+(20\d{2})\+\d{1,2}$/i.exec(plan.course.code);
  const academicYear = course ? `${course[2]}-${Number(course[2]) + 1}` : undefined;
  const params = verified.searchParams;
  if (!course || verified.hash || [...params.keys()].some(key => !['code', 'jaar', 'embedded', 'not_found'].includes(key))
    || params.get('code') !== course[1] || params.get('jaar') !== academicYear || params.get('embedded') !== 'true') {
    throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The public Study Guide redirect does not match this exact course and academic year.');
  }
  const clean = new URL('https://studiegids.tudelft.nl/courses/deeplink');
  clean.searchParams.set('code', course[1]!); clean.searchParams.set('jaar', academicYear!); clean.searchParams.set('embedded', 'true');
  // not_found controls the public SPA's fallback screen; it is neither followed nor retained.
  return { url: clean.href, courseCode: course[1]!, academicYear: academicYear! };
}

export function validateServiceForm(service: CourseServiceName, html: string, launchUrl: string, brightspaceOrigin: string): { loginUrl: string; targetUrl: string } {
  const $ = load(html), form = $('form');
  if (form.length !== 1 || form.attr('method')?.toLowerCase() !== 'post') throw new BrightspaceError('SERVICE_FORMAT_CHANGED', 'The course service did not return the observed LTI login form.');
  const login = strictUrl(form.attr('action') ?? '', launchUrl), definition = definitions[service];
  if (login.origin !== definition.loginOrigin || !definition.loginPath.test(login.pathname) || login.search || login.hash) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The LTI login destination does not match the observed TU Delft service.');
  const inputs = form.find('input[name]').toArray(), fields = inputs.map((input) => $(input).attr('name')!);
  if (fields.length !== initialFields.length || initialFields.some((key) => fields.filter((name) => name === key).length !== 1)) throw new BrightspaceError('SERVICE_FORMAT_CHANGED', 'The LTI login form fields changed.');
  if (form.find('input[name=iss]').attr('value') !== brightspaceOrigin) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The LTI issuer does not match the connected Brightspace service.');
  const target = strictUrl(form.find('input[name=target_link_uri]').attr('value') ?? '');
  if (!targetAllowed(service, target)) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The LTI launch destination does not match the observed course service.');
  return { loginUrl: login.href, targetUrl: target.href };
}

async function readLaunchHtml(request: APIRequestContext, url: string, timeout: number): Promise<string> {
  const response = await request.get(url, { maxRedirects: 0, timeout });
  try {
    if (response.status() === 401 || response.status() >= 300 && response.status() < 400) throw new BrightspaceError('AUTH_REQUIRED', 'Reconnect Brightspace before launching the course service.');
    if (!response.ok()) throw new BrightspaceError('SERVICE_UNAVAILABLE', 'Brightspace could not open the linked course service.');
    const body = await response.text();
    if (body.length > 2_000_000) throw new BrightspaceError('SERVICE_FORMAT_CHANGED', 'The course service launch page is unexpectedly large.');
    return body;
  } finally { await response.dispose(); }
}

export async function discoverServiceLaunch(request: APIRequestContext, link: CourseToolLink, course: StudentCourseInfo, service: CourseServiceName, brightspaceOrigin: string, timeout = 25_000): Promise<CourseServiceLaunch> {
  const id = numericId(course.id), source = strictUrl(link.url, brightspaceOrigin);
  rejectDuplicateParameters(source);
  if (link.kind !== 'lti' || link.title !== definitions[service].title || source.origin !== brightspaceOrigin || source.pathname !== '/d2l/common/dialogs/quickLink/quickLink.d2l' || source.searchParams.get('ou') !== id || source.searchParams.get('type') !== 'lti') throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'Use the matching LTI link observed on this exact course home.');
  const wrapper = load(await readLaunchHtml(request, source.href, timeout));
  const frames = wrapper('iframe[src]').toArray();
  if (frames.length !== 1) throw new BrightspaceError('SERVICE_FORMAT_CHANGED', 'The Brightspace service wrapper changed.');
  const frame = strictUrl(wrapper(frames[0]!).attr('src')!, brightspaceOrigin);
  rejectDuplicateParameters(frame);
  const match = /^\/d2l\/lti\/orgUnit\/(\d+)\/link\/(\d+)\/componentLaunch$/.exec(frame.pathname);
  if (frame.origin !== brightspaceOrigin || match?.[1] !== id) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The service wrapper does not match the requested course.');
  const launch = strictUrl(frame.searchParams.get('launchLocation') ?? '', brightspaceOrigin);
  rejectDuplicateParameters(launch);
  if (launch.origin !== brightspaceOrigin || !new RegExp(`^/d2l/le/lti/${id}/toolLaunch/${match[2]}/[0-9]+$`).test(launch.pathname)) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The observed LTI launch does not match the requested course.');
  if (!source.searchParams.get('rcode') || launch.searchParams.get('resourceCode') !== source.searchParams.get('rcode')) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The LTI resource does not match the observed course link.');
  const form = validateServiceForm(service, await readLaunchHtml(request, launch.href, timeout), launch.href, brightspaceOrigin);
  return { service, course, sourceUrl: safeSourceUrl(source.href, brightspaceOrigin)!, brightspaceOrigin, launchUrl: launch.href, ...form };
}

function decodedAction(url: URL): string {
  let action = url.pathname + url.search;
  try {
    for (let i = 0; i < 4; i++) { const next = decodeURIComponent(action); if (next === action) break; action = next; }
  } catch { throw new BrightspaceError('UNSAFE_SERVICE_ACTION', 'The service URL contains invalid escaping.'); }
  if (/%[0-9a-f]{2}/i.test(action)) throw new BrightspaceError('UNSAFE_SERVICE_ACTION', 'The service URL contains nested escaping.');
  return action;
}

/** Allows protocol authentication, then reads. It never permits group or curriculum edits. */
export class ServiceNavigationPolicy {
  readonly origins: Set<string>;
  private readonly callbacks = new Set<string>();
  private readonly protocolSecrets = new Set<string>();
  constructor(readonly plan: CourseServiceLaunch) {
    const login = strictUrl(plan.loginUrl), target = strictUrl(plan.targetUrl), definition = definitions[plan.service];
    if (login.origin !== definition.loginOrigin || !definition.loginPath.test(login.pathname) || login.search || login.hash || !targetAllowed(plan.service, target)) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The service launch plan has an unverified destination.');
    this.origins = new Set([plan.brightspaceOrigin, login.origin, target.origin]);
    this.callbacks.add(target.href);
  }
  publicStudyGuideHandoff(sourceUrl: string, method: string, status: number, target: URL): PublicStudyGuideHandoff | undefined {
    if (!this.callbacks.has(sourceUrl)) return undefined;
    return studyGuidePublicHandoff(this.plan, sourceUrl, method, status, target);
  }
  check(input: string, method = 'GET', navigation = true, body = '', contentType = ''): URL {
    const url = strictUrl(input), action = decodedAction(url);
    if (navigation) rejectDuplicateParameters(url);
    const submitted = new URLSearchParams(body);
    for (const fields of [url.searchParams, submitted]) for (const key of ['id_token', 'state', 'nonce', 'login_hint', 'lti_message_hint', 'session_state']) {
      for (const value of fields.getAll(key)) if (value.length > 3) this.protocolSecrets.add(value);
    }
    if (!this.origins.has(url.origin)) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The service attempted to leave its verified university/provider origins.', { origin: url.origin });
    if (/(?:^|\/)(?:logout|signout|delete|remove|join|leave|unenrol[l]?|enrol[l]?|register|submit|save|update|create|add|edit|members|roster)(?:\/|\.|\?|$)|[?&](?:(?:action|cmd)=(?:join|leave|enrol[l]?|register|submit|delete|save|update)|(?:join|leave|enrol[l]?|unenrol[l]?|register|submit|delete|save|update)=)/i.test(action)) throw new BrightspaceError('UNSAFE_SERVICE_ACTION', 'Group changes, peer rosters, and service edits require a separate action tool.');
    if (url.origin === this.plan.brightspaceOrigin) {
      const initial = url.href === this.plan.launchUrl;
      const protocol = /^\/d2l\/(?:le\/)?lti\//.test(url.pathname);
      const asset = !navigation && /\.(?:js|css|svg|png|ico|woff2?)(?:$|\?)/i.test(url.pathname);
      if (!initial && !protocol && !asset) throw new BrightspaceError('UNSAFE_SERVICE_ACTION', 'The LTI handoff attempted to open an unrelated Brightspace action.');
      const redirect = url.searchParams.get('redirect_uri');
      if (redirect) {
        const callback = strictUrl(redirect);
        if (!targetAllowed(this.plan.service, callback) || !this.origins.has(callback.origin)) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The LTI callback destination is not verified.');
        this.callbacks.add(callback.href);
      }
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return url;
    if (method !== 'POST' || !navigation || !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new BrightspaceError('UNSAFE_SERVICE_ACTION', 'Only the observed browser LTI authentication forms may submit data.');
    const fields = new URLSearchParams(body), names = [...fields.keys()];
    if (url.href === this.plan.loginUrl) {
      if (names.length !== initialFields.length || initialFields.some((key) => fields.getAll(key).length !== 1) || fields.get('iss') !== this.plan.brightspaceOrigin || fields.get('target_link_uri') !== this.plan.targetUrl) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The LTI login form changed after discovery.');
    } else if (this.callbacks.has(url.href)) {
      if (!fields.get('id_token') || !fields.get('state') || names.some((name) => !['id_token', 'state', 'session_state'].includes(name)) || names.some((name) => fields.getAll(name).length !== 1)) throw new BrightspaceError('UNSAFE_SERVICE_ACTION', 'The provider form is not a recognised LTI authentication response.');
    } else throw new BrightspaceError('UNSAFE_SERVICE_ACTION', 'The service attempted to submit an unverified form.');
    return url;
  }
  redact(text: string): string {
    for (const value of this.protocolSecrets) text = text.split(value).join('[authentication value omitted]');
    return text.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[signed token omitted]');
  }
}

export interface ServiceGuardState { blockedRequests: number; navigationCount: number; failure?: BrightspaceError; publicGuideHandoff?: PublicStudyGuideHandoff; redact: (text: string) => string; }
export type ServiceResponseFetcher = (route: Route) => Promise<APIResponse>;
export async function guardServiceNavigation(context: BrowserContext, plan: CourseServiceLaunch, verifyAccount: () => Promise<void>, fetchResponse: ServiceResponseFetcher = (route) => route.fetch({ maxRedirects: 0, timeout: 25_000 })): Promise<ServiceGuardState> {
  const policy = new ServiceNavigationPolicy(plan), state: ServiceGuardState = { blockedRequests: 0, navigationCount: 0, redact: (text) => policy.redact(text) };
  await context.route('**/*', async (route) => {
    const request = route.request(), navigation = request.isNavigationRequest();
    try {
      if (state.publicGuideHandoff) { await route.abort('blockedbyclient').catch(() => undefined); return; }
      if (state.failure) throw state.failure;
      policy.check(request.url(), request.method(), navigation, request.postData() ?? '', request.headers()['content-type'] ?? '');
      if (navigation && ++state.navigationCount > 20) throw new BrightspaceError('SERVICE_UNAVAILABLE', 'The LTI service exceeded the bounded authentication redirect limit.');
      if (request.method() === 'POST') await verifyAccount();
      const response = await fetchResponse(route);
      try {
        const status = response.status();
        if (status >= 300 && status < 400) {
          const target = strictUrl(response.headers().location ?? '', request.url());
          const handoff = navigation ? policy.publicStudyGuideHandoff(request.url(), request.method(), status, target) : undefined;
          if (handoff) {
            await verifyAccount();
            state.publicGuideHandoff = handoff;
            // End authenticated browsing here. Published course data is read through
            // the isolated anonymous Study Guide transport after this browser closes.
            await route.abort('blockedbyclient').catch(() => undefined); return;
          }
          policy.check(target.href);
          if (!navigation || (status === 307 || status === 308) && request.method() !== 'GET') throw new BrightspaceError('UNSAFE_SERVICE_ACTION', 'The service requested an unsupported redirect with submitted data.');
          // A new browser GET is independently intercepted; no authorization body or
          // request headers are manually forwarded across origins on a redirect.
          await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'referrer-policy': 'no-referrer' }, body: `<!doctype html><script>location.replace(${JSON.stringify(target.href).replaceAll('<', '\\u003c')})</script>` });
        } else {
          if (navigation && (status === 401 || status === 403)) throw new BrightspaceError('SERVICE_AUTH_REQUIRED', 'The linked service did not accept the current course login.');
          if (navigation && status >= 400) throw new BrightspaceError('SERVICE_UNAVAILABLE', 'The linked course service returned an error.');
          await route.fulfill({ response });
        }
      } finally { await response.dispose(); }
    } catch (error) {
      state.blockedRequests++;
      if (navigation || request.method() !== 'GET') state.failure = error instanceof BrightspaceError ? error : new BrightspaceError('SERVICE_UNAVAILABLE', 'The linked service could not be read.');
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  });
  return state;
}

export interface CourseServicePage { page: PageSnapshot; blockedRequests: number; courseIdentityVerified: boolean; }
export interface CourseServicePublicHandoff { source: 'public_guide_handoff'; handoff: PublicStudyGuideHandoff; blockedRequests: number; }
export type ServiceLauncher = (plan: CourseServiceLaunch, verifyAccount: () => Promise<void>) => Promise<CourseServicePage | CourseServicePublicHandoff>;

export function serviceStorageForBrightspace(storage: BrowserState, origin: string): BrowserState {
  const scoped = browserStorageForOrigin(storage, origin);
  return { ...scoped, cookies: scoped.cookies.map((cookie) => ({ ...cookie, domain: new URL(origin).hostname })) };
}

export class CourseServices {
  constructor(private readonly client: BrightspaceClient, private readonly reader: BrowserReader, private readonly launcher?: ServiceLauncher,
    private readonly publicGuide: Pick<PublicStudyGuide, 'getCourse'> = new PublicStudyGuide()) {}

  async read(courseId: string, service: CourseServiceName) {
    if (!Object.hasOwn(definitions, service)) throw new BrightspaceError('UNSUPPORTED_SERVICE', 'Choose Study Guide or Group Self Enrollment.');
    const course = await resolveStudentCourse(this.client, courseId), identity = await this.client.sessionIdentity();
    if (!identity || !/^\d{1,18}$/.test(identity)) throw new BrightspaceError('AUTH_REQUIRED', 'Verify the current Brightspace account with check_auth before launching a course service.');
    const verifyAccount = async () => { if (await this.client.sessionIdentity() !== identity) throw new BrightspaceError('ACCOUNT_CHANGED', 'The account changed while reading the course service.'); };
    const opened = await this.reader.open(course.url);
    let plan: CourseServiceLaunch;
    try {
      const links = await observeCourseTools(opened.page, this.client.config.baseUrl, course.id);
      const link = links.find((candidate) => candidate.title === definitions[service].title && candidate.kind === 'lti');
      if (!link) throw new BrightspaceError('SERVICE_NOT_AVAILABLE', 'This service was not observed in the requested course navigation.');
      plan = await discoverServiceLaunch(opened.context.request, link, course, service, this.client.config.baseUrl, this.client.config.timeoutMs);
    } finally { await opened.close(); }
    await verifyAccount();
    const result = await (this.launcher ?? this.launch.bind(this))(plan, verifyAccount);
    await verifyAccount();
    if ('handoff' in result) {
      const handoff = studyGuidePublicHandoff(plan, plan.targetUrl, 'POST', 302, new URL(result.handoff.url));
      if (!handoff) throw new BrightspaceError('UNSAFE_SERVICE_TARGET', 'The service did not verify a public Study Guide handoff.');
      const guide = await this.publicGuide.getCourse(handoff.courseCode, handoff.academicYear, 'en');
      await verifyAccount();
      if (guide.authentication !== 'anonymous' || guide.course.code.toUpperCase() !== handoff.courseCode.toUpperCase()
        || guide.course.academicYear !== handoff.academicYear) throw new BrightspaceError('COURSE_CHANGED', 'The public Study Guide data does not match the requested course and academic year.');
      return { course, service, title: definitions[service].title, provider: definitions[service].provider,
        source: 'anonymous_public_study_guide' as const, sourceUrl: plan.sourceUrl,
        loginOrigin: new URL(plan.loginUrl).origin, advertisedTargetOrigin: new URL(plan.targetUrl).origin,
        acceptanceTargetAdvertised: new URL(plan.targetUrl).hostname === 'tudelft-acc.sqill.it',
        access: 'public_course_information' as const, authentication: 'anonymous' as const, handoff,
        courseIdentityVerified: true, academicYearVerified: true, authenticatedContextClosed: true,
        blockedRequests: result.blockedRequests, guide, complete: guide.complete,
        scope: 'The observed Study Guide handoff matched this course and academic year. The login browser was closed; published course data was read anonymously. No provider page, fallback search, linked documents, or enrollment status is implied.' };
    }
    return { course, service, title: definitions[service].title, provider: definitions[service].provider, sourceUrl: plan.sourceUrl,
      loginOrigin: new URL(plan.loginUrl).origin, advertisedTargetOrigin: new URL(plan.targetUrl).origin,
      acceptanceTargetAdvertised: new URL(plan.targetUrl).hostname === 'tudelft-acc.sqill.it',
      source: 'authenticated_provider_page' as const, access: 'read' as const, ...result, complete: false,
      scope: 'Initial linked service page only. No group changes, curriculum edits, linked roster visits, or service-wide search. Course identity is verified only when the requested course code appears in the visible service page.' };
  }

  private async launch(plan: CourseServiceLaunch, verifyAccount: () => Promise<void>): Promise<CourseServicePage | CourseServicePublicHandoff> {
    const session = await this.reader.auth.session();
    await verifyAccount();
    // Parent-domain cookies from the saved university login must not become provider cookies.
    const storage = serviceStorageForBrightspace(session.storage, plan.brightspaceOrigin);
    const browser = await chromium.launch({ headless: true, channel: this.client.config.browserChannel });
    try {
      const context = await browser.newContext({ storageState: storage, serviceWorkers: 'block' });
      const guard = await guardServiceNavigation(context, plan, verifyAccount);
      const page = await context.newPage(), deadline = Date.now() + this.client.config.timeoutMs;
      await page.goto(plan.launchUrl, { waitUntil: 'domcontentloaded', timeout: this.client.config.timeoutMs }).catch(() => undefined);
      while (Date.now() < deadline) {
        if (guard.failure) throw guard.failure;
        if (guard.publicGuideHandoff) return { source: 'public_guide_handoff', handoff: guard.publicGuideHandoff, blockedRequests: guard.blockedRequests };
        for (const candidate of context.pages().flatMap((entry) => entry.frames())) {
          let url: URL; try { url = new URL(candidate.url()); } catch { continue; }
          if (!new ServiceNavigationPolicy(plan).origins.has(url.origin) || url.origin === plan.brightspaceOrigin) continue;
          if (await candidate.locator('input[type=password]').count()) throw new BrightspaceError('SERVICE_AUTH_REQUIRED', 'The provider requires a separate interactive login.');
          if (await candidate.locator('input[name=id_token],input[name=login_hint],input[name=iss]').count()) continue;
          if (/\/(?:login|init|authenticate|authorize)(?:\/|$)/i.test(url.pathname)) continue;
          const snapshot = await snapshotPage(candidate, url.origin).catch(() => undefined);
          if (!snapshot || snapshot.text.trim().length < 40) continue;
          // Allow client rendering to settle, then re-read the same provider frame.
          await page.waitForTimeout(350);
          if (guard.failure) throw guard.failure;
          const final = await snapshotPage(candidate, url.origin);
          await verifyAccount();
          const code = plan.course.code.split('+')[0]!;
          const courseIdentityVerified = new RegExp(`(?:^|[^a-z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(`${final.title}\n${final.text}`);
          const clean = (text: string) => guard.redact(text.replace(/https?:\/\/[^\s<>"']+/gi, (source) => safeSourceUrl(source, url.origin) ?? '[unsafe URL omitted]'));
          return { page: { ...final, text: clean(final.text), title: clean(final.title), url: clean(final.url),
            links: final.links.map((link) => ({ title: clean(link.title), url: clean(link.url) })),
            media: final.media.map((item) => ({ ...item, url: clean(item.url) })),
            buttons: final.buttons.map((button) => ({ ...button, label: clean(button.label) })) }, blockedRequests: guard.blockedRequests, courseIdentityVerified };
        }
        await page.waitForTimeout(200);
      }
      throw new BrightspaceError('SERVICE_NOT_READY', 'The course service did not produce a readable page within the timeout. Its LTI configuration or login may need attention.');
    } finally { await browser.close(); }
  }
}
