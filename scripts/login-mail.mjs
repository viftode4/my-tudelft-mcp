// Interactive email verification through the compiled MCP. Reports contain no message content or account identifiers.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mailLoginDiagnostic } from '../dist/university-mail.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const client = new Client({ name: 'university-mail-login-check', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(project, 'dist', 'cli.js'), 'serve'], cwd: dirname(project), stderr: 'pipe' });
transport.stderr?.resume();
const checks = [];
const failure = error => ({ code: error.code, message: error.message, details: mailLoginDiagnostic(error.details) });
const report = value => { const item = { ...value, checkedAt: new Date().toISOString() }; checks.push(item); console.log(JSON.stringify(item)); };
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  if (response.isError) {
    const error = value.error ?? value;
    report({ tool: name, error: failure(error) });
    throw new Error('Email verification stopped; see the safe diagnostic above.');
  }
  return value;
}
try {
  await client.connect(transport);
  assert.equal((await call('check_auth')).connected, true);
  const start = await call('begin_mail_login');
  report({ tool: 'begin_mail_login', state: start.state, message: start.message });
  const deadline = Date.now() + 12 * 60_000;
  let previous = start.state, connected = false;
  while (Date.now() < deadline) {
    const status = await call('get_mail_login_status');
    if (status.state !== previous) {
      report({ tool: 'get_mail_login_status', state: status.state, message: status.message,
        error: status.error ? failure(status.error) : undefined });
      previous = status.state;
    }
    if (status.state === 'failed') throw new Error('Email login stopped. Check the safe status and Microsoft login window.');
    if (status.state === 'connected') { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal(connected, true, 'Complete Microsoft sign-in before its timeout.');
  const auth = await call('check_mail_auth');
  assert.equal(auth.authenticated, true); assert.equal(auth.canSend, false);
  report({ tool: 'check_mail_auth', authenticated: auth.authenticated, canSend: auth.canSend, persistence: auth.persistence });
  const folders = await call('list_mail_folders');
  report({ tool: 'list_mail_folders', source: folders.source, itemCount: folders.items.length, complete: folders.complete, hasNextCursor: Boolean(folders.nextCursor) });
  const messages = await call('list_mail_messages', { folderId: 'inbox', limit: 5 });
  report({ tool: 'list_mail_messages', source: messages.source, itemCount: messages.items.length, complete: messages.complete, hasNextCursor: Boolean(messages.nextCursor) });
  if (messages.items[0]) {
    const detail = await call('read_mail', { messageId: messages.items[0].id });
    report({ tool: 'read_mail', source: detail.source, complete: detail.complete, messageFields: Object.keys(detail.message), attachmentsIncluded: detail.attachmentsIncluded, mailboxReadStateChanged: detail.mailboxReadStateChanged });
  }
  const search = await call('search_mail', { query: 'lecture', limit: 5 });
  report({ tool: 'search_mail', source: search.source, itemCount: search.items.length, complete: search.complete, hasNextCursor: Boolean(search.nextCursor) });
  report({ verified: true, draftCreated: false, emailSent: false });
} finally {
  try { await client.close(); report({ processLocalMailSessionEnded: true }); }
  finally {
    await mkdir(join(project, '.local'), { recursive: true });
    await writeFile(join(project, '.local', 'last-mail-login-check.json'), JSON.stringify(checks, null, 2) + '\n');
  }
}
