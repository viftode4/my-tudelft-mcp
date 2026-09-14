import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface Config {
  baseUrl: string;
  catalogUrl: string;
  dataDir: string;
  browserChannel?: string;
  timeoutMs: number;
  maxFileBytes: number;
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
    browserChannel: env.BRIGHTSPACE_BROWSER_CHANNEL,
    timeoutMs: 25_000,
    maxFileBytes: 50 * 1024 * 1024,
  };
}
