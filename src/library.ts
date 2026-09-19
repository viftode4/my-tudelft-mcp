import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { BrightspaceError } from './errors.js';
import { safeSourceUrl, snippet } from './util.js';

const MAX_INDEXED_TEXT = 2_000_000;
export interface IndexedDocument { id: string; courseId: string; kind: string; title: string; url: string; text: string; fetchedAt: string; }
export interface ReadTarget { name: string; arguments: Record<string, string>; }
export interface SearchResult { id: string; courseId: string; kind: string; title: string; url: string; snippet: string; fetchedAt: string; cached: true; readTool?: ReadTarget; }

/** Targets are derived only from connector-owned resource keys, never document text or links. */
export function readTarget(id: string, courseId: string, kind: string): ReadTarget | undefined {
  const [scope, type, target, fourth, fifth, ...extra] = id.split(':');
  const numeric = (value: string | undefined): value is string => /^\d{1,18}$/.test(value ?? '');
  if (scope !== courseId || !numeric(scope) || extra.length) return undefined;
  const course = { courseId };
  if (kind === 'group_locker_file') {
    if (!numeric(type) || fourth !== undefined || !target || target.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(target)) return undefined;
    const filePath = Buffer.from(target, 'base64url').toString('utf8');
    if (Buffer.from(filePath, 'utf8').toString('base64url') !== target || !filePath.startsWith('/') || filePath.length > 2048) return undefined;
    const parts = filePath.slice(1).split('/');
    if (parts.length > 12 || parts.some((part) => !part || part.length > 255 || part === '.' || part === '..' || /[\\%?#:\u0000-\u001f\u007f]/.test(part))) return undefined;
    return { name: 'read_group_locker_file', arguments: { ...course, groupId: type, filePath } };
  }
  if (!numeric(target)) return undefined;
  if (fourth === undefined) {
    if (type === 'file' && kind === 'document' || type === 'topic' && kind === 'topic') return { name: 'read_material', arguments: { ...course, topicId: target } };
    if (type === 'module' && kind === 'module') return { name: 'get_course_content', arguments: course };
    if (type === 'assignment' && kind === 'assignment') return { name: 'get_assignment', arguments: { ...course, assignmentId: target } };
    if (type === 'news' && kind === 'announcement') return { name: 'get_announcements', arguments: course };
  }
  if (type === 'attachment' && kind === 'document' && numeric(fourth) && fifth === undefined) {
    return { name: 'read_assignment_attachment', arguments: { ...course, assignmentId: target, fileId: fourth } };
  }
  if (type !== kind || !numeric(fourth) || !numeric(fifth)) return undefined;
  if (type === 'announcement_attachment' && fourth === '0') return { name: 'read_announcement_attachment', arguments: { ...course, announcementId: target, fileId: fifth } };
  if (type === 'feedback_attachment' && fourth === '0') return { name: 'read_assignment_feedback_file', arguments: { ...course, assignmentId: target, fileId: fifth } };
  if (type === 'submission_file') return { name: 'read_my_submission_file', arguments: { ...course, assignmentId: target, submissionId: fourth, fileId: fifth } };
  return undefined;
}

export class Library {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, course_id UNINDEXED, kind UNINDEXED, title, url UNINDEXED, body, fetched_at UNINDEXED, tokenize="unicode61");');
    } catch (error) {
      // Node's bundled SQLite gained the FTS5 extension in 22.16.0. Older 22.x builds fail here with
      // a bare "no such module: fts5", which says nothing about what the student should do.
      if (error instanceof Error && /fts5/i.test(error.message)) {
        throw new BrightspaceError('SQLITE_FTS5_MISSING',
          `Local course search needs the FTS5 extension, which this Node build's SQLite does not include (running ${process.version}). Upgrade to Node 22.16 or later, or Node 24. Other tools are unaffected.`);
      }
      throw error;
    }
  }
  put(doc: IndexedDocument): void {
    const timestamp = Date.parse(doc.fetchedAt);
    if (!Number.isFinite(timestamp)) throw new BrightspaceError('INVALID_TIMESTAMP', 'An indexed document needs a valid fetch timestamp.');
    const fetchedAt = new Date(timestamp).toISOString();
    const source = safeSourceUrl(doc.url, doc.url) ?? '';
    this.db.exec('BEGIN');
    try {
      // IDs are only meaningful within their course/resource type.
      this.db.prepare('DELETE FROM documents WHERE id = ? AND course_id = ? AND kind = ?').run(doc.id, doc.courseId, doc.kind);
      this.db.prepare('INSERT INTO documents(id,course_id,kind,title,url,body,fetched_at) VALUES(?,?,?,?,?,?,?)').run(doc.id, doc.courseId, doc.kind, doc.title, source, doc.text.slice(0, MAX_INDEXED_TEXT), fetchedAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  search(query: string, courseId?: string, limit = 15): SearchResult[] {
    const tokens = query.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)?.slice(0, 20) ?? [];
    if (!tokens.length) return [];
    // User text is always literal; FTS operators, quotes, column filters and wildcards cannot alter the query.
    const match = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ');
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 15;
    const filtered = courseId !== undefined;
    const sql = 'SELECT id,course_id,kind,title,url,body,fetched_at FROM documents WHERE documents MATCH ?' + (filtered ? ' AND course_id = ?' : '') + ' ORDER BY bm25(documents,0,0,0,5,0,1,0), course_id, kind, id LIMIT ?';
    return this.db.prepare(sql).all(...(filtered ? [match, courseId, boundedLimit] : [match, boundedLimit])).map((row) => ({
      id: String(row.id), courseId: String(row.course_id), kind: String(row.kind), title: String(row.title), url: String(row.url),
      snippet: snippet(String(row.body), query), fetchedAt: String(row.fetched_at), cached: true,
      readTool: readTarget(String(row.id), String(row.course_id), String(row.kind)),
    }));
  }
  coverage(courseId?: string): unknown[] {
    const filtered = courseId !== undefined;
    return this.db.prepare('SELECT course_id AS courseId, kind, count(*) AS documents, min(fetched_at) AS oldestFetch, max(fetched_at) AS latestFetch FROM documents' + (filtered ? ' WHERE course_id = ?' : '') + ' GROUP BY course_id,kind ORDER BY course_id,kind').all(...(filtered ? [courseId] : []));
  }
  clear(courseId?: string): void {
    const filtered = courseId !== undefined;
    this.db.prepare('DELETE FROM documents' + (filtered ? ' WHERE course_id = ?' : '')).run(...(filtered ? [courseId] : []));
  }
  close(): void { this.db.close(); }
}
