import { request, type APIRequestContext } from 'playwright';
import type { Config } from './config.js';
import { Auth, discoverVersions, extractIdentity, mintToken, type Session } from './auth.js';
import { BrightspaceError } from './errors.js';
import { pageItems, sameOriginUrl, sleep } from './util.js';

export class BrightspaceClient {
  private context?: APIRequestContext;
  private state?: Session;
  private vaultFingerprint?: string | null;
  private versions?: Promise<{ lp: string; le: string }>;
  private starting?: Promise<void>;
  private renewing?: Promise<boolean>;
  private retired = new Set<APIRequestContext>();

  constructor(readonly config: Config, readonly auth: Auth) {}

  private async ready(): Promise<void> {
    if (this.context) { await this.verifyAccount(); return; }
    this.starting ??= (async () => {
      const fingerprint = await this.auth.vault.fingerprint();
      const state = await this.auth.session();
      this.context = await request.newContext({ storageState: state.storage, timeout: this.config.timeoutMs });
      this.state = state;
      this.vaultFingerprint = fingerprint;
    })().finally(() => { this.starting = undefined; });
    await this.starting;
    await this.verifyAccount();
  }

  private async verifyAccount(): Promise<void> {
    const fingerprint = await this.auth.vault.fingerprint();
    if (fingerprint === this.vaultFingerprint) return;
    const latest = await this.auth.session();
    this.assertSameAccount(latest);
    this.vaultFingerprint = fingerprint;
  }

  private assertSameAccount(latest: Session): void {
    const identity = this.state?.identity?.id;
    const sameAccount = latest.origin === this.state?.origin && (identity && latest.identity?.id
      ? identity === latest.identity.id : latest.savedAt === this.state?.savedAt);
    if (!sameAccount) throw new BrightspaceError('ACCOUNT_CHANGED', 'The saved Brightspace account changed. Run check_auth to reconnect before using course data or preparing actions.');
  }

  async sessionIdentity(): Promise<string | undefined> {
    await this.ready();
    return this.state?.identity?.id;
  }
  async verifyIdentity(): Promise<NonNullable<Session['identity']>> {
    const identity = extractIdentity(await this.json('lp', 'users/whoami'));
    if (!identity) throw new BrightspaceError('API_FORMAT_CHANGED', 'The identity response was not recognised.');
    const expectedFingerprint = await this.auth.vault.fingerprint();
    const latest = await this.auth.session();
    this.assertSameAccount(latest);
    if ([this.state?.identity, latest.identity].some((saved) => saved && saved.id !== identity.id)) {
      throw new BrightspaceError('ACCOUNT_CHANGED', 'The verified API identity differs from the saved account. Run begin_login to reconnect.');
    }
    if (!latest.identity) {
      // Only an identity returned by the current authenticated whoami request may be saved.
      // Retain newer same-account cookies/tokens rather than copying the cached API state.
      await this.auth.vault.save({ ...latest, identity }, expectedFingerprint);
    }
    this.state = { ...this.state!, identity };
    // Keep the previous fingerprint until account verification has inspected the saved result.
    await this.verifyAccount();
    return identity;
  }
  private apiOnly(input: string): string {
    const url = sameOriginUrl(input, this.config.baseUrl);
    if (!/^\/d2l\/api\/(?:lp|le)\/\d+\.\d+\//.test(url.pathname) || url.hash) {
      throw new BrightspaceError('INVALID_API_PATH', 'The request must address a Brightspace learning API endpoint.');
    }
    return url.href;
  }

  async apiUrl(product: 'lp' | 'le', path: string, params: Record<string, string> = {}): Promise<string> {
    await this.ready();
    this.versions ??= discoverVersions(this.config).catch((error: unknown) => { this.versions = undefined; throw error; });
    const versions = await this.versions;
    if (/[?#\\]/.test(path) || path.split('/').some((part) => /^(?:\.|%2e){1,2}$/i.test(part))) {
      throw new BrightspaceError('INVALID_API_PATH', 'The API endpoint path is not valid.');
    }
    const prefix = `/d2l/api/${product}/${versions[product]}/`;
    const url = new URL(`${prefix}${path.replace(/^\//, '')}`, this.config.baseUrl);
    if (!url.pathname.startsWith(prefix)) throw new BrightspaceError('INVALID_API_PATH', 'The API endpoint path is not valid.');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.apiOnly(url.href);
  }

  private async renew(expiredBearer?: string): Promise<boolean> {
    if (this.state?.bearer && this.state.bearer !== expiredBearer) return true;
    this.renewing ??= (async () => {
      const latest = await this.auth.session();
      this.assertSameAccount(latest);
      if (latest.savedAt !== this.state?.savedAt || latest.bearer !== this.state?.bearer) {
        const context = await request.newContext({ storageState: latest.storage, timeout: this.config.timeoutMs });
        if (this.context) this.retired.add(this.context);
        this.context = context;
        this.state = latest;
        if (latest.bearer && latest.bearer !== expiredBearer) return true;
      }
      const bearer = await mintToken(this.context!, this.config, this.state?.csrf).catch(() => undefined);
      if (!bearer) {
        const accountId = this.state?.identity?.id;
        if (!accountId || this.config.baseUrl !== 'https://brightspace.tudelft.nl' || !await this.auth.renewSso(accountId)) return false;
        const reconnected = await this.auth.session(); this.assertSameAccount(reconnected);
        const context = await request.newContext({ storageState: reconnected.storage, timeout: this.config.timeoutMs });
        if (this.context) this.retired.add(this.context);
        this.context = context; this.state = reconnected;
        return true;
      }
      this.state = { ...this.state!, bearer, storage: await this.context!.storageState(), savedAt: new Date().toISOString() };
      await this.auth.vault.save(this.state);
      return true;
    })().finally(() => { this.renewing = undefined; });
    return this.renewing;
  }

  private async jsonUrl(input: string): Promise<unknown> {
    await this.ready();
    const url = this.apiOnly(input);
    let renewed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.verifyAccount();
      const bearer = this.state?.bearer;
      let response;
      try {
        response = await this.context!.get(url, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}, maxRedirects: 0 });
      } catch { throw new BrightspaceError('UNAVAILABLE', 'Brightspace could not be reached. Retry later.'); }
      const status = response.status(), type = response.headers()['content-type'] ?? '';
      if (status === 429 || status >= 500) {
        const seconds = Number(response.headers()['retry-after']);
        await response.dispose();
        if (attempt === 3) throw new BrightspaceError('UNAVAILABLE', 'Brightspace is busy or temporarily unavailable. Retry later.', { status });
        await sleep(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 10_000) : 500 * 2 ** attempt);
        continue;
      }
      if (status === 401 || status >= 300 && status < 400 || status === 200 && !type.includes('json')) {
        await response.dispose();
        if (!renewed) { renewed = true; if (await this.renew(bearer)) continue; }
        throw new BrightspaceError('AUTH_REQUIRED', 'The API session has expired or is unavailable. Run begin_login to reconnect.');
      }
      if (!response.ok()) {
        await response.dispose();
        throw new BrightspaceError(status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND' : 'API_ERROR', 'Brightspace could not provide this resource.', { status });
      }
      try {
        if (status === 204) return null;
        const value: unknown = await response.json();
        await this.verifyAccount();
        return value;
      } catch (error) { if (error instanceof BrightspaceError) throw error; throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unreadable API response.'); }
      finally { await response.dispose(); }
    }
    throw new BrightspaceError('UNAVAILABLE', 'Brightspace could not complete the request.');
  }

  async json(product: 'lp' | 'le', path: string, params: Record<string, string> = {}): Promise<unknown> {
    return this.jsonUrl(await this.apiUrl(product, path, params));
  }

  async list(product: 'lp' | 'le', path: string, params: Record<string, string> = {}, maxPages = 20): Promise<{ items: unknown[]; complete: boolean; nextBookmark?: string; nextUrl?: string }> {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new BrightspaceError('INVALID_LIMIT', 'Pagination must request between 1 and 1000 pages.');
    const items: unknown[] = [], visited = new Set<string>();
    let url = await this.apiUrl(product, path, params);
    let bookmark = params.bookmark, nextUrl: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      if (visited.has(url)) throw new BrightspaceError('PAGINATION_ERROR', 'Brightspace did not advance its pagination cursor. Results may be incomplete.');
      visited.add(url);
      const result = pageItems(await this.jsonUrl(url));
      items.push(...result.items);
      if (!result.hasMore) return { items, complete: true };
      if (result.nextUrl) {
        url = this.apiOnly(new URL(result.nextUrl, url).href);
        nextUrl = url; bookmark = undefined;
      } else if (result.bookmark) {
        bookmark = result.bookmark; nextUrl = undefined;
        url = await this.apiUrl(product, path, { ...params, bookmark });
      } else throw new BrightspaceError('PAGINATION_ERROR', 'Brightspace did not provide a pagination cursor. Results may be incomplete.');
    }
    return { items, complete: false, ...(bookmark ? { nextBookmark: bookmark } : {}), ...(nextUrl ? { nextUrl } : {}) };
  }

  async postMultipart(product: 'lp' | 'le', path: string, body: Buffer, contentType: string): Promise<{ status: number; data: unknown }> {
    const url = await this.apiUrl(product, path);
    await this.verifyAccount();
    let response;
    try {
      response = await this.context!.post(url, {
        data: body, headers: { 'Content-Type': contentType, 'Content-Length': String(body.byteLength), ...(this.state?.bearer ? { Authorization: `Bearer ${this.state.bearer}` } : {}) },
        maxRedirects: 0, maxRetries: 0,
      });
    } catch {
      throw new BrightspaceError('SUBMISSION_OUTCOME_UNKNOWN', 'The upload connection ended without a receipt. Check existing submissions before trying again.');
    }
    try {
      const status = response.status();
      if (status >= 500) throw new BrightspaceError('SUBMISSION_OUTCOME_UNKNOWN', 'Brightspace did not confirm the upload. Check existing submissions before trying again.', { status });
      if (status >= 300 && status < 400) throw new BrightspaceError('SUBMISSION_OUTCOME_UNKNOWN', 'Brightspace redirected the upload without confirming its outcome. Check existing submissions before trying again.', { status });
      if (status === 401) throw new BrightspaceError('AUTH_REQUIRED', 'Sign in again before submitting. The upload was not retried.', { status });
      if (!response.ok()) throw new BrightspaceError(status === 403 ? 'PERMISSION_DENIED' : 'SUBMISSION_REJECTED', 'Brightspace rejected the upload. The upload was not retried.', { status });
      if (status === 204) return { status, data: null };
      let text: string;
      try { text = await response.text(); } catch { throw new BrightspaceError('SUBMISSION_OUTCOME_UNKNOWN', 'The submission receipt could not be read. Check existing submissions before trying again.', { status }); }
      if (!text.trim()) return { status, data: null };
      if (!(response.headers()['content-type'] ?? '').includes('json')) throw new BrightspaceError('SUBMISSION_OUTCOME_UNKNOWN', 'Brightspace did not provide a structured submission receipt. Check existing submissions before trying again.', { status });
      try { return { status, data: JSON.parse(text) as unknown }; }
      catch { throw new BrightspaceError('SUBMISSION_OUTCOME_UNKNOWN', 'The submission receipt could not be read. Check existing submissions before trying again.', { status }); }
    } finally { await response.dispose(); }
  }

  async download(input: string): Promise<{ bytes: Buffer; contentType: string; filename?: string; url: string }> {
    await this.ready();
    let url = sameOriginUrl(input, this.config.baseUrl);
    for (let redirect = 0; redirect < 6; redirect++) {
      await this.verifyAccount();
      const state = await this.context!.storageState();
      const cookies = state.cookies.filter((c) => {
        const domain = c.domain.replace(/^\./, '');
        const domainMatch = c.domain.startsWith('.') ? url.hostname === domain || url.hostname.endsWith(`.${domain}`) : url.hostname === domain;
        return domainMatch && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)) && (c.expires < 0 || c.expires > Date.now() / 1000);
      });
      const bearer = this.state?.bearer;
      const headers: Record<string, string> = { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
      if (url.pathname.startsWith('/d2l/api/') && bearer) headers.Authorization = `Bearer ${bearer}`;
      let response;
      try { response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) }); }
      catch { throw new BrightspaceError('DOWNLOAD_FAILED', 'Brightspace could not be reached to download this file.'); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new BrightspaceError('DOWNLOAD_FAILED', 'Brightspace returned a redirect without a destination.');
        url = sameOriginUrl(new URL(location, url).href, this.config.baseUrl);
        if (/\/d2l\/(?:login|lp\/auth)/.test(url.pathname)) throw new BrightspaceError('AUTH_REQUIRED', 'Sign in again to download this file.');
        continue;
      }
      if (response.status === 401) {
        await response.body?.cancel();
        if (redirect === 0 && await this.renew(bearer)) continue;
        throw new BrightspaceError('AUTH_REQUIRED', 'Sign in again to download this file.');
      }
      if (!response.ok) { await response.body?.cancel(); throw new BrightspaceError('DOWNLOAD_FAILED', 'Brightspace did not provide this file.', { status: response.status }); }
      if (Number(response.headers.get('content-length') ?? 0) > this.config.maxFileBytes) { await response.body?.cancel(); throw new BrightspaceError('FILE_TOO_LARGE', 'This file exceeds the configured download limit.'); }
      const chunks: Uint8Array[] = []; let length = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new BrightspaceError('DOWNLOAD_FAILED', 'Brightspace returned an empty response.');
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.length;
          if (length > this.config.maxFileBytes) { await reader.cancel(); throw new BrightspaceError('FILE_TOO_LARGE', 'This file exceeds the configured download limit.'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const disposition = response.headers.get('content-disposition') ?? '';
      let filename = /filename\*=(?:UTF-8'')([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)/i.exec(disposition)?.[1];
      if (filename) { try { filename = decodeURIComponent(filename); } catch { /* Keep the literal filename if encoding is malformed. */ } }
      const bytes = Buffer.concat(chunks);
      const html = bytes.subarray(0, 8000).toString();
      if (html.includes('/d2l/login?sessionExpired') || /<input\b[^>]*type=["']password["']/i.test(html)) throw new BrightspaceError('AUTH_REQUIRED', 'Sign in again to download this file.');
      await this.verifyAccount();
      return { bytes, contentType: response.headers.get('content-type') ?? '', filename, url: url.href };
    }
    throw new BrightspaceError('DOWNLOAD_FAILED', 'This file redirected too many times.');
  }

  async reset(): Promise<void> { await this.close(); this.state = undefined; }
  async close(): Promise<void> {
    await this.starting?.catch(() => undefined);
    await this.renewing?.catch(() => undefined);
    if (this.context) this.retired.add(this.context);
    this.context = undefined;
    await Promise.all([...this.retired].map((context) => context.dispose().catch(() => undefined)));
    this.retired.clear();
  }
}
