// Optional compiled MCP checks for public course information and owned student resources.
// Private exact targets belong in ignored .local/*.json. No confirmation tools are called.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

assert.ok(process.argv[2], 'Usage: node scripts/smoke-course-workflows-live.mjs <local-targets.json>');
const targets = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
const project = fileURLToPath(new URL('..', import.meta.url));
const client = new Client({ name: 'brightspace-course-workflows-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(project, 'dist', 'cli.js'), 'serve'], cwd: dirname(project), stderr: 'pipe' });
let diagnostics = '';
transport.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-20_000); });
const results = [];
const report = value => { results.push(value); console.log(JSON.stringify(value)); };
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  if (response.isError) throw new Error(JSON.stringify({ tool: name, error: value.error ?? value }));
  return value;
}
try {
  await client.connect(transport);
  report({ tools: (await client.listTools()).tools.length, outsideProject: true });
  for (const args of targets.studyGuide ?? []) {
    const data = await call('get_study_guide', args);
    assert.equal(data.authentication, 'anonymous');
    assert.equal(data.course.code.toUpperCase(), args.courseCode.toUpperCase());
    assert.equal(data.course.academicYear, args.academicYear);
    assert.ok(data.sections.length > 0);
    const search = await call('search_study_guide', { query: args.courseCode, academicYear: args.academicYear, language: args.language ?? 'en' });
    assert.ok(search.items.some(item => item.id === data.course.id && item.academicYear === args.academicYear));
    report({ tool: 'get_study_guide', courseCode: data.course.code, academicYear: data.course.academicYear,
      sections: data.sections.length, credits: data.course.credits, complete: data.complete,
      outputTruncated: data.outputTruncated, authentication: data.authentication, exactSearchMatch: true });
  }
  assert.equal((await call('check_auth')).connected, true);
  const courses = await call('list_courses', { activeOnly: false });
  report({ authenticated: true, memberships: courses.items.length, complete: courses.complete });
  for (const args of targets.textPreviews ?? []) {
    assert.ok(courses.items.some(course => course.id === args.courseId));
    const text = 'Synthetic preview only.\nNever submit this text.\nLiteral <tag> and Vector<T>.';
    const data = await call('prepare_text_submission', { ...args, text });
    assert.equal(data.status, 'preview');
    assert.equal(data.text, text);
    assert.equal(data.target.courseId, args.courseId);
    assert.equal(data.target.folderId, args.assignmentId);
    assert.equal(data.target.group?.id, args.groupId);
    assert.equal(data.format, 'literal_plain_text');
    assert.match(data.confirmationRequired, /explicitly approves this preview/);
    assert.ok(data.confirmationToken);
    report({ tool: 'prepare_text_submission', courseId: args.courseId, assignmentId: args.assignmentId,
      affectsGroup: data.affectsGroup, overwritesPrevious: data.overwritesPrevious,
      literalTextPreserved: true, confirmed: false, submitted: false });
  }
  for (const args of targets.progressSections ?? []) {
    assert.ok(courses.items.some(course => course.id === args.courseId));
    const data = await call('get_my_progress', args);
    assert.equal(data.section, args.section);
    assert.ok(data.availableSections.some(item => item.section === args.section));
    assert.ok(data.snapshot.text.length > 0);
    assert.equal(data.complete, false);
    report({ tool: 'get_my_progress', courseId: args.courseId, section: data.section, chars: data.snapshot.text.length,
      availableSections: data.availableSections.length, complete: data.complete });
  }
  for (const { expectedBytes, expectedFormat, ...args } of targets.lockerFiles ?? []) {
    assert.ok(courses.items.some(course => course.id === args.courseId));
    const parent = args.filePath.slice(0, args.filePath.lastIndexOf('/') + 1) || '/';
    const listing = await call('list_group_locker_files', { courseId: args.courseId, groupId: args.groupId, folderPath: parent });
    assert.equal(listing.membershipVerified, true);
    assert.ok(listing.items.some(item => item.type === 'file' && item.path === args.filePath));
    const data = await call('read_group_locker_file', { ...args, download: true, maxChars: 200 });
    assert.equal(data.membershipVerified, true);
    assert.equal(data.bytes, expectedBytes);
    assert.equal(data.format, expectedFormat);
    assert.equal((await stat(data.localPath)).size, data.bytes);
    if (data.indexed) {
      const search = await call('search_course_materials', { courseId: args.courseId, query: data.filename });
      assert.ok(search.items.some(item => item.readTool?.name === 'read_group_locker_file'
        && item.readTool.arguments.groupId === args.groupId && item.readTool.arguments.filePath === args.filePath));
    }
    report({ tool: 'read_group_locker_file', courseId: args.courseId, bytes: data.bytes, format: data.format,
      indexed: data.indexed, warnings: data.warnings.length, complete: data.complete, downloaded: true });
  }
  assert.equal(/(?:Error:|Unhandled)/.test(diagnostics), false);
  report({ protocol: 'passed', unexpectedStderr: false, verifiedAt: new Date().toISOString() });
  await mkdir(join(project, '.local'), { recursive: true });
  await writeFile(join(project, '.local', 'last-course-workflows-check.json'), JSON.stringify(results, null, 2) + '\n');
} finally { await client.close(); }
