// Optional live integration checks. Targets are supplied in an ignored local JSON file.
// Reads existing student data, saves requested downloads locally, and creates upload previews.
// Confirmation tools are never invoked.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, unlink, rmdir, stat, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-student-live.mjs <local-targets.json>');
const targets = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
const project = fileURLToPath(new URL('..', import.meta.url));
const client = new Client({ name: 'brightspace-student-live-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(project, 'dist', 'cli.js'), 'serve'], stderr: 'pipe',
});
let diagnostics = '', temporary;
transport.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-20_000); });
const results = [];
function report(value) { results.push(value); console.log(JSON.stringify(value)); }
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  if (response.isError) throw new Error(JSON.stringify({ tool: name, error: value.error ?? value }));
  return value;
}
try {
  await client.connect(transport);
  report({ tools: (await client.listTools()).tools.length });
  assert.equal((await call('check_auth')).connected, true);
  report({ authenticated: true });
  const courses = await call('list_courses', { activeOnly: false });
  report({ memberships: courses.items.length, complete: courses.complete });
  for (const courseId of targets.courseIds ?? []) {
    assert.ok(courses.items.some(course => course.id === courseId), 'Target must be in own course list');
    const groups = await call('get_my_groups', { courseId });
    report({ tool: 'get_my_groups', courseId, groups: groups.myGroups.length, categories: groups.categories.length, membershipComplete: groups.membershipComplete });
  }
  if (targets.courseIds?.length) {
    const overview = await call('get_study_overview', { courseIds: targets.courseIds, days: 14 });
    assert.equal(overview.errors.length, 0);
    report({ tool: 'get_study_overview', deadlines: overview.deadlines.length, events: overview.events.length,
      closingWindows: overview.closingWindows.length, coverage: overview.coverage.length, complete: overview.complete,
      warnings: overview.warnings });
    const courseId = targets.courseIds[0];
    const navigation = await call('get_course_tools', { courseId });
    assert.ok(navigation.tools.length);
    report({ tool: 'get_course_tools', courseId, tools: navigation.tools.length, links: navigation.linkedResources.length, complete: navigation.complete });
    const progress = await call('get_my_progress', { courseId });
    assert.ok(progress.snapshot.text.length);
    report({ tool: 'get_my_progress', courseId, chars: progress.snapshot.text.length, links: progress.snapshot.links.length, complete: progress.complete });
  }
  for (const args of targets.lockers ?? []) {
    const locker = await call('read_group_locker', args);
    assert.equal(locker.membershipVerified, true);
    report({ tool: 'read_group_locker', courseId: args.courseId, chars: locker.snapshot.text.length, links: locker.snapshot.links.length, complete: locker.complete });
  }
  for (const { preview, ...args } of targets.availableGroups ?? []) {
    const available = await call('list_available_groups', args);
    report({ tool: 'list_available_groups', courseId: args.courseId, groups: available.groups.length,
      joinable: available.groups.filter(group => group.joinable).length, complete: available.complete });
    if (preview) {
      const group = available.groups.find(group => group.joinable);
      assert.ok(group, 'The live preview sample requires an available group');
      const prepared = await call('prepare_group_enrollment', { courseId: args.courseId, groupId: group.id, categoryId: group.categoryId });
      assert.ok(prepared.confirmationToken);
      report({ tool: 'prepare_group_enrollment', courseId: args.courseId, preview: true, enrolled: false });
    }
  }
  for (const args of targets.nativeMedia ?? []) {
    const media = await call('read_material', args);
    assert.ok(['audio', 'video'].includes(media.media?.kind));
    assert.equal(media.source, 'api_metadata');
    assert.equal(media.bytes, undefined);
    report({ tool: 'read_material', courseId: args.courseId, mediaKind: media.media.kind, source: media.source, mediaBytesFetched: false });
  }
  for (const [list, tool] of [['newsFiles', 'read_announcement_attachment'], ['submissionFiles', 'read_my_submission_file'], ['feedbackFiles', 'read_assignment_feedback_file']]) {
    for (const target of targets[list] ?? []) {
      const { extension, entityType, ...args } = target;
      const data = await call(tool, { ...args, maxChars: 200, download: true });
      assert.equal(data.extractionError, undefined);
      assert.ok(data.totalChars > 0);
      assert.equal(data.format, extension);
      assert.equal(data.indexed, true);
      const search = await call('search_course_materials', { courseId: args.courseId, query: data.filename, limit: 50 });
      assert.ok(search.items.some(item => item.readTool?.name === tool && item.readTool.arguments.fileId === args.fileId));
      assert.equal((await stat(data.localPath)).size, data.bytes);
      if (entityType) assert.equal(data.provenance.entityType, entityType.toLowerCase());
      if (data.nextOffset !== null) {
        const next = await call(tool, { ...args, offset: data.nextOffset, maxChars: 200 });
        assert.ok(next.text.length);
        assert.equal(next.localPath, undefined);
      }
      report({ tool, courseId: args.courseId, format: data.format, bytes: data.bytes, chars: data.totalChars,
        warnings: data.warnings, downloaded: true, chunked: data.nextOffset !== null, indexed: true, searchReadTargetVerified: true });
    }
  }
  if (targets.previews?.length) {
    const local = join(project, '.local');
    await mkdir(local, { recursive: true });
    temporary = await mkdtemp(join(local, 'preview-check-'));
    const path = join(temporary, 'mcp-preview-test.txt');
    await writeFile(path, 'Synthetic local preview verification. This file must not be uploaded.\n');
    for (const args of targets.previews) {
      const preview = await call('prepare_assignment_submission', { ...args, files: [path] });
      assert.ok(preview.confirmationToken);
      assert.equal(preview.affectsGroup, Boolean(args.groupId));
      report({ tool: 'prepare_assignment_submission', courseId: args.courseId, affectsGroup: preview.affectsGroup, uploaded: false });
    }
  }
  report({ protocol: 'passed', unexpectedStderr: /(?:Error:|Unhandled)/.test(diagnostics), verifiedAt: new Date().toISOString() });
  await writeFile(join(project, '.local', 'last-student-check.json'), JSON.stringify(results, null, 2) + '\n');
} finally {
  await client.close();
  if (temporary) {
    assert.equal(dirname(resolve(temporary)), resolve(project, '.local'));
    await unlink(join(temporary, 'mcp-preview-test.txt'));
    await rmdir(temporary);
  }
}
