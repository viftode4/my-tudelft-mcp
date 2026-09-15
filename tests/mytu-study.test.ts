import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MyTuStudy, studyData } from '../src/mytu-study.js';
import { myTuApiRequestAllowed } from '../src/mytu-routes.js';
import { BrightspaceError } from '../src/errors.js';
import type { MyTuAccess } from '../src/mytudelft.js';

// All account, course and exam values are synthetic. Tests never contact OSIRIS.
function fixture() {
  const state = { accountId: 'synthetic-account', studentHash: 'synthetic-student', calls: [] as Array<{ path: string; method: string; body?: unknown }>,
    writes: 0, registered: false, failWrite: false, failReceipt: false, searchResponse: undefined as unknown, eligibility: [] as unknown[], afterEligibility: undefined as (() => void) | undefined,
    detail: { id_cursus: 'curs:101', id_cursus_blok: 'cubl:201', cursus: 'SYN1000', cursus_korte_naam: 'Synthetic Course', collegejaar: 2026,
      toetsen: [{ id_toets_gelegenheid: 'toge:301', toets: 'EX', toets_omschrijving: 'Synthetic Exam', datum: '2026-10-20', beschikbare_plekken: 10, voorzieningen: [] }],
      werkvormen: [], werkvormgroepen_per_werkvorm: [], mag_uitschrijven: 'J' } as Record<string, any> };
  const access: MyTuAccess = { accountId: state.accountId, studentHash: state.studentHash, current: async () => undefined,
    request: async (path, method = 'GET', body) => {
      assert.equal(myTuApiRequestAllowed(path, method, body), true, method + ' ' + path);
      state.calls.push({ path, method, body });
      const url = new URL(path, 'https://my.tudelft.nl'), p = url.pathname;
      const collection = (items: unknown[]) => ({ items, offset: Number(url.searchParams.get('offset')), limit: Number(url.searchParams.get('limit') ?? 25), hasMore: false });
      if (method === 'POST' && p.endsWith('/zoeken')) return state.searchResponse ?? { hits: { total: { value: 1, relation: 'eq' }, hits: [{ _source: { id_cursus: 'curs:101', cursus: 'SYN1000' } }] } };
      if (method !== 'GET') {
        state.writes++; if (state.failWrite) throw new Error('Synthetic connection dropped after sending');
        state.registered = method !== 'DELETE'; return { statusmeldingen: [] };
      }
      if (p.endsWith('/controleren')) { state.afterEligibility?.(); return { statusmeldingen: state.eligibility }; }
      if (p.includes('/voortgang/per_opleiding')) return collection([{ opleiding: 'SYN', examenfases: [{ id: 'sopl:401:exty:9', behaalde_punten: 30 }] }]);
      if (p.endsWith('/onderwijsprogramma')) return [{ naam: 'Synthetic curriculum', cursussen: [{ cursus: 'SYN1000', behaald: 'N' }] }];
      if (p.endsWith('/studieadviezen')) return collection([{ advies: 'Synthetic advice' }]);
      if (p.includes('/open_voor_inschrijving/')) return collection([{ id_cursus: 'curs:101', id_cursus_blok: 'cubl:201' }]);
      if (p.endsWith('/blokken_voor_cursusinschrijving')) return { items: [{ id_cursus_blok: 'cubl:201' }] };
      if (p.includes('/cursussen_voor_')) return structuredClone(state.detail);
      if (p.startsWith('/student/inschrijvingen/')) {
        if (p.endsWith('/toetsen') || p.endsWith('/cursussen')) return collection(state.registered ? [{ ...state.detail, id_toets_gelegenheid: 'toge:301' }] : []);
        if (!state.registered) throw new BrightspaceError('MYTU_NOT_FOUND', 'Synthetic registration missing');
        if (state.failReceipt) throw new Error('Synthetic receipt read unavailable');
        return { ...state.detail, id_toets_gelegenheid: 'toge:301' };
      }
      throw Error('Unmocked route: ' + path);
    } };
  const study = new MyTuStudy({ withAccess: async task => { access.accountId = state.accountId; access.studentHash = state.studentHash; return task(access); } });
  return { study, state };
}

test('OSIRIS route policy excludes arbitrary identity endpoints, writes and query substitutions', () => {
  for (const path of ['/student/contactgegevens?student=another', '/student/../contactgegevens', '//evil.example/gebruiker',
    '/student/voortgang/one/onderwijsprogramma?student=other', '/student/resultaten?offset=0&offset=25', '/student/resultaten/%2e%2e', '/gebruiker#token=x']) {
    assert.equal(myTuApiRequestAllowed(path), false, path);
  }
  assert.equal(myTuApiRequestAllowed('/student/personalia', 'PUT', {}), false);
  assert.equal(myTuApiRequestAllowed('/student/inschrijvingen/toetsen/', 'POST', { toetsen: [{}, {}] }), false);
});

test('study data retains nested academic fields and omits credentials and photo blobs', () => {
  assert.deepEqual(studyData({ punten: 30, pasfoto: 'private-photo', access_token: 'private-token', onderdelen: [{ naam: 'Core', behaald: 'J' }] }),
    { punten: 30, onderdelen: [{ naam: 'Core', behaald: 'J' }] });
});

test('programme reads require an own progress identifier discovered in this account', async () => {
  const { study, state } = fixture();
  await assert.rejects(study.programme('sopl:401:exty:9'), { code: 'MYTU_TARGET_UNVERIFIED' });
  await study.progress();
  assert.equal((await study.programme('sopl:401:exty:9')).complete, true);
  state.accountId = 'different-account';
  await assert.rejects(study.programme('sopl:401:exty:9'), { code: 'MYTU_TARGET_UNVERIFIED' });
});

test('catalogue POST is a bounded read and exposes discovered IDs for detail reads', async () => {
  const { study, state } = fixture();
  const result = await study.available('exam', { query: 'Synthetic' });
  assert.equal(result.hasMore, false); assert.equal(result.complete, true);
  await study.course('exam', 'curs:101');
  assert.equal(state.writes, 0);
  const body = state.calls[0]!.body as any;
  assert.equal(body.query.bool.must[0].multi_match.query, 'SYNTHETIC');
});

test('catalogue rejects missing course records and inconsistent or unknown totals', async () => {
  const { study, state } = fixture();
  for (const hits of [{ total: 0, hits: [{ _source: { id_cursus: 'curs:101' } }] },
    { total: 1, hits: [{}] }, { hits: [] }, { total: { value: 1, relation: 'unknown' }, hits: [] }]) {
    state.searchResponse = { hits };
    await assert.rejects(study.available('exam', { query: 'Synthetic' }), { code: 'MYTU_FORMAT_CHANGED' });
  }
});

test('study advice preserves page offset and does not claim complete coverage from a later page', async () => {
  const { study } = fixture(); await study.progress();
  const advice = await study.programme('sopl:401:exty:9', 'advice', { offset: 25 });
  assert.equal(advice.offset, 25); assert.equal(advice.complete, false);
  assert.deepEqual(advice.items, [{ advies: 'Synthetic advice' }]);
});

test('existing registrations prevent a duplicate even when catalogue flags lag', async () => {
  const { study, state } = fixture(); await study.available('exam');
  const preview = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
  state.registered = true;
  await assert.rejects(study.confirmRegistration(preview.confirmationToken as string, true), { code: 'MYTU_ALREADY_REGISTERED' });
  assert.equal(state.writes, 0);
});

test('exam preparation performs reads only and binds the exact exam date and opportunity', async () => {
  const { study, state } = fixture(); await study.available('exam');
  const preview = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
  assert.equal(preview.status, 'preview_only'); assert.equal(state.writes, 0);
  assert.equal((preview.target as any).datum, '2026-10-20');
  assert.equal((preview.selections as any).toetsen.length, 1);
  await assert.rejects(study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'unrelated-exam' }), { code: 'MYTU_TARGET_UNVERIFIED' });
});

test('exam preview uses the native OSIRIS clock serialization in its target and payload', async () => {
  const { study, state } = fixture(); await study.available('exam');
  state.detail.toetsen[0].tijd_vanaf = 13.3; state.detail.toetsen[0].tijd_tm = 15.05;
  const preview = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
  assert.equal((preview.target as any).tijd_vanaf, '13:30');
  assert.equal((preview.selections as any).toetsen[0].tijd_tm, '15:05');
  state.detail.toetsen[0].tijd_vanaf = 0; state.detail.toetsen[0].tijd_tm = null;
  const unspecified = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
  assert.equal((unspecified.target as any).tijd_vanaf, ''); assert.equal((unspecified.target as any).tijd_tm, '');
  state.detail.toetsen[0].tijd_vanaf = 13.99;
  await assert.rejects(study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' }), { code: 'MYTU_FORMAT_CHANGED' });
  assert.equal(state.writes, 0);
});

test('confirmation requires literal approval and cannot repeat a registration', async () => {
  const { study, state } = fixture(); await study.available('exam');
  const preview = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
  const token = preview.confirmationToken as string;
  await assert.rejects(study.confirmRegistration(token, false), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(state.writes, 0);
  const results = await Promise.allSettled([study.confirmRegistration(token, true), study.confirmRegistration(token, true)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(state.writes, 1);
  assert.equal((results[0] as PromiseFulfilledResult<any>).value.status, 'registered');
});

test('changing an exam date invalidates its approved preview before writing', async () => {
  const { study, state } = fixture(); await study.available('exam');
  const preview = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
  state.detail.toetsen[0].datum = '2026-10-21';
  await assert.rejects(study.confirmRegistration(preview.confirmationToken as string, true), { code: 'PREVIEW_CHANGED' });
  assert.equal(state.writes, 0);
});

test('switching accounts or closing the connection invalidates registration previews', async () => {
  const { study, state } = fixture(); await study.available('exam');
  const first = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
  state.studentHash = 'another-student';
  await assert.rejects(study.confirmRegistration(first.confirmationToken as string, true), { code: 'MYTU_ACCOUNT_MISMATCH' });
  state.studentHash = 'synthetic-student';
  const second = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
  study.close();
  await assert.rejects(study.confirmRegistration(second.confirmationToken as string, true), { code: 'PREVIEW_EXPIRED' });
  assert.equal(state.writes, 0);
});

test('connection closure during revalidation stops registration before the write', async () => {
  const { study, state } = fixture(); await study.available('exam');
  const preview = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
  state.afterEligibility = () => study.close();
  await assert.rejects(study.confirmRegistration(preview.confirmationToken as string, true), { code: 'PREVIEW_EXPIRED' });
  assert.equal(state.writes, 0);
});

test('eligibility errors and warnings produce no executable registration preview', async () => {
  const { study, state } = fixture(); await study.available('exam');
  state.eligibility = [{ type: 'W', tekst: 'Synthetic prerequisite warning' }];
  await assert.rejects(study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' }), { code: 'MYTU_REGISTRATION_REVIEW_REQUIRED' });
  assert.equal(state.writes, 0);
});

test('network failure or unavailable receipts report uncertainty without replaying the write', async () => {
  for (const mode of ['failWrite', 'failReceipt'] as const) {
    const { study, state } = fixture(); await study.available('exam');
    const preview = await study.prepareRegistration({ kind: 'exam', courseId: 'curs:101', targetId: 'toge:301' });
    state[mode] = true;
    await assert.rejects(study.confirmRegistration(preview.confirmationToken as string, true), { code: 'MYTU_WRITE_UNCERTAIN' });
    await assert.rejects(study.confirmRegistration(preview.confirmationToken as string, true), { code: 'PREVIEW_EXPIRED' });
    assert.equal(state.writes, 1);
  }
});

test('course registration preserves automatic assessments and only explicitly selected optional ones', async () => {
  const { study, state } = fixture();
  state.detail.toetsen.push({ toets: 'AUTO', automatisch_ingeschreven: 'J' });
  await study.available('course');
  const preview = await study.prepareRegistration({ kind: 'course', courseId: 'cubl:201' });
  assert.deepEqual((preview.selections as any).toetsen.map((row: any) => row.toets), ['AUTO']);
  const result = await study.confirmRegistration(preview.confirmationToken as string, true);
  assert.equal(result.status, 'registered'); assert.equal(state.writes, 1);
});

test('withdrawal requires a current allowed registration and verifies its removal', async () => {
  const { study, state } = fixture(); state.registered = true;
  await study.registrations('exam');
  const preview = await study.prepareRegistration({ kind: 'exam', action: 'withdraw', courseId: 'curs:101', targetId: 'toge:301' });
  assert.equal(state.writes, 0);
  assert.equal((await study.confirmRegistration(preview.confirmationToken as string, true)).status, 'withdrawn');
  assert.equal(state.registered, false); assert.equal(state.writes, 1);
});
