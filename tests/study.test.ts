import assert from 'node:assert/strict';
import test from 'node:test';
import { BrightspaceError } from '../src/errors.js';
import { studyOverview, type StudySources } from '../src/study.js';
import { array, record } from '../src/util.js';
const origin = 'https://brightspace.example', now = Date.parse('2026-09-14T10:00:00Z');
const due = '2026-09-15T10:00:00Z', close = '2026-09-16T10:00:00Z';
function fixtures() {
  const data = { assignments: [] as unknown[], quizzes: [] as unknown[], calendar: [] as unknown[], announcements: [] as unknown[] };
  const calls: string[] = [];
  const sources: StudySources = Object.fromEntries(Object.keys(data).map((area) => [area, async () => {
    calls.push(area); return { source: 'api', items: data[area as keyof typeof data], complete: true };
  }])) as unknown as StudySources;
  return { data, calls, sources };
}
test('overview combines explicit activity/calendar due dates and deduplicates matching linked deadlines', async () => {
  const { data, sources } = fixtures();
  data.assignments.push({ id: '1', title: 'Report', dueDate: due, closesAt: close, url: origin + '/report' });
  data.quizzes.push({ QuizId: 2, Name: 'Quiz', DueDate: '2026-09-15T13:00:00+02:00', EndDate: close, IsActive: true });
  data.calendar.push({ CalendarEventId: 3, Title: 'Report due', EventType: 6, StartDateTime: '2026-09-15T12:00:00+02:00',
    AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Dropbox.Dropbox', AssociatedEntityId: 1 }, CalendarEventViewUrl: origin + '/calendar/3' });
  const result = await studyOverview(sources, origin, ['11'], 14, { now });
  assert.equal(result.complete, true);
  assert.equal(array(result.deadlines).length, 2);
  assert.deepEqual(record(array(result.deadlines)[0]).sources, [origin + '/report', origin + '/calendar/3']);
  assert.equal(array(result.closingWindows).length, 2);
  assert.equal(array(result.events).length, 1);
});
test('closing times, reminder titles and inactive quizzes never invent due dates', async () => {
  const { data, sources } = fixtures();
  data.quizzes.push({ QuizId: 1, Name: 'No published due date', EndDate: close },
    { QuizId: 2, Name: 'Inactive quiz', DueDate: due, IsActive: false });
  data.calendar.push({ CalendarEventId: 3, Title: 'Important deadline exam submission', EventType: 1, StartDateTime: due });
  const result = await studyOverview(sources, origin, ['11'], 14, { now });
  assert.equal(array(result.deadlines).length, 0);
  assert.equal(array(result.closingWindows).length, 1);
  assert.equal(array(result.activitiesWithoutDueDates).length, 1);
  assert.equal(array(result.events).length, 1);
});
test('conflicting activity and calendar dates remain visible with an explicit warning', async () => {
  const { data, sources } = fixtures();
  data.assignments.push({ id: '1', title: 'Report', dueDate: due });
  data.calendar.push({ CalendarEventId: 3, EventType: 6, StartDateTime: close,
    AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Dropbox.Dropbox', AssociatedEntityId: 1 } });
  const result = await studyOverview(sources, origin, ['11'], 14, { now });
  assert.equal(result.complete, false);
  assert.equal(array(result.deadlines).length, 2);
  assert.ok(array(result.warnings).some((w) => record(w).code === 'CONFLICTING_DUE_DATES'));
});
test('partial and failed sources cannot turn into a complete empty overview', async () => {
  const { sources } = fixtures();
  sources.assignments = async () => ({ source: 'browser', text: 'Visible assignment page', url: origin + '/assignments', complete: false });
  sources.quizzes = async () => { throw new BrightspaceError('PERMISSION_DENIED', 'Quiz data is unavailable.'); };
  const result = await studyOverview(sources, origin, ['11'], 14, { now });
  assert.equal(result.complete, false);
  assert.equal(array(result.errors).length, 2);
  assert.equal(record(array(result.partialSources)[0]).text, 'Visible assignment page');
  assert.equal(array(result.coverage).length, 4);
});
test('changed accounts abort the aggregate and invalid input makes no requests', async () => {
  const { calls, sources } = fixtures();
  await assert.rejects(studyOverview(sources, origin, [], 14, { now }), { code: 'INVALID_RANGE' });
  await assert.rejects(studyOverview(sources, origin, ['11/../22'], 14, { now }), { code: 'INVALID_ID' });
  assert.equal(calls.length, 0);
  sources.calendar = async () => { throw new BrightspaceError('ACCOUNT_CHANGED', 'Account changed.'); };
  await assert.rejects(studyOverview(sources, origin, ['11'], 14, { now }), { code: 'ACCOUNT_CHANGED' });
});
test('overview preserves bounded announcement coverage and de-duplicates requested courses', async () => {
  const { data, calls, sources } = fixtures();
  data.announcements.push(...Array.from({ length: 8 }, (_, id) => ({ id: String(id), title: 'Update', text: 'a'.repeat(2000), publishedAt: '2026-09-14T10:00:00Z' })));
  const result = await studyOverview(sources, origin, ['11', '11'], 14, { now });
  assert.equal(calls.length, 4);
  assert.equal(array(result.announcements).length, 5);
  const coverage = array(result.coverage).map(record).find((c) => c.area === 'announcements')!;
  assert.equal(coverage.limited, true); assert.equal(coverage.count, 8);
  assert.equal(String(record(array(result.announcements)[0]).text).length, 1500);
});
test('invalid dates and unexpanded recurring series are reported without claiming complete schedule coverage', async () => {
  const { data, sources } = fixtures();
  data.assignments.push({ id: '1', dueDate: 'tomorrow-ish' });
  data.calendar.push({ CalendarEventId: 2, EventType: 1, StartDateTime: due, IsRecurring: true });
  const result = await studyOverview(sources, origin, ['11'], 14, { now, includeAnnouncements: false });
  assert.equal(result.complete, false);
  assert.deepEqual(array(result.warnings).map((w) => record(w).code), ['INVALID_DUE_DATE', 'RECURRENCE_NOT_EXPANDED']);
  assert.equal(array(result.coverage).length, 3);
});

test('expanded recurring occurrences keep distinct identities without false series warnings or deadline conflicts', async () => {
  const { data, sources } = fixtures();
  data.calendar.push(...[due, close].map((date, i) => ({
    CalendarEventId: 3, OccurrenceId: '3:' + (i+1), RecurrenceId: i+1,
    IsRecurring: true, IsOccurrence: true, EventType: 6, StartDateTime: date,
    EndDateTime: date, Title: 'Weekly submission',
  })));
  const result = await studyOverview(sources, origin, ['11'], 14, { now });
  assert.equal(result.complete, true);
  assert.deepEqual(array(result.events).map(e => record(e).id), ['3:1','3:2']);
  assert.ok(array(result.events).every(e => record(e).calendarEventId === '3' && record(e).occurrence === true));
  assert.equal(array(result.deadlines).length, 2);
  assert.deepEqual(result.warnings, []);
});
