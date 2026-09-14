import type { BrightspaceClient } from './client.js';
import { BrowserReader, validateReadPage, type PageSnapshot } from './browser.js';
import { CourseNavigation } from './course-navigation.js';
import { StudentGroups } from './groups.js';
import { BrightspaceError } from './errors.js';
import { numericId, safeSourceUrl, sameOriginUrl } from './util.js';

const LOCKER_PATH = '/d2l/lms/locker/group/group_locker.d2l';
const PROGRESS_PATH = /^\/d2l\/le\/userprogress\/(\d{1,18})\/(\d{1,18})\/Summary\/?$/;
const PROGRESS_SECTIONS = { grades: 'Grades', content: 'Content', discussions: 'Discussions', assignments: 'Assignments', quizzes: 'Quizzes', checklists: 'Checklists', surveys: 'Survey' } as const;
export type ProgressSection = 'summary' | keyof typeof PROGRESS_SECTIONS;
const MUTATION_OR_PRIVATE = /upload|delete|remove|rename|create|new[_/-]?(?:file|folder)|edit|move|copy|permission|classlist|roster|group[_/-]?members|addressbook|\/email\/|instantmessage/i;

type SafeSnapshot = Omit<PageSnapshot, 'buttons' | 'media'>;

/** Native student pages whose ownership must be verified before browser retrieval. */
export class StudentPages {
  private readonly navigation: CourseNavigation;
  private readonly groups: StudentGroups;
  constructor(private readonly client: BrightspaceClient, private readonly browser: BrowserReader) {
    this.navigation = new CourseNavigation(client, browser);
    this.groups = new StudentGroups(client);
  }

  private async identity(): Promise<string> {
    const identity = await this.client.sessionIdentity();
    if (!identity || !/^\d{1,18}$/.test(identity)) {
      throw new BrightspaceError('AUTH_REQUIRED', 'Run check_auth to verify the current account before reading personal student pages.');
    }
    return identity;
  }

  private async unchanged(expected: string): Promise<void> {
    if (await this.identity() !== expected) throw new BrightspaceError('ACCOUNT_CHANGED', 'The account changed while reading this student page. Run check_auth to reconnect.');
  }

  private ownProgress(input: string, courseId: string, identity: string): URL | undefined {
    try {
      const url = sameOriginUrl(input, this.client.config.baseUrl), path = PROGRESS_PATH.exec(url.pathname);
      const safeQuery = [...url.searchParams].every(([key, value]) => ['searchString', 'sortField', 'sortDirection'].includes(key)
        && url.searchParams.getAll(key).length === 1 && (key === 'searchString' ? value === '' : /^[a-zA-Z0-9_-]{0,80}$/.test(value)));
      return path?.[1] === identity && path[2] === courseId && safeQuery && !url.hash ? url : undefined;
    } catch { return undefined; }
  }

  private progressSection(input: string, courseId: string, identity: string): keyof typeof PROGRESS_SECTIONS | undefined {
    try {
      const url = sameOriginUrl(input, this.client.config.baseUrl);
      const prefix = '/d2l/le/userprogress/' + identity + '/' + courseId + '/';
      if (!url.pathname.startsWith(prefix)) return undefined;
      const suffix = url.pathname.slice(prefix.length).replace(/\/$/, '');
      const section = (Object.keys(PROGRESS_SECTIONS) as (keyof typeof PROGRESS_SECTIONS)[]).find((key) => suffix === PROGRESS_SECTIONS[key] + '/Details');
      // Section navigation carries the same harmless sorting parameters as the summary.
      url.pathname = prefix + 'Summary';
      return section && this.ownProgress(url.href, courseId, identity) ? section : undefined;
    } catch { return undefined; }
  }

  private safeSnapshot(snapshot: PageSnapshot, acceptLink: (url: URL) => boolean): SafeSnapshot {
    const origin = this.client.config.baseUrl;
    const links = snapshot.links.flatMap((link) => {
      try {
        // Validate before redaction: removing an action or authentication parameter must
        // never turn an unsafe target into an apparently readable link.
        const url = new URL(validateReadPage(link.url, origin));
        if (MUTATION_OR_PRIVATE.test(url.pathname + url.search) || !acceptLink(url)) return [];
        const safe = safeSourceUrl(url.href, origin);
        return safe ? [{ title: link.title, url: safe }] : [];
      } catch { return []; }
    });
    return {
      title: snapshot.title, url: safeSourceUrl(snapshot.url, origin)!,
      text: snapshot.text.replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeSourceUrl(url, origin) ?? '[unsafe URL omitted]'),
      truncated: snapshot.truncated, links, retrievedAt: snapshot.retrievedAt, source: 'browser',
    };
  }

  async progress(courseId: string, section: ProgressSection = 'summary') {
    if (section !== 'summary' && !Object.hasOwn(PROGRESS_SECTIONS, section)) throw new BrightspaceError('INVALID_ARGUMENT', 'Select a supported own-progress section.');
    const course = numericId(courseId), identity = await this.identity();
    const navigation = await this.navigation.get(course);
    await this.unchanged(identity);
    const observed = navigation.tools.find((tool) => tool.location === 'personal_menu' && tool.kind === 'brightspace'
      && !tool.requiresLaunch && tool.readCoursePageAvailable && this.ownProgress(tool.url, course, identity));
    if (!observed) throw new BrightspaceError('PROGRESS_UNAVAILABLE', 'The course home did not expose a readable Progress link for the current student. No personal-progress URL was guessed.');
    const acceptLink = (rawUrl: string): boolean => Boolean(this.progressSection(rawUrl, course, identity)) || Boolean(this.ownProgress(rawUrl, course, identity));
    const page = await this.browser.read(observed.url, {
      acceptLink,
      validateUrl: (rawUrl) => { if (!this.ownProgress(rawUrl, course, identity)) throw new BrightspaceError('PROGRESS_UNVERIFIED', 'The browser did not remain on the current student progress summary for this course.'); },
    });
    await this.unchanged(identity);
    if (!this.ownProgress(page.url, course, identity)) {
      throw new BrightspaceError('PROGRESS_UNVERIFIED', 'The browser did not remain on the current student progress summary for this course.');
    }
    const prefix = '/d2l/le/userprogress/' + identity + '/' + course + '/';
    let snapshot = this.safeSnapshot(page, (url) => url.pathname.startsWith(prefix)
      && (!url.searchParams.has('ou') || url.searchParams.getAll('ou').every((value) => value === course))
      && ![...url.searchParams.keys()].some((key) => /user|student/i.test(key)));
    // BrowserReader first validates original links. Revalidate the sanitized output too;
    // removing an unsafe parameter must never create a callable target.
    const availableSections = page.links.flatMap((link) => {
      const value = this.progressSection(link.url, course, identity);
      return value ? [{ section: value, title: link.title, url: link.url }] : [];
    }).filter((link, index, links) => links.findIndex((candidate) => candidate.section === link.section && candidate.url === link.url) === index);
    const summaryUrl = snapshot.url;
    if (section !== 'summary') {
      const targets = availableSections.filter((link) => link.section === section);
      if (targets.length !== 1) throw new BrightspaceError('PROGRESS_SECTION_UNAVAILABLE', 'The current student summary did not expose one unambiguous link for this progress section.', { section, availableSections: [...new Set(availableSections.map((link) => link.section))] });
      await this.unchanged(identity);
      const selected = await this.browser.read(targets[0]!.url, {
        acceptLink,
        validateUrl: (rawUrl) => { if (this.progressSection(rawUrl, course, identity) !== section) throw new BrightspaceError('PROGRESS_UNVERIFIED', 'The browser did not remain in the selected current-student progress section.'); },
      });
      await this.unchanged(identity);
      if (this.progressSection(selected.url, course, identity) !== section) throw new BrightspaceError('PROGRESS_UNVERIFIED', 'The browser did not remain in the selected current-student progress section.');
      snapshot = this.safeSnapshot(selected, (url) => Boolean(this.progressSection(url.href, course, identity)) || Boolean(this.ownProgress(url.href, course, identity)));
    }
    return { source: 'browser', course: navigation.course, courseId: course, url: snapshot.url, fetchedAt: snapshot.retrievedAt,
      complete: false, snapshot, discoverySource: navigation.url, section, summaryUrl, availableSections,
      scope: 'The current student visible progress summary or selected section, discovered through its own summary links. Unopened sections, charts and paginated details may be absent; displayed progress is not proof of course completion.' };
  }

  async groupLocker(courseId: string, groupId: string) {
    const course = numericId(courseId), group = numericId(groupId), identity = await this.identity();
    const memberships = await this.groups.get(course);
    await this.unchanged(identity);
    const ownGroup = memberships.myGroups.find((item) => item.id === group && item.courseId === course && item.membership === 'enrolled');
    if (!ownGroup) throw new BrightspaceError(memberships.membershipComplete ? 'PERMISSION_DENIED' : 'GROUP_MEMBERSHIP_UNVERIFIED',
      memberships.membershipComplete ? 'This group is not in the current student own groups for this course.' : 'Membership in this exact group could not be verified. The group locker was not opened.');
    const url = new URL(LOCKER_PATH, this.client.config.baseUrl);
    url.searchParams.set('ou', course); url.searchParams.set('grpId', group);
    const page = await this.browser.read(url.href);
    await this.unchanged(identity);
    const actual = sameOriginUrl(page.url, this.client.config.baseUrl);
    const exactScope = (target: URL): boolean => target.searchParams.getAll('ou').length === 1 && target.searchParams.get('ou') === course
      && target.searchParams.getAll('grpId').length === 1 && target.searchParams.get('grpId') === group
      && ![...target.searchParams.keys()].some((key) => /user|student|owner/i.test(key));
    if (actual.pathname !== LOCKER_PATH || !exactScope(actual)) {
      throw new BrightspaceError('GROUP_LOCKER_UNVERIFIED', 'The browser did not remain in the verified group locker.');
    }
    const snapshot = this.safeSnapshot(page, (target) => target.pathname.startsWith('/d2l/lms/locker/group/') && exactScope(target));
    return { source: 'browser', courseId: course, group: { id: ownGroup.id, categoryId: ownGroup.categoryId, name: ownGroup.name, code: ownGroup.code },
      membershipSource: memberships.url, membershipVerified: true, url: snapshot.url, fetchedAt: snapshot.retrievedAt,
      complete: false, snapshot,
      scope: 'Visible names and metadata in this verified own-group shared locker. File contents, unopened folders and paginated entries were not retrieved. This tool does not download, upload, rename or delete group files.' };
  }
}
