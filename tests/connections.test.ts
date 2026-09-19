import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionOverview, type ConnectionChecks, type ConnectionReport } from '../src/connections.js';
import { BrightspaceError } from '../src/errors.js';
import { record, type Row } from '../src/util.js';

const ORIGIN = 'https://brightspace.example.edu';
const fail = (code: string, message = 'denied') => async (): Promise<Row> => { throw new BrightspaceError(code, message); };

function checks(overrides: Partial<ConnectionChecks> = {}): ConnectionChecks {
  return {
    brightspace: async () => ({ connected: true }),
    mytu: async () => ({ connected: true, identityMethod: 'institutional_student_number' }),
    timetable: async () => ({ configured: true, connectedAt: '2026-09-01T10:00:00.000Z' }),
    recordings: () => ({ state: 'idle', message: 'No recording login is in progress.' }),
    mail: async () => ({ authenticated: true, access: 'read_search_and_unsent_reply_drafts' }),
    ...overrides,
  };
}

const rows = (report: Row): ConnectionReport[] => report.services as ConnectionReport[];
const find = (report: Row, service: string): ConnectionReport => {
  const row = rows(report).find((entry) => entry.service === service);
  assert.ok(row, service);
  return row;
};

test('a fully connected account reports every service once, with no identifiers or links', async () => {
  const report = await connectionOverview(checks(), ORIGIN);
  assert.equal(report.ready, true);
  assert.deepEqual(rows(report).map((row) => row.service), ['brightspace', 'mytu', 'timetable', 'recordings', 'mail']);
  assert.deepEqual(report.connected, ['brightspace', 'mytu', 'timetable', 'mail']);
  assert.deepEqual(report.actionNeeded, []);
  assert.equal(find(report, 'timetable').detail?.connectedAt, '2026-09-01T10:00:00.000Z');
  // Recording access is per topic and is not established by a process-local login state.
  assert.equal(find(report, 'recordings').state, 'unknown');
  const serialized = JSON.stringify(report);
  for (const secret of ['ical', 'accessToken', 'cookie', 'Bearer', 'feedUrl']) assert.ok(!serialized.includes(secret), secret);
});

test('without Brightspace the account-bound services are reported as blocked instead of being called', async () => {
  let called = 0;
  const count = async (): Promise<Row> => { called++; return {}; };
  const report = await connectionOverview(checks({
    brightspace: fail('AUTH_REQUIRED', 'Sign in first.'), mytu: count, timetable: count,
  }), ORIGIN);
  assert.equal(called, 0);
  assert.equal(report.ready, false);
  assert.equal(find(report, 'brightspace').state, 'sign_in_needed');
  for (const service of ['mytu', 'timetable', 'recordings']) assert.equal(find(report, service).state, 'blocked');
  assert.match(String(report.summary), /Brightspace is not connected/);
});

test('optional email is still checked when Brightspace is down, and never blocks readiness', async () => {
  const down = await connectionOverview(checks({ brightspace: fail('AUTH_REQUIRED'), mail: fail('MAIL_AUTH_REQUIRED') }), ORIGIN);
  assert.equal(find(down, 'mail').state, 'not_connected');
  assert.equal(find(down, 'mail').required, false);
  const ready = await connectionOverview(checks({ mail: fail('MAIL_DEPENDENCY_MISSING') }), ORIGIN);
  assert.equal(ready.ready, true);
  assert.match(String(find(ready, 'mail').nextStep), /only when the student asks/i);
});

test('opt-in extras never appear as action needed, while login services do', async () => {
  const report = await connectionOverview(checks({ mail: fail('MAIL_AUTH_REQUIRED'), timetable: async () => ({ configured: false }) }), ORIGIN);
  assert.deepEqual(report.actionNeeded, [
    { service: 'timetable', state: 'sign_in_needed', nextStep: find(report, 'timetable').nextStep },
  ]);
  assert.equal(find(report, 'mail').partOfLogin, false);
  assert.equal(find(report, 'recordings').partOfLogin, false);
  for (const service of ['brightspace', 'mytu', 'timetable']) assert.equal(find(report, service).partOfLogin, true);
});

test('each service that needs attention carries its own next step', async () => {
  const report = await connectionOverview(checks({
    mytu: fail('MYTU_AUTH_REQUIRED'),
    timetable: async () => ({ configured: false }),
  }), ORIGIN);
  assert.equal(find(report, 'mytu').state, 'sign_in_needed');
  assert.match(String(find(report, 'mytu').nextStep), /--only mytu|begin_mytu_login/);
  assert.equal(find(report, 'timetable').state, 'sign_in_needed');
  assert.match(String(find(report, 'timetable').nextStep), /--only timetable|connect_timetable_from_browser/);
  assert.deepEqual(report.actionNeeded, [
    { service: 'mytu', state: 'sign_in_needed', nextStep: find(report, 'mytu').nextStep },
    { service: 'timetable', state: 'sign_in_needed', nextStep: find(report, 'timetable').nextStep },
  ]);
});

test('a changed account is reported as a reconnection, not as a routine sign-in', async () => {
  const report = await connectionOverview(checks({ mytu: fail('MYTU_ACCOUNT_MISMATCH') }), ORIGIN);
  const row = find(report, 'mytu');
  assert.equal(row.state, 'not_connected');
  assert.match(String(row.nextStep), /logout_mytu/);
});

test('an unexpected provider failure is sanitized and never mistaken for a sign-in prompt', async () => {
  const report = await connectionOverview(checks({ mytu: async () => { throw new Error('socket hang up at https://osiris.example/token?cookie=abc'); } }), ORIGIN);
  const row = find(report, 'mytu');
  assert.equal(row.state, 'not_connected');
  assert.equal(record(row.error).code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(row).includes('osiris.example'));
});
