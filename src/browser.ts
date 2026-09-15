import { chromium, type Browser, type BrowserContext, type Page, type Frame } from 'playwright';
import { Auth, type BrowserState } from './auth.js';
import { BrightspaceError } from './errors.js';
import { sameOriginUrl, safeSourceUrl } from './util.js';

export interface PageSnapshot {
  title: string; url: string; text: string; truncated: boolean;
  links: Array<{ title: string; url: string }>;
  media: Array<{ kind: string; url: string }>;
  buttons: Array<{ index: number; label: string }>;
  retrievedAt: string; source: 'browser';
}

export interface BrowserReadOptions {
  /** Internal scope checks run on original URLs before any output redaction. */
  acceptLink?: (rawUrl: string) => boolean;
  validateUrl?: (rawUrl: string) => void;
}

export function validateReadPage(input: string, origin: string): string {
  const url = sameOriginUrl(input, origin);
  let action = url.pathname + url.search;
  try {
    for (let round = 0; round < 4; round++) {
      const decoded = decodeURIComponent(action);
      if (decoded === action) break;
      action = decoded;
    }
  } catch { throw new BrightspaceError('INVALID_URL', 'The URL contains invalid escaping.'); }
  if (/%[0-9a-f]{2}/i.test(action) || /logout|signout|delete|remove|unenrol|unsubscribe|submit|register|enrol|complete|markread|\/d2l\/(?:login|lp\/auth)|quiz[^?]*(?:attempt|start|take)|(?:attempt|start|take)[^?]*quiz|[?&](?:action|cmd)=(?:start|attempt|launch)|\/lti\/|[?&]type=lti/i.test(action)) {
    throw new BrightspaceError('UNSAFE_NAVIGATION', 'Use a dedicated action tool for this URL.');
  }
  return url.href;
}

export function browserStorageForOrigin(storage: BrowserState, origin: string): BrowserState {
  const host = new URL(origin).hostname;
  return {
    cookies: storage.cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, '');
      return cookie.domain.startsWith('.') ? host === domain || host.endsWith(`.${domain}`) : host === domain;
    }),
    origins: storage.origins.filter((entry) => entry.origin === origin),
  };
}

export async function guardReadNavigation(context: BrowserContext, origin: string): Promise<{ redirects: Map<string, string>; failures: Map<string, BrightspaceError> }> {
  const state = { redirects: new Map<string, string>(), failures: new Map<string, BrightspaceError>() };
  // Context routing covers the main page, iframes, and popup first requests. The normal
  // Brightspace frontend may still fetch its own hosted API/assets across origins.
  await context.route('**/*', async (route) => {
    if (!route.request().isNavigationRequest()) { await route.continue(); return; }
    const url = route.request().url();
    try {
      validateReadPage(url, origin);
      if (route.request().method() !== 'GET') throw new BrightspaceError('UNSAFE_NAVIGATION', 'Read-only browsing cannot submit a form.');
      // Playwright routing can skip redirected requests. Fetch with redirects disabled,
      // inspect Location, and let open() make each allowed redirect a new guarded navigation.
      const response = await route.fetch({ maxRedirects: 0, timeout: 25_000 });
      try {
        if (response.status() >= 300 && response.status() < 400) {
          const target = new URL(response.headers().location ?? '', url).href;
          if (/\/d2l\/(?:login|lp\/auth)/i.test(new URL(target).pathname) || new URL(target).origin !== origin) {
            throw new BrightspaceError('AUTH_REQUIRED', 'The service redirected outside the authenticated course reader. Use begin_login to reconnect, or open this external service separately.');
          }
          state.redirects.set(url, validateReadPage(target, origin));
          // A harmless placeholder lets the current navigation settle before open()
          // follows the validated target; aborting here races Chromium's error page.
          await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Loading course</title>' });
        } else { await route.fulfill({ response }); }
      } finally { await response.dispose(); }
    } catch (error) {
      state.failures.set(url, error instanceof BrightspaceError ? error : new BrightspaceError('UNAVAILABLE', 'The requested page could not be loaded.'));
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  });
  return state;
}

// Walk open shadow roots because Brightspace uses web components. Never read input values.
export async function snapshotPage(page: Page | Frame, expectedOrigin: string, options: BrowserReadOptions = {}): Promise<PageSnapshot> {
  options.validateUrl?.(page.url());
  if (new URL(page.url()).origin !== expectedOrigin || await page.locator('input[type=password]').count()) {
    throw new BrightspaceError('AUTH_REQUIRED', 'This service needs a login. Use begin_login for Brightspace or the catalog.');
  }
  const value = await page.evaluate(() => {
    const texts: string[] = [], links: Array<{ title: string; url: string }> = [], media: Array<{ kind: string; url: string }> = [];
    let length = 0;
    const stack: Node[] = [document.querySelector('main,[role=main]') ?? document.body];
    while (stack.length && length <= 100_000) {
      const root = stack.pop()!;
      if (root.nodeType === Node.TEXT_NODE) {
        const text = root.textContent?.replace(/\s+/g, ' ').trim();
        if (text) { texts.push(text); length += text.length; }
        continue;
      }
      if (root instanceof Element) {
        if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','INPUT','TEXTAREA','NAV','HEADER','FOOTER','D2L-OFFSCREEN'].includes(root.tagName)) continue;
        if (root.tagName.startsWith('D2L-DIALOG') && !root.hasAttribute('opened')) continue;
        if (root.hasAttribute('hidden') || root.getAttribute('aria-hidden') === 'true') continue;
        const style = getComputedStyle(root);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (root instanceof HTMLAnchorElement && root.href && links.length < 250) links.push({ title: root.innerText.trim(), url: root.href });
        if (['D2L-LIST-ITEM-BUTTON','D2L-LINK','D2L-CARD'].includes(root.tagName) && root.getAttribute('href') && links.length < 250) {
          links.push({ title: root.getAttribute('label') ?? root.textContent?.trim() ?? '', url: new URL(root.getAttribute('href')!, location.href).href });
        }
        if (['IFRAME','VIDEO','AUDIO','SOURCE','TRACK'].includes(root.tagName)) {
          const src = root.getAttribute('src');
          if (src && media.length < 100) media.push({ kind: root.tagName.toLowerCase(), url: new URL(src, location.href).href });
        }
        if (root.shadowRoot) stack.push(root.shadowRoot);
      }
      stack.push(...Array.from(root.childNodes).reverse());
    }
    return { title: document.title, text: texts.join('\n'), links, media };
  });
  const controls = page.locator('button,input[type=submit],a[role=button],d2l-button');
  const buttons: PageSnapshot['buttons'] = [];
  for (let i = 0, count = Math.min(await controls.count(), 150); i < count; i++) {
    const control = controls.nth(i);
    if (!await control.isVisible()) continue;
    const label = await control.getAttribute('aria-label') || await control.innerText().catch(() => '') || await control.getAttribute('value') || '';
    if (label.trim()) buttons.push({ index: i, label: label.trim() });
  }
  const links = value.links.flatMap((link) => {
    if (options.acceptLink && !options.acceptLink(link.url)) return [];
    const url = safeSourceUrl(link.url, expectedOrigin);
    return url ? [{ title: link.title, url }] : [];
  });
  const media = value.media.flatMap((item) => { const url = safeSourceUrl(item.url, expectedOrigin); return url ? [{ kind: item.kind, url }] : []; });
  options.validateUrl?.(page.url());
  return { ...value, text: value.text.slice(0, 30_000), truncated: value.text.length > 30_000, url: safeSourceUrl(page.url(), expectedOrigin)!, links, media, buttons, retrievedAt: new Date().toISOString(), source: 'browser' };
}

export interface BrowserPage { browser: Browser; context: BrowserContext; page: Page; close: () => Promise<void>; }
export class BrowserReader {
  private discoveryUrl?: string;
  constructor(readonly auth: Auth) {}
  async open(input: string, catalog = false): Promise<BrowserPage> {
    const expectedAccount = (await this.auth.session()).identity?.id;
    try { return await this.openSaved(input, catalog); }
    catch (error) {
      if (!(error instanceof BrightspaceError) || error.code !== 'AUTH_REQUIRED' || catalog
        || this.auth.config.baseUrl !== 'https://brightspace.tudelft.nl') throw error;
      const session = await this.auth.session();
      if (session.identity?.id !== expectedAccount) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed before course-page renewal.');
      if (!session.identity?.id || !await this.auth.renewSso(session.identity.id)) throw error;
      if ((await this.auth.session()).identity?.id !== expectedAccount) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed during course-page renewal.');
      return this.openSaved(input, catalog);
    }
  }
  private async openSaved(input: string, catalog = false): Promise<BrowserPage> {
    const origin = catalog ? this.auth.config.catalogUrl : this.auth.config.baseUrl;
    let url = validateReadPage(input, origin);
    const session = await this.auth.session();
    const browser = await chromium.launch({ headless: true, channel: this.auth.config.browserChannel });
    try {
      const context = await browser.newContext({ storageState: browserStorageForOrigin(session.storage, origin), locale: 'en-GB', timezoneId: 'Europe/Amsterdam', serviceWorkers: 'block' });
      const guard = await guardReadNavigation(context, origin);
      const page = await context.newPage();
      for (let redirect = 0; ; redirect++) {
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.auth.config.timeoutMs }); }
        catch (error) {
          throw guard.failures.get(url) ?? error;
        }
        const target = guard.redirects.get(url);
        if (!target) break;
        if (redirect >= 5) throw new BrightspaceError('UNAVAILABLE', 'The page redirected too many times.');
        url = target;
      }
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      if (new URL(page.url()).origin !== origin || /\/d2l\/login/.test(new URL(page.url()).pathname)) {
        throw new BrightspaceError('AUTH_REQUIRED', `Use begin_login with service=${catalog ? 'catalog' : 'brightspace'} to connect this service.`);
      }
      return { browser, context, page, close: () => browser.close() };
    } catch (error) { await browser.close(); throw error; }
  }
  async read(url: string, options: BrowserReadOptions = {}): Promise<PageSnapshot> {
    const opened = await this.open(url);
    try {
      const snapshot = await snapshotPage(opened.page, this.auth.config.baseUrl, options);
      // The new Brightspace Lessons interface is a same-origin iframe. Read its
      // rendered contents too; external lecture/assessment tools remain source links.
      for (const frame of opened.page.frames().filter((frame) => frame !== opened.page.mainFrame()).slice(0, 8)) {
        try {
          validateReadPage(frame.url(), this.auth.config.baseUrl);
          const embedded = await snapshotPage(frame, this.auth.config.baseUrl, options);
          const combined = snapshot.text + (embedded.text ? `\n\n${embedded.title}\n${embedded.text}` : '');
          snapshot.truncated ||= combined.length > 30_000 || embedded.truncated;
          snapshot.text = combined.slice(0, 30_000);
          for (const link of embedded.links) if (snapshot.links.length < 250 && !snapshot.links.some((item) => item.url === link.url)) snapshot.links.push(link);
          for (const media of embedded.media) if (snapshot.media.length < 100 && !snapshot.media.some((item) => item.url === media.url)) snapshot.media.push(media);
        } catch { /* Unavailable or external frames do not erase readable course metadata. */ }
      }
      return snapshot;
    }
    finally { await opened.close(); }
  }
  async catalog(query?: string, url?: string): Promise<PageSnapshot> {
    const opened = await this.openCatalog(url);
    const expectedOrigin = new URL(opened.page.url()).origin;
    try {
      if (query) {
        const search = opened.page.locator('input[type=search]:visible, input[placeholder*="Search" i]:visible, input[placeholder*="Zoek" i]:visible, input[name*="search" i]:visible');
        if (await search.count() !== 1) throw new BrightspaceError('CATALOG_SEARCH_UNAVAILABLE', 'The catalog search field could not be identified uniquely. Browse the catalog without a query first.');
        await search.fill(query);
        await search.press('Enter');
        await opened.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
        await opened.page.waitForTimeout(750);
      }
      // Discover renders search results asynchronously inside open shadow roots.
      if (await opened.page.locator('search-results').count()) {
        await opened.page.locator('search-results course-list[total-courses], search-results d2l-empty-state-illustrated').first().waitFor({ state: 'attached', timeout: this.auth.config.timeoutMs });
      }
      const snapshot = await snapshotPage(opened.page, expectedOrigin);
      if (/\/d2l\/le\/discovery\/view\/search\//.test(new URL(snapshot.url).pathname)) {
        const current = new URL(snapshot.url), pageNumber = Number(current.searchParams.get('page') ?? '1');
        for (const [label, offset] of [['Next page', 1], ['Previous page', -1]] as const) {
          const button = opened.page.getByRole('button', { name: label, exact: true });
          if (await button.count() === 1 && await button.isVisible() && await button.isEnabled() && Number.isSafeInteger(pageNumber) && pageNumber + offset > 0) {
            const next = new URL(current); next.searchParams.set('page', String(pageNumber + offset));
            snapshot.links.push({ title: label, url: next.href });
          }
        }
      }
      return snapshot;
    } finally { await opened.close(); }
  }

  async openCatalog(input?: string): Promise<BrowserPage> {
    if (input) {
      const url = new URL(input, this.auth.config.baseUrl);
      if (url.origin === this.auth.config.baseUrl) {
        if (!/^\/d2l\/le\/discovery\/view\/(?:home\/?|search\/?)?$/.test(url.pathname) && !/^\/d2l\/le\/discovery\/view\/course\/\d+\/?$/.test(url.pathname)) {
          throw new BrightspaceError('INVALID_CATALOG_URL', 'Use a course or search URL returned by the Discover catalog.');
        }
        return this.open(url.href);
      }
      return this.open(input, true);
    }
    if (!this.discoveryUrl) {
      const home = await this.open(`${this.auth.config.baseUrl}/d2l/home`);
      try {
        const links = await home.page.locator('a[href*="/d2l/le/discovery/view"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')).filter(Boolean));
        const target = links.find((href) => href && new URL(href, this.auth.config.baseUrl).origin === this.auth.config.baseUrl);
        if (target) this.discoveryUrl = validateReadPage(target, this.auth.config.baseUrl);
      } finally { await home.close(); }
    }
    return this.discoveryUrl ? this.open(this.discoveryUrl) : this.open(this.auth.config.catalogUrl, true);
  }
}
