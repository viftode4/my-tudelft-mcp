import { load } from 'cheerio';
import { strFromU8, type Unzipped } from 'fflate';
import { posix } from 'node:path';
import { BrightspaceError } from './errors.js';
import { plainText, record } from './util.js';
import type { DocumentText } from './documents.js';

const MAX_CELLS = 100_000;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 16_384;
const MAX_SHEETS = 100;
const MAX_NOTEBOOK_CELLS = 10_000;
const MAX_NOTEBOOK_OUTPUTS = 20_000;
const MAX_NOTEBOOK_OUTPUT_TEXT = 20_000;
const MAX_NOTEBOOK_TOTAL_OUTPUT_TEXT = 500_000;
const MAX_TEXT = 2_000_000;

function tooLarge(message: string): never { throw new BrightspaceError('FILE_TOO_LARGE', message); }
function invalid(message: string): never { throw new BrightspaceError('DOCUMENT_PARSE_FAILED', message); }
function readable(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

class TextBudget {
  private parts: string[] = [];
  private length = 0;
  truncated = false;
  get full(): boolean { return this.length >= MAX_TEXT; }
  add(text: string): void {
    if (!text) return;
    const available = MAX_TEXT - this.length;
    if (text.length > available) this.truncated = true;
    if (available <= 0) return;
    const part = text.slice(0, available);
    this.parts.push(part); this.length += part.length;
  }
  finish(format: string, warnings: string[]): DocumentText {
    if (this.truncated) warnings.push('Extracted text was truncated to 2,000,000 characters.');
    return { text: this.parts.join(''), format, warnings: [...new Set(warnings)] };
  }
}

function xml(bytes: Uint8Array) {
  const text = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) invalid('Office XML declarations with document types or entities are not supported.');
  // Bound DOM object growth before asking the XML parser to allocate nodes.
  let markers = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 60 && ++markers > 500_000) tooLarge('The spreadsheet XML contains too many elements.');
  }
  return load(text, { xml: true });
}
type Xml = ReturnType<typeof xml>;
function elements($: Xml, name: string) {
  return $('*').filter((_, element) => 'name' in element && element.name.split(':').at(-1) === name);
}
function relationId(attributes: Record<string, string>): string | undefined {
  return Object.entries(attributes).find(([key]) => key.split(':').at(-1) === 'id' && key.includes(':'))?.[1];
}
function relatedParts(bytes: Uint8Array | undefined, base: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!bytes) return result;
  const $ = xml(bytes);
  for (const element of elements($, 'Relationship').toArray()) {
    const item = $(element), id = item.attr('Id'), target = item.attr('Target');
    if (!id || !target || item.attr('TargetMode')?.toLowerCase() === 'external' || /[\\?#]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const path = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(base, target));
    if (path.startsWith('../') || !path.startsWith('xl/')) continue;
    if (result.has(id)) invalid('The spreadsheet contains duplicate relationship IDs.');
    result.set(id, path);
  }
  return result;
}
function childText($: Xml, element: Parameters<Xml>[0], name: string): string {
  return $(element).children().filter((_, item) => item.name.split(':').at(-1) === name).first().text();
}
function stringText($: Xml, element: Parameters<Xml>[0]): string {
  const root = $(element).clone();
  root.find('*').filter((_, item) => item.name.split(':').at(-1) === 'rPh').remove();
  return root.find('*').filter((_, item) => item.name.split(':').at(-1) === 't').toArray().map((item) => $(item).text()).join('');
}
function columnName(column: number): string {
  let result = '';
  while (column > 0) { result = String.fromCharCode(65 + (column - 1) % 26) + result; column = Math.floor((column - 1) / 26); }
  return result;
}
function columnNumber(name: string): number {
  let result = 0;
  for (const char of name) result = result * 26 + char.charCodeAt(0) - 64;
  return result;
}
function cellValue($: Xml, cell: Parameters<Xml>[0], shared: string[], warnings: string[]): string {
  const item = $(cell), value = childText($, cell, 'v'), type = item.attr('t');
  if (type === 'inlineStr') return stringText($, cell);
  if (type === 's') {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || shared[Number(value)] === undefined) {
      warnings.push('Some shared-string references were missing or invalid.');
      return '[unavailable shared string]';
    }
    return shared[Number(value)]!;
  }
  if (type === 'b') return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : '[invalid boolean]';
  if (type === 'e') return '[Excel error: ' + value + ']';
  return value;
}

/** SpreadsheetML values are read as stored; formulas and external relationships are never evaluated. */
export function extractSpreadsheet(zip: Unzipped): DocumentText {
  if (!zip['xl/workbook.xml']) invalid('The spreadsheet has no workbook XML.');
  const warnings = ['Spreadsheet formulas are not executed. Cached formula values may be stale; number and date display formatting is not applied. Images, charts and external workbook data are not extracted.'];
  const workbook = xml(zip['xl/workbook.xml']);
  const rels = relatedParts(zip['xl/_rels/workbook.xml.rels'], 'xl');
  const sheets = elements(workbook, 'sheet').toArray();
  if (!sheets.length) invalid('The spreadsheet contains no sheet definitions.');
  if (sheets.length > MAX_SHEETS) tooLarge('Only workbooks with at most 100 sheets can be extracted.');
  const shared: string[] = [];
  const sharedPath = [...rels.values()].find((name) => /(?:^|\/)sharedStrings\.xml$/i.test(name)) ?? 'xl/sharedStrings.xml';
  if (zip[sharedPath]) {
    const $ = xml(zip[sharedPath]);
    const strings = elements($, 'si').toArray();
    if (strings.length > MAX_CELLS) tooLarge('The spreadsheet shared-string table exceeds 100,000 entries.');
    for (const item of strings) shared.push(stringText($, item));
  }
  const text = new TextBudget(), usedSheets = new Set<string>();
  let cellCount = 0, rowCount = 0;
  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
    if (text.full) { text.truncated = true; break; }
    const definition = sheets[sheetIndex]!, entry = workbook(definition);
    const name = entry.attr('name') ?? 'Sheet ' + (sheetIndex + 1);
    const path = rels.get(relationId(entry.attr() ?? {}) ?? '');
    const state = entry.attr('state');
    text.add('\n[Sheet ' + (sheetIndex + 1) + ': ' + readable(name) + (state && state !== 'visible' ? '; ' + state : '') + ']\n');
    if (!path || !/^xl\/worksheets\/[^/]+\.xml$/i.test(path) || !zip[path]) {
      text.add('[Worksheet data unavailable]\n'); warnings.push('Some workbook sheets did not have readable worksheet XML.'); continue;
    }
    if (usedSheets.has(path)) invalid('The spreadsheet links more than one sheet definition to the same worksheet.');
    usedSheets.add(path);
    const $ = xml(zip[path]);
    const rows = elements($, 'row').filter((_, row) => $(row).parent().get(0)?.name.split(':').at(-1) === 'sheetData').toArray();
    const refs = new Set<string>();
    let previousRow = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      if (text.full) { text.truncated = true; break; }
      if (++rowCount > MAX_ROWS) tooLarge('The spreadsheet exceeds 100,000 rows.');
      const row = rows[rowIndex]!, rawRow = $(row).attr('r');
      const rowNumber = rawRow === undefined ? previousRow + 1 : /^\d+$/.test(rawRow) ? Number(rawRow) : NaN;
      if (!Number.isSafeInteger(rowNumber) || rowNumber <= previousRow || rowNumber > 1_048_576) invalid('The spreadsheet contains invalid or unordered row references.');
      previousRow = rowNumber;
      const cells = $(row).children().filter((_, item) => item.name.split(':').at(-1) === 'c').toArray();
      let previousColumn = 0, emittedRow = false;
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
        if (text.full) { text.truncated = true; break; }
        if (++cellCount > MAX_CELLS) tooLarge('The spreadsheet exceeds 100,000 cells.');
        const cell = cells[cellIndex]!, item = $(cell), rawRef = item.attr('r');
        const ref = rawRef ?? columnName(previousColumn + 1) + rowNumber;
        const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref), column = match ? columnNumber(match[1]!) : NaN;
        if (!match || !Number.isSafeInteger(column) || column <= previousColumn || column > MAX_COLUMNS || Number(match[2]) !== rowNumber || refs.has(ref)) {
          invalid('The spreadsheet contains invalid, duplicate or unordered cell references.');
        }
        refs.add(ref); previousColumn = column;
        let value = cellValue($, cell, shared, warnings);
        const formula = item.children().filter((_, node) => node.name.split(':').at(-1) === 'f').first();
        if (formula.length) {
          const source = formula.text();
          const details = source ? '=' + source : '[' + (formula.attr('t') ?? 'shared') + ' formula source unavailable]';
          const hasCachedValue = item.children().toArray().some((node) => node.name.split(':').at(-1) === 'v');
          value = 'Formula (not executed): ' + details + '\nCached value: ' + (value || (hasCachedValue ? '[empty]' : '[not stored]'));
        }
        if (!value && !formula.length) continue;
        if (!emittedRow) { text.add('[Row ' + rowNumber + ']\n'); emittedRow = true; }
        text.add(ref + ': ' + readable(value).replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ') + '\n');
      }
    }
  }
  return text.finish('xlsx', warnings);
}

/** RFC 4180 quoting, with tab/semicolon dialects selected without evaluating spreadsheet expressions. */
export function extractDelimited(source: string, format: 'csv' | 'tsv'): DocumentText {
  const warnings: string[] = [], text = new TextBudget();
  const delimiter = format === 'tsv' ? '\t' : detectDelimiter(source);
  if (format === 'csv' && delimiter !== ',') warnings.push('Detected ' + (delimiter === ';' ? 'semicolon' : 'tab') + '-separated CSV fields.');
  let field = '', row: string[] = [], quoted = false, afterQuote = false, atStart = true;
  let rowNumber = 0, cellCount = 0, dataSinceNewline = false;
  const emitCell = (): void => {
    if (row.length >= MAX_COLUMNS || ++cellCount > MAX_CELLS) tooLarge('The delimited file exceeds 100,000 cells or 16,384 columns.');
    row.push(field); field = ''; atStart = true; afterQuote = false;
  };
  const emitRow = (): void => {
    if (++rowNumber > MAX_ROWS) tooLarge('The delimited file exceeds 100,000 rows.');
    text.add('[Row ' + rowNumber + ']\n');
    row.forEach((value, index) => text.add(columnName(index + 1) + rowNumber + ': ' + readable(value).replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ') + '\n'));
    row = []; dataSinceNewline = false;
  };
  for (let i = 0; i < source.length; i++) {
    if (text.full) { text.truncated = true; break; }
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; } else { quoted = false; afterQuote = true; }
      } else field += char;
      if (field.length > MAX_TEXT) { field = field.slice(0, MAX_TEXT); emitCell(); emitRow(); text.truncated = true; break; }
      continue;
    }
    if (char === '"') {
      if (!atStart || afterQuote) invalid('The delimited file contains an invalid quoted field.');
      quoted = true; atStart = false; dataSinceNewline = true;
    } else if (char === delimiter) {
      emitCell(); dataSinceNewline = true;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      emitCell(); emitRow();
    } else {
      if (afterQuote) invalid('The delimited file contains text after a closing field quote.');
      field += char; atStart = false; dataSinceNewline = true;
      if (field.length > MAX_TEXT) { field = field.slice(0, MAX_TEXT); emitCell(); emitRow(); text.truncated = true; break; }
    }
  }
  if (!text.truncated) {
    if (quoted) invalid('The delimited file contains an unterminated quoted field.');
    if (field.length || row.length || dataSinceNewline) { emitCell(); emitRow(); }
  }
  warnings.push('Delimited values are literal text; spreadsheet formulas are not executed.');
  return text.finish(format, warnings);
}

function detectDelimiter(source: string): string {
  const candidates = [',', ';', '\t'], rows: number[][] = [];
  let counts = [0, 0, 0], quoted = false, nonempty = false, index = 0;
  for (; index < source.length && index < 65_536 && rows.length < 5; index++) {
    const i = index;
    const char = source[i]!;
    if (char === '"') {
      if (quoted && source[i + 1] === '"') index++; else quoted = !quoted;
    } else if (!quoted) {
      if (char === '\n' || char === '\r' && source[i + 1] !== '\n') {
        if (nonempty) rows.push(counts);
        counts = [0, 0, 0]; nonempty = false;
      } else {
        const candidate = candidates.indexOf(char);
        if (candidate >= 0) counts[candidate] = counts[candidate]! + 1;
      }
    }
    if (char !== '\r' && char !== '\n') nonempty = true;
  }
  if (index === source.length && nonempty) rows.push(counts);
  if (!rows.length) rows.push(counts);
  // A consistent separator beats decimal commas occurring only in numeric rows.
  return candidates.map((delimiter, index) => {
    const values = rows.map((row) => row[index]!);
    const positive = values.filter((count) => count > 0);
    const consistent = positive.length === values.length && values.every((count) => count === values[0]);
    return { delimiter, score: (consistent ? 1_000_000 : 0) + positive.length * 10_000 + values.reduce((sum, count) => sum + count, 0) };
  }).sort((a, b) => b.score - a.score)[0]!.delimiter;
}

function multiline(value: unknown, field: string, warnings: string[]): string {
  if (value === undefined) return '';
  const warn = (): void => { warnings.push('Notebook ' + field + ' was truncated to 2,000,000 input characters before text normalization.'); };
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) warn();
    return value.slice(0, MAX_TEXT);
  }
  if (!Array.isArray(value) || value.length > MAX_CELLS || value.some((item) => typeof item !== 'string')) {
    invalid('The notebook has an invalid ' + field + ' text field.');
  }
  let result = '';
  for (const part of value as string[]) {
    const available = MAX_TEXT - result.length;
    if (part.length > available) { warn(); return result + part.slice(0, available); }
    result += part;
  }
  return result;
}

function checkNotebookShape(source: string): void {
  let quoted = false, depth = 0, tokens = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '\\') index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') {
      if (++depth > 128 || ++tokens > 500_000) tooLarge('The notebook JSON nesting or structure exceeds the extraction limit.');
    } else if (char === ']' || char === '}') depth--;
    else if ((char === ':' || char === ',') && ++tokens > 500_000) tooLarge('The notebook JSON structure exceeds the extraction limit.');
  }
}

function jsonOutput(value: unknown): { text: string; truncated: boolean } {
  let nodes = 0, characters = 0, truncated = false;
  const bounded = (item: unknown, depth: number): unknown => {
    if (++nodes > 10_000 || depth > 16 || characters >= 100_000) { truncated = true; return '[JSON output truncated]'; }
    if (typeof item === 'string') {
      const available = 100_000 - characters;
      characters += Math.min(item.length, available);
      if (item.length > available) truncated = true;
      return item.slice(0, available);
    }
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (const child of item) {
        result.push(bounded(child, depth + 1));
        if (nodes >= 10_000 || characters >= 100_000) { if (result.length < item.length) truncated = true; break; }
      }
      return result;
    }
    if (item && typeof item === 'object') {
      const entries: [string, unknown][] = [];
      for (const [key, child] of Object.entries(item)) {
        characters += key.length;
        entries.push([key.slice(0, 1000), bounded(child, depth + 1)]);
        if (key.length > 1000) truncated = true;
        if (nodes >= 10_000 || characters >= 100_000) { truncated = true; break; }
      }
      return Object.fromEntries(entries);
    }
    return item;
  };
  return { text: JSON.stringify(bounded(value, 0), null, 2), truncated };
}

/** Read saved notebook content only. Kernels, widget code, scripts and attachments are never launched. */
export function extractNotebook(source: string): DocumentText {
  if (source.length > 20 * 1024 * 1024) tooLarge('The notebook JSON exceeds the 20 MB extraction limit.');
  checkNotebookShape(source);
  const notebook = record(JSON.parse(source));
  if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells)) invalid('Only Jupyter notebooks in nbformat version 4 are supported.');
  if (notebook.cells.length > MAX_NOTEBOOK_CELLS) tooLarge('The notebook exceeds 10,000 cells.');
  const warnings = ['Notebook code is not executed. Outputs are saved results and may be stale. Binary outputs, widgets and attachments are not extracted.'];
  const text = new TextBudget();
  let outputCount = 0, savedOutputCharacters = 0, outputBudgetReached = false;
  const addOutput = (header: string, value: string): void => {
    const body = readable(value), marker = '\n[Saved output truncated.]';
    const remaining = MAX_NOTEBOOK_TOTAL_OUTPUT_TEXT - savedOutputCharacters - header.length - 1;
    const limit = Math.max(0, Math.min(MAX_NOTEBOOK_OUTPUT_TEXT, remaining - marker.length));
    const truncated = body.length > limit;
    const rendered = header + body.slice(0, limit) + (truncated ? marker : '') + '\n';
    savedOutputCharacters += rendered.length;
    text.add(rendered);
    if (truncated) warnings.push('Saved notebook output was truncated: each output is limited to 20,000 readable characters, and saved output text together is limited to 500,000 characters so later source cells remain readable.');
  };
  for (let index = 0; index < notebook.cells.length; index++) {
    if (text.full) { text.truncated = true; break; }
    const cell = record(notebook.cells[index]), type = cell.cell_type;
    if (!['code', 'markdown', 'raw'].includes(String(type))) { warnings.push('Some unrecognized notebook cells were omitted.'); continue; }
    text.add('\n[Cell ' + (index + 1) + ': ' + type + ']\n[Source]\n' + readable(multiline(cell.source, 'cell source', warnings)) + '\n');
    if (type !== 'code' || cell.outputs === undefined) continue;
    if (!Array.isArray(cell.outputs)) invalid('The notebook contains an invalid outputs list.');
    outputCount += cell.outputs.length;
    if (outputCount > MAX_NOTEBOOK_OUTPUTS) tooLarge('The notebook exceeds 20,000 stored outputs.');
    for (let outputIndex = 0; outputIndex < cell.outputs.length; outputIndex++) {
      if (text.full) { text.truncated = true; break; }
      if (savedOutputCharacters >= MAX_NOTEBOOK_TOTAL_OUTPUT_TEXT - 256) {
        if (!outputBudgetReached) {
          text.add('[Further saved outputs omitted to preserve later source cells.]\n');
          warnings.push('Further saved notebook outputs were omitted after reaching the 500,000-character output budget; subsequent source cells were still extracted.');
          outputBudgetReached = true;
        }
        break;
      }
      const output = record(cell.outputs[outputIndex]), kind = output.output_type;
      const prefix = '[Saved output ' + (outputIndex + 1) + ': ';
      if (kind === 'stream') {
        addOutput(prefix + (output.name === 'stderr' ? 'stderr' : 'stdout') + ']\n', multiline(output.text, 'stream output', warnings));
      } else if (kind === 'error') {
        const name = typeof output.ename === 'string' ? output.ename : 'Error';
        const value = typeof output.evalue === 'string' ? output.evalue : '';
        const trace = Array.isArray(output.traceback) ? output.traceback.map((line) => typeof line === 'string' ? line + '\n' : line) : output.traceback;
        addOutput(prefix + 'error]\n', name + ': ' + value + '\n' + multiline(trace, 'error traceback', warnings));
      } else if (kind === 'display_data' || kind === 'execute_result') {
        const data = record(output.data);
        const mime = ['text/plain', 'text/markdown', 'text/html', 'application/json'].find((name) => data[name] !== undefined);
        if (!mime) { warnings.push('Some notebook outputs had no supported textual representation.'); continue; }
        const json = mime === 'application/json' ? jsonOutput(data[mime]) : undefined;
        if (json?.truncated) warnings.push('Some stored JSON outputs were truncated to bounded text and structure.');
        const value = json ? json.text : multiline(data[mime], 'display output', warnings);
        addOutput(prefix + mime + ']\n', mime === 'text/html' ? plainText(value) : value);
      } else warnings.push('Some unrecognized notebook outputs were omitted.');
    }
  }
  return text.finish('ipynb', warnings);
}
