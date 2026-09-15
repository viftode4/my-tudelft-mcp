import { BrightspaceError, safeError } from './errors.js';
import type { MyTuStudy } from './mytu-study.js';
import type { MyTimetable } from './mytimetable.js';
import { timetableWindow } from './timetable-calendar.js';
import { record, type Row } from './util.js';

/** Compare timed events only. A timetable subscription is not proof of registration. */
export function timetableConflicts(events: unknown[]) {
  if (events.length > 5000) throw new BrightspaceError('TIMETABLE_LIMIT', 'Too many events to compare. Choose a shorter window.');
  let excludedAllDay = 0;
  const timed = events.flatMap(value => {
    const row = record(value);
    if (row.status === 'CANCELLED') return [];
    if (row.allDay === true) { excludedAllDay++; return []; }
    const start = typeof row.start === 'string' ? Date.parse(row.start) : NaN;
    const end = typeof row.end === 'string' ? Date.parse(row.end) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || typeof row.id !== 'string') {
      throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'A timetable event has no valid interval or identifier.');
    }
    return [{ row, start, end }];
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const items: { first: Row; second: Row; overlapMinutes: number }[] = [];
  const summary = (row: Row): Row => Object.fromEntries(['id', 'title', 'start', 'end', 'location', 'sourceUrl'].map(key => [key, row[key]]));
  for (let i = 0; i < timed.length; i++) {
    const first = timed[i]!;
    for (let j = i + 1; j < timed.length && timed[j]!.start < first.end; j++) {
      const second = timed[j]!;
      if (items.length === 200) return { items, complete: false, excludedAllDay };
      items.push({ first: summary(first.row), second: summary(second.row),
        overlapMinutes: (Math.min(first.end, second.end) - second.start) / 60_000 });
    }
  }
  return { items, complete: true, excludedAllDay };
}

type Section = { items: unknown[]; complete: boolean; sourceUrl?: string; nextOffset?: number; error?: ReturnType<typeof safeError> };
export class ExamPlanning {
  constructor(private readonly study: Pick<MyTuStudy, 'registrations' | 'available'>,
    private readonly timetable: Pick<MyTimetable, 'events'>,
    private readonly identity: () => Promise<{ id: string }>) {}

  private async pages(read: (offset: number) => Promise<Row>): Promise<Section> {
    const items: unknown[] = [];
    let offset = 0, sourceUrl: string | undefined;
    try {
      for (let page = 0; page < 10; page++) {
        const data = await read(offset);
        if (!Array.isArray(data.items) || typeof data.hasMore !== 'boolean') throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'Exam pagination was not recognised.');
        items.push(...data.items);
        sourceUrl = typeof data.sourceUrl === 'string' ? data.sourceUrl : sourceUrl;
        if (!data.hasMore) return { items, complete: true, sourceUrl };
        if (data.nextOffset !== offset + 100) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'Exam pagination did not advance as expected.');
        offset += 100;
      }
      return { items, complete: false, sourceUrl, nextOffset: offset };
    } catch (error) {
      if (error instanceof BrightspaceError && /ACCOUNT_CHANGED|CANCELLED/.test(error.code)) throw error;
      return { items, complete: false, sourceUrl, nextOffset: offset, error: safeError(error) };
    }
  }

  async overview(from: string, to: string) {
    timetableWindow(from, to);
    const account = (await this.identity()).id;
    const registeredExams = await this.pages(offset => this.study.registrations('exam', { offset, limit: 100 }));
    const openExamCourses = await this.pages(offset => this.study.available('exam', { offset, limit: 100 }));
    let timetable: Row, conflicts: ReturnType<typeof timetableConflicts> | null = null;
    try {
      timetable = await this.timetable.events(from, to);
      if (!Array.isArray(timetable.items)) throw new BrightspaceError('TIMETABLE_FORMAT_CHANGED', 'No recognised timetable event list was returned.');
      conflicts = timetableConflicts(timetable.items);
    } catch (error) {
      if (error instanceof BrightspaceError && /ACCOUNT_CHANGED|CANCELLED/.test(error.code)) throw error;
      timetable = { complete: false, error: safeError(error) };
    }
    if ((await this.identity()).id !== account) throw new BrightspaceError('ACCOUNT_CHANGED', 'The university account changed while building the exam overview.');
    return { registeredExams, openExamCourses, timetable, conflicts, from, to,
      complete: registeredExams.complete && openExamCourses.complete && timetable.complete === true && conflicts?.complete === true,
      backgroundRemindersEnabled: false, fetchedAt: new Date().toISOString(),
      coverage: 'On-demand overview. Exam lists are current OSIRIS lists, not filtered to the timetable window. Open courses do not prove eligibility or a missing registration. Use get_official_course for exact assessment opportunities and registration dates. Clashes cover only timed events in the connected timetable subscription; no automatic course-to-event matching or background notifications.' };
  }
}
