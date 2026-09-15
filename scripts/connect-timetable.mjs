// Supply the private subscription on stdin, or explicitly choose --clipboard on Windows.
// The URL is never printed, put in process arguments, or written to a plaintext file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function input() {
  if (process.argv.includes('--clipboard')) {
    if (process.platform !== 'win32') throw new Error('Use stdin on this platform.');
    try {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { windowsHide: true, timeout: 10_000, maxBuffer: 8192 });
      return stdout.trim();
    } catch { throw new Error('Could not read the copied calendar link.'); }
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 8192) throw new Error('The subscription input is too long.'); chunks.push(chunk); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8').trim();
}
const project = fileURLToPath(new URL('..', import.meta.url));
const client = new Client({ name: 'timetable-connect', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(project, 'dist', 'cli.js'), 'serve'], cwd: project, stderr: 'pipe' });
transport.stderr?.resume();
try {
  const feedUrl = await input();
  await client.connect(transport);
  const result = await client.callTool({ name: 'connect_timetable', arguments: { feedUrl } }, undefined, { timeout: 60_000 });
  const value = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  console.log(JSON.stringify(value));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
