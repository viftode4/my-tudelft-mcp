import type { BrightspaceClient } from './client.js';
import { BrightspaceError, safeError } from './errors.js';
import { numericId, plainText, record, safeSourceUrl, str, type Row } from './util.js';

const PRIMARY = 'calendar/events/myEventsWithOccurrences/';
const TIMEZONE = 'Europe/Amsterdam';
const MAX_WINDOW_MS = 366 * 86_400_000;
const EVENT_FIELDS = ['CalendarEventId', 'OrgUnitId', 'Title', 'Description', 'StartDateTime', 'EndDateTime',
  'IsAllDayEvent', 'StartDay', 'EndDay', 'GroupId', 'IsRecurring', 'RecurrenceInfo', 'LocationId', 'LocationName',
  'OrgUnitName', 'OrgUnitCode', 'IsAssociatedWithEntity', 'AssociatedEntity', 'HasVisibilityRestrictions',
  'VisibilityRestrictions', 'CalendarEventViewUrl', 'EventType', 'Presenters'] as const;
const OCCURRENCE_FIELDS = ['StartDateTime', 'EndDateTime', 'IsAllDayEvent', 'StartDay', 'EndDay'] as const;

type CalendarClient = Pick<BrightspaceClient, 'list' | 'json' | 'config'>;
type Page = Awaited<ReturnType<CalendarClient['list']>>;
export interface CalendarLimits { maxPages?: number; maxEvents?: number; maxOccurrences?: number; maxSeriesLookups?: number }
interface Issue { code: string; message: string; calendarEventId?: string; apiPath?: string }
interface Source { source: 'api'; apiPath: string; status: 'available' | 'unavailable'; error?: ReturnType<typeof safeError> }
export interface CalendarResult extends Row {
  source: 'api'; courseId: string; from: string; to: string; timezone: string; fetchedAt: string; url: string;
  items: Row[]; complete: boolean; recurrenceExpanded: boolean; apiPath: string; sources: Source[]; issues: Issue[];
}

function dateParts(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && last !== undefined && day >= 1 && day <= last ? { year, month, day } : undefined;
}

function utcTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,7})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value) || !dateParts(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function windowTime(value: string, label: string): string {
  const time = utcTime(value);
  if (time === undefined) throw new BrightspaceError('INVALID_DATE', label + ' must be a valid ISO datetime with Z or an explicit timezone offset.');
  return new Date(time).toISOString();
}

const civilFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, calendar: 'iso8601', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function utcDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0); return date.getTime();
}
/** Interpret Brightspace's all-day civil dates in Delft, including 23/25-hour DST days. */
function civilMidnight(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?)?$/.test(value)) return undefined;
  const parts = dateParts(value); if (!parts) return undefined;
  const target = utcDate(parts.year, parts.month, parts.day);
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const shown = Object.fromEntries(civilFormatter.formatToParts(candidate).map((part) => [part.type, Number(part.value)]));
    const correction = target - utcDate(shown.year!, shown.month!, shown.day!, shown.hour!, shown.minute!, shown.second!);
    if (correction === 0) return candidate;
    candidate += correction;
  }
  return undefined;
}

function overlaps(event: Row, start: number, end: number): boolean {
  const allDay = event.IsAllDayEvent === true;
  const first = allDay ? civilMidnight(event.StartDay) : utcTime(event.StartDateTime);
  const last = allDay ? civilMidnight(event.EndDay) : event.EndDateTime == null ? first : utcTime(event.EndDateTime);
  if (first === undefined || last === undefined || last < first || allDay && last === first) {
    throw new BrightspaceError('CALENDAR_DATE_UNRECOGNISED', 'An event has missing or invalid occurrence dates.');
  }
  // Timed point events (including deadlines) occur at their start; interval ends are exclusive.
  return first < end && (last === first ? first >= start : last > start);
}

function clean(value: unknown, origin: string, key = '', depth = 0): unknown {
  if (depth > 7) return '[nested data omitted]';
  if (/url$|^link$/i.test(key)) return safeSourceUrl(value, origin) ?? null;
  if (Array.isArray(value)) return value.slice(0, 200).filter((item) => key !== 'Presenters' || record(item).Visible !== false).map((item) => clean(item, origin, '', depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(record(value))
    .filter(([name]) => !/token|password|secret|cookie|authorization|csrf|xsrf|session|apikey|saml/i.test(name))
    .map(([name, item]) => [name, clean(item, origin, name, depth + 1)]));
  if (typeof value !== 'string') return value;
  return plainText(value).replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeSourceUrl(url, origin) ?? '[unsafe URL omitted]').slice(0, 20_000);
}

function unavailable(error: unknown): boolean {
  return error instanceof BrightspaceError && (['PERMISSION_DENIED', 'NOT_FOUND', 'API_UNSUPPORTED', 'UNSUPPORTED_API_VERSION'].includes(error.code)
    || error.code === 'API_ERROR' && [405, 410].includes(Number(error.details?.status)));
}

/** Read current-user occurrences supplied by Brightspace; never approximate recurrence rules locally. */
export class StudentCalendar {
  constructor(private readonly client: CalendarClient) {}

  async get(courseId: string, from: string, to: string, options: CalendarLimits = {}): Promise<CalendarResult> {
    const id = numericId(courseId), start = windowTime(from, 'Start'), end = windowTime(to, 'End');
    const startMs = Date.parse(start), endMs = Date.parse(end);
    if (endMs <= startMs || endMs - startMs > MAX_WINDOW_MS) throw new BrightspaceError('INVALID_RANGE', 'Choose an increasing calendar window of at most 366 days.');
    const limits = { maxPages: options.maxPages ?? 20, maxEvents: options.maxEvents ?? 2000,
      maxOccurrences: options.maxOccurrences ?? 5000, maxSeriesLookups: options.maxSeriesLookups ?? 20 };
    const ceilings = { maxPages: 100, maxEvents: 10_000, maxOccurrences: 20_000, maxSeriesLookups: 50 };
    for (const name of Object.keys(limits) as (keyof typeof limits)[]) {
      if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > ceilings[name]) throw new BrightspaceError('INVALID_LIMIT', 'Calendar limits must be positive integers within their documented maximums.');
    }
    const params = { startDateTime: start, endDateTime: end }, sources: Source[] = [], issues: Issue[] = [];
    const origin = this.client.config.baseUrl, items: Row[] = [], seen = new Set<string>();
    let complete = true, examinedOccurrences = 0, examinedEvents = 0, seriesLookups = 0;
    const issue = (code: string, message: string, calendarEventId?: string, apiPath?: string): void => {
      complete = false;
      if (issues.length < 100 && !issues.some((old) => old.code === code && old.calendarEventId === calendarEventId && old.apiPath === apiPath)) issues.push({ code, message, ...(calendarEventId ? { calendarEventId } : {}), ...(apiPath ? { apiPath } : {}) });
    };
    const list = async (apiPath: string, query: Record<string, string>): Promise<Page> => {
      try { const page = await this.client.list('le', apiPath, query, limits.maxPages); sources.push({ source: 'api', apiPath, status: 'available' }); return page; }
      catch (error) {
        if (!unavailable(error)) throw error;
        sources.push({ source: 'api', apiPath, status: 'unavailable', error: safeError(error) }); throw error;
      }
    };
    let page: Page, apiPath = PRIMARY, modern = true;
    try { page = await list(apiPath, { orgUnitIdsCSV: id, ...params }); }
    catch (error) {
      if (!unavailable(error)) throw error;
      apiPath = id + '/calendar/events/occurrences/';
      try { page = await list(apiPath, params); }
      catch (error) {
        if (!unavailable(error)) throw error;
        modern = false; apiPath = id + '/calendar/events/myEvents/'; page = await list(apiPath, params);
        issue('RECURRENCE_COVERAGE_PARTIAL', 'The legacy event list may omit series that began before this window, even when returned series can be expanded.', undefined, apiPath);
      }
    }
    if (!page.complete) issue('CALENDAR_PAGE_LIMIT', 'More calendar pages are available. Use a smaller window or a larger page limit.', undefined, apiPath);
    if (page.items.length > limits.maxEvents) issue('CALENDAR_EVENT_LIMIT', 'The calendar event limit was reached. Use a smaller window.', undefined, apiPath);

    const eventData = (raw: unknown, path: string, expectedId?: string): Row | undefined => {
      const event = record(raw), eventId = str(event.CalendarEventId);
      const scopes = [event.OrgUnitId, record(event.OrgUnit).Id].filter((value) => value !== undefined && value !== null).map(str);
      if (!scopes.length || scopes.some((scope) => scope !== id)) {
        issue('CALENDAR_SCOPE_MISMATCH', 'An event did not identify the requested course and was omitted.', undefined, path); return undefined;
      }
      if (!/^\d{1,18}$/.test(eventId) || expectedId !== undefined && eventId !== expectedId || typeof event.IsRecurring !== 'boolean' || typeof event.IsAllDayEvent !== 'boolean') {
        issue('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar calendar event.', undefined, path); return undefined;
      }
      return { ...Object.fromEntries(EVENT_FIELDS.filter((key) => key in event).map((key) => [key, clean(event[key], origin, key)])), OrgUnitId: event.OrgUnitId ?? id };
    };
    const append = (event: Row, path: string, occurrence?: Row): void => {
      const eventId = str(event.CalendarEventId);
      let merged = { ...event, IsOccurrence: false } as Row;
      if (occurrence) {
        const occurrenceId = str(occurrence.RecurrenceId);
        if (!/^\d{1,18}$/.test(occurrenceId) || occurrence.CalendarEventId != null && str(occurrence.CalendarEventId) !== eventId
          || typeof occurrence.IsAllDayEvent !== 'boolean' || OCCURRENCE_FIELDS.some((key) => !(key in occurrence))) {
          issue('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar or mismatched calendar occurrence.', eventId, path); return;
        }
        merged = { ...event, ...Object.fromEntries(OCCURRENCE_FIELDS.map((key) => [key, occurrence[key]])),
          IsOccurrence: true, RecurrenceId: occurrence.RecurrenceId,
          SeriesStartDateTime: event.StartDateTime ?? null, SeriesEndDateTime: event.EndDateTime ?? null,
          SeriesStartDay: event.StartDay ?? null, SeriesEndDay: event.EndDay ?? null };
      }
      try { if (!overlaps(merged, startMs, endMs)) return; }
      catch { issue('CALENDAR_DATE_UNRECOGNISED', 'An event has missing or invalid occurrence dates and was omitted.', eventId, path); return; }
      const identity = [eventId, str(merged.RecurrenceId), str(merged.StartDateTime), str(merged.EndDateTime), str(merged.StartDay), str(merged.EndDay)].join(':');
      if (seen.has(identity)) return;
      if (items.length >= limits.maxOccurrences) {
        issue('CALENDAR_OCCURRENCE_LIMIT', 'The occurrence limit was reached. Use a smaller window.', undefined, path); return;
      }
      seen.add(identity);
      items.push({ ...merged, OccurrenceId: identity, OccurrenceSource: { source: 'api', apiPath: path } });
    };
    const expand = (raw: unknown, path: string, expectedId?: string): void => {
      const wrapper = record(raw), event = eventData(wrapper.EventDataInfo, path, expectedId);
      if (!event) return;
      if (!Array.isArray(wrapper.Occurrences)) {
        issue('API_FORMAT_CHANGED', 'Brightspace did not provide a calendar occurrence list.', str(event.CalendarEventId), path);
        if (event.IsRecurring === false) append(event, path);
        return;
      }
      if (!wrapper.Occurrences.length && event.IsRecurring === false) append(event, path);
      for (const rawOccurrence of wrapper.Occurrences) {
        if (examinedOccurrences >= limits.maxOccurrences) {
          issue('CALENDAR_OCCURRENCE_LIMIT', 'The occurrence limit was reached. Use a smaller window.', undefined, path); break;
        }
        examinedOccurrences++; append(event, path, record(rawOccurrence));
      }
    };

    for (const raw of page.items.slice(0, limits.maxEvents)) {
      examinedEvents++;
      if (modern) { expand(raw, apiPath); continue; }
      const event = eventData(raw, apiPath); if (!event) continue;
      if (event.IsRecurring === false) { append(event, apiPath); continue; }
      if (seriesLookups >= limits.maxSeriesLookups) {
        issue('CALENDAR_SERIES_LIMIT', 'The per-series occurrence lookup limit was reached.', str(event.CalendarEventId), apiPath); append(event, apiPath); continue;
      }
      seriesLookups++;
      const path = id + '/calendar/event/' + str(event.CalendarEventId) + '/occurrences';
      try {
        const result = await this.client.json('le', path);
        sources.push({ source: 'api', apiPath: path, status: 'available' }); expand(result, path, str(event.CalendarEventId));
      } catch (error) {
        if (error instanceof BrightspaceError && ['AUTH_REQUIRED', 'ACCOUNT_CHANGED'].includes(error.code)) throw error;
        const failure = safeError(error);
        sources.push({ source: 'api', apiPath: path, status: 'unavailable', error: failure });
        issue('RECURRENCE_UNAVAILABLE', 'Brightspace could not provide occurrences for this series (' + failure.code + ').', str(event.CalendarEventId), path);
        append(event, apiPath);
      }
    }
    const eventTime = (event: Row): number => (event.IsAllDayEvent === true ? civilMidnight(event.StartDay) : utcTime(event.StartDateTime))!;
    items.sort((left, right) => eventTime(left) - eventTime(right) || str(left.OccurrenceId).localeCompare(str(right.OccurrenceId)));
    return { source: 'api', courseId: id, from: start, to: end, timezone: TIMEZONE, fetchedAt: new Date().toISOString(),
      url: origin + '/d2l/le/calendar/' + id, apiPath, items, complete, recurrenceExpanded: modern && complete,
      sources, issues, limits, examinedEvents, examinedOccurrences, seriesLookups,
      ...(page.nextBookmark ? { nextBookmark: page.nextBookmark } : {}),
      ...(page.nextUrl ? { nextUrl: safeSourceUrl(page.nextUrl, origin) } : {}),
      coverage: { currentUserOnly: true, dateWindow: '[from, to)', recurringSeries: modern ? 'server_occurrences' : 'legacy_partial',
        allDayDates: 'Delft civil dates; EndDay is exclusive.', recurrenceRulesExpandedLocally: false } };
  }
}
