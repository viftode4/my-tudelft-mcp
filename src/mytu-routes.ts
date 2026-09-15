import { record } from './util.js';

// OSIRIS uses typed, sometimes compound identifiers such as scto:123 and sopl:123:exty:9.
export const MYTU_ID = '[a-zA-Z0-9_:-]{1,100}';
export const MYTU_ID_PATTERN = new RegExp('^' + MYTU_ID + '$');
const ID = MYTU_ID;
/** Only routes observed in the My TU Delft web application. No arbitrary URL proxy. */
export function myTuApiRequestAllowed(path: string, method = 'GET', body?: unknown): boolean {
  const url = new URL(path, 'https://my.tudelft.nl');
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== 'https://my.tudelft.nl' || url.hash
    || url.pathname.includes('%') || path.split('?')[0]!.includes('..') || path.includes('\\')) return false;
  const p = url.pathname, q = url.searchParams;
  if ([...q.keys()].some(key => q.getAll(key).length !== 1)) return false;
  if (method === 'GET') {
    if (body !== undefined) return false;
    if (['/gebruiker', '/student/contactgegevens', '/student/personalia', '/applicatie/menus'].includes(p)) return !url.search;
    if ([...q].some(([key, value]) => !(
      (key === 'offset' && /^\d{1,7}$/.test(value) && Number(value) <= 1_000_000)
      || (key === 'limit' && /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 100)
      || (key === 'toon_historie' && ['J', 'N'].includes(value))
      || (key === 'zoekstring' && value.length <= 200 && !/[\r\n]/.test(value))
    ))) return false;
    return new RegExp('^/student/resultaten(?:/' + ID + ')?$').test(p)
      || p === '/student/voortgang/per_opleiding/'
      || new RegExp('^/student/voortgang/' + ID + '/(?:onderwijsprogramma|studieadviezen|cursussen/' + ID + ')$').test(p)
      || new RegExp('^/student/inschrijvingen/(?:cursussen|toetsen|opleidingen|minoren|specialisaties|pakketten|voorinschrijvingen_cursus|wachtlijsten_cursus|wachtlijsten_toets|wachtlijsten_toelating_vereist_cursus)(?:/' + ID + ')?/?$').test(p)
      || new RegExp('^/student/cursussen_voor_(?:cursusinschrijving|toetsinschrijving)/(?:' + ID + '(?:/(?:controleren|blokken_voor_cursusinschrijving))?|te_volgen_onderwijs/open_voor_inschrijving/|gepland_onderwijs/)$').test(p)
      || p === '/student/rooster';
  }
  if (url.search) return false;
  const data = record(body);
  if (method === 'POST' && /^\/student\/cursussen_voor_(?:cursusinschrijving|toetsinschrijving)\/zoeken$/.test(p)) {
    const must = record(record(data.query).bool).must;
    const match = Array.isArray(must) && must.length === 1 ? record(record(must[0]).multi_match) : {};
    return Object.keys(data).every(key => ['from', 'size', 'query'].includes(key))
      && typeof match.query === 'string' && match.query.trim().length >= 2 && match.query.length <= 200
      && !/[\r\n]/.test(match.query) && match.type === 'phrase_prefix' && match.max_expansions === 200
      && JSON.stringify(match.fields) === JSON.stringify(['cursus', 'cursus_korte_naam', 'cursus_lange_naam'])
      && Number.isSafeInteger(data.from) && Number(data.from) >= 0 && Number(data.from) <= 1_000_000
      && Number.isSafeInteger(data.size) && Number(data.size) >= 1 && Number(data.size) <= 100
      && Object.keys(record(data.query)).length === 1 && Object.keys(record(record(data.query).bool)).length === 1
      && Array.isArray(must) && Object.keys(record(must[0])).length === 1 && Object.keys(match).length === 4;
  }
  if (method === 'PUT' && new RegExp('^/student/inschrijvingen/cursussen/' + ID + '$').test(p)) return Object.keys(data).length > 0;
  if (method === 'POST' && p === '/student/inschrijvingen/toetsen/') return Object.keys(data).length === 1 && Array.isArray(data.toetsen) && data.toetsen.length === 1;
  return method === 'DELETE' && body === undefined && new RegExp('^/student/inschrijvingen/(?:cursussen|toetsen)/' + ID + '$').test(p);
}
