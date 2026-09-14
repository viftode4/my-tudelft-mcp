import type { BrightspaceClient } from './client.js';
import { BrightspaceError, safeError } from './errors.js';
import { numericId, plainText, record, safeSourceUrl, str, type Row } from './util.js';

export type GroupsClient = Pick<BrightspaceClient, 'json' | 'list' | 'config'>;
type GroupIssue = { part: string; categoryId?: string; groupId?: string; code: string; message: string; status?: number };
export interface OwnGroup {
  id: string; categoryId: string; courseId: string; name: string; code: string;
  description: string | null; membership: 'enrolled'; detailSource: 'group_api' | 'own_enrollment';
  complete: boolean; url: string;
}
export interface StudentGroupCategory {
  id: string; name: string; description: string; enrollmentStyle: number | null;
  enrollmentStyleName: string; selfEnrollmentConfigured: boolean | null; maxUsersPerGroup: number | null;
  selfEnrollmentStartsAt: string | null; selfEnrollmentExpiresAt: string | null;
  descriptionsVisibleToEnrolees: boolean | null; groupCount: number | null;
  ownMembership: 'enrolled' | 'not_enrolled' | 'unknown'; ownGroups: OwnGroup[];
  complete: boolean; url: string;
}

const ENROLLMENT_STYLES = [
  'NumberOfGroupsNoEnrollment', 'PeoplePerGroupAutoEnrollment', 'NumberOfGroupsAutoEnrollment',
  'PeoplePerGroupSelfEnrollment', 'SelfEnrollmentNumberOfGroups', 'PeoplePerNumberOfGroupsSelfEnrollment',
  'SingleUserMemberSpecificGroup',
] as const;
const MAX_CATEGORIES = 100;
const MAX_GROUP_DETAILS = 100;

function publicText(value: unknown, origin: string): string {
  return plainText(value).replace(/https?:\/\/[^\s<>"']+/gi,
    (url) => safeSourceUrl(url, origin) ?? '[unsafe URL omitted]');
}

function apiId(value: unknown, label: string): string {
  const id = str(value);
  if (!/^\d{1,18}$/.test(id)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned ' + label + ' without a numeric identifier.');
  return id;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalDate(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function issue(error: unknown, part: string, categoryId?: string, groupId?: string): GroupIssue {
  // Authentication changes invalidate the whole read, rather than appearing as empty membership.
  if (error instanceof BrightspaceError && ['AUTH_REQUIRED', 'ACCOUNT_CHANGED'].includes(error.code)) throw error;
  const safe = safeError(error), status = safe.details?.status;
  return { part, ...(categoryId ? { categoryId } : {}), ...(groupId ? { groupId } : {}),
    code: safe.code, message: safe.message, ...(typeof status === 'number' ? { status } : {}) };
}

function partialIssue(part: string, categoryId?: string): GroupIssue {
  return { part, ...(categoryId ? { categoryId } : {}), code: 'PARTIAL_RESULTS',
    message: 'Brightspace pagination was incomplete. Missing memberships cannot be ruled out.' };
}

/** Uses only current-user enrollments and the group route that excludes enrollment rosters. */
export class StudentGroups {
  constructor(private readonly client: GroupsClient) {}

  async get(courseId: string, categoryId?: string) {
    const course = numericId(courseId), category = categoryId === undefined ? undefined : numericId(categoryId);
    const origin = this.client.config.baseUrl, url = origin + '/d2l/lms/group/user_group_list.d2l?ou=' + course;
    const errors: GroupIssue[] = [], categories: StudentGroupCategory[] = [], myGroups: OwnGroup[] = [];
    const metadata = { source: 'api', courseId: course, url, fetchedAt: new Date().toISOString() };
    let rawCategories: unknown[], categoriesComplete = true;
    try {
      if (category) rawCategories = [await this.client.json('lp', course + '/groupcategories/' + category)];
      else {
        const result = await this.client.list('lp', course + '/groupcategories/');
        rawCategories = result.items;
        categoriesComplete = result.complete;
        if (!result.complete) errors.push(partialIssue('categories'));
      }
    } catch (error) {
      errors.push(issue(error, 'categories', category));
      return { ...metadata, status: 'unavailable', complete: false, membershipComplete: false, categories, myGroups, errors,
        note: 'Group categories could not be read. This does not establish that you have no groups.' };
    }
    if (rawCategories.length > MAX_CATEGORIES) {
      categoriesComplete = false;
      errors.push({ part: 'categories', code: 'READ_LIMIT', message: 'Only the first 100 categories were checked; request a specific category ID for more.' });
      rawCategories = rawCategories.slice(0, MAX_CATEGORIES);
    }
    if (!rawCategories.length) {
      return { ...metadata, status: categoriesComplete ? 'complete' : 'partial', complete: categoriesComplete,
        membershipComplete: categoriesComplete, categories, myGroups, errors,
        note: 'No group categories were returned for this course. No peer enrollment lists were requested.' };
    }

    const ownEnrollments = new Map<string, Row>();
    let membershipComplete = false;
    try {
      // D2L documents this as all enrollments of the calling user, including groups.
      // Intersecting those IDs with category.Groups avoids fetching other students' IDs.
      const result = await this.client.list('lp', 'enrollments/myenrollments/');
      for (const item of result.items) {
        const unit = record(record(item).OrgUnit), id = apiId(unit.Id, 'an own enrollment');
        ownEnrollments.set(id, unit);
      }
      membershipComplete = result.complete;
      if (!result.complete) errors.push(partialIssue('own_enrollments'));
    } catch (error) { errors.push(issue(error, 'own_enrollments')); }

    const seenCategories = new Set<string>();
    let detailsRead = 0;
    for (const raw of rawCategories) {
      const row = record(raw);
      let id: string;
      try {
        id = apiId(row.GroupCategoryId, 'a group category');
        if (category && id !== category) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned a different group category than requested.');
        if (seenCategories.has(id)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned a duplicate group category.');
        seenCategories.add(id);
      } catch (error) { errors.push(issue(error, 'category', category)); continue; }

      let groupIds: string[] = [], groupIdsComplete = true;
      try {
        if (!Array.isArray(row.Groups)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace did not provide the group IDs for this category.');
        groupIds = [...new Set(row.Groups.map((value) => apiId(value, 'a group')))];
      } catch (error) { groupIdsComplete = false; errors.push(issue(error, 'category_groups', id)); }
      const ownIds = groupIds.filter((groupId) => ownEnrollments.has(groupId)), ownGroups: OwnGroup[] = [];
      const visibility = typeof row.DescriptionsVisibleToEnrolees === 'boolean' ? row.DescriptionsVisibleToEnrolees : null;
      for (const groupId of ownIds) {
        const enrollment = ownEnrollments.get(groupId)!;
        const base: OwnGroup = { id: groupId, courseId: course, categoryId: id, name: str(enrollment.Name), code: str(enrollment.Code),
          description: null, membership: 'enrolled', detailSource: 'own_enrollment', complete: false, url };
        try {
          if (detailsRead >= MAX_GROUP_DETAILS) throw new BrightspaceError('READ_LIMIT', 'The read reached 100 own-group details; request a specific category for more.');
          detailsRead++;
          const group = record(await this.client.json('lp', course + '/groupcategories/' + id + '/groups/' + groupId + '/noenrollments'));
          if (apiId(group.GroupId, 'a group') !== groupId) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned a different group than requested.');
          // Explicit allowlist: even an unexpected Enrollments field must never leave this module.
          Object.assign(base, { name: str(group.Name) || base.name, code: str(group.Code) || base.code,
            description: visibility === false ? null : publicText(group.Description, origin), detailSource: 'group_api', complete: true });
        } catch (error) { errors.push(issue(error, 'group_details', id, groupId)); }
        ownGroups.push(base); myGroups.push(base);
      }
      const style = optionalNumber(row.EnrollmentStyle);
      const validStyle = style !== null && style < ENROLLMENT_STYLES.length;
      categories.push({
        id, name: str(row.Name), description: publicText(row.Description, origin),
        enrollmentStyle: style, enrollmentStyleName: validStyle ? ENROLLMENT_STYLES[style]! : 'Unknown',
        selfEnrollmentConfigured: validStyle ? [3, 4, 5].includes(style) : null, maxUsersPerGroup: optionalNumber(row.MaxUsersPerGroup),
        selfEnrollmentStartsAt: optionalDate(row.SelfEnrollmentStartDate), selfEnrollmentExpiresAt: optionalDate(row.SelfEnrollmentExpiryDate),
        descriptionsVisibleToEnrolees: visibility, groupCount: groupIdsComplete ? groupIds.length : null,
        ownMembership: ownGroups.length ? 'enrolled' : membershipComplete && groupIdsComplete ? 'not_enrolled' : 'unknown',
        ownGroups, complete: membershipComplete && groupIdsComplete && ownGroups.every((group) => group.complete), url,
      });
    }
    const complete = categoriesComplete && membershipComplete && !errors.length && categories.every((item) => item.complete);
    return { ...metadata, status: complete ? 'complete' : 'partial', complete,
      membershipComplete: categoriesComplete && membershipComplete
        && !errors.some((item) => item.part !== 'group_details') && categories.every((item) => item.ownMembership !== 'unknown'),
      categories, myGroups, errors,
      note: 'Only your own group membership and metadata are returned. Self-enrollment settings describe configuration, not permission or an available place; joining groups and group submissions require separate confirmed actions.' };
  }
}
