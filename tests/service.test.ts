import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Auth, Session } from '../src/auth.js';
import type { BrightspaceClient } from '../src/client.js';
import type { Config } from '../src/config.js';
import { BrightspaceError } from '../src/errors.js';
import { StudentService, cleanData, flattenContent } from '../src/service.js';
import { StudentFiles } from '../src/student-files.js';
import { array, record } from '../src/util.js';

const origin = 'https://brightspace.tudelft.nl';
const topic = (id: number, options: Record<string, unknown> = {}) => ({
  TopicId: id, Title: 'Lecture ' + id, ActivityType: 1, Url: '/content/enforced/11/lecture' + id + '.txt', ...options,
});
const toc = (topics = [topic(21)]) => ({ Modules: [{ ModuleId: 1, Title: 'Week 1', Description: { Text: 'Foundations', Html: null }, Modules: [], Topics: topics }] });

class FakeClient {
  config = { baseUrl: origin };
  calls: { method: string; product?: string; path: string; params?: Record<string, string> }[] = [];
  payloads = new Map<string, unknown>([
    ['11/content/toc', toc()], ['11/news/', []], ['11/dropbox/folders/', []],
    ['11/grades/values/myGradeValues/', []], ['calendar/events/myEventsWithOccurrences/', []], ['11/calendar/events/myEvents/', []],
  ]);
  partial = new Set<string>();
  failures = new Map<string, BrightspaceError>();
  downloadBytes = Buffer.from('Lecture content with graph theory and algorithms.');
  downloadType = 'text/plain';
  filename = 'lecture.txt';
  downloads = 0;
  accountId = '17';
  downloadError?: BrightspaceError;

  async json(product: 'le' | 'lp', path: string, params: Record<string, string> = {}): Promise<unknown> {
    this.calls.push({ method: 'json', product, path, params });
    if (this.failures.has(path)) throw this.failures.get(path);
    if (this.payloads.has(path)) return structuredClone(this.payloads.get(path));
    const match = /^11\/content\/topics\/(\d+)$/.exec(path);
    if (match) return { Id: Number(match[1]), TopicType: 1, Title: 'Lecture ' + match[1], Url: '/content/enforced/11/lecture' + match[1] + '.txt' };
    throw new Error('Unexpected API request: ' + product + ':' + path);
  }
  async list(product: 'le' | 'lp', path: string, params: Record<string, string> = {}) {
    const payload = await this.json(product, path, params);
    return { items: Array.isArray(payload) ? payload : array(record(payload).Objects), complete: !this.partial.has(path),
      ...(this.partial.has(path) ? { nextBookmark: 'continuation' } : {}) };
  }
  async apiUrl(product: 'le' | 'lp', path: string) { return origin + '/d2l/api/' + product + '/1.98/' + path; }
  async download(path: string) {
    this.calls.push({ method: 'download', path }); this.downloads++;
    if (this.downloadError) throw this.downloadError;
    return { bytes: this.downloadBytes, contentType: this.downloadType, filename: this.filename, url: path };
  }
  async reset() {}
  async sessionIdentity() { return this.accountId; }
  async close() {}
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'brightspace-service-'));
  const config: Config = { baseUrl: origin, catalogUrl: 'https://brightspace-cc.tudelft.nl', dataDir: dir, timeoutMs: 1000, maxFileBytes: 50 * 1024 * 1024 };
  let sessionLoads = 0;
  const session: Session = { origin, identity: { id: '17', name: 'Student' }, savedAt: '2026-09-14T00:00:00Z', storage: { cookies: [], origins: [] } };
  const auth = { config, session: async () => { sessionLoads++; return session; }, status: { state: 'connected' } } as unknown as Auth;
  const client = new FakeClient(), service = new StudentService(auth, client as unknown as BrightspaceClient);
  let browserReads = 0;
  t.mock.method(service.browser, 'read', async (url: string) => {
    browserReads++;
    return { source: 'browser', url, text: 'Visible browser excerpt', title: 'Brightspace', fetchedAt: new Date().toISOString() };
  });
  t.after(async () => {
    await service.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'brightspace-service-'));
    await rm(dir, { recursive: true, force: true });
  });
  return { client, service, session, sessionLoads: () => sessionLoads, browserReads: () => browserReads };
}

test('TOC maps real TU Delft ActivityType and nested TopicId data, preserving source and availability', () => {
  const input = toc([topic(21), topic(22, { ActivityType: 27, Url: 'https://external.example/launch?token=private&course=11' })]);
  input.Modules[0]!.Modules = [{ ModuleId: 2, Title: 'Exercises', Topics: [topic(23)], Modules: [] }] as never;
  const result = flattenContent(input, '11', origin);
  assert.equal(result.modules.length, 2);
  assert.equal(result.topics[0]!.type, 1);
  assert.equal(result.topics[1]!.activityType, 27);
  assert.equal(result.topics[1]!.type, null);
  assert.equal(result.topics[1]!.resourceUrl, 'https://external.example/launch?course=11');
  assert.equal(result.topics[2]!.module, 'Week 1 / Exercises');
});

test('malformed, hidden and cyclic TOC data never becomes a false complete empty course', () => {
  assert.throws(() => flattenContent({}, '11', origin), { code: 'API_FORMAT_CHANGED' });
  assert.throws(() => flattenContent({ Modules: [{ Title: 'No ID' }] }, '11', origin), { code: 'API_FORMAT_CHANGED' });
  const input = toc([topic(21, { IsHidden: true }), topic(22)]);
  assert.deepEqual(flattenContent(input, '11', origin).topics.map(t => t.id), ['22']);
  input.Modules[0]!.Modules = [input.Modules[0]!] as never;
  assert.throws(() => flattenContent(input, '11', origin), { code: 'API_FORMAT_CHANGED' });
});

test('raw API cleaning strips mixed-case credentials and signed URLs in objects and prose', () => {
  const result = cleanData({
    AccessToken: 'secret1', csrfToken: 'secret2', client_secret: 'secret3', SessionId: 'secret4', courseCode: 'DSAIT4310',
    LinkAttachments: [{ Href: 'https://external.example/file?access_token=secret5&course=11#token' }],
    relative: '/d2l/launch?oauth_signature=secret6&ou=11',
    Body: { Text: 'See https://external.example/page?token=secret7&topic=21 now.', Html: null },
  });
  const json = JSON.stringify(result);
  assert.ok(!json.includes('secret'));
  assert.ok(json.includes('DSAIT4310'));
  assert.ok(json.includes('course=11'));
  assert.ok(json.includes('topic=21'));
  assert.equal((cleanData(Array.from({ length: 2001 }, (_, i) => i)) as unknown[]).length, 2001);
});

test('content indexes all metadata using one vault load per operation', async (t) => {
  const { client, service, sessionLoads } = await fixture(t);
  client.payloads.set('11/content/toc', toc(Array.from({ length: 40 }, (_, i) => topic(100 + i))));
  const result = await service.content('11');
  assert.equal(result.complete, true);
  assert.equal(array(result.topics).length, 40);
  assert.equal(sessionLoads(), 1);
  const matches = await service.search('Foundations', '11');
  assert.equal(array(matches.items).length, 1);
  assert.equal(matches.complete, false);
});

test('API format failure returns a visibly partial browser fallback', async (t) => {
  const { client, service, browserReads } = await fixture(t);
  client.payloads.set('11/content/toc', { unrelated: [] });
  const result = await service.content('11');
  assert.equal(result.source, 'browser');
  assert.equal(result.complete, false);
  assert.equal(browserReads(), 1);
  assert.equal(record(result.apiError).code, 'API_FORMAT_CHANGED');
});

test('calendar validates impossible and ambiguous dates before requests and normalizes valid offsets', async (t) => {
  const { client, service } = await fixture(t);
  for (const from of ['not-a-date', '2026-09-14', '2026-09-14T12:00:00', '2026-02-30T00:00:00Z']) {
    await assert.rejects(service.calendar('11', from, '2026-10-01T00:00:00Z'), { code: 'INVALID_DATE' });
  }
  assert.equal(client.calls.length, 0);
  await service.calendar('11', '2026-09-14T12:00:00+02:00', '2026-09-15T12:00:00+02:00');
  assert.deepEqual(client.calls[0]!.params, { orgUnitIdsCSV: '11', startDateTime: '2026-09-14T10:00:00.000Z', endDateTime: '2026-09-15T10:00:00.000Z' });
  assert.equal(client.calls[0]!.path, 'calendar/events/myEventsWithOccurrences/');
});

test('calendar permission failure falls back without pretending the date range is complete', async (t) => {
  const { client, service } = await fixture(t);
  for (const path of ['calendar/events/myEventsWithOccurrences/', '11/calendar/events/occurrences/', '11/calendar/events/myEvents/']) {
    client.failures.set(path, new BrightspaceError('PERMISSION_DENIED', 'No calendar permission.'));
  }
  const result = await service.calendar('11', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');
  assert.equal(result.source, 'browser');
  assert.equal(result.complete, false);
});

test('announcements reject invalid filters, omit drafts and retain undated announcements explicitly', async (t) => {
  const { client, service } = await fixture(t);
  await assert.rejects(service.announcements('11', 'invalid'), { code: 'INVALID_DATE' });
  client.payloads.set('11/news/', [
    { Id: 1, Title: 'Draft', IsPublished: false }, { Id: 2, Title: 'Hidden', IsHidden: true },
    { Id: 3, Title: 'Old', StartDate: '2025-01-01T00:00:00Z' },
    { Id: 4, Title: 'Undated', Body: { Text: 'Read this update', Html: null } },
    { Id: 5, Title: 'New', LastModifiedDate: '2026-09-14T10:00:00Z' },
  ]);
  const result = await service.announcements('11', '2026-09-01T00:00:00Z');
  assert.deepEqual(array(result.items).map(item => record(item).id), ['4', '5']);
  assert.match(String(result.dateFilterWarning), /could not be determined/);
});

test('deadline aggregation preserves partial status and flags unusable published dates', async (t) => {
  const { client, service } = await fixture(t);
  const tomorrow = new Date(Date.now() + 86400_000).toISOString();
  client.payloads.set('11/dropbox/folders/', [
    { Id: 1, Name: 'Report', DueDate: tomorrow, CustomInstructions: { Text: 'Use graphs', Html: null } },
    { Id: 2, Name: 'Bad date', DueDate: 'yesterday-ish' }, { Id: 3, Name: 'No date', DueDate: null },
  ]);
  client.partial.add('11/dropbox/folders/');
  const result = await service.deadlines(['11', '11'], 14);
  assert.equal(array(result.items).length, 1);
  assert.deepEqual(result.checkedCourses, ['11']);
  assert.equal(result.complete, false);
  assert.equal(record(array(result.errors)[0]).code, 'PARTIAL_ASSIGNMENTS');
  assert.equal(array(result.assignmentsWithoutUsableDueDate).length, 2);
  await assert.rejects(service.deadlines(['11'], Number.NaN), { code: 'INVALID_RANGE' });
});

test('sync resumes through a stable candidate list, reuses one vault read and distinguishes batch from course completeness', async (t) => {
  const { client, service, sessionLoads } = await fixture(t);
  client.payloads.set('11/content/toc', toc([topic(23), topic(21), topic(22)]));
  const first = await service.syncCourse('11', 1, 0);
  assert.equal(first.nextStartAt, 1);
  assert.equal(first.filesIndexed, 1);
  assert.equal(first.complete, false);
  assert.equal(first.batchComplete, true);
  assert.equal(sessionLoads(), 1);
  assert.ok(client.calls.some(call => call.path === '11/content/topics/21'));
  const second = await service.syncCourse('11', 2, 1);
  assert.equal(second.nextStartAt, null);
  assert.equal(second.filesAttempted, 2);
  assert.equal(second.filesIndexed, 2);
  assert.equal(second.complete, false); // Prior batches are not silently asserted to have succeeded.
  assert.equal(client.downloads, 3);
  assert.equal(sessionLoads(), 2);
});

test('sync does not fetch LTI links or unsupported file formats and never counts their text as indexed', async (t) => {
  const { client, service } = await fixture(t);
  client.payloads.set('11/content/toc', toc([
    topic(21), topic(22, { ActivityType: 27, Url: '/d2l/launch?token=hidden' }),
    topic(23, { Url: '/content/enforced/11/archive.zip' }),
  ]));
  const result = await service.syncCourse('11', 20);
  assert.equal(result.filesIndexed, 1);
  assert.equal(array(result.skippedTopics).length, 2);
  assert.equal(result.complete, false);
  assert.equal(client.downloads, 1);
});

test('sync retains partial metadata status even when every selected file succeeds', async (t) => {
  const { client, service } = await fixture(t);
  client.partial.add('11/news/');
  const result = await service.syncCourse('11', 20);
  assert.equal(result.complete, false);
  assert.ok(array(result.errors).some(error => record(error).part === 'announcements' && record(error).code === 'PARTIAL_RESULTS'));
});

test('material does not download or launch a non-file activity and sanitizes its displayed URL', async (t) => {
  const { client, service } = await fixture(t);
  client.payloads.set('11/content/topics/21', { Id: 21, TopicType: 3, ActivityType: 27, Title: 'Recordings',
    Url: 'https://video.example/launch?token=secret&course=11', Description: { Text: 'Lecture recordings', Html: null } });
  const result = await service.material('11', '21');
  assert.equal(result.external, true);
  assert.equal(result.downloadable, false);
  assert.equal(result.indexed, false);
  assert.equal(result.resourceUrl, 'https://video.example/launch?course=11');
  assert.equal(client.downloads, 0);
});

test('material returns bounded extracted text and reports unsupported extraction honestly', async (t) => {
  const { client, service } = await fixture(t);
  const result = await service.material('11', '21', 0, 7);
  assert.equal(result.text, 'Lecture');
  assert.equal(result.nextOffset, 7);
  assert.equal(result.indexed, true);
  assert.equal(result.complete, false);
  await assert.rejects(service.material('11', '21', -1), { code: 'INVALID_RANGE' });
  client.downloadBytes = Buffer.from([0, 1, 2]);
  client.downloadType = 'application/octet-stream';
  client.filename = 'data.xlsx';
  await assert.rejects(service.material('11', '21'), { code: 'DOCUMENT_PARSE_FAILED' });
  client.filename = 'archive.zip';
  const unsupported = await service.material('11', '21');
  assert.equal(unsupported.indexed, false);
  assert.equal(unsupported.complete, false);
  assert.ok(array(unsupported.warnings).length > 0);
});

test('assignment detail missing submission permissions is explicitly incomplete', async (t) => {
  const { client, service } = await fixture(t);
  client.payloads.set('11/dropbox/folders/31', { Id: 31, Name: 'Report' });
  client.failures.set('11/dropbox/folders/31/submissions/mysubmissions/', new BrightspaceError('PERMISSION_DENIED', 'Unavailable.'));
  const result = await service.assignment('11', '31');
  assert.equal(result.complete, false);
  assert.equal(record(result.submissionError).code, 'PERMISSION_DENIED');
});

test('attachment retrieval checks membership and discussion topics require a forum', async (t) => {
  const { client, service } = await fixture(t);
  client.payloads.set('11/dropbox/folders/31', { Id: 31, Attachments: [{ FileId: 42, FileName: 'task.txt' }] });
  await assert.rejects(service.attachment('11', '31', '43'), { code: 'NOT_FOUND' });
  assert.equal(client.downloads, 0);
  await assert.rejects(service.discussions('11', undefined, '25'), { code: 'INVALID_ID' });
});

test('same-account library reopens after close and distinct identities never share search results', async (t) => {
  const { service, session } = await fixture(t);
  await service.content('11');
  await service.close();
  assert.equal(array((await service.search('Foundations', '11')).items).length, 1);
  session.identity = { id: '99', name: 'Another student' };
  (service.client as unknown as FakeClient).accountId = '99';
  assert.equal(array((await service.search('Foundations', '11')).items).length, 0);
});

test('external login account mismatch cannot index old-account content into the new account library', async (t) => {
  const { service, session } = await fixture(t);
  await service.content('11');
  session.identity = { id: '99', name: 'Another student' };
  await assert.rejects(service.search('Foundations', '11'), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(service.content('11'), { code: 'ACCOUNT_CHANGED' });
});

test('missing source file falls back to partial browser text without claiming document indexing', async (t) => {
  const { service, client } = await fixture(t);
  client.downloadError = new BrightspaceError('DOWNLOAD_FAILED', 'File unavailable.', { status: 404 });
  const result = await service.material('11', '21');
  assert.equal(result.source, 'browser');
  assert.equal(result.complete, false);
  assert.equal(result.indexed, false);
  assert.equal(record(result.apiError).code, 'DOWNLOAD_FAILED');
});

test('missing file plus failed browser retains useful description links and reports both failures', async (t) => {
  const { service, client } = await fixture(t);
  client.payloads.set('11/content/topics/21', { Id: 21, TopicType: 1, Title: 'Slides', Url: '/content/enforced/11/missing.pptx',
    Description: { Text: 'An alternative copy', Html: '<a href="https://course.example/slides?token=secret&amp;week=1">Alternative slides</a>' } });
  client.downloadError = new BrightspaceError('DOWNLOAD_FAILED', 'File unavailable.', { status: 404 });
  t.mock.method(service.browser, 'read', async () => { throw new Error('private browser failure'); });
  const result = await service.material('11', '21');
  assert.equal(result.source, 'api_metadata');
  assert.equal(result.text, 'An alternative copy');
  assert.equal(result.indexed, false);
  assert.equal(result.complete, false);
  assert.equal(record(result.browserError).code, 'INTERNAL_ERROR');
  assert.deepEqual(result.descriptionLinks, [{ title: 'Alternative slides', url: 'https://course.example/slides?week=1' }]);
  assert.ok(!JSON.stringify(result).includes('private browser failure'));
});

test('course sync includes workbook, notebook and TSV topics in its resumable file candidates', async (t) => {
  const { client, service } = await fixture(t);
  client.payloads.set('11/content/toc', toc([
    topic(23, { Url: '/content/enforced/11/data.xlsx' }),
    topic(24, { Url: '/content/enforced/11/analysis.ipynb' }),
    topic(25, { Url: '/content/enforced/11/table.tsv' }),
  ]));
  const attempted: string[] = [];
  t.mock.method(service, 'material', async (_course, id) => {
    attempted.push(id); return { source: 'api', indexed: true, warnings: [] };
  });
  const first = await service.syncCourse('11', 2);
  assert.equal(first.candidateFiles, 3);
  assert.deepEqual(attempted, ['23', '24']);
  assert.equal(first.nextStartAt, 2);
  assert.equal(first.remainingFiles, 1);
  await service.syncCourse('11', 2, 2);
  assert.deepEqual(attempted, ['23', '24', '25']);
});

test('reading own student files builds account-scoped search results with reusable exact MCP targets', async (t) => {
  const { service, client } = await fixture(t);
  client.payloads.set('11/dropbox/folders/31/submissions/mysubmissions/', [{
    Entity: {EntityType:'User', EntityId:17},
    Submissions: [{Id:41, Files:[{FileId:51, FileName:'own-notes.txt'}]}],
    Feedback: {IsGraded:false, Files:[]},
  }]);
  const files = new StudentFiles(service.client, service.auth.config, (account, doc) => service.indexStudentFile(account, doc));
  const read = await files.submission('11','31','41','51',{maxChars:7});
  assert.equal(read.indexed, true);
  const matches = array((await service.search('graph theory','11')).items).map(record);
  assert.equal(matches.length,1);
  assert.equal(matches[0]!.kind,'submission_file');
  assert.deepEqual(matches[0]!.readTool,{name:'read_my_submission_file',arguments:{courseId:'11',assignmentId:'31',submissionId:'41',fileId:'51'}});
  client.accountId='18';
  await assert.rejects(service.indexStudentFile('17',{id:'11:file:99',courseId:'11',kind:'document',title:'Wrong account',url:origin,text:'confidential'}),{code:'ACCOUNT_CHANGED'});
});

test('native media reads expose source and published captions without downloading bulk video', async (t) => {
  const { client, service } = await fixture(t);
  client.payloads.set('11/content/topics/21', {
    Id:21, TopicType:1, Title:'Recorded lecture', Url:'/content/enforced/11/recording.mp4',
    Description:{Html:'<p>Lecture explanation</p><a href="/content/enforced/11/captions.vtt">Captions</a>'},
  });
  const result = await service.material('11','21');
  assert.equal(client.downloads,0);
  assert.equal(result.source,'api_metadata');
  assert.equal(result.complete,false);
  assert.equal(result.indexed,false);
  assert.deepEqual(result.media,{kind:'video',format:'mp4',url:origin+'/content/enforced/11/recording.mp4'});
  assert.equal(array(result.captionLinks).length,1);
  client.downloadBytes=Buffer.from('small synthetic video fixture');
  client.downloadType='video/mp4';
  client.filename='recording.mp4';
  const downloaded = await service.material('11','21',0,20000,true);
  assert.equal(client.downloads,1);
  assert.equal(typeof downloaded.localPath,'string');
});
