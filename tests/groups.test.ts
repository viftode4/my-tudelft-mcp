import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../src/config.js';
import { BrightspaceError } from '../src/errors.js';
import { StudentGroups, type GroupsClient } from '../src/groups.js';

class FakeGroupsClient implements GroupsClient {
  config = { baseUrl: 'https://brightspace.tudelft.nl' } as Config;
  calls: { method: string; product: string; path: string }[] = [];
  categories: Record<string, unknown>[] = [{ GroupCategoryId: 31, Name: 'Project teams', Groups: [41, 42],
    Description: { Text: 'Choose a project team', Html: null }, EnrollmentStyle: 3, MaxUsersPerGroup: 4,
    DescriptionsVisibleToEnrolees: true, SelfEnrollmentStartDate: null, SelfEnrollmentExpiryDate: '2026-10-01T00:00:00Z' }];
  enrollments: unknown[] = [{ OrgUnit: { Id: 11, Name: 'Course' } }, { OrgUnit: { Id: 41, Name: 'Team A', Code: 'A' } }];
  group: unknown = { GroupId: 41, Name: 'Team A', Code: 'A', Description: { Text: 'Our project', Html: null } };
  incomplete = new Set<string>();
  failures = new Map<string, Error>();
  async list(product: 'lp' | 'le', path: string) {
    this.calls.push({ method: 'list', product, path });
    if (this.failures.has(path)) throw this.failures.get(path);
    if (path === '11/groupcategories/') return { items: structuredClone(this.categories), complete: !this.incomplete.has(path) };
    if (path === 'enrollments/myenrollments/') return { items: structuredClone(this.enrollments), complete: !this.incomplete.has(path) };
    throw new Error('Unexpected list request');
  }
  async json(product: 'lp' | 'le', path: string): Promise<unknown> {
    this.calls.push({ method: 'json', product, path });
    if (this.failures.has(path)) throw this.failures.get(path);
    if (path === '11/groupcategories/31') return structuredClone(this.categories[0]);
    if (path === '11/groupcategories/31/groups/41/noenrollments') return structuredClone(this.group);
    throw new Error('Unexpected detail request');
  }
}

test('own groups are matched using only own enrollment IDs and roster-free group detail', async () => {
  const client = new FakeGroupsClient(), result = await new StudentGroups(client).get('11');
  assert.equal(result.complete, true);
  assert.equal(result.status, 'complete');
  assert.equal(result.membershipComplete, true);
  assert.equal(result.categories[0]!.groupCount, 2);
  assert.equal(result.categories[0]!.ownMembership, 'enrolled');
  assert.equal(result.categories[0]!.selfEnrollmentConfigured, true);
  assert.equal(result.myGroups[0]!.id, '41');
  assert.equal(result.myGroups[0]!.description, 'Our project');
  assert.equal(result.myGroups[0]!.url, 'https://brightspace.tudelft.nl/d2l/lms/group/user_group_list.d2l?ou=11');
  assert.deepEqual(client.calls.map((call) => call.path), [
    '11/groupcategories/', 'enrollments/myenrollments/', '11/groupcategories/31/groups/41/noenrollments',
  ]);
  assert.ok(client.calls.every((call) => call.product === 'lp'));
});

test('unexpected roster fields and authentication fields never reach output', async () => {
  const client = new FakeGroupsClient();
  client.group = { GroupId: 41, Name: 'Team A', Code: 'A', Enrollments: [12345, 54321], AccessToken: 'private-token',
    Description: { Text: 'Read https://example.com/team?token=hidden&project=11', Html: null } };
  const result = await new StudentGroups(client).get('11'), serialized = JSON.stringify(result);
  for (const secret of ['12345', '54321', 'Enrollments', 'private-token', 'hidden']) assert.ok(!serialized.includes(secret));
  assert.equal(result.myGroups[0]!.description, 'Read https://example.com/team?project=11');
});

test('complete absence of own membership is distinguished from incomplete membership enumeration', async () => {
  const client = new FakeGroupsClient();
  client.enrollments = [{ OrgUnit: { Id: 11, Name: 'Course' } }];
  let result = await new StudentGroups(client).get('11');
  assert.equal(result.categories[0]!.ownMembership, 'not_enrolled');
  assert.equal(result.complete, true);
  assert.equal(client.calls.filter(call => call.path.includes('/groups/')).length, 0);
  client.incomplete.add('enrollments/myenrollments/');
  result = await new StudentGroups(client).get('11');
  assert.equal(result.categories[0]!.ownMembership, 'unknown');
  assert.equal(result.complete, false);
  assert.equal(result.membershipComplete, false);
});

test('category pagination retains known groups while marking overall coverage partial', async () => {
  const client = new FakeGroupsClient();
  client.incomplete.add('11/groupcategories/');
  const result = await new StudentGroups(client).get('11');
  assert.equal(result.myGroups.length, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.membershipComplete, false);
});

test('category permission denial is unavailable, never a successful no-groups result', async () => {
  const client = new FakeGroupsClient();
  client.failures.set('11/groupcategories/', new BrightspaceError('PERMISSION_DENIED', 'Group access denied.', { status: 403 }));
  const result = await new StudentGroups(client).get('11');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.complete, false);
  assert.equal(result.errors[0]!.code, 'PERMISSION_DENIED');
  assert.equal(result.errors[0]!.status, 403);
  assert.equal(client.calls.length, 1);
});

test('own membership denial preserves available category settings without guessing membership', async () => {
  const client = new FakeGroupsClient();
  client.failures.set('enrollments/myenrollments/', new BrightspaceError('PERMISSION_DENIED', 'Enrollment unavailable.'));
  const result = await new StudentGroups(client).get('11');
  assert.equal(result.categories.length, 1);
  assert.equal(result.categories[0]!.ownMembership, 'unknown');
  assert.equal(result.myGroups.length, 0);
  assert.equal(result.complete, false);
});

test('roster-free detail permission denial retains only proven own-enrollment metadata', async () => {
  const client = new FakeGroupsClient();
  client.failures.set('11/groupcategories/31/groups/41/noenrollments', new BrightspaceError('PERMISSION_DENIED', 'Details unavailable.'));
  const result = await new StudentGroups(client).get('11');
  assert.equal(result.myGroups[0]!.name, 'Team A');
  assert.equal(result.myGroups[0]!.membership, 'enrolled');
  assert.equal(result.myGroups[0]!.detailSource, 'own_enrollment');
  assert.equal(result.myGroups[0]!.description, null);
  assert.equal(result.myGroups[0]!.complete, false);
  assert.equal(result.membershipComplete, true);
  assert.equal(result.complete, false);
});

test('hidden group descriptions are not exposed despite unexpected server data', async () => {
  const client = new FakeGroupsClient();
  client.categories[0]!.DescriptionsVisibleToEnrolees = false;
  const result = await new StudentGroups(client).get('11');
  assert.equal(result.myGroups[0]!.description, null);
});

test('explicit category lookup and all target IDs are validated before requests', async () => {
  const client = new FakeGroupsClient(), groups = new StudentGroups(client);
  await assert.rejects(groups.get('../11'), { code: 'INVALID_ID' });
  await assert.rejects(groups.get('11', '31?other=1'), { code: 'INVALID_ID' });
  assert.equal(client.calls.length, 0);
  const result = await groups.get('11', '31');
  assert.equal(result.complete, true);
  assert.equal(client.calls[0]!.path, '11/groupcategories/31');
});

test('malformed group IDs, mismatched detail and missing group lists produce explicit incomplete results', async () => {
  const client = new FakeGroupsClient();
  client.categories[0]!.Groups = undefined;
  let result = await new StudentGroups(client).get('11');
  assert.equal(result.categories[0]!.ownMembership, 'unknown');
  assert.equal(result.categories[0]!.groupCount, null);
  assert.equal(result.errors[0]!.code, 'API_FORMAT_CHANGED');
  client.categories[0]!.Groups = [41];
  client.group = { GroupId: 999, Name: 'Someone else' };
  result = await new StudentGroups(client).get('11');
  assert.equal(result.myGroups[0]!.name, 'Team A');
  assert.equal(result.myGroups[0]!.complete, false);
  assert.ok(!JSON.stringify(result).includes('Someone else'));
});

test('empty categories require no membership or roster reads', async () => {
  const client = new FakeGroupsClient();
  client.categories = [];
  const result = await new StudentGroups(client).get('11');
  assert.equal(result.complete, true);
  assert.deepEqual(result.categories, []);
  assert.deepEqual(result.myGroups, []);
  assert.equal(client.calls.length, 1);
});

test('malformed omitted category never counts as complete membership coverage', async () => {
  const client = new FakeGroupsClient();
  client.categories = [{ Name: 'No ID', Groups: [] }];
  const result = await new StudentGroups(client).get('11');
  assert.equal(result.complete, false);
  assert.equal(result.membershipComplete, false);
  assert.equal(result.errors[0]!.code, 'API_FORMAT_CHANGED');
});

test('authentication failures and account switches propagate instead of appearing as empty membership', async () => {
  for (const code of ['AUTH_REQUIRED', 'ACCOUNT_CHANGED']) {
    const client = new FakeGroupsClient();
    client.failures.set('enrollments/myenrollments/', new BrightspaceError(code, 'Reconnect.'));
    await assert.rejects(new StudentGroups(client).get('11'), { code });
  }
});

test('unknown failures are sanitized and never expose transport details', async () => {
  const client = new FakeGroupsClient();
  client.failures.set('11/groupcategories/31/groups/41/noenrollments', new Error('Cookie: secret-value'));
  const result = await new StudentGroups(client).get('11');
  assert.equal(result.errors[0]!.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});
