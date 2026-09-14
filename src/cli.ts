#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Auth, discoverVersions } from './auth.js';
import { BrightspaceClient } from './client.js';
import { safeError } from './errors.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  if (command === '--help') {
    process.stdout.write('Usage: node dist/cli.js [serve|login [--fresh] [--catalog]|logout|doctor]\n');
    return;
  }
  const config = loadConfig(), auth = new Auth(config);
  if (command === 'login') {
    process.stderr.write(`${auth.beginLogin(process.argv.includes('--catalog') ? 'catalog' : 'brightspace', { fresh: process.argv.includes('--fresh') }).message}\n`);
    const status = await auth.waitForLogin();
    process.stderr.write(`${status.message}\n`);
    await auth.close();
    if (status.state !== 'connected') process.exitCode = 1;
  } else if (command === 'logout') {
    await auth.logout();
    process.stderr.write('Local login removed. Cached materials remain in the data directory.\n');
  } else if (command === 'doctor') {
    const client = new BrightspaceClient(config, auth);
    const report: Record<string, unknown> = { origin: config.baseUrl, checkedAt: new Date().toISOString() };
    try {
      report.versions = await discoverVersions(config);
      const state = await auth.vault.load();
      report.savedSession = Boolean(state);
      report.savedAt = state?.savedAt;
      const identity = await client.verifyIdentity();
      report.liveAuthenticated = Boolean(identity);
      if (!identity) process.exitCode = 1;
    } catch (error) { report.liveAuthenticated = false; report.error = safeError(error); process.exitCode = 1; }
    finally { await client.close(); await auth.close(); }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (command === 'serve') {
    const { serve } = await import('./server.js');
    await serve(config, auth);
  } else {
    process.stderr.write('Usage: node dist/cli.js [serve|login [--fresh] [--catalog]|logout|doctor]\n');
    process.exitCode = 1;
  }
}
main().catch((error: unknown) => { process.stderr.write(JSON.stringify(safeError(error)) + '\n'); process.exitCode = 1; });
