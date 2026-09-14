import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import type { BrightspaceClient } from './client.js';
import type { Config } from './config.js';
import { StudentGroups, type OwnGroup } from './groups.js';
import type { StudentFileIndexer, StudentFileOptions } from './student-files.js';
import { extractDocument, safeFilename, saveDownload, type DocumentText } from './documents.js';
import { BrightspaceError, safeError } from './errors.js';
import { numericId, plainText, record, safeSourceUrl, sameOriginUrl, str, type Row } from './util.js';

export type GroupLockerTransport = Pick<BrightspaceClient, 'json' | 'list' | 'apiUrl' | 'download' | 'sessionIdentity' | 'config'>;
export interface GroupLockerListOptions { folderPath?: string; startAt?: number; maxItems?: number; }
interface LockerItem { name: string; type: 'file' | 'folder'; size: number | null; lastModified: string | null; description: string; }
interface VerifiedGroup { accountId: string; courseId: string; group: OwnGroup; root: string; url: string; membershipUrl: string; }
const MAX_DEPTH = 12, MAX_ITEMS = 5_000;

function segment(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 255 || value === '.' || value === '..'
    || /[\\/%?#:\u0000-\u001f\u007f]/.test(value)) {
    throw new BrightspaceError('INVALID_LOCKER_PATH', 'Use an exact locker path returned by the file listing. Encoded paths, separators inside names and dot segments are not accepted.');
  }
  return value;
}
function pathParts(value: string, folder: boolean): string[] {
  if (typeof value !== 'string' || value.length > 2_048 || value.startsWith('//') || !folder && (!value || value.endsWith('/'))) {
    throw new BrightspaceError('INVALID_LOCKER_PATH', 'Use an exact file or folder path returned by the locker listing.');
  }
  let path = value.startsWith('/') ? value.slice(1) : value;
  if (folder && path.endsWith('/')) path = path.slice(0, -1);
  const parts = path ? path.split('/').map(segment) : [];
  if ((!folder && !parts.length) || parts.length > MAX_DEPTH) throw new BrightspaceError('INVALID_LOCKER_PATH', 'The locker path is empty or exceeds the folder depth limit.');
  return parts;
}
function canonical(parts: string[], folder = false): string { return '/' + parts.join('/') + (folder && parts.length ? '/' : ''); }
function encoded(parts: string[], folder = false): string { return parts.map(encodeURIComponent).join('/') + (folder && parts.length ? '/' : ''); }
function redactText(value: string, origin: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeSourceUrl(url, origin) ?? '[unsafe URL omitted]');
}
function publicText(value: unknown, origin: string): string {
  return redactText(plainText(value), origin);
}
function parseItems(payload: unknown, origin: string): LockerItem[] {
  // Current TU Delft returns a bare LockerItem array; D2L also documents a Folder wrapper.
  const values = Array.isArray(payload) ? payload : record(payload).Contents;
  if (!Array.isArray(values)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar group locker listing.');
  if (values.length > MAX_ITEMS) throw new BrightspaceError('LOCKER_READ_LIMIT', 'This folder exceeds the 5,000-item inspection limit.');
  const seen = new Set<string>();
  return values.map((value) => {
    const row = record(value);
    let name: string;
    try { name = segment(row.Name); } catch { throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unsupported locker item name.'); }
    if (seen.has(name) || row.Type !== 0 && row.Type !== 1) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned duplicate or unfamiliar locker items.');
    seen.add(name);
    const size = row.Size === null || row.Size === undefined ? null : row.Size;
    if (size !== null && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an invalid locker file size.');
    return { name, type: row.Type === 0 ? 'folder' : 'file', size,
      lastModified: typeof row.LastModified === 'string' && Number.isFinite(Date.parse(row.LastModified)) ? row.LastModified : null,
      description: publicText(str(row.Description).slice(0, 5_000), origin) };
  });
}
function range(options: StudentFileOptions): { offset: number; maxChars: number } {
  const offset = options.offset ?? 0, maxChars = options.maxChars ?? 20_000;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 50_000
    || options.download !== undefined && typeof options.download !== 'boolean') {
    throw new BrightspaceError('INVALID_RANGE', 'Use a nonnegative offset, maxChars from 1 to 50,000, and a boolean download option.');
  }
  return { offset, maxChars };
}

/** Reads only files whose exact path is present in a currently verified own-group locker. */
export class GroupLockerFiles {
  private readonly groups: StudentGroups;
  constructor(private readonly client: GroupLockerTransport, private readonly config: Pick<Config, 'baseUrl' | 'dataDir'> = client.config,
    private readonly indexFile?: StudentFileIndexer) {
    if (config.baseUrl !== client.config.baseUrl) throw new BrightspaceError('INVALID_ORIGIN', 'The locker configuration must use the authenticated Brightspace origin.');
    this.groups = new StudentGroups(client);
  }
  private async account(): Promise<string> {
    const account = await this.client.sessionIdentity();
    if (!account || !/^\d{1,18}$/.test(account)) throw new BrightspaceError('AUTH_REQUIRED', 'Verify your Brightspace identity before reading group locker files.');
    return account;
  }
  private async unchanged(expected: string): Promise<void> {
    if (await this.account() !== expected) throw new BrightspaceError('ACCOUNT_CHANGED', 'The account changed while reading group locker files.');
  }
  private async own(courseId: string, groupId: string): Promise<VerifiedGroup> {
    const accountId = await this.account(), memberships = await this.groups.get(courseId);
    await this.unchanged(accountId);
    const group = memberships.myGroups.find(item => item.id === groupId && item.courseId === courseId && item.membership === 'enrolled');
    if (!group) throw new BrightspaceError(memberships.membershipComplete ? 'PERMISSION_DENIED' : 'GROUP_MEMBERSHIP_UNVERIFIED',
      'This exact group could not be verified in the current student own memberships for the course.');
    return { accountId, courseId, group, root: courseId + '/locker/group/' + groupId + '/',
      url: this.config.baseUrl + '/d2l/lms/locker/group/group_locker.d2l?ou=' + courseId + '&grpId=' + groupId,
      membershipUrl: memberships.url };
  }
  private async folder(verified: VerifiedGroup, parts: string[]): Promise<{ path: string; items: LockerItem[] }> {
    let path = verified.root, items = parseItems(await this.client.json('le', path), this.config.baseUrl);
    await this.unchanged(verified.accountId);
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!, match = items.find(item => item.name === name && item.type === 'folder');
      if (!match) throw new BrightspaceError('NOT_FOUND', 'This folder is not listed in the verified group locker.');
      path = verified.root + encoded(parts.slice(0, index + 1), true);
      items = parseItems(await this.client.json('le', path), this.config.baseUrl);
      await this.unchanged(verified.accountId);
    }
    return { path, items };
  }
  async list(courseId: string, groupId: string, options: GroupLockerListOptions = {}): Promise<Row> {
    const course = numericId(courseId), group = numericId(groupId), parts = pathParts(options.folderPath ?? '/', true);
    const startAt = options.startAt ?? 0, maxItems = options.maxItems ?? 100;
    if (!Number.isSafeInteger(startAt) || startAt < 0 || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 500) {
      throw new BrightspaceError('INVALID_RANGE', 'Use a nonnegative startAt and maxItems from 1 to 500.');
    }
    const verified = await this.own(course, group), folder = await this.folder(verified, parts);
    if (startAt > folder.items.length) throw new BrightspaceError('INVALID_RANGE', 'startAt is beyond this folder. Restart at 0 if its contents changed.');
    const items = folder.items.slice(startAt, startAt + maxItems).map(item => ({
      name: item.name, type: item.type, path: canonical([...parts, item.name], item.type === 'folder'), size: item.size,
      lastModified: item.lastModified, description: item.description,
    }));
    await this.unchanged(verified.accountId);
    return { source: 'api', courseId: course, group: { id: group, categoryId: verified.group.categoryId, name: verified.group.name },
      membershipVerified: true, fetchedAt: new Date().toISOString(), url: verified.url, folderPath: canonical(parts, true), items,
      totalItems: folder.items.length, startAt, nextStartAt: startAt + items.length < folder.items.length ? startAt + items.length : null,
      complete: startAt + items.length >= folder.items.length,
      provenance: { membership: 'own_group_enrollment', membershipUrl: verified.membershipUrl,
        metadataUrl: safeSourceUrl(await this.client.apiUrl('le', folder.path), this.config.baseUrl), verifiedAncestorFolders: parts.length },
      scope: 'Direct contents of this verified own-group locker folder. Child folder contents and file bytes were not retrieved. Folder changes can shift startAt.' };
  }
  async read(courseId: string, groupId: string, filePath: string, options: StudentFileOptions = {}): Promise<Row> {
    const course = numericId(courseId), group = numericId(groupId), parts = pathParts(filePath, false), { offset, maxChars } = range(options);
    const verified = await this.own(course, group), folder = await this.folder(verified, parts.slice(0, -1));
    const metadata = folder.items.find(item => item.name === parts.at(-1) && item.type === 'file');
    if (!metadata) throw new BrightspaceError('NOT_FOUND', 'This exact file is not listed in the verified group locker folder.');
    if (metadata.size !== null && metadata.size > this.client.config.maxFileBytes) throw new BrightspaceError('FILE_TOO_LARGE', 'This locker file exceeds the configured download limit.');
    const fileUrl = await this.client.apiUrl('le', verified.root + encoded(parts));
    await this.unchanged(verified.accountId);
    const file = await this.client.download(fileUrl);
    await this.unchanged(verified.accountId);
    if (sameOriginUrl(file.url, this.config.baseUrl).href !== fileUrl) {
      throw new BrightspaceError('LOCKER_FILE_UNVERIFIED', 'The locker download did not remain at the exact verified file endpoint.');
    }
    if (file.bytes.length > this.client.config.maxFileBytes) throw new BrightspaceError('FILE_TOO_LARGE', 'This locker file exceeds the configured download limit.');
    const filename = safeFilename(metadata.name);
    let document: DocumentText, extractionError: ReturnType<typeof safeError> | undefined;
    try { document = await extractDocument(file.bytes, filename, file.contentType); }
    catch (error) {
      if (!(error instanceof BrightspaceError)) throw error;
      extractionError = safeError(error);
      document = { text: '', format: extname(filename).slice(1) || 'binary', warnings: ['The file is available, but its text could not be extracted: ' + error.message] };
    }
    const text = redactText(document.text, this.config.baseUrl);
    await this.unchanged(verified.accountId);
    let indexed = false, indexError: ReturnType<typeof safeError> | undefined;
    if (this.indexFile && text.trim()) {
      try {
        await this.indexFile(verified.accountId, {
          id: [course, group, Buffer.from(canonical(parts), 'utf8').toString('base64url')].join(':'),
          courseId: course, kind: 'group_locker_file', title: filename, text, url: verified.url,
        });
        indexed = true;
      } catch (error) {
        if (error instanceof BrightspaceError && error.code === 'ACCOUNT_CHANGED') throw error;
        indexError = safeError(error);
      }
      await this.unchanged(verified.accountId);
    }
    const accountKey = createHash('sha256').update(this.config.baseUrl + ':' + verified.accountId).digest('hex').slice(0, 20);
    const localPath = options.download ? await saveDownload(join(this.config.dataDir, 'downloads', accountKey, course, 'group_locker', group), filename, file.bytes) : undefined;
    await this.unchanged(verified.accountId);
    return { source: 'api', kind: 'group_locker_file', courseId: course, group: { id: group, categoryId: verified.group.categoryId, name: verified.group.name },
      membershipVerified: true, filePath: canonical(parts), filename, declaredBytes: metadata.size, bytes: file.bytes.length,
      lastModified: metadata.lastModified, fetchedAt: new Date().toISOString(), url: verified.url, localPath,
      format: document.format, pages: document.pages, warnings: document.warnings, extractionError, indexed, indexError,
      text: text.slice(offset, offset + maxChars), totalChars: text.length, nextOffset: offset + maxChars < text.length ? offset + maxChars : null,
      complete: document.warnings.length === 0 && offset + maxChars >= text.length,
      provenance: { membership: 'own_group_enrollment_and_exact_folder_entry', membershipUrl: verified.membershipUrl,
        metadataUrl: safeSourceUrl(await this.client.apiUrl('le', folder.path), this.config.baseUrl),
        fileUrl: safeSourceUrl(fileUrl, this.config.baseUrl), verifiedAncestorFolders: parts.length - 1 } };
  }
}
