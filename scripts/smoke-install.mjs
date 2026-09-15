// Credential-free check: never uses the student's saved sessions.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const dataDir = await mkdtemp(join(tmpdir(), 'brightspace-install-'));
const client = new Client({ name: 'installation-check', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'serve'],
  env: { ...getDefaultEnvironment(), BRIGHTSPACE_DATA_DIR: dataDir },
  stderr: 'pipe',
});
transport.stderr?.resume();
try {
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['check_auth', 'list_courses', 'get_official_programme', 'get_timetable', 'begin_mail_login']) {
    assert.ok(tools.some(tool => tool.name === name), `Missing tool: ${name}`);
  }
  const { resources } = await client.listResources();
  assert.ok(resources.some(resource => resource.uri === 'brightspace://usage'));
  const usage = await client.readResource({ uri: 'brightspace://usage' });
  assert.ok(usage.contents.length > 0);
  console.log(JSON.stringify({ installed: true, chromium: 'passed', protocol: 'passed', tools: tools.length, universityAuthentication: 'not tested' }));
} finally {
  try { await client.close(); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}
