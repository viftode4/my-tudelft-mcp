import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BrightspaceClient } from './client.js';
import { BrightspaceError, safeError } from './errors.js';
import { plainText, record, str, type Row } from './util.js';

const MODULE_VERSION = '2.39.0';
const PREFIX = 'GRAPH_MAIL_V1 ';
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024;
type Client = Pick<BrightspaceClient, 'config' | 'json' | 'sessionIdentity'>;
export interface MailStudentIdentity { accountId: string; uniqueName: string; emails: string[] }
export interface MailIdentity { id: string; tenantId: string; userPrincipalName: string; mail: string; displayName: string }
export interface MailWorker { request(op: string, args?: Row, timeoutMs?: number): Promise<unknown>; close(): Promise<void>; onLoginPrompt?: (prompt: MailLoginPrompt) => void }
export interface MailLoginPrompt { verificationUrl: string; userCode: string }
export interface UniversityMailOptions { powerShell?: string; modulePath?: string; workerFactory?: () => Promise<MailWorker>; openBrowser?: () => void }
export interface MailLoginStatus {
  state: 'idle' | 'waiting' | 'connected' | 'failed'; message: string;
  account?: MailIdentity; error?: ReturnType<typeof safeError>;
  verificationUrl?: string; userCode?: string;
}

export function mailLoginPrompt(value: unknown): MailLoginPrompt | undefined {
  const row = record(value);
  if (row.verificationUrl !== 'https://microsoft.com/devicelogin' || !/^[A-Z0-9]{6,12}$/.test(str(row.userCode))) return undefined;
  return { verificationUrl: row.verificationUrl, userCode: str(row.userCode) };
}

/** Only a fixed Microsoft page is passed to the platform's browser launcher. */
export function mailBrowserCommand(platform: string): [string, string[]] {
  const url = 'https://microsoft.com/devicelogin';
  if (platform === 'win32') return ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Start-Process '" + url + "'"]];
  return platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
}
function openMailBrowser(): void {
  const [command, args] = mailBrowserCommand(process.platform);
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => undefined); // The status always supplies the manual link.
  child.unref();
}

const lower = (value: unknown): string => str(value).trim().toLowerCase();
function principal(value: string): string | undefined { return /^([a-z0-9._-]{1,100})@(tudelft\.nl|student\.tudelft\.nl)$/.exec(value)?.[1]; }
const uuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Match institution-controlled identifiers, never display names or a lookalike domain. */
export function matchMailIdentity(student: MailStudentIdentity, value: unknown): MailIdentity {
  const row = record(value);
  const identity = { id: str(row.id), tenantId: str(row.tenantId), userPrincipalName: lower(row.userPrincipalName), mail: lower(row.mail), displayName: str(row.displayName).slice(0, 200) };
  const unique = lower(student.uniqueName), netid = principal(unique) ?? (/^[a-z0-9._-]{1,100}$/.test(unique) ? unique : undefined);
  const candidates = [identity.userPrincipalName, identity.mail].filter(value => principal(value));
  const emails = student.emails.map(lower).filter(value => principal(value));
  if (!uuid(identity.id) || !uuid(identity.tenantId) || identity.mail.length > 320 || !principal(identity.userPrincipalName)
    || !candidates.some(value => emails.includes(value) || value === unique || netid && principal(value) === netid)) {
    throw new BrightspaceError('MAIL_ACCOUNT_MISMATCH', 'Sign in with the same TU Delft account used for Brightspace. Display names are not sufficient to identify an account.');
  }
  return identity;
}

function mailId(value: string): string {
  if (!/^[A-Za-z0-9_+=/-]{1,2048}$/.test(value)) throw new BrightspaceError('INVALID_ARGUMENT', 'A valid mailbox message or folder ID is required.');
  return value;
}
function pageLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new BrightspaceError('INVALID_ARGUMENT', 'Email page size must be between 1 and 50.');
  return value;
}
function cursorValue(value?: string): string | undefined {
  if (value !== undefined && !/^[a-f0-9]{32}$/.test(value)) throw new BrightspaceError('INVALID_ARGUMENT', 'Use the opaque cursor returned by the same email query.');
  return value;
}

export function mailLoginDiagnostic(value: unknown): Row | undefined {
  const row = record(value);
  if (row.stage !== 'sdk_login') return undefined;
  const result: Row = { stage: 'sdk_login', reason: 'unclassified', exceptionType: 'other' };
  if (['window_handle_required', 'user_cancelled', 'browser_unavailable', 'timeout'].includes(str(row.reason))) result.reason = row.reason;
  if (['Azure.Identity.AuthenticationFailedException', 'Microsoft.Identity.Client.MsalClientException', 'Microsoft.Identity.Client.MsalServiceException', 'System.OperationCanceledException', 'System.TimeoutException', 'System.InvalidOperationException'].includes(str(row.exceptionType))) result.exceptionType = row.exceptionType;
  if (/^AADSTS(?:65001|65004|90094|50076|50079|53003|700016|50011)$/.test(str(row.aadsts))) result.aadsts = row.aadsts;
  return result;
}

/** A dedicated SDK process owns tokens; only bounded protocol responses leave it. */
export class PowerShellMailWorker implements MailWorker {
  onLoginPrompt?: (prompt: MailLoginPrompt) => void;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; draft: boolean; login: boolean }>();
  private sequence = 0;
  private buffer = '';
  private closed = false;
  constructor(powerShell: string, scriptPath: string, modulePath: string) {
    this.process = spawn(powerShell, ['-NoLogo', '-NoProfile', '-File', scriptPath, '-ModulePath', modulePath], { shell: false, windowsHide: true, stdio: 'pipe' });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.receive(chunk));
    // SDK warnings/errors can contain protocol material. Never copy either stream to MCP.
    this.process.stderr.resume();
    this.process.stdin.on('error', () => this.fail('MAIL_SESSION_ENDED', 'The email worker input stream closed.'));
    this.process.on('error', () => this.fail('MAIL_WORKER_UNAVAILABLE', 'PowerShell 7 could not start. Install the optional mail dependencies.'));
    this.process.on('exit', () => this.fail('MAIL_SESSION_ENDED', 'The process-local email session ended. Sign in again.'));
  }
  private fail(code: string, message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(entry.draft ? new BrightspaceError('MAIL_DRAFT_RESULT_UNKNOWN', 'Draft creation may have completed. Check Outlook Drafts before trying again; the request was not retried.') : new BrightspaceError(code, message));
    }
    this.pending.clear(); this.buffer = '';
    this.process.kill();
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_PROTOCOL_BYTES) return this.fail('MAIL_RESPONSE_TOO_LARGE', 'The email worker response exceeded its size limit.');
    for (;;) {
      const end = this.buffer.indexOf('\n'); if (end < 0) break;
      const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith(PREFIX)) {
        // SDK versions that write directly to Console bypass the PS pipeline.
        const match = /^To sign in, use a web browser to open the page https:\/\/(?:microsoft\.com\/devicelogin|login\.microsoft\.com\/device) and enter the code ([A-Z0-9]{6,12}) to authenticate\.?$/.exec(line);
        if (match && [...this.pending.values()].some(entry => entry.login)) {
          this.onLoginPrompt?.({ verificationUrl: 'https://microsoft.com/devicelogin', userCode: match[1]! });
        }
        continue;
      }
      let response: Row; try { response = record(JSON.parse(line.slice(PREFIX.length))); } catch { return this.fail('MAIL_PROTOCOL_ERROR', 'The email worker returned an invalid response.'); }
      const entry = this.pending.get(Number(response.id)); if (!entry) continue;
      if (response.event === 'login_prompt') {
        const prompt = mailLoginPrompt(response.prompt);
        if (entry.login && prompt) this.onLoginPrompt?.(prompt);
        continue;
      }
      this.pending.delete(Number(response.id)); clearTimeout(entry.timer);
      if (response.ok === true) entry.resolve(response.result);
      else {
        const code = str(record(response.error).code);
        const allowed: Record<string, string> = {
          MAIL_AUTH_REQUIRED: 'Sign in to university email first.', MAIL_LOGIN_FAILED: 'Microsoft browser sign-in did not complete. Start email login again; university approval or MFA may be required.',
          MAIL_ACCOUNT_MISMATCH: 'The email account does not match the current TU Delft account.', MAIL_SCOPE_MISMATCH: 'The Microsoft SDK session has unsupported permissions. No mailbox action was performed.',
          MAIL_ACCOUNT_CHANGED: 'The email account changed. Sign in again.', MAIL_CURSOR_INVALID: 'The email cursor expired or belongs to another query.', MAIL_NOT_FOUND: 'The selected message or folder was not found in your mailbox.',
          MAIL_REQUEST_FAILED: 'Microsoft Graph could not complete this request.', MAIL_RESPONSE_TOO_LARGE: 'The Microsoft Graph response exceeded its size limit.', MAIL_UNSAFE_RESPONSE: 'Microsoft Graph returned an unexpected response or redirect.',
          MAIL_DRAFT_RESULT_UNKNOWN: 'Draft creation may have completed. Check Outlook Drafts before trying again; the request was not retried.', MAIL_DRAFT_INVALID: 'Reply draft creation requires a sent or received message with a valid recipient.',
          MAIL_DEPENDENCY_MISSING: 'Install the optional mail dependencies with scripts/install-mail.ps1.', INVALID_ARGUMENT: 'An email argument is invalid.',
          MAIL_READ_LIMIT: 'Email pagination reached its 100-page limit. Start a narrower query.',
        };
        entry.reject(new BrightspaceError(code in allowed ? code : 'MAIL_REQUEST_FAILED', allowed[code] ?? allowed.MAIL_REQUEST_FAILED!, code === 'MAIL_LOGIN_FAILED' ? mailLoginDiagnostic(record(response.error).details) : undefined));
      }
    }
  }
  request(op: string, args: Row = {}, timeoutMs = 120_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new BrightspaceError('MAIL_SESSION_ENDED', 'The email session ended. Sign in again.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail('MAIL_TIMEOUT', 'The email operation timed out. Sign in again.'), timeoutMs);
      this.pending.set(id, { resolve, reject, timer, draft: op === 'createReply', login: op === 'login' });
      this.process.stdin.write(JSON.stringify({ id, op, args }) + '\n', error => { if (error) this.fail('MAIL_SESSION_ENDED', 'The email worker stopped.'); });
    });
  }
  async close(): Promise<void> { if (!this.closed) this.fail('MAIL_SESSION_ENDED', 'The email session was closed.'); }
}

class OutputBudget {
  remaining = 80_000; truncated = false;
  text(value: unknown, max: number): string {
    const raw = str(value), limit = Math.max(0, Math.min(max, this.remaining));
    if (raw.length > limit) this.truncated = true;
    const result = raw.slice(0, limit); this.remaining -= result.length; return result;
  }
  rows(value: unknown, max: number): unknown[] { const rows = Array.isArray(value) ? value : []; if (rows.length > max) this.truncated = true; return rows.slice(0, max); }
}
function emailAddress(value: unknown, budget: OutputBudget): Row {
  const address = record(record(value).emailAddress ?? value);
  return { name: budget.text(address.name, 200), address: budget.text(address.address, 320) };
}
function sourceLink(value: unknown): string | undefined {
  try { const url = new URL(str(value)); if (url.protocol === 'https:' && ['outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'].includes(url.hostname) && !url.username && !url.password && url.port === '' && url.href.length <= 4096) return url.href; } catch { /* no untrusted link */ }
  return undefined;
}
function message(value: unknown, budget: OutputBudget, full: boolean): Row {
  const row = record(value), id = str(row.id); mailId(id);
  const result: Row = { id, subject: budget.text(row.subject, 1000), from: emailAddress(row.from, budget), sender: emailAddress(row.sender, budget),
    receivedDateTime: budget.text(row.receivedDateTime, 40), sentDateTime: budget.text(row.sentDateTime, 40), isRead: row.isRead === true, isDraft: row.isDraft === true,
    hasAttachments: row.hasAttachments === true, bodyPreview: budget.text(row.bodyPreview, 300), webLink: sourceLink(row.webLink), conversationId: budget.text(row.conversationId, 2048) };
  if (full) {
    result.toRecipients = budget.rows(row.toRecipients, 50).map(item => emailAddress(item, budget));
    result.ccRecipients = budget.rows(row.ccRecipients, 50).map(item => emailAddress(item, budget));
    result.replyTo = budget.rows(row.replyTo, 20).map(item => emailAddress(item, budget));
    const body = record(row.body);
    result.body = budget.text(lower(body.contentType) === 'html' ? plainText(str(body.content)) : str(body.content), 60_000);
    result.bodyContentType = 'text';
  }
  return result;
}

export class UniversityMail {
  private worker?: MailWorker;
  private student?: MailStudentIdentity;
  private account?: MailIdentity;
  private generation = 0;
  private status: MailLoginStatus = { state: 'idle', message: 'University email is not connected.' };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly client: Client, private readonly options: UniversityMailOptions = {}) {}

  private async identity(): Promise<MailStudentIdentity> {
    const accountId = await this.client.sessionIdentity();
    if (!accountId || !/^\d+$/.test(accountId)) throw new BrightspaceError('AUTH_REQUIRED', 'Sign in to Brightspace before connecting university email.');
    const row = record(await this.client.json('lp', 'users/whoami'));
    if (str(row.Identifier) !== accountId || await this.client.sessionIdentity() !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed.');
    return { accountId, uniqueName: str(row.UniqueName), emails: [row.EmailAddress, row.Email, row.ExternalEmail].map(lower).filter(Boolean) };
  }
  private async createWorker(): Promise<MailWorker> {
    if (this.options.workerFactory) return this.options.workerFactory();
    const modulePath = this.options.modulePath ?? fileURLToPath(new URL('../.local/powershell/Modules/Microsoft.Graph.Authentication/' + MODULE_VERSION + '/Microsoft.Graph.Authentication.psd1', import.meta.url));
    try { await access(modulePath); } catch { throw new BrightspaceError('MAIL_DEPENDENCY_MISSING', 'Install the optional mail dependencies with scripts/install-mail.ps1.'); }
    return new PowerShellMailWorker(this.options.powerShell ?? 'pwsh', fileURLToPath(new URL('../scripts/graph-mail.ps1', import.meta.url)), modulePath);
  }
  private async assertCurrent(generation: number, student: MailStudentIdentity): Promise<void> {
    if (generation !== this.generation || await this.client.sessionIdentity() !== student.accountId || generation !== this.generation) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account or email session changed.');
  }
  beginLogin(): MailLoginStatus {
    if (this.status.state === 'waiting') return this.loginStatus();
    const generation = ++this.generation, old = this.worker; this.worker = undefined; this.student = undefined; this.account = undefined;
    void old?.close();
    this.status = { state: 'waiting', message: 'Preparing Microsoft browser sign-in. Poll login status for the Microsoft link and short code. Requested access: your profile and mail read/write for unsent drafts; no sending permission. University approval may be required.' };
    void (async () => {
      let worker: MailWorker | undefined;
      try {
        const student = await this.identity(); await this.assertCurrent(generation, student);
        worker = await this.createWorker();
        await this.assertCurrent(generation, student); this.worker = worker;
        let browserOpened = false;
        worker.onLoginPrompt = prompt => {
          if (generation !== this.generation || this.status.state !== 'waiting') return;
          this.status = { state: 'waiting', message: 'Open the Microsoft link and enter the code, then complete TU Delft sign-in and consent in your browser. If no browser opened, use the link manually.', ...prompt };
          if (!browserOpened) { browserOpened = true; (this.options.openBrowser ?? openMailBrowser)(); }
        };
        const result = record(await worker.request('login', { student }, 10 * 60_000));
        const account = matchMailIdentity(student, result.identity);
        await this.assertCurrent(generation, student);
        this.student = student; this.account = account; this.status = { state: 'connected', message: 'University email is connected for read/search and unsent reply drafts. The session lasts until this MCP process closes.', account };
      } catch (error) {
        await worker?.close();
        if (generation === this.generation) { this.worker = undefined; this.student = undefined; this.account = undefined; this.status = { state: 'failed', message: 'University email could not connect.', error: safeError(error) }; }
      }
    })();
    return this.loginStatus();
  }
  loginStatus(): MailLoginStatus { return structuredClone(this.status); }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const scoped = () => { if (generation !== this.generation) throw new BrightspaceError('ACCOUNT_CHANGED', 'The email session changed while this operation was queued.'); return action(); };
    const next = this.queue.then(scoped, scoped); this.queue = next.catch(() => undefined); return next;
  }
  private async invoke(op: string, args: Row = {}): Promise<Row> {
    const worker = this.worker, student = this.student, account = this.account, generation = this.generation;
    if (!worker || !student || !account || this.status.state !== 'connected') throw new BrightspaceError('MAIL_AUTH_REQUIRED', 'Connect university email first.');
    await this.assertCurrent(generation, student);
    const result = record(await worker.request(op, args));
    const current = matchMailIdentity(student, result.identity);
    if (current.id !== account.id || current.tenantId !== account.tenantId) throw new BrightspaceError('MAIL_ACCOUNT_CHANGED', 'The connected mailbox changed. Sign in again.');
    await this.assertCurrent(generation, student);
    return record(result.data);
  }
  async checkAuth(): Promise<Row> { return this.exclusive(async () => { await this.invoke('check'); return { authenticated: true, account: this.account, access: 'read_search_and_unsent_reply_drafts', canSend: false, persistence: 'current_mcp_process' }; }); }
  async listFolders(parentId?: string, cursor?: string): Promise<Row> {
    if (parentId !== undefined) mailId(parentId); cursorValue(cursor);
    return this.exclusive(async () => {
      const data = await this.invoke('folders', { parentId, cursor }), budget = new OutputBudget();
      const items = budget.rows(data.value, 50).map(value => { const row = record(value); return { id: mailId(str(row.id)), displayName: budget.text(row.displayName, 500), parentFolderId: budget.text(row.parentFolderId, 2048), childFolderCount: Number(row.childFolderCount) || 0, unreadItemCount: Number(row.unreadItemCount) || 0, totalItemCount: Number(row.totalItemCount) || 0 }; });
      return { source: 'microsoft_graph', items, nextCursor: cursorValue(typeof data.nextCursor === 'string' ? data.nextCursor : undefined), complete: !data.nextCursor && !budget.truncated && data.readLimitReached !== true, truncated: budget.truncated, readLimitReached: data.readLimitReached === true, pageLimit: 100 };
    });
  }
  private async messages(op: 'messages' | 'search', args: Row): Promise<Row> {
    const data = await this.invoke(op, args), budget = new OutputBudget();
    return { source: 'microsoft_graph', items: budget.rows(data.value, Number(args.limit)).map(value => message(value, budget, false)), nextCursor: cursorValue(typeof data.nextCursor === 'string' ? data.nextCursor : undefined), complete: !data.nextCursor && !budget.truncated && data.readLimitReached !== true, truncated: budget.truncated, readLimitReached: data.readLimitReached === true, pageLimit: 100, searchResultLimit: op === 'search' ? 1000 : undefined };
  }
  async listMessages(folderId = 'inbox', limit = 25, cursor?: string): Promise<Row> { mailId(folderId); pageLimit(limit); cursorValue(cursor); return this.exclusive(() => this.messages('messages', { folderId, limit, cursor })); }
  async search(query: string, limit = 25, cursor?: string): Promise<Row> {
    if (!query.trim() || query.length > 1000 || /[\x00-\x1f\x7f]/.test(query)) throw new BrightspaceError('INVALID_ARGUMENT', 'Email search must contain 1 to 1000 printable characters.');
    pageLimit(limit); cursorValue(cursor); return this.exclusive(() => this.messages('search', { query, limit, cursor }));
  }
  async read(messageId: string): Promise<Row> {
    mailId(messageId); return this.exclusive(async () => { const data = await this.invoke('read', { messageId }), budget = new OutputBudget(); if (str(data.id) !== messageId) throw new BrightspaceError('MAIL_UNSAFE_RESPONSE', 'The returned email does not match the requested message.'); return { source: 'microsoft_graph', message: message(data, budget, true), complete: !budget.truncated, truncated: budget.truncated, attachmentsIncluded: false, mailboxReadStateChanged: false }; });
  }
  async createReplyDraft(messageId: string, body: string, replyAll = false): Promise<Row> {
    mailId(messageId);
    if (!body.trim() || body.length > 20_000 || body.includes('\0') || typeof replyAll !== 'boolean') throw new BrightspaceError('INVALID_ARGUMENT', 'Reply text must contain 1 to 20000 characters and no NUL characters.');
    return this.exclusive(async () => {
      // The account is checked again between exact-message preflight and the one-shot write.
      const prepared = await this.invoke('prepareReply', { messageId, body, replyAll });
      const permit = cursorValue(str(prepared.permit));
      if (!permit) throw new BrightspaceError('MAIL_DRAFT_INVALID', 'The reply draft preflight did not complete.');
      let data: Row;
      try { data = await this.invoke('createReply', { permit }); }
      catch { throw new BrightspaceError('MAIL_DRAFT_RESULT_UNKNOWN', 'Draft creation may have completed. Check Outlook Drafts before trying again; the request was not retried.'); }
      if (data.isDraft !== true || data.bodyVerified !== true || data.recipientsVerified !== true || str(data.parentMessageId) !== messageId) throw new BrightspaceError('MAIL_DRAFT_RESULT_UNKNOWN', 'The draft could not be verified. Check Outlook Drafts before trying again.');
      const budget = new OutputBudget();
      return { source: 'microsoft_graph', savedToOutlook: true, sent: false, parentMessageId: messageId, replyAll, draft: message(data, budget, true), bodyVerified: true, recipientsVerified: true, complete: !budget.truncated, truncated: budget.truncated };
    });
  }
  async logout(): Promise<Row> { ++this.generation; const worker = this.worker; this.worker = undefined; this.student = undefined; this.account = undefined; this.status = { state: 'idle', message: 'The process-local university email session was closed.' }; await worker?.close(); return { loggedOut: true, processLocalSessionCleared: true }; }
  async close(): Promise<void> { await this.logout(); }
}
