import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrintActions, type PrintTransport, type PrintSettings } from '../src/print-actions.js';

const settings: PrintSettings = { copies: 1, colour: false, duplex: true, staple: false };
async function fixture() {
 const dir = await mkdtemp(join(tmpdir(), 'print-actions-'));
 const path = join(dir, 'notes.pdf'); await writeFile(path, '%PDF-1.4\nsynthetic document');
 let account = 'student-a', uploads = 0, fail = false;
 const transport: PrintTransport = {
  inspect: async () => ({ accountId: account, accountLabel: 'Student A', destination: 'TU Delft Campus Print', settings, cost: { amount: null, currency: 'EUR', explanation: 'Provider does not supply a pre-upload quote.' } }),
  submit: async (_preview, file) => { uploads++; assert.equal(file.filename, 'notes.pdf'); if (fail) throw new Error('secret upstream data'); return { queued: true, jobId: 'job-1' }; },
 };
 const actions = new PrintActions(transport);
 return { actions, path, transport, uploads: () => uploads, switchAccount: () => { account = 'student-b'; }, fail: () => { fail = true; }, close: async () => { actions.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('print preparation snapshots file and exact settings without transmitting bytes', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); assert.equal(f.uploads(), 0); assert.equal(p.file.filename, 'notes.pdf'); assert.match(p.file.sha256, /^[a-f0-9]{64}$/); assert.deepEqual(p.settings, settings); assert.equal(p.cost.amount, null); assert.equal(p.physicalReleaseRequired, true); } finally { await f.close(); }
});
test('print confirmation queues once and consumes the preview', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); assert.equal((await f.actions.confirm(p.confirmationToken, true)).queued, true); await assert.rejects(f.actions.confirm(p.confirmationToken, true), { code: 'INVALID_CONFIRMATION' }); assert.equal(f.uploads(), 1); } finally { await f.close(); }
});
test('a changed file is never uploaded', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); await writeFile(f.path, '%PDF-1.4\nchanged'); await assert.rejects(f.actions.confirm(p.confirmationToken, true), { code: 'FILE_CHANGED' }); assert.equal(f.uploads(), 0); } finally { await f.close(); }
});
test('account change invalidates print approval', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); f.switchAccount(); await assert.rejects(f.actions.confirm(p.confirmationToken, true), { code: 'PRINT_PREVIEW_CHANGED' }); assert.equal(f.uploads(), 0); } finally { await f.close(); }
});
test('changed settings or price require a new preview', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); const old = f.transport.inspect; f.transport.inspect = async s => ({ ...await old(s), cost: { amount: 1, currency: 'EUR', explanation: 'Quote' } }); await assert.rejects(f.actions.confirm(p.confirmationToken, true), { code: 'PRINT_PREVIEW_CHANGED' }); assert.equal(f.uploads(), 0); } finally { await f.close(); }
});
test('an uncertain submission is sanitized and never retried', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); f.fail(); await assert.rejects(f.actions.confirm(p.confirmationToken, true), { code: 'PRINT_OUTCOME_UNCERTAIN' }); await assert.rejects(f.actions.confirm(p.confirmationToken, true), { code: 'INVALID_CONFIRMATION' }); assert.equal(f.uploads(), 1); } finally { await f.close(); }
});
test('explicit confirmation is required', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); await assert.rejects(f.actions.confirm(p.confirmationToken, false), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.uploads(), 0); } finally { await f.close(); }
});
test('concurrent confirmations cannot upload twice', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); const results = await Promise.allSettled([f.actions.confirm(p.confirmationToken, true), f.actions.confirm(p.confirmationToken, true)]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.uploads(), 1); } finally { await f.close(); }
});
test('closing discards approvals', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); f.actions.close(); await assert.rejects(f.actions.confirm(p.confirmationToken, true), { code: 'INVALID_CONFIRMATION' }); } finally { await f.close(); }
});
test('only supported PDF files and bounded settings are accepted', async () => {
 const f = await fixture(); try { await writeFile(f.path, 'not a PDF'); await assert.rejects(f.actions.prepare(f.path, settings), { code: 'INVALID_PRINT_FILE' }); for (const invalid of [{ ...settings, copies: 0 }, { ...settings, copies: 101 }, { ...settings, copies: 1.5 }, { ...settings, colour: 'yes' }]) await assert.rejects(f.actions.prepare(f.path, invalid as PrintSettings), { code: 'INVALID_PRINT_SETTINGS' }); assert.equal(f.uploads(), 0); } finally { await f.close(); }
});
test('expired approvals and evicted old previews cannot upload', async () => {
 const f = await fixture(); let now = 1000; const actions = new PrintActions(f.transport, () => now);
 try { const expired = await actions.prepare(f.path, settings); now += 300001; await assert.rejects(actions.confirm(expired.confirmationToken, true), { code: 'INVALID_CONFIRMATION' }); const first = await actions.prepare(f.path, settings); for (let n = 0; n < 8; n++) await actions.prepare(f.path, settings); await assert.rejects(actions.confirm(first.confirmationToken, true), { code: 'INVALID_CONFIRMATION' }); assert.equal(f.uploads(), 0); } finally { actions.close(); await f.close(); }
});
test('provider setting coercion cannot silently replace requested settings', async () => {
 const f = await fixture(); try { await assert.rejects(f.actions.prepare(f.path, { ...settings, copies: 2 }), { code: 'INVALID_PRINT_SETTINGS' }); } finally { await f.close(); }
});
test('a response without a queue identifier is uncertain', async () => {
 const f = await fixture(); try { f.transport.submit = async () => ({ queued: true, jobId: '' }); const p = await f.actions.prepare(f.path, settings); await assert.rejects(f.actions.confirm(p.confirmationToken, true), { code: 'PRINT_OUTCOME_UNCERTAIN' }); } finally { await f.close(); }
});
test('closing during preparation cannot leave a usable approval', async () => {
 const f = await fixture(); try { const original = f.transport.inspect; f.transport.inspect = async s => { f.actions.close(); return original(s); }; await assert.rejects(f.actions.prepare(f.path, settings), { code: 'PRINT_CANCELLED' }); } finally { await f.close(); }
});
test('closing during confirmation prevents upload', async () => {
 const f = await fixture(); try { const p = await f.actions.prepare(f.path, settings); const original = f.transport.inspect; f.transport.inspect = async s => { f.actions.close(); return original(s); }; await assert.rejects(f.actions.confirm(p.confirmationToken, true), { code: 'PRINT_CANCELLED' }); assert.equal(f.uploads(), 0); } finally { await f.close(); }
});
