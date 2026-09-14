import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BrightspaceError } from './errors.js';

async function dpapi(input: string, decrypt: boolean): Promise<string> {
  const method = decrypt ? 'Unprotect' : 'Protect';
  // All dynamic data goes through stdin, never through shell source or command-line arguments.
  const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $result = [Security.Cryptography.ProtectedData]::${method}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const fail = () => reject(new BrightspaceError('VAULT_ERROR', 'Could not protect or read the saved session for this Windows user. Log in again.'));
    const timer = setTimeout(() => { child.kill(); fail(); }, 15_000);
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.resume();
    child.stdin.on('error', () => { clearTimeout(timer); fail(); });
    child.on('error', () => { clearTimeout(timer); fail(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && output.trim()) resolve(output.trim()); else fail();
    });
    child.stdin.end(input);
  });
}

export class Vault<T> {
  private path: string;
  constructor(private directory: string, name = 'session') {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new BrightspaceError('VAULT_ERROR', 'The session storage name is not valid.');
    this.path = join(directory, `${name}.vault`);
  }

  async fingerprint(): Promise<string | null> {
    try {
      const info = await stat(this.path, { bigint: true });
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new BrightspaceError('VAULT_ERROR', 'The saved session could not be checked. Log in again.');
    }
  }
  async load(): Promise<T | null> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new BrightspaceError('VAULT_ERROR', 'The saved session could not be read. Log in again.');
    }
    try {
      const envelope = JSON.parse(text) as { format: string; value: string };
      if (!envelope || typeof envelope.format !== 'string' || typeof envelope.value !== 'string') throw new Error('Invalid envelope');
      if (envelope.format === 'dpapi-v1' && process.platform === 'win32') {
        return JSON.parse(Buffer.from(await dpapi(envelope.value, true), 'base64').toString('utf8')) as T;
      }
      if (envelope.format === 'owner-file-v1' && process.platform !== 'win32') return JSON.parse(envelope.value) as T;
      throw new Error('Unsupported envelope');
    } catch { throw new BrightspaceError('VAULT_ERROR', 'The saved session could not be decrypted or is damaged. Log in again.'); }
  }

  async save(value: T, expectedFingerprint?: string | null, preCommit?: () => void): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const json = JSON.stringify(value);
    const envelope = process.platform === 'win32'
      ? { format: 'dpapi-v1', value: await dpapi(Buffer.from(json).toString('base64'), false) }
      : { format: 'owner-file-v1', value: json };
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
      // Encryption may take time. Do not replace a newer session saved during that work.
      if (expectedFingerprint !== undefined && await this.fingerprint() !== expectedFingerprint) {
        throw new BrightspaceError('ACCOUNT_CHANGED', 'The saved session changed while it was being updated. Run check_auth to reconnect.');
      }
      // The caller may cancel during encryption or temporary-file writes. Check at
      // the commit boundary, after all awaited preparation and immediately before rename.
      preCommit?.();
      await rename(temp, this.path);
    } finally { await rm(temp, { force: true }); }
  }

  async clear(): Promise<void> { await rm(this.path, { force: true }); }
}
