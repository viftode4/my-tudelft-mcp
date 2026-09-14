import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BrightspaceError, safeError } from '../src/errors.js';
import { SubmissionActions, type SubmissionTransport } from '../src/submissions.js';
import { loadConfig } from '../src/config.js';

class FakeClient implements SubmissionTransport {
  config = loadConfig({});
  account = '17';
  courseError?: BrightspaceError;
  directEnrollmentError?: BrightspaceError;
  enrollment: unknown = { OrgUnit: { Id: 11, Name: 'Mechanics from enrollment', Code: 'ME101' }, Access: { CanAccess: true } };
  memberships: { items: unknown[]; complete: boolean } = { items: [], complete: true };
  groupCategory: Record<string, unknown> = { GroupCategoryId: 31, Name: 'Project teams', Groups: [41, 42], EnrollmentStyle: 3 };
  group: Record<string, unknown> = { GroupId: 41, Name: 'Team A', Code: 'A' };
  groupError?: Error;
  folder: Record<string, unknown> = {
    Id: 22, Name: 'Final report', DropboxType: 2, SubmissionType: 0, SubmissionRule: 2,
    IsHidden: false, Availability: null, DueDate: null, CustomInstructions: { Text: 'Upload your report.' },
  };
  submissions: unknown[] = [];
  posts: { product: string; path: string; body: Buffer; contentType: string }[] = [];
  calls: string[] = [];
  postError?: Error;
  status = 200;
  afterPost?: () => void;
  historyUnavailableAfterPost = false;

  async json(product: 'le' | 'lp', path: string): Promise<unknown> {
    this.calls.push(product + ':' + path);
    if (product === 'lp' && path === 'users/whoami') return { Identifier: this.account };
    if (product === 'lp' && path === 'courses/11') {
      if (this.courseError) throw this.courseError;
      return { Identifier: '11', Name: 'Mechanics', Code: 'ME101' };
    }
    if (product === 'lp' && path === 'enrollments/myenrollments/11') {
      if (this.directEnrollmentError) throw this.directEnrollmentError;
      return structuredClone(this.enrollment);
    }
    if (product === 'lp' && path === '11/groupcategories/31') return structuredClone(this.groupCategory);
    if (product === 'lp' && path === '11/groupcategories/31/groups/41/noenrollments') {
      if (this.groupError) throw this.groupError;
      return structuredClone(this.group);
    }
    if (product === 'le' && path === '11/dropbox/folders/22') return structuredClone(this.folder);
    if (product === 'le' && path === '11/dropbox/folders/22/submissions/mysubmissions/') {
      if (this.posts.length && this.historyUnavailableAfterPost) throw new Error('private session detail');
      return structuredClone(this.submissions);
    }
    throw new Error('Unexpected request: ' + product + ':' + path);
  }

  async list(product: 'le' | 'lp', path: string) {
    this.calls.push(product + ':' + path);
    if (product === 'lp' && path === 'enrollments/myenrollments/') return structuredClone(this.memberships);
    throw new Error('Unexpected list request: ' + product + ':' + path);
  }

  async postMultipart(product: 'le' | 'lp', path: string, body: Buffer, contentType: string) {
    this.posts.push({ product, path, body, contentType });
    if (this.postError) throw this.postError;
    this.afterPost?.();
    return { status: this.status, data: null };
  }
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'brightspace-submissions-'));
  t.after(async () => {
    // Cleanup is confined to this test's independently created temporary directory.
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'brightspace-submissions-'));
    await rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'report.txt');
  await writeFile(path, 'report content');
  const client = new FakeClient(), actions = new SubmissionActions(client);
  t.after(() => actions.close());
  return { dir, path, client, actions };
}

function enableGroup(client: FakeClient) {
  client.folder.DropboxType = 1;
  client.folder.GroupTypeId = 31;
  client.memberships.items = [{ OrgUnit: { Id: 41, Name: 'Team A', Code: 'A' } }];
}

function groupSubmission(id: number, groupId = 41, submittedBy = '17') {
  return { Entity: { EntityType: 'Group', EntityId: groupId }, Submissions: [{
    Id: id, SubmittedBy: { Id: submittedBy, DisplayName: 'Not returned' }, SubmissionDate: '2026-09-14T12:00:00Z',
    Files: [{ FileName: 'report.txt', Size: 14 }],
  }] };
}

test('submission preview identifies the account, exact assignment and file digest without uploading', async (t) => {
  const { path, client, actions } = await fixture(t);
  const preview = await actions.prepare('11', '22', [path], 'My final report');
  assert.equal(preview.status, 'preview');
  assert.deepEqual(preview.target, { courseId: '11', courseName: 'Mechanics', folderId: '22', assignmentName: 'Final report', accountId: '17' });
  assert.equal(preview.files[0]?.filename, 'report.txt');
  assert.equal(preview.files[0]?.size, 14);
  assert.equal(preview.files[0]?.sha256, createHash('sha256').update('report content').digest('hex'));
  assert.equal(preview.comments, 'My final report');
  assert.ok(Date.parse(preview.expiresAt) > Date.now());
  assert.equal(client.posts.length, 0);
});

test('submission confirmation requires explicit approval', async (t) => {
  const { path, client, actions } = await fixture(t);
  const preview = await actions.prepare('11', '22', [path]);
  await assert.rejects(actions.confirm(preview.confirmationToken), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(client.posts.length, 0);
  assert.equal((await actions.confirm(preview.confirmationToken, true)).status, 'accepted');
});

test('student previews use exact own enrollment when course details are forbidden', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.courseError = new BrightspaceError('PERMISSION_DENIED', 'Course details are unavailable.');
  const preview = await actions.prepare('11', '22', [path]);
  assert.equal(preview.target.courseName, 'Mechanics from enrollment');
  assert.deepEqual(preview.course, { id: '11', name: 'Mechanics from enrollment', code: 'ME101',
    url: 'https://brightspace.tudelft.nl/d2l/home/11', metadataSource: 'my_enrollments' });
  assert.equal(client.posts.length, 0);
  assert.ok(!client.calls.includes('lp:enrollments/myenrollments/'));
});

test('student preview fallback refuses absent or incomplete course membership instead of guessing the target', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.courseError = new BrightspaceError('PERMISSION_DENIED', 'Course details are unavailable.');
  client.directEnrollmentError = new BrightspaceError('NOT_FOUND', 'The enrollment is unavailable.');
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'PERMISSION_DENIED' });
  client.memberships.complete = false;
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'PAGINATION_ERROR' });
  client.memberships.items = [client.enrollment];
  const preview = await actions.prepare('11', '22', [path]);
  assert.equal(preview.target.courseName, 'Mechanics from enrollment');
  assert.equal(client.posts.length, 0);
});

test('student preview fallback requires matching enrollment identity, access and exact metadata', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.courseError = new BrightspaceError('PERMISSION_DENIED', 'Course details are unavailable.');
  client.enrollment = { OrgUnit: { Id: 12, Name: 'A different course', Code: 'ME102' } };
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'API_FORMAT_CHANGED' });
  client.enrollment = { OrgUnit: { Id: 11, Name: 'Mechanics', Code: 'ME101' }, Access: { CanAccess: false } };
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'PERMISSION_DENIED' });
  client.enrollment = { OrgUnit: { Id: 11 }, Access: { CanAccess: true } };
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'API_FORMAT_CHANGED' });
  assert.equal(client.posts.length, 0);
});

test('confirmed submission uses D2L multipart/mixed JSON then exact file bytes and a verified receipt', async (t) => {
  const { dir, path, client, actions } = await fixture(t);
  const binaryPath = join(dir, 'diagram.bin'), binary = Buffer.from([0, 255, 1, 13, 10, 128]);
  await writeFile(binaryPath, binary);
  client.afterPost = () => { client.submissions = [{ Entity: { EntityId: 17 }, Submissions: [{
    Id: 999, SubmissionDate: '2026-09-14T12:00:00Z',
    Files: [{ FileName: 'diagram.bin', Size: 6 }, { FileName: 'report.txt', Size: 14 }],
  }] }]; };
  const preview = await actions.prepare('11', '22', [path, binaryPath], 'Ready!\r\nThanks.');
  const result = await actions.confirm(preview.confirmationToken, true);
  assert.equal(client.posts.length, 1);
  const post = client.posts[0]!;
  assert.equal(post.product, 'le');
  assert.equal(post.path, '11/dropbox/folders/22/submissions/mysubmissions/');
  assert.match(post.contentType, /^multipart\/mixed; boundary=/);
  const boundary = post.contentType.split('boundary=')[1]!;
  assert.ok(post.body.toString().startsWith('--' + boundary + '\r\nContent-Type: application/json\r\n\r\n'
    + JSON.stringify({ Text: 'Ready!\r\nThanks.', Html: null }) + '\r\n'));
  assert.ok(post.body.includes('Content-Disposition: form-data; name=""; filename="report.txt"\r\n'));
  assert.ok(post.body.includes('report content'));
  assert.ok(post.body.includes(binary));
  assert.ok(post.body.toString().endsWith('--' + boundary + '--\r\n'));
  assert.equal(result.receipt?.id, '999');
  assert.equal(result.httpStatus, 200);
  assert.match(result.evidence, /matching new current-user submission/);
});

test('concurrent confirmation consumes the token synchronously and sends once', async (t) => {
  const { path, client, actions } = await fixture(t);
  const preview = await actions.prepare('11', '22', [path]);
  const outcomes = await Promise.allSettled([
    actions.confirm(preview.confirmationToken, true), actions.confirm(preview.confirmationToken, true),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(client.posts.length, 1);
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
});

test('changed files with the same size cannot pass the preview hash', async (t) => {
  const { path, client, actions } = await fixture(t);
  const preview = await actions.prepare('11', '22', [path]);
  await writeFile(path, 'CHANGEDCONTENT');
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'FILE_CHANGED' });
  assert.equal(client.posts.length, 0);
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
});

test('mutating returned preview objects does not alter the pending upload', async (t) => {
  const { path, actions } = await fixture(t);
  const preview = await actions.prepare('11', '22', [path]);
  preview.files[0]!.sha256 = 'tampered';
  preview.assignment.name = 'Another assignment';
  const result = await actions.confirm(preview.confirmationToken, true);
  assert.equal(result.target.assignmentName, 'Final report');
  assert.notEqual(result.files[0]!.sha256, 'tampered');
});

test('expired previews and logout invalidation cannot submit', async (t) => {
  const { path, client, actions } = await fixture(t);
  const preview = await actions.prepare('11', '22', [path]);
  t.mock.method(Date, 'now', () => Date.parse(preview.expiresAt) + 1);
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  t.mock.restoreAll();
  const second = await actions.prepare('11', '22', [path]);
  actions.close();
  await assert.rejects(actions.confirm(second.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  assert.equal(client.posts.length, 0);
});

test('account changes block a prepared submission', async (t) => {
  const { path, client, actions } = await fixture(t);
  const preview = await actions.prepare('11', '22', [path]);
  client.account = '99';
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'ACCOUNT_CHANGED' });
  assert.equal(client.posts.length, 0);
});

test('logout during preflight prevents a pending confirmation from uploading', async (t) => {
  const { path, client, actions } = await fixture(t);
  const preview = await actions.prepare('11', '22', [path]);
  const originalJson = client.json.bind(client);
  t.mock.method(client, 'json', async (product: 'lp' | 'le', resource: string) => {
    const result = await originalJson(product, resource);
    if (resource === 'users/whoami') actions.close();
    return result;
  });
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  assert.equal(client.posts.length, 0);
});

test('changed assignment rules and submission history require another preview', async (t) => {
  const { path, client, actions } = await fixture(t);
  const preview = await actions.prepare('11', '22', [path]);
  client.folder.SubmissionRule = 3;
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'PREVIEW_STALE' });
  const second = await actions.prepare('11', '22', [path]);
  client.submissions = [{ Submissions: [{ Id: 7, Files: [] }] }];
  await assert.rejects(actions.confirm(second.confirmationToken, true), { code: 'PREVIEW_STALE' });
  assert.equal(client.posts.length, 0);
});

test('past general dates produce warnings without denying possible special access', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.folder.Availability = { EndDate: '2020-01-01T00:00:00Z' };
  client.folder.DueDate = '2020-01-01T00:00:00Z';
  client.folder.AllowOnlyUsersWithSpecialAccess = true;
  client.folder.SubmissionRule = 3;
  const preview = await actions.prepare('11', '22', [path]);
  assert.ok(preview.warnings.some((item) => item.includes('end date has passed')));
  assert.ok(preview.warnings.some((item) => item.includes('special access')));
  assert.ok(preview.warnings.some((item) => item.includes('overwrite')));
  assert.equal((await actions.confirm(preview.confirmationToken, true)).status, 'accepted');
});

test('non-file and group assignments cannot accidentally use individual submission', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.folder.SubmissionType = 1;
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'UNSUPPORTED_SUBMISSION' });
  client.folder.SubmissionType = 0;
  enableGroup(client);
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'GROUP_SELECTION_REQUIRED' });
  assert.equal(client.posts.length, 0);
});

test('group assignment selection lists only verified own groups in the exact assignment category', async (t) => {
  const { path, client, actions } = await fixture(t);
  enableGroup(client);
  client.memberships.items.push({ OrgUnit: { Id: 99, Name: 'Another category group' } });
  await assert.rejects(actions.prepare('11', '22', [path]), (error: unknown) => {
    assert.ok(error instanceof BrightspaceError);
    assert.equal(error.code, 'GROUP_SELECTION_REQUIRED');
    assert.deepEqual(error.details?.ownGroups, [{ groupId: '41', groupName: 'Team A',
      groupCategoryId: '31', groupCategoryName: 'Project teams' }]);
    assert.equal(error.details?.membershipComplete, true);
    return true;
  });
  assert.equal(client.posts.length, 0);
  assert.ok(!client.calls.some((call) => call.includes('/groups/42') || call.includes('/groups/99')));
});

test('group previews bind the exact target despite returned-object mutation and send the group route with an own receipt', async (t) => {
  const { path, client, actions } = await fixture(t);
  enableGroup(client);
  client.afterPost = () => { client.submissions = [groupSubmission(999)]; };
  const preview = await actions.prepare('11', '22', [path], 'Group report', '41');
  assert.equal(preview.affectsGroup, true);
  assert.equal(preview.target.groupId, '41');
  assert.equal(preview.target.groupName, 'Team A');
  assert.equal(preview.target.groupCategoryId, '31');
  assert.ok(preview.warnings.some((warning) => warning.includes('affects all members of Team A')));
  preview.target.groupId = '42';
  preview.target.groupName = 'Changed display';
  preview.assignment.groupCategoryId = '99';
  const result = await actions.confirm(preview.confirmationToken, true);
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0]?.path, '11/dropbox/folders/22/submissions/group/41/');
  assert.match(client.posts[0]!.contentType, /^multipart\/mixed; boundary=/);
  assert.ok(client.posts[0]!.body.includes('report content'));
  assert.equal(result.target.groupId, '41');
  assert.equal(result.target.groupName, 'Team A');
  assert.equal(result.affectsGroup, true);
  assert.equal(result.receipt?.id, '999');
  assert.equal(result.receipt?.groupId, '41');
  assert.equal(result.receipt?.submittedById, '17');
  assert.ok(!JSON.stringify(result).includes('Not returned'));
});

test('unowned groups, wrong categories and group IDs on individual assignments cannot prepare an upload', async (t) => {
  const { path, client, actions } = await fixture(t);
  await assert.rejects(actions.prepare('11', '22', [path], '', '41'), { code: 'INVALID_GROUP_TARGET' });
  enableGroup(client);
  await assert.rejects(actions.prepare('11', '22', [path], '', '../41'), { code: 'INVALID_ID' });
  await assert.rejects(actions.prepare('11', '22', [path], '', '42'), { code: 'GROUP_MEMBERSHIP_REQUIRED' });
  client.memberships.items.push({ OrgUnit: { Id: 99, Name: 'Other-category group' } });
  await assert.rejects(actions.prepare('11', '22', [path], '', '99'), { code: 'GROUP_MEMBERSHIP_REQUIRED' });
  client.groupCategory.GroupCategoryId = 32;
  await assert.rejects(actions.prepare('11', '22', [path], '', '41'), { code: 'GROUP_MEMBERSHIP_UNVERIFIED' });
  assert.equal(client.posts.length, 0);
});

test('loss of group membership during confirmation prevents upload and consumes the approval token', async (t) => {
  const { path, client, actions } = await fixture(t);
  enableGroup(client);
  const preview = await actions.prepare('11', '22', [path], '', '41');
  client.memberships.items = [];
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'GROUP_MEMBERSHIP_REQUIRED' });
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  assert.equal(client.posts.length, 0);
});

test('incomplete membership or unreadable group details prevent group submission previews', async (t) => {
  const { path, client, actions } = await fixture(t);
  enableGroup(client);
  client.memberships.complete = false;
  await assert.rejects(actions.prepare('11', '22', [path], '', '41'), { code: 'GROUP_MEMBERSHIP_UNVERIFIED' });
  client.memberships.complete = true;
  client.groupError = new BrightspaceError('PERMISSION_DENIED', 'Group details unavailable.');
  await assert.rejects(actions.prepare('11', '22', [path], '', '41'), { code: 'GROUP_MEMBERSHIP_UNVERIFIED' });
  assert.equal(client.posts.length, 0);
});

test('changed group names, assignment group categories and group history require a new preview', async (t) => {
  const { path, client, actions } = await fixture(t);
  enableGroup(client);
  const preview = await actions.prepare('11', '22', [path], '', '41');
  client.group.Name = 'New team name';
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'PREVIEW_STALE' });
  const second = await actions.prepare('11', '22', [path], '', '41');
  client.folder.GroupTypeId = 32;
  await assert.rejects(actions.confirm(second.confirmationToken, true), { code: 'PREVIEW_STALE' });
  client.folder.GroupTypeId = 31;
  const third = await actions.prepare('11', '22', [path], '', '41');
  client.submissions = [groupSubmission(501)];
  await assert.rejects(actions.confirm(third.confirmationToken, true), { code: 'PREVIEW_STALE' });
  assert.equal(client.posts.length, 0);
});

test('group confirmation requires explicit approval, handles concurrent replay once and never retries uncertainty', async (t) => {
  const { path, client, actions } = await fixture(t);
  enableGroup(client);
  const preview = await actions.prepare('11', '22', [path], '', '41');
  await assert.rejects(actions.confirm(preview.confirmationToken), { code: 'CONFIRMATION_REQUIRED' });
  client.postError = new Error('Network ambiguity containing private token');
  const results = await Promise.allSettled([
    actions.confirm(preview.confirmationToken, true), actions.confirm(preview.confirmationToken, true),
  ]);
  const codes = results.map((result) => result.status === 'rejected' ? safeError(result.reason).code : 'accepted').sort();
  assert.deepEqual(codes, ['INVALID_PREVIEW', 'SUBMISSION_OUTCOME_UNKNOWN']);
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0]?.path, '11/dropbox/folders/22/submissions/group/41/');
});

test('group receipts require the selected group and current submitting account', async (t) => {
  const { path, client, actions } = await fixture(t);
  enableGroup(client);
  client.afterPost = () => { client.submissions = [groupSubmission(701, 42), groupSubmission(702, 41, '18')]; };
  const preview = await actions.prepare('11', '22', [path], '', '41');
  const result = await actions.confirm(preview.confirmationToken, true);
  assert.equal(result.status, 'accepted');
  assert.equal(result.receipt, null);
  assert.match(result.evidence, /could not yet be identified/);
  assert.ok(!JSON.stringify(result).includes('submittedById'));
});

test('unidentified group history and inconsistent assignment group metadata cannot be approved', async (t) => {
  const { path, client, actions } = await fixture(t);
  enableGroup(client);
  client.submissions = [{ Submissions: [{ Id: 901, Files: [] }] }];
  await assert.rejects(actions.prepare('11', '22', [path], '', '41'), { code: 'API_FORMAT_CHANGED' });
  client.submissions = [];
  client.folder.GroupTypeId = null;
  await assert.rejects(actions.prepare('11', '22', [path], '', '41'), { code: 'API_FORMAT_CHANGED' });
  client.folder.DropboxType = 2;
  client.folder.GroupTypeId = 31;
  await assert.rejects(actions.prepare('11', '22', [path], '', '41'), { code: 'API_FORMAT_CHANGED' });
  assert.equal(client.posts.length, 0);
});

test('invalid targets, nonlocal paths, duplicate names, directories, empty and oversized files are rejected', async (t) => {
  const { path, dir, actions, client } = await fixture(t);
  await assert.rejects(actions.prepare('../11', '22', [path]), { code: 'INVALID_ID' });
  for (const files of [[], ['https://example.com/report.txt'], ['relative.txt'], ['\\\\server\\report.txt'], [dir], Array(11).fill(path)]) {
    await assert.rejects(actions.prepare('11', '22', files), { code: 'INVALID_FILE' });
  }
  await assert.rejects(actions.prepare('11', '22', [path, path]), { code: 'INVALID_FILE' });
  await mkdir(join(dir, 'other'));
  const duplicate = join(dir, 'other', 'report.txt');
  await writeFile(duplicate, 'other');
  await assert.rejects(actions.prepare('11', '22', [path, duplicate]), { code: 'INVALID_FILE' });
  await writeFile(path, '');
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'INVALID_FILE' });
  await writeFile(path, Buffer.alloc(25 * 1024 * 1024 + 1));
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'INVALID_FILE' });
  assert.equal(client.posts.length, 0);
});

test('unfamiliar assignment and submission history never produce an upload preview', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.folder.Id = 23;
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'API_FORMAT_CHANGED' });
  client.folder.Id = 22;
  client.submissions = [{ unexpected: [] }];
  await assert.rejects(actions.prepare('11', '22', [path]), { code: 'API_FORMAT_CHANGED' });
});

test('transport uncertainty is sanitized, never retried and consumes the token', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.postError = new Error('Network request failed Cookie: private-token');
  const preview = await actions.prepare('11', '22', [path]);
  await assert.rejects(actions.confirm(preview.confirmationToken, true), (error: unknown) => {
    assert.equal(safeError(error).code, 'SUBMISSION_OUTCOME_UNKNOWN');
    assert.ok(!JSON.stringify(safeError(error)).includes('private-token'));
    assert.match(safeError(error).message, /Do not retry automatically/);
    return true;
  });
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  assert.equal(client.posts.length, 1);
});

test('definitive server rejection is preserved and not retried', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.postError = new BrightspaceError('PERMISSION_DENIED', 'Brightspace refused this submission.', { status: 403 });
  const preview = await actions.prepare('11', '22', [path]);
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'PERMISSION_DENIED' });
  assert.equal(client.posts.length, 1);
});

test('HTTP acceptance is accurately distinguished from an unavailable history receipt', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.historyUnavailableAfterPost = true;
  const preview = await actions.prepare('11', '22', [path]);
  const result = await actions.confirm(preview.confirmationToken, true);
  assert.equal(result.status, 'accepted');
  assert.equal(result.receipt, null);
  assert.match(result.evidence, /could not yet be identified/);
  assert.ok(!JSON.stringify(result).includes('private session detail'));
});

test('unexpected successful statuses are not reported as a submission receipt', async (t) => {
  const { path, client, actions } = await fixture(t);
  client.status = 202;
  const preview = await actions.prepare('11', '22', [path]);
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'SUBMISSION_OUTCOME_UNKNOWN' });
  assert.equal(client.posts.length, 1);
});
