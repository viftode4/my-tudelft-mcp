import type { Page } from 'playwright';
import type { BrightspaceClient } from './client.js';
import { BrowserReader, snapshotPage, validateReadPage } from './browser.js';
import { BrightspaceError, safeError } from './errors.js';
import { numericId, plainText, record, safeSourceUrl, str } from './util.js';

export type CourseClient = Pick<BrightspaceClient, 'json' | 'list' | 'config'>;
export interface StudentCourseInfo {
  id: string; name: string; code: string; url: string;
  metadataSource: 'course_api' | 'my_enrollments';
  active?: boolean; canAccess?: boolean; startDate?: unknown; endDate?: unknown;
  description?: string; semester?: string; department?: string;
  courseDetailsError?: ReturnType<typeof safeError>;
}

/** Course details may be forbidden to students even when their exact own membership is readable. */
export async function resolveStudentCourse(client: CourseClient, courseId: string): Promise<StudentCourseInfo> {
  const id = numericId(courseId), url = `${client.config.baseUrl}/d2l/home/${id}`;
  try {
    const course = record(await client.json('lp', `courses/${id}`));
    if (str(course.Identifier) !== id || !str(course.Name).trim() || !str(course.Code).trim()) {
      throw new BrightspaceError('API_FORMAT_CHANGED', 'The course details do not match the requested course.');
    }
    return { id, name: str(course.Name), code: str(course.Code), url, metadataSource: 'course_api',
      active: typeof course.IsActive === 'boolean' ? course.IsActive : undefined,
      startDate: course.StartDate, endDate: course.EndDate,
      description: plainText(course.Description).replace(/https?:\/\/[^\s<>"']+/gi, (source) => safeSourceUrl(source, client.config.baseUrl) ?? '[unsafe URL omitted]'),
      semester: str(record(course.Semester).Name) || undefined, department: str(record(course.Department).Name) || undefined };
  } catch (error) {
    if (!(error instanceof BrightspaceError) || !['PERMISSION_DENIED', 'NOT_FOUND'].includes(error.code)) throw error;
    let exact: Record<string, unknown> | undefined;
    try {
      exact = record(await client.json('lp', `enrollments/myenrollments/${id}`));
      if (str(record(exact.OrgUnit).Id) !== id) throw new BrightspaceError('API_FORMAT_CHANGED', 'The enrollment response does not match the requested course.');
    } catch (membershipError) {
      if (!(membershipError instanceof BrightspaceError) || !['PERMISSION_DENIED', 'NOT_FOUND'].includes(membershipError.code)) throw membershipError;
      const memberships = await client.list('lp', 'enrollments/myenrollments/', { orgUnitTypeId: '3' });
      exact = memberships.items.map(record).find((entry) => str(record(entry.OrgUnit).Id) === id);
      if (!exact) {
        if (!memberships.complete) throw new BrightspaceError('PAGINATION_ERROR', 'Course membership could not be verified from an incomplete enrollment list.');
        throw new BrightspaceError('PERMISSION_DENIED', 'This course is not present in the current account enrollment list.');
      }
    }
    const unit = record(exact.OrgUnit), access = record(exact.Access);
    if (access.CanAccess === false) throw new BrightspaceError('PERMISSION_DENIED', 'The current account cannot access this course.');
    if (!str(unit.Name).trim() || !str(unit.Code).trim()) throw new BrightspaceError('API_FORMAT_CHANGED', 'The current enrollment does not include an exact course name and code.');
    return { id, name: str(unit.Name), code: str(unit.Code), url, metadataSource: 'my_enrollments', courseDetailsError: safeError(error),
      active: typeof access.IsActive === 'boolean' ? access.IsActive : undefined,
      canAccess: typeof access.CanAccess === 'boolean' ? access.CanAccess : undefined,
      startDate: access.StartDate, endDate: access.EndDate };
  }
}

export interface CourseToolLink {
  key: string; title: string; url: string; sourceUrl: string;
  location: 'navigation' | 'course_home' | 'personal_menu';
  kind: 'brightspace' | 'lti' | 'external'; requiresLaunch: boolean;
  access: 'same_session' | 'launch_not_verified' | 'external_not_verified';
  externalAuthentication: 'not_needed_for_descriptor' | 'unknown';
  readCoursePageAvailable: boolean; suggestedTools: string[];
}
export interface ObservedCourseLink { title: string; url: string; location: CourseToolLink['location']; }

export function normalizeCourseTools(links: ObservedCourseLink[], origin: string, courseId: string): CourseToolLink[] {
  const id = numericId(courseId), sourceUrl = `${origin}/d2l/home/${id}`, seen = new Set<string>();
  return links.flatMap((link) => {
    const title = link.title.replace(/\s+/g, ' ').trim();
    if (!title || /^(?:Profile|Notifications|Account Settings|Help|My Home|Course Home|Log Out|Sign Out)$/i.test(title)) return [];
    const href = safeSourceUrl(link.url, origin);
    if (!href || seen.has(href)) return [];
    const url = new URL(href), sameOrigin = url.origin === origin;
    if (sameOrigin && url.searchParams.has('ou') && url.searchParams.get('ou') !== id) return [];
    const pathCourse = /^\/d2l\/(?:home|le\/(?:lessons|calendar))\/(\d+)/.exec(url.pathname)?.[1]
      ?? /^\/d2l\/le\/(\d+)\//.exec(url.pathname)?.[1];
    if (sameOrigin && pathCourse && pathCourse !== id) return [];
    const lti = sameOrigin && (url.searchParams.get('type')?.toLowerCase() === 'lti' || /\/lti\//i.test(url.pathname));
    const kind = lti ? 'lti' : sameOrigin ? 'brightspace' : 'external';
    let readCoursePageAvailable = false;
    if (sameOrigin && !lti) {
      try { validateReadPage(href, origin); readCoursePageAvailable = true; } catch { /* Descriptor only. */ }
    }
    let key = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (/announcement/i.test(title)) key = 'announcements';
    const suggested: Record<string, string[]> = {
      content: ['get_course_content', 'read_material'], grades: ['get_my_grades'],
      assignments: ['list_assignments', 'get_assignment'], quizzes: ['list_quizzes'],
      discussions: ['read_discussions'], calendar: ['get_calendar'], announcements: ['get_announcements'],
      groups: ['get_my_groups', 'list_available_groups'], progress: ['get_my_progress'],
      study_guide: ['search_study_guide', 'get_study_guide'], group_self_enrollment: ['read_course_service'],
    };
    seen.add(href);
    return [{ key, title, url: href, sourceUrl, location: link.location, kind, requiresLaunch: lti,
      access: lti ? 'launch_not_verified' : sameOrigin ? 'same_session' : 'external_not_verified',
      externalAuthentication: kind === 'brightspace' ? 'not_needed_for_descriptor' : 'unknown',
      readCoursePageAvailable, suggestedTools: suggested[key] ?? (readCoursePageAvailable ? ['read_course_page'] : []) } satisfies CourseToolLink];
  });
}

export async function observeCourseTools(page: Page, origin: string, courseId: string): Promise<CourseToolLink[]> {
  const id = numericId(courseId);
  const current = new URL(page.url());
  if (current.origin !== origin || !new RegExp(`^/d2l/home/${id}/?$`).test(current.pathname)) {
    throw new BrightspaceError('COURSE_CHANGED', 'The browser did not open the requested course home.');
  }
  // These containers were observed in the live desktop/mobile navbar. Playwright
  // pierces their open shadow roots, including menu-item links without clicking menus.
  const nav = await page.locator('.d2l-navigation-s-main-wrapper a[href], .d2l-navigation-s-mobile-menu-nav a[href]').evaluateAll((nodes) => nodes.map((node) => ({ title: node.textContent ?? '', url: node.getAttribute('href') ?? '' })));
  const all = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => ({ title: node.textContent ?? '', url: node.getAttribute('href') ?? '' })));
  const widgets: ObservedCourseLink[] = [];
  for (const link of all) {
    let url: URL; try { url = new URL(link.url, origin); } catch { continue; }
    if (url.origin !== origin) continue;
    if (url.pathname === `/d2l/le/calendar/${id}` || url.pathname === '/d2l/lms/news/main.d2l' && url.searchParams.get('ou') === id) {
      widgets.push({ ...link, location: 'course_home' });
    } else if (/^\/d2l\/le\/userprogress\/\d+\//.test(url.pathname) && url.pathname.endsWith(`/${id}/Summary`)) {
      widgets.push({ ...link, location: 'personal_menu' });
    }
  }
  return normalizeCourseTools([...nav.map((link) => ({ ...link, location: 'navigation' as const })), ...widgets], origin, id);
}

export class CourseNavigation {
  constructor(private readonly client: BrightspaceClient, private readonly browser: BrowserReader) {}
  async get(courseId: string) {
    const course = await resolveStudentCourse(this.client, courseId);
    const identity = await this.client.sessionIdentity();
    const opened = await this.browser.open(course.url);
    try {
      const tools = await observeCourseTools(opened.page, this.client.config.baseUrl, course.id);
      const snapshot = await snapshotPage(opened.page, this.client.config.baseUrl);
      if (await this.client.sessionIdentity() !== identity) throw new BrightspaceError('ACCOUNT_CHANGED', 'The account changed while reading course navigation.');
      const resources = snapshot.links.filter((link) => new URL(link.url).origin !== this.client.config.baseUrl)
        .filter((link, index, links) => links.findIndex((other) => other.url === link.url) === index).slice(0, 30)
        .map((link) => ({ ...link, sourceUrl: course.url, access: 'external_not_verified', externalAuthentication: 'unknown' }));
      return { course, source: 'api_and_browser', fetchedAt: snapshot.retrievedAt, url: course.url, tools, linkedResources: resources,
        complete: false, scope: 'Observed course navigation and course-home links. A link does not prove the target tool is enabled or accessible. External services and LTI launches were not opened.' };
    } finally { await opened.close(); }
  }
}
