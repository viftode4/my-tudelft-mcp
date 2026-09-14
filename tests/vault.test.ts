import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/vault.js';

test('vault protects and atomically replaces a session, then removes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-vault-test-'));
  try {
    const vault = new Vault<{ cookie: string }>(directory);
    assert.equal(await vault.load(), null);
    assert.equal(await vault.fingerprint(), null);
    await vault.save({ cookie: 'synthetic-test-cookie' });
    const originalFingerprint = await vault.fingerprint();
    assert.equal(typeof originalFingerprint, 'string');
    assert.deepEqual(await vault.load(), { cookie: 'synthetic-test-cookie' });
    if (process.platform === 'win32') assert.equal((await readFile(join(directory, 'session.vault'), 'utf8')).includes('synthetic-test-cookie'), false);
    await vault.save({ cookie: 'synthetic-replacement' });
    assert.notEqual(await vault.fingerprint(), originalFingerprint);
    assert.deepEqual(await vault.load(), { cookie: 'synthetic-replacement' });
    await vault.clear();
    assert.equal(await vault.load(), null);
    assert.equal(await vault.fingerprint(), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('damaged vault errors contain no saved contents and permit reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-vault-test-'));
  try {
    const vault = new Vault(directory);
    await writeFile(join(directory, 'session.vault'), 'damaged-secret-session');
    await assert.rejects(vault.load(), (error: any) => error.code === 'VAULT_ERROR' && error.message.includes('Log in again') && !error.message.includes('damaged-secret-session'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('vault name cannot escape its storage directory', () => {
  assert.throws(() => new Vault(tmpdir(), '../session'), { code: 'VAULT_ERROR' });
});


test('a guarded vault save refuses to replace a newer saved session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-vault-test-'));
  try {
    const vault = new Vault<{ account: string }>(directory);
    await vault.save({ account: 'original' });
    const original = await vault.fingerprint();
    await vault.save({ account: 'replacement' });
    await assert.rejects(vault.save({ account: 'stale-recovery' }, original), { code: 'ACCOUNT_CHANGED' });
    assert.deepEqual(await vault.load(), { account: 'replacement' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('preCommit cancellation after vault preparation retains the original encrypted file and removes its temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-vault-test-'));
  try {
    const vault = new Vault<{ account: string }>(directory);
    await vault.save({ account: 'working' }); const before = await readFile(join(directory, 'session.vault'), 'utf8');
    const fingerprint = await vault.fingerprint(); let reachedCommit = false;
    await assert.rejects(vault.save({ account: 'cancelled' }, fingerprint, () => { reachedCommit = true; throw new Error('Cancelled at commit boundary.'); }), /Cancelled at commit boundary/);
    assert.equal(reachedCommit, true); assert.equal(await readFile(join(directory, 'session.vault'), 'utf8'), before);
    assert.deepEqual(await vault.load(), { account: 'working' }); assert.deepEqual(await readdir(directory), ['session.vault']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
