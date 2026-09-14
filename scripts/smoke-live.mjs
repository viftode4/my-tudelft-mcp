// Explicit read-only live integration check. Uses the existing local session.
// Course arguments are supplied at runtime; private data is never written to fixtures.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const courseIds = process.argv.slice(2);
if (!courseIds.length || courseIds.some((id) => !/^\d+$/.test(id))) {
  process.stderr.write('Usage: node scripts/smoke-live.mjs <courseId> [courseId...]\n');
  process.exit(1);
}
const client = new Client({ name: 'brightspace-live-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'serve'],
  stderr: 'pipe',
});
let diagnostics = '';
transport.stderr?.on('data', (chunk) => { diagnostics += chunk.toString(); });
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const value = response.structuredContent ?? JSON.parse(response.content.find((item) => item.type === 'text').text);
  if (response.isError) throw new Error(JSON.stringify({ tool: name, error: value.error ?? value }));
  return value;
}
try {
  await client.connect(transport);
  const listing = await client.listTools();
  console.log(JSON.stringify({ tools: listing.tools.length }));
  const auth = await call('check_auth');
  console.log(JSON.stringify({ liveAuthenticated: auth.connected }));
  const courses = await call('list_courses', { activeOnly: false });
  console.log(JSON.stringify({ memberships: courses.items?.length, complete: courses.complete }));
  for (const courseId of courseIds) {
    const outline = await call('get_course_content', { courseId });
    console.log(JSON.stringify({ courseId, topics: outline.topics?.length, source: outline.source, complete: outline.complete }));
    for (const name of ['get_announcements', 'list_assignments', 'get_my_grades', 'list_quizzes', 'read_discussions', 'get_calendar']) {
      const args = { courseId };
      if (name === 'get_calendar') { args.from = new Date(Date.now() - 7 * 86400000).toISOString(); args.to = new Date(Date.now() + 30 * 86400000).toISOString(); }
      const data = await call(name, args);
      console.log(JSON.stringify({ courseId, tool: name, source: data.source, items: data.items?.length ?? data.values?.length, complete: data.complete, browserFallback: data.source === 'browser' }));
      if (name === 'list_assignments' && data.items?.[0]?.id) {
        const detail = await call('get_assignment', { courseId, assignmentId: data.items[0].id });
        console.log(JSON.stringify({ courseId, tool: 'get_assignment', hasDetails: Boolean(detail.details), submissionError: detail.submissionError?.code }));
      }
    }
    const start = await call('start_course_sync', { courseId, maxFiles: 30 });
    let job;
    do {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      job = await call('get_sync_status', { jobId: start.jobId });
    } while (job.state === 'queued' || job.state === 'running');
    console.log(JSON.stringify({ courseId, sync: job.state, ...job.result, error: job.error }));
    if (job.state === 'failed') process.exitCode = 1;
    const search = await call('search_course_materials', { courseId, query: 'the', limit: 3 });
    console.log(JSON.stringify({ courseId, searchHits: search.items?.length, source: search.source }));
  }
  console.log(JSON.stringify({ protocol: 'passed', unexpectedStderr: /(?:Error:|Unhandled)/.test(diagnostics) }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await client.close(); }
