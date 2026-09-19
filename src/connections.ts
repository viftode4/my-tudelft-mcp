import { safeError } from './errors.js';
import { record, type Row } from './util.js';

/**
 * One answer to "what is actually connected?".
 *
 * Without this, a student or an agent needs up to seven separate calls
 * (check_auth, get_login_status, check_mytu_auth, get_mytu_login_status,
 * get_timetable_status, get_recording_login_status, check_mail_auth) and has to
 * reconcile five different result shapes. This runs the same silent checks once
 * and reports them in one shape, with the next step for anything not ready.
 *
 * No login window is ever opened, and no identifier, address, token or private
 * feed URL is included: the report is safe to read aloud, log or paste into an
 * issue.
 */

export type ConnectionState = 'connected' | 'sign_in_needed' | 'not_connected' | 'blocked' | 'unknown';

export interface ConnectionReport {
  service: string;
  label: string;
  state: ConnectionState;
  /** Brightspace alone: nothing account-bound works without it. */
  required: boolean;
  /** Connected by `npm run login`, so a missing one is worth reporting unprompted. */
  partOfLogin: boolean;
  message: string;
  nextStep?: string;
  detail?: Row;
  error?: ReturnType<typeof safeError>;
}

/** The silent checks this overview runs. Each is the provider's own existing check. */
export interface ConnectionChecks {
  /** Brightspace: the account every other service is bound to. */
  brightspace: () => Promise<Row>;
  /** My TU Delft (OSIRIS) official records. */
  mytu: () => Promise<Row>;
  /** MyTimetable calendar subscription; local configuration only. */
  timetable: () => Promise<Row>;
  /** Collegerama login progress in this process. */
  recordings: () => Row;
  /** Optional Microsoft university email, for this process only. */
  mail: () => Promise<Row>;
}

const SIGN_IN_CODES = new Set(['AUTH_REQUIRED', 'MYTU_AUTH_REQUIRED', 'TIMETABLE_AUTH_REQUIRED', 'RECORDING_AUTH_REQUIRED',
  'LOGIN_TIMEOUT', 'LOGIN_CANCELLED', 'MYTU_LOGIN_TIMEOUT', 'TIMETABLE_LOGIN_TIMEOUT']);

/** What the student should do next, keyed by the sanitized error code. */
function nextStepFor(service: string, code: string): string {
  if (code === 'MYTU_ACCOUNT_MISMATCH') return 'The saved My TU Delft account no longer matches this Brightspace account. Run logout_mytu, then begin_mytu_login when the student asks.';
  if (code === 'ACCOUNT_CHANGED') return 'The Brightspace account changed. Run check_auth, then reconnect this service.';
  if (code === 'TIMETABLE_NOT_CONNECTED') return 'Run `npm run login -- --only timetable`, or connect_timetable_from_browser when the student asks.';
  if (!SIGN_IN_CODES.has(code)) return 'Read the error code and message; this is not an authentication problem.';
  if (service === 'brightspace') return 'Run `npm run login`. In an MCP client, begin_login needs interactive:true and the student’s explicit request.';
  if (service === 'mytu') return 'Run `npm run login -- --only mytu`, or begin_mytu_login when the student asks.';
  if (service === 'timetable') return 'Run `npm run login -- --only timetable`, or connect_timetable_from_browser when the student asks.';
  if (service === 'recordings') return 'Recordings sign in per course topic: begin_recording_login when the student asks.';
  return 'Sign in to this service when the student asks.';
}

const LOGIN_SERVICES = new Set(['brightspace', 'mytu', 'timetable']);

function failure(service: string, label: string, required: boolean, error: unknown, message: string): ConnectionReport {
  const safe = safeError(error);
  return { service, label, required, partOfLogin: LOGIN_SERVICES.has(service),
    state: SIGN_IN_CODES.has(safe.code) || safe.code === 'TIMETABLE_NOT_CONNECTED' ? 'sign_in_needed' : 'not_connected',
    message, nextStep: nextStepFor(service, safe.code), error: safe };
}

const blocked = (service: string, label: string, required: boolean): ConnectionReport => ({
  service, label, required, partOfLogin: LOGIN_SERVICES.has(service), state: 'blocked',
  message: 'Not checked: this service is bound to a verified Brightspace account.',
  nextStep: 'Connect Brightspace first, then check again.',
});

export async function connectionOverview(checks: ConnectionChecks, origin: string): Promise<Row> {
  const services: ConnectionReport[] = [];

  let brightspaceConnected = false;
  try {
    await checks.brightspace();
    brightspaceConnected = true;
    services.push({ service: 'brightspace', label: 'Brightspace', required: true, partOfLogin: true, state: 'connected',
      message: 'Signed in and verified against the live current-user API.',
      detail: { accountVerified: true, origin } });
  } catch (error) {
    services.push(failure('brightspace', 'Brightspace', true, error, 'Not signed in, or the saved session no longer verifies.'));
  }

  if (!brightspaceConnected) {
    services.push(blocked('mytu', 'My TU Delft (OSIRIS)', false));
    services.push(blocked('timetable', 'MyTimetable', false));
    services.push(blocked('recordings', 'Collegerama recordings', false));
  } else {
    try {
      const result = record(await checks.mytu());
      services.push({ service: 'mytu', label: 'My TU Delft (OSIRIS)', required: false, partOfLogin: true, state: 'connected',
        message: 'Connected and matched to this Brightspace account.',
        detail: { accountVerified: true, identityMethod: result.identityMethod, officialResults: true } });
    } catch (error) {
      services.push(failure('mytu', 'My TU Delft (OSIRIS)', false, error, 'No verified My TU Delft connection for this account.'));
    }

    try {
      const result = record(await checks.timetable());
      services.push(result.configured === true
        ? { service: 'timetable', label: 'MyTimetable', required: false, partOfLogin: true, state: 'connected',
            message: 'A personal calendar subscription is saved for this account. Read it with get_timetable.',
            detail: { configured: true, accountBound: true, connectedAt: result.connectedAt, liveVerified: false } }
        : { service: 'timetable', label: 'MyTimetable', required: false, partOfLogin: true, state: 'sign_in_needed',
            message: 'No calendar subscription is saved for this account.',
            nextStep: nextStepFor('timetable', 'TIMETABLE_NOT_CONNECTED'), detail: { configured: false } });
    } catch (error) {
      services.push(failure('timetable', 'MyTimetable', false, error, 'The saved timetable subscription could not be checked.'));
    }

    const recordings = record(checks.recordings());
    services.push({ service: 'recordings', label: 'Collegerama recordings', required: false, partOfLogin: false,
      state: 'unknown',
      message: recordings.state === 'waiting'
        ? 'An interactive recording login is in progress in this process.'
        : 'Recording access is per course topic and is verified only when read_recording runs.',
      nextStep: 'Call read_recording for an exact course topic; it renews a saved session silently.',
      detail: { loginState: recordings.state } });
  }

  try {
    const result = record(await checks.mail());
    services.push({ service: 'mail', label: 'University email (Microsoft)', required: false, partOfLogin: false, state: 'connected',
      message: 'An email session is active for this connector process only.',
      detail: { access: result.access, canSend: false, persistence: 'current_mcp_process' } });
  } catch (error) {
    const report = failure('mail', 'University email (Microsoft)', false, error, 'Optional. No email session in this connector process.');
    report.nextStep = 'Optional and independent of coursework tools. Start begin_mail_login only when the student asks.';
    services.push(report);
  }

  const connected = services.filter(service => service.state === 'connected').map(service => service.service);
  // Optional extras (recordings, email) are not "action needed": they are connected only when the student asks.
  const actionNeeded = services.filter(service => service.partOfLogin && (service.state === 'sign_in_needed' || service.state === 'not_connected'))
    .map(service => ({ service: service.service, state: service.state, nextStep: service.nextStep }));
  const ready = services.find(service => service.service === 'brightspace')?.state === 'connected';
  return {
    origin, checkedAt: new Date().toISOString(), services, connected, actionNeeded,
    ready,
    summary: ready
      ? `Brightspace is connected. Connected services: ${connected.join(', ')}.${actionNeeded.length ? ` Needs attention: ${actionNeeded.map(item => item.service).join(', ')}.` : ''}`
      : 'Brightspace is not connected. Sign in to Brightspace before using account-bound services.',
    note: 'Checked silently from saved sessions. No login window was opened and no identifier, token or private calendar link is included.',
  };
}
