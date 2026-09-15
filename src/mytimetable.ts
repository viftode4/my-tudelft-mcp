import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { BrightspaceClient } from './client.js';
import type { Config } from './config.js';
import { BrightspaceError } from './errors.js';
import { Vault } from './vault.js';
import { timetableWindow, TIMETABLE_URL, type TimetableCalendar } from './timetable-calendar.js';
import type { Row } from './util.js';

interface SavedFeed { version: 1; accountId: string; origin: string; feedUrl: string; connectedAt: string }
export function timetableFeedUrl(value: string): string {
  const fail = (): never => { throw new BrightspaceError('INVALID_TIMETABLE_FEED', 'Use your MyTimetable Connect calendar subscription URL on mytimetable.tudelft.nl.'); };
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\s]/.test(value)) return fail();
  let url: URL; try { url = new URL(value.replace(/^webcal:/i, 'https:')); } catch { return fail(); }
  if (url.origin !== 'https://mytimetable.tudelft.nl' || url.pathname !== '/ical' || url.username || url.password || url.hash || !url.search
    || [...url.searchParams].some(([key, val]) => /[\r\n\x00]/.test(key + val) || url.searchParams.getAll(key).length !== 1)) return fail();
  return url.href;
}
export async function calendarInWorker(text: string, from: string, to: string): Promise<TimetableCalendar> {
  timetableWindow(from, to);
  const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './timetable-worker.ts' : './timetable-worker.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { text, from, to }, stdout: true, stderr: true,
      execArgv: workerUrl.pathname.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (error?: BrightspaceError, calendar?: TimetableCalendar): void => {
      if (settled) return; settled = true; clearTimeout(timer);
      void worker.terminate().then(() => error ? reject(error) : resolve(calendar!), () => error ? reject(error) : resolve(calendar!));
    };
    const timer = setTimeout(() => finish(new BrightspaceError('TIMETABLE_LIMIT', 'Calendar parsing exceeded its time limit.')), 8000);
    worker.once('message', (message: { calendar?: TimetableCalendar; error?: { code: string; message: string } }) => {
      if (message.calendar) finish(undefined, message.calendar);
      else finish(new BrightspaceError(message.error?.code ?? 'TIMETABLE_FORMAT_CHANGED', message.error?.message ?? 'The calendar could not be parsed.'));
    });
    worker.once('error', () => finish(new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'Calendar parsing stopped or exceeded its memory limit.')));
    worker.once('exit', () => { if (!settled) finish(new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'Calendar parsing ended without a result.')); });
  });
}
export class MyTimetable {
  private generation = 0;
  private currentAccount?: string;
  constructor(private readonly config: Config, private readonly client: Pick<BrightspaceClient, 'verifyIdentity' | 'sessionIdentity'>) {}
  close(): void { this.generation++; }
  private vault(accountId: string): Vault<SavedFeed> {
    return new Vault(this.config.dataDir, 'timetable-' + createHash('sha256').update(this.config.baseUrl + ':' + accountId).digest('hex').slice(0, 20));
  }
  private async own(): Promise<string> {
    if (this.config.baseUrl !== 'https://brightspace.tudelft.nl') throw new BrightspaceError('TIMETABLE_ACCOUNT_UNVERIFIED', 'This calendar connector requires the TU Delft Brightspace account.');
    const accountId = (await this.client.verifyIdentity()).id;
    this.currentAccount = accountId; return accountId;
  }
  private async current(accountId: string, generation: number): Promise<void> {
    if (generation !== this.generation || await this.client.sessionIdentity() !== accountId || generation !== this.generation) {
      throw new BrightspaceError('TIMETABLE_ACCOUNT_CHANGED', 'The account or timetable connection changed. Check authentication before retrying.');
    }
  }
  private async download(feedUrl: string): Promise<string> {
    let response: Response;
    try { response = await fetch(timetableFeedUrl(feedUrl), { method: 'GET', redirect: 'manual',
      headers: { accept: 'text/calendar' }, signal: AbortSignal.timeout(this.config.timeoutMs) }); }
    catch { throw new BrightspaceError('TIMETABLE_UNAVAILABLE', 'The timetable subscription could not be reached.'); }
    try {
      if (response.status !== 200) throw new BrightspaceError('TIMETABLE_UNAVAILABLE', 'The timetable subscription was denied, incomplete or unavailable. Check your Connect calendar link.', { status: response.status });
      if (!/^(?:text\/calendar|application\/ics)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'The subscription did not return an iCalendar feed.');
      if (Number(response.headers.get('content-length') ?? 0) > 4 * 1024 * 1024) throw new BrightspaceError('TIMETABLE_LIMIT', 'The timetable feed exceeded its size limit.');
      const reader = response.body?.getReader(); if (!reader) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'The timetable feed was empty.');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > 4 * 1024 * 1024) throw new BrightspaceError('TIMETABLE_LIMIT', 'The timetable feed exceeded its size limit.');
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof BrightspaceError) throw error;
        throw new BrightspaceError('TIMETABLE_UNAVAILABLE', 'The timetable feed could not be read completely.');
      } finally { await reader.cancel().catch(() => undefined); }
      return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
    } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined); }
  }
  async connect(feedUrl: string): Promise<Row> {
    feedUrl = timetableFeedUrl(feedUrl);
    const generation = this.generation, accountId = await this.own(), vault = this.vault(accountId), fingerprint = await vault.fingerprint();
    await this.current(accountId, generation);
    const text = await this.download(feedUrl); await this.current(accountId, generation);
    const from = new Date().toISOString(), to = new Date(Date.now() + 14 * 86400_000).toISOString();
    const calendar = await calendarInWorker(text, from, to); await this.current(accountId, generation);
    const connectedAt = new Date().toISOString();
    await vault.save({ version: 1, accountId, origin: this.config.baseUrl, feedUrl, connectedAt }, fingerprint, () => {
      if (generation !== this.generation) throw new BrightspaceError('TIMETABLE_ACCOUNT_CHANGED', 'The timetable connection changed before saving.');
    });
    await this.current(accountId, generation);
    return { connected: true, accountBound: true, provider: 'MyTimetable', feedOwnership: 'student_supplied', sourceUrl: TIMETABLE_URL,
      connectedAt, previewEventCount: calendar.items.length, scope: 'The courses and groups included in your personal calendar subscription.' };
  }
  private async saved(accountId: string): Promise<SavedFeed> {
    const value = await this.vault(accountId).load();
    if (!value || value.version !== 1 || value.accountId !== accountId || value.origin !== this.config.baseUrl) {
      throw new BrightspaceError('TIMETABLE_NOT_CONNECTED', 'Connect your personal MyTimetable calendar subscription first.');
    }
    timetableFeedUrl(value.feedUrl); return value;
  }
  async status(): Promise<Row> {
    const generation = this.generation, accountId = await this.own();
    let value: SavedFeed;
    try { value = await this.saved(accountId); }
    catch (error) {
      if (error instanceof BrightspaceError && error.code === 'TIMETABLE_NOT_CONNECTED') {
        await this.current(accountId, generation); return { configured: false, sourceUrl: TIMETABLE_URL };
      }
      throw error;
    }
    await this.current(accountId, generation);
    return { configured: true, liveVerified: false, accountBound: true, provider: 'MyTimetable', connectedAt: value.connectedAt, sourceUrl: TIMETABLE_URL };
  }
  async events(from: string, to: string): Promise<Row> {
    timetableWindow(from, to);
    const generation = this.generation, accountId = await this.own(), vault = this.vault(accountId), fingerprint = await vault.fingerprint();
    const value = await this.saved(accountId); await this.current(accountId, generation);
    const text = await this.download(value.feedUrl); await this.current(accountId, generation);
    const calendar = await calendarInWorker(text, from, to); await this.current(accountId, generation);
    if (await vault.fingerprint() !== fingerprint) throw new BrightspaceError('TIMETABLE_ACCOUNT_CHANGED', 'The saved timetable changed during this read.');
    return { ...calendar, source: 'mytimetable_ical', provider: 'MyTimetable', accountBound: true, feedOwnership: 'student_supplied',
      from, to, fetchedAt: new Date().toISOString(), sourceUrl: TIMETABLE_URL,
      coverage: 'Events published in the current subscription for the selected range. Empty output does not establish free time; check selected courses, groups and publication dates.' };
  }
  async disconnect(): Promise<Row> {
    const accountId = await this.client.sessionIdentity().catch(() => undefined) ?? this.currentAccount;
    this.close(); if (accountId) await this.vault(accountId).clear();
    return { disconnected: true, provider: 'MyTimetable', remoteSubscriptionRevoked: false };
  }
}
