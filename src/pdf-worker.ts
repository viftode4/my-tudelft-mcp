import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { DocumentText } from './documents.js';

// All input is already downloaded bytes. Extraction must never follow PDF-supplied network references.
globalThis.fetch = async () => { throw new Error('Network access is disabled during document extraction.'); };

async function extract(): Promise<DocumentText> {
  const { bytes, maxPages, maxTextLength } = workerData as { bytes: Uint8Array; maxPages: number; maxTextLength: number };
  const task = getDocument({
    data: bytes, useSystemFonts: false, disableFontFace: true, verbosity: 0,
    useWorkerFetch: false, useWasm: false, enableXfa: false, maxImageSize: 0,
  });
  try {
    const pdf = await task.promise;
    const parts: string[] = [], count = Math.min(pdf.numPages, maxPages);
    let length = 0, extractedPages = 0;
    for (let i = 1; i <= count && length <= maxTextLength; i++) {
      const page = await pdf.getPage(i), content = await page.getTextContent();
      const text = `[Page ${i}]\n` + content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      parts.push(text); length += text.length; extractedPages++;
      page.cleanup();
    }
    const text = parts.join('\n\n');
    return { text: text.slice(0, maxTextLength), format: 'pdf', pages: pdf.numPages, warnings: [
      ...(extractedPages < pdf.numPages ? [`Only the first ${extractedPages} pages were extracted because of extraction limits.`] : []),
      ...(text.length > maxTextLength ? ['Extracted text was truncated to 2,000,000 characters.'] : []),
      ...(text.replace(/\[Page \d+\]/g, '').trim().length < 30 ? ['This PDF may be scanned. OCR is not configured.'] : []),
    ] };
  } finally { await task.destroy(); }
}

void extract().then(
  (document) => parentPort?.postMessage({ document }),
  () => parentPort?.postMessage({ error: true }),
).finally(() => parentPort?.close());
