import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTimetable, timetableWindow } from '../src/timetable-calendar.js';
import { calendarInWorker } from '../src/mytimetable.js';

const event = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const feed = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic timetable tests//EN', ...events, 'END:VCALENDAR'].join('\r\n');
const read = (text: string, from = '2026-10-01T00:00:00Z', to = '2026-11-01T00:00:00Z') => parseTimetable(text, from, to);
const series = (uid = 'synthetic') => event('UID:' + uid, 'DTSTART;TZID=Europe/Amsterdam:20261018T090000', 'DTEND;TZID=Europe/Amsterdam:20261018T110000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Lecture', 'LOCATION:Room 1');

test('weekly local classes retain their wall time across the Delft autumn clock change', () => {
  const result = read(feed(series()));
  assert.deepEqual(result.items.map(item => item.start), ['2026-10-18T07:00:00.000Z', '2026-10-25T08:00:00.000Z']);
  assert.deepEqual(result.items.map(item => item.localStart), ['2026-10-18T09:00:00', '2026-10-25T09:00:00']);
  assert.equal(result.complete, true);
});

test('UTC, floating and feed-level timezone values are converted to Delft local time', () => {
  const result = read(feed('X-WR-TIMEZONE:America/New_York',
    event('UID:utc', 'DTSTART:20261020T090000Z', 'DTEND:20261020T100000Z'),
    event('UID:floating', 'DTSTART:20261020T090000', 'DURATION:PT1H')));
  assert.deepEqual(result.items.map(item => item.localStart), ['2026-10-20T11:00:00', '2026-10-20T15:00:00']);
});

test('embedded timezone definitions work without a runtime IANA identifier', () => {
  const zone = ['BEGIN:VTIMEZONE', 'TZID:Synthetic/Fixed', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0300', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
  const result = read(feed(zone, event('UID:custom', 'DTSTART;TZID=Synthetic/Fixed:20261020T090000', 'DTEND;TZID=Synthetic/Fixed:20261020T100000')));
  assert.equal(result.items[0]!.start, '2026-10-20T06:00:00.000Z');
});

test('all-day events use exclusive local midnight ends even over a daylight-saving change', () => {
  const result = read(feed(event('UID:all-day', 'DTSTART;VALUE=DATE:20261025', 'SUMMARY:Study day')));
  const item = result.items[0]!;
  assert.equal(item.allDay, true);
  assert.equal(item.start, '2026-10-24T22:00:00.000Z');
  assert.equal(item.end, '2026-10-25T23:00:00.000Z');
  assert.equal(read(feed(event('UID:all-day', 'DTSTART;VALUE=DATE:20261025')), item.end, '2026-10-27T00:00:00Z').items.length, 0);
});

test('EXDATE excludes a class and a moved exception replaces its original slot and room', () => {
  const master = event('UID:changed', 'DTSTART:20261010T080000Z', 'DTEND:20261010T100000Z',
    'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20261011T080000Z', 'SUMMARY:Lab', 'LOCATION:Old room');
  const moved = event('UID:changed', 'RECURRENCE-ID:20261012T080000Z', 'DTSTART:20261012T110000Z', 'DTEND:20261012T130000Z', 'LOCATION:New room');
  const result = read(feed(master, moved));
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1]!.localStart, '2026-10-12T13:00:00');
  assert.equal(result.items[1]!.location, 'New room');
  assert.equal(result.items[1]!.title, 'Lab');
});

test('a moved occurrence enters the requested window even when its original date is much later', () => {
  const moved = event('UID:synthetic', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20261101T090000',
    'DTSTART;TZID=Europe/Amsterdam:20261019T100000', 'DTEND;TZID=Europe/Amsterdam:20261019T120000');
  const result = read(feed(series(), moved), '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.localStart, '2026-10-19T10:00:00');
});

test('UTC recurrence exceptions match local series without duplicating the changed event', () => {
  const changed = event('UID:synthetic', 'RECURRENCE-ID:20261025T080000Z', 'DTSTART:20261025T100000Z', 'DTEND:20261025T120000Z');
  const result = read(feed(series(), changed));
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1]!.localStart, '2026-10-25T11:00:00');
});

test('cancellation without DTSTART replaces the active class and does not affect another series', () => {
  const cancellation = event('UID:synthetic', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20261025T090000', 'STATUS:CANCELLED');
  const result = read(feed(series(), series('unrelated'), cancellation));
  assert.equal(result.items.length, 4);
  assert.equal(result.items.filter(item => item.status === 'cancelled').length, 1);
  const cancelled = result.items.find(item => item.status === 'cancelled')!;
  assert.equal(cancelled.localStart, '2026-10-25T09:00:00');
  assert.equal(cancelled.localEnd, '2026-10-25T11:00:00');
  assert.equal(cancelled.title, 'Lecture');
});

test('half-open query windows include overlapping and instantaneous events without duplicates', () => {
  const result = read(feed(event('UID:overlap', 'DTSTART:20261020T070000Z', 'DTEND:20261020T090000Z'),
    event('UID:instant', 'DTSTART:20261020T080000Z'), event('UID:end', 'DTSTART:20261020T100000Z')),
  '2026-10-20T08:00:00Z', '2026-10-20T10:00:00Z');
  assert.equal(result.items.length, 2);
});

test('unsupported range changes, duplicate identities and missing starts fail explicitly', () => {
  for (const text of [feed(series(), series()), feed(event('DTSTART:20261020T080000Z')),
    feed(event('UID:missing')), feed(series(), event('UID:synthetic', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261025T090000Z', 'DTSTART:20261025T100000Z'))]) {
    assert.throws(() => read(text), { code: 'TIMETABLE_FORMAT_CHANGED' });
  }
});

test('text/category clipping is reported instead of claiming complete output', () => {
  const result = read(feed(event('UID:long', 'DTSTART:20261020T080000Z', 'DESCRIPTION:' + 'x'.repeat(4500),
    'CATEGORIES:' + Array.from({ length: 35 }, (_, i) => 'Category' + i).join(','))));
  assert.equal(result.complete, false); assert.equal(result.warnings.length, 2);
  assert.equal(result.items[0]!.description.length, 4000); assert.equal(result.items[0]!.categories.length, 30);
});

test('worker rejects malformed feeds without exposing input, and never follows event URLs', async () => {
  await assert.rejects(calendarInWorker(feed(event('UID:private-value', 'DTSTART:private-value')), '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), (error: any) => {
    assert.equal(error.code, 'TIMETABLE_FORMAT_CHANGED'); assert.equal(String(error).includes('private-value'), false); return true;
  });
  const result = await calendarInWorker(feed(event('UID:url', 'DTSTART:20261020T080000Z', 'URL:https://invalid.example/private',
    'ATTACH:https://invalid.example/private')), '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
  assert.equal(result.items[0]!.sourceUrl, 'https://mytimetable.tudelft.nl/schedule');
});

test('bounds reject truncated feeds, excessive output and unqualified or oversized date windows', () => {
  assert.throws(() => read('BEGIN:VCALENDAR\r\nVERSION:2.0'), { code: 'TIMETABLE_FORMAT_CHANGED' });
  assert.throws(() => timetableWindow('2026-10-01T00:00:00', '2026-11-01T00:00:00Z'), { code: 'INVALID_RANGE' });
  assert.throws(() => timetableWindow('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'), { code: 'INVALID_RANGE' });
  assert.throws(() => read(feed(event('UID:many', 'DTSTART:20261001T000000Z', 'RRULE:FREQ=MINUTELY;COUNT=2001'))), { code: 'TIMETABLE_LIMIT' });
});
