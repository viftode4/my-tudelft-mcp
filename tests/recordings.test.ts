import assert from 'node:assert/strict';
import test from 'node:test';
import { CourseRecordings, type RecordingTransport } from '../src/recordings.js';
import { BrightspaceError } from '../src/errors.js';
import { record, type Row } from '../src/util.js';

const origin = 'https://brightspace.example';
const presentation = 'https://collegeramavideoportal.tudelft.nl/catalogue/course/presentation/1234567890abcdef1234567890abcdef1d';
class Client implements RecordingTransport {
  config = { baseUrl: origin };
  identity: string | undefined = '17';
  payloads = new Map<string, unknown>();
  calls: string[] = [];
  afterJson?: (path: string) => void;
  sessionIdentity = async () => this.identity;
  json = async (_product: 'lp' | 'le', path: string): Promise<unknown> => {
    this.calls.push(path);
    const value = this.payloads.get(path);
    this.afterJson?.(path);
    if (value instanceof Error) throw value;
    return value;
  };
}
function fixture(topics: Row[], modules: Row[] = []) {
  const client = new Client();
  client.payloads.set('100/content/toc', { Modules: [{ ModuleId: 200, Title: 'Course content', Topics: topics, Modules: modules }] });
  client.payloads.set('100/content/modules/200', { Id: 200, Title: 'Course content' });
  for (const topic of topics) client.payloads.set('100/content/topics/' + topic.TopicId, { ...topic, Id: topic.TopicId });
  return client;
}
const items = (result: Row): Row[] => result.items as Row[];

test('recordings group exact source URLs and preserve topic/module provenance without visiting providers', async () => {
  const client = fixture([
    { TopicId: 301, Title: 'Lecture recording', ActivityType: 2, Url: presentation },
    { TopicId: 302, Title: 'Same lecture', ActivityType: 2, Url: presentation },
  ]);
  client.payloads.set('100/content/modules/200', { Id: 200, Title: 'Course content', Description: { Html: '<a href="' + presentation + '">Recorded lecture</a>' } });
  const result = await new CourseRecordings(client).list('100');
  assert.equal(items(result).length, 1);
  assert.equal(items(result)[0]!.provider, 'Collegerama');
  assert.equal((items(result)[0]!.sources as Row[]).length, 3);
  const topic = (items(result)[0]!.sources as Row[]).find(src => src.topicId === '301')!;
  assert.deepEqual(topic.metadataSources, ['toc', 'topic_detail']);
  assert.equal(topic.sourceUrl, origin + '/d2l/le/content/100/viewContent/301/View');
  assert.equal(result.complete, true);
  assert.ok(client.calls.every(path => /^100\/content\/(?:toc|(?:topics|modules)\/\d+)$/.test(path)));
  assert.equal(result.source, 'api_metadata');
});

test('native media read_material targets require the exact topic media URL; embedded sources retain provenance', async () => {
  const client = fixture([
    { TopicId: 301, Title: 'Recording', Url: '/content/enforced/100/video.mp4' },
    { TopicId: 302, Title: 'Video page', Url: '/content/enforced/100/page.html', Description: { Html: '<video><source src="/content/enforced/100/video.mp4"><track src="/content/enforced/100/en.vtt" srclang="en" label="English"></video>' } },
  ]);
  const result = await new CourseRecordings(client).list('100');
  const recording = items(result)[0]!;
  assert.equal(recording.nativeMedia, true);
  assert.deepEqual(recording.readMaterialTargets, [{ courseId: '100', topicId: '301' }]);
  const sources = recording.sources as Row[];
  assert.equal(sources.find(src => src.topicId === '302')!.readMaterial, undefined);
  assert.equal((recording.captionLinks as Row[]).length, 1);
  assert.equal((recording.captionLinks as Row[])[0]!.language, 'en');
  assert.equal((recording.captionLinks as Row[])[0]!.url, origin + '/content/enforced/100/en.vtt');
});

test('provider matching respects hostname boundaries and does not label ordinary SharePoint pages as recordings', async () => {
  const client = fixture([
    { TopicId: 301, Title: 'Resources', Description: { Html: [
      '<a href="https://tud365.sharepoint.com/sites/department">Department page</a>',
      '<a href="https://tud365.sharepoint.com/:v:/r/course/session">Watch video</a>',
      '<a href="https://tud365.sharepoint.com/sites/course/archive">Lecture recordings</a>',
      '<a href="https://youtube.com.evil.invalid/watch?v=abcd">Video</a>',
      '<a href="https://www.youtube.com/watch?v=abcd">Supplemental video</a>',
      '<a href="https://collegeramavideoportal.tudelft.nl.evil.invalid/catalogue/a/presentation/id">Recording</a>',
      '<a href="javascript:alert(1)">Lecture recording</a>',
      '<a href="https://user:secret@www.youtube.com/watch?v=x">Lecture recording</a>',
    ].join('') } },
  ]);
  const result = await new CourseRecordings(client).list('100', { maxDetails: 0 });
  assert.equal(items(result).length, 3);
  assert.equal(items(result).filter(item => item.provider === 'SharePoint recording link').length, 2);
  assert.ok(!JSON.stringify(result).includes('evil.invalid'));
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(items(result).every(item => (item.readMaterialTargets as unknown[]).length === 0));
});

test('pagination inspects every visible object in deterministic bounded pages and reports per-call coverage honestly', async () => {
  const client = fixture([
    { TopicId: 303, Title: 'Notes' }, { TopicId: 302, Title: 'Web resource', ActivityType: 2 },
    { TopicId: 301, Title: 'Lecture recording', ActivityType: 2 },
  ]);
  client.payloads.set('100/content/topics/301', { Id: 301, Title: 'Lecture recording', Url: presentation });
  const reader = new CourseRecordings(client);
  const first = await reader.list('100', { maxDetails: 1 });
  assert.deepEqual(client.calls, ['100/content/toc', '100/content/topics/301']);
  assert.equal(first.nextStartAt, 1);
  assert.equal(first.complete, false);
  client.calls = [];
  const second = await reader.list('100', { startAt: 1, maxDetails: 3 });
  assert.deepEqual(client.calls, ['100/content/toc', '100/content/topics/302', '100/content/modules/200', '100/content/topics/303']);
  assert.equal(second.nextStartAt, null);
  assert.equal(second.complete, false);
  assert.equal(record(second.coverage).currentCallOnly, true);
  assert.equal(record(second.coverage).remainingDetails, 0);
});

test('hidden/locked content is not inspected and a newly hidden detail suppresses stale TOC links', async () => {
  const client = fixture([
    { TopicId: 301, Title: 'Recording', Url: presentation },
    { TopicId: 302, Title: 'Hidden recording', IsHidden: true, Url: presentation + '2' },
    { TopicId: 303, Title: 'Locked recording', IsLocked: true, Url: presentation + '3' },
  ], [{ ModuleId: 201, Title: 'Hidden module', IsHidden: true, Topics: [{ TopicId: 304, Url: presentation + '4' }] }]);
  client.payloads.set('100/content/topics/301', { Id: 301, IsHidden: true });
  const result = await new CourseRecordings(client).list('100');
  assert.deepEqual(items(result), []);
  assert.ok(!client.calls.some(path => /\/(?:302|303|304|201)$/.test(path)));
});

test('signed URL fields are redacted, duplicate links merge, and caption contents are never requested', async () => {
  const client = fixture([{ TopicId: 301, Title: 'Recording', Url: '/content/enforced/100/video.mp4?courseCode=ABC&token=private',
    Description: { Html: '<a href="/content/enforced/100/captions.vtt?access_token=private">English captions</a>' } }]);
  const result = await new CourseRecordings(client).list('100');
  assert.equal(items(result)[0]!.url, origin + '/content/enforced/100/video.mp4?courseCode=ABC');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal((result.captionLinks as Row[]).length, 1);
  assert.ok(!client.calls.some(path => /file|vtt|mp4/.test(path)));
});

test('detail failures remain explicit, wrong-object metadata cannot contribute links, and error diagnostics are sanitized', async () => {
  const client = fixture([{ TopicId: 301, Title: 'Lecture recording' }, { TopicId: 302, Title: 'Recording' }]);
  client.payloads.set('100/content/topics/301', new Error('private-token-should-not-leak'));
  client.payloads.set('100/content/topics/302', { Id: 999, Url: presentation });
  const result = await new CourseRecordings(client).list('100');
  assert.deepEqual(items(result), []);
  assert.equal(result.complete, false);
  assert.deepEqual((record(result.coverage).errors as Row[]).map(error => error.code), ['INTERNAL_ERROR', 'API_FORMAT_CHANGED']);
  assert.ok(!JSON.stringify(result).includes('private-token'));
});

test('range and identity boundaries fail safely, including an account switch during metadata retrieval', async () => {
  const client = fixture([{ TopicId: 301, Title: 'Recording', Url: presentation }]), reader = new CourseRecordings(client);
  for (const [id, options] of [['../100', {}], ['100', { startAt: -1 }], ['100', { maxDetails: 51 }], ['100', { maxDetails: 1.5 }]] as const) {
    await assert.rejects(reader.list(id, options), BrightspaceError);
  }
  assert.deepEqual(client.calls, []);
  client.identity = undefined; await assert.rejects(reader.list('100'), { code: 'AUTH_REQUIRED' });
  client.identity = '17'; client.afterJson = () => { client.identity = '18'; };
  await assert.rejects(reader.list('100'), { code: 'ACCOUNT_CHANGED' });
});

test('oversized descriptions and link counts report omissions instead of claiming complete discovery', async () => {
  const client = fixture([
    { TopicId: 301, Title: 'Recording', Description: 'x'.repeat(250_001) },
    { TopicId: 302, Title: 'Recording links', Description: '<a href="https://www.youtube.com/watch?v=a">A</a>'.repeat(210) },
  ]);
  const result = await new CourseRecordings(client).list('100');
  assert.equal(result.complete, false);
  const reasons = (record(result.coverage).omissions as Row[]).map(item => item.reason);
  assert.ok(reasons.includes('description_limit'));
  assert.ok(reasons.includes('link_limit'));
});

test('unfamiliar or duplicated trees fail instead of inventing recording ownership', async () => {
  const client = new Client(), reader = new CourseRecordings(client);
  for (const value of [{ Items: [] }, { Modules: [{ ModuleId: 200, Topics: [{ TopicId: 301 }, { TopicId: 301 }] }] }]) {
    client.payloads.set('100/content/toc', value);
    await assert.rejects(reader.list('100'), { code: 'API_FORMAT_CHANGED' });
  }
});


test('standalone captions remain unverified when their source contains multiple recordings', async () => {
  const client = fixture([]);
  client.payloads.set('100/content/modules/200', { Id: 200, Title: 'Lecture recordings', Description: { Html: [
    '<video src="/content/enforced/100/first.mp4"><track src="/content/enforced/100/first.vtt"></video>',
    '<video src="/content/enforced/100/second.mp4"></video>',
    '<a href="/content/enforced/100/unassociated.vtt">Lecture captions</a>',
  ].join('') } });
  const result = await new CourseRecordings(client).list('100');
  const first = items(result).find(item => String(item.url).endsWith('first.mp4'))!;
  const second = items(result).find(item => String(item.url).endsWith('second.mp4'))!;
  assert.equal((first.captionLinks as Row[]).length, 1);
  assert.equal((first.captionLinks as Row[])[0]!.association, 'media_track');
  assert.deepEqual(second.captionLinks, []);
  const unassociated = (result.captionLinks as Row[]).find(caption => String(caption.url).endsWith('unassociated.vtt'))!;
  assert.equal(unassociated.association, 'unverified');
});

test('a freshly hidden or locked parent suppresses stale nested topic links and captions', async () => {
  for (const flag of ['IsHidden', 'IsLocked']) {
    const client = fixture([], [{ ModuleId: 201, Title: 'Unit', Modules: [
      { ModuleId: 202, Title: 'Week', Topics: [
        { TopicId: 304, Title: 'Lecture recording', Url: presentation,
          Description: { Html: '<a href="/content/enforced/100/subtitles.vtt">Captions</a>' } },
      ] },
    ] }]);
    client.payloads.set('100/content/topics/304', { Id: 304, Title: 'Lecture recording', Url: presentation });
    client.payloads.set('100/content/modules/201', { Id: 201, [flag]: true });
    client.payloads.set('100/content/modules/202', { Id: 202, Title: 'Week' });
    const result = await new CourseRecordings(client).list('100');
    assert.deepEqual(items(result), []);
    assert.deepEqual(result.captionLinks, []);
    assert.equal(record(result.coverage).excludedObjects, 3);
    assert.equal(record(result.coverage).skippedDetails, 1);
    assert.ok(!client.calls.includes('100/content/modules/202'));
    assert.ok(client.calls.indexOf('100/content/topics/304') < client.calls.indexOf('100/content/modules/201'));
  }
});

test('global caption and provenance budgets bound results and retain aggregate omission counts', async () => {
  const topics: Row[] = [
    ...Array.from({ length: 1_300 }, (_, index) => ({ TopicId: 1_000 + index, Title: 'Captions', Url: '/content/enforced/100/caption-' + index + '.vtt' })),
    ...Array.from({ length: 1_300 }, (_, index) => ({ TopicId: 3_000 + index, Title: 'Recording', Url: '/content/enforced/100/shared.mp4' })),
  ];
  const result = await new CourseRecordings(fixture(topics)).list('100', { maxDetails: 0 });
  assert.equal((result.captionLinks as Row[]).length, 1_000);
  assert.equal(items(result).length, 1);
  assert.equal((items(result)[0]!.sources as Row[]).length, 1_000);
  const coverage = record(result.coverage);
  assert.equal(coverage.omissionCount, 600);
  assert.deepEqual(coverage.omissionsByReason, { caption_limit: 300, provenance_limit: 300 });
  assert.equal((coverage.omissions as Row[]).length, 100);
  assert.equal(coverage.omissionDetailsTruncated, true);
  assert.equal(result.complete, false);
});

test('a source truncated by link limits cannot imply unique ownership of a standalone caption', async () => {
  const client = fixture([{ TopicId: 301, Title: 'Recording page', Description: { Html:
    '<a href="/content/enforced/100/captions.vtt">Captions</a><video src="/content/enforced/100/one.mp4"></video>'
      + '<a href="/course">Resource</a>'.repeat(210) + '<video src="/content/enforced/100/two.mp4"></video>',
  } }]);
  const result = await new CourseRecordings(client).list('100');
  assert.equal(items(result).length, 1);
  assert.deepEqual(items(result)[0]!.captionLinks, []);
  assert.equal((result.captionLinks as Row[])[0]!.association, 'unverified');
});
