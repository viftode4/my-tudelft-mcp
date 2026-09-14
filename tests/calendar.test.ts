import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrightspaceClient } from '../src/client.js';
import { StudentCalendar } from '../src/calendar.js';
import { BrightspaceError } from '../src/errors.js';
import { record, type Row } from '../src/util.js';

const primary = 'calendar/events/myEventsWithOccurrences/';
const secondary = '123/calendar/events/occurrences/';
const legacy = '123/calendar/events/myEvents/';
const origin = 'https://school.example';
const from = '2026-09-01T00:00:00Z', to = '2026-10-01T00:00:00Z';
const start = '2026-09-14T08:00:00Z', end = '2026-09-14T09:00:00Z';
const event = (extra: Row = {}): Row => ({ CalendarEventId: 7, OrgUnitId: 123, Title: 'Weekly lecture', Description: '<p>Course lecture</p>',
  StartDateTime: '2026-08-24T08:00:00Z', EndDateTime: '2026-08-24T09:00:00Z', IsAllDayEvent: false,
  StartDay: null, EndDay: null, IsRecurring: true, RecurrenceInfo: { RepeatType: 3, RepeatEvery: 1 },
  CalendarEventViewUrl: origin + '/calendar/7', EventType: 1, ...extra });
const occurrence = (extra: Row = {}): Row => ({ RecurrenceId: 901, CalendarEventId: null, StartDateTime: start, EndDateTime: end,
  IsAllDayEvent: false, StartDay: null, EndDay: null, ...extra });
const wrapped = (base: Row = event(), occurrences: unknown[] = [occurrence()]): Row => ({ EventDataInfo: base, Occurrences: occurrences });

function fixture() {
  const payloads = new Map<string, unknown>([[primary, [wrapped()]]]);
  const failures = new Map<string, Error>();
  const incomplete = new Set<string>();
  const calls: { method: string; path: string; params?: Record<string, string>; maxPages?: number }[] = [];
  const client = {
    config: { baseUrl: origin },
    list: async (_product: string, path: string, params: Record<string, string>, maxPages: number) => {
      calls.push({ method: 'list', path, params, maxPages });
      if (failures.has(path)) throw failures.get(path)!;
      return { items: structuredClone(payloads.get(path) ?? []) as unknown[], complete: !incomplete.has(path),
        ...(incomplete.has(path) ? { nextUrl: origin + '/d2l/api/le/1.94/calendar/events/myEventsWithOccurrences/?page=2&token=private' } : {}) };
    },
    json: async (_product: string, path: string) => {
      calls.push({ method: 'json', path });
      if (failures.has(path)) throw failures.get(path)!;
      return structuredClone(payloads.get(path));
    },
  } as unknown as BrightspaceClient;
  const calendar = new StudentCalendar(client);
  const oldServer = () => { failures.set(primary, new BrightspaceError('NOT_FOUND', 'Unsupported route.')); failures.set(secondary, new BrightspaceError('PERMISSION_DENIED', 'Unsupported scope.')); };
  return { calendar, payloads, failures, incomplete, calls, oldServer };
}

const codes = (result: { issues: { code: string }[] }) => result.issues.map((issue) => issue.code);

test('uses current-user occurrence endpoint with one course and normalized explicit window, preserving series and occurrence identities', async () => {
  const { calendar, calls, payloads } = fixture();
  payloads.set(primary, [wrapped(event(), [occurrence(), occurrence({ RecurrenceId: 902, StartDateTime: '2026-09-21T10:00:00Z', EndDateTime: '2026-09-21T11:30:00Z' })])]);
  const result = await calendar.get('123', '2026-09-01T02:00:00+02:00', to);
  assert.deepEqual(calls, [{ method: 'list', path: primary, params: { orgUnitIdsCSV: '123', startDateTime: '2026-09-01T00:00:00.000Z', endDateTime: '2026-10-01T00:00:00.000Z' }, maxPages: 20 }]);
  assert.equal(result.complete, true); assert.equal(result.recurrenceExpanded, true); assert.equal(result.items.length, 2);
  assert.equal(result.items[0]!.CalendarEventId, 7); assert.equal(result.items[0]!.RecurrenceId, 901);
  assert.equal(result.items[0]!.StartDateTime, start); assert.equal(result.items[0]!.SeriesStartDateTime, '2026-08-24T08:00:00Z');
  assert.equal(result.items[0]!.IsOccurrence, true); assert.equal(result.items[0]!.IsRecurring, true);
  assert.equal(result.items[0]!.Description, 'Course lecture');
  assert.notEqual(result.items[0]!.OccurrenceId, result.items[1]!.OccurrenceId);
  assert.deepEqual(result.items[0]!.OccurrenceSource, { source: 'api', apiPath: primary });
  assert.equal(result.sources[0]!.status, 'available'); assert.equal(result.timezone, 'Europe/Amsterdam');
});

test('trusts actual server occurrences including moved occurrences, without recreating missing or cancelled weekly dates', async () => {
  const { calendar, payloads } = fixture();
  payloads.set(primary, [wrapped(event(), [occurrence({ StartDateTime: '2026-09-15T10:00:00Z', EndDateTime: '2026-09-15T11:00:00Z' })]), wrapped(event({ CalendarEventId: 8 }), [])]);
  const result = await calendar.get('123', from, to);
  assert.equal(result.complete, true); assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.StartDateTime, '2026-09-15T10:00:00Z');
});

test('applies [from,to) window to timed occurrences, retaining overlaps and boundary point deadlines', async () => {
  const { calendar, payloads } = fixture();
  const events = [
    occurrence({ RecurrenceId: 1, StartDateTime: '2026-08-31T23:00:00Z', EndDateTime: from }),
    occurrence({ RecurrenceId: 2, StartDateTime: '2026-08-31T23:00:00Z', EndDateTime: '2026-09-01T01:00:00Z' }),
    occurrence({ RecurrenceId: 3, StartDateTime: from, EndDateTime: from }),
    occurrence({ RecurrenceId: 4, StartDateTime: to, EndDateTime: null }),
    occurrence({ RecurrenceId: 5, StartDateTime: '2026-10-02T00:00:00Z', EndDateTime: '2026-10-02T01:00:00Z' }),
  ];
  payloads.set(primary, [wrapped(event(), events)]);
  const result = await calendar.get('123', from, to);
  assert.deepEqual(result.items.map((item) => item.RecurrenceId), [2, 3]); assert.equal(result.complete, true);
});

test('preserves all-day civil dates across the spring and autumn DST boundaries with exclusive EndDay', async () => {
  const { calendar, payloads } = fixture();
  for (const dates of [
    { first: '2026-03-29', next: '2026-03-30', before: '2026-03-28T22:59:59Z', begins: '2026-03-28T23:00:00Z', finishes: '2026-03-29T22:00:00Z' },
    { first: '2026-10-25', next: '2026-10-26', before: '2026-10-24T21:59:59Z', begins: '2026-10-24T22:00:00Z', finishes: '2026-10-25T23:00:00Z' },
  ]) {
    payloads.set(primary, [wrapped(event(), [occurrence({ IsAllDayEvent: true, StartDateTime: null, EndDateTime: null, StartDay: dates.first + 'T00:00:00', EndDay: dates.next + 'T00:00:00' })])]);
    const within = await calendar.get('123', dates.begins, dates.finishes);
    assert.equal(within.items.length, 1); assert.equal(within.items[0]!.StartDateTime, null); assert.equal(within.items[0]!.StartDay, dates.first + 'T00:00:00');
    assert.equal((await calendar.get('123', dates.before, dates.begins)).items.length, 0);
    assert.equal((await calendar.get('123', dates.finishes, new Date(Date.parse(dates.finishes) + 3600_000).toISOString())).items.length, 0);
  }
});

test('rejects impossible, ambiguous, reversed or unbounded windows and invalid limits before API reads', async () => {
  const { calendar, calls } = fixture();
  for (const value of ['2026-02-30T00:00:00Z', '2026-09-14T10:00:00', '2026-09-14', '2026-09-14T24:00:00Z', '2026-09-14T10:60:00Z']) {
    await assert.rejects(calendar.get('123', value, to), { code: 'INVALID_DATE' });
  }
  await assert.rejects(calendar.get('123', to, from), { code: 'INVALID_RANGE' });
  await assert.rejects(calendar.get('123', from, '2028-01-01T00:00:00Z'), { code: 'INVALID_RANGE' });
  for (const limits of [{ maxPages: 0 }, { maxEvents: 10_001 }, { maxOccurrences: 1.5 }, { maxSeriesLookups: 51 }]) await assert.rejects(calendar.get('123', from, to, limits), { code: 'INVALID_LIMIT' });
  await assert.rejects(calendar.get('../123', from, to), { code: 'INVALID_ID' });
  assert.equal(calls.length, 0);
});

test('falls back to course current-user occurrence endpoint on unsupported primary route with complete coverage', async () => {
  const { calendar, failures, payloads, calls } = fixture();
  failures.set(primary, new BrightspaceError('NOT_FOUND', 'Unavailable.')); payloads.set(secondary, [wrapped()]);
  const result = await calendar.get('123', from, to, { maxPages: 3 });
  assert.equal(result.apiPath, secondary); assert.equal(result.complete, true); assert.equal(result.recurrenceExpanded, true);
  assert.deepEqual(result.sources.map((source) => source.status), ['unavailable', 'available']);
  assert.equal(calls[1]!.maxPages, 3); assert.equal('orgUnitIdsCSV' in calls[1]!.params!, false);
});

test('authentication, account changes, invalid requests and outages do not trigger alternate reads', async () => {
  const { calendar, failures, calls } = fixture();
  for (const code of ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'UNAVAILABLE', 'API_ERROR', 'API_FORMAT_CHANGED']) {
    calls.length = 0; failures.set(primary, new BrightspaceError(code, 'Unavailable.', { status: 400 }));
    await assert.rejects(calendar.get('123', from, to), { code }); assert.equal(calls.length, 1);
  }
});

test('legacy fallback expands only returned series via documented event route and marks missing series coverage incomplete', async () => {
  const { calendar, payloads, calls, oldServer } = fixture(); oldServer();
  payloads.set(legacy, [event()]); payloads.set('123/calendar/event/7/occurrences', wrapped(event(), [occurrence(), occurrence({ RecurrenceId: 900, StartDateTime: '2026-08-24T08:00:00Z', EndDateTime: '2026-08-24T09:00:00Z' })]));
  const result = await calendar.get('123', from, to);
  assert.equal(result.complete, false); assert.equal(result.recurrenceExpanded, false); assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.IsOccurrence, true); assert.equal(result.items[0]!.RecurrenceId, 901);
  assert.ok(codes(result).includes('RECURRENCE_COVERAGE_PARTIAL'));
  assert.deepEqual(calls.at(-1), { method: 'json', path: '123/calendar/event/7/occurrences' });
});

test('unavailable legacy series retain only the known dated base event with explicit unexpanded status', async () => {
  const { calendar, payloads, failures, oldServer } = fixture(); oldServer();
  payloads.set(legacy, [event({ StartDateTime: start, EndDateTime: end })]);
  failures.set('123/calendar/event/7/occurrences', new BrightspaceError('NOT_FOUND', 'Series unavailable.'));
  const result = await calendar.get('123', from, to);
  assert.equal(result.items.length, 1); assert.equal(result.items[0]!.IsOccurrence, false);
  assert.ok(codes(result).includes('RECURRENCE_UNAVAILABLE')); assert.equal(result.complete, false);
});

test('legacy per-series authentication failure aborts instead of returning a stale partial snapshot', async () => {
  const { calendar, payloads, failures, oldServer } = fixture(); oldServer(); payloads.set(legacy, [event()]);
  for (const code of ['AUTH_REQUIRED', 'ACCOUNT_CHANGED']) {
    failures.set('123/calendar/event/7/occurrences', new BrightspaceError(code, 'Reconnect.'));
    await assert.rejects(calendar.get('123', from, to), { code });
  }
});

test('pagination, event and occurrence caps disclose incomplete coverage and preserve a sanitized continuation', async () => {
  const { calendar, payloads, incomplete } = fixture(); incomplete.add(primary);
  payloads.set(primary, [wrapped(event(), [occurrence(), occurrence({ RecurrenceId: 902 })]), wrapped(event({ CalendarEventId: 8 }))]);
  const result = await calendar.get('123', from, to, { maxEvents: 1, maxOccurrences: 1 });
  assert.equal(result.items.length, 1); assert.equal(result.complete, false); assert.equal(result.recurrenceExpanded, false);
  assert.deepEqual(codes(result), ['CALENDAR_PAGE_LIMIT', 'CALENDAR_EVENT_LIMIT', 'CALENDAR_OCCURRENCE_LIMIT']);
  assert.equal(String(result.nextUrl).includes('private'), false); assert.equal(new URL(String(result.nextUrl)).searchParams.get('page'), '2');
});

test('legacy per-series requests are capped before another network request', async () => {
  const { calendar, payloads, calls, oldServer } = fixture(); oldServer();
  payloads.set(legacy, [event(), event({ CalendarEventId: 8 })]); payloads.set('123/calendar/event/7/occurrences', wrapped());
  const result = await calendar.get('123', from, to, { maxSeriesLookups: 1 });
  assert.equal(calls.filter((call) => call.method === 'json').length, 1); assert.ok(codes(result).includes('CALENDAR_SERIES_LIMIT'));
});

test('verifies course and event identities before exposing metadata or expanding legacy detail routes', async () => {
  const { calendar, payloads, calls, oldServer } = fixture();
  payloads.set(primary, [wrapped(event({ OrgUnitId: 999, Title: 'Other course private event' })), wrapped(event({ OrgUnitId: undefined })), wrapped(event({ OrgUnit: { Id: 999 } })), wrapped(event({ CalendarEventId: 9, OrgUnitId: undefined, OrgUnit: { Id: 123 } }))]);
  let result = await calendar.get('123', from, to);
  assert.equal(result.items.length, 1); assert.equal(result.items[0]!.CalendarEventId, 9); assert.equal(result.items[0]!.OrgUnitId, '123');
  assert.equal(JSON.stringify(result).includes('Other course private event'), false); assert.ok(codes(result).includes('CALENDAR_SCOPE_MISMATCH'));
  oldServer(); calls.length = 0; payloads.set(legacy, [event({ OrgUnitId: 999 })]);
  result = await calendar.get('123', from, to);
  assert.equal(result.items.length, 0); assert.equal(calls.some((call) => call.method === 'json'), false);
});

test('rejects mismatched recurrence IDs, malformed wrapper lists and invalid dates without claiming complete coverage', async () => {
  const { calendar, payloads } = fixture();
  payloads.set(primary, [wrapped(event(), [occurrence({ CalendarEventId: 99 }), occurrence({ RecurrenceId: 'bad' }), occurrence({ StartDateTime: '2026-02-30T00:00:00Z' }), occurrence({ EndDateTime: '2026-09-14T07:00:00Z' })]), { EventDataInfo: event(), Occurrences: null }, wrapped(event({ CalendarEventId: 8 }), [occurrence()])]);
  const result = await calendar.get('123', from, to);
  assert.equal(result.items.length, 1); assert.equal(result.items[0]!.CalendarEventId, 8);
  assert.equal(result.complete, false); assert.ok(codes(result).includes('API_FORMAT_CHANGED')); assert.ok(codes(result).includes('CALENDAR_DATE_UNRECOGNISED'));
});

test('rejects a detail response for a different series', async () => {
  const { calendar, payloads, oldServer } = fixture(); oldServer(); payloads.set(legacy, [event()]);
  payloads.set('123/calendar/event/7/occurrences', wrapped(event({ CalendarEventId: 99 })));
  const result = await calendar.get('123', from, to); assert.equal(result.items.length, 0); assert.ok(codes(result).includes('API_FORMAT_CHANGED'));
});

test('deduplicates the same occurrence repeated across pages without collapsing different occurrences of its series', async () => {
  const { calendar, payloads } = fixture();
  payloads.set(primary, [wrapped(), wrapped(), wrapped(event(), [occurrence({ RecurrenceId: 902, StartDateTime: '2026-09-21T08:00:00Z', EndDateTime: '2026-09-21T09:00:00Z' })])]);
  const result = await calendar.get('123', from, to); assert.equal(result.items.length, 2); assert.equal(result.complete, true);
});

test('retains plain one-time events when the modern wrapper has no separate occurrences', async () => {
  const { calendar, payloads } = fixture();
  payloads.set(primary, [wrapped(event({ IsRecurring: false, StartDateTime: start, EndDateTime: end }), [])]);
  const result = await calendar.get('123', from, to);
  assert.equal(result.items.length, 1); assert.equal(result.items[0]!.IsOccurrence, false); assert.equal(result.complete, true);
});

test('calendar metadata and provenance omit credentials, hidden presenters and undocumented response fields', async () => {
  const { calendar, payloads } = fixture();
  payloads.set(primary, [wrapped(event({ Title: '<script>private-script</script>Lecture', CalendarEventViewUrl: origin + '/calendar/7?token=private-token&event=7',
    Description: 'Use https://resource.example/lecture?key=private-key&week=2', Secret: 'private-secret', CreatorUserId: 999,
    AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Dropbox.Dropbox', AssociatedEntityId: 3, Link: '/assignment/3?session=private-session' },
    Presenters: [{ Name: 'Visible tutor', Visible: true }, { Name: 'private-hidden', Visible: false }],
    RecurrenceInfo: { RepeatType: 3, Token: 'private-nested' } }))]);
  const result = await calendar.get('123', from, to), item = result.items[0]!;
  assert.equal(JSON.stringify(result).includes('private-'), false); assert.equal(item.Title, 'Lecture');
  assert.equal(item.CreatorUserId, undefined); assert.equal(record(item.AssociatedEntity).AssociatedEntityId, 3);
  assert.equal(record(item.AssociatedEntity).Link, origin + '/assignment/3');
});


test('the output occurrence cap also bounds legacy one-time events and occurrence-free wrappers', async () => {
  const { calendar, payloads, oldServer } = fixture();
  const base = event({ IsRecurring: false, StartDateTime: start, EndDateTime: end });
  payloads.set(primary, [wrapped(base, []), wrapped({ ...base, CalendarEventId: 8 }, [])]);
  let result = await calendar.get('123', from, to, { maxOccurrences: 1 });
  assert.equal(result.items.length, 1); assert.ok(codes(result).includes('CALENDAR_OCCURRENCE_LIMIT'));
  oldServer(); payloads.set(legacy, [base, { ...base, CalendarEventId: 8 }]);
  result = await calendar.get('123', from, to, { maxOccurrences: 1 });
  assert.equal(result.items.length, 1); assert.ok(codes(result).includes('CALENDAR_OCCURRENCE_LIMIT'));
});

test('orders mixed UTC-offset and civil-day occurrences by their actual Delft instants', async () => {
  const { calendar, payloads } = fixture();
  payloads.set(primary, [wrapped(event(), [
    occurrence({ RecurrenceId: 1, StartDateTime: '2026-09-14T08:30:00Z', EndDateTime: '2026-09-14T09:00:00Z' }),
    occurrence({ RecurrenceId: 2, StartDateTime: '2026-09-14T10:00:00+02:00', EndDateTime: '2026-09-14T11:00:00+02:00' }),
    occurrence({ RecurrenceId: 3, IsAllDayEvent: true, StartDateTime: null, EndDateTime: null, StartDay: '2026-09-14', EndDay: '2026-09-15' }),
  ])]);
  const result = await calendar.get('123', from, to);
  assert.deepEqual(result.items.map((item) => item.RecurrenceId), [3, 2, 1]);
});
