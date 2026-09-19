#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Auth, discoverVersions } from './auth.js';
import { BrightspaceClient } from './client.js';
import { safeError } from './errors.js';
import { MyTuDelft } from './mytudelft.js';
import { MyTimetable } from './mytimetable.js';
import { UniversityMail } from './university-mail.js';
import { connectionOverview } from './connections.js';
import { parseLoginArgs } from './login-plan.js';
import { record } from './util.js';

const USAGE = 'Usage: node dist/cli.js [serve|login [--fresh] [--catalog] [--only brightspace,mytu,timetable]|logout|doctor]\n';

async function login(config: ReturnType<typeof loadConfig>, auth: Auth, argv: readonly string[]): Promise<void> {
  const plan = parseLoginArgs(argv);
  const say = (line: string): void => { process.stderr.write(`${line}\n`); };
  const client = new BrightspaceClient(config, auth);
  const mytu = new MyTuDelft(auth, client);
  const timetable = new MyTimetable(config, client, auth);
  const attempted: string[] = [];
  let failed = false;
  try {
    // 1. Brightspace: the one interactive sign-in. Everything else reuses its SURF SSO cookies.
    if (plan.steps.has('brightspace')) {
      attempted.push('Brightspace');
      say(auth.beginLogin(plan.catalog ? 'catalog' : 'brightspace', { fresh: plan.fresh }).message);
      const status = await auth.waitForLogin();
      say(`Brightspace: ${status.message}`);
      if (status.state !== 'connected') { process.exitCode = 1; return; }
      if (plan.catalog) return;
    } else {
      // --only without brightspace: use the saved session, never open a window for it.
      try { await client.verifyIdentity(); say('Brightspace: using the saved sign-in; no window was opened.'); }
      catch (error) {
        say(`Brightspace: ${safeError(error).message}`);
        say('Run "npm run login" once without --only to sign in, then retry.');
        process.exitCode = 1; return;
      }
    }

    // 2. My TU Delft (OSIRIS): silent through shared SSO first, a window only if the university asks.
    if (plan.steps.has('mytu')) {
      attempted.push('My TU Delft');
      let connected = false;
      if (!plan.fresh) {
        try { await mytu.checkAuth(); connected = true; say('My TU Delft: connected through your saved university sign-in.'); }
        catch { connected = false; }
      }
      if (!connected) {
        await mytu.beginLogin({ silent: false });
        const status = await mytu.waitForLogin();
        say(`My TU Delft: ${status.message}`);
        if (status.state !== 'connected') failed = true;
      }
    }

    // 3. MyTimetable: read the personal calendar link from the site, silently when SSO still holds.
    if (plan.steps.has('timetable')) {
      attempted.push('MyTimetable');
      // A saved subscription is kept unless the student asked for this step by name or for a fresh start.
      const requested = plan.fresh || (plan.only && plan.steps.has('timetable'));
      const existing = requested ? undefined : record(await timetable.status().catch(() => ({})));
      if (existing?.configured === true) {
        say('MyTimetable: already connected; the saved calendar subscription was kept. Use "--only timetable" to read it again.');
      } else {
        try { await timetable.capture({ silent: true }); say('MyTimetable: calendar subscription connected.'); }
        catch (silentError) {
          const code = safeError(silentError).code;
          if (code === 'TIMETABLE_AUTH_REQUIRED' || code === 'TIMETABLE_LOGIN_TIMEOUT') {
            try { await timetable.capture({ silent: false }); say('MyTimetable: calendar subscription connected.'); }
            catch (error) { failed = true; say(`MyTimetable: ${safeError(error).message}`); }
          } else { failed = true; say(`MyTimetable: ${safeError(silentError).message}`); }
        }
      }
    }
  } finally {
    timetable.close(); await mytu.close(); await client.close(); await auth.close();
  }
  const done = attempted.length ? `${attempted.join(', ')} ` : '';
  say(failed ? `Done with warnings (${done.trim()}). Run "npm run doctor" for the full picture. Lecture recordings and university email have their own logins; see the README.`
    : `Done. ${done}connected. Run "npm run doctor" to confirm. Lecture recordings and university email have their own logins; see the README.`);
  if (failed) process.exitCode = 1;
}

async function doctor(config: ReturnType<typeof loadConfig>, auth: Auth): Promise<void> {
  const client = new BrightspaceClient(config, auth);
  const mytu = new MyTuDelft(auth, client);
  const timetable = new MyTimetable(config, client, auth);
  const mail = new UniversityMail(client);
  const report: Record<string, unknown> = { origin: config.baseUrl, checkedAt: new Date().toISOString() };
  try {
    report.versions = await discoverVersions(config);
    const state = await auth.vault.load();
    report.savedSession = Boolean(state);
    report.savedAt = state?.savedAt;
    const overview = await connectionOverview({
      brightspace: async () => { await client.verifyIdentity(); return { connected: true }; },
      mytu: () => mytu.checkAuth(),
      timetable: () => timetable.status(),
      recordings: () => ({ state: 'idle' }),
      mail: () => mail.checkAuth(),
    }, config.baseUrl);
    Object.assign(report, overview);
    report.liveAuthenticated = overview.ready === true;
    if (overview.ready !== true) process.exitCode = 1;
  } catch (error) {
    report.liveAuthenticated = false; report.error = safeError(error); process.exitCode = 1;
  } finally {
    timetable.close(); await mytu.close(); await mail.close().catch(() => undefined); await client.close(); await auth.close();
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  if (command === '--help') { process.stdout.write(USAGE); return; }
  const config = loadConfig(), auth = new Auth(config);
  if (command === 'login') {
    await login(config, auth, process.argv.slice(3));
  } else if (command === 'logout') {
    await auth.logout();
    process.stderr.write('Local login removed. Cached materials remain in the data directory.\n');
  } else if (command === 'doctor') {
    await doctor(config, auth);
  } else if (command === 'serve') {
    const { serve } = await import('./server.js');
    await serve(config, auth);
  } else {
    process.stderr.write(USAGE);
    process.exitCode = 1;
  }
}
main().catch((error: unknown) => { process.stderr.write(JSON.stringify(safeError(error)) + '\n'); process.exitCode = 1; });
