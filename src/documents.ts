import { startParsingWorker } from './worker.js';
import mammoth from 'mammoth';
import { unzipSync, zipSync, strFromU8, type Unzipped } from 'fflate';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, lstat, readFile } from 'node:fs/promises';
import { join, basename, extname, posix } from 'node:path';
import { BrightspaceError } from './errors.js';
import { plainText } from './util.js';
import { extractDelimited, extractNotebook, extractSpreadsheet } from './tabular.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_XML_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_LENGTH = 2_000_000;
export interface DocumentText { text: string; format: string; pages?: number; warnings: string[]; }

/** A separate worker keeps parser logs off MCP stdout and makes slow PDF parsing cancellable. */
export async function extractPdfInWorker(bytes: Buffer, options: { workerUrl?: URL; timeoutMs?: number } = {}): Promise<DocumentText> {
  const workerUrl = options.workerUrl ?? new URL(import.meta.url.endsWith('.ts') ? './pdf-worker.ts' : './pdf-worker.js', import.meta.url);
  const data = Uint8Array.from(bytes);
  return new Promise<DocumentText>((resolve, reject) => {
    const worker = startParsingWorker(workerUrl, {
      workerData: { bytes: data, maxPages: 600, maxTextLength: MAX_TEXT_LENGTH }, transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true, stderr: true,
    });
    // Parser diagnostics can contain document text. Discard both streams rather than forwarding them.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (error?: BrightspaceError, result?: DocumentText): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const settle = () => error ? reject(error) : resolve(result!);
      void worker.terminate().then(settle, settle);
    };
    const timer = setTimeout(() => finish(new BrightspaceError('DOCUMENT_TIMEOUT', 'PDF extraction exceeded its time limit. Try a smaller document.')), options.timeoutMs ?? 30_000);
    worker.once('message', (message: { document?: DocumentText; error?: boolean }) => {
      if (!message.document || typeof message.document.text !== 'string' || message.document.format !== 'pdf' || !Array.isArray(message.document.warnings)) {
        finish(new BrightspaceError('DOCUMENT_PARSE_FAILED', 'This PDF could not be parsed. It may be damaged or encrypted.'));
      } else finish(undefined, message.document);
    });
    worker.once('error', () => finish(new BrightspaceError('DOCUMENT_PARSE_FAILED', 'PDF extraction stopped unexpectedly or exceeded its memory limit.')));
    worker.once('exit', () => {
      if (!settled) finish(new BrightspaceError('DOCUMENT_PARSE_FAILED', 'PDF extraction ended without a result.'));
    });
  });
}

export function safeFilename(input: string): string {
  // Truncate before trimming: a cut can otherwise introduce a final dot or space on Windows.
  const name = basename(input.replace(/\\/g, '/')).normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '_')
    .slice(0, 160).replace(/[. ]+$/, '');
  return !name || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[. ]|$)/i.test(name) ? 'document' : name;
}

/** Keep only bounded XML parts. Neither archive filenames nor relationships reach the filesystem. */
function officeXml(bytes: Buffer): Unzipped {
  let count = 0, xmlBytes = 0, totalBytes = 0;
  const names = new Set<string>();
  return unzipSync(bytes, { filter: (entry) => {
    count++;
    if (count > 8192 || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
      throw new BrightspaceError('FILE_TOO_LARGE', 'The Office archive exceeds the extraction limit.');
    }
    if (names.has(entry.name) || entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').includes('..')) {
      throw new BrightspaceError('DOCUMENT_PARSE_FAILED', 'The Office archive contains ambiguous paths.');
    }
    names.add(entry.name);
    totalBytes += entry.originalSize;
    if (totalBytes > 256 * 1024 * 1024) throw new BrightspaceError('FILE_TOO_LARGE', 'The expanded Office archive exceeds 256 MB.');
    if (!/\.(?:xml|rels)$/i.test(entry.name)) return false;
    // Stored ZIP entries consume their compressed size even if the declared original size is invalid.
    xmlBytes += Math.max(entry.originalSize, entry.compression === 0 ? entry.size : 0);
    if (xmlBytes > MAX_XML_BYTES) throw new BrightspaceError('FILE_TOO_LARGE', 'The Office XML exceeds the 30 MB extraction limit.');
    return true;
  } });
}

function xmlText(bytes: Uint8Array): string {
  const $ = load(strFromU8(bytes), { xml: true });
  return $('*').filter((_, element) => 'name' in element && element.name.split(':').at(-1) === 't')
    .toArray().map((element) => $(element).text()).join('\n');
}

function relationships(bytes: Uint8Array | undefined, base: string): Map<string, string> {
  if (!bytes) return new Map();
  const $ = load(strFromU8(bytes), { xml: true });
  const result = new Map<string, string>();
  $('*').filter((_, element) => 'name' in element && element.name.split(':').at(-1) === 'Relationship').each((_, element) => {
    const id = $(element).attr('Id'), target = $(element).attr('Target');
    if (!id || !target || $(element).attr('TargetMode') === 'External' || target.includes('\\') || /^[a-z]+:/i.test(target)) return;
    const path = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(base, target));
    if (!path.startsWith('../')) result.set(id, path);
  });
  return result;
}

function slides(zip: Unzipped): DocumentText {
  let names: string[] = [];
  if (zip['ppt/presentation.xml']) {
    const rels = relationships(zip['ppt/_rels/presentation.xml.rels'], 'ppt');
    const $ = load(strFromU8(zip['ppt/presentation.xml']), { xml: true });
    $('*').filter((_, element) => 'name' in element && element.name.split(':').at(-1) === 'sldId').each((_, element) => {
      const path = rels.get($(element).attr('r:id') ?? '');
      if (path && /^ppt\/slides\/[^/]+\.xml$/.test(path) && zip[path]) names.push(path);
    });
  }
  const warnings = ['Image-only content is not extracted; OCR is not configured.'];
  if (!names.length) {
    names = Object.keys(zip).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/slide(\d+)/.exec(a)?.[1]) - Number(/slide(\d+)/.exec(b)?.[1]));
    if (names.length) warnings.push('Presentation order was unavailable; slides use their archive numbering.');
  }
  if (!names.length) throw new BrightspaceError('DOCUMENT_PARSE_FAILED', 'This presentation contains no readable slide XML.');
  const parts = names.slice(0, 600).map((name, index) => {
    const rels = relationships(zip[posix.join(posix.dirname(name), '_rels', posix.basename(name) + '.rels')], posix.dirname(name));
    const note = [...rels.values()].find((path) => /^ppt\/notesSlides\/[^/]+\.xml$/.test(path) && zip[path]);
    return `[Slide ${index + 1}]\n${xmlText(zip[name]!)}` + (note ? `\n[Speaker notes]\n${xmlText(zip[note]!)}` : '');
  });
  if (names.length > 600) warnings.push('Only the first 600 slides were extracted.');
  return { text: parts.join('\n\n'), format: 'pptx', pages: names.length, warnings };
}

function textFile(bytes: Buffer): { text: string; warnings: string[] } {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try { return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), warnings: [] }; }
  catch { return { text: new TextDecoder(encoding).decode(bytes), warnings: ['Some text bytes could not be decoded and were replaced.'] }; }
}

export async function extractDocument(bytes: Buffer, filename: string, contentType: string): Promise<DocumentText> {
  if (bytes.length > MAX_FILE_BYTES) throw new BrightspaceError('FILE_TOO_LARGE', 'This file exceeds the 50 MB extraction limit.');
  try {
    const result = await extract(bytes, filename, contentType.toLowerCase());
    if (result.text.length > MAX_TEXT_LENGTH) {
      result.text = result.text.slice(0, MAX_TEXT_LENGTH);
      result.warnings.push('Extracted text was truncated to 2,000,000 characters.');
    }
    return result;
  } catch (error) {
    if (error instanceof BrightspaceError) throw error;
    throw new BrightspaceError('DOCUMENT_PARSE_FAILED', 'This file could not be parsed. It may be damaged, encrypted, or in an unsupported format.');
  }
}

async function extract(bytes: Buffer, filename: string, contentType: string): Promise<DocumentText> {
  const extension = extname(filename).toLowerCase();
  if (bytes.subarray(0, 5).toString() === '%PDF-' || extension === '.pdf' || contentType.includes('application/pdf')) {
    return extractPdfInWorker(bytes);
  }
  if (extension === '.docx' || contentType.includes('wordprocessingml')) {
    const zip = officeXml(bytes);
    if (!zip['word/document.xml']) throw new BrightspaceError('DOCUMENT_PARSE_FAILED', 'The Word document has no document XML.');
    // Repacking bounded XML prevents the downstream parser from expanding unrelated media or unverified ZIP entries.
    const result = await mammoth.extractRawText({ buffer: Buffer.from(zipSync(zip, { level: 0 })) });
    return { text: result.value, format: 'docx', warnings: result.messages.length ? ['Some document formatting could not be extracted.'] : [] };
  }
  if (extension === '.pptx' || contentType.includes('presentationml')) return slides(officeXml(bytes));
  if (extension === '.xlsx' || contentType.includes('spreadsheetml')) return extractSpreadsheet(officeXml(bytes));
  if (extension === '.ipynb' || contentType.includes('application/x-ipynb+json')) {
    const decoded = textFile(bytes), result = extractNotebook(decoded.text);
    result.warnings.push(...decoded.warnings);
    return result;
  }
  if (['.csv', '.tsv'].includes(extension) || contentType.includes('text/csv') || contentType.includes('text/tab-separated-values')) {
    const decoded = textFile(bytes), format = extension === '.tsv' || contentType.includes('text/tab-separated-values') ? 'tsv' : 'csv';
    const result = extractDelimited(decoded.text, format);
    result.warnings.push(...decoded.warnings);
    return result;
  }
  if (contentType.includes('html') || ['.html', '.htm'].includes(extension)) {
    const decoded = textFile(bytes);
    return { text: plainText(decoded.text), format: 'html', warnings: decoded.warnings };
  }
  if (contentType.startsWith('text/') || ['.txt', '.md', '.csv', '.json', '.xml', '.vtt', '.srt', '.py', '.java', '.js', '.ts', '.r', '.c', '.cpp', '.tex'].includes(extension)) {
    return { ...textFile(bytes), format: extension.slice(1) || 'text' };
  }
  return { text: '', format: extension.slice(1) || contentType || 'binary', warnings: ['Downloaded successfully; text extraction is unavailable for this format.'] };
}

export async function saveDownload(directory: string, filename: string, bytes: Buffer): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12), path = join(directory, `${hash}-${safeFilename(filename)}`);
  try { await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length || !(await readFile(path)).equals(bytes)) {
      throw new BrightspaceError('DOWNLOAD_CONFLICT', 'The download destination already contains a different file. Choose another download directory.');
    }
  }
  return path;
}
