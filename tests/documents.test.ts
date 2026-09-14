import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { extractDocument, safeFilename, saveDownload } from '../src/documents.js';
function zip(parts: Record<string, string>): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, strToU8(value)]))));
}
function pdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
test('PDF preserves page provenance and identifies missing searchable text', async () => {
  const result = await extractDocument(pdf('Vector calculus divergence lecture material for students'), 'lecture.pdf', 'application/pdf');
  assert.equal(result.pages, 1); assert.match(result.text, /\[Page 1\][\s\S]*Vector calculus divergence/);
  assert.equal(result.warnings.length, 0);
  assert.match((await extractDocument(pdf(''), 'scan.pdf', 'application/pdf')).warnings.join(' '), /OCR/);
  await assert.rejects(extractDocument(Buffer.from('broken private URL'), 'bad.pdf', 'application/pdf'), { code: 'DOCUMENT_PARSE_FAILED' });
});
test('PPTX follows presentation order and includes linked speaker notes', async () => {
  const archive = zip({
    'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="300" r:id="second"/><p:sldId id="301" r:id="first"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>Final exercise</a:t></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>Opening &amp; motivation</a:t></p:sld>',
    'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide7.xml"/><Relationship Id="external" Target="https://example.invalid/secret" TargetMode="External"/></Relationships>',
    'ppt/notesSlides/notesSlide7.xml': '<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><a:t>Explain the motivation first.</a:t></p:notes>',
  });
  const result = await extractDocument(archive, 'slides.pptx', 'application/octet-stream');
  assert.equal(result.pages, 2);
  assert.match(result.text, /^\[Slide 1\]\nOpening & motivation\n\[Speaker notes\]\nExplain the motivation first\.\n\n\[Slide 2\]\nFinal exercise$/);
  assert.ok(!result.warnings.some((warning) => /order was unavailable/.test(warning)));
});
test('DOCX extracts paragraphs and tables using only bounded XML', async () => {
  const archive = zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Assignment instructions</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Rubric criteria</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    'word/media/image1.png': 'unneeded image bytes',
  });
  const result = await extractDocument(archive, 'assignment.docx', 'application/octet-stream');
  assert.match(result.text, /Assignment instructions[\s\S]*Rubric criteria/);
  assert.ok(!result.text.includes('unneeded image bytes'));
});
test('Office archives reject expansion limits and traversal before parsing', async () => {
  const inflated = zip({ 'word/document.xml': '<document />' });
  const central = inflated.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); assert.ok(central > 0);
  inflated.writeUInt32LE(31 * 1024 * 1024, central + 24);
  for (const filename of ['bomb.docx', 'bomb.pptx']) await assert.rejects(extractDocument(inflated, filename, 'application/octet-stream'), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(extractDocument(zip({ '../word/document.xml': '<document />' }), 'traversal.docx', 'application/octet-stream'), { code: 'DOCUMENT_PARSE_FAILED' });
});
test('HTML strips active markup; text decoding supports UTF-16 and unsupported binaries', async () => {
  const html = await extractDocument(Buffer.from('<style>hidden</style><h1>Week 1</h1><script>secret()</script><p>Read &amp; prepare<br>Bring notes</p>'), 'page.html', 'text/html');
  assert.equal(html.text, 'Week 1\nRead & prepare\nBring notes');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Δ Lecture notes', 'utf16le')]);
  assert.equal((await extractDocument(utf16, 'notes.txt', 'text/plain')).text, 'Δ Lecture notes');
  const binary = await extractDocument(Buffer.from([0, 1, 2, 3]), 'recording.mp4', 'video/mp4');
  assert.equal(binary.text, ''); assert.match(binary.warnings.join(' '), /unavailable/);
});
test('downloads use safe basenames, deduplicate content and refuse corrupt collisions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-docs-test-')); assert.equal(dirname(directory), tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['CON.txt', 'nul', 'LPT¹.txt', '..', 'CON .txt']) assert.equal(safeFilename(name), 'document');
  assert.equal(safeFilename('../folder/lecture:notes?.pdf'), 'lecture_notes_.pdf');
  assert.ok(!/[. ]$/.test(safeFilename('x'.repeat(159) + '.more')));
  const bytes = Buffer.from('synthetic course document');
  const path = await saveDownload(directory, '..\\private\\lecture.pdf', bytes);
  assert.equal(dirname(path), directory); assert.deepEqual(await readFile(path), bytes);
  assert.equal(await saveDownload(directory, 'lecture.pdf', bytes), path);
  await writeFile(path, Buffer.from('different content'));
  await assert.rejects(saveDownload(directory, 'lecture.pdf', bytes), { code: 'DOWNLOAD_CONFLICT' });
  await rm(path); await mkdir(path);
  await assert.rejects(saveDownload(directory, 'lecture.pdf', bytes), { code: 'DOWNLOAD_CONFLICT' });
});
