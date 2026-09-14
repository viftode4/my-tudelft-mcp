import assert from 'node:assert/strict';
import test from 'node:test';
import type { APIRequestContext } from 'playwright';
import { PublicStudyGuide, anonymousStudyGuideTransport, type StudyGuideTransport } from '../src/study-guide.js';

const year = '2026-2027';
function course(id = '33727', code = 'DSAIT4000', academicYear = year) {
  return { type: 'items', id, attributes: { type_canonical_name: 'modules', data: {
    item_id: Number(id), code, jaar: { en: [academicYear], nl: [academicYear] }, course_name_2: { en: 'Data Management and Engineering', nl: 'Data Management en Engineering' }, studiepunten_ects: 5,
    cr_course_start: ['1'], voertaal: { en: ['English'], nl: ['Engels'] }, cr_level: { en: ['Master'], nl: ['Master'] }, locatie: { en: ['Delft'], nl: ['Delft'] },
    vakbeschrijving: { en: '<p>Learn about data systems.</p><script>hidden secret</script><a href="https://example.org/reading?token=SECRET">Reading</a>', nl: '<p>Leer over datasystemen.</p>' },
    leerdoelen: { en: '<ol><li>Understand data systems</li></ol>' }, toetsing: { en: '<p>Exam and group assignments.</p>' },
    verantwoordelijk_docent_1: '<a href="mailto:teacher@tudelft.nl">Dr Example</a>', opleidingen_namen: ['MSc Example'], cr_enrolment_course: { en: ['No'] },
  } } };
}
function page(items: unknown[], total = items.length, offset = 0) { return { data: items, meta: { total, offset: String(offset), size: '30' } }; }

test('exact public course resolves search and detail with code, year, sources and useful sections', async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const transport: StudyGuideTransport = async (path, body) => { calls.push({ path, body }); return body ? page([course()]) : { data: course() }; };
  const result = await new PublicStudyGuide(transport).getCourse('dsait4000', year);
  assert.deepEqual(calls, [{ path: '/courses/items/search?size=30&offset=0', body: { query: 'DSAIT4000', filters: { jaar: [year] }, language: 'en' } }, { path: '/courses/items/33727', body: undefined }]);
  assert.equal(result.course.code, 'DSAIT4000');
  assert.equal(result.course.academicYear, year);
  assert.equal(result.course.credits, 5);
  assert.equal(result.authentication, 'anonymous');
  assert.equal(result.sourceUrl, 'https://studyguide.tudelft.nl/courses/study-guide/educations/33727');
  assert.ok(result.sections.find((section) => section.key === 'assessment')?.text.includes('Exam'));
  assert.doesNotMatch(JSON.stringify(result), /hidden secret|SECRET|token=/);
  assert.deepEqual(result.lecturers, [{ name: 'Dr Example', emails: ['teacher@tudelft.nl'] }]);
  assert.deepEqual(result.courseRegistrationInformation, ['No']);
  assert.match(result.coverage, /not the student/);
});

test('same course in another academic year is rejected rather than silently substituted', async () => {
  const historical = course('100', 'DSAIT4000', '2025-2026');
  await assert.rejects(new PublicStudyGuide(async () => page([historical])).getCourse('DSAIT4000', year), { code: 'COURSE_YEAR_MISMATCH' });
  const mismatchedLanguages = course(); mismatchedLanguages.attributes.data.jaar.nl = ['2025-2026'];
  await assert.rejects(new PublicStudyGuide(async () => page([mismatchedLanguages])).search('DSAIT4000', year), { code: 'COURSE_YEAR_MISMATCH' });
  await assert.rejects(new PublicStudyGuide(async () => page([])).getCourse('DSAIT4000', '2025-2026'), { code: 'NOT_FOUND' });
});

test('exact course identity is required after fuzzy search and is rechecked at detail retrieval', async () => {
  await assert.rejects(new PublicStudyGuide(async () => page([course('1', 'DSAIT4000X')])).getCourse('DSAIT4000', year), { code: 'NOT_FOUND' });
  await assert.rejects(new PublicStudyGuide(async (_path, body) => body ? page([course()]) : { data: course('99') }).getCourse('DSAIT4000', year), { code: 'COURSE_CHANGED' });
  await assert.rejects(new PublicStudyGuide(async (_path, body) => body ? page([course()]) : { data: course('33727', 'DSAIT4310') }).getCourse('DSAIT4000', year), { code: 'COURSE_CHANGED' });
  await assert.rejects(new PublicStudyGuide(async () => page([course(), course('99')])).getCourse('DSAIT4000', year), { code: 'AMBIGUOUS_COURSE' });
});

test('public search exposes validated next offsets and rejects duplicate or incomplete pages', async () => {
  const items = Array.from({ length: 30 }, (_, index) => course(String(index + 1), `EX${index + 1}`));
  const result = await new PublicStudyGuide(async () => page(items, 31)).search('data', year);
  assert.equal(result.complete, false); assert.equal(result.nextOffset, 30); assert.equal(result.total, 31);
  for (const response of [page([course(), course()]), page([], 1), page([course()], 3), { data: [], meta: { total: 0, offset: '0', size: '999' } }]) await assert.rejects(new PublicStudyGuide(async () => response).search('data', year), { code: 'PAGINATION_ERROR' });
});

test('exact resolution checks all bounded pages before choosing a course and detects changing totals', async () => {
  const first = Array.from({ length: 30 }, (_, index) => course(String(index + 1), index === 0 ? 'DSAIT4000' : `EX${index + 1}`));
  let calls = 0;
  await assert.rejects(new PublicStudyGuide(async () => ++calls === 1 ? page(first, 31) : page([course('99')], 31, 30)).getCourse('DSAIT4000', year), { code: 'AMBIGUOUS_COURSE' });
  calls = 0;
  await assert.rejects(new PublicStudyGuide(async () => ++calls === 1 ? page(first, 31) : page([], 30, 30)).getCourse('DSAIT4000', year), { code: 'PAGINATION_ERROR' });
  calls = 0;
  await assert.rejects(new PublicStudyGuide(async () => { const offset = calls++ * 30; return page(Array.from({ length: 30 }, (_, index) => course(String(offset + index + 1), `EX${offset + index + 1}`)), 1000, offset); }).getCourse('DSAIT4000', year), { code: 'PAGINATION_ERROR' });
  assert.equal(calls, 3);
});

test('invalid codes, explicit years, language and offsets fail without network requests', async () => {
  const guide = new PublicStudyGuide(async () => assert.fail('Invalid inputs cannot reach the public API'));
  await assert.rejects(guide.getCourse('DSAIT4000+2026+1', year), { code: 'INVALID_COURSE_CODE' });
  await assert.rejects(guide.getCourse('DSAIT4000', '2026-2028'), { code: 'INVALID_ACADEMIC_YEAR' });
  await assert.rejects(guide.search('', year), { code: 'INVALID_SEARCH' });
  await assert.rejects(guide.search('DSAIT4000', year, 'en', 1), { code: 'INVALID_SEARCH' });
  await assert.rejects(guide.search('DSAIT4000', year, 'de' as 'en'), { code: 'INVALID_LANGUAGE' });
});

test('requested source language is selected without inventing a translation or historical fallback', async () => {
  const result = await new PublicStudyGuide(async (_path, body) => body ? page([course()]) : { data: course() }).getCourse('DSAIT4000', year, 'nl');
  assert.equal(result.course.name, 'Data Management en Engineering');
  assert.equal(result.sections.find((section) => section.key === 'description')?.text, 'Leer over datasystemen.');
  assert.equal(result.sections.some((section) => section.key === 'assessment'), false);
});

test('large source sections report truncation and preserve a bounded total text size', async () => {
  const large = course(); large.attributes.data.vakbeschrijving.en = 'X'.repeat(100_000);
  const result = await new PublicStudyGuide(async (_path, body) => body ? page([large]) : { data: large }).getCourse('DSAIT4000', year);
  assert.equal(result.complete, false);
  assert.equal(result.sections[0]?.truncated, true);
  assert.ok(result.sections.reduce((sum, section) => sum + section.text.length, 0) <= 60_000);
});

test('giant link titles and addresses share the output budget and invalid shortened addresses are omitted', async () => {
  const huge = course();
  const fields = huge.attributes.data as Record<string, unknown>;
  fields.vakbeschrijving = { en: `<a href="https://example.org/reading">${'T'.repeat(100_000)}</a><a href="https://example.org/${'u'.repeat(100_000)}">Long address</a>` };
  const result = await new PublicStudyGuide(async (_path, body) => body ? page([huge]) : { data: huge }).getCourse('DSAIT4000', year);
  const description = result.sections.find((section) => section.key === 'description')!;
  assert.equal(result.complete, false);
  assert.equal(result.outputTruncated, true);
  assert.equal(description.truncated, true);
  assert.equal(description.links.length, 1);
  assert.ok(description.links[0]!.title.length <= 300);
  assert.equal(description.links[0]!.url, 'https://example.org/reading');
  assert.ok(result.outputOmissions.some((omission) => omission.path.endsWith('.title')));
  assert.ok(result.outputOmissions.some((omission) => omission.reason === 'unsafe_to_shorten'));
  assert.ok(JSON.stringify(result).length <= 100_000);
});

test('auxiliary metadata, lecturers, programmes and arrays cannot bypass global output limits', async () => {
  const huge = course(), fields = huge.attributes.data as Record<string, unknown>;
  fields.course_name_2 = { en: 'N'.repeat(100_000) };
  fields.opleidingen_namen = Array.from({ length: 200 }, () => 'P'.repeat(5_000));
  fields.verantwoordelijk_docent_1 = `<a href="mailto:${'e'.repeat(1_000)}@tudelft.nl">${'L'.repeat(100_000)}</a>`;
  fields.docenten = Array.from({ length: 60 }, (_, index) => `Lecturer ${index} ${'A'.repeat(5_000)}`);
  fields.onderwijs_activiteiten = { en: Array.from({ length: 60 }, () => 'B'.repeat(5_000)) };
  fields.status = { en: 'S'.repeat(100_000) };
  const result = await new PublicStudyGuide(async (_path, body) => body ? page([huge]) : { data: huge }).getCourse('DSAIT4000', year);
  assert.equal(result.course.id, '33727');
  assert.equal(result.course.code, 'DSAIT4000');
  assert.equal(result.course.academicYear, year);
  assert.equal(result.sourceUrl, 'https://studyguide.tudelft.nl/courses/study-guide/educations/33727');
  assert.equal(result.complete, false);
  assert.equal(result.outputTruncated, true);
  assert.ok(result.course.name.length <= 500);
  assert.ok(result.lecturers.length <= 30);
  assert.ok(result.lecturers.every((lecturer) => lecturer.name.length <= 500 && lecturer.emails.every((email) => email.length <= 254)));
  assert.ok(result.programmes.length <= 30 && result.programmes.every((programme) => programme.length <= 500));
  assert.ok(result.outputOmissions.length <= 30);
  assert.ok(result.omittedFieldCount > 0);
  assert.ok(JSON.stringify(result).length <= 100_000);
});

test('public search bounds every summary without changing pagination completeness or exact identifiers', async () => {
  const items = Array.from({ length: 30 }, (_, index) => {
    const item = course(String(index + 1), `EX${index + 1}`), fields = item.attributes.data as Record<string, unknown>;
    fields.course_name_2 = { en: 'N'.repeat(10_000) };
    fields.faculteit = { en: Array.from({ length: 60 }, () => 'F'.repeat(1_000)) };
    return item;
  });
  const result = await new PublicStudyGuide(async () => page(items)).search('data', year);
  assert.equal(result.complete, true);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.items.length, 30);
  assert.equal(result.items.at(-1)!.id, '30');
  assert.equal(result.items.at(-1)!.code, 'EX30');
  assert.equal(result.items.at(-1)!.academicYear, year);
  assert.ok(result.items.every((item) => item.name.length <= 500));
  assert.ok(result.outputOmissions.length <= 30);
  assert.ok(JSON.stringify(result).length <= 100_000);
});

test('large link collections expose original count and truncation', async () => {
  const huge = course();
  huge.attributes.data.vakbeschrijving.en = Array.from({ length: 150 }, (_, index) => `<a href="https://example.org/${index}">Link ${index}</a>`).join(' ');
  const result = await new PublicStudyGuide(async (_path, body) => body ? page([huge]) : { data: huge }).getCourse('DSAIT4000', year);
  const section = result.sections[0]!;
  assert.equal(section.linkCount, 150);
  assert.equal(section.linksTruncated, true);
  assert.equal(section.truncated, true);
  assert.ok(section.links.length <= 30);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.complete, false);
});

test('anonymous transport creates empty storage, uses only fixed public endpoints and never follows redirects', async () => {
  const options: unknown[] = [], calls: Array<{ url: string; options: unknown }> = [];
  let disposed = 0, responseDisposed = 0, status = 200;
  const transport = anonymousStudyGuideTransport(1000, async (settings) => {
    options.push(settings);
    return { fetch: async (url: string, fetchOptions: unknown) => {
      calls.push({ url, options: fetchOptions });
      return { status: () => status, ok: () => status === 200, headers: () => ({ 'content-type': 'application/json' }), body: async () => Buffer.from('{"data":[]}'), dispose: async () => { responseDisposed++; } };
    }, dispose: async () => { disposed++; } } as unknown as APIRequestContext;
  });
  await transport('/courses/items/33727');
  assert.deepEqual(options[0], { timeout: 1000, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { Accept: 'application/json' } });
  assert.equal(calls[0]?.url, 'https://curriculum.tudelft.nl/publisher/api/v0/courses/items/33727');
  assert.deepEqual(calls[0]?.options, { method: 'GET', data: undefined, maxRedirects: 0, maxRetries: 0 });
  status = 302;
  await assert.rejects(transport('/courses/items/33727'), { code: 'PUBLIC_GUIDE_UNAVAILABLE' });
  assert.equal(calls.length, 2); assert.equal(disposed, 2); assert.equal(responseDisposed, 2);
  for (const path of ['https://tudelft-acc.sqill.it/publisher/api/v0/courses/items/33727', '/courses/items/../login', '/courses/items/33727?token=secret', '/lti/1.3/login']) await assert.rejects(transport(path), { code: 'INVALID_PUBLIC_ROUTE' });
  assert.equal(calls.length, 2);
});
