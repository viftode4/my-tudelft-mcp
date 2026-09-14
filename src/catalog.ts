import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import { BrowserReader, snapshotPage, type PageSnapshot } from './browser.js';
import type { BrightspaceClient } from './client.js';
import { BrightspaceError } from './errors.js';
import { record, sameOriginUrl, sleep, str } from './util.js';

export interface CatalogCourse { id: string; title: string; url: string; code?: string; semester?: string; }
export interface CourseInspection { course: CatalogCourse; snapshot: PageSnapshot; canEnroll: boolean; }
export interface RegistrationPreview {
  status: 'confirmation_required' | 'already_enrolled' | 'unsupported';
  course: CatalogCourse; message: string; snapshot: PageSnapshot;
  confirmationToken?: string; expiresAt?: string;
}
export interface RegistrationResult {
  status: 'enrolled' | 'already_enrolled' | 'unverified';
  course: CatalogCourse; message: string; verifiedAt?: string;
}

// This interface makes it possible to test the write boundary without enrolling a real student.
export interface RegistrationBackend {
  accountId(): Promise<string>;
  inspect(url: string): Promise<CourseInspection>;
  enrolled(courseId: string): Promise<boolean>;
  enroll(expected: CatalogCourse, assertCurrent?: () => void): Promise<void>;
}

export function discoverCourseUrl(input: string, origin: string): { id: string; url: string } {
  const url = sameOriginUrl(input, origin);
  const match = /^\/d2l\/le\/discovery\/view\/course\/(\d{1,18})\/?$/.exec(url.pathname);
  if (!match || url.search || url.hash) {
    throw new BrightspaceError('UNSUPPORTED_REGISTRATION', 'Use the exact Brightspace Discover course URL returned by search_catalog. Legacy catalog and official course/exam registration are not supported.');
  }
  return { id: match[1]!, url: `${origin}/d2l/le/discovery/view/course/${match[1]}` };
}

function sameCourse(a: CatalogCourse, b: CatalogCourse): boolean {
  return a.id === b.id && a.url === b.url && a.title === b.title && a.code === b.code && a.semester === b.semester;
}

// Selectors below were observed on TU Delft's live Discover course page. No guessed write API is used.
const SUMMARY = 'course-summary#d2l-discovery-course-summary';
const ENROLL = '#d2l-discovery-course-summary-enroll';

async function inspectPage(page: Page, input: string, origin: string): Promise<CourseInspection> {
  const target = discoverCourseUrl(input, origin);
  const actual = discoverCourseUrl(page.url(), origin);
  if (target.id !== actual.id) throw new BrightspaceError('COURSE_CHANGED', 'The catalog redirected to a different course. Prepare a new registration.');
  const summary = page.locator(`${SUMMARY}[data-is-ready]`);
  await summary.waitFor({ state: 'attached', timeout: 15_000 });
  if (await summary.count() !== 1 || await summary.getAttribute('course-id') !== target.id) {
    throw new BrightspaceError('COURSE_CHANGED', 'The course page does not match the requested course ID.');
  }
  const title = (await summary.getAttribute('course-title'))?.trim();
  const heading = (await page.locator('#d2l-discovery-course-summary-title').innerText()).trim();
  if (!title || title !== heading) throw new BrightspaceError('COURSE_CHANGED', 'The course title could not be verified.');
  const snapshot = await snapshotPage(page, origin);
  const code = /(?:^|\n)Course Code\n([^\n]+)/.exec(snapshot.text)?.[1]?.trim();
  const semester = /(?:^|\n)Semester\n([^\n]+)/.exec(snapshot.text)?.[1]?.trim();
  const button = page.locator(ENROLL);
  const canEnroll = await button.count() === 1 && await button.isVisible() && await button.isEnabled()
    && await button.getAttribute('disabled') === null && await button.getAttribute('aria-disabled') !== 'true'
    && (await button.innerText()).trim() === 'Enroll in Course';
  return { course: { ...target, title, code, semester }, snapshot, canEnroll };
}

class DiscoverBackend implements RegistrationBackend {
  constructor(private readonly browser: BrowserReader, private readonly client: BrightspaceClient) {}
  async accountId(): Promise<string> {
    const id = str(record(await this.client.json('lp', 'users/whoami')).Identifier);
    if (!/^\d+$/.test(id)) throw new BrightspaceError('AUTH_REQUIRED', 'The current Brightspace identity could not be verified.');
    return id;
  }
  async inspect(url: string): Promise<CourseInspection> {
    const opened = await this.browser.openCatalog(url);
    try { return await inspectPage(opened.page, url, this.browser.auth.config.baseUrl); }
    finally { await opened.close(); }
  }
  async enrolled(courseId: string): Promise<boolean> {
    const result = await this.client.list('lp', 'enrollments/myenrollments/', {}, 100);
    if (result.items.some((entry) => str(record(record(entry).OrgUnit).Id) === courseId)) return true;
    if (!result.complete) throw new BrightspaceError('ENROLLMENT_UNVERIFIED', 'The enrollment list was incomplete; no registration will be attempted.');
    return false;
  }
  async enroll(expected: CatalogCourse, assertCurrent?: () => void): Promise<void> {
    const opened = await this.browser.openCatalog(expected.url);
    try {
      const fresh = await inspectPage(opened.page, expected.url, this.browser.auth.config.baseUrl);
      if (!sameCourse(fresh.course, expected) || !fresh.canEnroll) {
        throw new BrightspaceError('COURSE_CHANGED', 'The course or enrollment action changed after the preview. Prepare a new registration.');
      }
      // Exactly one verified control is clicked. We never automate approval requests, payments,
      // unenrollment, or arbitrary dialog buttons, and never retry a potentially completed click.
      await this.client.sessionIdentity();
      assertCurrent?.();
      await opened.page.locator(ENROLL).click({ timeout: 15_000 });
      await opened.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    } finally { await opened.close(); }
  }
}

interface Pending { course: CatalogCourse; accountId: string; expiresAt: number; }
export class Catalog {
  private readonly pending = new Map<string, Pending>();
  private generation = 0;
  private readonly backend?: RegistrationBackend;
  private readonly now: () => number;
  private readonly pause: (milliseconds: number) => Promise<void>;

  constructor(readonly browser: BrowserReader, client?: BrightspaceClient,
    options: { backend?: RegistrationBackend; now?: () => number; pause?: (milliseconds: number) => Promise<void> } = {}) {
    this.backend = options.backend ?? (client ? new DiscoverBackend(browser, client) : undefined);
    this.now = options.now ?? Date.now;
    this.pause = options.pause ?? sleep;
  }

  async search(query?: string, url?: string): Promise<PageSnapshot> { return this.browser.catalog(query, url); }

  async prepare(courseUrl: string): Promise<RegistrationPreview> {
    const generation = this.generation;
    const target = discoverCourseUrl(courseUrl, this.browser.auth.config.baseUrl);
    if (!this.backend) throw new BrightspaceError('UNSUPPORTED_REGISTRATION', 'An authenticated Brightspace API connection is required to verify enrollment.');
    const accountId = await this.backend.accountId();
    const inspection = await this.backend.inspect(target.url);
    if (inspection.course.id !== target.id || inspection.course.url !== target.url) throw new BrightspaceError('COURSE_CHANGED', 'The inspected course does not match the requested course.');
    if (await this.backend.enrolled(target.id)) {
      return { status: 'already_enrolled', ...inspection, message: 'Your Brightspace account already belongs to this course.' };
    }
    if (!inspection.canEnroll) {
      return { status: 'unsupported', ...inspection, message: 'This course does not expose the verified direct Enroll in Course action. Approval requests and official My TU Delft course/exam registration require their own service.' };
    }
    const now = this.now();
    this.assertCurrent(generation);
    for (const [token, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(token);
    if (this.pending.size >= 20) this.pending.delete(this.pending.keys().next().value!);
    const confirmationToken = randomBytes(24).toString('base64url'), expiresAt = now + 5 * 60_000;
    this.pending.set(confirmationToken, { course: { ...inspection.course }, accountId, expiresAt });
    return {
      status: 'confirmation_required', course: inspection.course, snapshot: inspection.snapshot,
      confirmationToken, expiresAt: new Date(expiresAt).toISOString(),
      message: 'Review the exact course, code, and semester with the student before calling confirm_registration. This grants Brightspace course access; it does not register an official course or exam in My TU Delft.',
    };
  }

  async confirm(token: string): Promise<RegistrationResult> {
    const generation = this.generation;
    const pending = this.pending.get(token);
    // Consume before any await: concurrent or repeated calls cannot reuse a confirmation.
    this.pending.delete(token);
    if (!pending || pending.expiresAt <= this.now()) throw new BrightspaceError('INVALID_CONFIRMATION', 'This confirmation is invalid, expired, or already used. Prepare a new registration.');
    if (!this.backend) throw new BrightspaceError('UNSUPPORTED_REGISTRATION', 'Enrollment verification is unavailable.');
    if (await this.backend.accountId() !== pending.accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The signed-in account changed. Prepare a new registration.');
    this.assertCurrent(generation);
    const current = await this.backend.inspect(pending.course.url);
    this.assertCurrent(generation);
    if (!sameCourse(current.course, pending.course)) throw new BrightspaceError('COURSE_CHANGED', 'Course details changed. Review a new registration preview.');
    const alreadyEnrolled = await this.backend.enrolled(pending.course.id);
    this.assertCurrent(generation);
    if (alreadyEnrolled) return { status: 'already_enrolled', course: pending.course, message: 'Your Brightspace account already belongs to this course.' };
    if (!current.canEnroll) throw new BrightspaceError('REGISTRATION_UNAVAILABLE', 'The course no longer offers direct enrollment.');
    try { await this.backend.enroll(pending.course, () => this.assertCurrent(generation)); }
    catch (error) {
      if (error instanceof BrightspaceError && ['COURSE_CHANGED', 'ACCOUNT_CHANGED', 'INVALID_CONFIRMATION'].includes(error.code)) throw error;
      return { status: 'unverified', course: pending.course, message: 'The enrollment action could not be verified and may have completed. Check your course memberships before preparing another attempt.' };
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await this.pause(700 * attempt);
      try {
        if (await this.backend.enrolled(pending.course.id)) return {
          status: 'enrolled', course: pending.course, verifiedAt: new Date(this.now()).toISOString(),
          message: 'Brightspace course membership was verified through the current account enrollment API. Official course/exam registration remains separate.',
        };
      } catch { break; }
    }
    return { status: 'unverified', course: pending.course, message: 'The enrollment control was clicked once, but Brightspace has not confirmed membership. Check your course memberships before trying again.' };
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new BrightspaceError('INVALID_CONFIRMATION', 'The account session changed or pending registrations were cleared. Prepare a new registration.');
  }

  async close(): Promise<void> { this.generation++; this.pending.clear(); }
}
