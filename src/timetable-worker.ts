import { parentPort, workerData } from 'node:worker_threads';
import { parseTimetable } from './timetable-calendar.js';
import { BrightspaceError } from './errors.js';

globalThis.fetch = async () => { throw new Error('Calendar parsing cannot access the network.'); };
try {
  parentPort?.postMessage({ calendar: parseTimetable(workerData.text, workerData.from, workerData.to) });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof BrightspaceError ? { code: error.code, message: error.message }
    : { code: 'TIMETABLE_FORMAT_CHANGED', message: 'The iCalendar feed could not be parsed.' } });
} finally { parentPort?.close(); }
