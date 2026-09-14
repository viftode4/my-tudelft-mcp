// Interactive Collegerama login through the compiled MCP. Password/MFA stays in the TU Delft browser.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [courseId, topicId] = process.argv.slice(2);
assert.ok(/^\d{1,18}$/.test(courseId ?? '') && /^\d{1,18}$/.test(topicId ?? ''),
  'Usage: node scripts/login-recordings.mjs <own-courseId> <recording-topicId>');
const project = fileURLToPath(new URL('..', import.meta.url));
const client = new Client({ name: 'brightspace-recording-login', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(project, 'dist', 'cli.js'), 'serve'], cwd: dirname(project), stderr: 'pipe' });
transport.stderr?.resume();
const checks = [];
const report = value => { checks.push(value); console.log(JSON.stringify(value)); };
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  if (response.isError) throw new Error(JSON.stringify({ tool: name, error: value.error ?? value }));
  return value;
}
try {
  await client.connect(transport);
  assert.equal((await call('check_auth')).connected, true);
  const status = await call('begin_recording_login', { courseId, topicId });
  report({ tool: 'begin_recording_login', ...status, checkedAt: new Date().toISOString() });
  const deadline = Date.now() + 12 * 60_000;
  let previous = JSON.stringify(status), connected = false;
  while (Date.now() < deadline) {
    const current = await call('get_recording_login_status');
    if (JSON.stringify(current) !== previous) {
      report({ tool: 'get_recording_login_status', ...current, checkedAt: new Date().toISOString() });
      previous = JSON.stringify(current);
    }
    if (current.state === 'failed') throw new Error('Recording login failed: ' + current.message);
    if (current.state === 'connected') { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal(connected, true, 'Finish the university sign-in before its login window expires.');
  const recording = await call('read_recording', { courseId, topicId });
  assert.equal(recording.accountVerified, true);
  assert.equal(recording.metadataVerified, true);
  assert.equal(recording.mediaBytesFetched, false);
  report({ tool: 'read_recording', courseId, topicId, accountVerified: true, metadataVerified: true,
    mediaBytesFetched: false, metadataFields: Object.keys(recording.metadata), chars: recording.totalChars,
    complete: recording.complete, verifiedAt: new Date().toISOString() });
} finally {
  try {
    await mkdir(join(project, '.local'), { recursive: true });
    await writeFile(join(project, '.local', 'last-recording-login-check.json'), JSON.stringify(checks, null, 2) + '\n');
  } finally { await client.close(); }
}
