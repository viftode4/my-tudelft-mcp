import { request, type APIRequestContext } from 'playwright';
import { load } from 'cheerio';
import { BrightspaceError } from './errors.js';
import { array, numericId, plainText, record, safeSourceUrl, str } from './util.js';

const apiOrigin = 'https://curriculum.tudelft.nl';
const apiRoot = `${apiOrigin}/publisher/api/v0`;
const guideOrigin = 'https://studyguide.tudelft.nl';
const pageSize = 30;
export type StudyGuideLanguage = 'en' | 'nl';
export type StudyGuideTransport = (path: string, body?: Record<string, unknown>) => Promise<unknown>;
type PublicContextFactory = (options: Parameters<typeof request.newContext>[0]) => Promise<APIRequestContext>;

/** The public publisher API observed in the official Study Guide. No Auth or vault dependency. */
export function anonymousStudyGuideTransport(timeoutMs = 25_000, createContext: PublicContextFactory = (options) => request.newContext(options)): StudyGuideTransport {
  return async (path, body) => {
    if (!/^\/courses\/items\/(?:[0-9]{1,18}|search\?size=30&offset=[0-9]{1,5})$/.test(path) || (path.includes('/search?') ? !body : Boolean(body))) throw new BrightspaceError('INVALID_PUBLIC_ROUTE', 'Only the observed public course search and course detail routes are supported.');
    const context = await createContext({ timeout: timeoutMs, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { Accept: 'application/json' } });
    try {
      const response = await context.fetch(apiRoot + path, { method: body ? 'POST' : 'GET', data: body, maxRedirects: 0, maxRetries: 0 });
      try {
        if (response.status() >= 300 && response.status() < 400 || [401, 403].includes(response.status())) throw new BrightspaceError('PUBLIC_GUIDE_UNAVAILABLE', 'The Study Guide is not available anonymously at its verified public endpoint.');
        if (response.status() === 404) throw new BrightspaceError('NOT_FOUND', 'This published Study Guide course is no longer available.');
        if (!response.ok()) throw new BrightspaceError('PUBLIC_GUIDE_UNAVAILABLE', 'The public Study Guide could not be read.');
        if (!(response.headers()['content-type'] ?? '').toLowerCase().includes('json')) throw new BrightspaceError('API_FORMAT_CHANGED', 'The public Study Guide did not return its observed JSON format.');
        const bytes = await response.body();
        if (bytes.length > 3_000_000) throw new BrightspaceError('RESPONSE_TOO_LARGE', 'The public Study Guide response exceeded its bounded size.');
        try { return JSON.parse(bytes.toString('utf8')) as unknown; }
        catch { throw new BrightspaceError('API_FORMAT_CHANGED', 'The public Study Guide returned invalid JSON.'); }
      } finally { await response.dispose(); }
    } catch (error) {
      if (error instanceof BrightspaceError) throw error;
      throw new BrightspaceError('PUBLIC_GUIDE_UNAVAILABLE', 'The public Study Guide could not be reached.');
    } finally { await context.dispose(); }
  };
}

function validateYear(value: string): string {
  const match = /^(20[0-9]{2})-(20[0-9]{2})$/.exec(value);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) throw new BrightspaceError('INVALID_ACADEMIC_YEAR', 'Use an explicit academic year such as 2026-2027.');
  return value;
}
function validateLanguage(language: StudyGuideLanguage): void {
  if (!['en', 'nl'].includes(language)) throw new BrightspaceError('INVALID_LANGUAGE', 'Choose en or nl for the public Study Guide.');
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('\n');
  return plainText(value).replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeSourceUrl(url, guideOrigin) ?? '[unsafe URL omitted]');
}
function localized(value: unknown, language: StudyGuideLanguage): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) ? record(value)[language] : value;
}
function texts(value: unknown): string[] { return (Array.isArray(value) ? value : value == null ? [] : [value]).map(text).filter(Boolean); }

export interface StudyGuideCourseSummary {
  id: string; code: string; academicYear: string; name: string; credits?: number;
  language: StudyGuideLanguage; sourceUrl: string; periods: string[]; courseLanguages: string[];
  levels: string[]; faculties: string[]; locations: string[];
}
function normalizeItem(value: unknown, year: string, language: StudyGuideLanguage): { summary: StudyGuideCourseSummary; fields: Record<string, unknown> } {
  const item = record(value), attributes = record(item.attributes), fields = record(attributes.data), id = str(item.id), code = str(fields.code);
  if (item.type !== 'items' || attributes.type_canonical_name !== 'modules' || !/^\d{1,18}$/.test(id) || str(fields.item_id) !== id || !/^[A-Z0-9][A-Z0-9_-]{1,31}$/i.test(code)) throw new BrightspaceError('API_FORMAT_CHANGED', 'The public course record does not contain its expected identity.');
  const years = record(fields.jaar), requested = years[language];
  if (!Array.isArray(requested) || requested.length !== 1 || requested[0] !== year || Object.values(years).some((value) => !Array.isArray(value) || value.length !== 1 || value[0] !== year)) throw new BrightspaceError('COURSE_YEAR_MISMATCH', 'The public course record does not match the exact requested academic year.');
  const name = text(localized(fields.course_name_2, language));
  if (!name.trim()) throw new BrightspaceError('API_FORMAT_CHANGED', 'The published course has no name in the requested language.');
  return { summary: { id, code, academicYear: year, name, credits: typeof fields.studiepunten_ects === 'number' && Number.isFinite(fields.studiepunten_ects) ? fields.studiepunten_ects : undefined,
    language, sourceUrl: `${guideOrigin}/courses/study-guide/educations/${id}`, periods: texts(fields.cr_course_start),
    courseLanguages: texts(localized(fields.voertaal, language)), levels: texts(localized(fields.cr_level, language)), faculties: texts(localized(fields.faculteit, language)), locations: texts(localized(fields.locatie, language)) }, fields };
}

const sectionDefinitions = [
  ['description', 'Description', 'vakbeschrijving'], ['learning_objectives', 'Learning objectives', 'leerdoelen'],
  ['teaching_method', 'Teaching method', 'toelichting_onderwijsmethode'], ['contact_hours', 'Contact hours per week', 'contacturen_per_week_nederlands'],
  ['assessment', 'Assessment', 'toetsing'], ['literature', 'Literature and course materials', 'literatuur_en_studiemateriaal'],
  ['prior_knowledge', 'Expected prior knowledge', 'cr_expected_prior_knowledge_nld'], ['prerequisites', 'Entry requirements', 'toelatingseisen_nld'],
  ['registration', 'Course registration information', 'cr_enrolment_nld_1'], ['required_courses', 'Required courses', 'cr_required_course'],
  ['gives_access_to', 'Gives access to', 'cr_gives_access_to'], ['requirements_and_registration', 'Requirements and registration details', 'cr_more_information_on_requirements_and_registration_nld'],
  ['additional_information', 'Additional information', 'cr_addtional_comments_studyguide_nld_1'], ['substitution', 'Substitution arrangement', 'cr_explanation_of_the_substitution_arrangement'],
  ['student_contact', 'Student contact information', 'contact_informatie_studenten'],
] as const;
function sourceLinks(html: unknown): { links: Array<{ title: string; url: string }>; linkCount: number; linksTruncated: boolean } {
  const $ = load(str(html));
  const nodes = $('a[href]').toArray();
  const links = nodes.slice(0, 100).flatMap((node) => {
    const url = safeSourceUrl($(node).attr('href'), guideOrigin);
    return url ? [{ title: text($(node).text()), url }] : [];
  });
  return { links, linkCount: nodes.length, linksTruncated: nodes.length > 100 };
}

interface OutputOmission { path: string; reason: 'length' | 'budget' | 'array_limit' | 'unsafe_to_shorten'; originalSize: number; returnedSize: number; }
/** Includes auxiliary fields and links in the same budget as section text. */
function boundOutput<T extends Record<string, unknown>>(value: T, pagination = false, initiallyTruncated = false): T & { outputTruncated: boolean; outputOmissions: OutputOmission[]; omittedFieldCount: number } {
  const identityKeys = new Set(['id', 'code', 'key', 'academicYear', 'language', 'sourceUrl', 'apiSourceUrl', 'source', 'authentication', 'retrievedAt', 'query', 'coverage']);
  let reserved = 0;
  const reserve = (entry: unknown, key = ''): void => {
    if (typeof entry === 'string' && identityKeys.has(key)) reserved += JSON.stringify(entry).length;
    else if (Array.isArray(entry)) entry.forEach((item) => reserve(item, key));
    else if (entry && typeof entry === 'object') for (const [childKey, child] of Object.entries(entry)) reserve(child, childKey);
  };
  reserve(value);
  if (reserved > 12_000) throw new BrightspaceError('RESPONSE_TOO_LARGE', 'The public Study Guide returned too much identity metadata to represent safely.');
  let remaining = 48_000 - reserved, omissionCount = 0;
  const omissions: OutputOmission[] = [];
  const omit = (path: string, reason: OutputOmission['reason'], originalSize: number, returnedSize: number) => {
    omissionCount++;
    if (omissions.length < 30) omissions.push({ path, reason, originalSize, returnedSize });
  };
  const walk = (entry: unknown, key: string, path: string): unknown => {
    if (typeof entry === 'string') {
      if (identityKeys.has(key)) return entry;
      const max = key === 'text' ? 20_000 : key === 'title' ? 300 : key === 'url' ? 2_048 : key === 'emails' ? 254 : 500;
      const address = key === 'url' || key === 'emails';
      if (address && (entry.length > max || JSON.stringify(entry).length > remaining)) { omit(path, 'unsafe_to_shorten', entry.length, 0); return undefined; }
      let bounded = entry.slice(0, max), reason: OutputOmission['reason'] = 'length';
      if (JSON.stringify(bounded).length > remaining) {
        reason = 'budget';
        let low = 0, high = bounded.length;
        while (low < high) { const middle = Math.ceil((low + high) / 2); if (JSON.stringify(bounded.slice(0, middle)).length <= remaining) low = middle; else high = middle - 1; }
        bounded = bounded.slice(0, low);
      }
      if (bounded.length < entry.length) omit(path, reason, entry.length, bounded.length);
      remaining = Math.max(0, remaining - JSON.stringify(bounded).length);
      return bounded;
    }
    if (Array.isArray(entry)) {
      const limit = key === 'sections' ? 20 : 30;
      if (entry.length > limit) omit(path, 'array_limit', entry.length, limit);
      return entry.slice(0, limit).flatMap((item, index) => {
        const bounded = walk(item, key, `${path}[${index}]`);
        return bounded === undefined || bounded === '' && typeof item === 'string' && item !== '' ? [] : [bounded];
      });
    }
    if (entry && typeof entry === 'object') {
      const input = record(entry), result: Record<string, unknown> = {}, previousOmissions = omissionCount;
      for (const [childKey, child] of Object.entries(input)) {
        const bounded = walk(child, childKey, path ? `${path}.${childKey}` : childKey);
        if (bounded !== undefined) result[childKey] = bounded;
      }
      // A URL is never shortened into an invalid link. Drop its descriptor instead.
      if ('url' in input && !result.url) return undefined;
      if ('text' in input && 'links' in input && omissionCount > previousOmissions) result.truncated = true;
      return result;
    }
    return entry;
  };
  const result = walk(value, '', '') as T;
  const outputTruncated = initiallyTruncated || omissionCount > 0;
  if (!pagination && outputTruncated) (result as Record<string, unknown>).complete = false;
  const output = { ...result, outputTruncated, outputOmissions: omissions, omittedFieldCount: omissionCount };
  // Structural/escaping overhead is checked too; this fails closed instead of
  // allowing an unexpectedly expansive auxiliary schema to bypass the text cap.
  if (JSON.stringify(output).length > 100_000) throw new BrightspaceError('RESPONSE_TOO_LARGE', 'The public Study Guide result exceeded its serialized output limit.');
  return output;
}

export class PublicStudyGuide {
  constructor(private readonly transport: StudyGuideTransport = anonymousStudyGuideTransport()) {}

  async search(query: string, academicYear: string, language: StudyGuideLanguage = 'en', offset = 0) {
    const year = validateYear(academicYear);
    validateLanguage(language);
    if (!query.trim() || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 99990 || offset % pageSize !== 0) throw new BrightspaceError('INVALID_SEARCH', 'Use a nonempty query up to 200 characters and the nextOffset returned by a previous search.');
    const path = `/courses/items/search?size=${pageSize}&offset=${offset}`;
    const value = record(await this.transport(path, { query: query.trim(), filters: { jaar: [year] }, language })), meta = record(value.meta);
    if (!Array.isArray(value.data) || value.data.length > pageSize || !Number.isSafeInteger(meta.total) || Number(meta.total) < 0 || str(meta.offset) !== String(offset) || str(meta.size) !== String(pageSize)) throw new BrightspaceError('PAGINATION_ERROR', 'The public Study Guide search returned inconsistent paging metadata.');
    const total = Number(meta.total), items = value.data.map((item) => normalizeItem(item, year, language).summary);
    if (new Set(items.map((item) => item.id)).size !== items.length || offset + items.length > total || items.length === 0 && offset < total || items.length < pageSize && offset + items.length < total) throw new BrightspaceError('PAGINATION_ERROR', 'The public Study Guide search returned an incomplete or duplicate page.');
    const complete = offset + items.length >= total;
    return boundOutput({ query: query.trim(), academicYear: year, language, items, total, offset, pageSize, complete, nextOffset: complete ? undefined : offset + items.length,
      source: 'public_study_guide' as const, authentication: 'anonymous' as const, sourceUrl: `${guideOrigin}/courses/study-guide`, retrievedAt: new Date().toISOString() }, true);
  }

  async getCourse(code: string, academicYear: string, language: StudyGuideLanguage = 'en') {
    const requestedCode = code.trim().toUpperCase(), year = validateYear(academicYear);
    validateLanguage(language);
    if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(requestedCode)) throw new BrightspaceError('INVALID_COURSE_CODE', 'Use the public course code, for example DSAIT4000, without Brightspace year or period suffixes.');
    const matches: StudyGuideCourseSummary[] = [], seen = new Set<string>();
    let offset = 0, complete = false, expectedTotal: number | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await this.search(requestedCode, year, language, offset);
      if (expectedTotal !== undefined && result.total !== expectedTotal) throw new BrightspaceError('PAGINATION_ERROR', 'The public Study Guide changed during exact course resolution. Retry the lookup.');
      expectedTotal = result.total;
      for (const item of result.items) {
        if (seen.has(item.id)) throw new BrightspaceError('PAGINATION_ERROR', 'The public Study Guide repeated a record while resolving the exact course.');
        seen.add(item.id);
        if (item.code.toUpperCase() === requestedCode) matches.push(item);
      }
      if (result.complete) { complete = true; break; }
      offset = result.nextOffset!;
    }
    if (!complete) throw new BrightspaceError('PAGINATION_ERROR', 'The exact course could not be resolved within the bounded public search. Refine the course code.');
    if (!matches.length) throw new BrightspaceError('NOT_FOUND', 'No published course matches this exact code and academic year. Historical years are not substituted.');
    if (matches.length !== 1) throw new BrightspaceError('AMBIGUOUS_COURSE', 'Multiple public records match this exact course code and year; the connector will not choose one.');
    const id = numericId(matches[0]!.id), payload = record(await this.transport(`/courses/items/${id}`)), { summary, fields } = normalizeItem(payload.data, year, language);
    if (summary.id !== id || summary.code.toUpperCase() !== requestedCode) throw new BrightspaceError('COURSE_CHANGED', 'The detail record does not match the exact public course selected from search.');
    const sections = sectionDefinitions.flatMap(([key, title, attribute]) => {
      const value = localized(fields[attribute], language), content = text(value);
      if (!content) return [];
      const links = sourceLinks(value);
      return [{ key, title, text: content, ...links, truncated: links.linksTruncated }];
    });
    const lecturers = [fields.verantwoordelijk_docent_1, fields.verantwoordelijk_docent_2, fields.verantwoordelijk_docent_3, fields.verantwoordelijk_docent_4, ...array(fields.docenten)].flatMap((value) => {
      const $ = load(str(value)), name = text(value);
      if (!name) return [];
      const emails = $('a[href^="mailto:"]').toArray().map((node) => ($(node).attr('href') ?? '').slice(7).split('?')[0]!).filter((email) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email));
      return [{ name, emails }];
    }).filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index);
    return boundOutput({ course: summary, sections, lecturers, programmes: texts(fields.opleidingen_namen),
      teachingActivities: texts(localized(fields.onderwijs_activiteiten, language)), durationPeriods: texts(localized(fields.cr_course_duration, language)),
      courseRegistrationInformation: texts(localized(fields.cr_enrolment_course, language)),
      publicationStatus: text(localized(fields.status, language)), draftLabel: text(localized(fields.concept, language)),
      source: 'public_study_guide' as const, authentication: 'anonymous' as const, sourceUrl: summary.sourceUrl,
      apiSourceUrl: `${apiRoot}/courses/items/${id}`, retrievedAt: new Date().toISOString(), complete: true,
      coverage: 'Mapped published course fields for the exact requested code and academic year. Output omissions and section/link truncation are reported explicitly. Source links are descriptors; linked documents are not read. Registration information describes the catalogue policy, not the student’s current enrollment.' }, false, sections.some((section) => section.linksTruncated));
  }
}
