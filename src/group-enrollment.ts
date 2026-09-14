import { createHash, randomBytes } from 'node:crypto';
import type { Page, Route } from 'playwright';
import type { BrightspaceClient } from './client.js';
import type { BrowserReader, BrowserPage } from './browser.js';
import { resolveStudentCourse } from './course-navigation.js';
import { BrightspaceError, safeError } from './errors.js';
import { numericId, plainText, record, safeSourceUrl, str } from './util.js';

type Client = Pick<BrightspaceClient, 'json' | 'list' | 'config' | 'sessionIdentity'>;
type Browser = Pick<BrowserReader, 'open'>;
type RawRow = { name: string; categoryName: string; members: string; memberHandler: string; joinHandler: string; disabled: boolean };
type Observation = { title: string; rows: RawRow[]; empty: boolean; validPage: boolean; truncated: boolean; handler: string };
type Issue = { code: string; message: string };
type Category = { id: string; name: string; description: string; style: number; startsAt: string | null; expiresAt: string | null;
  groupIds: string[]; ownGroupIds: string[]; membershipComplete: boolean; restrictedBy: string | null };
export type AvailableGroup = { id: string; name: string; categoryId: string; categoryName: string; memberCount: number | null;
  capacity: number | null; availablePlaces: number | null; joinable: boolean; reason: string | null; url: string };
type Pending = { accountId: string; courseId: string; courseName: string; groupId: string; categoryId: string; fingerprint: string; expiresAt: number };
const PAGE_PATH = '/d2l/lms/group/user_available_group_list.d2l';
const RPC_PATH = PAGE_PATH + 'file';
const TTL = 5 * 60 * 1000;
const MAX_GROUPS = 500;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source = (origin: string, course: string) => origin + PAGE_PATH + '?ou=' + course;

function fail(error: unknown): Issue {
  if (error instanceof BrightspaceError && ['AUTH_REQUIRED', 'ACCOUNT_CHANGED'].includes(error.code)) throw error;
  const result = safeError(error);
  return { code: result.code, message: result.message };
}

function apiId(value: unknown): string {
  const id = str(value);
  if (!/^\d{1,18}$/.test(id)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an invalid group or category identifier.');
  return id;
}

function publicText(value: unknown, origin: string): string {
  return plainText(value).replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeSourceUrl(url, origin) ?? '[unsafe URL omitted]');
}

function validPage(url: string, origin: string, courseId: string): boolean {
  try {
    const value = new URL(url);
    return value.origin === origin && value.pathname === PAGE_PATH && value.searchParams.get('ou') === courseId
      && [...value.searchParams.keys()].length === 1 && !value.hash;
  } catch { return false; }
}

/** Reads identifiers from controls without opening ViewMembers or invoking SelfEnroll. */
export async function observeAvailableGroups(page: Page, origin: string, courseId: string): Promise<Observation> {
  if (!validPage(page.url(), origin, courseId)) throw new BrightspaceError('COURSE_CHANGED', 'The browser did not open the requested course group enrollment page.');
  return page.evaluate(({ limit, expectedCourse }) => {
    const main = document.querySelector('main,[role=main]') ?? document.body;
    let categoryName = '';
    const rows: RawRow[] = [];
    for (const row of Array.from(main.querySelectorAll('tr'))) {
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      if (cells.length === 1 && cells[0]?.getAttribute('colspan') === '4') {
        categoryName = cells[0].querySelector('label')?.textContent?.trim() ?? '';
      } else if (cells.length === 4) {
        const join = cells[3]?.querySelector('a[onclick]');
        rows.push({ name: cells[0]?.querySelector('label')?.textContent?.trim() ?? '', categoryName,
          members: cells[2]?.textContent?.trim() ?? '', memberHandler: cells[2]?.querySelector('a')?.getAttribute('onclick') ?? '',
          joinHandler: join?.getAttribute('onclick') ?? '', disabled: join?.getAttribute('aria-disabled') === 'true' || join?.hasAttribute('disabled') === true });
      }
      if (rows.length > limit) break;
    }
    const form = Array.from(document.forms).some((item) => item.getAttribute('method')?.toLowerCase() === 'post'
      && new URL(item.getAttribute('action') ?? '', location.href).href === location.origin + '/d2l/lms/group/user_available_group_list.d2l?ou=' + expectedCourse);
    const selfEnroll = (window as unknown as { SelfEnroll?: unknown }).SelfEnroll;
    const empty = /No items found\./i.test(main.textContent ?? '') || Array.from(main.querySelectorAll('d2l-empty-state-simple'))
      .some((element) => /No items found\./i.test(element.shadowRoot?.textContent ?? ''));
    return { title: document.title, rows: rows.slice(0, limit), empty,
      validPage: form && /Available Groups/.test(main.textContent ?? '') && !document.querySelector('input[type=password]'),
      truncated: rows.length > limit, handler: typeof selfEnroll === 'function' ? String(selfEnroll) : '' };
  }, { limit: MAX_GROUPS, expectedCourse: courseId });
}

function knownHandler(handler: string, courseId: string): boolean {
  return /D2L\.Rpc\.Create\(['"]IsGroupFull['"]/.test(handler) && /D2L\.Rpc\.Create\(['"]EnrollUser['"]/.test(handler)
    && handler.includes(PAGE_PATH) && handler.includes('/d2l/lms/group/user_group_list.d2l?ou=' + courseId);
}

/** Restricts the observed native RPC to one group and its capacity/enrollment actions. */
export function identifyGroupRpc(url: string, method: string, body: string | null, origin: string, courseId: string, groupId: string): 'capacity' | 'enroll' | undefined {
  try {
    const target = new URL(url);
    const queryKeys = [...target.searchParams.keys()];
    if (method !== 'POST' || target.origin !== origin || target.pathname !== RPC_PATH || target.searchParams.get('ou') !== courseId
      || queryKeys.length !== new Set(queryKeys).size || queryKeys.some((key) => !['ou', 'd2l_rh', 'd2l_rt'].includes(key))) return undefined;
    const data = new URLSearchParams(body ?? '');
    const bodyKeys = [...data.keys()];
    if (data.get('d2l_action') !== 'rpc' || bodyKeys.length !== new Set(bodyKeys).size
      || bodyKeys.some((key) => !['d2l_rf', 'params', 'd2l_referrer', 'd2l_hitcode', 'd2l_action'].includes(key))) return undefined;
    // The observed native serializer emits exactly this one numeric argument.
    // Parsing arbitrary JSON would conceal duplicate param1 keys.
    const args = /^\{"param1":(\d{1,16})\}$/.exec(data.get('params') ?? '');
    if (!args || !Number.isSafeInteger(Number(args[1])) || args[1] !== groupId) return undefined;
    return data.get('d2l_rf') === 'IsGroupFull' ? 'capacity' : data.get('d2l_rf') === 'EnrollUser' ? 'enroll' : undefined;
  } catch { return undefined; }
}

export class GroupEnrollment {
  private readonly pending = new Map<string, Pending>();
  private generation = 0;
  constructor(private readonly client: Client, private readonly browser: Browser) {}

  private async collect(courseId: string, categoryId?: string, retained?: BrowserPage) {
    const accountId = await this.client.sessionIdentity();
    if (!accountId) throw new BrightspaceError('AUTH_REQUIRED', 'A verified current account is required to inspect group enrollment.');
    const course = await resolveStudentCourse(this.client, courseId), url = source(this.client.config.baseUrl, courseId);
    const errors: Issue[] = [], categories: Category[] = [], groups: AvailableGroup[] = [];
    let categoriesComplete = false, membershipComplete = false;
    try {
      const raw = categoryId ? { items: [await this.client.json('lp', courseId + '/groupcategories/' + categoryId)], complete: true }
        : await this.client.list('lp', courseId + '/groupcategories/');
      categoriesComplete = raw.complete && raw.items.length <= 100;
      for (const entry of raw.items.slice(0, 100)) {
        const row = record(entry), id = apiId(row.GroupCategoryId);
        if (categoryId && id !== categoryId || categories.some((item) => item.id === id) || !str(row.Name).trim() || !Array.isArray(row.Groups)) {
          throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace did not provide a unique matching group category.');
        }
        categories.push({ id, name: str(row.Name), description: publicText(row.Description, this.client.config.baseUrl), style: Number(row.EnrollmentStyle),
          startsAt: row.SelfEnrollmentStartDate == null ? null : str(row.SelfEnrollmentStartDate),
          expiresAt: row.SelfEnrollmentExpiryDate == null ? null : str(row.SelfEnrollmentExpiryDate),
          restrictedBy: row.RestrictedByOrgUnitId == null ? null : apiId(row.RestrictedByOrgUnitId),
          groupIds: [...new Set(row.Groups.map(apiId))], ownGroupIds: [], membershipComplete: false });
      }
      if (!categoriesComplete) errors.push({ code: 'PARTIAL_RESULTS', message: 'Only part of the course group categories could be read.' });
    } catch (error) { categoriesComplete = false; errors.push(fail(error)); }
    try {
      const own = await this.client.list('lp', 'enrollments/myenrollments/');
      const ids = new Set(own.items.map((item) => apiId(record(record(item).OrgUnit).Id)));
      membershipComplete = own.complete;
      for (const category of categories) {
        category.ownGroupIds = category.groupIds.filter((id) => ids.has(id));
        category.membershipComplete = membershipComplete;
      }
      if (!own.complete) errors.push({ code: 'PARTIAL_RESULTS', message: 'Current group membership could not be fully enumerated.' });
    } catch (error) { errors.push(fail(error)); }
    let observed: Observation | undefined;
    const opened = retained ?? await this.browser.open(url);
    try {
      observed = await observeAvailableGroups(opened.page, this.client.config.baseUrl, courseId);
      if (!observed.validPage || !observed.rows.length && !observed.empty) {
        throw new BrightspaceError('PAGE_FORMAT_CHANGED', 'The native Available Groups page could not be identified.');
      }
      if (observed.truncated) errors.push({ code: 'READ_LIMIT', message: 'Only the first 500 available-group rows were inspected.' });
      const handlerSupported = knownHandler(observed.handler, courseId), seen = new Set<string>();
      for (const row of observed.rows) {
        const join = /^SelfEnroll\((\d{1,18})\);return false;$/.exec(row.joinHandler);
        const member = /^ViewMembers\((\d{1,18})\);return false;$/.exec(row.memberHandler);
        const id = join?.[1] ?? member?.[1];
        if (!id || !row.name || join && member && join[1] !== member[1] || seen.has(id)) {
          errors.push({ code: 'PAGE_FORMAT_CHANGED', message: 'A group row did not contain a unique consistent group identifier.' }); continue;
        }
        seen.add(id);
        const matches = categories.filter((item) => item.groupIds.includes(id));
        if (categoryId && !matches.length) continue;
        if (matches.length !== 1 || matches[0]!.name !== row.categoryName) {
          errors.push({ code: 'GROUP_CATEGORY_UNVERIFIED', message: 'An available group did not match exactly one API group category.' }); continue;
        }
        const category = matches[0]!, counts = /^(\d+)\s*\/\s*(\d+)(?:\s*\(Full\))?$/.exec(row.members);
        const parsedMembers = counts ? Number(counts[1]) : NaN, parsedCapacity = counts ? Number(counts[2]) : NaN;
        const validCounts = Number.isSafeInteger(parsedMembers) && Number.isSafeInteger(parsedCapacity)
          && parsedMembers >= 0 && parsedCapacity > 0 && parsedMembers <= parsedCapacity;
        const memberCount = validCounts ? parsedMembers : null, capacity = validCounts ? parsedCapacity : null;
        const places = memberCount !== null && capacity !== null ? Math.max(0, capacity - memberCount) : null;
        const startsAt = category.startsAt === null ? null : Date.parse(category.startsAt);
        const expiresAt = category.expiresAt === null ? null : Date.parse(category.expiresAt);
        let reason: string | null = null;
        if (!membershipComplete || !categoriesComplete) reason = 'membership_or_category_incomplete';
        else if (category.ownGroupIds.length) reason = 'already_enrolled_in_category';
        else if (![3, 4, 5].includes(category.style)) reason = 'self_enrollment_not_configured';
        else if (startsAt !== null && !Number.isFinite(startsAt) || expiresAt !== null && !Number.isFinite(expiresAt)) reason = 'enrollment_dates_invalid';
        else if (startsAt !== null && startsAt > Date.now()) reason = 'self_enrollment_not_started';
        else if (expiresAt !== null && expiresAt <= Date.now()) reason = 'self_enrollment_closed';
        else if (!handlerSupported) reason = 'native_action_not_recognized';
        else if (!join || row.disabled) reason = places === 0 ? 'full' : 'join_control_unavailable';
        else if (places === null || places < 1) reason = places === 0 ? 'full' : 'capacity_unknown';
        groups.push({ id, name: row.name, categoryId: category.id, categoryName: category.name, memberCount, capacity,
          availablePlaces: places, joinable: reason === null, reason, url });
      }
    } catch (error) { errors.push(fail(error)); }
    finally { if (!retained) await opened.close(); }
    if (await this.client.sessionIdentity() !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The account changed while inspecting group enrollment.');
    const complete = categoriesComplete && membershipComplete && Boolean(observed?.validPage) && !errors.length;
    return { course, accountId, source: 'api_and_browser', url, fetchedAt: new Date().toISOString(), complete,
      status: complete ? 'complete' : groups.length ? 'partial' : 'unavailable', categories, groups, errors,
      handlerFingerprint: hash(observed?.handler ?? '') };
  }

  async list(courseId: string, categoryId?: string) {
    const data = await this.collect(numericId(courseId), categoryId === undefined ? undefined : numericId(categoryId));
    const { handlerFingerprint: _, categories, ...result } = data;
    return { ...result, categories: categories.map(({ groupIds: _ids, ...category }) => category),
      note: 'Joinability is based on the current native student controls and your own membership. Counts can change. No member lists were opened.' };
  }

  private selection(data: Awaited<ReturnType<GroupEnrollment['collect']>>, groupId: string) {
    const group = data.groups.find((item) => item.id === groupId);
    if (!data.complete) throw new BrightspaceError('GROUP_ENROLLMENT_UNVERIFIED', 'Group enrollment details are incomplete. Refresh before preparing an action.');
    if (!group) throw new BrightspaceError('GROUP_NOT_AVAILABLE', 'The requested group is not listed on the native Available Groups page.');
    if (!group.joinable) throw new BrightspaceError('GROUP_NOT_JOINABLE', 'The selected group cannot currently be joined.', { reason: group.reason, groupId });
    const category = data.categories.find((item) => item.id === group.categoryId)!;
    // A changing occupancy count does not change the chosen group, but capacity and instructions do.
    return { group, fingerprint: hash({ groupId, groupName: group.name, capacity: group.capacity, category, handler: data.handlerFingerprint }) };
  }

  async prepare(courseId: string, groupId: string, categoryId?: string) {
    const generation = this.generation;
    courseId = numericId(courseId); groupId = numericId(groupId);
    if (categoryId !== undefined) categoryId = numericId(categoryId);
    for (const [token, item] of this.pending) if (item.expiresAt <= Date.now()) this.pending.delete(token);
    if (this.pending.size >= 8) throw new BrightspaceError('PREVIEW_LIMIT', 'There are too many pending group enrollment previews.');
    const data = await this.collect(courseId, categoryId), selected = this.selection(data, groupId);
    if (generation !== this.generation) throw new BrightspaceError('INVALID_PREVIEW', 'The session changed while preparing group enrollment.');
    const expiresAt = Date.now() + TTL, token = randomBytes(32).toString('base64url');
    this.pending.set(token, { accountId: data.accountId, courseId, courseName: data.course.name, groupId,
      categoryId: selected.group.categoryId, fingerprint: selected.fingerprint, expiresAt });
    return { status: 'preview', confirmationToken: token, expiresAt: new Date(expiresAt).toISOString(), accountId: data.accountId,
      course: data.course, target: { ...selected.group }, url: data.url,
      effect: 'Enroll the current account in this group. This can affect group assignments and which group resources are available.',
      confirmationRequired: 'Show the exact course, category, group, capacity and effect. Confirm only after the user explicitly approves joining this group. No place is reserved by this preview.' };
  }

  async confirm(token: string, confirmed = false) {
    if (confirmed !== true) throw new BrightspaceError('CONFIRMATION_REQUIRED', 'The user must explicitly approve the exact group before enrollment.');
    const pending = this.pending.get(token), generation = this.generation;
    this.pending.delete(token);
    if (!pending || pending.expiresAt <= Date.now()) throw new BrightspaceError('INVALID_PREVIEW', 'The group enrollment preview is expired, used or unknown.');
    if (await this.client.sessionIdentity() !== pending.accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The current account changed after the group enrollment preview.');
    const opened = await this.browser.open(source(this.client.config.baseUrl, pending.courseId));
    let enrollmentSent = false, enrollmentReserved = false, capacitySent = false, capacityCompleted = false, guardFailure = false, acceptingRequests = true;
    try {
      const data = await this.collect(pending.courseId, pending.categoryId, opened), selected = this.selection(data, pending.groupId);
      if (data.accountId !== pending.accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The current account changed after preview.');
      if (selected.fingerprint !== pending.fingerprint) throw new BrightspaceError('PREVIEW_STALE', 'The group or category details changed. Prepare and approve a new preview.');
      if (generation !== this.generation || pending.expiresAt <= Date.now()) throw new BrightspaceError('INVALID_PREVIEW', 'The preview expired or the session changed before enrollment.');
      const control = opened.page.locator('a[onclick="SelfEnroll(' + pending.groupId + ');return false;"]');
      if (await control.count() !== 1 || !await control.isVisible()) throw new BrightspaceError('PAGE_FORMAT_CHANGED', 'The exact group enrollment control could not be identified.');
      await opened.context.route('**/*', async (route: Route) => {
        const request = route.request();
        if (['GET', 'HEAD'].includes(request.method())) {
          const target = new URL(request.url());
          const allowed = target.origin === this.client.config.baseUrl && [PAGE_PATH, '/d2l/lms/group/user_group_list.d2l'].includes(target.pathname)
            && target.searchParams.get('ou') === pending.courseId && [...target.searchParams.keys()].length === 1;
          if (allowed) await route.fallback(); else await route.abort('blockedbyclient');
          return;
        }
        const action = identifyGroupRpc(request.url(), request.method(), request.postData(), this.client.config.baseUrl, pending.courseId, pending.groupId);
        if (!acceptingRequests || !action || action === 'capacity' && capacitySent || action === 'enroll' && (enrollmentReserved || !capacityCompleted)) {
          guardFailure = true; await route.abort('blockedbyclient'); return;
        }
        // Reserve synchronously: concurrent native retries cannot pass the gate together.
        if (action === 'capacity') capacitySent = true; else enrollmentReserved = true;
        try {
          const identity = await this.client.sessionIdentity();
          if (!acceptingRequests || generation !== this.generation || pending.expiresAt <= Date.now() || identity !== pending.accountId) {
            guardFailure = true; await route.abort('blockedbyclient'); return;
          }
          if (action === 'enroll') enrollmentSent = true;
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: this.client.config.timeoutMs });
          try {
            if (response.status() !== 200) { guardFailure = true; await route.abort('blockedbyclient'); return; }
            if (action === 'capacity') capacityCompleted = true;
            await route.fulfill({ response });
          } finally { await response.dispose(); }
        } catch { guardFailure = true; await route.abort('blockedbyclient').catch(() => undefined); }
      });
      await control.click({ timeout: this.client.config.timeoutMs }).catch(() => { guardFailure = true; });
      await opened.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      // Stop late native callbacks before deciding whether a mutation was sent.
      acceptingRequests = false;
      if (enrollmentSent) {
        try {
          const own = await this.client.list('lp', 'enrollments/myenrollments/');
          const exists = own.items.some((item) => str(record(record(item).OrgUnit).Id) === pending.groupId);
          if (exists && await this.client.sessionIdentity() === pending.accountId) {
            return { status: 'enrolled', courseId: pending.courseId, courseName: pending.courseName, accountId: pending.accountId,
              groupId: pending.groupId, groupName: selected.group.name, categoryId: pending.categoryId, verifiedAt: new Date().toISOString(),
              evidence: 'The selected group now appears in the current account enrollment list.', url: source(this.client.config.baseUrl, pending.courseId) };
          }
        } catch { /* An attempted enrollment needs an explicit unknown result if verification fails. */ }
        throw new BrightspaceError('GROUP_ENROLLMENT_OUTCOME_UNKNOWN', 'An enrollment request was sent, but membership could not be verified. Do not retry automatically; check your groups first.',
          { courseId: pending.courseId, groupId: pending.groupId, categoryId: pending.categoryId });
      }
      throw new BrightspaceError('GROUP_ENROLLMENT_NOT_SENT', guardFailure
        ? 'The native enrollment action could not be safely completed. No enrollment request was sent; refresh the group list.'
        : 'The native page did not send an enrollment request. The group may have filled; refresh the group list.');
    } finally { acceptingRequests = false; await opened.close(); }
  }

  close(): void { this.generation++; this.pending.clear(); }
}
