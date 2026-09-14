// Optional live MCP metadata checks. Only supply exact IDs from your own course list.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const courseIds = [...new Set(process.argv.slice(2))];
assert.ok(courseIds.length > 0 && courseIds.length <= 10 && courseIds.every(id => /^\d{1,18}$/.test(id)),
  'Usage: node scripts/smoke-recordings-live.mjs <courseId> [courseId...] (up to 10)');
const project = fileURLToPath(new URL('..', import.meta.url));
const client = new Client({ name: 'brightspace-recordings-live-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(project, 'dist', 'cli.js'), 'serve'], cwd: dirname(project), stderr: 'pipe',
});
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
  const listed = (await client.listTools()).tools;
  assert.ok(listed.some(tool => tool.name === 'list_recordings'));
  assert.equal((await call('check_auth')).connected, true);
  const courses = await call('list_courses', { activeOnly: false });
  report({ tools: listed.length, authenticated: true, memberships: courses.items.length, outsideProject: true });
  for (const courseId of courseIds) {
    assert.ok(courses.items.some(course => course.id === courseId), 'Target must be an own course');
    let startAt = 0;
    for (let page = 0; page < 2; page++) {
      const data = await call('list_recordings', { courseId, startAt, maxDetails: 20 });
      assert.equal(data.source, 'api_metadata');
      assert.equal(data.coverage.startAt, startAt);
      assert.equal(data.coverage.currentCallOnly, true);
      assert.ok(data.coverage.attemptedDetails <= 20);
      assert.ok(Array.isArray(data.coverage.errors));
      for (const error of data.coverage.errors) {
        assert.ok(['NOT_FOUND', 'PERMISSION_DENIED'].includes(error.code), 'Unexpected recording metadata failure: ' + error.code);
        assert.equal(data.complete, false, 'Unavailable source metadata must keep coverage partial');
        assert.ok(/^\d+$/.test(error.objectId));
      }
      assert.equal(new Set(data.items.map(item => item.url)).size, data.items.length);
      assert.ok(data.items.every(item => item.sources.length && item.sources.every(source => source.courseId === courseId)));
      assert.ok(data.items.every(item => item.readMaterialTargets.every(target => target.courseId === courseId && /^\d+$/.test(target.topicId))));
      if (startAt > 0) assert.equal(data.complete, false);
      report({ tool: 'list_recordings', courseId, startAt, recordings: data.items.length,
        providers: [...new Set(data.items.map(item => item.provider))],
        nativeReadTargets: data.items.reduce((count, item) => count + item.readMaterialTargets.length, 0),
        captionLinks: data.captionLinks.length, complete: data.complete, nextStartAt: data.nextStartAt,
        detailsRead: data.coverage.successfulDetails, omissions: data.coverage.omissions.length,
        sourceErrors: data.coverage.errors });
      if (data.nextStartAt === null) break;
      assert.ok(data.nextStartAt > startAt);
      startAt = data.nextStartAt;
    }
  }
  assert.equal(/(?:Error:|Unhandled)/.test(diagnostics), false);
  report({ protocol: 'passed', unexpectedStderr: false, verifiedAt: new Date().toISOString() });
  await mkdir(join(project, '.local'), { recursive: true });
  await writeFile(join(project, '.local', 'last-recordings-mcp-check.json'), JSON.stringify(results, null, 2) + '\n');
} finally { await client.close(); }
