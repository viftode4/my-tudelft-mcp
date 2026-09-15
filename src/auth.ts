import { chromium, type APIRequestContext, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Config } from './config.js';
import { BrightspaceError } from './errors.js';
import { Vault } from './vault.js';
import { SharedSso, isSsoCookie, type SsoLease } from './sso.js';

export type BrowserState = Awaited<ReturnType<BrowserContext['storageState']>>;
export interface Session {
  origin: string;
  storage: BrowserState;
  bearer?: string;
  csrf?: string;
  savedAt: string;
  identity?: { id: string; name: string };
}
export interface LoginOptions { fresh?: boolean; silent?: boolean }
export interface LoginStatus { state: 'idle' | 'waiting' | 'connected' | 'failed'; message: string; }

export function isBrightspaceHome(url: string, origin: string): boolean {
  try { const u = new URL(url); return u.origin === origin && !u.username && !u.password && /^\/d2l\/home(?:\/|$)/.test(u.pathname); }
  catch { return false; }
}

/** Match only the reported SURF failure surface, without returning its account/error-page contents. */
export function isUnsupportedSurfLogin(url: string, text: string): boolean {
  try {
    const target = new URL(url);
    if (target.origin !== 'https://engine.surfconext.nl' || target.username || target.password
      || target.pathname !== '/authentication/sp/consume-assertion') return false;
  } catch { return false; }
  const body = text.slice(0, 40_000).replace(/\s+/g, ' ').toLowerCase();
  const reportedReference = /\bec\s*:?\s*66571\b/.test(body);
  const reportedExplanation = body.includes('login request was initiated in a way that is not supported')
    && body.includes('without first starting a login from this application');
  return /\bunsupported idp[- ]initiated request\b/.test(body)
    || reportedReference && (reportedExplanation
      || /\bidp[- ]initiated\b/.test(body) && /\b(?:unsupported|not supported|does not support)\b/.test(body));
}

export function extractIdentity(value: unknown): Session['identity'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!['string', 'number'].includes(typeof v.Identifier) || !/^\d+$/.test(String(v.Identifier))) return undefined;
  return { id: String(v.Identifier), name: [v.FirstName, v.LastName].filter((part) => typeof part === 'string').join(' ').trim() };
}

export async function discoverVersions(config: Config): Promise<{ lp: string; le: string }> {
  let payload: unknown;
  try {
    const response = await fetch(`${config.baseUrl}/d2l/api/versions/`, { signal: AbortSignal.timeout(config.timeoutMs), redirect: 'error' });
    if (!response.ok) throw new Error('Unavailable');
    payload = await response.json();
  } catch { throw new BrightspaceError('UNAVAILABLE', 'Brightspace API discovery is unavailable.'); }
  if (!Array.isArray(payload)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace did not return recognised API versions.');
  const get = (code: string): unknown => payload.find((p: unknown) => p && typeof p === 'object' && (p as Record<string, unknown>).ProductCode === code)?.LatestVersion;
  const lp = get('lp'), le = get('le');
  if (typeof lp !== 'string' || typeof le !== 'string' || !/^\d+\.\d+$/.test(lp) || !/^\d+\.\d+$/.test(le)) {
    throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace did not return recognised API versions.');
  }
  return { lp, le };
}

export async function mintToken(context: APIRequestContext, config: Config, csrf?: string): Promise<string | undefined> {
  if (!csrf) return undefined;
  const response = await context.post(`${config.baseUrl}/d2l/lp/auth/oauth2/token`, {
    form: { scope: '*:*:*' }, headers: { 'x-csrf-token': csrf },
    timeout: config.timeoutMs, maxRedirects: 0, maxRetries: 0,
  });
  try {
    if (!response.ok() || !(response.headers()['content-type'] ?? '').includes('json')) return undefined;
    const body = await response.json() as { access_token?: unknown };
    return typeof body.access_token === 'string' && body.access_token ? body.access_token : undefined;
  } finally { await response.dispose(); }
}

async function hasBrightspaceSession(context: BrowserContext, config: Config): Promise<boolean> {
  return (await context.cookies(config.baseUrl)).some((cookie) => cookie.name === 'd2lSessionVal' && cookie.value && (cookie.expires < 0 || cookie.expires > Date.now() / 1000));
}

async function hasCatalogSession(page: Page, config: Config): Promise<boolean> {
  if (new URL(page.url()).origin !== config.catalogUrl) return false;
  // A public landing page without a password input does not prove authentication.
  const signOut = page.getByRole('link', { name: /^(?:log\s*out|sign\s*out|uitloggen|afmelden)$/i }).or(page.getByRole('button', { name: /^(?:log\s*out|sign\s*out|uitloggen|afmelden)$/i }));
  return await signOut.first().isVisible().catch(() => false);
}

export class Auth {
  readonly vault: Vault<Session>;
  private loginBrowser?: Browser;
  private loginTask?: Promise<void>;
  private cancelLogin = false;
  private generation = 0;
  private failedSilentAt = 0;
  status: LoginStatus = { state: 'idle', message: 'Run login to connect your Brightspace account.' };

  constructor(readonly config: Config) { this.vault = new Vault(config.dataDir); }

  async session(): Promise<Session> {
    const state = await this.vault.load();
    if (!state || state.origin !== this.config.baseUrl || !state.storage || !Array.isArray(state.storage.cookies) || !Array.isArray(state.storage.origins)) {
      throw new BrightspaceError('AUTH_REQUIRED', 'Use begin_login or run npm run login to sign in to Brightspace.');
    }
    return state;
  }

  async sso(accountId: string): Promise<SsoLease> {
    const saved = await this.session();
    if (saved.identity?.id !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The saved Brightspace account changed before university sign-in.');
    return new SharedSso(this.config).open(accountId, saved.storage.cookies);
  }

  beginLogin(service: 'brightspace' | 'catalog' = 'brightspace', options: LoginOptions = {}): LoginStatus {
    if (this.loginTask) return this.status;
    this.cancelLogin = false;
    this.status = { state: 'waiting', message: options.silent ? 'Reconnecting Brightspace through your shared university sign-in.' : 'Complete your TU Delft login in the browser window. You have 10 minutes.' };
    this.loginTask = this.login(service, options.fresh === true, options.silent === true).catch((error: unknown) => {
      // Browser exceptions can contain request headers or login URLs. Keep them out of logs.
      this.status = { state: 'failed', message: error instanceof BrightspaceError ? error.message : 'Login could not finish. Check the browser and try again.' };
    }).finally(() => { this.loginTask = undefined; });
    return this.status;
  }

  async waitForLogin(): Promise<LoginStatus> { await this.loginTask; return this.status; }

  async renewSso(accountId: string): Promise<boolean> {
    if (this.config.baseUrl !== 'https://brightspace.tudelft.nl' || Date.now() - this.failedSilentAt < 60_000) return false;
    const generation = this.generation;
    const previous = await this.session();
    if (generation !== this.generation) throw new BrightspaceError('LOGIN_CANCELLED', 'The Brightspace connection was closed during SSO reconnection.');
    if (previous.identity?.id !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed before SSO reconnection.');
    this.beginLogin('brightspace', { silent: true });
    await this.waitForLogin();
    if (this.status.state !== 'connected') { this.failedSilentAt = Date.now(); return false; }
    if ((await this.session()).identity?.id !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed during SSO reconnection.');
    this.failedSilentAt = 0; return true;
  }

  private assertLoginActive(page?: Page): void {
    if (this.cancelLogin || page?.isClosed()) throw new BrightspaceError('LOGIN_CANCELLED', 'Login was cancelled. The previous saved session was kept.');
  }

  private async login(service: 'brightspace' | 'catalog', fresh: boolean, silent: boolean): Promise<void> {
    const expectedFingerprint = await this.vault.fingerprint();
    const previous = await this.vault.load().catch(() => null);
    if (this.cancelLogin) throw new BrightspaceError('LOGIN_CANCELLED', 'Login was cancelled. Run login again when ready.');
    if (service === 'catalog' && (!previous || previous.origin !== this.config.baseUrl)) {
      throw new BrightspaceError('AUTH_REQUIRED', 'Sign in to Brightspace first, then connect the catalog.');
    }
    if (silent && (fresh || service !== 'brightspace' || !previous?.identity || previous.origin !== this.config.baseUrl)) {
      throw new BrightspaceError('AUTH_REQUIRED', 'Connect and verify Brightspace before automatic SSO reconnection.');
    }
    const browser = await chromium.launch({ headless: silent, channel: this.config.browserChannel });
    this.loginBrowser = browser;
    try {
      if (this.cancelLogin) throw new BrightspaceError('LOGIN_CANCELLED', 'Login was cancelled. Run login again when ready.');
      const shared = this.config.baseUrl === 'https://brightspace.tudelft.nl' && previous?.origin === this.config.baseUrl && previous.identity
        ? await this.sso(previous.identity.id) : undefined;
      const storageState = !fresh && previous?.origin === this.config.baseUrl ? structuredClone(previous.storage) : undefined;
      if (storageState && shared) storageState.cookies = [...storageState.cookies.filter(cookie => !isSsoCookie(cookie)), ...shared.cookies];
      this.assertLoginActive();
      if (silent && !shared?.cookies.length) throw new BrightspaceError('AUTH_REQUIRED', 'The university SSO session needs sign-in. Run begin_login.');
      const context = await browser.newContext({
        storageState,
        locale: 'en-GB', timezoneId: 'Europe/Amsterdam',
      });
      const page = await context.newPage();
      let captured: string | undefined;
      context.on('request', (req) => {
        const url = new URL(req.url());
        if (url.origin !== this.config.baseUrl || !url.pathname.startsWith('/d2l/')) return;
        const authorization = req.headers().authorization;
        if (authorization?.startsWith('Bearer ')) captured = authorization.slice(7);
      });
      await page.goto(service === 'catalog' ? this.config.catalogUrl : `${this.config.baseUrl}/d2l/home`, { waitUntil: 'domcontentloaded', timeout: silent ? 25_000 : 60_000 });
      const deadline = Date.now() + (silent ? 25_000 : 10 * 60_000);
      let connected: 'brightspace' | 'catalog' | undefined;
      while (Date.now() < deadline) {
        if (this.cancelLogin || page.isClosed()) throw new BrightspaceError('LOGIN_CANCELLED', 'The login window was closed. The previous saved session was kept.');
        const location = new URL(page.url());
        if (location.origin === 'https://engine.surfconext.nl' && location.pathname === '/authentication/sp/consume-assertion') {
          // The normal assertion callback may navigate while this read-only observation runs.
          const text = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 40_000)).catch(() => undefined);
          this.assertLoginActive(page);
          if (typeof text === 'string' && isUnsupportedSurfLogin(page.url(), text)) {
            throw new BrightspaceError('LOGIN_UNSOLICITED', 'SURF rejected an unsupported IdP-initiated login. Close this window and retry a fresh login starting from Brightspace. The previous saved session was kept.');
          }
        }
        if (isBrightspaceHome(page.url(), this.config.baseUrl) && await hasBrightspaceSession(context, this.config)) {
          connected = 'brightspace'; break;
        }
        if (service === 'catalog' && await hasCatalogSession(page, this.config)) { connected = 'catalog'; break; }
        if (silent && await page.locator('input[type="password"]').first().isVisible().catch(() => false)) {
          throw new BrightspaceError('AUTH_REQUIRED', 'The university requires sign-in or MFA. Run begin_login once to refresh shared SSO.');
        }
        await page.waitForTimeout(750);
      }
      if (!connected) throw new BrightspaceError('LOGIN_TIMEOUT', 'Login timed out. Run login again when ready.');
      if (connected === 'catalog') {
        if (fresh) throw new BrightspaceError('LOGIN_UNVERIFIED', 'A fresh login must verify the Brightspace account before saving. Start a fresh Brightspace login first. The previous saved session was kept.');
        const storage = await context.storageState();
        this.assertLoginActive(page);
        await this.vault.save({ ...previous!, storage, savedAt: new Date().toISOString() }, expectedFingerprint, () => this.assertLoginActive(page));
        this.status = { state: 'connected', message: 'TU Delft catalog session saved.' };
        return;
      }
      this.assertLoginActive(page);
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      this.assertLoginActive(page);
      const material = await page.evaluate(() => {
        const d2l = (window as unknown as { D2L?: { LP?: { Web?: { Authentication?: { Xsrf?: { GetXsrfToken?: () => string } } } } } }).D2L;
        let csrf: string | undefined;
        try { csrf = d2l?.LP?.Web?.Authentication?.Xsrf?.GetXsrfToken?.(); } catch { /* optional */ }
        csrf ??= document.querySelector('meta[name="d2l-xsrf-token"]')?.getAttribute('content') ?? undefined;
        let bearer: string | undefined;
        try {
          const entries = JSON.parse(localStorage.getItem('D2L.Fetch.Tokens') ?? '{}') as Record<string, { access_token?: string }>;
          bearer = entries['*:*:*']?.access_token;
        } catch { /* optional */ }
        return { csrf, bearer };
      });
      this.assertLoginActive(page);
      const bearer = await mintToken(context.request, this.config, material.csrf).catch(() => undefined) ?? captured ?? material.bearer;
      this.assertLoginActive(page);
      let identity: Session['identity'];
      try {
        const versions = await discoverVersions(this.config);
        const result = await context.request.get(`${this.config.baseUrl}/d2l/api/lp/${versions.lp}/users/whoami`, {
          headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}, maxRedirects: 0, timeout: this.config.timeoutMs,
        });
        try {
          identity = result.ok() && (result.headers()['content-type'] ?? '').includes('json') ? extractIdentity(await result.json()) : undefined;
        } finally { await result.dispose(); }
      } catch { /* Browser session remains useful when an API endpoint is unavailable. */ }
      this.assertLoginActive(page);
      if (fresh && !identity) throw new BrightspaceError('LOGIN_UNVERIFIED', 'The fresh browser login could not verify your Brightspace account. The previous saved session was kept. Retry when the current-user API is available.');
      if (silent && (!identity || identity.id !== previous?.identity?.id)) {
        throw new BrightspaceError('ACCOUNT_CHANGED', 'Automatic SSO did not verify the previously connected Brightspace account. The saved session was kept.');
      }
      const storage = await context.storageState();
      this.assertLoginActive(page);
      await this.vault.save({ origin: this.config.baseUrl, storage, bearer, csrf: material.csrf, savedAt: new Date().toISOString(), identity },
        expectedFingerprint, () => this.assertLoginActive(page));
      if (identity && this.config.baseUrl === 'https://brightspace.tudelft.nl') {
        const updated = shared?.accountId === identity.id ? shared : await this.sso(identity.id);
        await updated.save(storage.cookies, () => this.assertLoginActive(page));
      }
      this.failedSilentAt = 0;
      this.status = identity
        ? { state: 'connected', message: service === 'catalog' ? 'The catalog redirected to Brightspace. Brightspace login and API access verified.' : 'Brightspace login and API access verified.' }
        : { state: 'connected', message: 'Browser session saved. API access is unavailable; browser retrieval can be tested.' };
    } finally { await browser.close().catch(() => undefined); this.loginBrowser = undefined; }
  }

  async logout(): Promise<void> {
    await this.close();
    const saved = await this.vault.load().catch(() => null);
    try {
      if (this.config.baseUrl === 'https://brightspace.tudelft.nl' && saved?.origin === this.config.baseUrl && saved.identity) {
        await new SharedSso(this.config).forget(saved.identity.id);
      }
    } finally {
      await this.vault.clear(); this.status = { state: 'idle', message: 'Local Brightspace and shared university sign-in removed.' };
    }
  }
  async close(): Promise<void> { this.generation++; this.cancelLogin = true; await this.loginBrowser?.close().catch(() => undefined); await this.loginTask; }
}
