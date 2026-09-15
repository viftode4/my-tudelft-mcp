import { load } from 'cheerio';
import { BrightspaceError } from './errors.js';
import { plainText, record, safeSourceUrl, type Row } from './util.js';
const SOFTWARE = 'https://softwarefinder.tudelft.nl';
const ROOMS = 'https://esviewer.tudelft.nl';
const SPACES = 'https://spacefinder.tudelft.nl';
const ICT = 'https://meldingen-ict.tudelft.nl';
const fail = (): never => { throw new BrightspaceError('PUBLIC_FORMAT_CHANGED', 'The public service returned an unrecognised format. No empty-result claim can be made.'); };
const text = (value: unknown): string => plainText(value).replace(/https?:\/\/[^\s<>"']+/gi, url => safeSourceUrl(url, SOFTWARE) ?? '[link omitted]').slice(0, 20000);
export async function publicCampusFetch(input: string, request: typeof fetch = fetch): Promise<string> {
  const u = new URL(input);
  const allowed = !u.username && !u.password && !u.hash && (
    u.origin === SOFTWARE && !u.search && (/^\/package\/[0-9]{1,10}\/$/.test(u.pathname) || u.pathname === '/')
    || u.origin === ROOMS && u.pathname === '/' && !u.search
    || u.origin === SPACES && u.pathname === '/en/spaces/' && !u.search
    || u.origin === ICT && /^\/api\/(incidents|maintenance|information)\/$/.test(u.pathname) && /^\?format=json&page=[1-9][0-9]{0,3}$/.test(u.search));
  if (!allowed) throw new BrightspaceError('INVALID_PUBLIC_ROUTE', 'Only observed public campus routes are supported.');
  let response: Response | undefined;
  try {
    response = await request(u.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(25000), headers: { Accept: 'text/html, application/json' } });
    if (!response.ok || !/text\/html|application\/json/i.test(response.headers.get('content-type') ?? '')) throw new BrightspaceError('PUBLIC_UNAVAILABLE', 'The public service is unavailable or requires authentication.');
    const reader = response.body?.getReader(); if (!reader) return fail();
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2_000_000) throw new BrightspaceError('PUBLIC_RESPONSE_LIMIT', 'The public response exceeds 2 MB.'); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (error instanceof BrightspaceError) throw error;
    throw new BrightspaceError('PUBLIC_UNAVAILABLE', 'The public service could not be reached.');
  } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined); }
}
function page(items: Row[], query: string, offset = 0) {
  if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new BrightspaceError('INVALID_RANGE', 'Use a query up to 200 characters and offset 0 to 10000.');
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = items.filter(item => terms.every(term => JSON.stringify(item).toLowerCase().includes(term)));
  return { items: matches.slice(offset, offset + 25), total: matches.length, offset, complete: offset + 25 >= matches.length, nextOffset: offset + 25 < matches.length ? offset + 25 : null };
}
function source(sourceUrl: string) { return { sourceUrl, fetchedAt: new Date().toISOString(), authentication: 'anonymous', contentIsUntrusted: true }; }
/** Decode only the observed Nuxt data subset, without evaluating scripts or reading public API keys. */
export function parseSpaces(html: string): Row[] {
  const $ = load(html); let values: unknown[];
  try { values = JSON.parse($('#__NUXT_DATA__').text()); } catch { return fail(); }
  if (!Array.isArray(values) || values.length > 20000) return fail();
  let visits = 0;
  const decode = (index: unknown, depth = 0): unknown => {
    if (++visits > 50000 || depth > 30 || !Number.isInteger(index) || Number(index) < 0 || Number(index) >= values.length) return fail();
    const v = values[Number(index)];
    if (Array.isArray(v)) {
      if (['Ref', 'Reactive', 'ShallowRef', 'ShallowReactive'].includes(String(v[0]))) return decode(v[1], depth + 1);
      if (v[0] === 'EmptyRef') return null;
      return v.map(i => decode(i, depth + 1));
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, i]) => [k, decode(i, depth + 1)]));
    return v;
  };
  const state = record(record(record(decode(0)).pinia).spaces);
  if (!Array.isArray(state.spacesI18n) || !Array.isArray(state.buildingsI18n)) return fail();
  const buildings = new Map(state.buildingsI18n.map(b => { const row = record(b); return [row.number, text(record(record(row.i18n).en).name)]; }));
  return state.spacesI18n.map(value => {
    const row = record(value), en = record(record(row.i18n).en);
    if (typeof row.spaceId !== 'string' || typeof en.name !== 'string' || !Number.isFinite(row.seats)) return fail();
    const facilities = Object.fromEntries(Object.entries(record(row.facilities)).filter(([key, val]) => /^[a-zA-Z]{1,40}$/.test(key) && (typeof val === 'boolean' || typeof val === 'string')));
    return { id: row.spaceId, name: text(en.name), building: buildings.get(row.buildingNumber) ?? null, buildingNumber: row.buildingNumber, floor: text(row.floor), seats: row.seats, facilities, remarks: text(en.remark), sourceUrl: SPACES + '/en/spaces/' };
  });
}
export class PublicCampus {
  constructor(private readonly read: (url: string) => Promise<string> = publicCampusFetch) {}
  async software(query: string, offset = 0) {
    const $ = load(await this.read(SOFTWARE + '/')), items: Row[] = [];
    for (const node of $('a[href^="/package/"]').toArray()) {
      const a = $(node), href = a.attr('href') ?? '', id = /^\/package\/([0-9]{1,10})$/.exec(href)?.[1];
      if (!id || !a.find('.card_title').length) return fail();
      items.push({ id, name: text(a.find('.card_title').text()), description: text(a.find('.card_desc').text()), cloudAdvice: text(a.find('.toast-header small').text()), sourceUrl: SOFTWARE + href });
    }
    if (!items.length) return fail();
    return { ...page(items, query, offset), ...source(SOFTWARE + '/'), coverage: 'Public software catalogue; listing does not establish student licence entitlement or install software.' };
  }
  async softwareDetail(id: string) {
    if (!/^[0-9]{1,10}$/.test(id)) throw new BrightspaceError('INVALID_ID', 'Use the software ID returned by search_software.');
    const url = SOFTWARE + '/package/' + id + '/', $ = load(await this.read(url)), section = $('.col-sm-9');
    const name = text(section.find('h3').first().text()); if (!name || section.length !== 1) return fail();
    const links = section.find('a[href]').toArray().flatMap(e => { const href = safeSourceUrl($(e).attr('href'), SOFTWARE); return href ? [{ title: text($(e).text()), url: href }] : []; });
    return { id, name, text: text(section.html()), links, ...source(url), coverage: 'Published software guidance only; no installation, download or licence acceptance.' };
  }
  async rooms(query: string, offset = 0) {
    const $ = load(await this.read(ROOMS + '/')), items: Row[] = [];
    for (const tr of $('table tbody tr').toArray()) {
      const cells = $(tr).find('td'), link = cells.eq(1).find('a[href^="/space/"]');
      const href = link.attr('href') ?? ''; if (!/^\/space\/[0-9]+$/.test(href)) continue;
      if (cells.length < 17) return fail();
      const number = (index: number) => { const v = text(cells.eq(index).text()); if (!/^\d+$/.test(v)) return fail(); return Number(v); };
      items.push({ id: href.split('/').pop(), name: text(link.text()), building: text(cells.eq(2).text()), type: text(cells.eq(4).text()), seats: number(5), examSeats: number(6), computers: number(7), furniture: text(cells.eq(8).text()), presentation: text(cells.eq(10).text()), facilities: text(cells.eq(13).html()), software: text(cells.eq(14).text()), buildingNumber: text(cells.eq(16).text()), sourceUrl: ROOMS + href });
    }
    if (!items.length) return fail();
    return { ...page(items, query, offset), ...source(ROOMS + '/'), liveAvailability: false, coverage: 'Published room specifications, not booking availability or current occupancy.' };
  }
  async spaces(query: string, offset = 0) {
    const url = SPACES + '/en/spaces/';
    return { ...page(parseSpaces(await this.read(url)), query, offset), ...source(url), liveAvailability: false,
      coverage: 'Published Spacefinder catalogue snapshot, which may lag live changes. No occupancy, opening-hours or reservation claim is made.' };
  }
  async notices(kind: 'incidents' | 'maintenance' | 'information', pageNumber = 1) {
    if (!['incidents', 'maintenance', 'information'].includes(kind) || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 9999) throw new BrightspaceError('INVALID_RANGE', 'Choose a notice category and page 1 to 9999.');
    const url = ICT + '/api/' + kind + '/?format=json&page=' + pageNumber;
    let data: Row; try { data = record(JSON.parse(await this.read(url))); } catch (e) { if (e instanceof BrightspaceError) throw e; return fail(); }
    if (!Array.isArray(data.results) || data.results.length > 100 || !Number.isSafeInteger(data.count) || Number(data.count) < data.results.length || data.next !== null && typeof data.next !== 'string') return fail();
    if (pageNumber === 1 && data.next === null && data.results.length !== data.count) return fail();
    if (data.next !== null) {
      const expected = new URL(url); expected.searchParams.set('page', String(pageNumber + 1));
      const next = new URL(String(data.next), ICT); if (next.href !== expected.href) return fail();
    }
    const items = data.results.map(value => {
      const row = record(value); if (!Number.isSafeInteger(row.id) || typeof row.title_EN !== 'string' || typeof row.closed !== 'boolean' || !Array.isArray(row.status_update)) return fail();
      return { id: row.id, title: text(row.title_EN), description: text(row.description_EN), closed: row.closed, publishedAt: row.creation_date ?? null, fromDate: row.from_date ?? null, periodInformation: text(row.period_info_EN), impact: text(record(row.impact).title_EN), updates: row.status_update.map(v => { const update = record(v); return { date: update.date ?? null, status: text(record(update.status).title_EN), description: text(update.description_EN) }; }), sourceUrl: ICT + '/en/' };
    });
    return { items, total: data.count, page: pageNumber, nextPage: data.next === null ? null : pageNumber + 1, complete: pageNumber === 1 && data.next === null, ...source(ICT + '/en/'), coverage: 'Published service notices, not a real-time health check. Dates retain provider meaning; maintenance timing may appear only in the description.' };
  }
}
