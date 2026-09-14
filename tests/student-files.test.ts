import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StudentFiles, type StudentFileTransport } from '../src/student-files.js';
import { BrightspaceError } from '../src/errors.js';

const origin = 'https://brightspace.example';
class Client implements StudentFileTransport {
  accountId: string | undefined = '17';
  payloads = new Map<string, unknown>();
  reads: string[] = [];
  downloads: string[] = [];
  bytes = Buffer.from('Synthetic attachment text.');
  contentType = 'text/plain';
  afterJson?: () => void;
  afterDownload?: () => void;
  sessionIdentity = async () => this.accountId;
  json = async (_product: 'lp' | 'le', path: string): Promise<unknown> => {
    this.reads.push(path);
    const payload = this.payloads.get(path);
    this.afterJson?.();
    return payload;
  };
  apiUrl = async (_product: 'lp' | 'le', path: string) => origin + '/d2l/api/le/1.99/' + path;
  download = async (url: string) => {
    this.downloads.push(url); this.afterDownload?.();
    return { bytes: this.bytes, contentType: this.contentType, filename: 'untrusted-redirect-name.txt', url };
  };
}
const history = '100/dropbox/folders/200/submissions/mysubmissions/';
function owned(overrides: Record<string, unknown> = {}) {
  return { Entity: { EntityId: 17, EntityType: 'User' },
    Submissions: [{ Id: 300, Files: [{ FileId: 400, FileName: 'submitted.txt', Size: 26 }] }],
    Feedback: { IsGraded: true, Files: [{ FileId: 500, FileName: 'feedback.txt', Size: 26 }] }, ...overrides };
}
function helper(client: Client, dataDir = join(tmpdir(), 'brightspace-unused-student-file-directory')) {
  return new StudentFiles(client, { baseUrl: origin, dataDir });
}

test('announcement download is bound to metadata and ignores arbitrary attachment URLs', async () => {
  const client = new Client();
  client.payloads.set('100/news/200', { Id: 200, IsPublished: true,
    Attachments: [{ FileId: 400, FileName: '../lecture.txt', FileSize: 26, Url: 'https://external.invalid/?access_token=private' }] });
  const result = await helper(client).announcement('100', '200', '400', { offset: 10, maxChars: 5 });
  assert.deepEqual(client.reads, ['100/news/200']);
  assert.deepEqual(client.downloads, [origin + '/d2l/api/le/1.99/100/news/200/attachments/400']);
  assert.equal(result.filename, 'lecture.txt');
  assert.equal(result.text, 'attac');
  assert.equal(result.nextOffset, 15);
  assert.equal(result.declaredBytes, 26);
  assert.equal(result.localPath, undefined);
  assert.ok(!JSON.stringify(result).includes('access_token'));
  assert.equal((result.provenance as Record<string, unknown>).membership, 'announcement_attachment_metadata');
  client.downloads = [];
  await assert.rejects(helper(client).announcement('100', '200', '999'), { code: 'NOT_FOUND' });
  assert.deepEqual(client.downloads, []);
});

test('hidden, unpublished, malformed and mismatched announcements never download', async () => {
  const client = new Client();
  for (const [payload, code] of [
    [{ Id: 201, Attachments: [] }, 'API_FORMAT_CHANGED'],
    [{ Id: 200, IsHidden: true, Attachments: [{ FileId: 400, FileName: 'a.txt' }] }, 'NOT_FOUND'],
    [{ Id: 200, IsPublished: false, Attachments: [{ FileId: 400, FileName: 'a.txt' }] }, 'NOT_FOUND'],
    [{ Id: 200, Attachments: 'unexpected' }, 'API_FORMAT_CHANGED'],
    [{ Id: 200, Attachments: [{ FileId: 400, FileName: 'a.txt' }, { FileId: 400, FileName: 'b.txt' }] }, 'API_FORMAT_CHANGED'],
  ] as const) {
    client.payloads.set('100/news/200', payload);
    await assert.rejects(helper(client).announcement('100', '200', '400'), { code });
  }
  assert.deepEqual(client.downloads, []);
});

test('submitted files must belong to the exact own submission and folder', async () => {
  const client = new Client();
  client.payloads.set(history, [owned({ Submissions: [
    { Id: 300, Files: [{ FileId: 400, FileName: 'submitted.txt' }] },
    { Id: 301, Files: [{ FileId: 401, FileName: 'other.txt' }] },
  ] })]);
  const result = await helper(client).submission('100', '200', '300', '400');
  assert.equal(result.kind, 'submission_file');
  assert.equal(result.submissionId, '300');
  assert.deepEqual(client.downloads, [origin + '/d2l/api/le/1.99/100/dropbox/folders/200/submissions/300/files/400']);
  client.downloads = [];
  await assert.rejects(helper(client).submission('100', '200', '300', '401'), { code: 'NOT_FOUND' });
  await assert.rejects(helper(client).submission('100', '200', '999', '400'), { code: 'NOT_FOUND' });
  client.payloads.set('100/dropbox/folders/201/submissions/mysubmissions/', []);
  await assert.rejects(helper(client).submission('100', '201', '300', '400'), { code: 'NOT_FOUND' });
  assert.deepEqual(client.downloads, []);
});

test('another user entity is refused; a group is accepted only through own history', async () => {
  const client = new Client();
  client.payloads.set(history, [owned({ Entity: { EntityId: 18, EntityType: 'User' } })]);
  await assert.rejects(helper(client).submission('100', '200', '300', '400'), { code: 'OWNERSHIP_UNVERIFIED' });
  await assert.rejects(helper(client).feedback('100', '200', '500'), { code: 'OWNERSHIP_UNVERIFIED' });
  assert.deepEqual(client.downloads, []);
  client.payloads.set(history, [owned({ Entity: { EntityId: 72, EntityType: 'Group' } })]);
  const result = await helper(client).feedback('100', '200', '500');
  assert.equal((result.provenance as Record<string, unknown>).entityType, 'group');
  assert.equal((result.provenance as Record<string, unknown>).entityId, '72');
  assert.equal(client.downloads[0], origin + '/d2l/api/le/1.99/100/dropbox/folders/200/feedback/group/72/attachments/500');
  assert.ok(client.reads.every((path) => path === history));
});

test('feedback requires published exact-file metadata and does not guess an entity route', async () => {
  const client = new Client();
  client.payloads.set(history, [owned()]);
  const result = await helper(client).feedback('100', '200', '500');
  assert.equal(result.kind, 'feedback_attachment');
  assert.equal(client.downloads[0], origin + '/d2l/api/le/1.99/100/dropbox/folders/200/feedback/user/17/attachments/500');
  client.downloads = [];
  for (const feedback of [{ IsGraded: false, Files: [{ FileId: 500, FileName: 'draft.txt' }] }, null, { Files: [{ FileId: 500, FileName: 'unknown.txt' }] }]) {
    client.payloads.set(history, [owned({ Feedback: feedback })]);
    await assert.rejects(helper(client).feedback('100', '200', '500'), { code: 'NOT_FOUND' });
  }
  client.payloads.set(history, [owned(), owned({ Entity: { EntityId: 72, EntityType: 'Group' } })]);
  await assert.rejects(helper(client).feedback('100', '200', '500'), { code: 'API_FORMAT_CHANGED' });
  assert.deepEqual(client.downloads, []);
});

test('identity changes abort before download or returning potentially mixed-account content', async () => {
  const client = new Client();
  client.payloads.set(history, [owned()]);
  client.afterJson = () => { client.accountId = '18'; };
  await assert.rejects(helper(client).submission('100', '200', '300', '400'), { code: 'ACCOUNT_CHANGED' });
  assert.deepEqual(client.downloads, []);
  client.accountId = '17'; client.afterJson = undefined;
  client.afterDownload = () => { client.accountId = '18'; };
  await assert.rejects(helper(client).submission('100', '200', '300', '400'), { code: 'ACCOUNT_CHANGED' });
});

test('invalid IDs and ranges are rejected before authenticated requests', async () => {
  const client = new Client(), files = helper(client);
  await assert.rejects(files.announcement('100/../users', '200', '400'), { code: 'INVALID_ID' });
  await assert.rejects(files.submission('100', '200', '300', '400', { offset: -1 }), { code: 'INVALID_RANGE' });
  await assert.rejects(files.feedback('100', '200', '500', { maxChars: 50_001 }), { code: 'INVALID_RANGE' });
  client.accountId = undefined;
  await assert.rejects(files.announcement('100', '200', '400'), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(client.reads, []);
  assert.deepEqual(client.downloads, []);
});

test('optional downloads preserve raw bytes when extraction fails and stay account-scoped', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-student-files-'));
  assert.equal(dirname(directory), tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new Client();
  client.bytes = Buffer.from('This is a damaged synthetic PDF.');
  client.contentType = 'application/pdf';
  client.payloads.set('100/news/200', { Id: 200, Attachments: [{ FileId: 400, FileName: '../../broken.pdf', Size: client.bytes.length }] });
  const result = await helper(client, directory).announcement('100', '200', '400', { download: true });
  assert.equal(result.complete, false);
  assert.equal(result.text, '');
  assert.equal((result.extractionError as Record<string, unknown>).code, 'DOCUMENT_PARSE_FAILED');
  assert.deepEqual(await readFile(String(result.localPath)), client.bytes);
  assert.ok(String(result.localPath).startsWith(join(directory, 'downloads')));
  assert.equal((await readdir(directory)).length, 1);
});

test('file access denial propagates without a guessed fallback or retry', async () => {
  const client = new Client();
  client.payloads.set(history, [owned()]);
  client.download = async (url: string) => { client.downloads.push(url); throw new BrightspaceError('DOWNLOAD_FAILED', 'Access denied.', { status: 403 }); };
  await assert.rejects(helper(client).feedback('100', '200', '500'), { code: 'DOWNLOAD_FAILED', details: { status: 403 } });
  assert.equal(client.downloads.length, 1);
});

test('extracted URL text is redacted before reaching the assistant', async () => {
  const client = new Client();
  client.payloads.set(history, [owned()]);
  client.bytes = Buffer.from('See https://brightspace.example/feedback?courseCode=CS100&access_token=private#fragment');
  const result = await helper(client).submission('100', '200', '300', '400');
  assert.match(String(result.text), /courseCode=CS100/);
  assert.ok(!String(result.text).includes('private'));
});


test('student file indexing gets full sanitized text and exact owned resource identity before chunking', async () => {
  const client = new Client();
  client.payloads.set(history, [owned()]);
  client.bytes = Buffer.from('First part. See https://school.example/resource?token=private&course=100 then remaining lecture material.');
  const indexed: unknown[][] = [];
  const files = new StudentFiles(client, {baseUrl: origin, dataDir: join(tmpdir(), 'unused-cache-test')},
    async (...args) => { indexed.push(args); });
  const result = await files.submission('100', '200', '300', '400', { maxChars: 5 });
  assert.equal(result.text, 'First');
  assert.equal(result.indexed, true);
  assert.equal(indexed[0]?.[0], '17');
  const doc = indexed[0]?.[1] as Record<string, string>;
  assert.equal(doc.id, '100:submission_file:200:300:400');
  assert.equal(doc.kind, 'submission_file');
  assert.match(doc.text!, /remaining lecture material/);
  assert.ok(!doc.text!.includes('private'));
});

test('failed local indexing keeps the readable file but account changes still abort it', async () => {
  const client = new Client();
  client.payloads.set(history, [owned()]);
  const files = new StudentFiles(client, {baseUrl: origin, dataDir: join(tmpdir(), 'unused-cache-test')},
    async () => { throw new Error('private file system diagnostic'); });
  const result = await files.feedback('100', '200', '500');
  assert.equal(result.indexed, false);
  assert.equal((result.indexError as any).code, 'INTERNAL_ERROR');
  assert.ok(String(result.text).length > 0);
  assert.ok(!JSON.stringify(result).includes('private file system diagnostic'));
  const switched = new StudentFiles(client, {baseUrl: origin, dataDir: join(tmpdir(), 'unused-cache-test')},
    async () => { client.accountId = '18'; });
  await assert.rejects(switched.feedback('100', '200', '500'), {code: 'ACCOUNT_CHANGED'});
});
