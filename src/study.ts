import { BrightspaceError, safeError } from './errors.js';
import { array, numericId, plainText, record, safeSourceUrl, str, type Row } from './util.js';

export interface StudySources {
  assignments(courseId: string): Promise<Row>;
  quizzes(courseId: string): Promise<Row>;
  calendar(courseId: string, from: string, to: string): Promise<Row>;
  announcements(courseId: string, since?: string): Promise<Row>;
}
const kinds: Record<string, string> = {
  'D2L.LE.Dropbox.Dropbox': 'assignment', 'D2L.LE.Quizzing.Quiz': 'quiz',
  'D2L.LE.Content.ContentObject.ModuleCO': 'module', 'D2L.LE.Content.ContentObject.TopicCO': 'topic',
  'D2L.LE.Discussions.DiscussionTopic': 'discussion', 'D2L.LE.Checklist.ChecklistItem': 'checklist',
};
const eventTypes: Record<number, string> = { 1: 'reminder', 2: 'opens', 3: 'closes', 4: 'unlocks', 5: 'locks', 6: 'due' };
function time(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
function clip(value: unknown): string { return plainText(value).slice(0, 1500); }

/** Consolidate explicit dates; an availability boundary is never relabelled as a due date. */
export async function studyOverview(sources: StudySources, origin: string, courseIds: string[], days = 14,
  options: { now?: number; includeAnnouncements?: boolean } = {}): Promise<Row> {
  if (!Array.isArray(courseIds) || courseIds.length < 1 || courseIds.length > 30 || !Number.isSafeInteger(days) || days < 1 || days > 180) {
    throw new BrightspaceError('INVALID_RANGE', 'Choose 1-30 courses and 1-180 days.');
  }
  const ids = [...new Set(courseIds.map(numericId))], now = options.now ?? Date.now(), end = now + days * 86400_000;
  if (!Number.isFinite(now)) throw new BrightspaceError('INVALID_RANGE', 'The overview time is invalid.');
  const from = new Date(now).toISOString(), to = new Date(end).toISOString();
  const deadlines = new Map<string, Row>(), closingWindows: Row[] = [], events: Row[] = [], undated: Row[] = [];
  const announcements: Row[] = [], coverage: Row[] = [], errors: Row[] = [], partialSources: Row[] = [], warnings: Row[] = [];
  const inWindow = (value: unknown) => { const n = time(value); return n !== undefined && n >= now && n < end; };
  const addDue = (item: Row, sourceUrl: string) => {
    const due = time(item.dueDate);
    if (due === undefined || due < now || due >= end) return;
    const dueDate = new Date(due).toISOString(), key = [item.courseId, item.kind, item.id, dueDate].join(':');
    const previous = deadlines.get(key);
    if (previous) { previous.sources = [...new Set([...array(previous.sources).map(str), sourceUrl])]; return; }
    deadlines.set(key, { ...item, dueDate, sources: [sourceUrl] });
  };
  for (const courseId of ids) {
    const courseUrl = origin + '/d2l/home/' + courseId;
    const requests: [string, () => Promise<Row>][] = [
      ['assignments', () => sources.assignments(courseId)],
      ['quizzes', () => sources.quizzes(courseId)],
      ['calendar', () => sources.calendar(courseId, from, to)],
    ];
    if (options.includeAnnouncements !== false) requests.push(['announcements', () => sources.announcements(courseId, new Date(now - 7 * 86400_000).toISOString())]);
    const results = await Promise.allSettled(requests.map(([, request]) => request()));
    for (let index = 0; index < requests.length; index++) {
      const area = requests[index]![0], result = results[index]!;
      if (result.status === 'rejected') {
        if (result.reason instanceof BrightspaceError && result.reason.code === 'ACCOUNT_CHANGED') throw result.reason;
        const error = safeError(result.reason);
        errors.push({ courseId, area, ...error }); coverage.push({ courseId, area, complete: false, error }); continue;
      }
      const payload = result.value;
      if (payload.source !== 'api' || !Array.isArray(payload.items)) {
        const error = { courseId, area, code: 'PARTIAL_SOURCE', message: 'Only a partial page or unfamiliar data was available.' };
        errors.push(error); coverage.push({ courseId, area, source: payload.source, complete: false });
        partialSources.push({ courseId, area, url: safeSourceUrl(payload.url, origin) ?? courseUrl, text: clip(payload.text), warning: payload.warning ?? error.message });
        continue;
      }
      const rows = payload.items.map(record);
      coverage.push({ courseId, area, source: 'api', complete: payload.complete === true, count: rows.length });
      if (payload.complete !== true) errors.push({ courseId, area, code: 'PARTIAL_RESULTS' });
      if (area === 'assignments' || area === 'quizzes') {
        for (const row of rows) {
          if (row.IsHidden === true || area === 'quizzes' && row.IsActive === false) continue;
          const kind = area === 'assignments' ? 'assignment' : 'quiz', id = str(row.id ?? row.QuizId ?? row.Id);
          if (!/^\d+$/.test(id)) { warnings.push({ courseId, area, code: 'MISSING_ACTIVITY_ID' }); continue; }
          const url = safeSourceUrl(row.url, origin) ?? (kind === 'quiz' ? origin + '/d2l/lms/quizzing/user/quizzes_list.d2l?ou=' + courseId : courseUrl);
          const item = { courseId, kind, id, title: str(row.title ?? row.Name), dueDate: row.dueDate ?? row.DueDate ?? null,
            opensAt: row.opensAt ?? row.StartDate ?? null, closesAt: row.closesAt ?? row.EndDate ?? null, url };
          if (item.dueDate === null || time(item.dueDate) === undefined) {
            undated.push({ ...item, reason: item.dueDate === null ? 'not_published' : 'invalid_date' });
            if (item.dueDate !== null) warnings.push({ courseId, area, id, code: 'INVALID_DUE_DATE' });
          } else addDue(item, url);
          if (inWindow(item.closesAt)) closingWindows.push({ ...item, boundary: 'availability_ends' });
        }
      } else if (area === 'calendar') {
        for (const row of rows) {
          const calendarEventId = str(row.CalendarEventId), id = str(row.OccurrenceId) || calendarEventId;
          const start = time(row.StartDateTime), finish = time(row.EndDateTime);
          const url = safeSourceUrl(row.CalendarEventViewUrl, origin) ?? origin + '/d2l/le/calendar/' + courseId;
          const association = record(row.AssociatedEntity), kind = kinds[str(association.AssociatedEntityType)];
          const event: Row = { courseId, id, calendarEventId, recurrenceId: row.RecurrenceId ?? null,
            occurrence: row.IsOccurrence === true, title: str(row.Title), description: clip(row.Description), startsAt: row.StartDateTime ?? null,
            endsAt: row.EndDateTime ?? null, startDay: row.StartDay ?? null, endDay: row.EndDay ?? null,
            allDay: row.IsAllDayEvent === true, recurring: row.IsRecurring === true, location: str(row.LocationName),
            eventType: eventTypes[Number(row.EventType)] ?? 'unknown', url, associatedKind: kind, associatedId: str(association.AssociatedEntityId) || undefined };
          if (row.IsRecurring === true && row.IsOccurrence !== true) warnings.push({ courseId, area, id, code: 'RECURRENCE_NOT_EXPANDED', message: 'Recurring series are shown; individual occurrences may need the calendar page.' });
          if (start === undefined) {
            if (!row.IsAllDayEvent) warnings.push({ courseId, area, id, code: 'MISSING_EVENT_TIME' });
            events.push(event);
          } else if (start < end && (finish ?? start) >= now) events.push(event);
          // Only the documented DueDate event type establishes a deadline.
          if (Number(row.EventType) === 6 && start !== undefined) {
            addDue({ courseId, kind: kind ?? 'calendar', id: kind ? str(association.AssociatedEntityId) || id : id,
              title: event.title, dueDate: row.StartDateTime, url }, url);
          }
        }
      } else {
        const sorted = [...rows].sort((a, b) => (time(b.modifiedAt ?? b.publishedAt ?? b.createdAt) ?? 0) - (time(a.modifiedAt ?? a.publishedAt ?? a.createdAt) ?? 0));
        for (const row of sorted.slice(0, 5)) announcements.push({ courseId, id: row.id, title: row.title, text: clip(row.text),
          publishedAt: row.publishedAt, modifiedAt: row.modifiedAt, url: safeSourceUrl(row.url, origin) ?? courseUrl });
        const lastCoverage = coverage[coverage.length - 1]!;
        lastCoverage.returned = Math.min(5, sorted.length); lastCoverage.limited = sorted.length > 5;
      }
    }
  }
  const items = [...deadlines.values()].sort((a, b) => time(a.dueDate)! - time(b.dueDate)!);
  const seenDue = new Map<string, string>();
  for (const item of items) {
    const key = [item.courseId, item.kind, item.id].join(':'), previous = seenDue.get(key);
    if (previous && previous !== item.dueDate) warnings.push({ courseId: item.courseId, kind: item.kind, id: item.id, code: 'CONFLICTING_DUE_DATES', message: 'Different sources publish different dates for this activity; verify its details.' });
    seenDue.set(key, str(item.dueDate));
  }
  closingWindows.sort((a, b) => time(a.closesAt)! - time(b.closesAt)!);
  events.sort((a, b) => (time(a.startsAt) ?? 0) - (time(b.startsAt) ?? 0));
  return { source: 'api', fetchedAt: new Date().toISOString(), timezone: 'Europe/Amsterdam', from, to,
    courseIds: ids, deadlines: items, closingWindows, events, activitiesWithoutDueDates: undated,
    announcements, coverage, errors, warnings, partialSources, complete: errors.length === 0 && warnings.length === 0,
    scope: 'Published assignment and quiz dates, explicit calendar due-date events, scheduled events, and up to five announcements per course from the last seven days. No attempt or submission state is inferred.',
    note: 'Availability closing times are separate from due dates. Individual extensions and deadlines inside instructions may require reading the specific activity.' };
}
