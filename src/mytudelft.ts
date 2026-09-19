import { createHash } from 'node:crypto';
import { type APIResponse, type Browser, type BrowserContext, type Route } from 'playwright';
import { runLoginFlow } from './login-flow.js';
import type { Auth, BrowserState } from './auth.js';
import type { BrightspaceClient } from './client.js';
import { BrightspaceError, safeError } from './errors.js';
import { Vault } from './vault.js';
import { record, str, type Row } from './util.js';
import { MYTU_ID_PATTERN, myTuApiRequestAllowed } from './mytu-routes.js';

const ORIGIN = 'https://my.tudelft.nl';
const API = '/student/osiris';
const OAUTH = 'https://osi-auth-server-prd.osiris-link.nl';
const SAML = 'https://osiris-saml.tudelft.nl';
const ENGINE = 'https://engine.surfconext.nl';
const IDP = 'https://login.tudelft.nl';
const ACS = '/osirissaml/saml2/acs/osiris-student';
const MAX_BYTES = 2 * 1024 * 1024;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
type Client = Pick<BrightspaceClient, 'config' | 'json' | 'sessionIdentity'>;
export interface MyTuAccess {
  accountId: string;
  studentHash: string;
  current: () => Promise<void>;
  request: (path: string, method?: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown) => Promise<unknown>;
}
export interface MyTuIdentity { accountId: string; studentNumbers: string[]; institutionalEmail?: string }
type IdentityMethod = 'institutional_student_number' | 'institutional_email' | 'student_confirmed_link';
interface VerifiedIdentity { studentHash: string; method: IdentityMethod }
interface Session {
  version: 1; brightspaceOrigin: string; accountId: string; providerOrigin: string;
  accessToken: string; expiresAt: number | null; studentHash: string; identityMethod: string; savedAt: string;
  providerCookies?: BrowserState['cookies'];
}
interface Token { accessToken: string; expiresAt: number | null }
export interface MyTuLoginStatus {
  state: 'idle' | 'waiting' | 'connected' | 'failed'; message: string; identityMethod?: IdentityMethod; error?: ReturnType<typeof safeError>;
}
function fieldNames(value: Row): string[] { return Object.keys(value).filter(key => /^[a-zA-Z_][a-zA-Z0-9_.-]{0,70}$/.test(key)).slice(0, 40); }
function number(value: unknown): string | undefined {
  const candidate = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^[0-9]{1,18}$/.test(candidate) ? candidate : undefined;
}
function institutionalEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 254) return undefined;
  const email = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._+-]{0,99}@(student\.)?tudelft\.nl$/.test(email) ? email : undefined;
}
/**
 * /gebruiker supplies studentnummer and the account-menu e_mailadres. The
 * contact page separately gates its same main email with read/edit permissions.
 * External and application addresses, display names, and domain/local-part guesses are excluded.
 */
export function matchMyTuIdentity(expected: MyTuIdentity, user: Row, contact?: Row): VerifiedIdentity {
  const student = number(user.studentnummer);
  const unverified = () => new BrightspaceError('MYTU_IDENTITY_UNVERIFIED',
    'The My TU Delft account could not be matched to a verified institutional identifier. The login has not been saved.',
    { availableIdentityFields: fieldNames(user), ...(contact ? { availableContactFields: fieldNames(contact) } : {}),
      brightspaceStudentNumberAvailable: expected.studentNumbers.length > 0,
      brightspaceInstitutionalEmailAvailable: Boolean(institutionalEmail(expected.institutionalEmail)) });
  const mismatch = () => new BrightspaceError('MYTU_ACCOUNT_MISMATCH',
    'The My TU Delft student account does not match the current Brightspace account. Sign in with the same TU Delft account.');
  if (!student || expected.studentNumbers.length > 1) throw unverified();
  if (user.toegang_applicatie !== undefined && user.toegang_applicatie !== 'J') throw new BrightspaceError('MYTU_PERMISSION_DENIED', 'This account does not have access to the student application.');
  // A conflicting student number must never fall through to the weaker email check.
  if (expected.studentNumbers.length) {
    if (!expected.studentNumbers.includes(student)) throw mismatch();
    return { studentHash: digest(student), method: 'institutional_student_number' };
  }
  const expectedEmail = institutionalEmail(expected.institutionalEmail), accountEmail = institutionalEmail(user.e_mailadres);
  if (!expectedEmail || !accountEmail) throw unverified();
  if (accountEmail !== expectedEmail) throw mismatch();
  if (!contact || contact.mag_e_mailadres_lezen !== 'J' || contact.mag_e_mailadres_wijzigen !== 'N') throw unverified();
  const mainEmail = institutionalEmail(contact.e_mailadres);
  if (!mainEmail) throw unverified();
  if (mainEmail !== accountEmail) throw mismatch();
  return { studentHash: digest(student), method: 'institutional_email' };
}
function tokenFrom(value: unknown): Token {
  // The web app accepts an omitted expiry until the provider rejects the token.
  // Keep that distinction explicit; every read still verifies the live account.
  const body = record(value), token = str(body.access_token), seconds = body.expires_in === undefined ? null : Number(body.expires_in);
  if (!token || token.length > 32_000 || /[\r\n]/.test(token) || seconds !== null && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 366 * 86400)
    || body.token_type !== undefined && str(body.token_type).toLowerCase() !== 'bearer') {
    throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The student application returned an unfamiliar token response.', { availableFields: fieldNames(body) });
  }
  return { accessToken: token, expiresAt: seconds === null ? null : Date.now() + seconds * 1000 };
}
function providerCookies(cookies: BrowserState['cookies']): BrowserState['cookies'] {
  return cookies.filter(cookie => cookie.domain === 'my.tudelft.nl' && cookie.secure
    && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
}
function duplicates(params: URLSearchParams): boolean { return [...params.keys()].some(key => params.getAll(key).length !== 1); }
/** OSIRIS returns its web authorization code in the root URL fragment. It never leaves the browser URL. */
function codeCallback(source: URL, target: URL, method: string): boolean {
  if (source.origin !== OAUTH || !['/oauth/authorize', '/samlagent/endpoint/acs.do'].includes(source.pathname) || method !== 'GET'
    || target.origin !== ORIGIN || target.pathname !== '/' || target.search || target.username || target.password
    || !/^#\??code=/.test(target.hash)) return false;
  const params = new URLSearchParams(target.hash.replace(/^#\??/, '')), code = params.get('code');
  return !duplicates(params) && [...params.keys()].every(key => key === 'code')
    && Boolean(code && code.length <= 16_000 && !/[\r\n]/.test(code));
}
function staticDiagnostic(url: URL): Row {
  const origin = ['https:', 'http:'].includes(url.protocol) && url.origin.length <= 200 ? url.origin : '[unrecognized origin]';
  const pathClass = url.origin === ORIGIN ? url.pathname === API + '/token' ? 'mytu_token' : url.pathname.startsWith(API + '/') ? 'mytu_api' : 'mytu_page_or_asset'
    : url.origin === OAUTH ? url.pathname === '/samlagent/endpoint/acs.do' ? 'osiris_saml_callback' : 'osiris_authorization' : url.origin === SAML ? 'university_osiris_saml'
    : url.origin === ENGINE ? 'surf_authentication' : url.origin === IDP ? 'university_login' : 'unclassified_path';
  const fragment = new URLSearchParams(url.hash.replace(/^#[/?]?/, ''));
  return { origin, pathClass, rootPath: url.pathname === '/', hasQuery: Boolean(url.search),
    fragment: url.hash.startsWith('#?code=') ? 'code_query' : url.hash.startsWith('#code=') ? 'code' : url.hash.startsWith('#/code=') ? 'code_route' : url.hash ? 'other' : 'none',
    fragmentFields: ['code', 'state', 'access_token', 'token_type', 'expires_in', 'scope', 'iss', 'error', 'session_state'].filter(key => fragment.has(key)) };
}

/** Origins and protocol routes observed in the university's public OSIRIS login bootstrap. */
export function myTuRequestAllowed(url: URL, method: string, resourceType: string, body?: string | null): boolean {
  if (![ORIGIN, OAUTH, SAML, ENGINE, IDP].includes(url.origin) || url.username || url.password || url.hash
    || resourceType === 'media' || /analytics|telemetry|tracking|logout|signout/i.test(url.pathname)) return false;
  if (url.origin === ORIGIN && url.pathname === API + '/token' && method !== 'POST') return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (url.origin === OAUTH && url.pathname === '/oauth/authorize') {
      const p = url.searchParams;
      return !duplicates(p) && p.get('response_type') === 'code' && [ORIGIN, ORIGIN + '/'].includes(p.get('redirect_uri') ?? '')
        && Boolean(p.get('client_id')) && (p.get('client_id') ?? '').length <= 200;
    }
    return true;
  }
  if (method !== 'POST') return false;
  if (url.origin === IDP) return /^\/(?:sso|nidp)(?:\/|$)/i.test(url.pathname);
  if (url.origin === ENGINE) return url.pathname.startsWith('/authentication/');
  if (url.origin === SAML && url.pathname === ACS) {
    const form = new URLSearchParams(body ?? '');
    return !duplicates(form) && form.has('SAMLResponse') && [...form.keys()].every(key => ['SAMLResponse', 'RelayState'].includes(key));
  }
  if (url.origin !== ORIGIN || url.pathname !== API + '/token' || url.search) return false;
  let json: Row;
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    json = record(parsed);
  } catch { return false; }
  // These two protocol fields have string values. Count their encoded keys before
  // forwarding the original body so duplicate-key parser differences cannot alter the callback.
  const encodedKeys = [...(body ?? '').matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)];
  let keys: string[]; try { keys = encodedKeys.map(match => JSON.parse('"' + match[1] + '"') as string); } catch { return false; }
  if (keys.length !== Object.keys(json).length || new Set(keys).size !== keys.length) return false;
  // The web app exchanges its callback code at /token; native/pre-authentication/impersonation flows are excluded.
  // The web app also renews its own HttpOnly session with an empty JSON object.
  return Object.keys(json).length === 0 || Object.keys(json).every(key => ['code', 'redirect_uri'].includes(key))
    && typeof json.code === 'string' && json.code.length > 0 && json.code.length <= 16_000
    && (json.redirect_uri === '' || json.redirect_uri === '/');
}

export interface MyTuGuardState { blockedRequests: number; navigationCount: number; failure?: BrightspaceError }
export async function guardMyTuLogin(context: BrowserContext, active: () => Promise<void>,
  observe: (url: URL, response: APIResponse) => Promise<void> = async () => undefined,
  fetchResponse: (route: Route) => Promise<APIResponse> = route => route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 25_000 })): Promise<MyTuGuardState> {
  const state: MyTuGuardState = { blockedRequests: 0, navigationCount: 0 };
  await context.route('**/*', async route => {
    const req = route.request(), navigation = req.isNavigationRequest(), top = navigation && !req.frame().parentFrame();
    const method = req.method(), knownMethod = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method) ? method : 'OTHER';
    let url: URL; try { url = new URL(req.url()); } catch { await route.abort('blockedbyclient'); return; }
    const fail = (reason: string, target?: URL) => new BrightspaceError('MYTU_LOGIN_BLOCKED',
      'The My TU Delft login requested an unsupported step. The blocked request was not sent.',
      { reason, method: knownMethod, request: staticDiagnostic(url), ...(target ? { destination: staticDiagnostic(target) } : {}) });
    try {
      if (state.failure) throw state.failure;
      if (!myTuRequestAllowed(url, method, req.resourceType(), [ORIGIN, SAML].includes(url.origin) ? req.postData() : undefined)) {
        state.blockedRequests++;
        if (top || method === 'POST' && url.origin !== ORIGIN) state.failure = fail('request_not_allowed');
        await route.abort('blockedbyclient').catch(() => undefined); return;
      }
      if (navigation && ++state.navigationCount > 40) throw fail('navigation_limit');
      await active();
      const response = await fetchResponse(route);
      try {
        await active();
        const status = response.status();
        if ([301, 302, 303, 307, 308].includes(status)) {
          const raw = response.headers().location;
          if (!raw || raw.length > 32_000) throw fail('invalid_redirect');
          let target: URL; try { target = new URL(raw, url); } catch { throw fail('invalid_redirect'); }
          if (!myTuRequestAllowed(target, 'GET', req.resourceType()) && !codeCallback(url, target, method)) throw fail('redirect_not_allowed', target);
          if (!navigation) throw fail('redirect_not_navigation', target);
          if ([307, 308].includes(status) && method !== 'GET' && method !== 'HEAD') throw fail('redirect_would_preserve_post', target);
          await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'referrer-policy': 'no-referrer' },
            body: '<!doctype html><script>location.replace(' + JSON.stringify(target.href).replaceAll('<', '\\u003c') + ')</script>' });
        } else {
          if (top && status >= 400) throw fail('upstream_navigation_error');
          await observe(url, response); await active();
          await route.fulfill({ response });
        }
      } finally { await response.dispose(); }
    } catch (error) {
      state.blockedRequests++;
      if (top || method === 'POST' || error instanceof BrightspaceError && ['ACCOUNT_CHANGED', 'MYTU_SESSION_CHANGED'].includes(error.code)) {
        state.failure = error instanceof BrightspaceError ? error : fail('guarded_transport_failed');
      }
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  });
  return state;
}

function gradeId(value: string): string {
  if (!MYTU_ID_PATTERN.test(value)) throw new BrightspaceError('INVALID_ID', 'Use an exact result identifier returned by list_official_grades.');
  return value;
}
function text(value: unknown, max = 1000): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}
/** Fields used by the live public OSIRIS grade model; only allowlisted result data is returned. */
export function officialGrade(value: unknown, expectedId?: string): Row {
  const row = record(value), rawId = row.id_resultaat;
  const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : undefined;
  if (!id || !MYTU_ID_PATTERN.test(id) || expectedId && id !== expectedId) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The student results API returned an unfamiliar result identifier.');
  return { id, courseCode: text(row.cursus, 100), courseName: text(row.cursus_korte_naam), courseId: text(row.id_cursus, 100),
    assessment: text(row.toets_omschrijving), assessmentCode: text(row.toets, 100),
    result: text(row.resultaat, 100), resultDescription: text(row.resultaat_omschrijving),
    score: text(row.score, 100), scoreDescription: text(row.score_omschrijving),
    weight: text(row.weging, 100), assessmentDate: text(row.toetsdatum, 100), updatedAt: text(row.mutatiedatum, 100),
    sourceUrl: ORIGIN + '/resultaten/' + encodeURIComponent(id) };
}
export function officialGrades(value: unknown, offset: number, limit: number): Row {
  const body = record(value);
  if (!Array.isArray(body.items) || body.items.length > limit || typeof body.hasMore !== 'boolean'
    || body.offset !== undefined && body.offset !== offset || body.limit !== undefined && body.limit !== limit
    || body.hasMore && body.items.length !== limit) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The student results API returned unfamiliar pagination.');
  const items = body.items.map(item => officialGrade(item));
  if (new Set(items.map(item => item.id)).size !== items.length) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The student results API returned duplicate result identifiers.');
  return { source: 'official_osiris_api', provider: 'My TU Delft', sourceUrl: ORIGIN + '/resultaten', items,
    offset, limit, count: Number.isSafeInteger(body.count) && Number(body.count) >= 0 ? body.count : undefined,
    hasMore: body.hasMore, nextOffset: body.hasMore ? offset + limit : null, complete: offset === 0 && !body.hasMore,
    fetchedAt: new Date().toISOString() };
}

export class MyTuDelft {
  private loginState: MyTuLoginStatus = { state: 'idle', message: 'Run begin_mytu_login to connect official TU Delft results.' };
  private generation = 0;
  private starting?: Promise<MyTuLoginStatus>;
  private loginTask?: Promise<void>;
  private browser?: Browser;
  private currentAccount?: string;
  private closing?: Promise<void>;
  private loggingOut = false;
  private logoutTask?: Promise<void>;
  private renewing?: Promise<void>;
  private failedRenewal?: { fingerprint: string | null; at: number };
  constructor(private readonly auth: Auth, private readonly client: Client) {}
  status(): MyTuLoginStatus { return structuredClone(this.loginState); }
  private vault(accountId: string): Vault<Session> { return new Vault(this.auth.config.dataDir, 'mytu-' + digest(this.auth.config.baseUrl + ':' + accountId).slice(0, 20)); }
  private async identity(): Promise<MyTuIdentity> {
    if (this.auth.config.baseUrl !== 'https://brightspace.tudelft.nl') throw new BrightspaceError('MYTU_IDENTITY_UNVERIFIED', 'This connector requires the TU Delft Brightspace account.');
    const accountId = await this.client.sessionIdentity();
    if (!accountId) throw new BrightspaceError('AUTH_REQUIRED', 'Verify your Brightspace account before connecting My TU Delft.');
    const me = record(await this.client.json('lp', 'users/whoami'));
    if (str(me.Identifier) !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed before My TU Delft access.');
    let detail: Row = {};
    try { detail = record(await this.client.json('lp', 'users/' + accountId)); }
    catch (error) { if (!(error instanceof BrightspaceError) || !['PERMISSION_DENIED', 'NOT_FOUND'].includes(error.code)) throw error; }
    if (Object.keys(detail).length && str(detail.UserId) !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace user response did not match the current account.');
    if (await this.client.sessionIdentity() !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed before My TU Delft access.');
    const studentNumbers = [...new Set([number(me.OrgDefinedId), number(detail.OrgDefinedId)].filter((id): id is string => Boolean(id)))];
    if (studentNumbers.length > 1) throw new BrightspaceError('MYTU_IDENTITY_UNVERIFIED', 'Brightspace returned conflicting institutional student identifiers.');
    this.currentAccount = accountId; return { accountId, studentNumbers, institutionalEmail: institutionalEmail(me.UniqueName) };
  }
  private async active(accountId: string, generation: number): Promise<void> {
    if (generation !== this.generation) throw new BrightspaceError('MYTU_SESSION_CHANGED', 'The My TU Delft connection was closed or changed.');
    const current = await this.client.sessionIdentity();
    if (generation !== this.generation) throw new BrightspaceError('MYTU_SESSION_CHANGED', 'The My TU Delft connection was closed or changed.');
    if (current !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed during My TU Delft access.');
  }
  async beginLogin(options: { confirmedStudentNumber?: string; silent?: boolean } = {}): Promise<MyTuLoginStatus> {
    if (options.confirmedStudentNumber !== undefined && !/^[0-9]{1,18}$/.test(options.confirmedStudentNumber)) {
      throw new BrightspaceError('INVALID_ID', 'Use the exact student number explicitly confirmed by the student.');
    }
    if (this.closing || this.loggingOut) throw new BrightspaceError('MYTU_SESSION_CHANGED', 'The My TU Delft connection is closing. Retry after it finishes.');
    if (this.starting) return this.starting;
    if (this.loginTask) return this.status();
    const generation = this.generation;
    this.starting = (async () => {
      const expected = await this.identity(); await this.active(expected.accountId, generation);
      this.loginState = { state: 'waiting', message: options.silent ? 'Reconnecting My TU Delft through your shared university sign-in.' : 'Opening My TU Delft using your saved TU Delft single sign-on session. Complete sign-in or MFA in the browser only if the university asks.' };
      this.loginTask = this.login(expected, generation, options.confirmedStudentNumber, options.silent === true).catch((error: unknown) => {
        this.loginState = { state: 'failed', message: error instanceof BrightspaceError ? error.message : 'The My TU Delft login could not finish.',
          error: safeError(error) };
      }).finally(() => { this.loginTask = undefined; });
      return this.status();
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async login(expected: MyTuIdentity, generation: number, confirmedStudentNumber?: string, silent = false): Promise<void> {
    const vault = this.vault(expected.accountId), fingerprint = await vault.fingerprint();
    try {
      await this.active(expected.accountId, generation);
      const previous = await vault.load();
      if (await vault.fingerprint() !== fingerprint) throw new BrightspaceError('MYTU_SESSION_CHANGED', 'The saved My TU Delft account link changed. Start sign-in again.');
      const sameAccount = previous?.version === 1 && previous.brightspaceOrigin === this.auth.config.baseUrl
        && previous.providerOrigin === ORIGIN && previous.accountId === expected.accountId;
      let confirmedStudentHash = confirmedStudentNumber ? digest(confirmedStudentNumber) : undefined;
      if (!confirmedStudentHash && !expected.studentNumbers.length) {
        if (previous?.version === 1 && previous.brightspaceOrigin === this.auth.config.baseUrl
          && previous.providerOrigin === ORIGIN && previous.accountId === expected.accountId
          && previous.identityMethod === 'student_confirmed_link' && /^[a-f0-9]{64}$/.test(previous.studentHash)) {
          confirmedStudentHash = previous.studentHash;
        }
        if (await vault.fingerprint() !== fingerprint) throw new BrightspaceError('MYTU_SESSION_CHANGED', 'The saved My TU Delft account link changed. Start sign-in again.');
        await this.active(expected.accountId, generation);
      }
      const saved = await this.auth.session();
      await this.active(expected.accountId, generation);
      if (saved.origin !== this.auth.config.baseUrl || saved.identity?.id !== expected.accountId) {
        throw new BrightspaceError('ACCOUNT_CHANGED', 'The saved Brightspace account changed before My TU Delft sign-in. Check your Brightspace login first.');
      }
      // Reuse only TU/SURF SSO cookies on their original domains. Service cookies,
      // bearer tokens and local storage stay separate; SSO does not prove account identity.
      const shared = await this.auth.sso(expected.accountId), cookies = shared.cookies;
      const serviceCookies = sameAccount && Array.isArray(previous.providerCookies) ? providerCookies(previous.providerCookies) : [];
      // Mirror the web application's hasSessionCookie check. A load-balancer
      // affinity cookie alone does not establish a refreshable OSIRIS session.
      const canRefresh = serviceCookies.some(cookie => cookie.name === 'sessionCookie' && !cookie.httpOnly);
      await this.active(expected.accountId, generation);
      const interactiveRequired = () => new BrightspaceError('MYTU_AUTH_REQUIRED', 'The university SSO session requires sign-in or MFA. Run begin_mytu_login once; refreshed SSO will be saved for later connections.');
      if (silent && !cookies.length && !canRefresh) throw interactiveRequired();
      let candidate: Token | undefined;
      let guard: { failure?: BrightspaceError } = {};
      const current = async (): Promise<void> => {
        await this.active(expected.accountId, generation);
        if (guard.failure) throw guard.failure;
      };
      const cancelled = { code: 'MYTU_LOGIN_CANCELLED', message: 'The My TU Delft login browser was closed.' };
      const authRequired = interactiveRequired();
      await runLoginFlow<true>({
        silent, channel: this.auth.config.browserChannel, isolate: true,
        storageState: { cookies: [...cookies, ...serviceCookies], origins: [] },
        errors: {
          cancelled, authRequired: { code: authRequired.code, message: authRequired.message },
          timeout: { code: 'MYTU_LOGIN_TIMEOUT', message: 'The My TU Delft login timed out. Run begin_mytu_login again.' },
        },
        onBrowser: launched => { this.browser = launched; },
        check: current,
        prepare: async (context) => {
          guard = await guardMyTuLogin(context, () => this.active(expected.accountId, generation), async (url, response) => {
            if (url.origin === ORIGIN && url.pathname === API + '/token' && response.status() === 200) {
              if (!(response.headers()['content-type'] ?? '').includes('json')) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The My TU Delft token response was not JSON.');
              const bytes = await response.body();
              if (bytes.length > 64_000) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The My TU Delft token response exceeded its read limit.');
              let data: unknown; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The My TU Delft token response could not be read.'); }
              candidate = tokenFrom(data);
            }
          });
        },
        start: async (page, context) => {
          if (silent && canRefresh) {
            await current();
            const response = await context.request.post(ORIGIN + API + '/token', {
              data: {}, headers: { accept: 'application/json' }, maxRedirects: 0, maxRetries: 0, timeout: this.auth.config.timeoutMs,
            });
            try {
              await current();
              if (response.status() === 200 && (response.headers()['content-type'] ?? '').includes('json')) {
                const bytes = await response.body();
                if (bytes.length > 64_000) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The My TU Delft refresh response exceeded its read limit.');
                let body: unknown; try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The My TU Delft refresh response could not be read.'); }
                candidate = tokenFrom(body);
              }
            } finally { await response.dispose(); }
          }
          if (!candidate) await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: this.auth.config.timeoutMs });
        },
        probe: async (page, context) => {
          if (!candidate) return undefined;
          const token = candidate;
          const stillOpen = async (): Promise<void> => { await current(); if (page.isClosed()) throw new BrightspaceError(cancelled.code, cancelled.message); };
          const verified = await this.providerIdentity(expected, token.accessToken, stillOpen, confirmedStudentHash);
          await stillOpen();
          const storage = await context.storageState();
          await stillOpen();
          await vault.save({ version: 1, brightspaceOrigin: this.auth.config.baseUrl, accountId: expected.accountId, providerOrigin: ORIGIN,
            ...token, providerCookies: providerCookies(storage.cookies), studentHash: verified.studentHash, identityMethod: verified.method, savedAt: new Date().toISOString() }, fingerprint, () => {
            if (generation !== this.generation || page.isClosed()) throw new BrightspaceError('MYTU_LOGIN_CANCELLED', 'The My TU Delft login was cancelled before saving.');
          });
          await stillOpen();
          await shared.save(storage.cookies, () => {
            if (generation !== this.generation || page.isClosed()) throw new BrightspaceError('MYTU_LOGIN_CANCELLED', 'The My TU Delft login was cancelled before saving shared sign-in.');
          });
          await stillOpen(); this.failedRenewal = undefined;
          this.loginState = { state: 'connected', identityMethod: verified.method, message: verified.method === 'student_confirmed_link'
            ? 'My TU Delft is connected to the exact student account you explicitly linked to this Brightspace account.' : verified.method === 'institutional_student_number'
            ? 'My TU Delft is connected and matched to your Brightspace student number.'
            : 'My TU Delft is connected and matched to your Brightspace institutional email address.' };
          return true;
        },
      });
    } finally { this.browser = undefined; }
  }
  private async api(path: string, token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown): Promise<unknown> {
    if (!myTuApiRequestAllowed(path, method, body)) throw new BrightspaceError('MYTU_TARGET_UNVERIFIED', 'This is not an approved own-student endpoint.');
    let response: Response;
    try { response = await fetch(ORIGIN + API + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: 'Bearer ' + token, accept: 'application/json', taal: 'EN', client_type: 'web', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      redirect: 'manual', signal: AbortSignal.timeout(this.auth.config.timeoutMs) }); }
    catch { throw new BrightspaceError('MYTU_UNAVAILABLE', 'The student results service could not be reached.'); }
    try {
      if (response.status === 401 || response.status >= 300 && response.status < 400) throw new BrightspaceError('MYTU_AUTH_REQUIRED', 'Run begin_mytu_login to reconnect to My TU Delft.');
      if (response.status === 403) throw new BrightspaceError('MYTU_PERMISSION_DENIED', 'The student results service did not permit this read.');
      if (response.status === 404) throw new BrightspaceError('MYTU_NOT_FOUND', 'The student result was not found.');
      if (response.status === 501) throw new BrightspaceError('MYTU_FEATURE_UNAVAILABLE', 'The university has not implemented this feature in its OSIRIS service.', { status: 501 });
      if (!response.ok) throw new BrightspaceError('MYTU_UNAVAILABLE', 'The student results service returned an error.', { status: response.status });
      if (response.status === 204 && (method === 'PUT' || method === 'DELETE' || method === 'POST' && !path.endsWith('/zoeken'))) return {};
      if (!(response.headers.get('content-type') ?? '').includes('json')) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The student results service did not return JSON.');
      if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new BrightspaceError('MYTU_LIMIT', 'The student results response exceeded its read limit.');
      const reader = response.body?.getReader(); if (!reader) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The student results response was empty.');
      const chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_BYTES) throw new BrightspaceError('MYTU_LIMIT', 'The student results response exceeded its read limit.'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => undefined); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The student results JSON could not be read.'); }
    } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined); }
  }
  private async providerIdentity(expected: MyTuIdentity, token: string, current: () => Promise<void>, confirmedStudentHash?: string): Promise<VerifiedIdentity> {
    const user = record(await this.api('/gebruiker', token)); await current();
    // Explicit linking is available when Brightspace cannot expose its student number.
    // It never overrides a conflicting institutional student-number comparison.
    if (!expected.studentNumbers.length && confirmedStudentHash) {
      const student = number(user.studentnummer);
      if (user.toegang_applicatie !== 'J') throw new BrightspaceError('MYTU_PERMISSION_DENIED', 'This account does not have access to the student application.');
      if (!student || digest(student) !== confirmedStudentHash) throw new BrightspaceError('MYTU_ACCOUNT_MISMATCH', 'Sign in to the exact My TU Delft student account you confirmed.');
      return { studentHash: confirmedStudentHash, method: 'student_confirmed_link' };
    }
    // Do not read contact details when a student-number comparison settles the match,
    // or when the email/student prerequisites already prove that the fallback cannot work.
    const expectedEmail = institutionalEmail(expected.institutionalEmail), accountEmail = institutionalEmail(user.e_mailadres);
    if (expected.studentNumbers.length || !number(user.studentnummer) || !expectedEmail || !accountEmail
      || expectedEmail !== accountEmail || user.toegang_applicatie !== undefined && user.toegang_applicatie !== 'J') {
      return matchMyTuIdentity(expected, user);
    }
    const contact = record(await this.api('/student/contactgegevens', token)); await current();
    const matched = matchMyTuIdentity(expected, user, contact);
    // Re-read the token's own account after contact verification. Persist only a
    // stable student subject, and repeat the same check when a saved session is used.
    const after = record(await this.api('/gebruiker', token)); await current();
    const confirmed = matchMyTuIdentity(expected, after, contact);
    if (confirmed.studentHash !== matched.studentHash) throw new BrightspaceError('MYTU_ACCOUNT_MISMATCH', 'The My TU Delft student identity changed during verification.');
    return confirmed;
  }
  private async renew(fingerprint: string | null): Promise<void> {
    if (this.renewing) return this.renewing;
    if (this.failedRenewal?.fingerprint === fingerprint && Date.now() - this.failedRenewal.at < 60_000) {
      throw new BrightspaceError('MYTU_AUTH_REQUIRED', 'Automatic SSO reconnection could not complete. Run begin_mytu_login if the university needs sign-in or MFA.');
    }
    this.renewing = (async () => {
      await this.beginLogin({ silent: true });
      await this.loginTask;
      if (this.loginState.state !== 'connected') {
        this.failedRenewal = { fingerprint, at: Date.now() };
        const error = this.loginState.error;
        throw new BrightspaceError(error?.code ?? 'MYTU_AUTH_REQUIRED', error?.message ?? 'Automatic university sign-in could not complete. Run begin_mytu_login.');
      }
    })().finally(() => { this.renewing = undefined; });
    return this.renewing;
  }
  private async verified(allowRenew = true): Promise<{ session: Session; current: () => Promise<void>; identityMethod: IdentityMethod }> {
    const generation = this.generation, expected = await this.identity(), vault = this.vault(expected.accountId);
    const fingerprint = await vault.fingerprint(), session = await vault.load();
    if (!session || session.version !== 1 || session.providerOrigin !== ORIGIN || session.brightspaceOrigin !== this.auth.config.baseUrl
      || session.accountId !== expected.accountId || typeof session.accessToken !== 'string' || !session.accessToken || session.accessToken.length > 32_000
      || /[\r\n]/.test(session.accessToken) || session.expiresAt !== null && !Number.isFinite(session.expiresAt)
      || !/^[a-f0-9]{64}$/.test(session.studentHash)
      || !['institutional_student_number', 'institutional_email', 'student_confirmed_link'].includes(session.identityMethod)) {
      throw new BrightspaceError('MYTU_AUTH_REQUIRED', 'Run begin_mytu_login to connect official TU Delft results.');
    }
    const current = async (): Promise<void> => {
      await this.active(expected.accountId, generation);
      if (await vault.fingerprint() !== fingerprint) throw new BrightspaceError('MYTU_SESSION_CHANGED', 'The saved My TU Delft session changed. Retry after checking authentication.');
      await this.active(expected.accountId, generation);
    };
    await current();
    let matched: VerifiedIdentity;
    try {
      if (session.expiresAt !== null && session.expiresAt <= Date.now()) throw new BrightspaceError('MYTU_AUTH_REQUIRED', 'The saved My TU Delft token has expired.');
      matched = await this.providerIdentity(expected, session.accessToken, current,
        session.identityMethod === 'student_confirmed_link' ? session.studentHash : undefined);
    } catch (error) {
      if (!allowRenew || !(error instanceof BrightspaceError) || error.code !== 'MYTU_AUTH_REQUIRED') throw error;
      await current(); await this.renew(fingerprint); await this.active(expected.accountId, generation);
      return this.verified(false);
    }
    if (matched.studentHash !== session.studentHash) throw new BrightspaceError('MYTU_ACCOUNT_MISMATCH', 'The saved My TU Delft student identity changed. Reconnect with your current account.');
    await current(); return { session, current, identityMethod: matched.method };
  }
  /** Resolve once a login started with beginLogin has finished, with its final status. */
  async waitForLogin(): Promise<MyTuLoginStatus> { await this.starting?.catch(() => undefined); await this.loginTask; return this.status(); }
  async checkAuth(): Promise<Row> {
    const { current, identityMethod } = await this.verified(); await current();
    return { connected: true, provider: 'My TU Delft', accountVerified: true, identityMethod, officialResults: true };
  }
  async withAccess<T>(task: (access: MyTuAccess) => Promise<T>): Promise<T> {
    const { session, current } = await this.verified();
    const value = await task({ accountId: session.accountId, studentHash: session.studentHash, current,
      request: async (path, method = 'GET', body) => {
        await current();
        let result: unknown;
        try { result = await this.api(path, session.accessToken, method, body); }
        catch (error) {
          if (error instanceof BrightspaceError && error.code === 'MYTU_AUTH_REQUIRED' && path !== '/gebruiker') {
            // Some OSIRIS features return 401 while the same token still verifies.
            // Distinguish unavailable feature access from an expired login without replaying the request.
            await current(); await this.verified(false); await current();
            throw new BrightspaceError('MYTU_PERMISSION_DENIED', 'Your My TU Delft login is valid, but the university did not grant access to this feature.');
          }
          throw error;
        }
        await current(); return result;
      } });
    await current(); return value;
  }
  async grades(options: { offset?: number; limit?: number } = {}): Promise<Row> {
    const offset = options.offset ?? 0, limit = options.limit ?? 25;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BrightspaceError('INVALID_RANGE', 'Use an offset between 0 and 1,000,000 and a limit between 1 and 100.');
    const { session, current } = await this.verified();
    const data = await this.api('/student/resultaten?offset=' + offset + '&limit=' + limit, session.accessToken);
    await current(); return { ...officialGrades(data, offset, limit), accountVerified: true };
  }
  async grade(id: string): Promise<Row> {
    id = gradeId(id); const { session, current } = await this.verified();
    const item = officialGrade(await this.api('/student/resultaten/' + id, session.accessToken), id);
    await current(); return { source: 'official_osiris_api', provider: 'My TU Delft', item, accountVerified: true, fetchedAt: new Date().toISOString() };
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.generation++;
    this.closing = (async () => {
      await this.browser?.close().catch(() => undefined);
      await this.starting?.catch(() => undefined); await this.loginTask;
      this.loginState = { state: 'idle', message: 'The My TU Delft connection is closed. Saved access is verified on the next read.' };
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }
  async logout(): Promise<void> {
    if (this.logoutTask) return this.logoutTask;
    this.loggingOut = true;
    this.logoutTask = (async () => {
      const account = await this.client.sessionIdentity().catch(() => undefined) ?? this.currentAccount;
      await this.close(); if (account) await this.vault(account).clear();
      this.loginState = { state: 'idle', message: 'The local My TU Delft login has been removed.' };
    })().finally(() => { this.loggingOut = false; this.logoutTask = undefined; });
    return this.logoutTask;
  }
}
