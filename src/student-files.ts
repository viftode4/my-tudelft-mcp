import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import type { BrightspaceClient } from './client.js';
import type { Config } from './config.js';
import type { IndexedDocument } from './library.js';
import { extractDocument, safeFilename, saveDownload, type DocumentText } from './documents.js';
import { BrightspaceError, safeError } from './errors.js';
import { numericId, record, safeSourceUrl, str, type Row } from './util.js';

export type StudentFileTransport = Pick<BrightspaceClient, 'json' | 'apiUrl' | 'download' | 'sessionIdentity'>;
export interface StudentFileOptions { offset?: number; maxChars?: number; download?: boolean; }
export type StudentFileKind = 'announcement_attachment' | 'submission_file' | 'feedback_attachment';
export type StudentFileIndexer = (accountId: string, document: Omit<IndexedDocument, 'fetchedAt'>) => Promise<void>;
interface FileMetadata { id: string; filename: string; size?: number; }
interface EntityFiles { entityType: 'user' | 'group'; entityId: string; submissions: Row[]; feedback: Row; }
interface VerifiedFile {
  accountId: string; courseId: string; kind: StudentFileKind; file: FileMetadata;
  metadataPath: string; filePath: string; url: string;
  announcementId?: string; assignmentId?: string; submissionId?: string;
  entityType?: 'user' | 'group'; entityId?: string;
}

function fileMetadata(value: unknown): FileMetadata[] {
  if (!Array.isArray(value)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar file list.');
  return value.map((entry) => {
    const row = record(entry), id = str(row.FileId), filename = str(row.FileName);
    if (!/^\d{1,18}$/.test(id) || !filename) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned incomplete file metadata.');
    const size = row.Size ?? row.FileSize;
    return { id, filename: safeFilename(filename), ...(typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? { size } : {}) };
  });
}

function exactFile(files: FileMetadata[], fileId: string): FileMetadata {
  const matches = files.filter((file) => file.id === fileId);
  if (matches.length !== 1) throw new BrightspaceError(matches.length ? 'API_FORMAT_CHANGED' : 'NOT_FOUND',
    matches.length ? 'Brightspace returned an ambiguous file identifier.' : 'This file does not belong to the specified student resource.');
  return matches[0]!;
}

function ownEntities(payload: unknown, accountId: string): EntityFiles[] {
  if (!Array.isArray(payload)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned unfamiliar current-user submission history.');
  return payload.map((value) => {
    const row = record(value), entity = record(row.Entity), entityId = str(entity.EntityId);
    const type = str(entity.EntityType).toLowerCase();
    if (!/^\d{1,18}$/.test(entityId) || !['user', 'group'].includes(type) || !Array.isArray(row.Submissions)) {
      throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace did not identify the owner of this submission history.');
    }
    if (type === 'user' && entityId !== accountId) throw new BrightspaceError('OWNERSHIP_UNVERIFIED', 'The submission history belongs to another account.');
    // A group is trusted only because it was returned by the current-user mysubmissions endpoint.
    return { entityType: type as 'user' | 'group', entityId, submissions: row.Submissions.map(record), feedback: record(row.Feedback) };
  });
}

function range(options: StudentFileOptions): { offset: number; maxChars: number } {
  const offset = options.offset ?? 0, maxChars = options.maxChars ?? 20_000;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 50_000) {
    throw new BrightspaceError('INVALID_RANGE', 'Use a nonnegative offset and between 1 and 50,000 characters.');
  }
  return { offset, maxChars };
}

function publicText(value: string, origin: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeSourceUrl(url, origin) ?? '[unsafe URL omitted]');
}

/** No method accepts a URL, entity ID, or local destination supplied by the model.
 * All download paths are reconstructed from numeric IDs after source-membership checks.
 * D2L routes: https://docs.valence.desire2learn.com/res/news.html
 * https://docs.valence.desire2learn.com/res/dropbox.html
 */
export class StudentFiles {
  constructor(private readonly client: StudentFileTransport, private readonly config: Pick<Config, 'baseUrl' | 'dataDir'>,
    private readonly indexFile?: StudentFileIndexer) {}

  private async account(): Promise<string> {
    const accountId = await this.client.sessionIdentity();
    if (!accountId || !/^\d{1,18}$/.test(accountId)) throw new BrightspaceError('AUTH_REQUIRED', 'Verify your Brightspace identity before reading student files.');
    return accountId;
  }
  private async assertAccount(expected: string): Promise<void> {
    if (await this.account() !== expected) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed while reading this file.');
  }

  async announcement(courseId: string, announcementId: string, fileId: string, options: StudentFileOptions = {}): Promise<Row> {
    range(options);
    courseId = numericId(courseId); announcementId = numericId(announcementId); fileId = numericId(fileId);
    const accountId = await this.account(), metadataPath = courseId + '/news/' + announcementId;
    const news = record(await this.client.json('le', metadataPath));
    if (str(news.Id) !== announcementId) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace did not identify the requested announcement.');
    if (news.IsHidden === true || news.IsPublished === false) throw new BrightspaceError('NOT_FOUND', 'This announcement is not published for the student.');
    const file = exactFile(fileMetadata(news.Attachments), fileId);
    return this.read({ accountId, courseId, kind: 'announcement_attachment', announcementId, file, metadataPath,
      filePath: metadataPath + '/attachments/' + fileId,
      url: this.config.baseUrl + '/d2l/lms/news/main.d2l?ou=' + courseId }, options);
  }

  async submission(courseId: string, assignmentId: string, submissionId: string, fileId: string, options: StudentFileOptions = {}): Promise<Row> {
    range(options);
    courseId = numericId(courseId); assignmentId = numericId(assignmentId); submissionId = numericId(submissionId); fileId = numericId(fileId);
    const accountId = await this.account(), base = courseId + '/dropbox/folders/' + assignmentId;
    const metadataPath = base + '/submissions/mysubmissions/';
    const entities = ownEntities(await this.client.json('le', metadataPath), accountId);
    const matches = entities.flatMap((entity) => entity.submissions.filter((submission) => str(submission.Id) === submissionId).map((submission) => ({ entity, submission })));
    if (matches.length !== 1) throw new BrightspaceError(matches.length ? 'API_FORMAT_CHANGED' : 'NOT_FOUND',
      matches.length ? 'Brightspace returned an ambiguous submission identifier.' : 'This submission is not in your current-user submission history.');
    const { entity, submission } = matches[0]!;
    const file = exactFile(fileMetadata(submission.Files), fileId);
    return this.read({ accountId, courseId, kind: 'submission_file', assignmentId, submissionId, file, metadataPath,
      entityType: entity.entityType, entityId: entity.entityId,
      filePath: base + '/submissions/' + submissionId + '/files/' + fileId,
      url: this.config.baseUrl + '/d2l/lms/dropbox/user/folders_list.d2l?ou=' + courseId }, options);
  }

  async feedback(courseId: string, assignmentId: string, fileId: string, options: StudentFileOptions = {}): Promise<Row> {
    range(options);
    courseId = numericId(courseId); assignmentId = numericId(assignmentId); fileId = numericId(fileId);
    const accountId = await this.account(), base = courseId + '/dropbox/folders/' + assignmentId;
    const metadataPath = base + '/submissions/mysubmissions/';
    const entities = ownEntities(await this.client.json('le', metadataPath), accountId);
    const matches = entities.flatMap((entity) => {
      if (entity.feedback.IsGraded !== true) return [];
      return fileMetadata(entity.feedback.Files).filter((file) => file.id === fileId).map((file) => ({ entity, file }));
    });
    if (matches.length !== 1) throw new BrightspaceError(matches.length ? 'API_FORMAT_CHANGED' : 'NOT_FOUND',
      matches.length ? 'Brightspace returned an ambiguous feedback attachment.' : 'This file is not in your published assignment feedback.');
    const { entity, file } = matches[0]!;
    return this.read({ accountId, courseId, kind: 'feedback_attachment', assignmentId, file, metadataPath,
      entityType: entity.entityType, entityId: entity.entityId,
      filePath: base + '/feedback/' + entity.entityType + '/' + entity.entityId + '/attachments/' + fileId,
      url: this.config.baseUrl + '/d2l/lms/dropbox/user/folders_list.d2l?ou=' + courseId }, options);
  }

  private async read(verified: VerifiedFile, options: StudentFileOptions): Promise<Row> {
    const { offset, maxChars } = range(options);
    await this.assertAccount(verified.accountId);
    const metadataUrl = await this.client.apiUrl('le', verified.metadataPath);
    const fileUrl = await this.client.apiUrl('le', verified.filePath);
    const file = await this.client.download(fileUrl);
    await this.assertAccount(verified.accountId);
    let document: DocumentText, extractionError: ReturnType<typeof safeError> | undefined;
    try { document = await extractDocument(file.bytes, verified.file.filename, file.contentType); }
    catch (error) {
      if (!(error instanceof BrightspaceError)) throw error;
      extractionError = safeError(error);
      document = { text: '', format: extname(verified.file.filename).slice(1) || 'binary',
        warnings: ['The file is available, but its text could not be extracted: ' + error.message] };
    }
    const text = publicText(document.text, this.config.baseUrl);
    await this.assertAccount(verified.accountId);
    let indexed = false, indexError: ReturnType<typeof safeError> | undefined;
    if (this.indexFile && text.trim()) {
      try {
        await this.indexFile(verified.accountId, {
          id: [verified.courseId, verified.kind, verified.announcementId ?? verified.assignmentId, verified.submissionId ?? '0', verified.file.id].join(':'),
          courseId: verified.courseId, kind: verified.kind, title: verified.file.filename, url: verified.url, text,
        });
        indexed = true;
      } catch (error) {
        if (error instanceof BrightspaceError && error.code === 'ACCOUNT_CHANGED') throw error;
        indexError = safeError(error);
      }
      await this.assertAccount(verified.accountId);
    }
    const accountKey = createHash('sha256').update(this.config.baseUrl + ':' + verified.accountId).digest('hex').slice(0, 20);
    const localPath = options.download ? await saveDownload(join(this.config.dataDir, 'downloads', accountKey, verified.courseId, verified.kind), verified.file.filename, file.bytes) : undefined;
    await this.assertAccount(verified.accountId);
    return {
      source: 'api', kind: verified.kind, fetchedAt: new Date().toISOString(), timezone: 'Europe/Amsterdam',
      courseId: verified.courseId, announcementId: verified.announcementId, assignmentId: verified.assignmentId, submissionId: verified.submissionId,
      fileId: verified.file.id, filename: verified.file.filename, declaredBytes: verified.file.size, bytes: file.bytes.length,
      url: verified.url, localPath, format: document.format, pages: document.pages, warnings: document.warnings, extractionError,
      indexed, indexError,
      text: text.slice(offset, offset + maxChars), totalChars: text.length,
      nextOffset: offset + maxChars < text.length ? offset + maxChars : null,
      complete: document.warnings.length === 0 && offset + maxChars >= text.length,
      provenance: {
        membership: verified.kind === 'announcement_attachment' ? 'announcement_attachment_metadata' : 'current_user_submission_history',
        metadataUrl: safeSourceUrl(metadataUrl, this.config.baseUrl), fileUrl: safeSourceUrl(fileUrl, this.config.baseUrl),
        entityType: verified.entityType, entityId: verified.entityId,
      },
    };
  }
}
