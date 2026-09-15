import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { BrightspaceError } from './errors.js';

export const TIMETABLE_URL = 'https://mytimetable.tudelft.nl/schedule';
export interface TimetableEvent {
  id: string; title: string; start: string; end: string; allDay: boolean;
  localStart: string; localEnd: string; timeZone: string; location: string;
  description: string; status: string; categories: string[]; sourceUrl: string;
}
export interface TimetableCalendar {
  items: TimetableEvent[]; complete: boolean; warnings: string[]; timeZone: string;
  publishedEventCount: number;
}
export function timetableWindow(from: string, to: string): { start: number; end: number } {
  const iso = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/;
  const start = Date.parse(from), end = Date.parse(to);
  if (!iso.test(from) || !iso.test(to) || !Number.isFinite(start) || !Number.isFinite(end)
    || end <= start || end - start > 93 * 86400_000) throw new BrightspaceError('INVALID_RANGE', 'Choose an explicit timestamp window of at most 93 days.');
  return { start, end };
}
function parts(ms: number, zone: string): number[] {
  const values = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(values.find(part => part.type === key)!.value));
}
function wallEpoch(fields: number[]): number { return Date.UTC(fields[0]!, fields[1]! - 1, fields[2]!, fields[3]!, fields[4]!, fields[5]!); }
function millis(time: ICAL.Time, declaredZone: string): number {
  if (!time.isDate && time.zone.tzid !== 'floating') return time.toJSDate().getTime();
  const fields = [time.year, time.month, time.day, time.hour, time.minute, time.second], wall = wallEpoch(fields);
  const candidates = new Set<number>();
  // Use the runtime's IANA data when feeds omit VTIMEZONE. Resolve overlaps to the first occurrence.
  for (const shift of [-86400_000, 0, 86400_000]) {
    const probe = wall + shift, offset = wallEpoch(parts(probe, declaredZone)) - probe;
    const candidate = wall - offset;
    if (parts(candidate, declaredZone).every((part, index) => part === fields[index])) candidates.add(candidate);
  }
  if (!candidates.size) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'A timetable time falls in an unsupported daylight-saving gap.');
  return Math.min(...candidates);
}
function local(ms: number): string {
  const p = parts(ms, 'Europe/Amsterdam').map((part, index) => String(part).padStart(index ? 2 : 4, '0'));
  return `${p[0]}-${p[1]}-${p[2]}T${p[3]}:${p[4]}:${p[5]}`;
}

/** Called in an isolated, time/memory-bounded worker for remotely supplied feeds. */
export function parseTimetable(text: string, from: string, to: string): TimetableCalendar {
  const window = timetableWindow(from, to);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024 || !/^\s*BEGIN:VCALENDAR\r?\n/i.test(text)
    || !/\r?\nEND:VCALENDAR\s*$/i.test(text)) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'The subscription did not return a complete iCalendar document.');
  const root = new ICAL.Component(ICAL.parse(text.trim()));
  if (root.name !== 'vcalendar') throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'Expected one iCalendar document.');
  const components = root.getAllSubcomponents('vevent');
  if (components.length > 20_000) throw new BrightspaceError('TIMETABLE_LIMIT', 'The feed contains too many events.');
  const feedZone = String(root.getFirstPropertyValue('x-wr-timezone') || 'Europe/Amsterdam');
  const zoneFor = (event: ICAL.Event, property: string): string => String(event.component.getFirstProperty(property)?.getParameter('tzid')
    || event.component.getFirstProperty('dtstart')?.getParameter('tzid') || feedZone);
  // Avoid automatic parent scanning, which relates unrelated series and costs O(n²).
  const events = components.map(component => new ICAL.Event(component, { exceptions: [], strictExceptions: true }));
  const masters = new Map<string, ICAL.Event>(), exceptions = new Map<string, ICAL.Event>();
  for (const event of events) {
    if (!event.uid) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'A timetable event is missing its identity.');
    const target = event.isRecurrenceException() ? exceptions : masters;
    const key = event.isRecurrenceException() ? event.uid + ':' + millis(event.recurrenceId, zoneFor(event, 'recurrence-id')) : event.uid;
    if (target.has(key)) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'The feed contains duplicate events or series.');
    target.set(key, event);
  }
  for (const event of exceptions.values()) {
    if (event.modifiesFuture()) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'This feed uses a recurrence-range change that requires the native timetable view.');
    const master = masters.get(event.uid);
    if (!event.component.hasProperty('dtstart')) {
      if (String(event.component.getFirstPropertyValue('status')).toLowerCase() !== 'cancelled') throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'A changed event is missing its start time.');
      // A cancellation may contain only UID and RECURRENCE-ID. Keep it visible and
      // replace the original occurrence instead of accidentally showing an active class.
      event.startDate = event.recurrenceId.clone();
      const zone = event.component.getFirstProperty('recurrence-id')?.getParameter('tzid');
      if (zone) event.component.getFirstProperty('dtstart')!.setParameter('tzid', zone);
      if (master) event.component.addPropertyWithValue('duration', master.duration);
    }
    if (master) {
      for (const field of ['summary', 'location', 'description']) {
        if (!event.component.hasProperty(field) && master.component.hasProperty(field)) event.component.addPropertyWithValue(field, master.component.getFirstPropertyValue(field)!);
      }
      master.relateException(event);
    }
  }
  const warnings = new Set<string>(), items = new Map<string, TimetableEvent>();
  let iterations = 0;
  const clip = (value: unknown, max: number): string => {
    const text = typeof value === 'string' ? value : '';
    if (text.length > max) warnings.add('Some event text exceeded its output limit.');
    return text.slice(0, max);
  };
  const add = (event: ICAL.Event, startTime: ICAL.Time, endTime: ICAL.Time, recurrenceId: string): void => {
    const start = millis(startTime, zoneFor(event, 'dtstart')), end = millis(endTime, zoneFor(event, 'dtend'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'An event has invalid start or end times.');
    if (start >= window.end || (end === start ? start < window.start : end <= window.start)) return;
    const id = createHash('sha256').update(event.uid + ':' + recurrenceId).digest('hex').slice(0, 32);
    const categories = event.component.getFirstProperty('categories')?.getValues() ?? [];
    if (categories.length > 30) warnings.add('Some event categories exceeded their output limit.');
    items.set(id, { id, title: clip(event.summary, 1000), start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      allDay: startTime.isDate, localStart: local(start), localEnd: local(end), timeZone: 'Europe/Amsterdam',
      location: clip(event.location, 2000), description: clip(event.description, 4000),
      status: clip(event.component.getFirstPropertyValue('status'), 100).toLowerCase() || 'unspecified',
      categories: categories.slice(0, 30).map(value => clip(value, 200)), sourceUrl: TIMETABLE_URL });
    if (items.size > 2000) throw new BrightspaceError('TIMETABLE_LIMIT', 'More than 2000 activities occur in this window. Choose a shorter range.');
  };
  for (const event of masters.values()) {
    if (!event.uid || !event.component.hasProperty('dtstart')) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'A timetable event is missing its identity or start time.');
    if (event.isRecurring()) {
      const iterator = event.iterator();
      for (let occurrence = iterator.next(); occurrence; occurrence = iterator.next()) {
        if (++iterations > 100_000) throw new BrightspaceError('TIMETABLE_LIMIT', 'Calendar recurrence expansion exceeded its limit.');
        const original = millis(occurrence, zoneFor(event, 'dtstart'));
        const detail = event.getOccurrenceDetails(occurrence);
        add(detail.item, detail.startDate, detail.endDate, String(original));
        if (original >= window.end) break;
      }
    } else add(event, event.startDate, event.endDate, String(millis(event.startDate, zoneFor(event, 'dtstart'))));
  }
  // Detached or moved exceptions may enter this window from outside the generated range.
  for (const event of exceptions.values()) {
    add(event, event.startDate, event.endDate, String(millis(event.recurrenceId, zoneFor(event, 'recurrence-id'))));
  }
  return { items: [...items.values()].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)),
    complete: warnings.size === 0, warnings: [...warnings], timeZone: 'Europe/Amsterdam', publishedEventCount: components.length };
}
