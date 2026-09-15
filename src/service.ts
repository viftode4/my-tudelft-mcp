import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { load } from 'cheerio';
import { Auth } from './auth.js';
import { BrightspaceClient } from './client.js';
import { BrowserReader } from './browser.js';
import { BrightspaceError, safeError } from './errors.js';
import { Library, type IndexedDocument } from './library.js';
import { studyOverview } from './study.js';
import { StudentCalendar } from './calendar.js';
import { extractDocument, saveDownload } from './documents.js';
import { array, numericId, plainText, record, safeSourceUrl, str, type Row } from './util.js';

export interface Topic {
  id: string; title: string; module: string; description: string; url: string;
  resourceUrl?: string; type: unknown; activityType: unknown; dueDate: unknown;
  opensAt: unknown; closesAt: unknown; locked: boolean; broken: boolean;
  descriptionLinks: { title: string; url: string }[];
}

function redactText(input: string): string {
  return input.replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeSourceUrl(url, 'https://brightspace.invalid') ?? '[unsafe URL omitted]');
}

function text(value: unknown): string { return redactText(plainText(value)); }

function publicUrl(input: unknown, origin: string): string | undefined { return safeSourceUrl(input, origin); }

function richLinks(value: unknown, origin: string): { title: string; url: string }[] {
  const row = record(value), html = typeof value === 'string' ? value : str(row.Html || row.Content);
  const $ = load(html), seen = new Set<string>();
  return $('a[href]').toArray().slice(0, 100).flatMap((link) => {
    const url = publicUrl($(link).attr('href'), origin);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ title: text($(link).text()), url }];
  });
}

export function flattenContent(payload: unknown, courseId: string, origin: string): { modules: Row[]; topics: Topic[] } {
  numericId(courseId);
  if (!Array.isArray(record(payload).Modules)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar course-content tree.');
  const modules: Row[] = [], topics: Topic[] = [], seenModules = new Set<string>(), seenTopics = new Set<string>();
  const walk = (nodes: unknown[], parents: string[] = [], depth = 0): void => {
    if (depth > 30) throw new BrightspaceError('CONTENT_DEPTH', 'The content tree is unexpectedly deep.');
    for (const raw of nodes) {
      const node = record(raw);
      if (node.IsHidden === true) continue;
      const id = str(node.ModuleId ?? node.Id), title = str(node.Title), trail = [...parents, title];
      if (!/^\d+$/.test(id) || node.Topics != null && !Array.isArray(node.Topics) || node.Modules != null && !Array.isArray(node.Modules)) {
        throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar course module.');
      }
      if (seenModules.has(id)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned a duplicate or cyclic course module.');
      seenModules.add(id);
      modules.push({
        id, title, path: trail.join(' / '), description: text(node.Description), descriptionLinks: richLinks(node.Description, origin),
        opensAt: node.StartDateTime ?? node.ModuleStartDate ?? null,
        closesAt: node.EndDateTime ?? node.ModuleEndDate ?? null, dueDate: node.ModuleDueDate ?? null,
      });
      for (const item of array(node.Topics)) {
        const topic = record(item);
        if (topic.IsHidden === true) continue;
        const topicId = str(topic.TopicId ?? topic.Id);
        if (!/^\d+$/.test(topicId)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned a topic without a numeric identifier.');
        if (seenTopics.has(topicId)) continue;
        seenTopics.add(topicId);
        // The live TU Delft TOC exposes ActivityType, while the topic detail exposes TopicType.
        const activityType = topic.ActivityType ?? null;
        const topicType = topic.TopicType ?? (Number(activityType) === 1 ? 1 : Number(activityType) === 2 ? 3 : null);
        topics.push({
          id: topicId, title: str(topic.Title), module: trail.join(' / '), description: text(topic.Description),
          url: origin + '/d2l/le/content/' + courseId + '/viewContent/' + topicId + '/View',
          resourceUrl: publicUrl(topic.Url, origin), type: topicType, activityType, dueDate: topic.DueDate ?? null,
          opensAt: topic.StartDateTime ?? topic.StartDate ?? null, closesAt: topic.EndDateTime ?? topic.EndDate ?? null,
          locked: topic.IsLocked === true, broken: topic.IsBroken === true,
          descriptionLinks: richLinks(topic.Description, origin),
        });
      }
      walk(array(node.Modules), trail, depth + 1);
    }
  };
  walk(array(record(payload).Modules));
  return { modules, topics };
}

/** Clean returned API data, including URLs inside rich text, without exposing launch credentials. */
export function cleanData(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[nested data omitted]';
  if (Array.isArray(value)) return value.map((item) => cleanData(item, depth + 1));
  if (value && typeof value === 'object') {
    const row = record(value);
    if ('Text' in row && 'Html' in row) return text(row);
    return Object.fromEntries(Object.entries(row).filter(([key]) => {
      const normalized = key.toLowerCase().replace(/[-_.]/g, '');
      return !/(?:token|password|secret|cookie|authorization|csrf|xsrf)/.test(normalized)
        && !['session', 'sessionid', 'apikey', 'samlresponse', 'samlrequest', 'oauthsignature'].includes(normalized);
    }).map(([key, item]) => [key, cleanData(item, depth + 1)]));
  }
  if (typeof value !== 'string') return value;
  if (/^\/[^/\s]/.test(value) && !/\s/.test(value)) {
    const safe = publicUrl(value, 'https://brightspace.invalid');
    return safe ? new URL(safe).pathname + new URL(safe).search : '[unsafe URL omitted]';
  }
  return /<\/?[a-z][\s\S]*>/i.test(value) ? text(value) : redactText(value);
}

function dateTime(value: string, label: string): string {
  // Require an explicit timezone so a student's dates do not depend on the machine timezone.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new BrightspaceError('INVALID_DATE', label + ' must be an ISO datetime with Z or an explicit timezone offset.');
  }
  const parsed = Date.parse(value);
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)!;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  if (!Number.isFinite(parsed) || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new BrightspaceError('INVALID_DATE', label + ' is not a valid date.');
  }
  return new Date(parsed).toISOString();
}

function windowBounds(offset: number, maxChars: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 100_000) {
    throw new BrightspaceError('INVALID_RANGE', 'Use a nonnegative character offset and between 1 and 100,000 characters.');
  }
}

function pagination(result: { complete: boolean; nextBookmark?: string; nextUrl?: string }, origin: string): Row {
  return { complete: result.complete, ...(result.nextBookmark ? { nextBookmark: result.nextBookmark } : {}),
    ...(result.nextUrl ? { nextUrl: publicUrl(result.nextUrl, origin) } : {}) };
}

export class StudentService {
  readonly client: BrightspaceClient;
  readonly browser: BrowserReader;
  private index?: Library;
  private accountKey?: string;
  private readonly indexContext = new AsyncLocalStorage<Library>();
  constructor(readonly auth: Auth, client?: BrightspaceClient) {
    this.client = client ?? new BrightspaceClient(auth.config, auth);
    this.browser = new BrowserReader(auth);
  }
  private get origin(): string { return this.auth.config.baseUrl; }
  private meta(source = 'api'): Row { return { source, fetchedAt: new Date().toISOString(), timezone: 'Europe/Amsterdam' }; }
  async library(): Promise<Library> {
    const scoped = this.indexContext.getStore();
    if (scoped) return scoped;
    const state = await this.auth.session();
    if (!state.identity?.id) throw new BrightspaceError('AUTH_REQUIRED', 'Verify your Brightspace identity before using the local course index.');
    if (await this.client.sessionIdentity() !== state.identity.id) {
      throw new BrightspaceError('ACCOUNT_CHANGED', 'The saved login differs from the active API account. Reconnect before indexing or searching course data.');
    }
    const key = createHash('sha256').update(state.origin + ':' + state.identity.id).digest('hex').slice(0, 20);
    if (key !== this.accountKey || !this.index) {
      this.index?.close();
      this.index = new Library(join(this.auth.config.dataDir, 'index-' + key + '.sqlite'));
      this.accountKey = key;
    }
    return this.index;
  }
  private indexDocs(index: Library, docs: Omit<IndexedDocument, 'fetchedAt'>[]): void {
    const fetchedAt = new Date().toISOString();
    for (const doc of docs) index.put({ ...doc, fetchedAt });
  }
  async indexStudentFile(accountId: string, document: Omit<IndexedDocument, 'fetchedAt'>): Promise<void> {
    if (await this.client.sessionIdentity() !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The account changed before caching a student file.');
    const index = await this.library();
    if (await this.client.sessionIdentity() !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The account changed while opening its local cache.');
    this.indexDocs(index, [document]);
  }
  private async fallback<T>(operation: () => Promise<T>, url: string): Promise<T | Row> {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof BrightspaceError) || !['PERMISSION_DENIED', 'NOT_FOUND', 'API_FORMAT_CHANGED', 'AUTH_REQUIRED'].includes(error.code)) throw error;
      return { ...await this.browser.read(url), apiError: safeError(error), complete: false,
        warning: 'Visible browser content may omit paginated or unopened sections.' };
    }
  }
  async checkAuth(refresh = false): Promise<Row> {
    await this.client.reset();
    const identity = refresh ? await this.client.refreshSession() : await this.client.verifyIdentity();
    return { ...this.meta(), connected: true, identity, login: this.auth.status };
  }
  async courses(query?: string, activeOnly = true): Promise<Row> {
    return await this.fallback(async () => {
      const result = await this.client.list('lp', 'enrollments/myenrollments/', { orgUnitTypeId: '3' });
      const items = result.items.map((item) => {
        const row = record(item), unit = record(row.OrgUnit), access = record(row.Access);
        return { id: str(unit.Id), name: str(unit.Name), code: str(unit.Code), url: publicUrl(unit.HomeUrl, this.origin),
          active: access.IsActive, canAccess: access.CanAccess, startDate: access.StartDate, endDate: access.EndDate,
          role: access.ClasslistRoleName, pinnedAt: row.PinDate };
      }).filter((course) => (!activeOnly || course.active !== false)
        && (!query || (course.name + ' ' + course.code).toLowerCase().includes(query.toLowerCase())));
      return { ...this.meta(), items, ...pagination(result, this.origin) };
    }, this.origin + '/d2l/home');
  }
  async content(courseId: string): Promise<Row> {
    const id = numericId(courseId);
    return await this.fallback(async () => {
      const result = flattenContent(await this.client.json('le', id + '/content/toc'), id, this.origin);
      const index = await this.library();
      this.indexDocs(index, [
        ...result.modules.map((module) => ({ id: id + ':module:' + str(module.id), courseId: id, kind: 'module',
          title: str(module.path), text: str(module.description), url: this.origin + '/d2l/le/content/' + id + '/Home' })),
        ...result.topics.map((topic) => ({ id: id + ':topic:' + topic.id, courseId: id, kind: 'topic',
          title: topic.module + ' / ' + topic.title, text: topic.description, url: topic.url })),
      ]);
      return { ...this.meta(), courseId: id, ...result, complete: true,
        scope: 'Content visible to this account under the current release and date restrictions.' };
    }, this.origin + '/d2l/le/content/' + id + '/Home');
  }
  async announcements(courseId: string, since?: string): Promise<Row> {
    const id = numericId(courseId), sinceTime = since === undefined ? undefined : Date.parse(dateTime(since, 'Since'));
    return await this.fallback(async () => {
      const result = await this.client.list('le', id + '/news/');
      let unknownDates = 0;
      const items = result.items.map(record).filter((item) => item.IsHidden !== true && item.IsPublished !== false).map((item) => ({
        id: str(item.Id), title: str(item.Title), text: text(item.Body), publishedAt: item.StartDate,
        modifiedAt: item.LastModifiedDate, createdAt: item.CreatedDate, attachments: cleanData(item.Attachments),
        links: richLinks(item.Body, this.origin),
        url: this.origin + '/d2l/lms/news/main.d2l?ou=' + id,
      })).filter((item) => {
        if (sinceTime === undefined) return true;
        const timestamp = Date.parse(str(item.modifiedAt || item.publishedAt || item.createdAt));
        if (!Number.isFinite(timestamp)) { unknownDates++; return true; }
        return timestamp >= sinceTime;
      });
      this.indexDocs(await this.library(), items.map((item) => ({ id: id + ':news:' + item.id, courseId: id,
        kind: 'announcement', title: item.title, text: item.text, url: item.url })));
      return { ...this.meta(), courseId: id, items, ...pagination(result, this.origin),
        ...(unknownDates ? { dateFilterWarning: 'Included ' + unknownDates + ' announcements whose publication/update time could not be determined.' } : {}) };
    }, this.origin + '/d2l/lms/news/main.d2l?ou=' + id);
  }
  async assignments(courseId: string): Promise<Row> {
    const id = numericId(courseId);
    return await this.fallback(async () => {
      const result = await this.client.list('le', id + '/dropbox/folders/');
      const items = result.items.map(record).filter((item) => item.IsHidden !== true).map((item) => {
        const availability = record(item.Availability);
        return { id: str(item.Id), title: str(item.Name), instructions: text(item.CustomInstructions),
          dueDate: item.DueDate ?? null, opensAt: availability.StartDate ?? null, closesAt: availability.EndDate ?? null,
          submissionType: item.SubmissionType, submissionRule: item.SubmissionRule ?? null,
          groupAssignment: Number(item.DropboxType) === 1 || item.GroupTypeId != null,
          attachments: cleanData(item.Attachments), links: cleanData(item.LinkAttachments), assessment: cleanData(item.Assessment),
          instructionLinks: richLinks(item.CustomInstructions, this.origin),
          url: this.origin + '/d2l/lms/dropbox/user/folder_submit_files.d2l?db=' + str(item.Id) + '&ou=' + id };
      });
      this.indexDocs(await this.library(), items.map((item) => ({ id: id + ':assignment:' + item.id, courseId: id,
        kind: 'assignment', title: item.title, text: item.instructions, url: item.url })));
      return { ...this.meta(), courseId: id, items, ...pagination(result, this.origin),
        note: 'Due dates and access closing times are separate. Individual extensions may apply. A missing date does not establish that no deadline exists.' };
    }, this.origin + '/d2l/lms/dropbox/user/folders_list.d2l?ou=' + id);
  }
  async assignment(courseId: string, assignmentId: string): Promise<Row> {
    const id = numericId(courseId), folder = numericId(assignmentId);
    const details = await this.client.json('le', id + '/dropbox/folders/' + folder);
    let submissions: unknown, submissionError: unknown;
    try { submissions = cleanData(await this.client.json('le', id + '/dropbox/folders/' + folder + '/submissions/mysubmissions/')); }
    catch (error) { submissionError = safeError(error); }
    return { ...this.meta(), courseId: id, assignmentId: folder, details: cleanData(details),
      mySubmissions: submissions, submissionError, complete: submissionError === undefined };
  }
  async grades(courseId: string): Promise<Row> {
    const id = numericId(courseId);
    return await this.fallback(async () => {
      const result = await this.client.list('le', id + '/grades/values/myGradeValues/');
      return { ...this.meta(), courseId: id, values: cleanData(result.items), ...pagination(result, this.origin),
        note: 'Brightspace grades may differ from the official study record.' };
    }, this.origin + '/d2l/lms/grades/my_grades/main.d2l?ou=' + id);
  }
  async quizzes(courseId: string): Promise<Row> {
    const id = numericId(courseId);
    return await this.fallback(async () => {
      const result = await this.client.list('le', id + '/quizzes/');
      return { ...this.meta(), courseId: id, items: cleanData(result.items), ...pagination(result, this.origin),
        note: 'Metadata only; no quiz attempt is started.' };
    }, this.origin + '/d2l/lms/quizzing/user/quizzes_list.d2l?ou=' + id);
  }
  async discussions(courseId: string, forumId?: string, topicId?: string): Promise<Row> {
    const id = numericId(courseId);
    if (topicId !== undefined && forumId === undefined) throw new BrightspaceError('INVALID_ID', 'A discussion topic requires its forum ID.');
    const suffix = forumId ? numericId(forumId) + '/topics/' + (topicId ? numericId(topicId) + '/posts/' : '') : '';
    return await this.fallback(async () => {
      const result = await this.client.list('le', id + '/discussions/forums/' + suffix);
      return { ...this.meta(), courseId: id, items: cleanData(result.items), ...pagination(result, this.origin) };
    }, this.origin + '/d2l/le/' + id + '/discussions/List');
  }
  async calendar(courseId: string, from: string, to: string): Promise<Row> {
    const id = numericId(courseId), start = dateTime(from, 'Start'), end = dateTime(to, 'End');
    if (Date.parse(end) <= Date.parse(start)) throw new BrightspaceError('INVALID_RANGE', 'End must be after start.');
    return await this.fallback(async () => {
      return await new StudentCalendar(this.client).get(id, start, end);
    }, this.origin + '/d2l/le/calendar/' + id);
  }
  async deadlines(courseIds: string[], days = 14): Promise<Row> {
    if (!Array.isArray(courseIds) || courseIds.length < 1 || courseIds.length > 100
      || !Number.isSafeInteger(days) || days < 1 || days > 366) throw new BrightspaceError('INVALID_RANGE', 'Choose 1–100 courses and a window of 1–366 days.');
    const ids = [...new Set(courseIds.map(numericId))], now = Date.now(), end = now + days * 86400_000;
    const items: Row[] = [], errors: Row[] = [], checked: string[] = [], undated: Row[] = [];
    for (const courseId of ids) {
      try {
        const assignments = await this.assignments(courseId);
        if (assignments.source !== 'api') { errors.push({ courseId, code: 'BROWSER_ONLY' }); continue; }
        checked.push(courseId);
        if (assignments.complete !== true) errors.push({ courseId, code: 'PARTIAL_ASSIGNMENTS', message: 'Assignment pagination was incomplete.' });
        for (const raw of array(assignments.items)) {
          const assignment = record(raw), timestamp = Date.parse(str(assignment.dueDate));
          if (!Number.isFinite(timestamp)) {
            undated.push({ courseId, assignmentId: assignment.id, title: assignment.title,
              reason: assignment.dueDate == null ? 'No published due date' : 'Unrecognised published due date' });
          } else if (timestamp >= now && timestamp <= end) items.push({ ...assignment, courseId, kind: 'assignment' });
        }
      } catch (error) { errors.push({ courseId, ...safeError(error) }); }
    }
    items.sort((a, b) => Date.parse(str(a.dueDate)) - Date.parse(str(b.dueDate)));
    return { ...this.meta(), from: new Date(now).toISOString(), to: new Date(end).toISOString(), items,
      checkedCourses: checked, assignmentsWithoutUsableDueDate: undated, errors, complete: !errors.length && !undated.some((item) => item.reason === 'Unrecognised published due date'),
      scope: 'Published assignment due dates in requested courses. Check quizzes, calendar and instructions for other deadlines; missing due dates and individual extensions are not inferred.' };
  }
  async material(courseId: string, topicId: string, offset = 0, maxChars = 20_000, download = false): Promise<Row> {
    const id = numericId(courseId), topic = numericId(topicId), source = this.origin + '/d2l/le/content/' + id + '/viewContent/' + topic + '/View';
    windowBounds(offset, maxChars);
    return await this.fallback(async () => {
      const meta = record(await this.client.json('le', id + '/content/topics/' + topic));
      const resourceUrl = publicUrl(meta.Url, this.origin), topicType = Number(meta.TopicType);
      const descriptionLinks = richLinks(meta.Description, this.origin);
      if (topicType !== 1) {
        const external = !!resourceUrl && new URL(resourceUrl).origin !== this.origin;
        return { ...this.meta(), courseId: id, topicId: topic, title: str(meta.Title), url: source, resourceUrl,
          external, downloadable: false, indexed: false, text: text(meta.Description), descriptionLinks, complete: false,
          note: external ? 'This topic is hosted by another service; use its authentication.'
            : 'This is a link or course activity, not a downloadable file. Use its source link or the corresponding assignment, quiz or discussion tool.' };
      }
      const resourceExtension = resourceUrl ? extname(new URL(resourceUrl).pathname).toLowerCase() : '';
      if (!download && ['.mp4', '.webm', '.mov', '.m4v', '.mp3', '.m4a', '.wav', '.ogg', '.m3u8', '.mpd'].includes(resourceExtension)) {
        const kind = ['.mp3', '.m4a', '.wav', '.ogg'].includes(resourceExtension) ? 'audio' : 'video';
        return { ...this.meta('api_metadata'), courseId: id, topicId: topic, title: str(meta.Title), url: source,
          resourceUrl, media: { kind, format: resourceExtension.slice(1), url: resourceUrl }, descriptionLinks,
          text: text(meta.Description), indexed: false, complete: false,
          captionLinks: descriptionLinks.filter(link => /\.(?:vtt|srt)$/i.test(new URL(link.url).pathname)),
          note: 'This topic contains audio or video. The source link and published description are available; media bytes and speech were not retrieved. Use a published caption link when present. Explicit downloads retain the configured file-size limit.' };
      }
      let file: Awaited<ReturnType<BrightspaceClient['download']>>;
      try { file = await this.client.download(await this.client.apiUrl('le', id + '/content/topics/' + topic + '/file')); }
      catch (error) {
        const status = error instanceof BrightspaceError ? error.details?.status : undefined;
        if (!(error instanceof BrightspaceError) || !(error.code === 'DOWNLOAD_FAILED' && [403, 404].includes(Number(status))
          || ['PERMISSION_DENIED', 'NOT_FOUND'].includes(error.code))) throw error;
        let page: Row | undefined, browserError: unknown;
        try { page = { ...await this.browser.read(source) }; }
        catch (failure) { browserError = safeError(failure); }
        return { ...this.meta(page ? 'browser' : 'api_metadata'), ...page, courseId: id, topicId: topic,
          title: str(meta.Title), url: source, resourceUrl, description: text(meta.Description), descriptionLinks,
          text: page && str(page.text).trim() ? redactText(str(page.text)) : text(meta.Description), apiError: safeError(error), browserError,
          complete: false, indexed: false, downloadable: false,
          note: 'Brightspace did not provide the source file. This is available page text or topic metadata, not extracted file content. Check description links for an alternative source.' };
      }
      let name = file.filename;
      if (!name) {
        try { name = decodeURIComponent(basename(new URL(str(meta.Url) || file.url, this.origin).pathname)); }
        catch { name = 'material'; }
      }
      const document = await extractDocument(file.bytes, name, file.contentType), documentText = redactText(document.text);
      this.indexDocs(await this.library(), [{ id: id + ':file:' + topic, courseId: id, kind: 'document',
        title: str(meta.Title) || name, text: documentText, url: source }]);
      const localPath = download ? await saveDownload(join(this.auth.config.dataDir, 'downloads', this.accountKey ?? 'current', id), name, file.bytes) : undefined;
      return { ...this.meta(), courseId: id, topicId: topic, title: str(meta.Title), url: source, filename: name,
        descriptionLinks,
        format: document.format, pages: document.pages, warnings: document.warnings, bytes: file.bytes.length, localPath,
        indexed: documentText.trim().length > 0, text: documentText.slice(offset, offset + maxChars), totalChars: documentText.length,
        nextOffset: offset + maxChars < documentText.length ? offset + maxChars : null,
        complete: document.warnings.length === 0 && offset + maxChars >= documentText.length };
    }, source);
  }
  async attachment(courseId: string, assignmentId: string, fileId: string, offset = 0, maxChars = 20_000, download = false): Promise<Row> {
    const id = numericId(courseId), folder = numericId(assignmentId), fileIdSafe = numericId(fileId);
    windowBounds(offset, maxChars);
    const details = record(await this.client.json('le', id + '/dropbox/folders/' + folder));
    const attachment = array(details.Attachments).map(record).find((item) => str(item.FileId) === fileIdSafe);
    if (!attachment) throw new BrightspaceError('NOT_FOUND', 'This file is not an attachment of this assignment.');
    const file = await this.client.download(await this.client.apiUrl('le', id + '/dropbox/folders/' + folder + '/attachments/' + fileIdSafe));
    const filename = str(attachment.FileName) || file.filename || 'attachment';
    const document = await extractDocument(file.bytes, filename, file.contentType), documentText = redactText(document.text);
    const source = this.origin + '/d2l/lms/dropbox/user/folders_list.d2l?ou=' + id;
    this.indexDocs(await this.library(), [{ id: id + ':attachment:' + folder + ':' + fileIdSafe, courseId: id,
      kind: 'document', title: filename, text: documentText, url: source }]);
    const localPath = download ? await saveDownload(join(this.auth.config.dataDir, 'downloads', this.accountKey ?? 'current', id), filename, file.bytes) : undefined;
    return { ...this.meta(), courseId: id, assignmentId: folder, fileId: fileIdSafe, filename, url: source,
      format: document.format, pages: document.pages, warnings: document.warnings, localPath, bytes: file.bytes.length,
      indexed: documentText.trim().length > 0, text: documentText.slice(offset, offset + maxChars), totalChars: documentText.length,
      nextOffset: offset + maxChars < documentText.length ? offset + maxChars : null,
      complete: document.warnings.length === 0 && offset + maxChars >= documentText.length };
  }
  async syncCourse(courseId: string, maxFiles = 20, startAt = 0): Promise<Row> {
    const id = numericId(courseId);
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || maxFiles > 100 || !Number.isSafeInteger(startAt) || startAt < 0) {
      throw new BrightspaceError('INVALID_RANGE', 'Use 0–100 files per sync and a nonnegative startAt offset.');
    }
    const index = await this.library();
    return await this.indexContext.run(index, async () => {
      const errors: Row[] = [], extractionWarnings: Row[] = [];
      let content: Row = {}, filesIndexed = 0;
      for (const [part, task] of [['content', () => this.content(id)], ['announcements', () => this.announcements(id)], ['assignments', () => this.assignments(id)]] as const) {
        try {
          const result = await task();
          if (part === 'content') content = result;
          if (result.source !== 'api') errors.push({ part, code: 'BROWSER_ONLY' });
          else if (result.complete !== true) errors.push({ part, code: 'PARTIAL_RESULTS' });
        } catch (error) { errors.push({ part, ...safeError(error) }); }
      }
      const topics = array(content.topics).map(record), skipped: Row[] = [];
      const extensions = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.ipynb', '.tsv', '.html', '.htm', '.txt', '.md', '.vtt', '.srt', '.csv', '.json', '.xml', '.py', '.java', '.js', '.ts', '.r', '.c', '.cpp', '.tex']);
      const candidates = topics.filter((topic) => {
        const url = str(topic.resourceUrl), extension = extname(new URL(url || '/', this.origin).pathname).toLowerCase();
        const isFile = Number(topic.type) === 1 || Number(topic.activityType) === 1;
        const usable = isFile && !topic.broken && (!url || new URL(url).origin === this.origin) && (!extension || extensions.has(extension));
        if (!usable) skipped.push({ topicId: topic.id, reason: !isFile ? 'link_or_activity' : topic.broken ? 'broken_topic' : 'external_or_unsupported_format' });
        return usable;
      }).sort((a, b) => BigInt(str(a.id)) < BigInt(str(b.id)) ? -1 : BigInt(str(a.id)) > BigInt(str(b.id)) ? 1 : 0);
      const batch = candidates.slice(startAt, startAt + maxFiles);
      for (const topic of batch) {
        try {
          const result = await this.material(id, str(topic.id), 0, 1);
          if (result.source === 'api' && result.indexed === true) filesIndexed++;
          else errors.push({ part: 'file', topicId: topic.id, code: 'NOT_INDEXED' });
          if (array(result.warnings).length) extractionWarnings.push({ topicId: topic.id, warnings: result.warnings });
        } catch (error) { errors.push({ part: 'file', topicId: topic.id, ...safeError(error) }); }
      }
      const next = Math.min(candidates.length, startAt + batch.length), remainingFiles = Math.max(0, candidates.length - next);
      return { ...this.meta(), courseId: id, startAt, filesAttempted: batch.length, filesIndexed, candidateFiles: candidates.length,
        remainingFiles, nextStartAt: remainingFiles > 0 ? next : null, errors, extractionWarnings, skippedTopics: skipped,
        coverage: index.coverage(id), batchComplete: !errors.length && !extractionWarnings.length,
        complete: startAt === 0 && !errors.length && !extractionWarnings.length && remainingFiles === 0 && skipped.length === 0,
        scope: 'Batch completion covers attempted files and metadata. Overall completeness also requires no skipped topics or unverified prior batches.',
        note: 'Resume with nextStartAt. Candidate ordering uses topic IDs; restart at 0 after course content changes. Search contains cached text; removed items are retained and may be stale. External tools, OCR and video speech are not indexed.' };
    });
  }
  async search(query: string, courseId?: string, limit = 15): Promise<Row> {
    const id = courseId === undefined ? undefined : numericId(courseId), index = await this.library();
    return { ...this.meta('local_index'), items: index.search(query, id, limit), coverage: index.coverage(id), complete: false,
      note: 'These are cached search matches, not a complete or current course listing. Run sync_course or read_material to refresh content. Removed items may remain in the index.' };
  }
  async study(courseIds: string[], days = 14, includeAnnouncements = true): Promise<Row> {
    const identity = await this.client.sessionIdentity();
    const result = await studyOverview(this, this.origin, courseIds, days, { includeAnnouncements });
    if (await this.client.sessionIdentity() !== identity) throw new BrightspaceError('ACCOUNT_CHANGED', 'The active account changed while preparing the study overview.');
    return cleanData(result) as Row;
  }
  async readPage(url: string): Promise<Row> { return { ...await this.browser.read(url) }; }
  async close(): Promise<void> {
    this.index?.close(); this.index = undefined; this.accountKey = undefined;
    await this.client.close();
  }
}
