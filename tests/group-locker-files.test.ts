import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupLockerFiles, type GroupLockerTransport } from '../src/group-locker-files.js';
import { BrightspaceError } from '../src/errors.js';
import type { IndexedDocument } from '../src/library.js';
import { record, type Row } from '../src/util.js';

const origin = 'https://brightspace.example', root = '100/locker/group/300/';
class Client implements GroupLockerTransport {
  config = { baseUrl: origin, catalogUrl: origin, dataDir: join(tmpdir(), 'unused-locker-test'), timeoutMs: 1_000, maxFileBytes: 50 * 1024 * 1024 };
  accountId: string | undefined = '17';
  payloads = new Map<string, unknown>();
  calls: string[] = [];
  downloads: string[] = [];
  bytes = Buffer.from('Synthetic shared group notes.');
  contentType = 'text/plain';
  redirect?: string;
  afterJson?: () => void;
  afterDownload?: () => void;
  sessionIdentity = async () => this.accountId;
  list = async (_product: 'lp' | 'le', path: string) => {
    this.calls.push(path);
    if (path === '100/groupcategories/') return { items: [{ GroupCategoryId: 200, Name: 'Project', Groups: [300, 301], EnrollmentStyle: 0 }], complete: true };
    if (path === 'enrollments/myenrollments/') return { items: [{ OrgUnit: { Id: 300, Name: 'Our group', Code: 'G1' } }], complete: true };
    return { items: [], complete: true };
  };
  json = async (_product: 'lp' | 'le', path: string) => {
    this.calls.push(path); this.afterJson?.();
    if (path === '100/groupcategories/200/groups/300/noenrollments') return { GroupId: 300, Name: 'Our group', Code: 'G1' };
    const value = this.payloads.get(path);
    if (value instanceof Error) throw value;
    return value;
  };
  apiUrl = async (_product: 'lp' | 'le', path: string) => origin + '/d2l/api/le/1.99/' + path;
  download = async (url: string) => {
    this.downloads.push(url); this.afterDownload?.();
    return { bytes: this.bytes, contentType: this.contentType, filename: 'untrusted-name.txt', url: this.redirect ?? url };
  };
}
function file(name = 'notes.txt', size: number | null = 29): Row { return { Name: name, Type: 1, Size: size, Description: 'Shared notes', LastModified: '2026-09-01T12:00:00Z' }; }
function fixture() { const client = new Client(); client.payloads.set(root, [file()]); return client; }

test('lists the observed array shape with exact file paths and bounded direct-folder pagination', async () => {
  const client = fixture(); client.payloads.set(root, [file(), { Name: 'Folder', Type: 0, Size: null }, file('extra.txt')]);
  const result = await new GroupLockerFiles(client).list('100', '300', { startAt: 1, maxItems: 1 });
  assert.deepEqual((result.items as Row[]).map(item => ({ path: item.path, type: item.type })), [{ path: '/Folder/', type: 'folder' }]);
  assert.equal(result.nextStartAt, 2); assert.equal(result.complete, false);
  assert.equal(result.membershipVerified, true);
  assert.equal((record(result.provenance)).membership, 'own_group_enrollment');
  assert.deepEqual(client.downloads, []);
  assert.ok(client.calls.every(path => !/groups\/\d+\/enrollments$|classlist|roster/.test(path)));
});

test('nested folder and exact file membership are verified before an encoded streaming route is requested', async () => {
  const client = fixture();
  client.payloads.set(root, [{ Name: 'Shared folder', Type: 0, Size: null }]);
  client.payloads.set(root + 'Shared%20folder/', { Name: 'Shared folder', Contents: [{ ...file('group notes.txt'), Url: 'https://external.invalid/stolen?token=secret' }] });
  const result = await new GroupLockerFiles(client).read('100', '300', '/Shared folder/group notes.txt', { offset: 10, maxChars: 6 });
  assert.deepEqual(client.calls.slice(-2), [root, root + 'Shared%20folder/']);
  assert.deepEqual(client.downloads, [origin + '/d2l/api/le/1.99/' + root + 'Shared%20folder/group%20notes.txt']);
  assert.equal(result.filePath, '/Shared folder/group notes.txt');
  assert.equal(result.filename, 'group notes.txt');
  assert.equal(result.text, 'shared');
  assert.equal(result.nextOffset, 16);
  assert.equal(record(result.provenance).verifiedAncestorFolders, 1);
  assert.ok(!JSON.stringify(result).includes('external.invalid'));
});

test('peer groups and a group in a different course never reach a locker endpoint', async () => {
  const client = fixture(), reader = new GroupLockerFiles(client);
  await assert.rejects(reader.read('100', '301', '/notes.txt'), { code: 'PERMISSION_DENIED' });
  await assert.rejects(reader.list('101', '300'), { code: 'PERMISSION_DENIED' });
  assert.ok(!client.calls.some(path => path.includes('/locker/')));
  assert.deepEqual(client.downloads, []);
});

test('unlisted ancestors, missing files, and folder-as-file requests cannot download arbitrary paths', async () => {
  const client = fixture(), reader = new GroupLockerFiles(client);
  for (const path of ['/missing.txt', '/NotListed/private.txt']) await assert.rejects(reader.read('100', '300', path), { code: 'NOT_FOUND' });
  client.payloads.set(root, [{ Name: 'Folder', Type: 0, Size: null }]);
  await assert.rejects(reader.read('100', '300', '/Folder'), { code: 'NOT_FOUND' });
  assert.deepEqual(client.downloads, []);
  assert.ok(!client.calls.some(path => path.includes('NotListed')));
});

test('traversal, ambiguous encoding, external paths and invalid ranges are rejected before authenticated calls', async () => {
  const client = fixture(), reader = new GroupLockerFiles(client);
  for (const path of ['../secret', '/a/../b', '/a/%2e%2e/b', '/a%2fb', '//host/file', 'https://host/file', '/a\\b', '/file?x=1', '/file#frag', '/folder/', '/a/\u0000b', '/a//b', Array(14).fill('a').join('/')]) {
    await assert.rejects(reader.read('100', '300', path), { code: 'INVALID_LOCKER_PATH' });
  }
  await assert.rejects(reader.read('100', '300', '/notes.txt', { maxChars: 50_001 }), { code: 'INVALID_RANGE' });
  await assert.rejects(reader.list('100', '300', { maxItems: 501 }), { code: 'INVALID_RANGE' });
  assert.deepEqual(client.calls, []);
});

test('malformed or duplicate folder entries fail closed instead of choosing an ambiguous file', async () => {
  const client = fixture(), reader = new GroupLockerFiles(client);
  for (const value of [{ Items: [file()] }, [file(), file()], [file('../notes.txt')], [{ ...file(), Type: 8 }], [{ ...file(), Size: -1 }]]) {
    client.payloads.set(root, value);
    await assert.rejects(reader.read('100', '300', '/notes.txt'), { code: 'API_FORMAT_CHANGED' });
  }
  client.payloads.set(root, Array.from({ length: 5_001 }, (_, i) => file('item-' + i)));
  await assert.rejects(reader.list('100', '300'), { code: 'LOCKER_READ_LIMIT' });
  assert.deepEqual(client.downloads, []);
});

test('account changes during membership or download abort without indexing or returning mixed-account files', async () => {
  const client = fixture(); let indexed = false;
  const reader = new GroupLockerFiles(client, client.config, async () => { indexed = true; });
  client.afterJson = () => { client.accountId = '18'; };
  await assert.rejects(reader.read('100', '300', '/notes.txt'), { code: 'ACCOUNT_CHANGED' });
  assert.deepEqual(client.downloads, []);
  client.afterJson = undefined; client.accountId = '17'; client.afterDownload = () => { client.accountId = '18'; };
  await assert.rejects(reader.read('100', '300', '/notes.txt'), { code: 'ACCOUNT_CHANGED' });
  assert.equal(indexed, false);
});

test('size limits and unexpected download endpoints are enforced before extraction or indexing', async () => {
  const client = fixture(), reader = new GroupLockerFiles(client);
  client.payloads.set(root, [file('notes.txt', 51 * 1024 * 1024)]);
  await assert.rejects(reader.read('100', '300', '/notes.txt'), { code: 'FILE_TOO_LARGE' });
  assert.deepEqual(client.downloads, []);
  client.payloads.set(root, [file()]);
  client.redirect = origin + '/different-private-file.txt';
  await assert.rejects(reader.read('100', '300', '/notes.txt'), { code: 'LOCKER_FILE_UNVERIFIED' });
  client.redirect = 'https://external.invalid/file';
  await assert.rejects(reader.read('100', '300', '/notes.txt'), { code: 'EXTERNAL_RESOURCE' });
});

test('index IDs reversibly encode the exact canonical path and extracted URL credentials are redacted', async () => {
  const client = fixture(), indexed: Omit<IndexedDocument, 'fetchedAt'>[] = [];
  client.payloads.set(root, [file('résumé (final).txt', null)]);
  client.bytes = Buffer.from('A https://example.com/notes?courseCode=A&token=private URL.');
  const result = await new GroupLockerFiles(client, client.config, async (accountId, document) => {
    assert.equal(accountId, '17'); indexed.push(document);
  }).read('100', '300', 'résumé (final).txt');
  assert.equal(result.indexed, true); assert.equal(indexed.length, 1);
  assert.equal(indexed[0]!.kind, 'group_locker_file');
  const [course, group, encoded] = indexed[0]!.id.split(':');
  assert.equal(course, '100'); assert.equal(group, '300');
  assert.equal(Buffer.from(encoded!, 'base64url').toString('utf8'), '/résumé (final).txt');
  assert.ok(!String(result.text).includes('private'));
  assert.ok(!indexed[0]!.text.includes('private'));
});

test('unsupported ZIP files remain available as bounded account/group-scoped raw downloads without indexing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-locker-'));
  try {
    const client = fixture(); client.config.dataDir = directory;
    client.payloads.set(root, [file('project.zip', 4)]); client.bytes = Buffer.from([0x50, 0x4b, 3, 4]); client.contentType = 'application/zip';
    let indexed = false;
    const result = await new GroupLockerFiles(client, client.config, async () => { indexed = true; }).read('100', '300', '/project.zip', { download: true });
    assert.equal(result.indexed, false); assert.equal(indexed, false); assert.equal(result.complete, false);
    assert.ok((result.warnings as string[]).length > 0);
    assert.ok(String(result.localPath).includes(join('100', 'group_locker', '300')));
    assert.deepEqual(await readFile(String(result.localPath)), client.bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('access denials propagate without trying browser, alternate groups, or guessed file routes', async () => {
  const client = fixture(); client.payloads.set(root, new BrightspaceError('PERMISSION_DENIED', 'Denied.', { status: 403 }));
  await assert.rejects(new GroupLockerFiles(client).read('100', '300', '/notes.txt'), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(client.calls.filter(path => path.includes('/locker/')), [root]);
  assert.deepEqual(client.downloads, []);
});


test('already-extracted plain text and notebook code retain literal markup and generic syntax', async () => {
  const code = [
    'const identity = <T>(value: T): T => value;',
    'std::vector<int> numbers;',
    'const markup = "<tag>literal</tag>";',
    'const url = "https://example.com/notes?courseCode=ABC&token=private";',
  ].join('\n');
  for (const extension of ['txt', 'ipynb']) {
    const client = fixture(), indexed: Omit<IndexedDocument, 'fetchedAt'>[] = [];
    client.payloads.set(root, [file('code.' + extension, null)]);
    client.bytes = Buffer.from(extension === 'txt' ? code : JSON.stringify({
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [{ cell_type: 'code', metadata: {}, source: code, outputs: [], execution_count: null }],
    }));
    client.contentType = extension === 'txt' ? 'text/plain' : 'application/x-ipynb+json';
    const result = await new GroupLockerFiles(client, client.config, async (_accountId, document) => { indexed.push(document); })
      .read('100', '300', '/code.' + extension);
    for (const expected of ['<T>(value: T)', 'std::vector<int>', '<tag>literal</tag>']) {
      assert.ok(String(result.text).includes(expected), extension + ' should preserve ' + expected);
      assert.ok(indexed[0]!.text.includes(expected));
    }
    assert.ok(String(result.text).includes('courseCode=ABC'));
    assert.ok(!String(result.text).includes('private'));
  }
});
