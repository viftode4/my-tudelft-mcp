import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

export interface Config {
  baseUrl: string;
  catalogUrl: string;
  dataDir: string;
  browserChannel?: string;
  timeoutMs: number;
  maxFileBytes: number;
}

/**
 * Prefer a browser the student already has over a 300 MB Playwright download.
 * Returns a Playwright channel name, or undefined to use the bundled Chromium.
 * BRIGHTSPACE_BROWSER_CHANNEL always wins; set it to "bundled" to force the download.
 */
export function detectBrowserChannel(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
  const candidates: Array<[string, string[]]> = platform === 'win32'
    ? [['chrome', [join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')]],
       ['msedge', [join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]]]
    : platform === 'darwin'
    ? [['chrome', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]],
       ['msedge', ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']]]
    : [['chrome', ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']],
       ['msedge', ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']]];
  for (const [channel, paths] of candidates) if (paths.some(path => path && exists(path))) return channel;
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = new URL(env.BRIGHTSPACE_URL ?? 'https://brightspace.tudelft.nl');
  const catalog = new URL(env.BRIGHTSPACE_CATALOG_URL ?? 'https://brightspace-cc.tudelft.nl');
  for (const url of [base, catalog]) {
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Brightspace and catalog URLs must be HTTPS origins without credentials, paths, or queries.');
    }
  }
  return {
    baseUrl: base.origin,
    catalogUrl: catalog.origin,
    dataDir: resolve(env.BRIGHTSPACE_DATA_DIR ?? fileURLToPath(new URL('../.local', import.meta.url))),
    browserChannel: env.BRIGHTSPACE_BROWSER_CHANNEL === 'bundled' ? undefined : env.BRIGHTSPACE_BROWSER_CHANNEL ?? detectBrowserChannel(process.platform, env),
    timeoutMs: 25_000,
    maxFileBytes: 50 * 1024 * 1024,
  };
}
