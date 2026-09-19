import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { BrightspaceError } from './errors.js';

/** Interactive sign-in window: ten minutes. Silent renewal from saved SSO: 25 seconds. */
export const INTERACTIVE_LOGIN_MS = 10 * 60_000;
export const SILENT_LOGIN_MS = 25_000;
export const LOGIN_POLL_MS = 750;

export interface LoginFlowErrors {
  /** The window was closed or the owner cancelled. */
  cancelled: { code: string; message: string };
  /** The interactive deadline passed without the probe succeeding. */
  timeout: { code: string; message: string };
  /** Silent renewal hit a password/MFA page or ran out of time. */
  authRequired: { code: string; message: string };
}

export interface LoginFlow<T> {
  /** Headless renewal from saved SSO cookies, or a visible window for the student. */
  silent: boolean;
  /** Optional installed browser channel (BRIGHTSPACE_BROWSER_CHANNEL). */
  channel?: string;
  /** Cookies and origins seeded into the fresh context. */
  storageState: BrowserContextOptions['storageState'];
  /** Extra context options, e.g. locale and timezone for Brightspace. */
  contextOptions?: Omit<BrowserContextOptions, 'storageState'>;
  /** Block service workers, downloads and WebSockets (provider logins). */
  isolate?: boolean;
  interactiveMs?: number;
  silentMs?: number;
  errors: LoginFlowErrors;
  /** Called with the launched browser so the owner can cancel it, and with undefined when it is closed. */
  onBrowser?: (browser: Browser | undefined) => void;
  /** Owner-level cancellation and account checks; throw to abort. Runs before every step. */
  check: () => Promise<void>;
  /** Install guards and listeners on the context before the first page opens. */
  prepare?: (context: BrowserContext) => Promise<void>;
  /** Navigate the page to the service entry point. */
  start: (page: Page, context: BrowserContext) => Promise<void>;
  /** Return the result once the service is signed in, undefined to keep waiting, or throw. */
  probe: (page: Page, context: BrowserContext) => Promise<T | undefined>;
}

function raise(error: { code: string; message: string }): never {
  throw new BrightspaceError(error.code, error.message);
}

async function passwordVisible(page: Page): Promise<boolean> {
  return page.locator('input[type="password"]').first().isVisible().catch(() => false);
}

/**
 * The one browser login loop. Launches the browser (headed or headless),
 * seeds the context, runs the owner's start step, then polls the probe until
 * it returns a result or the deadline passes. Silent runs give up as soon as
 * the university shows a password field. The browser is always closed.
 */
export async function runLoginFlow<T>(flow: LoginFlow<T>): Promise<T> {
  const { silent, errors } = flow;
  const browser = await chromium.launch({ headless: silent, channel: flow.channel });
  flow.onBrowser?.(browser);
  try {
    await flow.check();
    const context = await browser.newContext({
      storageState: flow.storageState,
      ...(flow.isolate ? { serviceWorkers: 'block' as const, acceptDownloads: false } : {}),
      ...flow.contextOptions,
    });
    if (flow.isolate) await context.routeWebSocket('**/*', socket => socket.close());
    await flow.prepare?.(context);
    const page = await context.newPage();
    const current = async (): Promise<void> => {
      await flow.check();
      if (page.isClosed()) raise(errors.cancelled);
    };
    await current();
    await flow.start(page, context);
    const deadline = Date.now() + (silent ? flow.silentMs ?? SILENT_LOGIN_MS : flow.interactiveMs ?? INTERACTIVE_LOGIN_MS);
    while (Date.now() < deadline) {
      await current();
      const result = await flow.probe(page, context);
      if (result !== undefined) return result;
      if (silent && await passwordVisible(page)) raise(errors.authRequired);
      await page.waitForTimeout(LOGIN_POLL_MS);
    }
    const failure = silent ? errors.authRequired : errors.timeout;
    throw new BrightspaceError(failure.code, failure.message);
  } finally {
    await browser.close().catch(() => undefined);
    flow.onBrowser?.(undefined);
  }
}
