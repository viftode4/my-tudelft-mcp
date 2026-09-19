import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Auth } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { createServer, resultOf } from '../src/server.js';
import { SubmissionActions } from '../src/submissions.js';
import { StudentFiles } from '../src/student-files.js';
import { CourseRecordings } from '../src/recordings.js';
import { StudentPages } from '../src/student-pages.js';
import { PublicStudyGuide } from '../src/study-guide.js';
import { GroupLockerFiles } from '../src/group-locker-files.js';
import { Collegerama } from '../src/collegerama.js';
import { TextSubmissionActions } from '../src/text-submissions.js';
import { MyTuDelft } from '../src/mytudelft.js';
import { MyTimetable } from '../src/mytimetable.js';
import { UniversityMail } from '../src/university-mail.js';

const configFor = (dataDir: string): Config => ({ baseUrl: 'https://school.example', catalogUrl: 'https://catalog.example', dataDir, timeoutMs: 1000, maxFileBytes: 100 });
const decode = (result: any): any => result.structuredContent ?? JSON.parse(result.content[0].text);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-mcp-test-'));
  const config = configFor(directory), auth = new Auth(config), app = createServer(config, auth);
  const client = new Client({ name: 'brightspace-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    app, auth, client,
    close: async () => {
      try { await app.close(); }
      finally {
        try { await client.close(); }
        finally {
          assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  };
}
afterEach(() => mock.restoreAll());

test('MCP timetable tools validate timestamp schemas and forward only the supplied connection and range', async () => {
  const f = await fixture(), calls: unknown[][] = [];
  mock.method(MyTimetable.prototype, 'connect', async (...args: any[]) => { calls.push(args); return { connected: true }; });
  mock.method(MyTimetable.prototype, 'events', async (...args: any[]) => { calls.push(args); return { items: [], complete: true }; });
  mock.method(MyTimetable.prototype, 'status', async () => ({ configured: true }));
  try {
    const feedUrl = 'https://mytimetable.tudelft.nl/ical?synthetic-private';
    const from = '2026-10-01T00:00:00+02:00', to = '2026-10-08T00:00:00+02:00';
    const connected = await f.client.callTool({ name: 'connect_timetable', arguments: { feedUrl } });
    assert.equal(JSON.stringify(connected).includes('synthetic-private'), false);
    assert.equal(decode(await f.client.callTool({ name: 'get_timetable_status', arguments: {} })).configured, true);
    await f.client.callTool({ name: 'get_timetable', arguments: { from, to } });
    assert.equal((await f.client.callTool({ name: 'get_timetable', arguments: { from: '2026-10-01', to } })).isError, true);
    assert.deepEqual(calls, [[feedUrl], [from, to]]);
    const { tools } = await f.client.listTools();
    assert.equal(tools.find(tool => tool.name === 'get_timetable')!.annotations?.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === 'connect_timetable')!.annotations?.readOnlyHint, false);
  } finally { await f.close(); }
});

test('global logout removes the local timetable before clearing the Brightspace session', async () => {
  const f = await fixture(), calls: string[] = [];
  mock.method(MyTimetable.prototype, 'disconnect', async () => { calls.push('timetable'); return { disconnected: true }; });
  mock.method(f.auth, 'logout', async () => { calls.push('brightspace'); });
  try {
    await f.client.callTool({ name: 'logout', arguments: {} });
    assert.deepEqual(calls, ['timetable', 'brightspace']);
  } finally { await f.close(); }
});

test('MCP exposes student tools with schemas and accurate write annotations', async () => {
  const f = await fixture();
  try {
    const { tools } = await f.client.listTools();
    assert.equal(tools.length, 85);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    for (const name of ['list_recordings', 'read_course_service', 'list_available_groups', 'prepare_group_enrollment', 'search_study_guide', 'get_study_guide', 'list_group_locker_files', 'read_group_locker_file']) assert.ok(tools.some((tool) => tool.name === name), name);
    for (const name of ['begin_recording_login', 'get_recording_login_status', 'read_recording']) assert.ok(tools.some((tool) => tool.name === name), name);
    for (const name of ['connect_timetable', 'get_timetable_status', 'get_timetable', 'disconnect_timetable']) assert.ok(tools.some((tool) => tool.name === name), name);
    for (const name of ['begin_login', 'check_auth', 'list_courses', 'read_material', 'list_assignments', 'search_course_materials', 'search_catalog', 'get_my_grades', 'get_study_overview', 'get_course_tools', 'get_my_groups', 'get_my_progress', 'read_group_locker', 'read_announcement_attachment', 'read_my_submission_file', 'read_assignment_feedback_file']) assert.ok(tools.some((tool) => tool.name === name), name);
    for (const name of ['confirm_assignment_submission', 'confirm_course_registration', 'confirm_group_enrollment', 'confirm_text_submission', 'confirm_official_registration']) {
      const tool = tools.find((tool) => tool.name === name)!;
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.idempotentHint, false);
      assert.ok(tool.inputSchema.required?.includes('confirmed'));
      assert.equal((tool.inputSchema.properties?.confirmed as any).const, true);
    }
    assert.equal(tools.find((tool) => tool.name === 'list_courses')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'clear_local_index')?.annotations?.destructiveHint, true);
    assert.equal((tools.find((tool) => tool.name === 'start_course_sync')?.inputSchema.properties?.maxFiles as any).maximum, 50);
  } finally { await f.close(); }
});

test('MCP fresh login is opt-in and forwards the exact recovery option', async () => {
  const f = await fixture(), calls: unknown[][] = [];
  mock.method(f.auth, 'beginLogin', (...args: unknown[]) => { calls.push(args); return { state: 'waiting', message: 'Complete university sign-in.' }; });
  try {
    assert.equal((await f.client.callTool({ name: 'begin_login', arguments: { interactive: true } })).isError, undefined);
    assert.equal((await f.client.callTool({ name: 'begin_login', arguments: { fresh: true, interactive: true } })).isError, undefined);
    assert.deepEqual(calls, [['brightspace', { fresh: false }], ['brightspace', { fresh: true }]]);
    const invalid = await f.client.callTool({ name: 'begin_login', arguments: { fresh: 'true' } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 2);
  } finally { await f.close(); }
});

test('MCP check_auth with no session returns sanitized AUTH_REQUIRED without network access', async () => {
  const f = await fixture();
  let requests = 0;
  mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Network must not be contacted'); });
  try {
    const result = await f.client.callTool({ name: 'check_auth', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(decode(result).error.code, 'AUTH_REQUIRED');
    assert.match(decode(result).error.message, /begin_login/);
    assert.equal(requests, 0);
  } finally { await f.close(); }
});

test('MCP validates IDs, limits and explicit literal confirmation before running tools', async () => {
  const f = await fixture();
  try {
    const cases = [
      { name: 'get_course_content', arguments: { courseId: '../other' } },
      { name: 'get_official_grade', arguments: { resultId: '../other' } },
      { name: 'list_official_grades', arguments: { limit: 101 } },
      { name: 'get_official_programme', arguments: { progressId: '../other' } },
      { name: 'search_official_courses', arguments: { kind: 'exam', query: 'x' } },
      { name: 'confirm_official_registration', arguments: { confirmationToken: 'synthetic-preview-token', confirmed: false } },
      { name: 'confirm_official_registration', arguments: { confirmationToken: 'synthetic-preview-token' } },
      { name: 'list_mail_messages', arguments: { limit: 51 } },
      { name: 'list_mail_messages', arguments: { cursor: 'https://example.com/next' } },
      { name: 'read_mail', arguments: { messageId: '../other' } },
      { name: 'search_mail', arguments: { query: 'line\nbreak' } },
      { name: 'create_mail_reply_draft', arguments: { messageId: 'message-id', body: ' ' } },
      { name: 'create_mail_reply_draft', arguments: { messageId: 'message-id', body: 'test', replyAll: 'true' } },
      { name: 'read_material', arguments: { courseId: '123', topicId: '456', maxChars: 50001 } },
      { name: 'start_course_sync', arguments: { courseId: '123', maxFiles: 51 } },
      { name: 'list_recordings', arguments: { courseId: '123', maxDetails: 51 } },
      { name: 'list_recordings', arguments: { courseId: '123', startAt: -1 } },
      { name: 'get_my_progress', arguments: { courseId: '123', section: 'another_student' } },
      { name: 'search_study_guide', arguments: { query: 'Example', academicYear: '2026-2027', offset: 1 } },
      { name: 'get_study_guide', arguments: { courseCode: '../EX123', academicYear: '2026-2027' } },
      { name: 'list_group_locker_files', arguments: { courseId: '123', groupId: '456', maxItems: 501 } },
      { name: 'read_group_locker_file', arguments: { courseId: '123', filePath: '/notes.txt' } },
      { name: 'begin_recording_login', arguments: { courseId: '123' } },
      { name: 'read_recording', arguments: { courseId: '123', topicId: '456', maxChars: 50001 } },
      { name: 'prepare_text_submission', arguments: { courseId: '123', assignmentId: '4', text: '' } },
      { name: 'confirm_text_submission', arguments: { confirmationToken: 'synthetic-token-value', confirmed: false } },
      { name: 'confirm_course_registration', arguments: { confirmationToken: 'synthetic-token-value' } },
      { name: 'confirm_course_registration', arguments: { confirmationToken: 'synthetic-token-value', confirmed: false } },
      { name: 'confirm_assignment_submission', arguments: { confirmationToken: 'synthetic-token-value', confirmed: 'true' } },
      { name: 'read_group_locker', arguments: { courseId: '123' } },
      { name: 'prepare_assignment_submission', arguments: { courseId: '123', assignmentId: '4', files: ['test.txt'], groupId: '../5' } },
      { name: 'get_study_overview', arguments: { courseIds: [], days: 14 } },
      { name: 'read_my_submission_file', arguments: { courseId: '123', assignmentId: '4', fileId: '6' } },
      { name: 'read_course_service', arguments: { courseId: '123', service: 'arbitrary_external_site' } },
      { name: 'prepare_group_enrollment', arguments: { courseId: '123', groupId: '../4' } },
      { name: 'confirm_group_enrollment', arguments: { confirmationToken: 'synthetic-token-value', confirmed: false } },
    ];
    for (const input of cases) {
      const result = await f.client.callTool(input);
      assert.equal(result.isError, true, input.name);
      assert.match(JSON.stringify(result), /validation|Invalid|invalid/i);
    }
    const relationship = await f.client.callTool({ name: 'read_discussions', arguments: { courseId: '123', topicId: '456' } });
    assert.equal(decode(relationship).error.code, 'INVALID_ARGUMENT');
  } finally { await f.close(); }
});

test('public Study Guide calls do not require a Brightspace session and preserve exact year and language', async () => {
  const f = await fixture(), calls: unknown[][] = [];
  mock.method(f.auth, 'session', async () => { throw new Error('Public guide must not read saved credentials'); });
  mock.method(PublicStudyGuide.prototype, 'getCourse', async (...args: unknown[]) => { calls.push(args); return { authentication: 'anonymous' } as never; });
  mock.method(PublicStudyGuide.prototype, 'search', async (...args: unknown[]) => { calls.push(args); return { authentication: 'anonymous', items: [] } as never; });
  try {
    const detail = await f.client.callTool({ name: 'get_study_guide', arguments: { courseCode: 'EX123', academicYear: '2026-2027' } });
    assert.equal(detail.isError, undefined);
    assert.equal(decode(detail).authentication, 'anonymous');
    assert.deepEqual(calls[0], ['EX123', '2026-2027', 'en']);
    await f.client.callTool({ name: 'search_study_guide', arguments: { query: 'Example', academicYear: '2025-2026', language: 'nl', offset: 30 } });
    assert.deepEqual(calls[1], ['Example', '2025-2026', 'nl', 30]);
  } finally { await f.close(); }
});

test('MCP preserves exact locker group and file path with downloads disabled by default', async () => {
  const f = await fixture(), calls: unknown[][] = [];
  mock.method(GroupLockerFiles.prototype, 'list', async (...args: unknown[]) => { calls.push(args); return { items: [] }; });
  mock.method(GroupLockerFiles.prototype, 'read', async (...args: unknown[]) => { calls.push(args); return { text: 'Notebook source' }; });
  try {
    await f.client.callTool({ name: 'list_group_locker_files', arguments: { courseId: '123', groupId: '456', folderPath: '/Notes/' } });
    assert.deepEqual(calls[0], ['123', '456', { folderPath: '/Notes/', startAt: 0, maxItems: 100 }]);
    await f.client.callTool({ name: 'read_group_locker_file', arguments: { courseId: '123', groupId: '456', filePath: '/Notes/draft.ipynb', offset: 200, maxChars: 100 } });
    assert.deepEqual(calls[1]?.slice(0, 3), ['123', '456', '/Notes/draft.ipynb']);
    assert.equal((calls[1]?.[3] as any).download, false);
    assert.equal((calls[1]?.[3] as any).offset, 200);
  } finally { await f.close(); }
});

test('MCP exposes recording login status, exact metadata reads and combined logout', async () => {
  const f = await fixture(), calls: unknown[][] = [], events: string[] = [];
  mock.method(Collegerama.prototype, 'beginLogin', async (...args: unknown[]) => { calls.push(args); return { state: 'waiting', message: 'Complete the university browser sign-in' }; });
  mock.method(Collegerama.prototype, 'status', () => ({ state: 'waiting', message: 'Complete the university browser sign-in' }));
  mock.method(Collegerama.prototype, 'read', async (...args: unknown[]) => { calls.push(args); return { metadataVerified: true, mediaBytesFetched: false }; });
  mock.method(Collegerama.prototype, 'logout', async () => { events.push('recording-logout'); });
  const logout = f.auth.logout.bind(f.auth);
  mock.method(f.auth, 'logout', async () => { events.push('brightspace-logout'); await logout(); });
  try {
    assert.equal(decode(await f.client.callTool({ name: 'begin_recording_login', arguments: { courseId: '123', topicId: '456', interactive: true } })).state, 'waiting');
    assert.deepEqual(calls[0], ['123', '456']);
    assert.equal(decode(await f.client.callTool({ name: 'get_recording_login_status', arguments: {} })).state, 'waiting');
    const read = await f.client.callTool({ name: 'read_recording', arguments: { courseId: '123', topicId: '456', offset: 100, maxChars: 200 } });
    assert.equal(decode(read).mediaBytesFetched, false);
    assert.deepEqual(calls[1], ['123', '456', { offset: 100, maxChars: 200 }]);
    await f.client.callTool({ name: 'logout', arguments: {} });
    assert.deepEqual(events, ['recording-logout', 'brightspace-logout']);
  } finally { await f.close(); }
});

test('MCP keeps official results separate and preserves exact result IDs and pagination', async () => {
  const f = await fixture(), calls: unknown[][] = [];
  mock.method(MyTuDelft.prototype, 'beginLogin', async () => ({ state: 'waiting', message: 'Complete student login.' }));
  mock.method(MyTuDelft.prototype, 'status', () => ({ state: 'waiting', message: 'Complete student login.' }));
  mock.method(MyTuDelft.prototype, 'grades', async (...args: unknown[]) => { calls.push(args); return { source: 'official_osiris_api', items: [], complete: false, nextOffset: 50 }; });
  mock.method(MyTuDelft.prototype, 'grade', async (...args: unknown[]) => { calls.push(args); return { source: 'official_osiris_api', item: { id: 'result_123' } }; });
  try {
    assert.equal(decode(await f.client.callTool({ name: 'begin_mytu_login', arguments: { interactive: true } })).state, 'waiting');
    assert.equal(decode(await f.client.callTool({ name: 'get_mytu_login_status', arguments: {} })).state, 'waiting');
    const page = decode(await f.client.callTool({ name: 'list_official_grades', arguments: { offset: 25 } }));
    assert.equal(page.source, 'official_osiris_api'); assert.equal(page.complete, false); assert.equal(page.nextOffset, 50);
    await f.client.callTool({ name: 'get_official_grade', arguments: { resultId: 'result_123' } });
    assert.deepEqual(calls, [[{ offset: 25, limit: 25 }], ['result_123']]);
    const usage = JSON.stringify(await f.client.readResource({ uri: 'brightspace://usage' }));
    assert.match(usage, /separate Brightspace course gradebook/);
  } finally { await f.close(); }
});

test('MCP email preserves mailbox query and literal draft text with reply-all disabled by default', async () => {
  const f = await fixture(), calls: unknown[][] = [];
  mock.method(UniversityMail.prototype, 'listMessages', async (...args: unknown[]) => { calls.push(args); return { items: [] }; });
  mock.method(UniversityMail.prototype, 'search', async (...args: unknown[]) => { calls.push(args); return { items: [], complete: false }; });
  mock.method(UniversityMail.prototype, 'createReplyDraft', async (...args: unknown[]) => { calls.push(args); return { savedToOutlook: true, sent: false }; });
  try {
    const { tools } = await f.client.listTools();
    for (const name of ['begin_mail_login', 'get_mail_login_status', 'check_mail_auth', 'list_mail_folders', 'list_mail_messages', 'search_mail', 'read_mail', 'logout_mail']) assert.ok(tools.some(tool => tool.name === name), name);
    assert.equal(tools.some(tool => /send.*mail|mail.*send/.test(tool.name)), false);
    const draft = tools.find(tool => tool.name === 'create_mail_reply_draft')!;
    assert.equal(draft.annotations?.readOnlyHint, false); assert.equal(draft.annotations?.idempotentHint, false);
    assert.equal(tools.find(tool => tool.name === 'read_mail')?.annotations?.readOnlyHint, true);
    await f.client.callTool({ name: 'list_mail_messages', arguments: {} });
    const cursor = 'abcdef0123456789abcdef0123456789';
    await f.client.callTool({ name: 'search_mail', arguments: { query: 'subject:lecture', limit: 10, cursor } });
    const body = 'Thanks,\nLiteral <text> & symbols.';
    const result = decode(await f.client.callTool({ name: 'create_mail_reply_draft', arguments: { messageId: 'message_123==', body } }));
    assert.equal(result.savedToOutlook, true); assert.equal(result.sent, false);
    assert.deepEqual(calls, [['inbox', 25, undefined], ['subject:lecture', 10, cursor], ['message_123==', body, false]]);
  } finally { await f.close(); }
});

test('Brightspace account switches and logout close linked services before changing the account', async () => {
  const f = await fixture(), events: string[] = [];
  mock.method(MyTuDelft.prototype, 'close', async () => { events.push('mytu-close'); });
  mock.method(UniversityMail.prototype, 'close', async () => { events.push('mail-close'); });
  mock.method(MyTuDelft.prototype, 'logout', async () => { events.push('mytu-logout'); });
  mock.method(UniversityMail.prototype, 'logout', async () => { events.push('mail-logout'); return { loggedOut: true }; });
  mock.method(f.auth, 'beginLogin', () => { events.push('brightspace-login'); return { state: 'idle', message: 'Synthetic login' }; });
  mock.method(f.auth, 'logout', async () => { events.push('brightspace-logout'); });
  try {
    await f.client.callTool({ name: 'begin_login', arguments: { interactive: true } });
    assert.deepEqual(events, ['mytu-close', 'mail-close', 'brightspace-login']);
    events.length = 0;
    await f.client.callTool({ name: 'logout', arguments: {} });
    assert.deepEqual(events, ['mytu-logout', 'mail-logout', 'brightspace-logout']);
  } finally { await f.close(); }
});

test('global logout attempts other providers after a local vault removal failure', async () => {
  const f = await fixture(), events: string[] = [];
  mock.method(MyTuDelft.prototype, 'logout', async () => { events.push('mytu'); throw new Error('Private vault filesystem diagnostic'); });
  mock.method(UniversityMail.prototype, 'logout', async () => { events.push('mail'); return { loggedOut: true }; });
  mock.method(f.auth, 'logout', async () => { events.push('brightspace'); });
  try {
    const result = await f.client.callTool({ name: 'logout', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(decode(result).error.code, 'LOGOUT_INCOMPLETE');
    assert.deepEqual(decode(result).error.details.failedComponents, ['mytu_login']);
    assert.deepEqual(events, ['mytu', 'mail', 'brightspace']);
    assert.equal(JSON.stringify(result).includes('Private vault'), false);
  } finally { await f.close(); }
});

test('server shutdown attempts mail and course cleanup after a provider close failure', async () => {
  const f = await fixture(), events: string[] = [];
  const closeService = f.app.service.close.bind(f.app.service);
  mock.method(MyTuDelft.prototype, 'close', async () => { events.push('mytu'); throw new Error('Private browser diagnostic'); });
  mock.method(UniversityMail.prototype, 'close', async () => { events.push('mail'); });
  mock.method(f.app.service, 'close', async () => { events.push('course'); await closeService(); });
  try {
    await assert.rejects(f.app.close(), (error: any) => error.code === 'SHUTDOWN_INCOMPLETE' && error.details.failedComponents.join() === 'mytu_login');
    assert.deepEqual(events, ['mytu', 'mail', 'course']);
  } finally { await assert.rejects(f.close(), (error: any) => error.code === 'SHUTDOWN_INCOMPLETE'); }
});

test('MCP preserves literal text and explicit own-group selection in submission previews', async () => {
  const f = await fixture(), calls: unknown[][] = [];
  mock.method(TextSubmissionActions.prototype, 'prepare', async (...args: unknown[]) => { calls.push(args); return { status: 'preview', affectsGroup: true } as never; });
  try {
    const text = 'First line\nLiteral <tag> and Vector<T> & characters';
    const result = await f.client.callTool({ name: 'prepare_text_submission', arguments: { courseId: '123', assignmentId: '4', text, groupId: '456' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls[0], ['123', '4', text, '456']);
    assert.equal(decode(result).affectsGroup, true);
  } finally { await f.close(); }
});

test('MCP errors never echo raw transport diagnostics and empty task output is valid JSON', async () => {
  const f = await fixture();
  mock.method(f.app.service, 'checkAuth', async () => { throw new Error('Authorization: Bearer sensitive-test-value'); });
  try {
    const result = await f.client.callTool({ name: 'check_auth', arguments: {} });
    assert.equal(decode(result).error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(result).includes('sensitive-test-value'), false);
    assert.deepEqual(decode(await resultOf(() => undefined)), { result: null });
  } finally { await f.close(); }
});

test('MCP usage resource and briefing prompt retain source and approval guidance', async () => {
  const f = await fixture();
  try {
    const resource = await f.client.readResource({ uri: 'brightspace://usage' });
    const text = (resource.contents[0] as any).text;
    assert.match(text, /untrusted source data/);
    assert.match(text, /explicit approval/);
    assert.match(text, /My TU Delft/);
    const prompt = await f.client.getPrompt({ name: 'course_briefing', arguments: { courseId: '123' } });
    assert.match(JSON.stringify(prompt), /course 123/);
    assert.match(JSON.stringify(prompt), /incomplete data/);
  } finally { await f.close(); }
});

test('interactive login gates account operations while allowing status and cancellation', async () => {
  const f = await fixture();
  let checked = 0;
  const events: string[] = [];
  const closeService = f.app.service.close.bind(f.app.service);
  mock.method(f.app.service, 'close', async () => { events.push('resources-cleared'); await closeService(); });
  mock.method(f.auth, 'beginLogin', () => { assert.deepEqual(events, ['resources-cleared']); events.push('login-opened'); f.auth.status = { state: 'waiting', message: 'Test login pending' }; return f.auth.status; });
  mock.method(f.app.service, 'checkAuth', async () => { checked++; return { connected: true }; });
  try {
    assert.equal(decode(await f.client.callTool({ name: 'begin_login', arguments: { interactive: true } })).state, 'waiting');
    assert.equal(decode(await f.client.callTool({ name: 'check_auth', arguments: {} })).error.code, 'LOGIN_IN_PROGRESS');
    assert.equal(checked, 0);
    assert.equal(decode(await f.client.callTool({ name: 'get_login_status', arguments: {} })).state, 'waiting');
    assert.equal(decode(await f.client.callTool({ name: 'logout', arguments: {} })).loggedOut, true);
  } finally { await f.close(); }
});

test('concurrent sync starts reserve only one job and logout waits for that job', async () => {
  const f = await fixture();
  mock.method(f.auth, 'session', async () => ({ origin: f.auth.config.baseUrl, storage: { cookies: [], origins: [] }, savedAt: 'test', identity: { id: '1', name: 'Test' } }));
  let releaseSync!: () => void, syncCalls = 0;
  const sync = new Promise<void>((resolveSync) => { releaseSync = resolveSync; });
  mock.method(f.app.service, 'syncCourse', async () => { syncCalls++; await sync; return { complete: true }; });
  try {
    const results = await Promise.all([1, 2].map(() => f.client.callTool({ name: 'start_course_sync', arguments: { courseId: '123', maxFiles: 0 } })));
    assert.equal(results.filter((result) => !result.isError).length, 1);
    assert.equal(decode(results.find((result) => result.isError)).error.code, 'SYNC_BUSY');
    const jobId = decode(results.find((result) => !result.isError)).jobId;
    assert.equal(decode(await f.client.callTool({ name: 'get_sync_status', arguments: { jobId } })).state, 'running');
    const logout = f.client.callTool({ name: 'logout', arguments: {} });
    assert.equal(await Promise.race([logout.then(() => true), new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 20))]), false);
    releaseSync();
    assert.equal(decode(await logout).loggedOut, true);
    assert.equal(syncCalls, 1);
    assert.equal(decode(await f.client.callTool({ name: 'get_sync_status', arguments: { jobId } })).error.code, 'NOT_FOUND');
  } finally { releaseSync(); await f.close(); }
});

test('concurrent close calls share completion and wait for an in-flight operation', async () => {
  const f = await fixture();
  let releaseCheck!: () => void;
  const check = new Promise<void>((resolveCheck) => { releaseCheck = resolveCheck; });
  let started!: () => void;
  const began = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  mock.method(f.app.service, 'checkAuth', async () => { started(); await check; return { connected: true }; });
  try {
    const call = f.client.callTool({ name: 'check_auth', arguments: {} });
    await began;
    const first = f.app.close(), second = f.app.close();
    assert.equal(first, second);
    assert.equal(await Promise.race([first.then(() => true), new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 20))]), false);
    releaseCheck();
    await call;
    await first;
  } finally { releaseCheck(); await f.close(); }
});

test('stdio startup and tool calls emit only MCP JSON-RPC on stdout and close at EOF', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-stdio-test-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, BRIGHTSPACE_DATA_DIR: directory }, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map<number, (value: any) => void>(), unexpected: string[] = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    while (buffered.includes('\n')) {
      const offset = buffered.indexOf('\n'), line = buffered.slice(0, offset); buffered = buffered.slice(offset + 1);
      try {
        const message = JSON.parse(line);
        if (message.jsonrpc !== '2.0') unexpected.push(line);
        if (typeof message.id === 'number') responses.get(message.id)?.(message);
      } catch { unexpected.push(line); }
    }
  });
  child.stderr.resume();
  const closed = once(child, 'close');
  const rpc = (id: number, method: string, params: unknown) => new Promise<any>((resolveRpc) => {
    responses.set(id, resolveRpc);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1.0.0' } });
    assert.equal(initialized.result.serverInfo.name, 'tudelft-brightspace');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    assert.ok((await rpc(2, 'tools/list', {})).result.tools.length >= 25);
    const result = (await rpc(3, 'tools/call', { name: 'check_auth', arguments: {} })).result;
    assert.equal(result.isError, true);
    assert.equal(decode(result).error.code, 'AUTH_REQUIRED');
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0);
    assert.deepEqual(unexpected, []);
    assert.equal(buffered.trim(), '');
  } finally {
    if (child.exitCode === null) { child.kill(); await closed; }
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});


test('MCP routes group selection and file chunks exactly, with download disabled by default', async () => {
  const f = await fixture();
  const calls: unknown[][] = [];
  mock.method(SubmissionActions.prototype, 'prepare', async (...args: unknown[]) => { calls.push(args); return { affectsGroup: true }; });
  mock.method(StudentFiles.prototype, 'submission', async (...args: unknown[]) => { calls.push(args); return { format: 'ipynb', text: 'Stored source' }; });
  mock.method(f.app.service, 'study', async (...args: unknown[]) => { calls.push(args); return { complete: true }; });
  mock.method(CourseRecordings.prototype, 'list', async (...args: unknown[]) => { calls.push(args); return { items: [], nextStartAt: 20, complete: false }; });
  mock.method(StudentPages.prototype, 'progress', async (...args: unknown[]) => { calls.push(args); return { section: 'content', complete: false }; });
  try {
    const preview = await f.client.callTool({ name: 'prepare_assignment_submission', arguments: { courseId: '123', assignmentId: '4', files: ['test.txt'], groupId: '5' } });
    assert.equal(preview.isError, undefined);
    assert.deepEqual(calls[0], ['123', '4', ['test.txt'], '', '5']);
    assert.equal(decode(preview).affectsGroup, true);
    await f.client.callTool({ name: 'read_my_submission_file', arguments: { courseId: '123', assignmentId: '4', submissionId: '7', fileId: '6', offset: 20, maxChars: 100 } });
    assert.deepEqual(calls[1]?.slice(0, 4), ['123', '4', '7', '6']);
    assert.equal((calls[1]?.[4] as any).download, false);
    assert.equal((calls[1]?.[4] as any).offset, 20);
    assert.equal((calls[1]?.[4] as any).maxChars, 100);
    await f.client.callTool({ name: 'get_study_overview', arguments: { courseIds: ['123'], includeAnnouncements: false } });
    assert.deepEqual(calls[2], [['123'], 14, false]);
    const recordings = await f.client.callTool({ name: 'list_recordings', arguments: { courseId: '123', startAt: 20, maxDetails: 0 } });
    assert.deepEqual(calls[3], ['123', { startAt: 20, maxDetails: 0 }]);
    assert.equal(decode(recordings).complete, false);
    await f.client.callTool({ name: 'get_my_progress', arguments: { courseId: '123', section: 'content' } });
    assert.deepEqual(calls[4], ['123', 'content']);
  } finally { await f.close(); }
});


test('all visible login tools require explicit interactive opt-in before doing work', async () => {
  const f = await fixture();
  const opened: string[] = [];
  mock.method(f.auth, 'beginLogin', () => { opened.push('brightspace'); return { state: 'waiting', message: 'login' }; });
  mock.method(MyTuDelft.prototype, 'beginLogin', async () => { opened.push('mytu'); return { state: 'waiting', message: 'login' }; });
  mock.method(Collegerama.prototype, 'beginLogin', async () => { opened.push('recording'); return { state: 'waiting', message: 'login' }; });
  mock.method(UniversityMail.prototype, 'beginLogin', () => { opened.push('mail'); return { state: 'waiting', message: 'login' }; });
  try {
    for (const name of ['begin_login', 'begin_mytu_login', 'begin_recording_login', 'begin_mail_login']) {
      const target = name === 'begin_recording_login' ? { courseId: '123', topicId: '456' } : {};
      for (const args of [target, { ...target, interactive: false }]) {
        assert.equal((await f.client.callTool({ name, arguments: args })).isError, true, name);
      }
    }
    assert.deepEqual(opened, []);
  } finally { await f.close(); }
});

import { PublicCampus } from '../src/public-campus.js';
import { ExamPlanning } from '../src/exam-planning.js';
test('campus and exam MCP tools expose read-only schemas and forward explicit inputs', async () => {
 const f = await fixture(), calls: unknown[] = [];
 mock.method(PublicCampus.prototype, 'software', async (...a: unknown[]) => { calls.push(a); return { items: [], complete: true }; });
 mock.method(PublicCampus.prototype, 'softwareDetail', async (...a: unknown[]) => { calls.push(a); return { name: 'Example' }; });
 mock.method(PublicCampus.prototype, 'notices', async (...a: unknown[]) => { calls.push(a); return { items: [], complete: true }; });
 mock.method(ExamPlanning.prototype, 'overview', async (...a: unknown[]) => { calls.push(a); return { complete: true }; });
 try {
  const { tools } = await f.client.listTools();
  for (const name of ['get_exam_planning_overview', 'search_software', 'get_software', 'search_teaching_rooms', 'search_study_spaces', 'get_ict_notices']) assert.equal(tools.find(t => t.name === name)?.annotations?.readOnlyHint, true);
  await f.client.callTool({name:'search_software',arguments:{query:'editor',offset:25}});
  await f.client.callTool({name:'get_software',arguments:{softwareId:'12'}});
  await f.client.callTool({name:'get_ict_notices',arguments:{kind:'maintenance',page:2}});
  await f.client.callTool({name:'get_exam_planning_overview',arguments:{from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z'}});
  assert.deepEqual(calls,[['editor',25],['12'],['maintenance',2],['2026-10-01T00:00:00Z','2026-10-02T00:00:00Z']]);
  assert.equal((await f.client.callTool({name:'get_software',arguments:{softwareId:'../../private'}})).isError,true);
  assert.equal((await f.client.callTool({name:'get_exam_planning_overview',arguments:{from:'tomorrow',to:'next week'}})).isError,true);
 } finally { await f.close(); }
});
