import { createHash } from 'node:crypto';
import { chromium, type APIResponse, type Browser, type BrowserContext, type Route } from 'playwright';
import { load } from 'cheerio';
import type { Auth } from './auth.js';
import type { BrightspaceClient } from './client.js';
import { BrightspaceError, safeError } from './errors.js';
import { Vault } from './vault.js';
import { numericId, plainText, record, safeSourceUrl, str, type Row } from './util.js';

const PORTAL = 'https://collegeramavideoportal.tudelft.nl';
const CONNECT = 'https://connect.surfconext.nl';
const ENGINE = 'https://engine.surfconext.nl';
const IDP = 'https://login.tudelft.nl';
const OIDC_CLIENT = 'collegeramavideoportal.tudelft.nl-1';
const USER_KEY = 'oidc.user:' + CONNECT + '/:' + OIDC_CLIENT;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const LOGIN_MS = 10 * 60_000;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

type Client = Pick<BrightspaceClient, 'config' | 'json' | 'list' | 'sessionIdentity'>;
interface Identity { accountId: string; uniqueName: string; emails: string[] }
interface Target { courseId: string; topicId: string; url: string; slug: string; presentationId: string; sourceUrl: string; identity: Identity }
interface ProviderSession {
  version: 1; brightspaceOrigin: string; accountId: string; providerOrigin: string; authority: string;
  accessToken: string; expiresAt: number; subjectHash: string; identityMethod: string; savedAt: string;
}
export interface RecordingLoginStatus {
  state: 'idle' | 'waiting' | 'connected' | 'failed'; message: string;
  courseId?: string; topicId?: string; error?: ReturnType<typeof safeError>;
}

function normalized(value: unknown): string { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function values(value: unknown): string[] { return (Array.isArray(value) ? value : [value]).map(normalized).filter(Boolean); }
function principal(value: string): string | undefined {
  const match = /^([a-z0-9._-]+)@(tudelft\.nl|student\.tudelft\.nl)$/.exec(value); return match?.[1];
}

/** SURF preferred_username is a display name, not an institutional login identifier. */
export function matchRecordingIdentity(identity: Identity, claims: Row): string {
  const uniqueName = normalized(identity.uniqueName), home = normalized(claims.schac_home_organization);
  if (home && home !== 'tudelft.nl') throw new BrightspaceError('RECORDING_ACCOUNT_MISMATCH', 'The recording login belongs to another institution.');
  const netid = principal(uniqueName) ?? (/^[a-z0-9._-]+$/.test(uniqueName) ? uniqueName : undefined);
  const uids = values(claims.uids), principals = values(claims.eduperson_principal_name);
  if (home === 'tudelft.nl' && netid && uids.includes(netid)) return 'institutional_uid';
  if (netid && principals.some(value => principal(value) === netid)) return 'institutional_principal';
  const email = normalized(claims.email);
  if (claims.email_verified === true && email && Boolean(principal(email)) && (identity.emails.map(normalized).includes(email)
    || email === uniqueName && Boolean(principal(email)) || netid && principal(email) === netid)) return 'verified_institutional_email';
  if (home === 'tudelft.nl' && uids.length || principals.length || claims.email_verified === true && email && principal(email)) {
    throw new BrightspaceError('RECORDING_ACCOUNT_MISMATCH', 'The recording login could not be matched to the current Brightspace account. Sign in with the same TU Delft account.');
  }
  throw new BrightspaceError('RECORDING_IDENTITY_UNVERIFIED', 'The provider did not supply a comparable institutional identifier. Display names are not sufficient.',
    { availableClaimNames: Object.keys(claims).filter(key => /^[a-zA-Z_][a-zA-Z0-9_.-]{0,70}$/.test(key)).slice(0, 40) });
}

function presentationId(value: unknown): string | undefined {
  const id = str(value).replace(/-/g, '').toLowerCase(); return /^[a-f0-9]{32,34}$/.test(id) ? id : undefined;
}
function portalTarget(raw: string): { url: string; slug: string; presentationId: string } | undefined {
  let url: URL; try { url = new URL(raw); } catch { return undefined; }
  if (url.origin !== PORTAL || url.username || url.password || url.hash) return undefined;
  const match = /^\/catalogue\/([a-zA-Z0-9_-]{1,100})\/presentation\/([a-fA-F0-9-]{32,38})\/?$/.exec(url.pathname);
  const id = presentationId(match?.[2]);
  if (!match || !id || [...url.searchParams.keys()].some(key => key !== 'academicYear') || url.searchParams.getAll('academicYear').length > 1) return undefined;
  const year = url.searchParams.get('academicYear'); if (year && !/^[a-zA-Z0-9_-]{1,120}$/.test(year)) return undefined;
  return { url: url.href, slug: match[1]!, presentationId: id };
}

export function recordingRequestAllowed(url: URL, method: string, resourceType: string, postData?: string | null): boolean {
  if (![PORTAL, CONNECT, ENGINE, IDP].includes(url.origin) || url.username || url.password) return false;
  if (resourceType === 'media' || /\.(?:mp4|webm|m3u8|mpd|m4a|mp3|wav|m4v|mov)(?:$|\/)/i.test(url.pathname)
    || /analytics|telemetry|statistics|tracking|logout|signout/i.test(url.pathname)) return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (url.origin === CONNECT && url.pathname === '/oidc/authorize') {
      const p = url.searchParams;
      if ([...p.keys()].some(key => p.getAll(key).length !== 1)) return false;
      if (['client_id', 'redirect_uri', 'response_type', 'scope', 'state'].some(key => p.getAll(key).length !== 1)
        || p.get('client_id') !== OIDC_CLIENT || p.get('redirect_uri') !== PORTAL + '/callback'
        || p.get('response_type') !== 'code' || p.get('scope') !== 'openid profile'
        || !p.get('state') || (p.get('state') ?? '').length > 1024
        || p.has('code_challenge_method') && p.get('code_challenge_method') !== 'S256') return false;
    }
    if (url.origin === PORTAL && url.pathname.startsWith('/api/')) return false;
    return true;
  }
  if (method !== 'POST') return false;
  // Password/MFA submissions are made by the student only, inside the university's login page.
  if (url.origin === IDP) return /^\/(?:sso|nidp)(?:\/|$)/i.test(url.pathname);
  if (url.origin === ENGINE) return url.pathname.startsWith('/authentication/');
  if (url.origin !== CONNECT) return false;
  const form = new URLSearchParams(postData ?? '');
  if ([...form.keys()].some(key => form.getAll(key).length !== 1)) return false;
  if (url.pathname === '/oidc/token') return form.get('grant_type') === 'authorization_code'
    && form.get('client_id') === OIDC_CLIENT && form.get('redirect_uri') === PORTAL + '/callback';
  return url.pathname.startsWith('/saml/') && form.has('SAMLResponse')
    && [...form.keys()].every(key => ['SAMLResponse', 'RelayState'].includes(key));
}

const loginOrigins = [PORTAL, CONNECT, ENGINE, IDP];

/** Diagnostic labels are constants; URL paths, query strings and form values are never returned. */
function recordingLocationDiagnostic(url: URL): Row {
  let pathClass = 'unclassified_path';
  if (url.origin === PORTAL) {
    if (url.pathname === '/callback') pathClass = 'portal_callback';
    else if (url.pathname.startsWith('/api/')) pathClass = 'portal_api';
    else if (url.pathname.startsWith('/catalogue/')) pathClass = 'portal_catalogue';
    else pathClass = 'portal_page_or_asset';
  } else if (url.origin === CONNECT) {
    if (url.pathname === '/oidc/authorize') pathClass = 'oidc_authorize';
    else if (url.pathname === '/oidc/token') pathClass = 'oidc_token';
    else if (url.pathname === '/oidc/userinfo') pathClass = 'oidc_userinfo';
    else if (url.pathname.startsWith('/saml/')) pathClass = 'surf_connect_saml';
    else pathClass = 'surf_connect_other';
  } else if (url.origin === ENGINE) {
    pathClass = url.pathname.startsWith('/authentication/') ? 'surf_engine_authentication' : 'surf_engine_other';
  } else if (url.origin === IDP) {
    pathClass = /^\/(?:sso|nidp)(?:\/|$)/i.test(url.pathname) ? 'university_login' : 'university_other';
  }
  return { origin: ['https:', 'http:'].includes(url.protocol) && url.origin.length <= 200 ? url.origin : '[unrecognized origin]', pathClass };
}
function recordingRequestBlockReason(url: URL, method: string, resourceType: string): string {
  if (!loginOrigins.includes(url.origin)) return 'origin_not_allowed';
  if (url.username || url.password) return 'url_credentials_not_allowed';
  if (resourceType === 'media' || /\.(?:mp4|webm|m3u8|mpd|m4a|mp3|wav|m4v|mov)(?:$|\/)/i.test(url.pathname)) return 'media_not_allowed';
  if (/analytics|telemetry|statistics|tracking|logout|signout/i.test(url.pathname)) return 'unrequested_service_action';
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return url.origin === PORTAL && url.pathname.startsWith('/api/') ? 'portal_api_disabled_during_login' : 'oidc_authorize_parameters';
  if (method !== 'POST') return 'method_not_allowed';
  if (url.origin === IDP) return 'unrecognized_university_post_path';
  if (url.origin === ENGINE) return 'unrecognized_surf_engine_post_path';
  if (url.origin === CONNECT) return url.pathname === '/oidc/token' ? 'oidc_token_parameters' : 'unrecognized_surf_connect_post_or_form';
  return 'portal_write_not_allowed';
}

export interface RecordingGuardState { blockedRequests: number; navigationCount: number; failure?: BrightspaceError }
export type RecordingResponseFetcher = (route: Route) => Promise<APIResponse>;

/** Fetch every browser request without redirects, then independently intercept each next navigation. */
export async function guardRecordingLogin(context: BrowserContext, verifyAccount: () => Promise<void>,
  fetchResponse: RecordingResponseFetcher = route => route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 25_000 })): Promise<RecordingGuardState> {
  const state: RecordingGuardState = { blockedRequests: 0, navigationCount: 0 };
  await context.route('**/*', async route => {
    const request = route.request(), navigation = request.isNavigationRequest(), mainNavigation = navigation && !request.frame().parentFrame();
    const diagnostic = (reason: string, stage: string, target?: URL, status?: number): Row => {
      let location: Row = { origin: '[unrecognized origin]', pathClass: 'unclassified_path' };
      try { location = recordingLocationDiagnostic(new URL(request.url())); } catch { /* Never return malformed raw URLs. */ }
      return { reason, stage, request: { ...location,
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method()) ? request.method() : 'OTHER',
        navigation: mainNavigation ? 'top' : navigation ? 'frame' : 'resource' },
        ...(target ? { destination: recordingLocationDiagnostic(target) } : {}),
        ...(status !== undefined ? { status } : {}) };
    };
    const fail = (reason: string, stage = 'request', target?: URL, status?: number) => new BrightspaceError('RECORDING_LOGIN_BLOCKED',
      'The recording login requested an unsupported destination or redirect. The blocked request was not sent.', diagnostic(reason, stage, target, status));
    try {
      if (state.failure) throw state.failure;
      const url = new URL(request.url()), method = request.method();
      if (!recordingRequestAllowed(url, method, request.resourceType(), url.origin === CONNECT ? request.postData() : undefined)) {
        state.blockedRequests++;
        if (mainNavigation || [CONNECT, ENGINE, IDP].includes(url.origin) && method === 'POST') state.failure = fail(recordingRequestBlockReason(url, method, request.resourceType()));
        await route.abort('blockedbyclient').catch(() => undefined); return;
      }
      if (navigation && ++state.navigationCount > 30) throw fail('navigation_limit');
      await verifyAccount();
      const response = await fetchResponse(route);
      try {
        await verifyAccount();
        const status = response.status();
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers().location;
          if (!location || location.length > 32_000) throw fail('redirect_location_missing_or_oversized', 'redirect', undefined, status);
          let target: URL;
          try { target = new URL(location, url); } catch { throw fail('redirect_location_invalid', 'redirect', undefined, status); }
          if (!recordingRequestAllowed(target, 'GET', request.resourceType())) throw fail('redirect_' + recordingRequestBlockReason(target, 'GET', request.resourceType()), 'redirect', target, status);
          if (!navigation) throw fail('redirect_not_navigation', 'redirect', target, status);
          if ([307, 308].includes(status) && method !== 'GET' && method !== 'HEAD') throw fail('redirect_would_preserve_post', 'redirect', target, status);
          // A fresh browser GET has no forwarded POST body or Authorization header.
          // Redirect responses cannot replay login credentials outside this guard.
          await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'referrer-policy': 'no-referrer' },
            body: '<!doctype html><script>location.replace(' + JSON.stringify(target.href).replaceAll('<', '\\u003c') + ')</script>' });
        } else {
          if (mainNavigation && status >= 400) throw new BrightspaceError('RECORDING_UNAVAILABLE', 'The recording login page returned an error.', diagnostic('upstream_http_error', 'response', undefined, status));
          await route.fulfill({ response });
        }
      } finally { await response.dispose(); }
    } catch (error) {
      state.blockedRequests++;
      if (mainNavigation || request.method() === 'POST' || error instanceof BrightspaceError && ['ACCOUNT_CHANGED', 'RECORDING_SESSION_CHANGED'].includes(error.code)) {
        state.failure = error instanceof BrightspaceError ? error : new BrightspaceError('RECORDING_UNAVAILABLE', 'The recording login could not finish its guarded request.', diagnostic('guarded_transport_failed', 'transport'));
      }
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  });
  return state;
}

function requireVisibleTopic(payload: unknown, topicId: string): void {
  const root = record(payload);
  if (!Array.isArray(root.Modules)) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'The course outline could not verify this topic.');
  let visited = 0, matches = 0;
  const walk = (modules: unknown[], depth: number): void => {
    if (depth > 30) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'The course outline exceeds the verification limit.');
    for (const raw of modules) {
      if (++visited > 10_000) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'The course outline exceeds the verification limit.');
      const module = record(raw); if (module.IsHidden === true || module.IsLocked === true) continue;
      if (module.Topics != null && !Array.isArray(module.Topics) || module.Modules != null && !Array.isArray(module.Modules)) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'The course outline has an unfamiliar structure.');
      for (const rawTopic of Array.isArray(module.Topics) ? module.Topics : []) {
        if (++visited > 10_000) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'The course outline exceeds the verification limit.');
        const topic = record(rawTopic);
        if (str(topic.TopicId ?? topic.Id) === topicId && topic.IsHidden !== true && topic.IsLocked !== true) matches++;
      }
      walk(Array.isArray(module.Modules) ? module.Modules : [], depth + 1);
    }
  };
  walk(root.Modules, 0);
  if (matches !== 1) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'This topic is not uniquely present in the current visible course outline.');
}

/** Minimal recording metadata from the portal's public application model (not playback or transcripts). */
export function recordingMetadata(payload: unknown, requestedId: string): Row {
  const root = record(payload);
  if (!Array.isArray(root.value) || root.value.length > 5000) throw new BrightspaceError('RECORDING_FORMAT_CHANGED', 'The recording portal returned an unfamiliar or oversized presentation list.');
  const matches = root.value.map(record).filter(row => presentationId(row.Id) === requestedId);
  if (matches.length === 0) throw new BrightspaceError('RECORDING_NOT_FOUND', 'The exact course-linked presentation was not returned by the recording portal.');
  if (matches.length !== 1 || typeof matches[0]!.Title !== 'string') throw new BrightspaceError('RECORDING_FORMAT_CHANGED', 'The presentation metadata could not be identified uniquely.');
  const row = matches[0]!;
  const safeText = (value: unknown): string => plainText(value).replace(/https?:\/\/[^\s<>"']+/gi, url => safeSourceUrl(url, PORTAL) ?? '[unsafe URL omitted]').slice(0, 50_000);
  const duration = row.Duration;
  return { id: requestedId, title: safeText(row.Title), description: safeText(row.Description),
    durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null,
    recordedAt: typeof row.RecordDate === 'string' ? row.RecordDate.slice(0, 80) : null,
    recordedAtLocal: typeof row.RecordDateLocal === 'string' ? row.RecordDateLocal.slice(0, 80) : null,
    thumbnailUrl: typeof row.ThumbnailUrl === 'string' && row.ThumbnailUrl.length <= 2048 ? safeSourceUrl(row.ThumbnailUrl, PORTAL) : undefined, isLive: row.IsLive === true,
    listComplete: !root['odata.nextLink'] && !root['@odata.nextLink'] && !root.Next };
}

export class Collegerama {
  private loginState: RecordingLoginStatus = { state: 'idle', message: 'Run begin_recording_login to sign in to Collegerama.' };
  private generation = 0;
  private starting?: Promise<RecordingLoginStatus>;
  private loginTask?: Promise<void>;
  private browser?: Browser;
  private currentAccount?: string;
  constructor(private readonly auth: Auth, private readonly client: Client) {}

  status(): RecordingLoginStatus { return structuredClone(this.loginState); }
  private vault(accountId: string): Vault<ProviderSession> { return new Vault(this.auth.config.dataDir, 'collegerama-' + digest(this.auth.config.baseUrl + ':' + accountId).slice(0, 20)); }
  private async identity(): Promise<Identity> {
    if (this.auth.config.baseUrl !== 'https://brightspace.tudelft.nl') throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'This connector verifies Collegerama access only against TU Delft Brightspace.');
    const accountId = await this.client.sessionIdentity();
    if (!accountId) throw new BrightspaceError('AUTH_REQUIRED', 'Verify your Brightspace account before connecting lecture recordings.');
    const me = record(await this.client.json('lp', 'users/whoami'));
    if (str(me.Identifier) !== accountId || await this.client.sessionIdentity() !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The current Brightspace account changed. Run check_auth before accessing recordings.');
    const uniqueName = str(me.UniqueName);
    const emails = [me.EmailAddress, me.Email, me.ExternalEmail].map(normalized).filter(Boolean);
    if (!uniqueName && !emails.length) throw new BrightspaceError('RECORDING_IDENTITY_UNVERIFIED', 'Brightspace did not supply a comparable account identifier.');
    this.currentAccount = accountId; return { accountId, uniqueName, emails };
  }
  private async unchanged(accountId: string, generation: number): Promise<void> {
    if (generation !== this.generation) throw new BrightspaceError('RECORDING_SESSION_CHANGED', 'The recording session was closed or changed.');
    const current = await this.client.sessionIdentity();
    if (generation !== this.generation) throw new BrightspaceError('RECORDING_SESSION_CHANGED', 'The recording session was closed or changed.');
    if (current !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed during recording access.');
  }
  private async target(courseId: string, topicId: string): Promise<Target> {
    const course = numericId(courseId), topic = numericId(topicId), identity = await this.identity();
    const memberships = await this.client.list('lp', 'enrollments/myenrollments/');
    if (!memberships.items.some(item => str(record(record(item).OrgUnit).Id) === course && record(record(item).Access).CanAccess !== false)) {
      throw new BrightspaceError('COURSE_NOT_ENROLLED', 'This recording reader requires an exact course in your own Brightspace memberships.');
    }
    requireVisibleTopic(await this.client.json('le', course + '/content/toc'), topic);
    const detail = record(await this.client.json('le', course + '/content/topics/' + topic));
    const returnedId = detail.Id ?? detail.TopicId;
    if (returnedId !== undefined && str(returnedId) !== topic || detail.IsHidden === true || detail.IsLocked === true) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'The current course topic did not verify access to this recording.');
    const candidates = new Map<string, ReturnType<typeof portalTarget>>();
    const direct = portalTarget(str(detail.Url));
    if (direct) candidates.set(direct.url, direct);
    else {
      const rich = record(detail.Description), html = typeof detail.Description === 'string' ? detail.Description : str(rich.Html || rich.Content || rich.Text);
      if (html.length > 250_000) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'The topic description is too large to verify its recording links.');
      const $ = load(html), links = $('a[href],iframe[src]');
      if (links.length > 200) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'The topic has too many links to verify one recording unambiguously.');
      links.each((_, element) => { const node = $(element), candidate = portalTarget(node.attr('href') || node.attr('src') || ''); if (candidate) candidates.set(candidate.url, candidate); });
    }
    if (candidates.size !== 1) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'This topic must contain one exact Collegerama portal presentation link. Use list_recordings to inspect its sources.');
    const selected = [...candidates.values()][0]!;
    return { ...selected!, courseId: course, topicId: topic, identity,
      sourceUrl: this.auth.config.baseUrl + '/d2l/le/content/' + course + '/viewContent/' + topic + '/View' };
  }

  async beginLogin(courseId: string, topicId: string): Promise<RecordingLoginStatus> {
    if (this.starting) return this.starting;
    if (this.loginTask) return this.status();
    const generation = this.generation;
    this.starting = (async () => {
      const target = await this.target(courseId, topicId);
      await this.unchanged(target.identity.accountId, generation);
      this.loginState = { state: 'waiting', message: 'Complete the normal TU Delft Collegerama login and any MFA or consent in the browser. No password is entered in chat.', courseId: target.courseId, topicId: target.topicId };
      this.loginTask = this.login(target, generation).catch((error: unknown) => {
        this.loginState = { ...this.loginState, state: 'failed', message: error instanceof BrightspaceError ? error.message : 'The recording login could not finish. Try begin_recording_login again.', error: safeError(error) };
      }).finally(() => { this.loginTask = undefined; });
      return this.status();
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async providerJson(url: string, token: string): Promise<unknown> {
    const target = new URL(url);
    if (!(target.origin === CONNECT && target.pathname === '/oidc/userinfo'
      || target.origin === PORTAL && /^\/api\/v1\/nodes\/[a-zA-Z0-9_-]{1,100}\/presentations\/$/.test(target.pathname))
      || target.username || target.password || target.search || target.hash) throw new BrightspaceError('RECORDING_TARGET_UNVERIFIED', 'The recording request is not an approved metadata endpoint.');
    let response: Response;
    try { response = await fetch(target, { method: 'GET', headers: { authorization: 'Bearer ' + token, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(this.auth.config.timeoutMs) }); }
    catch { throw new BrightspaceError('RECORDING_UNAVAILABLE', 'The recording provider could not be reached.'); }
    try {
      if (response.status === 401 || response.status >= 300 && response.status < 400) throw new BrightspaceError('RECORDING_AUTH_REQUIRED', 'Run begin_recording_login to reconnect to Collegerama.');
      if (response.status === 403) throw new BrightspaceError('RECORDING_PERMISSION_DENIED', 'The provider did not allow access to this recording.');
      if (!response.ok) throw new BrightspaceError('RECORDING_UNAVAILABLE', 'The recording provider could not return this metadata.', { status: response.status });
      if (!(response.headers.get('content-type') ?? '').includes('json')) throw new BrightspaceError('RECORDING_FORMAT_CHANGED', 'The recording provider did not return JSON metadata.');
      if (Number(response.headers.get('content-length') ?? 0) > MAX_JSON_BYTES) throw new BrightspaceError('RECORDING_LIMIT', 'The recording metadata exceeded the read limit.');
      const reader = response.body?.getReader(); if (!reader) throw new BrightspaceError('RECORDING_FORMAT_CHANGED', 'The recording metadata response was empty.');
      const chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_JSON_BYTES) throw new BrightspaceError('RECORDING_LIMIT', 'The recording metadata exceeded the read limit.'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => undefined); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new BrightspaceError('RECORDING_FORMAT_CHANGED', 'The recording metadata JSON could not be read.'); }
    } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined); }
  }

  private async login(target: Target, generation: number): Promise<void> {
    const accountId = target.identity.accountId, vault = this.vault(accountId), expected = await vault.fingerprint();
    const saved = await this.auth.session();
    if (saved.identity?.id !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The saved Brightspace account changed before recording login.');
    // Reuse only the normal TU/SURF SSO cookies; never transfer Brightspace bearer/cookies/storage.
    const shared = await this.auth.sso(accountId), cookies = shared.cookies;
    await this.unchanged(accountId, generation);
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: false, channel: this.auth.config.browserChannel }); this.browser = browser;
      await this.unchanged(accountId, generation);
      const context = await browser.newContext({ storageState: { cookies, origins: [] }, serviceWorkers: 'block', acceptDownloads: false });
      await context.routeWebSocket('**/*', socket => socket.close());
      const guard = await guardRecordingLogin(context, () => this.unchanged(accountId, generation));
      const page = await context.newPage();
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: this.auth.config.timeoutMs }).catch(error => { if (guard.failure) throw guard.failure; throw error; });
      const deadline = Date.now() + LOGIN_MS;
      let clicked = false;
      while (Date.now() < deadline) {
        await this.unchanged(accountId, generation);
        if (guard.failure) throw guard.failure;
        if (page.isClosed()) throw new BrightspaceError('RECORDING_LOGIN_CANCELLED', 'The recording login browser was closed.');
        const location = new URL(page.url());
        if (location.origin === PORTAL) {
          const stored = await page.evaluate(key => localStorage.getItem(key), USER_KEY);
          if (stored) {
            let user: Row; try { user = record(JSON.parse(stored)); } catch { throw new BrightspaceError('RECORDING_FORMAT_CHANGED', 'The portal returned an unfamiliar login state.'); }
            const token = str(user.access_token), expiresAt = Number(user.expires_at) * 1000;
            if (!token || token.length > 32_000 || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new BrightspaceError('RECORDING_AUTH_REQUIRED', 'The recording login did not provide a valid current session.');
            const claims = record(await this.providerJson(CONNECT + '/oidc/userinfo', token));
            const subject = str(claims.sub);
            if (!subject || str(record(user.profile).sub) !== subject) throw new BrightspaceError('RECORDING_IDENTITY_UNVERIFIED', 'The provider session and verified account identifier did not agree.');
            const method = matchRecordingIdentity(target.identity, claims);
            await this.unchanged(accountId, generation);
            if (page.isClosed()) throw new BrightspaceError('RECORDING_LOGIN_CANCELLED', 'The recording login browser was closed before the account was saved.');
            await vault.save({ version: 1, brightspaceOrigin: this.auth.config.baseUrl, accountId, providerOrigin: PORTAL, authority: CONNECT,
              accessToken: token, expiresAt, subjectHash: digest(subject), identityMethod: method, savedAt: new Date().toISOString() }, expected);
            await this.unchanged(accountId, generation);
            const storage = await context.storageState();
            await this.unchanged(accountId, generation);
            await shared.save(storage.cookies, () => {
              if (generation !== this.generation || page.isClosed()) throw new BrightspaceError('RECORDING_LOGIN_CANCELLED', 'The recording login was cancelled before saving shared sign-in.');
            });
            this.loginState = { state: 'connected', message: 'Collegerama is connected to the verified Brightspace account.', courseId: target.courseId, topicId: target.topicId };
            return;
          }
          if (!clicked) {
            const signIn = page.getByRole('button', { name: /^(?:sign in|log in|login|inloggen)$/i }).or(page.getByRole('link', { name: /^(?:sign in|log in|login|inloggen)$/i })).filter({ visible: true });
            if (await signIn.count()) { clicked = true; await signIn.first().click({ timeout: 5000 }); }
          }
        }
        await page.waitForTimeout(750);
      }
      throw new BrightspaceError('RECORDING_LOGIN_TIMEOUT', 'The recording login timed out. Run begin_recording_login again.');
    } finally { await browser?.close().catch(() => undefined); if (this.browser === browser) this.browser = undefined; }
  }

  async read(courseId: string, topicId: string, options: { offset?: number; maxChars?: number } = {}): Promise<Row> {
    const offset = options.offset ?? 0, maxChars = options.maxChars ?? 20_000;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 100_000) throw new BrightspaceError('INVALID_RANGE', 'Use a nonnegative text offset and between 1 and 100,000 characters.');
    const generation = this.generation, target = await this.target(courseId, topicId), accountId = target.identity.accountId;
    const vault = this.vault(accountId), fingerprint = await vault.fingerprint(), session = await vault.load();
    if (!session || session.version !== 1 || session.accountId !== accountId || session.brightspaceOrigin !== this.auth.config.baseUrl
      || session.providerOrigin !== PORTAL || session.authority !== CONNECT || typeof session.accessToken !== 'string'
      || !session.accessToken || session.accessToken.length > 32_000 || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
      throw new BrightspaceError('RECORDING_AUTH_REQUIRED', 'Run begin_recording_login and complete the normal Collegerama login before reading recordings.');
    }
    const unchanged = async (): Promise<void> => {
      await this.unchanged(accountId, generation);
      if (await vault.fingerprint() !== fingerprint) throw new BrightspaceError('RECORDING_SESSION_CHANGED', 'The saved recording login changed during the read. Retry after checking login status.');
      await this.unchanged(accountId, generation);
    };
    await unchanged();
    const claims = record(await this.providerJson(CONNECT + '/oidc/userinfo', session.accessToken));
    if (!str(claims.sub) || digest(str(claims.sub)) !== session.subjectHash) throw new BrightspaceError('RECORDING_ACCOUNT_MISMATCH', 'The verified recording account changed. Reconnect with the current Brightspace account.');
    matchRecordingIdentity(target.identity, claims);
    await unchanged();
    const metadataUrl = PORTAL + '/api/v1/nodes/' + target.slug + '/presentations/';
    const metadata = recordingMetadata(await this.providerJson(metadataUrl, session.accessToken), target.presentationId);
    await unchanged();
    const text = [str(metadata.title), str(metadata.description)].filter(Boolean).join('\n\n');
    const summary = { ...metadata, title: str(metadata.title).slice(0, 1000), description: str(metadata.description).slice(0, 500), descriptionChars: str(metadata.description).length };
    return { source: 'provider_api', provider: 'Collegerama', courseId: target.courseId, topicId: target.topicId,
      url: target.url, sourceUrl: target.sourceUrl, metadataUrl, metadata: summary, fetchedAt: new Date().toISOString(), timezone: 'Europe/Amsterdam',
      text: text.slice(offset, offset + maxChars), totalChars: text.length, nextOffset: offset + maxChars < text.length ? offset + maxChars : null,
      complete: false, metadataVerified: true, accountVerified: true, mediaBytesFetched: false,
      transcript: { status: 'not_read', text: null },
      coverage: 'Exact course-linked presentation metadata. Playback, media bytes and caption/transcript contents were not read.' };
  }

  async close(): Promise<void> {
    this.generation++;
    await this.browser?.close().catch(() => undefined);
    await this.starting?.catch(() => undefined); await this.loginTask;
    this.loginState = { state: 'idle', message: 'The recording connection is closed. Saved recording access is checked when read_recording runs.' };
  }
  async logout(): Promise<void> {
    const session = await this.auth.session().catch(() => undefined), accountId = session?.identity?.id ?? this.currentAccount;
    await this.close();
    if (accountId) await this.vault(accountId).clear();
    this.loginState = { state: 'idle', message: 'The local Collegerama login has been removed.' };
  }
}
