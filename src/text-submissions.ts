import { createHash, randomBytes } from 'node:crypto';
import type { Page, Route } from 'playwright';
import type { BrightspaceClient } from './client.js';
import type { BrowserReader } from './browser.js';
import { validateReadPage } from './browser.js';
import { resolveStudentCourse } from './course-navigation.js';
import { StudentGroups } from './groups.js';
import { BrightspaceError } from './errors.js';
import { numericId, plainText, record, str } from './util.js';

type Client = Pick<BrightspaceClient, 'config' | 'json' | 'list' | 'sessionIdentity'>;
type Browser = Pick<BrowserReader, 'open'>;
type Group = { id: string; name: string; categoryId: string };
type Form = { url: string; button: 'Submit' | 'Overwrite'; singleSubmission: boolean; maxLength: number; fields: string[]; fingerprint: string };
type History = { id: string; submittedBy: string; html: string; text: string; date: string };
type Pending = { accountId: string; courseId: string; folderId: string; courseName: string; assignmentName: string;
  text: string; html: string; sha256: string; group?: Group; previousIds: string[]; fingerprint: string; formFingerprint: string; expiresAt: number };
const FORM_PATH = '/d2l/lms/dropbox/user/folder_submit_files.d2l';
const TTL = 5 * 60 * 1000;
const MAX_TEXT_BYTES = 256 * 1024;
const BOOTSTRAP = new Set(['/@d2l/htmleditor/htmleditor', '/@d2l/creator-plus-authoring-tools/creator-plus-authoring-tools']);
const EXTRA_FIELDS = ['d2l_multiedit', 'd2l_stateScopes', 'd2l_stateGroups', 'd2l_statePageId', 'd2l_state_hpg'];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fingerprint = (value: unknown) => digest(JSON.stringify(value));
// HTML form serialization uses CRLF even when the approved JavaScript text contains LF.
const nativeLineEndings = (html: string) => html.replace(/\r\n|\r|\n/g, '\r\n');

export function textSubmissionHtml(text: string): string {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_TEXT_BYTES || /\u0000/.test(text)) {
    throw new BrightspaceError('INVALID_TEXT', 'Provide nonempty literal text of at most 256 KiB without null characters.');
  }
  // Preformatted text preserves user-selected whitespace and never interprets HTML or scripts.
  const html = '<pre>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '</pre>';
  if (html.length > 1_048_575) throw new BrightspaceError('INVALID_TEXT', 'The escaped text exceeds the native editor length limit.');
  return html;
}

function expectedFormUrl(value: string, origin: string, courseId: string, folderId: string, groupId: string): boolean {
  try {
    const url = new URL(value), keys = [...url.searchParams.keys()];
    return url.origin === origin && !url.username && !url.password && url.pathname === FORM_PATH && !url.hash && keys.length === new Set(keys).size
      && keys.every((key) => ['db', 'grpid', 'isprv', 'bp', 'ou'].includes(key))
      && url.searchParams.get('db') === folderId && url.searchParams.get('grpid') === groupId
      && url.searchParams.get('ou') === courseId && url.searchParams.get('isprv') === '0' && url.searchParams.get('bp') === '0';
  } catch { return false; }
}

function bootstrapRequest(url: string, method: string, body: string | null, origin: string): boolean {
  try {
    const endpoint = new URL(url), value = record(JSON.parse(body ?? 'null'));
    return method === 'POST' && endpoint.origin === origin && !endpoint.username && !endpoint.password
      && endpoint.pathname === '/d2l/api/oslo/batch' && !endpoint.search
      && Object.keys(value).length === 1 && Array.isArray(value.resources) && value.resources.length > 0 && value.resources.length <= 2
      && value.resources.every((item) => {
        if (typeof item !== 'string') return false;
        const resource = new URL(item, origin);
        return resource.origin === origin && !resource.username && !resource.password && BOOTSTRAP.has(resource.pathname) && !resource.search && !resource.hash;
      });
  } catch { return false; }
}

/** Parses only text fields from the multipart form shape observed on the native Text Submission page. */
export function textSubmissionFormFields(body: Buffer, contentType: string): Map<string, string> | undefined {
  const match = /^multipart\/form-data;\s*boundary=([-A-Za-z0-9]{1,80})$/.exec(contentType);
  if (!match || body.length > 2 * 1024 * 1024) return undefined;
  const boundary = match[1]!, raw = body.toString('utf8'), fields = new Map<string, string>();
  if (!raw.startsWith('--' + boundary + '\r\n') || !raw.endsWith('--' + boundary + '--\r\n')) return undefined;
  const parts = raw.split('--' + boundary);
  for (const part of parts.slice(1, -1)) {
    const field = /^\r\nContent-Disposition: form-data; name="([A-Za-z0-9_$]+)"\r\n\r\n([\s\S]*)\r\n$/.exec(part);
    if (!field || fields.has(field[1]!)) return undefined;
    fields.set(field[1]!, field[2]!);
  }
  return fields;
}

export async function observeTextSubmissionForm(page: Page, origin: string, courseId: string, folderId: string, groupId: string): Promise<Form> {
  if (!expectedFormUrl(page.url(), origin, courseId, folderId, groupId)) throw new BrightspaceError('ASSIGNMENT_CHANGED', 'The browser did not open the exact text assignment target.');
  const observed = await page.evaluate(() => {
    const editor = document.querySelector('d2l-htmleditor#REDT_comments');
    const form = editor?.closest('form');
    // Brightspace places the native action bar outside the editor's form.
    const buttons = Array.from(document.querySelectorAll('button')).filter((button) => /^(Submit|Overwrite)$/.test(button.textContent?.trim() ?? ''));
    const globals = window as unknown as { hasConfirm?: unknown; hasSingleFileConfirm?: unknown; isTextFileSubmission?: unknown;
      Upload?: unknown; DoUpload?: unknown; DoOverwrite?: unknown };
    return { editor: Boolean(editor), action: form?.getAttribute('action') ?? '', method: form?.getAttribute('method') ?? '',
      folderId: form?.querySelector<HTMLInputElement>('input[name=dropboxId]')?.value,
      editorCourse: form?.querySelector<HTMLInputElement>('input[name="REDT_comments$htmlOrgUnitId"]')?.value,
      fields: Array.from(form?.querySelectorAll('input[name]') ?? []).map((input) => input.getAttribute('name')!),
      fileInputs: form?.querySelectorAll('input[type=file]').length ?? 0, maxLength: Number(editor?.getAttribute('max-length')),
      button: buttons.length === 1 ? buttons[0]?.textContent?.trim() : null, hasConfirm: globals.hasConfirm,
      single: globals.hasSingleFileConfirm, textAndFile: globals.isTextFileSubmission,
      handlers: [globals.Upload, globals.DoUpload, globals.DoOverwrite].map((value) => typeof value === 'function' ? String(value) : '') };
  });
  if (!observed.editor || observed.method.toLowerCase() !== 'post'
    || !expectedFormUrl(new URL(observed.action, page.url()).href, origin, courseId, folderId, groupId)
    || observed.folderId !== folderId || observed.editorCourse !== courseId || observed.fileInputs
    || observed.textAndFile !== false || !['Submit', 'Overwrite'].includes(observed.button ?? '')
    || !Number.isSafeInteger(observed.maxLength) || observed.maxLength < 1
    || !observed.handlers[0]?.includes("Nav.SubmitAction( 'Update' )")) {
    throw new BrightspaceError('TEXT_SUBMISSION_UNAVAILABLE', 'The native text-only submission form or its exact target could not be verified.');
  }
  if (observed.hasConfirm !== false || typeof observed.single !== 'boolean') {
    throw new BrightspaceError('TEXT_SUBMISSION_REVIEW_REQUIRED', 'This assignment has an additional native confirmation that this tool cannot safely interpret.');
  }
  if (new Set(observed.fields).size !== observed.fields.length || !observed.fields.includes('REDT_comments$html')) {
    throw new BrightspaceError('PAGE_FORMAT_CHANGED', 'The native form fields are unfamiliar.');
  }
  const stable = { button: observed.button, single: observed.single, maxLength: observed.maxLength, fields: observed.fields, handlers: observed.handlers };
  return { url: page.url(), button: observed.button as 'Submit' | 'Overwrite', singleSubmission: observed.single,
    maxLength: observed.maxLength, fields: observed.fields, fingerprint: fingerprint(stable) };
}

function history(value: unknown, accountId: string, group?: Group): History[] {
  if (!Array.isArray(value)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned unfamiliar text submission history.');
  return value.flatMap((entry) => {
    const row = record(entry), entity = record(row.Entity);
    if (entity.EntityType !== (group ? 'Group' : 'User') || str(entity.EntityId) !== (group?.id ?? accountId)) {
      throw new BrightspaceError('API_FORMAT_CHANGED', 'Submission history does not match the approved user or group target.');
    }
    if (!Array.isArray(row.Submissions)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Submission history is incomplete.');
    return row.Submissions.map((value) => {
      const item = record(value), comment = record(item.Comment), id = str(item.Id);
      if (!/^\d{1,18}$/.test(id)) throw new BrightspaceError('API_FORMAT_CHANGED', 'A submission lacks a valid identifier.');
      return { id, submittedBy: str(record(item.SubmittedBy).Id), html: str(comment.Html), text: str(comment.Text), date: str(item.SubmissionDate) };
    });
  });
}

export class TextSubmissionActions {
  private readonly pending = new Map<string, Pending>();
  private generation = 0;
  constructor(private readonly client: Client, private readonly browser: Browser) {}

  private async details(courseId: string, folderId: string, groupId?: string) {
    const accountId = await this.client.sessionIdentity();
    if (!accountId) throw new BrightspaceError('AUTH_REQUIRED', 'A verified current account is required.');
    const course = await resolveStudentCourse(this.client, courseId), base = courseId + '/dropbox/folders/' + folderId;
    const row = record(await this.client.json('le', base));
    if (str(row.Id) !== folderId || !str(row.Name).trim()) throw new BrightspaceError('API_FORMAT_CHANGED', 'The assignment target could not be verified.');
    if (Number(row.SubmissionType) !== 1) throw new BrightspaceError('UNSUPPORTED_SUBMISSION', 'This tool currently supports native Text submission assignments only.');
    const categoryId = row.GroupTypeId == null ? undefined : str(row.GroupTypeId);
    if (Number(row.DropboxType) !== (categoryId ? 1 : 2) || categoryId && !/^\d{1,18}$/.test(categoryId)) {
      throw new BrightspaceError('API_FORMAT_CHANGED', 'The text assignment has inconsistent group metadata.');
    }
    let group: Group | undefined;
    if (categoryId) {
      const memberships = await new StudentGroups(this.client).get(courseId, categoryId);
      const groups = memberships.myGroups.filter((item) => item.complete && item.name.trim() && item.courseId === courseId && item.categoryId === categoryId)
        .map((item) => ({ id: item.id, name: item.name, categoryId }));
      if (!groupId) throw new BrightspaceError('GROUP_SELECTION_REQUIRED', 'Select an exact own group before preparing this text submission.', { ownGroups: groups, membershipComplete: memberships.membershipComplete });
      if (!memberships.complete || !(group = groups.find((item) => item.id === groupId))) {
        throw new BrightspaceError('GROUP_MEMBERSHIP_UNVERIFIED', 'Current membership in the exact assignment group could not be verified.');
      }
    } else if (groupId) throw new BrightspaceError('INVALID_GROUP_TARGET', 'This text assignment is individual; omit the group ID.');
    const rawAvailability = record(row.Availability);
    const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
    const availability = { startDate: date(rawAvailability.StartDate), endDate: date(rawAvailability.EndDate),
      startAvailabilityType: typeof rawAvailability.StartDateAvailabilityType === 'number' ? rawAvailability.StartDateAvailabilityType : null,
      endAvailabilityType: typeof rawAvailability.EndDateAvailabilityType === 'number' ? rawAvailability.EndDateAvailabilityType : null };
    const folder = { id: folderId, name: str(row.Name), groupCategoryId: categoryId ?? null, submissionType: 1,
      rule: typeof row.SubmissionRule === 'number' ? row.SubmissionRule : null, hidden: typeof row.IsHidden === 'boolean' ? row.IsHidden : null,
      dueDate: date(row.DueDate), availability,
      specialAccessOnly: typeof row.AllowOnlyUsersWithSpecialAccess === 'boolean' ? row.AllowOnlyUsersWithSpecialAccess : null, instructions: plainText(row.CustomInstructions) };
    const previous = history(await this.client.json('le', base + '/submissions/mysubmissions/'), accountId, group);
    if (await this.client.sessionIdentity() !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The account changed while reading the assignment.');
    return { accountId, course, folder, group, previous, fingerprint: fingerprint({ folder, group }) };
  }

  private async open(courseId: string, folderId: string, groupId: string) {
    const origin = this.client.config.baseUrl, opened = await this.browser.open(origin + '/d2l/lms/dropbox/user/folders_list.d2l?ou=' + courseId);
    try {
      const links = await opened.page.locator('a[href]').evaluateAll((elements) => elements.map((element) => (element as HTMLAnchorElement).href));
      const matches = [...new Set(links.filter((url) => expectedFormUrl(url, origin, courseId, folderId, groupId)))];
      if (matches.length !== 1) throw new BrightspaceError('TEXT_SUBMISSION_UNAVAILABLE', 'The assignment list does not expose a unique native text submission link for this target.');
      const url = matches[0]!;
      await opened.context.route('**/*', async (route: Route) => {
        try {
          const request = route.request();
          const bootstrap = bootstrapRequest(request.url(), request.method(), request.postData(), origin);
          if (request.isNavigationRequest() && request.method() === 'GET' && request.url() === url || bootstrap) {
            const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: this.client.config.timeoutMs,
              // Send the validated object, eliminating duplicate JSON keys or parser differences.
              ...(bootstrap ? { postData: JSON.stringify(JSON.parse(request.postData()!)) } : {}) });
            try {
              if (response.status() !== 200) { await route.abort('blockedbyclient'); return; }
              await route.fulfill({ response });
            } finally { await response.dispose(); }
          } else if (['GET', 'HEAD'].includes(request.method())) await route.fallback();
          else await route.abort('blockedbyclient');
        } catch { await route.abort('blockedbyclient').catch(() => undefined); }
      });
      await opened.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.client.config.timeoutMs });
      await opened.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      const form = await observeTextSubmissionForm(opened.page, origin, courseId, folderId, groupId);
      return { opened, form };
    } catch (error) { await opened.close(); throw error; }
  }

  async prepare(courseId: string, folderId: string, text: string, groupId?: string) {
    courseId = numericId(courseId); folderId = numericId(folderId);
    if (groupId !== undefined) groupId = numericId(groupId);
    const html = textSubmissionHtml(text), generation = this.generation;
    for (const [token, item] of this.pending) if (item.expiresAt <= Date.now()) this.pending.delete(token);
    if (this.pending.size >= 8) throw new BrightspaceError('PREVIEW_LIMIT', 'Too many text submission previews are pending.');
    const data = await this.details(courseId, folderId, groupId), { opened, form } = await this.open(courseId, folderId, data.group?.id ?? '0');
    try {
      if (html.length > form.maxLength) throw new BrightspaceError('INVALID_TEXT', 'The escaped text exceeds this assignment editor limit.');
      const identity = await this.client.sessionIdentity();
      if (generation !== this.generation || identity !== data.accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The session changed while preparing the preview.');
      const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + TTL, sha256 = digest(text);
      this.pending.set(token, { accountId: data.accountId, courseId, folderId, courseName: data.course.name, assignmentName: data.folder.name,
        text, html, sha256, group: data.group, previousIds: data.previous.map((item) => item.id).sort(),
        fingerprint: data.fingerprint, formFingerprint: form.fingerprint, expiresAt });
      return { status: 'preview', confirmationToken: token, expiresAt: new Date(expiresAt).toISOString(),
        target: { accountId: data.accountId, courseId, courseName: data.course.name, folderId, assignmentName: data.folder.name, group: data.group ? { ...data.group } : null },
        text, format: 'literal_plain_text', bytes: Buffer.byteLength(text), sha256, affectsGroup: Boolean(data.group),
        overwritesPrevious: form.button === 'Overwrite', onlyOneSubmission: form.singleSubmission,
        previousSubmissionCount: data.previous.length, dueDate: data.folder.dueDate, availability: data.folder.availability, sourceUrl: form.url,
        confirmationRequired: 'Show the full exact text, course, assignment, group, and any overwrite or one-submission effect. Submit only after the user explicitly approves this preview. General dates may differ from individual extensions; Brightspace makes the final access decision.' };
    } finally { await opened.close(); }
  }

  async confirm(token: string, confirmed = false) {
    if (confirmed !== true) throw new BrightspaceError('CONFIRMATION_REQUIRED', 'The user must approve the exact text submission preview.');
    const pending = this.pending.get(token), generation = this.generation;
    this.pending.delete(token);
    if (!pending || pending.expiresAt <= Date.now()) throw new BrightspaceError('INVALID_PREVIEW', 'This text submission preview is expired, used or unknown.');
    const data = await this.details(pending.courseId, pending.folderId, pending.group?.id);
    if (data.accountId !== pending.accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The current account changed after preview.');
    if (data.fingerprint !== pending.fingerprint || JSON.stringify(data.previous.map((item) => item.id).sort()) !== JSON.stringify(pending.previousIds)) {
      throw new BrightspaceError('PREVIEW_STALE', 'Assignment, group or submission history changed. Prepare and approve a new preview.');
    }
    const { opened, form } = await this.open(pending.courseId, pending.folderId, pending.group?.id ?? '0');
    let sent = false, reserved = false, conversionUsed = false, accepting = true;
    try {
      if (form.fingerprint !== pending.formFingerprint) throw new BrightspaceError('PREVIEW_STALE', 'The native submission form or confirmation changed.');
      const allowedFields = new Set([...form.fields, ...EXTRA_FIELDS]);
      await opened.context.route('**/*', async (route: Route) => {
        const request = route.request(), url = new URL(request.url());
        if (['GET', 'HEAD'].includes(request.method())) {
          try {
            if (request.isNavigationRequest()) throw new Error('Navigation after approval is unnecessary');
            validateReadPage(request.url(), this.client.config.baseUrl);
            await route.fallback();
          } catch { await route.abort('blockedbyclient'); }
          return;
        }
        let conversion = false;
        if (request.method() === 'POST' && url.origin === this.client.config.baseUrl && !url.username && !url.password
          && url.pathname === '/d2l/lp/htmleditor/converttoabsolute'
          && [...url.searchParams.keys()].length === 1 && url.searchParams.get('ou') === pending.courseId) {
          const params = new URLSearchParams(request.postData() ?? ''), keys = [...params.keys()];
          conversion = !conversionUsed && params.get('html') === pending.html && keys.length === new Set(keys).size
            && keys.every((key) => ['filterMode', 'html', 'isXhr', 'requestId', 'd2l_referrer'].includes(key));
        }
        const fields = request.method() === 'POST' && request.url() === form.url
          ? textSubmissionFormFields(request.postDataBuffer() ?? Buffer.alloc(0), request.headers()['content-type'] ?? '') : undefined;
        const submission = fields && fields.get('d2l_action') === 'Update' && fields.get('dropboxId') === pending.folderId
          && fields.get('REDT_comments$htmlOrgUnitId') === pending.courseId
          && nativeLineEndings(fields.get('REDT_comments$html') ?? '') === nativeLineEndings(pending.html)
          && [...fields.keys()].every((key) => allowedFields.has(key));
        if (!accepting || !conversion && (!submission || reserved)) { await route.abort('blockedbyclient'); return; }
        if (conversion) conversionUsed = true; else reserved = true;
        try {
          const identity = await this.client.sessionIdentity();
          if (!accepting || generation !== this.generation || pending.expiresAt <= Date.now() || identity !== pending.accountId) {
            await route.abort('blockedbyclient'); return;
          }
          if (!conversion) sent = true;
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: this.client.config.timeoutMs });
          try {
            if (conversion && response.status() === 200) await route.fulfill({ response });
            else await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Verifying submission</title>' });
          } finally { await response.dispose(); }
        } catch { await route.abort('blockedbyclient').catch(() => undefined); }
      });
      if (generation !== this.generation || pending.expiresAt <= Date.now()) throw new BrightspaceError('INVALID_PREVIEW', 'The preview expired or the session changed before submission.');
      await opened.page.evaluate((html) => {
        const ui = (window as unknown as { UI?: { GetControl: (id: string) => { SetText: (html: string) => void } } }).UI;
        if (!ui) throw new Error('Native editor unavailable');
        ui.GetControl('REDT_comments').SetText(html);
      }, pending.html);
      await opened.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await opened.page.getByRole('button', { name: form.button, exact: true }).click({ timeout: this.client.config.timeoutMs });
      const confirmations = [
        ...(form.button === 'Overwrite' ? ['Are you sure you want to overwrite your previous submissions?'] : []),
        ...(form.singleSubmission ? ['This submission folder only allows one submission, are you sure you wish to submit?'] : []),
      ];
      for (const question of confirmations) {
        const prompt = opened.page.getByText(question, { exact: true });
        await prompt.waitFor({ state: 'visible', timeout: 5000 });
        const yes = opened.page.getByRole('button', { name: 'Yes', exact: true });
        if (await prompt.count() !== 1 || await yes.count() !== 1) throw new BrightspaceError('CONFIRMATION_CHANGED', 'The native confirmation could not be identified uniquely.');
        await yes.click({ timeout: 5000 });
      }
      await opened.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    } catch (error) {
      if (!sent && error instanceof BrightspaceError) throw error;
      // Once the guarded form was sent, only subsequent membership/history evidence can confirm success.
    } finally { accepting = false; await opened.close(); }
    if (!sent) throw new BrightspaceError('TEXT_SUBMISSION_NOT_SENT', 'No text submission request was sent. Refresh the assignment and prepare a new preview.');
    try {
      const after = history(await this.client.json('le', pending.courseId + '/dropbox/folders/' + pending.folderId + '/submissions/mysubmissions/'), pending.accountId, pending.group);
      const candidates = after.filter((item) => !pending.previousIds.includes(item.id) && item.submittedBy === pending.accountId
        && nativeLineEndings(item.html) === nativeLineEndings(pending.html));
      if (candidates.length === 1 && await this.client.sessionIdentity() === pending.accountId) return {
        status: 'submitted', accountId: pending.accountId, courseId: pending.courseId, courseName: pending.courseName, folderId: pending.folderId,
        assignmentName: pending.assignmentName, group: pending.group ? { ...pending.group } : null, sha256: pending.sha256,
        receipt: { id: candidates[0]!.id, submittedAt: candidates[0]!.date },
        evidence: 'A new submission by the current account, for the exact target, contains the exact approved text HTML.' };
    } catch { /* A native POST response alone does not establish submission success. */ }
    throw new BrightspaceError('TEXT_SUBMISSION_OUTCOME_UNKNOWN', 'A text submission request was sent, but an exact receipt could not be verified. Do not retry automatically; check submission history first.',
      { courseId: pending.courseId, folderId: pending.folderId, groupId: pending.group?.id, sha256: pending.sha256 });
  }

  close(): void { this.generation++; this.pending.clear(); }
}
