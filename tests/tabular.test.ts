import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { extractDocument } from '../src/documents.js';

function archive(parts: Record<string, string>): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, strToU8(value)]))));
}
function workbook(worksheet: string, extra: Record<string, string> = {}): Buffer {
  return archive({
    'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="Feedback" sheetId="7" r:id="feedback"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="feedback" Target="worksheets/sheet7.xml"/></Relationships>',
    'xl/worksheets/sheet7.xml': worksheet,
    ...extra,
  });
}
function notebook(cells: unknown[], extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells, ...extra }));
}

test('XLSX retains workbook order, sheet names, sparse cell references and stored formula results', async () => {
  const bytes = workbook('<worksheet><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="D2"><f>SUM(B2:C2)</f><v>8.5</v></c><c r="F2" t="b"><v>1</v></c></row><row r="5"><c r="B5" t="inlineStr"><is><r><t>Good </t></r><r><t>analysis</t></r></is></c><c r="E5"><f>WEBSERVICE("https://never-request.invalid")</f></c><c r="G5" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>', {
    'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="Overview &amp; marks" r:id="overview"/><sheet name="Feedback" state="hidden" r:id="feedback"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="feedback" Target="worksheets/sheet7.xml"/><Relationship Id="overview" Target="/xl/worksheets/sheet20.xml"/><Relationship Id="external" Target="https://never-request.invalid/secret.xml" TargetMode="External"/></Relationships>',
    'xl/worksheets/sheet20.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Read this first</t></is></c></row></sheetData></worksheet>',
    'xl/sharedStrings.xml': '<sst><si><r><t>Constructive </t></r><r><t>feedback</t></r><rPh><t>phonetic duplicate</t></rPh></si></sst>',
    'xl/worksheets/unused.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>Should not appear</v></c></row></sheetData></worksheet>',
  });
  const result = await extractDocument(bytes, 'feedback.xlsx', 'application/octet-stream');
  assert.equal(result.format, 'xlsx');
  assert.match(result.text, /\[Sheet 1: Overview & marks\][\s\S]*A1: Read this first[\s\S]*\[Sheet 2: Feedback; hidden\]/);
  assert.match(result.text, /\[Row 2\]\nA2: Constructive feedback\nD2: Formula \(not executed\): =SUM\(B2:C2\)\n  Cached value: 8.5\nF2: TRUE/);
  assert.match(result.text, /B5: Good analysis/);
  assert.match(result.text, /Cached value: \[not stored\]/);
  assert.match(result.text, /G5: \[Excel error: #DIV\/0!\]/);
  assert.doesNotMatch(result.text, /phonetic duplicate|Should not appear/);
  assert.match(result.warnings.join(' '), /not executed[\s\S]*may be stale/);
});

test('XLSX MIME routing, implicit addresses, shared formulas and unavailable references are explicit', async () => {
  const bytes = workbook('<s:worksheet xmlns:s="urn:spreadsheet"><s:sheetData><s:row><s:c t="s"><s:v>900</s:v></s:c><s:c><s:f t="shared" si="2"/><s:v>4</s:v></s:c></s:row></s:sheetData></s:worksheet>');
  const result = await extractDocument(bytes, 'download', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(result.text, /A1: \[unavailable shared string\]/);
  assert.match(result.text, /B1: Formula \(not executed\): \[shared formula source unavailable\]\n  Cached value: 4/);
  assert.match(result.warnings.join(' '), /shared-string references/);
  const missing = await extractDocument(workbook('<worksheet/>', {
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="feedback" Target="https://never-request.invalid/sheet.xml" TargetMode="External"/></Relationships>',
  }), 'missing.xlsx', 'application/octet-stream');
  assert.match(missing.text, /Worksheet data unavailable/);
});

test('XLSX rejects invalid workbook shapes and archive expansion before exposing ambiguous values', async () => {
  for (const cells of [
    '<c r="A1"><v>1</v></c><c r="A1"><v>2</v></c>',
    '<c r="XFE1"><v>1</v></c>',
    '<c r="B2"><v>1</v></c>',
  ]) {
    await assert.rejects(extractDocument(workbook('<worksheet><sheetData><row r="1">' + cells + '</row></sheetData></worksheet>'), 'bad.xlsx', 'application/octet-stream'), { code: 'DOCUMENT_PARSE_FAILED' });
  }
  await assert.rejects(extractDocument(workbook('<!DOCTYPE worksheet [<!ENTITY x SYSTEM "file:///private">]><worksheet/>'), 'bad.xlsx', 'application/octet-stream'), { code: 'DOCUMENT_PARSE_FAILED' });
  await assert.rejects(extractDocument(archive({ '../xl/workbook.xml': '<workbook/>' }), 'bad.xlsx', 'application/octet-stream'), { code: 'DOCUMENT_PARSE_FAILED' });
  const bytes = workbook('<worksheet/>');
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(31 * 1024 * 1024, central + 24);
  await assert.rejects(extractDocument(bytes, 'oversized.xlsx', 'application/octet-stream'), { code: 'FILE_TOO_LARGE' });
});

test('CSV supports quoted commas, escaped quotes and line breaks with row/cell provenance', async () => {
  const source = 'Name,Feedback,Score\r\n"Ada","Clear, with ""examples""\r\nNext step",8.5\r\nLin,,=SUM(C2:C3)\r\n';
  const result = await extractDocument(Buffer.from(source), 'feedback.csv', 'text/plain');
  assert.equal(result.format, 'csv');
  assert.match(result.text, /\[Row 2\]\nA2: Ada\nB2: Clear, with "examples"\n  Next step\nC2: 8.5/);
  assert.match(result.text, /\[Row 3\]\nA3: Lin\nB3: \nC3: =SUM\(C2:C3\)/);
  assert.doesNotMatch(result.text, /\[Row 4\]/);
  assert.match(result.warnings.join(' '), /literal text/);
});

test('CSV semicolon dialect preserves decimal commas and TSV preserves empty and UTF-16 cells', async () => {
  const csv = await extractDocument(Buffer.from('Item;Score;Average\nA;7,5;6,2\nB;8,0;7,1'), 'scores.csv', 'application/octet-stream');
  assert.match(csv.text, /B2: 7,5\nC2: 6,2/);
  assert.match(csv.warnings.join(' '), /semicolon/);
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Criterion\tΔ\t\nA\t"Line 1\nLine 2"\t9', 'utf16le')]);
  const tsv = await extractDocument(bytes, 'feedback', 'text/tab-separated-values');
  assert.equal(tsv.format, 'tsv');
  assert.match(tsv.text, /B1: Δ\nC1: \n/);
  assert.match(tsv.text, /B2: Line 1\n  Line 2\nC2: 9/);
});

test('delimited extraction rejects malformed quoting and bounds enormous cells and column counts', async () => {
  for (const source of ['a,"unterminated', 'a,"closed"x', 'a,b"c']) {
    await assert.rejects(extractDocument(Buffer.from(source), 'bad.csv', 'text/csv'), { code: 'DOCUMENT_PARSE_FAILED' });
  }
  await assert.rejects(extractDocument(Buffer.from(','.repeat(16_384)), 'wide.csv', 'text/csv'), { code: 'FILE_TOO_LARGE' });
  const result = await extractDocument(Buffer.from('x'.repeat(2_000_005)), 'large.csv', 'text/csv');
  assert.equal(result.text.length, 2_000_000);
  assert.match(result.warnings.join(' '), /truncated/);
});

test('notebooks retain numbered cells, source and saved textual output without executing code', async () => {
  const bytes = notebook([
    { cell_type: 'markdown', source: ['# Exercise\n', 'Explain the gradient.'], metadata: {} },
    { cell_type: 'code', source: ['raise RuntimeError("never execute me")\n', 'answer = 42'], execution_count: 2, outputs: [
      { output_type: 'stream', name: 'stdout', text: ['Gradient: ', '42\n'] },
      { output_type: 'execute_result', data: { 'text/plain': ['42'], 'text/html': '<script>Never run()</script><b>Duplicate 42</b>', 'image/png': 'ignored-image-data' } },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad input', traceback: ['\u001b[31mTraceback\u001b[0m', 'ValueError: bad input'] },
    ] },
    { cell_type: 'raw', source: 'Raw course notes', metadata: {} },
  ]);
  const result = await extractDocument(bytes, 'assignment.ipynb', 'application/octet-stream');
  assert.equal(result.format, 'ipynb');
  assert.match(result.text, /\[Cell 1: markdown\]\n\[Source\]\n# Exercise\nExplain the gradient\./);
  assert.match(result.text, /\[Cell 2: code\][\s\S]*raise RuntimeError\("never execute me"\)/);
  assert.match(result.text, /\[Saved output 1: stdout\]\nGradient: 42/);
  assert.match(result.text, /\[Saved output 2: text\/plain\]\n42/);
  assert.match(result.text, /\[Saved output 3: error\]\nValueError: bad input\nTraceback\nValueError: bad input/);
  assert.match(result.text, /\[Cell 3: raw\][\s\S]*Raw course notes/);
  assert.doesNotMatch(result.text, /Never run|Duplicate 42|ignored-image-data|\u001b/);
  assert.match(result.warnings.join(' '), /not executed[\s\S]*may be stale/);
});

test('notebook HTML-only outputs are sanitized and unsupported binary output stays out of text', async () => {
  const result = await extractDocument(notebook([{ cell_type: 'code', source: '', outputs: [
    { output_type: 'display_data', data: { 'text/html': ['<style>secret css</style><h1>Grade</h1>', '<script>secret code()</script><p>8 &amp; pass</p><img src="https://never-request.invalid/image"/><input value="secret form"/><iframe src="https://never-request.invalid"/>'] } },
    { output_type: 'display_data', data: { 'image/png': 'private-base64', 'application/javascript': 'secret javascript' } },
  ] }]), 'download', 'application/x-ipynb+json');
  assert.match(result.text, /\[Saved output 1: text\/html\]\nGrade\n8 & pass/);
  assert.doesNotMatch(result.text, /secret|private-base64|never-request/);
  assert.match(result.warnings.join(' '), /no supported textual representation/);
});

test('notebook shape validation and text caps handle malformed and oversized documents safely', async () => {
  await assert.rejects(extractDocument(Buffer.from('{broken private content'), 'bad.ipynb', 'application/octet-stream'), { code: 'DOCUMENT_PARSE_FAILED' });
  await assert.rejects(extractDocument(notebook([], { nbformat: 3 }), 'old.ipynb', 'application/octet-stream'), { code: 'DOCUMENT_PARSE_FAILED' });
  await assert.rejects(extractDocument(notebook([{ cell_type: 'code', source: [42] }]), 'bad.ipynb', 'application/octet-stream'), { code: 'DOCUMENT_PARSE_FAILED' });
  await assert.rejects(extractDocument(notebook(Array(10_001).fill({ cell_type: 'raw', source: '' })), 'large.ipynb', 'application/octet-stream'), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(extractDocument(notebook([{ cell_type: 'code', source: '', outputs: Array(20_001).fill({ output_type: 'stream', text: '' }) }]), 'large.ipynb', 'application/octet-stream'), { code: 'FILE_TOO_LARGE' });
  const result = await extractDocument(notebook([{ cell_type: 'markdown', source: 'x'.repeat(2_000_010) }]), 'large.ipynb', 'application/octet-stream');
  assert.equal(result.text.length, 2_000_000);
  assert.match(result.warnings.join(' '), /truncated/);
});

test('CSV delimiter detection does not mistake decimal commas for semicolon field boundaries', async () => {
  const result = await extractDocument(Buffer.from('Score;Average\n7,5;6,2\n8,0;7,1\n6,9;7,0'), 'scores.csv', 'text/csv');
  assert.match(result.text, /A2: 7,5\nB2: 6,2/);
  assert.match(result.warnings.join(' '), /semicolon/);
});

test('XLSX distinguishes empty cached strings and caps workbook sheet count and XML node growth', async () => {
  const empty = await extractDocument(workbook('<worksheet><sheetData><row><c t="str"><f>""</f><v></v></c></row></sheetData></worksheet>'), 'empty.xlsx', 'application/octet-stream');
  assert.match(empty.text, /Cached value: \[empty\]/);
  const manySheets = workbook('<worksheet/>', {
    'xl/workbook.xml': '<workbook><sheets>' + '<sheet name="A"/>'.repeat(101) + '</sheets></workbook>',
  });
  await assert.rejects(extractDocument(manySheets, 'huge.xlsx', 'application/octet-stream'), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(extractDocument(workbook('<worksheet>' + '<x/>'.repeat(500_001) + '</worksheet>'), 'huge.xlsx', 'application/octet-stream'), { code: 'FILE_TOO_LARGE' });
});

test('notebooks support stored JSON output and bound nested structures before JSON parsing', async () => {
  const result = await extractDocument(notebook([{ cell_type: 'code', source: '', outputs: [
    { output_type: 'execute_result', data: { 'application/json': { grade: 8, criteria: ['correct', 'clear'] } } },
  ] }]), 'result.ipynb', 'application/octet-stream');
  assert.match(result.text, /\[Saved output 1: application\/json\][\s\S]*"grade": 8[\s\S]*"correct"/);
  const nested = '{"nbformat":4,"cells":[],"metadata":' + '['.repeat(129) + '0' + ']'.repeat(129) + '}';
  await assert.rejects(extractDocument(Buffer.from(nested), 'nested.ipynb', 'application/octet-stream'), { code: 'FILE_TOO_LARGE' });
  const wide = '{"nbformat":4,"cells":[],"metadata":[' + '0,'.repeat(500_001) + '0]}';
  await assert.rejects(extractDocument(Buffer.from(wide), 'wide.ipynb', 'application/octet-stream'), { code: 'FILE_TOO_LARGE' });
  const json = await extractDocument(notebook([{ cell_type: 'code', source: '', outputs: [
    { output_type: 'execute_result', data: { 'application/json': { long: 'x'.repeat(100_005) } } },
  ] }]), 'result.ipynb', 'application/octet-stream');
  assert.ok(json.text.length < 101_000);
  assert.match(json.warnings.join(' '), /JSON outputs were truncated/);
});

test('notebook input truncation is reported after HTML and ANSI cleanup even below the final text limit', async () => {
  const ansi = '\u001b[31m'.repeat(400_001);
  for (const source of [ansi + 'Visible tail omitted', [ansi, 'Visible tail omitted']]) {
    const result = await extractDocument(notebook([{ cell_type: 'code', source, outputs: [] }]), 'ansi.ipynb', 'application/octet-stream');
    assert.ok(result.text.length < 100);
    assert.doesNotMatch(result.text, /Visible tail omitted/);
    assert.match(result.warnings.join(' '), /cell source was truncated[\s\S]*before text normalization/);
  }
  const html = '<script>' + 'x'.repeat(2_000_000) + '</script><p>Visible tail omitted</p>';
  for (const data of [html, [html]]) {
    const result = await extractDocument(notebook([{ cell_type: 'code', source: '', outputs: [
      { output_type: 'display_data', data: { 'text/html': data } },
    ] }]), 'html.ipynb', 'application/octet-stream');
    assert.ok(result.text.length < 100);
    assert.doesNotMatch(result.text, /Visible tail omitted/);
    assert.match(result.warnings.join(' '), /display output was truncated[\s\S]*before text normalization/);
  }
});

test('notebook stream and traceback input truncation cannot be hidden by ANSI stripping', async () => {
  const ansi = '\u001b[31m'.repeat(400_001);
  const result = await extractDocument(notebook([{ cell_type: 'code', source: '', outputs: [
    { output_type: 'stream', name: 'stdout', text: [ansi, 'stream tail omitted'] },
    { output_type: 'error', ename: 'Error', evalue: '', traceback: [ansi, 'trace tail omitted'] },
  ] }]), 'outputs.ipynb', 'application/octet-stream');
  assert.ok(result.text.length < 200);
  assert.doesNotMatch(result.text, /tail omitted/);
  assert.match(result.warnings.join(' '), /stream output was truncated/);
  assert.match(result.warnings.join(' '), /error traceback was truncated/);
});

test('large saved notebook output is bounded while later source cells stay readable in their original order', async () => {
  const bytes = notebook([
    { cell_type: 'code', source: 'print(training_log)', outputs: [{ output_type: 'stream', name: 'stdout', text: 'training output\n'.repeat(150_000) }] },
    { cell_type: 'code', source: 'final_answer = compute_solution()', outputs: [{ output_type: 'execute_result', data: { 'text/plain': '42' } }] },
    { cell_type: 'markdown', source: '## Final interpretation\nThe model converged.', metadata: {} },
  ]);
  const result = await extractDocument(bytes, 'verbose.ipynb', 'application/octet-stream');
  assert.ok(result.text.length < 21_000);
  assert.match(result.text, /\[Cell 1: code\][\s\S]*print\(training_log\)[\s\S]*\[Saved output truncated\.\][\s\S]*\[Cell 2: code\][\s\S]*final_answer = compute_solution\(\)[\s\S]*\[Saved output 1: text\/plain\]\n42[\s\S]*\[Cell 3: markdown\][\s\S]*The model converged\./);
  assert.match(result.warnings.join(' '), /each output is limited to 20,000 readable characters/);
});

test('many verbose saved outputs share a cumulative budget that preserves subsequent notebook source', async () => {
  const outputs = Array.from({ length: 40 }, () => ({ output_type: 'stream', name: 'stdout', text: 'x'.repeat(30_000) }));
  const result = await extractDocument(notebook([
    { cell_type: 'code', source: 'run_experiments()', outputs },
    { cell_type: 'code', source: 'important_final_result = 42', outputs },
    { cell_type: 'markdown', source: 'Conclusion after all experiments.' },
  ]), 'many-outputs.ipynb', 'application/octet-stream');
  assert.ok(result.text.length < 501_000);
  assert.match(result.text, /\[Further saved outputs omitted to preserve later source cells\.\][\s\S]*\[Cell 2: code\][\s\S]*important_final_result = 42[\s\S]*\[Cell 3: markdown\][\s\S]*Conclusion after all experiments\./);
  assert.match(result.warnings.join(' '), /500,000-character output budget/);
  assert.equal((result.text.match(/Further saved outputs omitted/g) ?? []).length, 1);
});
