import { createHash, randomBytes } from 'node:crypto';
import { BrightspaceError } from './errors.js';
import type { MyTuAccess, MyTuDelft } from './mytudelft.js';
import { record, str, type Row } from './util.js';
import { MYTU_ID_PATTERN } from './mytu-routes.js';

const ORIGIN = 'https://my.tudelft.nl';
export type RegistrationKind = 'course' | 'exam';
export type RegistrationAction = 'enroll' | 'withdraw';
export interface PageOptions { offset?: number; limit?: number }
const paths = { course: 'cursusinschrijving', exam: 'toetsinschrijving' } as const;
const registered = { course: 'cursussen', exam: 'toetsen' } as const;
function exactId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  if (!MYTU_ID_PATTERN.test(id)) throw new BrightspaceError('INVALID_ID', 'Use an exact identifier from the corresponding My TU Delft tool.');
  return id;
}
function pageOptions(options: PageOptions): { offset: number; limit: number } {
  const offset = options.offset ?? 0, limit = options.limit ?? 25;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new BrightspaceError('INVALID_RANGE', 'Use offset 0–1000000 and limit 1–100.');
  }
  return { offset, limit };
}
function kindPath(kind: RegistrationKind): string {
  if (!Object.hasOwn(paths, kind)) throw new BrightspaceError('INVALID_ARGUMENT', 'Choose course or exam.');
  return '/student/cursussen_voor_' + paths[kind];
}
/** Preserve the university's original academic fields without leaking image blobs or credentials. */
export function studyData(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new BrightspaceError('MYTU_LIMIT', 'The study data exceeded the supported nesting depth.');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.length > 50_000) throw new BrightspaceError('MYTU_LIMIT', 'A study field exceeded its text limit.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 5000) throw new BrightspaceError('MYTU_LIMIT', 'The study data exceeded its item limit.');
    return value.map(item => studyData(item, depth + 1));
  }
  const result: Row = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,100}$/.test(key)
      || /token|password|wachtwoord|secret|cookie|pasfoto|^links$|^href$|^__proto__$|^constructor$|^prototype$/i.test(key)) continue;
    result[key] = studyData(item, depth + 1);
  }
  return result;
}
function source(page: string): Row {
  return { source: 'official_osiris_api', provider: 'My TU Delft', sourceUrl: ORIGIN + page,
    accountVerified: true, fetchedAt: new Date().toISOString() };
}
function collection(value: unknown, options: PageOptions, page: string): Row {
  const { offset, limit } = pageOptions(options), data = record(value);
  if (!Array.isArray(data.items) || data.items.length > limit || typeof data.hasMore !== 'boolean'
    || data.offset !== undefined && data.offset !== offset || data.limit !== undefined && data.limit !== limit
    || data.hasMore && data.items.length !== limit) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The study service returned unfamiliar pagination.');
  return { ...source(page), items: studyData(data.items), offset, limit, hasMore: data.hasMore,
    nextOffset: data.hasMore ? offset + limit : null, complete: offset === 0 && !data.hasMore };
}
function findRows(value: unknown, predicate: (row: Row) => boolean, depth = 0): Row[] {
  if (depth > 20) return [];
  if (Array.isArray(value)) return value.flatMap(item => findRows(item, predicate, depth + 1));
  const row = record(value), found = predicate(row) ? [row] : [];
  return found.concat(...Object.values(row).filter(item => item && typeof item === 'object').map(item => findRows(item, predicate, depth + 1)));
}
function messages(value: unknown): Row[] {
  const rows = record(value).statusmeldingen;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'OSIRIS returned unfamiliar registration messages.');
  return rows.map(row => record(studyData(row)));
}
function examForRegistration(row: Row): Row {
  const result = { ...row };
  for (const field of ['tijd_vanaf', 'tijd_tm']) {
    const value = result[field];
    // The native OSIRIS model serializes decimal clock values (13.3 = 13:30).
    if (value === null || value === 0) result[field] = '';
    else if (typeof value === 'number') {
      const clock = value.toFixed(2).replace('.', ':').padStart(5, '0');
      if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(clock)) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'OSIRIS returned an unfamiliar exam time.');
      result[field] = clock;
    }
  }
  return result;
}
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Preview {
  token: string; expiresAt: number; accountId: string; studentHash: string; kind: RegistrationKind;
  action: RegistrationAction; courseId: string; targetId: string; target: Row; body?: Row;
  method: 'POST' | 'PUT' | 'DELETE'; path: string; digest: string;
  examCodes: string[]; workingMethods: string[];
}

export class MyTuStudy {
  private previews = new Map<string, Preview>();
  private observed = new Map<string, Set<string>>();
  private generation = 0;
  constructor(private readonly mytu: Pick<MyTuDelft, 'withAccess'>) {}
  close(): void { this.generation++; this.previews.clear(); this.observed.clear(); }
  private remember(access: MyTuAccess, area: string, value: unknown): void {
    const key = access.accountId + ':' + access.studentHash + ':' + area;
    const ids = this.observed.get(key) ?? new Set<string>();
    for (const row of findRows(value, row => Object.keys(row).some(key => /^id(?:_|$)/.test(key)))) {
      for (const [field, value] of Object.entries(row)) if (/^id(?:_|$)/.test(field)) {
        try { ids.add(exactId(value)); } catch { /* Non-identifiers are not tool targets. */ }
      }
    }
    if (ids.size > 10_000) throw new BrightspaceError('MYTU_LIMIT', 'Refresh the My TU Delft connection before discovering more targets.');
    this.observed.set(key, ids);
  }
  private requireObserved(access: MyTuAccess, area: string, id: string): void {
    if (!this.observed.get(access.accountId + ':' + access.studentHash + ':' + area)?.has(id)) {
      throw new BrightspaceError('MYTU_TARGET_UNVERIFIED', 'Discover this exact target with its My TU Delft list/search tool in this connection first.');
    }
  }
  async progress(options: PageOptions = {}): Promise<Row> {
    const range = pageOptions(options);
    return this.mytu.withAccess(async access => {
      const result = collection(await access.request('/student/voortgang/per_opleiding/?' + new URLSearchParams({ offset: String(range.offset), limit: String(range.limit) })), range, '/voortgang');
      this.remember(access, 'progress', result.items); return result;
    });
  }
  async programme(progressId: string, section: 'curriculum' | 'advice' = 'curriculum', options: PageOptions = {}): Promise<Row> {
    progressId = exactId(progressId);
    if (!['curriculum', 'advice'].includes(section)) throw new BrightspaceError('INVALID_ARGUMENT', 'Choose curriculum or advice.');
    return this.mytu.withAccess(async access => {
      this.requireObserved(access, 'progress', progressId);
      const range = pageOptions(options);
      const data = await access.request('/student/voortgang/' + progressId + (section === 'curriculum' ? '/onderwijsprogramma'
        : '/studieadviezen?' + new URLSearchParams({ offset: String(range.offset), limit: String(range.limit) })));
      if (section === 'advice') return { ...collection(data, range, '/voortgang'), progressId, section };
      return { ...source('/voortgang'), progressId, section, data: studyData(data),
        complete: Array.isArray(data) || record(data).hasMore === false, coverage: 'The selected published programme section; missing requirements are not inferred.' };
    });
  }
  async registrations(kind: RegistrationKind | 'programme' | 'minor' | 'specialisation', options: PageOptions & { history?: boolean; query?: string } = {}): Promise<Row> {
    const range = pageOptions(options), routes = { ...registered, programme: 'opleidingen', minor: 'minoren', specialisation: 'specialisaties' };
    if (!Object.hasOwn(routes, kind)) throw new BrightspaceError('INVALID_ARGUMENT', 'Choose course, exam, programme, minor or specialisation.');
    const route = routes[kind];
    const params = new URLSearchParams({ offset: String(range.offset), limit: String(range.limit) });
    if (['course', 'exam'].includes(kind)) params.set('toon_historie', options.history ? 'J' : 'N');
    if (options.query) { if (options.query.length > 200 || /[\r\n]/.test(options.query)) throw new BrightspaceError('INVALID_ARGUMENT', 'Use a single-line search of at most 200 characters.'); params.set('zoekstring', options.query); }
    return this.mytu.withAccess(async access => {
      const result = collection(await access.request('/student/inschrijvingen/' + route + '?' + params), range, '/inschrijven/mijn-inschrijvingen');
      this.remember(access, 'registered-' + kind, result.items); return { ...result, kind, history: Boolean(options.history) };
    });
  }
  async available(kind: RegistrationKind, options: PageOptions & { query?: string; planned?: boolean } = {}): Promise<Row> {
    const base = kindPath(kind), range = pageOptions(options);
    if (options.query !== undefined && (options.query.trim().length < 2 || options.query.length > 200 || /[\r\n]/.test(options.query))) throw new BrightspaceError('INVALID_ARGUMENT', 'Use a search of 2–200 characters.');
    return this.mytu.withAccess(async access => {
      let result: Row;
      if (options.query) {
        const query = { from: range.offset, size: range.limit, query: { bool: { must: [{ multi_match: {
          query: options.query.trim().toUpperCase(), type: 'phrase_prefix', fields: ['cursus', 'cursus_korte_naam', 'cursus_lange_naam'], max_expansions: 200,
        } }] } } };
        const data = record(await access.request(base + '/zoeken', 'POST', query)), hits = record(data.hits);
        if (!Array.isArray(hits.hits) || hits.hits.length > range.limit) throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The course search returned an unfamiliar response.');
        const total = typeof hits.total === 'number' ? hits.total : record(hits.total).value;
        const exactTotal = typeof hits.total === 'number' || record(hits.total).relation === 'eq';
        if (!Number.isSafeInteger(total) || Number(total) < 0 || !exactTotal && record(hits.total).relation !== 'gte'
          || hits.hits.some(hit => !Object.keys(record(record(hit)._source)).length)
          || exactTotal && hits.hits.length !== Math.min(range.limit, Math.max(0, Number(total) - range.offset))) {
          throw new BrightspaceError('MYTU_FORMAT_CHANGED', 'The course search returned inconsistent totals or missing course records.');
        }
        const hasMore = exactTotal ? range.offset + hits.hits.length < Number(total) : hits.hits.length === range.limit;
        result = { ...source('/inschrijven/' + (kind === 'course' ? 'cursus' : 'toets')), items: hits.hits.map(hit => studyData(record(hit)._source)),
          ...range, total, totalIsExact: exactTotal, hasMore, nextOffset: hasMore ? range.offset + range.limit : null, complete: range.offset === 0 && !hasMore };
      } else {
        result = collection(await access.request(base + (options.planned ? '/gepland_onderwijs/' : '/te_volgen_onderwijs/open_voor_inschrijving/')
          + '?' + new URLSearchParams({ offset: String(range.offset), limit: String(range.limit) })), range, '/inschrijven/' + (kind === 'course' ? 'cursus' : 'toets'));
      }
      this.remember(access, kind, result.items); return { ...result, kind };
    });
  }
  async course(kind: RegistrationKind, courseId: string, section: 'details' | 'blocks' = 'details'): Promise<Row> {
    const base = kindPath(kind); courseId = exactId(courseId);
    if (!['details', 'blocks'].includes(section) || section === 'blocks' && kind !== 'course') throw new BrightspaceError('INVALID_ARGUMENT', 'Blocks are available for course registration only.');
    return this.mytu.withAccess(async access => {
      this.requireObserved(access, kind, courseId);
      const data = await access.request(base + '/' + courseId + (section === 'blocks' ? '/blokken_voor_cursusinschrijving' : ''));
      this.remember(access, kind, data);
      return { ...source('/inschrijven/' + (kind === 'course' ? 'cursus' : 'toets')), kind, courseId, section, data: studyData(data) };
    });
  }
  async profile(): Promise<Row> {
    return this.mytu.withAccess(async access => ({ ...source('/personalia'), data: studyData(await access.request('/student/personalia')) }));
  }
  async timetable(options: PageOptions = {}): Promise<Row> {
    const range = pageOptions(options);
    return this.mytu.withAccess(async access => collection(await access.request('/student/rooster?' + new URLSearchParams({ offset: String(range.offset), limit: String(range.limit) })), range, '/rooster'));
  }
  private async registrationPlan(access: MyTuAccess, input: {
    kind: RegistrationKind; action?: RegistrationAction; courseId: string; targetId?: string; examCodes?: string[]; workingMethods?: string[];
  }): Promise<Omit<Preview, 'token' | 'expiresAt' | 'accountId' | 'studentHash' | 'digest'>> {
    const base = kindPath(input.kind), action = input.action ?? 'enroll', courseId = exactId(input.courseId);
    if (!['enroll', 'withdraw'].includes(action)) throw new BrightspaceError('INVALID_ARGUMENT', 'Choose enroll or withdraw.');
    const targetId = input.targetId === undefined ? courseId : exactId(input.targetId);
    const examCodes = (input.examCodes ?? []).map(exactId), workingMethods = (input.workingMethods ?? []).map(exactId);
    if (examCodes.length > 30 || workingMethods.length > 30 || new Set(examCodes).size !== examCodes.length || new Set(workingMethods).size !== workingMethods.length) throw new BrightspaceError('INVALID_ARGUMENT', 'Select each published assessment or teaching method at most once.');
    this.requireObserved(access, action === 'withdraw' ? 'registered-' + input.kind : input.kind, action === 'withdraw' ? targetId : courseId);
    let target: Row, body: Row | undefined, method: 'POST' | 'PUT' | 'DELETE', path: string;
    if (action === 'withdraw') {
      if (examCodes.length || workingMethods.length) throw new BrightspaceError('INVALID_ARGUMENT', 'Withdrawal does not accept enrollment selections.');
      path = '/student/inschrijvingen/' + registered[input.kind] + '/' + targetId;
      target = record(studyData(await access.request(path)));
      if (exactId(target[input.kind === 'course' ? 'id_cursus_blok' : 'id_toets_gelegenheid']) !== targetId) throw new BrightspaceError('MYTU_TARGET_UNVERIFIED', 'The current enrollment did not match its requested identifier.');
      if (target.mag_uitschrijven !== 'J') throw new BrightspaceError('MYTU_REGISTRATION_UNAVAILABLE', 'OSIRIS does not explicitly allow withdrawing this enrollment.');
      method = 'DELETE';
    } else {
      const eligibility = await access.request(base + '/' + courseId + '/controleren');
      const warnings = messages(eligibility);
      if (warnings.some(row => ['E', 'W'].includes(str(row.type)))) throw new BrightspaceError('MYTU_REGISTRATION_REVIEW_REQUIRED', 'OSIRIS requires review of these eligibility messages before registration.', { messages: warnings, sourceUrl: ORIGIN + '/inschrijven/' + (input.kind === 'course' ? 'cursus' : 'toets') });
      const details = record(studyData(await access.request(base + '/' + courseId)));
      if (input.kind === 'exam') {
        if (examCodes.length || workingMethods.length) throw new BrightspaceError('INVALID_ARGUMENT', 'For an exam select its exact targetId.');
        const matches = Array.isArray(details.toetsen) ? details.toetsen.map(record).filter(row => str(row.id_toets_gelegenheid) === targetId) : [];
        if (matches.length !== 1) throw new BrightspaceError('MYTU_TARGET_UNVERIFIED', 'Choose one exact exam opportunity listed in this course.');
        target = examForRegistration(matches[0]!);
        const facilities = Array.isArray(target.voorzieningen) ? target.voorzieningen.map(record).filter(row => row.standaard_toegekend === 'J') : [];
        body = { toetsen: [{ ...target, voorzieningen: facilities }] };
        method = 'POST'; path = '/student/inschrijvingen/toetsen/';
      } else {
        if (courseId !== targetId || exactId(details.id_cursus_blok) !== courseId) throw new BrightspaceError('MYTU_TARGET_UNVERIFIED', 'Choose an exact course block from get_official_course with section blocks.');
        target = details;
        const select = (field: string, key: string, selected: string[]): Row[] => {
          const available = Array.isArray(details[field]) ? details[field].map(record) : [];
          if (selected.some(code => !available.some(row => str(row[key]) === code))) throw new BrightspaceError('MYTU_TARGET_UNVERIFIED', 'A selected assessment or teaching method is not offered in this course block.');
          return available.filter(row => row.automatisch_ingeschreven === 'J' || selected.includes(str(row[key])));
        };
        const exams = select('toetsen', 'toets', examCodes).map(examForRegistration), methods = select('werkvormen', 'werkvorm', workingMethods);
        if (Array.isArray(details.werkvormen) && details.werkvormen.length && !methods.length) throw new BrightspaceError('MYTU_SELECTION_REQUIRED', 'Select at least one of the published teaching methods using workingMethods.', { available: details.werkvormen });
        const groups = Array.isArray(details.werkvormgroepen_per_werkvorm) ? details.werkvormgroepen_per_werkvorm : [];
        if (groups.length || Number(details.min_voorkeursgroepen) > 0 || details.id_zaak_def) throw new BrightspaceError('MYTU_REGISTRATION_REQUIRES_BROWSER', 'This course requires group preferences or an admission form. Complete these published choices in My TU Delft.', { sourceUrl: ORIGIN + '/inschrijven/cursus' });
        body = { ...details, toetsen: exams, werkvormen: methods, werkvormgroepen_per_werkvorm: [],
          toets_voorzieningen: [], werkvorm_voorzieningen: [] };
        if (findRows(details, row => Array.isArray(row.voorzieningen) && row.voorzieningen.length > 0).length) throw new BrightspaceError('MYTU_REGISTRATION_REQUIRES_BROWSER', 'This course includes accommodation choices; use My TU Delft to preserve those choices.');
        method = 'PUT'; path = '/student/inschrijvingen/cursussen/' + courseId;
      }
      if (target.ingeschreven === 'J' || target.automatisch_ingeschreven === 'J') throw new BrightspaceError('MYTU_ALREADY_REGISTERED', 'OSIRIS already reports this target as registered.');
      // An existing own-registration record also prevents duplicates when catalogue flags lag.
      try {
        await access.request('/student/inschrijvingen/' + registered[input.kind] + '/' + targetId);
        throw new BrightspaceError('MYTU_ALREADY_REGISTERED', 'OSIRIS already has a registration record for this target.');
      } catch (error) {
        if (!(error instanceof BrightspaceError) || error.code !== 'MYTU_NOT_FOUND') throw error;
      }
      if (target.inschrijven_toegestaan === 'N' || target.open_voor_inschrijving === 'N' || target.beschikbare_plekken === 0) throw new BrightspaceError('MYTU_REGISTRATION_UNAVAILABLE', 'OSIRIS does not currently offer a place for this registration.');
      if (Array.isArray(details.kosten) && details.kosten.length || Number(String(target.bedrag ?? '0').replace(',', '.')) > 0
        || details.moet_student_betalen === 'J') throw new BrightspaceError('MYTU_REGISTRATION_REQUIRES_BROWSER', 'This registration includes payment choices. Complete them in My TU Delft.');
    }
    return { kind: input.kind, action, courseId, targetId, target, body, method, path, examCodes, workingMethods };
  }
  async prepareRegistration(input: {
    kind: RegistrationKind; action?: RegistrationAction; courseId: string; targetId?: string; examCodes?: string[]; workingMethods?: string[];
  }): Promise<Row> {
    const generation = this.generation;
    return this.mytu.withAccess(async access => {
      const plan = await this.registrationPlan(access, input); await access.current();
      if (generation !== this.generation) throw new BrightspaceError('MYTU_SESSION_CHANGED', 'The My TU Delft connection changed during preparation.');
      for (const [key, value] of this.previews) if (value.expiresAt <= Date.now()) this.previews.delete(key);
      if (this.previews.size >= 20) throw new BrightspaceError('MYTU_LIMIT', 'Too many pending registration previews. Wait for an old preview to expire.');
      const token = randomBytes(24).toString('base64url'), expiresAt = Date.now() + 5 * 60_000;
      const preview: Preview = { ...plan, token, expiresAt, accountId: access.accountId, studentHash: access.studentHash, digest: fingerprint(plan) };
      this.previews.set(token, preview);
      return { ...source('/inschrijven/mijn-inschrijvingen'), confirmationToken: token, expiresAt: new Date(expiresAt).toISOString(),
        action: plan.action, kind: plan.kind, courseId: plan.courseId, targetId: plan.targetId, target: plan.target,
        selections: plan.body, status: 'preview_only', requiresExplicitStudentApproval: true };
    });
  }
  async confirmRegistration(token: string, confirmed: boolean): Promise<Row> {
    if (confirmed !== true) throw new BrightspaceError('CONFIRMATION_REQUIRED', 'Show the exact preview and obtain the student’s explicit approval first.');
    const preview = this.previews.get(token);
    this.previews.delete(token); // Consume before any await: concurrent calls cannot repeat the write.
    if (!preview || preview.expiresAt <= Date.now()) throw new BrightspaceError('PREVIEW_EXPIRED', 'Prepare a new registration preview and obtain approval.');
    const generation = this.generation;
    return this.mytu.withAccess(async access => {
      if (access.accountId !== preview.accountId || access.studentHash !== preview.studentHash) throw new BrightspaceError('MYTU_ACCOUNT_MISMATCH', 'The registration preview belongs to another account.');
      const current = await this.registrationPlan(access, preview);
      if (fingerprint(current) !== preview.digest) throw new BrightspaceError('PREVIEW_CHANGED', 'The registration details changed. Prepare a new preview and obtain approval.');
      await access.current();
      if (preview.expiresAt <= Date.now() || generation !== this.generation) throw new BrightspaceError('PREVIEW_EXPIRED', 'The registration preview expired or the connection changed.');
      let receipt: unknown;
      try { receipt = await access.request(preview.path, preview.method, preview.body); }
      catch { throw new BrightspaceError('MYTU_WRITE_UNCERTAIN', 'The registration request may have reached OSIRIS. Inspect official registrations before any retry.', { action: preview.action, kind: preview.kind, targetId: preview.targetId }); }
      let status: Row[];
      try { status = messages(receipt); }
      catch { throw new BrightspaceError('MYTU_WRITE_UNCERTAIN', 'OSIRIS returned an unfamiliar registration receipt. Inspect official registrations before any retry.'); }
      if (status.some(row => ['E', 'W'].includes(str(row.type)))) return { ...source('/inschrijven/mijn-inschrijvingen'), status: 'not_verified', messages: status, retryAutomatically: false };
      const readPath = '/student/inschrijvingen/' + registered[preview.kind] + '/' + preview.targetId;
      try {
        const item = record(await access.request(readPath));
        const id = item[preview.kind === 'course' ? 'id_cursus_blok' : 'id_toets_gelegenheid'];
        if (preview.action === 'enroll' && str(id) === preview.targetId) return { ...source('/inschrijven/mijn-inschrijvingen'), status: 'registered', kind: preview.kind, item: studyData(item), messages: status };
      } catch (error) {
        if (preview.action === 'withdraw' && error instanceof BrightspaceError && error.code === 'MYTU_NOT_FOUND') return { ...source('/inschrijven/mijn-inschrijvingen'), status: 'withdrawn', kind: preview.kind, targetId: preview.targetId, messages: status };
      }
      throw new BrightspaceError('MYTU_WRITE_UNCERTAIN', 'The request completed, but the final registration state could not be verified. Inspect official registrations before any retry.', { kind: preview.kind, targetId: preview.targetId });
    });
  }
}
