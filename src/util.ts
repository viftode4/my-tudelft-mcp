import { load } from 'cheerio';
import { BrightspaceError } from './errors.js';

export type Row = Record<string, unknown>;
export const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const str = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

export function plainText(value: unknown): string {
  if (typeof value !== 'string') {
    const v = record(value);
    return plainText(v.Text || v.Html || v.Content || '');
  }
  const $ = load(value);
  $('script,style,noscript,template,input,button').remove();
  $('br').replaceWith('\n');
  $('p,div,li,tr,h1,h2,h3,h4').append('\n');
  return $.root().text().replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}

export function sameOriginUrl(input: string, origin: string): URL {
  let url: URL;
  try { url = new URL(input, origin); } catch { throw new BrightspaceError('INVALID_URL', 'The URL is not valid.'); }
  if (url.origin !== origin || url.username || url.password || url.protocol !== 'https:') {
    throw new BrightspaceError('EXTERNAL_RESOURCE', 'This link belongs to another service. Brightspace credentials will not be sent to it.', { url: url.origin + url.pathname });
  }
  return url;
}

export function safeSourceUrl(input: unknown, origin: string, depth = 0): string | undefined {
  if (!str(input)) return undefined;
  try {
    const url = new URL(str(input), origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    // Do not expose authentication material from signed or launch URLs to the model.
    for (const key of [...url.searchParams.keys()]) {
      const name = key.toLowerCase().replace(/[-_.]/g, '');
      if (/token|secret|signature|saml|ticket|session/.test(name)
        || /^(?:auth|authorization|code|state|nonce|key|apikey|accesskey|clientid|clientsecret|d2lreferrerauth|jwt|ltik|sig|credentials?|assertion|loginhint|ltimessagehint|relaystate|(?:authorization|auth|verification|access)code|enrol[l]?mentkey)$/.test(name)
        || name.startsWith('oauth') || name.startsWith('xamz') || name.startsWith('xgoog')) {
        url.searchParams.delete(key);
        continue;
      }
      // A return/redirect URL can carry another full set of authentication parameters.
      const values = url.searchParams.getAll(key);
      const cleaned = values.flatMap((value) => {
        let nested = value;
        for (let i = 0; i < 2 && /^(?:https?%3a|%2f)/i.test(nested); i++) {
          try { nested = decodeURIComponent(nested); } catch { break; }
        }
        if (!/^(?:https?:\/\/|\/)/i.test(nested)) return [value];
        const safe = depth < 4 ? safeSourceUrl(nested, origin, depth + 1) : undefined;
        return safe ? [safe] : [];
      });
      if (cleaned.some((value, index) => value !== values[index]) || cleaned.length !== values.length) {
        url.searchParams.delete(key);
        for (const value of cleaned) url.searchParams.append(key, value);
      }
    }
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

export function numericId(value: unknown): string {
  const id = str(value);
  if (!/^\d{1,18}$/.test(id)) throw new BrightspaceError('INVALID_ID', 'Use the numeric ID returned by a Brightspace tool.');
  return id;
}

export function pageItems(payload: unknown): { items: unknown[]; hasMore: boolean; bookmark?: string; nextUrl?: string } {
  if (Array.isArray(payload)) return { items: payload, hasMore: false };
  const p = record(payload), paging = record(p.PagingInfo);
  if (Array.isArray(p.Items)) return { items: p.Items, hasMore: paging.HasMoreItems === true, bookmark: str(paging.Bookmark) || undefined };
  if (Array.isArray(p.Objects)) {
    if (p.Next !== null && p.Next !== undefined && typeof p.Next !== 'string') throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar pagination URL.');
    const nextUrl = typeof p.Next === 'string' ? p.Next.trim() || undefined : undefined;
    return { items: p.Objects, hasMore: Boolean(nextUrl), nextUrl };
  }
  throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar list format.');
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function snippet(text: string, query: string, length = 700): string {
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const lower = text.toLocaleLowerCase();
  const positions = tokens.map((token) => lower.indexOf(token)).filter((n) => n >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 100);
  return (start ? '…' : '') + text.slice(start, start + length) + (start + length < text.length ? '…' : '');
}
