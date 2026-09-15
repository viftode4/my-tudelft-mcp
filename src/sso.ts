import { createHash } from 'node:crypto';
import type { BrowserState } from './auth.js';
import type { Config } from './config.js';
import { BrightspaceError } from './errors.js';
import { Vault } from './vault.js';

type Cookie = BrowserState['cookies'][number];
const domains = new Set(['.surfconext.nl', 'engine.surfconext.nl', 'login.tudelft.nl']);
export function isSsoCookie(cookie: Cookie): boolean { return domains.has(cookie.domain); }
export function ssoCookies(cookies: Cookie[]): Cookie[] {
  return cookies.filter(cookie => isSsoCookie(cookie) && cookie.secure === true
    && (cookie.expires === -1 || Number.isFinite(cookie.expires) && cookie.expires > Date.now() / 1000));
}
interface SavedSso { version: 1; origin: string; accountId: string; cookies: Cookie[]; savedAt: string }
export interface SsoLease {
  accountId: string;
  cookies: Cookie[];
  /** Call only after the destination service has verified the linked account. */
  save(cookies: Cookie[], preCommit: () => void): Promise<void>;
}

/** A complete cookie snapshot: removed cookies must not reappear from an older service login. */
export class SharedSso {
  constructor(private readonly config: Config) {}
  private vault(accountId: string): Vault<SavedSso> {
    const key = createHash('sha256').update(this.config.baseUrl + ':' + accountId).digest('hex').slice(0, 20);
    return new Vault(this.config.dataDir, 'sso-' + key);
  }
  async open(accountId: string, fallback: Cookie[]): Promise<SsoLease> {
    if (this.config.baseUrl !== 'https://brightspace.tudelft.nl' || !/^\d+$/.test(accountId)) {
      throw new BrightspaceError('SSO_ACCOUNT_UNVERIFIED', 'Shared TU Delft sign-in requires a verified TU Delft Brightspace account.');
    }
    const vault = this.vault(accountId), fingerprint = await vault.fingerprint(), saved = await vault.load();
    if (await vault.fingerprint() !== fingerprint) throw new BrightspaceError('SSO_SESSION_CHANGED', 'The shared university sign-in changed. Retry the connection.');
    if (saved && (saved.version !== 1 || saved.origin !== this.config.baseUrl || saved.accountId !== accountId || !Array.isArray(saved.cookies))) {
      throw new BrightspaceError('SSO_ACCOUNT_UNVERIFIED', 'The shared sign-in does not match the current university account.');
    }
    return { accountId, cookies: ssoCookies(saved ? saved.cookies : fallback), save: async (cookies, preCommit) => {
      preCommit();
      // Another verified service may already have rotated the SSO state. Keep its newer snapshot.
      if (await vault.fingerprint() !== fingerprint) { preCommit(); return; }
      try {
        await vault.save({ version: 1, origin: this.config.baseUrl, accountId, cookies: ssoCookies(cookies), savedAt: new Date().toISOString() }, fingerprint, preCommit);
      } catch (error) {
        preCommit();
        if (!(error instanceof BrightspaceError && error.code === 'ACCOUNT_CHANGED') || await vault.fingerprint() === fingerprint) throw error;
      }
    } };
  }
  async forget(accountId: string): Promise<void> {
    // An empty snapshot also invalidates outstanding leases and prevents stale fallback resurrection.
    await this.vault(accountId).save({ version: 1, origin: this.config.baseUrl, accountId, cookies: [], savedAt: new Date().toISOString() });
  }
}
