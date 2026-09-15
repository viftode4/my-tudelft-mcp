// Own-account OSIRIS reads and discarded previews only. Never confirms a registration.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const client = new Client({ name: 'mytudelft-read-check', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(project, 'dist', 'cli.js'), 'serve'], cwd: project, stderr: 'pipe' });
transport.stderr?.resume();
const checks = [];
function rows(value, field) {
  if (Array.isArray(value)) return value.flatMap(item => rows(item, field));
  if (!value || typeof value !== 'object') return [];
  return [...(value[field] === undefined ? [] : [value]), ...Object.values(value).flatMap(item => rows(item, field))];
}
async function call(name, args = {}) {
  assert.ok(!/confirm|login|logout/.test(name), 'The smoke check only reads and prepares previews.');
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const raw = response.content.find(item => item.type === 'text')?.text ?? '{}';
  let value = response.structuredContent;
  if (!value) { try { value = JSON.parse(raw); } catch { value = { error: { code: 'MCP_RESPONSE_ERROR', message: raw.slice(0, 1000) } }; } }
  const entry = { tool: name, variant: args.kind ?? args.section, offset: args.offset, checkedAt: new Date().toISOString(),
    ...(response.isError ? { error: value.error ?? value } : { accountVerified: value.accountVerified, status: value.status,
      count: value.items?.length, hasMore: value.hasMore, complete: value.complete,
      fields: Object.keys(value.items?.[0] ?? value.data ?? value.item ?? value) }) };
  checks.push(entry); console.log(JSON.stringify(entry));
  return response.isError ? undefined : value;
}
try {
  await client.connect(transport);
  assert.equal((await call('check_mytu_auth'))?.connected, true, 'Connect and verify My TU Delft first.');
  const grades = await call('list_official_grades', { limit: 5 });
  if (grades?.nextOffset !== null && grades?.nextOffset !== undefined) await call('list_official_grades', { limit: 5, offset: grades.nextOffset });
  if (grades?.items?.[0]) await call('get_official_grade', { resultId: grades.items[0].id });
  const progress = await call('get_official_progress', { limit: 5 });
  const phase = rows(progress?.items, 'id_voortgang')[0];
  if (phase) {
    await call('get_official_programme', { progressId: String(phase.id_voortgang), section: 'curriculum' });
    await call('get_official_programme', { progressId: String(phase.id_voortgang), section: 'advice', limit: 5 });
  }
  await call('get_official_profile');
  await call('get_official_timetable', { limit: 5 });
  for (const kind of ['course', 'exam', 'programme', 'minor', 'specialisation']) {
    await call('list_official_registrations', { kind, limit: 5 });
    if (['course', 'exam'].includes(kind)) await call('list_official_registrations', { kind, history: true, limit: 5 });
  }
  for (const kind of ['course', 'exam']) {
    let available = await call('search_official_courses', { kind, limit: 5 });
    await call('search_official_courses', { kind, planned: true, limit: 5 });
    const query = grades?.items?.find(item => item.courseCode)?.courseCode ?? grades?.items?.find(item => item.course)?.course;
    if (typeof query === 'string' && query.length >= 2) {
      const matches = await call('search_official_courses', { kind, query, limit: 5 });
      if (!available?.items?.length) available = matches;
    }
    const course = rows(available?.items, 'id_cursus')[0];
    if (!course) continue;
    const courseId = String(course.id_cursus);
    if (kind === 'exam') {
      const detail = await call('get_official_course', { kind, courseId });
      const exam = rows(detail?.data, 'id_toets_gelegenheid')[0];
      if (exam) await call('prepare_official_registration', { kind, courseId, targetId: String(exam.id_toets_gelegenheid) });
    } else {
      const blocks = await call('get_official_course', { kind, courseId, section: 'blocks' });
      const block = rows(blocks?.data, 'id_cursus_blok')[0];
      if (block) {
        await call('get_official_course', { kind, courseId: String(block.id_cursus_blok) });
        await call('prepare_official_registration', { kind, courseId: String(block.id_cursus_blok) });
      }
    }
  }
} finally {
  try {
    await mkdir(join(project, '.local'), { recursive: true });
    await writeFile(join(project, '.local', 'last-mytu-study-check.json'), JSON.stringify(checks, null, 2) + '\n');
  } finally { await client.close(); }
}
