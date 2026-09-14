import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { BrightspaceClient } from './client.js';
import { resolveStudentCourse } from './course-navigation.js';
import { StudentGroups } from './groups.js';
import { BrightspaceError } from './errors.js';
import { array, numericId, plainText, record, str, type Row } from './util.js';

const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 8;

type FilePreview = { path: string; filename: string; size: number; sha256: string };
type FileSnapshot = FilePreview & { bytes: Buffer };
type GroupTarget = { groupId: string; groupName: string; groupCategoryId: string; groupCategoryName: string };
type Pending = {
  courseId: string; folderId: string; accountId: string; comments: string; files: FilePreview[];
  folder: Row; courseName: string; fingerprint: string; previousIds: string[]; expiresAt: number;
  group?: GroupTarget;
};
type Submission = { id: string; submittedAt: string; files: { filename: string; size: number }[]; groupId?: string; submittedById?: string };
export type SubmissionTransport = Pick<BrightspaceClient, 'json' | 'list' | 'config' | 'postMultipart'>;

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function folderSnapshot(value: unknown, expectedId: string): Row {
  const folder = record(value);
  if (str(folder.Id) !== expectedId || !str(folder.Name)) {
    throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace did not identify the requested assignment.');
  }
  const submissionType = folder.SubmissionType == null ? undefined : Number(folder.SubmissionType);
  if (submissionType !== undefined && ![0, 4].includes(submissionType)) {
    throw new BrightspaceError('UNSUPPORTED_SUBMISSION', 'This assignment does not accept file submissions through this tool.');
  }
  const dropboxType = folder.DropboxType == null ? undefined : Number(folder.DropboxType);
  const groupCategoryId = folder.GroupTypeId == null ? null : str(folder.GroupTypeId);
  if (dropboxType !== undefined && ![1, 2].includes(dropboxType)
    || dropboxType === 1 && groupCategoryId === null || dropboxType === 2 && groupCategoryId !== null
    || groupCategoryId !== null && !/^\d{1,18}$/.test(groupCategoryId)) {
    throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace did not identify a consistent assignment type and group category.');
  }
  const availability = record(folder.Availability);
  return {
    id: expectedId, name: str(folder.Name), submissionType: submissionType ?? null,
    dropboxType: dropboxType ?? (groupCategoryId === null ? 2 : 1), groupCategoryId,
    submissionRule: folder.SubmissionRule == null ? null : Number(folder.SubmissionRule),
    isHidden: folder.IsHidden ?? null, dueDate: folder.DueDate ?? null,
    startDate: availability.StartDate ?? null, endDate: availability.EndDate ?? null,
    startDateAvailabilityType: availability.StartDateAvailabilityType ?? null,
    endDateAvailabilityType: availability.EndDateAvailabilityType ?? null,
    specialAccessOnly: folder.AllowOnlyUsersWithSpecialAccess ?? null,
    instructions: plainText(folder.CustomInstructions).slice(0, 20_000),
  };
}

function readSubmissions(value: unknown, groupId?: string): Submission[] {
  if (!Array.isArray(value)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned unfamiliar submission history.');
  return value.flatMap((entity) => {
    if (groupId) {
      const target = record(record(entity).Entity);
      if (target.EntityType !== 'Group' || !/^\d{1,18}$/.test(str(target.EntityId))) {
        throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace did not identify the group in its submission history.');
      }
      if (str(target.EntityId) !== groupId) return [];
    }
    const rows = record(entity).Submissions;
    if (!Array.isArray(rows)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned unfamiliar submission history.');
    return rows.map((value) => {
      const item = record(value), id = str(item.Id);
      if (!id) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned a submission without an identifier.');
      return { id, submittedAt: str(item.SubmissionDate), files: array(item.Files).map((file) => ({
        filename: str(record(file).FileName), size: Number(record(file).Size),
      })), ...(groupId ? { groupId, submittedById: str(record(item.SubmittedBy).Id) } : {}) };
    });
  });
}

function localPath(input: string): string {
  if (typeof input !== 'string' || !isAbsolute(input) || /[\u0000-\u001f]/.test(input)
    || /^[\\/]{2}/.test(input) || process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(input) || input.slice(2).includes(':'))) {
    throw new BrightspaceError('INVALID_FILE', 'Select an absolute path to a regular local file; network, device and alternate-stream paths are unsupported.');
  }
  return resolve(input);
}

async function snapshotFile(input: string): Promise<FileSnapshot> {
  const selectedPath = localPath(input), filename = basename(selectedPath);
  if (!filename || /["\\/\u0000-\u001f\u007f]/.test(filename)) {
    throw new BrightspaceError('INVALID_FILE', 'The selected filename cannot be safely included in a submission.');
  }
  try {
    const metadata = await lstat(selectedPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new BrightspaceError('INVALID_FILE', 'Select a regular file, not a directory, link or device.');
    }
    const canonicalPath = await realpath(selectedPath);
    const file = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 1 || before.size > MAX_FILE_BYTES) {
        throw new BrightspaceError('INVALID_FILE', 'Each submission file must contain between 1 byte and 25 MiB.');
      }
      // Read an explicit bound even if a file grows while its content is being read.
      const chunks: Buffer[] = [];
      let length = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - length));
        const result = await file.read(chunk, 0, chunk.length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
        if (length > MAX_FILE_BYTES) throw new BrightspaceError('INVALID_FILE', 'A submission file exceeds 25 MiB.');
        chunks.push(chunk.subarray(0, result.bytesRead));
      }
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== before.size) {
        throw new BrightspaceError('FILE_CHANGED', 'A selected file changed while being read. Prepare a new preview.');
      }
      const bytes = Buffer.concat(chunks);
      return { path: canonicalPath, filename, size: bytes.length, sha256: digest(bytes), bytes };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof BrightspaceError) throw error;
    throw new BrightspaceError('INVALID_FILE', 'A selected local file could not be read. Check its path and permissions.');
  }
}

async function snapshotFiles(paths: string[]): Promise<FileSnapshot[]> {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_FILES) {
    throw new BrightspaceError('INVALID_FILE', 'Select between 1 and 10 local files.');
  }
  const files: FileSnapshot[] = [], seenPaths = new Set<string>(), seenNames = new Set<string>();
  let total = 0;
  for (const path of paths) {
    const file = await snapshotFile(path);
    const identity = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    const filename = file.filename.toLowerCase();
    if (seenPaths.has(identity) || seenNames.has(filename)) {
      throw new BrightspaceError('INVALID_FILE', 'Each selected file must have a unique path and filename.');
    }
    total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new BrightspaceError('INVALID_FILE', 'The combined submission files exceed 50 MiB.');
    seenPaths.add(identity); seenNames.add(filename); files.push(file);
  }
  return files;
}

function filePreview(file: FileSnapshot): FilePreview {
  return { path: file.path, filename: file.filename, size: file.size, sha256: file.sha256 };
}

function warnings(folder: Row, previousCount: number): string[] {
  const result = ['Brightspace makes the final access decision, including any individual extensions and allowed file types.'];
  if (folder.submissionRule === 3) result.push('This assignment is configured to overwrite previous submissions.');
  if (folder.submissionRule === 4) result.push('This assignment allows only one submission; previous submissions: ' + previousCount + '.');
  if (folder.submissionRule == null) result.push('This API version does not expose the submission retention rule.');
  if (folder.isHidden === true) result.push('The assignment is marked hidden; Brightspace may refuse the submission.');
  if (folder.specialAccessOnly === true) result.push('The assignment is restricted to students with special access.');
  const now = Date.now();
  if (Date.parse(str(folder.startDate)) > now) result.push('The general availability start date is in the future.');
  if (Date.parse(str(folder.endDate)) < now) result.push('The general availability end date has passed; individual extensions may apply.');
  if (Date.parse(str(folder.dueDate)) < now) result.push('The general due date has passed; this may be recorded as late.');
  return result;
}

function multipart(files: FileSnapshot[], comments: string): { body: Buffer; contentType: string } {
  // D2L requires multipart/mixed, a RichText JSON first part, and an empty file-part name.
  // https://docs.valence.desire2learn.com/basic/fileupload.html
  let boundary: string;
  do { boundary = 'brightspace-' + randomBytes(24).toString('hex'); }
  while (files.some((file) => file.bytes.includes(boundary)) || comments.includes(boundary));
  const parts: Buffer[] = [Buffer.from('--' + boundary + '\r\nContent-Type: application/json\r\n\r\n'
    + JSON.stringify({ Text: comments, Html: null }) + '\r\n')];
  for (const file of files) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name=""; filename="' + file.filename
      + '"\r\nContent-Type: application/octet-stream\r\n\r\n'), file.bytes, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  return { body: Buffer.concat(parts), contentType: 'multipart/mixed; boundary=' + boundary };
}

export class SubmissionActions {
  private readonly pending = new Map<string, Pending>();
  private generation = 0;
  constructor(private readonly client: SubmissionTransport) {}

  private async accountId(): Promise<string> {
    const user = record(await this.client.json('lp', 'users/whoami'));
    const id = str(user.Identifier);
    if (!id) throw new BrightspaceError('AUTH_REQUIRED', 'The current Brightspace account could not be verified.');
    return id;
  }

  private async groupTarget(courseId: string, folderId: string, folder: Row, selectedGroupId?: string): Promise<GroupTarget | undefined> {
    const categoryId = folder.groupCategoryId == null ? undefined : str(folder.groupCategoryId);
    if (!categoryId) {
      if (selectedGroupId) throw new BrightspaceError('INVALID_GROUP_TARGET', 'This is an individual assignment. Prepare it without a group ID.');
      return undefined;
    }
    const result = await new StudentGroups(this.client).get(courseId, categoryId);
    const category = result.categories.find((item) => item.id === categoryId);
    const ownGroups = result.myGroups.filter((group) => group.categoryId === categoryId && group.courseId === courseId
      && group.complete && group.name.trim()).map((group) => ({ groupId: group.id, groupName: group.name,
        groupCategoryId: categoryId, groupCategoryName: category?.name ?? '' }));
    const details = { courseId, folderId, groupCategoryId: categoryId, ownGroups, membershipComplete: result.membershipComplete };
    if (!selectedGroupId) throw new BrightspaceError('GROUP_SELECTION_REQUIRED',
      'This assignment submits for a group. Select an exact verified own group ID, then prepare and review a group submission preview.', details);
    if (!result.membershipComplete || !category?.complete) throw new BrightspaceError('GROUP_MEMBERSHIP_UNVERIFIED',
      'Current group membership or target details could not be fully verified. No submission was prepared or sent.', details);
    const selected = ownGroups.find((group) => group.groupId === selectedGroupId);
    if (!selected) throw new BrightspaceError('GROUP_MEMBERSHIP_REQUIRED',
      'The selected group is not a verified current membership in this assignment group category.', details);
    return selected;
  }

  async prepare(courseId: string, folderId: string, paths: string[], comments = '', groupId?: string) {
    const generation = this.generation;
    courseId = numericId(courseId); folderId = numericId(folderId);
    if (groupId !== undefined) groupId = numericId(groupId);
    if (typeof comments !== 'string' || Buffer.byteLength(comments) > 20_000) {
      throw new BrightspaceError('INVALID_COMMENTS', 'Submission comments must be at most 20,000 UTF-8 bytes.');
    }
    for (const [token, pending] of this.pending) if (pending.expiresAt <= Date.now()) this.pending.delete(token);
    if (this.pending.size >= MAX_PENDING) throw new BrightspaceError('PREVIEW_LIMIT', 'Too many pending submissions. Confirm an existing preview or wait five minutes.');
    const base = courseId + '/dropbox/folders/' + folderId;
    const accountId = await this.accountId();
    const course = await resolveStudentCourse(this.client, courseId);
    const folder = folderSnapshot(await this.client.json('le', base), folderId);
    const group = await this.groupTarget(courseId, folderId, folder, groupId);
    const previous = readSubmissions(await this.client.json('le', base + '/submissions/mysubmissions/'), group?.groupId);
    const files = (await snapshotFiles(paths)).map(filePreview), expiresAt = Date.now() + PREVIEW_TTL_MS;
    const courseName = course.name, token = randomBytes(32).toString('base64url');
    const pending: Pending = { courseId, folderId, accountId, courseName, folder, comments, files,
      fingerprint: digest(JSON.stringify(folder)), previousIds: previous.map((item) => item.id).sort(), expiresAt, group };
    if (generation !== this.generation) throw new BrightspaceError('INVALID_PREVIEW', 'The session changed while preparing this submission. Prepare a new preview.');
    this.pending.set(token, pending);
    return {
      status: 'preview', confirmationToken: token, expiresAt: new Date(expiresAt).toISOString(),
      target: { courseId, courseName, folderId, assignmentName: folder.name, accountId, ...group },
      affectsGroup: Boolean(group),
      course: { id: course.id, name: course.name, code: course.code, url: course.url, metadataSource: course.metadataSource },
      files: files.map((file) => ({ ...file })), totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      comments, assignment: structuredClone(folder), previousSubmissionCount: previous.length,
      warnings: [...warnings(folder, previous.length), ...(group ? [
        'This submission affects all members of ' + group.groupName + ' (group ' + group.groupId + '). Retention and overwrite rules apply to the group assignment.',
        'Submission history is limited to what the current-user endpoint returns. Concurrent changes by other group members cannot be prevented.',
      ] : [])],
      confirmationRequired: 'Show the exact target, files, comments and warnings, including any group effects, to the user. Submit only after they explicitly approve this preview.',
    };
  }

  async confirm(token: string, confirmed = false) {
    const generation = this.generation;
    if (confirmed !== true) throw new BrightspaceError('CONFIRMATION_REQUIRED', 'The user must explicitly approve the prepared submission before confirmation.');
    const pending = this.pending.get(token);
    // Consume synchronously, before any I/O: concurrent confirmations cannot send twice.
    this.pending.delete(token);
    if (!pending || pending.expiresAt <= Date.now()) throw new BrightspaceError('INVALID_PREVIEW', 'This submission preview is expired, already used or unknown. Prepare a new preview.');
    const { courseId, folderId } = pending, base = courseId + '/dropbox/folders/' + folderId;
    if (await this.accountId() !== pending.accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The signed-in account changed. Prepare a new submission preview.');
    const folder = folderSnapshot(await this.client.json('le', base), folderId);
    if (digest(JSON.stringify(folder)) !== pending.fingerprint) {
      throw new BrightspaceError('PREVIEW_STALE', 'Assignment details changed after preview. Prepare and review a new preview.');
    }
    const group = await this.groupTarget(courseId, folderId, folder, pending.group?.groupId);
    if (JSON.stringify(group) !== JSON.stringify(pending.group)) {
      throw new BrightspaceError('PREVIEW_STALE', 'The group target changed after preview. Prepare and review a new group submission preview.');
    }
    const before = readSubmissions(await this.client.json('le', base + '/submissions/mysubmissions/'), group?.groupId);
    if (JSON.stringify(before.map((item) => item.id).sort()) !== JSON.stringify(pending.previousIds)) {
      throw new BrightspaceError('PREVIEW_STALE', 'Submission history changed after preview. Prepare and review a new preview.');
    }
    const files = await snapshotFiles(pending.files.map((file) => file.path));
    if (files.some((file, index) => JSON.stringify(filePreview(file)) !== JSON.stringify(pending.files[index]))) {
      throw new BrightspaceError('FILE_CHANGED', 'The selected files changed after preview. Prepare and review a new preview.');
    }
    if (pending.expiresAt <= Date.now()) throw new BrightspaceError('INVALID_PREVIEW', 'The submission preview expired during validation. Prepare a new preview.');
    if (generation !== this.generation) throw new BrightspaceError('INVALID_PREVIEW', 'The session changed while validating this submission. Prepare a new preview.');
    const payload = multipart(files, pending.comments);
    let result: { status: number; data: unknown };
    try {
      const endpoint = group ? base + '/submissions/group/' + group.groupId + '/' : base + '/submissions/mysubmissions/';
      result = await this.client.postMultipart('le', endpoint, payload.body, payload.contentType);
    } catch (error) {
      if (error instanceof BrightspaceError && error.code !== 'SUBMISSION_OUTCOME_UNKNOWN') throw error;
      throw new BrightspaceError('SUBMISSION_OUTCOME_UNKNOWN',
        'Brightspace may have received the files. Do not retry automatically. Check current-user submission history before preparing another attempt.',
        { courseId, folderId, ...group, attemptedFiles: pending.files.map(({ filename, size, sha256 }) => ({ filename, size, sha256 })) });
    }
    if (result.status !== 200) throw new BrightspaceError('SUBMISSION_OUTCOME_UNKNOWN',
      'Brightspace did not return its documented submission acceptance status. Check submission history before trying again.', { courseId, folderId, ...group, status: result.status });
    let receipt: Submission | undefined;
    try {
      const after = readSubmissions(await this.client.json('le', base + '/submissions/mysubmissions/'), group?.groupId);
      const signature = (items: { filename: string; size: number }[]) => JSON.stringify(items.map((item) => [item.filename, item.size]).sort());
      const candidates = after.filter((item) => !pending.previousIds.includes(item.id) && signature(item.files) === signature(files)
        && (!group || item.groupId === group.groupId && item.submittedById === pending.accountId));
      if (candidates.length === 1) receipt = candidates[0];
    } catch { /* HTTP 200 already confirms acceptance; a history read can fail independently. */ }
    return {
      status: 'accepted', target: { courseId, courseName: pending.courseName, folderId, assignmentName: pending.folder.name, accountId: pending.accountId, ...group },
      affectsGroup: Boolean(group),
      files: pending.files.map(({ filename, size, sha256 }) => ({ filename, size, sha256 })),
      httpStatus: result.status, acceptedAt: new Date().toISOString(), receipt: receipt ?? null,
      evidence: receipt ? 'Brightspace accepted the request and a matching new current-user submission was found.'
        : 'Brightspace returned HTTP 200 (submission accepted). A matching submission-history receipt could not yet be identified.',
    };
  }

  close(): void { this.generation++; this.pending.clear(); }
}
