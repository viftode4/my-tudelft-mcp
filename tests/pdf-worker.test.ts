import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractPdfInWorker } from '../src/documents.js';

test('PDF worker timeout terminates a non-responsive parser without a large fixture', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-worker-test-'));
  assert.equal(dirname(directory), tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'hanging.mjs');
  await writeFile(path, 'setInterval(() => {}, 1000);');
  const started = Date.now();
  await assert.rejects(extractPdfInWorker(Buffer.from('synthetic'), { workerUrl: pathToFileURL(path), timeoutMs: 250 }), { code: 'DOCUMENT_TIMEOUT' });
  assert.ok(Date.now() - started < 5000);
});

test('PDF worker diagnostics never reach MCP stdout/stderr and failures stay sanitized', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-worker-test-'));
  assert.equal(dirname(directory), tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const success = join(directory, 'noisy.mjs'), failure = join(directory, 'failed.mjs');
  await writeFile(success, `import { parentPort, resourceLimits } from 'node:worker_threads';
    console.log('PRIVATE_STDOUT_SENTINEL'); console.error('PRIVATE_STDERR_SENTINEL');
    parentPort.postMessage({ document: { text: String(resourceLimits.maxOldGenerationSizeMb), format: 'pdf', warnings: [] } });`);
  await writeFile(failure, "console.log('PRIVATE_FAILURE_SENTINEL'); throw new Error('https://private.invalid/?token=PRIVATE_ERROR_SENTINEL');");
  const moduleUrl = new URL('../src/documents.ts', import.meta.url).href;
  const program = `import { extractPdfInWorker } from ${JSON.stringify(moduleUrl)};
    const doc = await extractPdfInWorker(Buffer.from('synthetic'), { workerUrl: new URL(${JSON.stringify(pathToFileURL(success).href)}) });
    let error;
    try { await extractPdfInWorker(Buffer.from('synthetic'), { workerUrl: new URL(${JSON.stringify(pathToFileURL(failure).href)}) }); }
    catch (caught) { error = { code: caught.code, message: caught.message }; }
    process.stdout.write(JSON.stringify({ doc, error }));`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(!child.stdout.includes('PRIVATE_'));
  assert.ok(!child.stderr.includes('PRIVATE_'));
  const result = JSON.parse(child.stdout);
  assert.equal(result.doc.text, '256');
  assert.equal(result.error.code, 'DOCUMENT_PARSE_FAILED');
});
