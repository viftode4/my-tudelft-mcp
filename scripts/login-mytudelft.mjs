// Normal My TU Delft login through the compiled local MCP. All fixture-free evidence stays in .local.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const client = new Client({ name: 'mytudelft-login-check', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(project, 'dist', 'cli.js'), 'serve'], cwd: dirname(project), stderr: 'pipe' });
transport.stderr?.resume();
const checks = [];
const report = value => { checks.push(value); console.log(JSON.stringify(value)); };
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  if (response.isError) {
    const error = value.error ?? value;
    report({ tool: name, error: { code: error.code, message: error.message, details: error.details }, checkedAt: new Date().toISOString() });
    throw new Error('My TU Delft check failed; see the safe diagnostic above.');
  }
  return value;
}
try {
  await client.connect(transport);
  assert.equal((await call('check_auth')).connected, true);
  const start = await call('begin_mytu_login');
  report({ tool: 'begin_mytu_login', ...start, checkedAt: new Date().toISOString() });
  const deadline = Date.now() + 12 * 60_000;
  let previous = JSON.stringify(start), connected = false;
  while (Date.now() < deadline) {
    const status = await call('get_mytu_login_status');
    if (JSON.stringify(status) !== previous) {
      report({ tool: 'get_mytu_login_status', ...status, checkedAt: new Date().toISOString() }); previous = JSON.stringify(status);
    }
    if (status.state === 'failed') throw new Error('My TU Delft login stopped. The safe status above identifies the next step.');
    if (status.state === 'connected') { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal(connected, true, 'Finish the normal student login before its browser expires.');
  const auth = await call('check_mytu_auth');
  report({ tool: 'check_mytu_auth', connected: auth.connected, accountVerified: auth.accountVerified, identityMethod: auth.identityMethod });
  const grades = await call('list_official_grades', { offset: 0, limit: 5 });
  report({ tool: 'list_official_grades', source: grades.source, accountVerified: grades.accountVerified,
    itemCount: grades.items.length, hasMore: grades.hasMore, itemFields: grades.items[0] ? Object.keys(grades.items[0]) : [], checkedAt: new Date().toISOString() });
  if (grades.items[0]) {
    const detail = await call('get_official_grade', { resultId: grades.items[0].id });
    report({ tool: 'get_official_grade', accountVerified: detail.accountVerified, itemFields: Object.keys(detail.item), checkedAt: new Date().toISOString() });
  }
} finally {
  try {
    await mkdir(join(project, '.local'), { recursive: true });
    await writeFile(join(project, '.local', 'last-mytu-login-check.json'), JSON.stringify(checks, null, 2) + '\n');
  } finally { await client.close(); }
}
