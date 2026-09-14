import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Route } from 'playwright';
import type { BrowserReader } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { BrightspaceError } from '../src/errors.js';
import { GroupEnrollment, identifyGroupRpc, observeAvailableGroups } from '../src/group-enrollment.js';

const origin = 'https://brightspace.tudelft.nl';
const path = '/d2l/lms/group/user_available_group_list.d2l';
const url = origin + path + '?ou=11';
const handler = "function SelfEnroll(groupId){D2L.Rpc.Create('IsGroupFull', callback, '" + path
  + "').Call(groupId); D2L.Rpc.Create('EnrollUser', callback2, '" + path
  + "').Call(groupId);const next='/d2l/lms/group/user_group_list.d2l?ou=11';}";
function rpcBody(action = 'EnrollUser', id = '41') {
  return new URLSearchParams({ d2l_rf: action, params: '{"param1":' + id + '}', d2l_action: 'rpc',
    d2l_referrer: 'kept-private', d2l_hitcode: 'internal' }).toString();
}
function fixture() {
  const client = {
    config: loadConfig({}), account: '17', ownIds: [] as string[], complete: true,
    category: { GroupCategoryId: 31, Name: 'Project teams', Groups: [41, 42], EnrollmentStyle: 3,
      Description: { Text: 'Choose a team' }, SelfEnrollmentStartDate: null as string | null, SelfEnrollmentExpiryDate: null as string | null },
    async sessionIdentity() { return this.account; },
    async json(product: 'le' | 'lp', resource: string): Promise<unknown> {
      assert.equal(product, 'lp');
      if (resource === 'courses/11') return { Identifier: 11, Name: 'Mechanics', Code: 'ME101' };
      if (resource === '11/groupcategories/31') return structuredClone(this.category);
      throw new Error('Unexpected API detail request: ' + resource);
    },
    async list(product: 'le' | 'lp', resource: string) {
      assert.equal(product, 'lp');
      if (resource === '11/groupcategories/') return { items: [structuredClone(this.category)], complete: true };
      if (resource === 'enrollments/myenrollments/') return { items: this.ownIds.map(Id => ({ OrgUnit: { Id } })), complete: this.complete };
      throw new Error('Unexpected API list request: ' + resource);
    },
  };
  const native = {
    observation: { title: 'Groups', empty: false, validPage: true, truncated: false, handler, rows: [
      { name: 'Team A', categoryName: 'Project teams', members: '1/5', memberHandler: 'ViewMembers(41);return false;',
        joinHandler: 'SelfEnroll(41);return false;', disabled: false },
      { name: 'Team B', categoryName: 'Project teams', members: '5/5 (Full)', memberHandler: 'ViewMembers(42);return false;',
        joinHandler: '', disabled: false },
    ] },
    posts: [] as string[], aborted: 0, opened: 0, closed: 0, duplicateEnrollment: false, enrollmentFails: false,
    persistMembership: true, capacityStatus: 200, injectedGroup: undefined as string | undefined,
    lateEnrollment: false, deferredEnrollment: undefined as (() => Promise<void>) | undefined,
    beforeClick: undefined as (() => void) | undefined,
    async open(input: string) {
      assert.equal(input, url); this.opened++;
      let gate: ((route: Route) => Promise<void>) | undefined;
      const invoke = async (action: string, id: string) => {
        const route = {
          request: () => ({ method: () => 'POST', url: () => origin + path + 'file?ou=11&d2l_rh=handler&d2l_rt=call',
            postData: () => rpcBody(action, id) }),
          fetch: async (options: Record<string, unknown>) => {
            assert.equal(options.maxRetries, 0); assert.equal(options.maxRedirects, 0);
            this.posts.push(action);
            if (action === 'EnrollUser') {
              if (this.enrollmentFails) throw new Error('private transport detail');
              if (this.persistMembership) client.ownIds = [id];
            }
            return { status: () => action === 'IsGroupFull' ? this.capacityStatus : 200, dispose: async () => undefined };
          },
          fulfill: async () => undefined, fallback: async () => undefined,
          abort: async () => { this.aborted++; },
        };
        assert.ok(gate); await gate(route as unknown as Route);
      };
      return {
        page: { url: () => url, evaluate: async () => structuredClone(this.observation),
          waitForLoadState: async () => undefined,
          locator: (selector: string) => ({
            count: async () => selector === 'a[onclick="SelfEnroll(41);return false;"]' ? 1 : 0,
            isVisible: async () => true,
            click: async () => {
              this.beforeClick?.();
              await invoke('IsGroupFull', this.injectedGroup ?? '41');
              if (this.lateEnrollment) { this.deferredEnrollment = () => invoke('EnrollUser', '41'); return; }
              if (this.duplicateEnrollment) await Promise.all([invoke('EnrollUser', '41'), invoke('EnrollUser', '41')]);
              else await invoke('EnrollUser', this.injectedGroup ?? '41');
            },
          }),
        },
        context: { route: async (_pattern: string, callback: (route: Route) => Promise<void>) => { gate = callback; } },
        close: async () => { this.closed++; },
      };
    },
  };
  const actions = new GroupEnrollment(client, native as unknown as Pick<BrowserReader, 'open'>);
  return { client, native, actions };
}

test('native discovery maps exact categories and capacity without exposing roster controls or performing a write', async () => {
  const { native, actions } = fixture(), result = await actions.list('11');
  assert.equal(result.complete, true);
  assert.equal(result.groups[0]?.joinable, true);
  assert.equal(result.groups[0]?.availablePlaces, 4);
  assert.equal(result.groups[1]?.reason, 'full');
  assert.equal(result.groups[0]?.categoryId, '31');
  assert.equal(native.posts.length, 0);
  assert.equal(native.opened, native.closed);
  for (const value of ['ViewMembers', 'SelfEnroll', 'handlerFingerprint', 'kept-private']) assert.ok(!JSON.stringify(result).includes(value));
});

test('native DOM inspection reads group identifiers without invoking member or enrollment handlers', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><title>Groups</title><main><h2>Available Groups</h2>'
      + '<form method="post" action="user_available_group_list.d2l?ou=11"><table>'
      + '<tr><td colspan="4"><label>Project teams</label></td></tr><tr><td><label>Team A</label></td><td></td>'
      + '<td><a onclick="ViewMembers(41);return false;">1/5</a></td>'
      + '<td><a onclick="SelfEnroll(41);return false;">Join Group</a></td></tr></table></form></main>'
      + '<script>window.memberCalls=0; function ViewMembers(){window.memberCalls++};' + handler + '</script>' }));
    await page.goto(url);
    const result = await observeAvailableGroups(page, origin, '11');
    assert.equal(result.validPage, true);
    assert.equal(result.rows[0]?.name, 'Team A');
    assert.equal(result.rows[0]?.joinHandler, 'SelfEnroll(41);return false;');
    assert.equal(await page.evaluate(() => (window as unknown as { memberCalls: number }).memberCalls), 0);
    await assert.rejects(observeAvailableGroups(page, origin, '12'), { code: 'COURSE_CHANGED' });
    await page.setContent('<main><h2>Available Groups</h2><form method="post" action="user_available_group_list.d2l?ou=11">'
      + '<d2l-empty-state-simple></d2l-empty-state-simple></form></main>');
    await page.locator('d2l-empty-state-simple').evaluate(element => {
      element.attachShadow({ mode: 'open' }).textContent = 'No items found.';
    });
    const empty = await observeAvailableGroups(page, origin, '11');
    assert.equal(empty.empty, true); assert.equal(empty.validPage, true); assert.equal(empty.rows.length, 0);
  } finally { await browser.close(); }
});

test('a recognized empty native page is complete and distinguishes no available groups from a format error', async () => {
  const { native, client, actions } = fixture();
  native.observation.rows = []; native.observation.empty = true; client.ownIds = ['41'];
  const result = await actions.list('11');
  assert.equal(result.complete, true); assert.equal(result.status, 'complete'); assert.equal(result.groups.length, 0);
  assert.deepEqual(result.categories[0]?.ownGroupIds, ['41']);
  assert.equal(native.posts.length, 0);
});

test('preview is account-bound, reserves no place, and mutation of returned target cannot change enrollment', async () => {
  const { native, actions } = fixture(), preview = await actions.prepare('11', '41', '31');
  assert.equal(preview.accountId, '17');
  assert.equal(preview.target.name, 'Team A');
  assert.match(preview.confirmationRequired, /No place is reserved/);
  assert.equal(native.posts.length, 0);
  preview.target.id = '42'; preview.target.name = 'Altered';
  await assert.rejects(actions.confirm(preview.confirmationToken), { code: 'CONFIRMATION_REQUIRED' });
  const result = await actions.confirm(preview.confirmationToken, true);
  assert.equal(result.status, 'enrolled'); assert.equal(result.groupId, '41'); assert.equal(result.groupName, 'Team A');
  assert.deepEqual(native.posts, ['IsGroupFull', 'EnrollUser']);
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
});

test('full groups, malformed capacity, future/expired dates and own existing membership block previews', async () => {
  const { native, client, actions } = fixture();
  await assert.rejects(actions.prepare('11', '42'), { code: 'GROUP_NOT_JOINABLE' });
  for (const members of ['999999999999999999999/5', '6/5', 'unknown', '1/0']) {
    native.observation.rows[0]!.members = members;
    await assert.rejects(actions.prepare('11', '41'), { code: 'GROUP_NOT_JOINABLE' });
  }
  native.observation.rows[0]!.members = '1/5';
  client.category.SelfEnrollmentStartDate = '2999-01-01T00:00:00Z';
  await assert.rejects(actions.prepare('11', '41'), { code: 'GROUP_NOT_JOINABLE' });
  client.category.SelfEnrollmentStartDate = null; client.category.SelfEnrollmentExpiryDate = '2000-01-01T00:00:00Z';
  await assert.rejects(actions.prepare('11', '41'), { code: 'GROUP_NOT_JOINABLE' });
  client.category.SelfEnrollmentExpiryDate = 'invalid';
  await assert.rejects(actions.prepare('11', '41'), { code: 'GROUP_NOT_JOINABLE' });
  client.category.SelfEnrollmentExpiryDate = null; client.ownIds = ['42'];
  await assert.rejects(actions.prepare('11', '41'), { code: 'GROUP_NOT_JOINABLE' });
  assert.equal(native.posts.length, 0);
});

test('incomplete membership, mismatched category and changed native controls never produce an actionable preview', async () => {
  const { client, native, actions } = fixture();
  client.complete = false;
  await assert.rejects(actions.prepare('11', '41'), { code: 'GROUP_ENROLLMENT_UNVERIFIED' });
  client.complete = true; native.observation.rows[0]!.categoryName = 'Wrong category';
  await assert.rejects(actions.prepare('11', '41'), { code: 'GROUP_ENROLLMENT_UNVERIFIED' });
  native.observation.rows[0]!.categoryName = 'Project teams'; native.observation.handler = 'function unexpected() {}';
  await assert.rejects(actions.prepare('11', '41'), { code: 'GROUP_NOT_JOINABLE' });
  await assert.rejects(actions.prepare('../11', '41'), { code: 'INVALID_ID' });
  assert.equal(native.posts.length, 0);
});

test('changed account, session invalidation and stale group metadata consume previews without enrollment', async () => {
  const { client, native, actions } = fixture();
  const first = await actions.prepare('11', '41'); client.account = '18';
  await assert.rejects(actions.confirm(first.confirmationToken, true), { code: 'ACCOUNT_CHANGED' });
  client.account = '17';
  const second = await actions.prepare('11', '41'); client.category.Description.Text = 'Different group requirements';
  await assert.rejects(actions.confirm(second.confirmationToken, true), { code: 'PREVIEW_STALE' });
  const third = await actions.prepare('11', '41'); actions.close();
  await assert.rejects(actions.confirm(third.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  const fourth = await actions.prepare('11', '41'); native.beforeClick = () => actions.close();
  await assert.rejects(actions.confirm(fourth.confirmationToken, true), { code: 'GROUP_ENROLLMENT_NOT_SENT' });
  assert.equal(native.posts.length, 0);
});

test('concurrent confirmation and duplicate native enrollment requests each send at most once', async () => {
  const { native, actions } = fixture(); native.duplicateEnrollment = true;
  const preview = await actions.prepare('11', '41');
  const result = await Promise.allSettled([actions.confirm(preview.confirmationToken, true), actions.confirm(preview.confirmationToken, true)]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(native.posts.filter(item => item === 'EnrollUser').length, 1);
  assert.ok(native.aborted >= 1);
});

test('changed own membership or capacity blocks confirmation, while occupancy changes preserve the chosen group', async () => {
  const { native, client, actions } = fixture();
  const first = await actions.prepare('11', '41'); client.ownIds = ['42'];
  await assert.rejects(actions.confirm(first.confirmationToken, true), { code: 'GROUP_NOT_JOINABLE' });
  client.ownIds = [];
  const second = await actions.prepare('11', '41'); native.observation.rows[0]!.members = '1/6';
  await assert.rejects(actions.confirm(second.confirmationToken, true), { code: 'PREVIEW_STALE' });
  native.observation.rows[0]!.members = '1/5';
  const third = await actions.prepare('11', '41'); native.observation.rows[0]!.members = '3/5';
  assert.equal((await actions.confirm(third.confirmationToken, true)).status, 'enrolled');
  assert.equal(native.posts.filter(item => item === 'EnrollUser').length, 1);
});

test('expired previews cannot send a native enrollment request', async (t) => {
  const { native, actions } = fixture(), preview = await actions.prepare('11', '41');
  t.mock.method(Date, 'now', () => Date.parse(preview.expiresAt) + 1);
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  assert.equal(native.posts.length, 0);
});

test('an HTTP 200 enrollment response without observed membership remains outcome unknown', async () => {
  const { native, actions } = fixture(); native.persistMembership = false;
  const preview = await actions.prepare('11', '41');
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'GROUP_ENROLLMENT_OUTCOME_UNKNOWN' });
  assert.equal(native.posts.filter(item => item === 'EnrollUser').length, 1);
});

test('wrong RPC target and failed capacity check never send enrollment', async () => {
  const { native, actions } = fixture(); native.injectedGroup = '42';
  const first = await actions.prepare('11', '41');
  await assert.rejects(actions.confirm(first.confirmationToken, true), { code: 'GROUP_ENROLLMENT_NOT_SENT' });
  assert.equal(native.posts.length, 0);
  native.injectedGroup = undefined; native.capacityStatus = 500;
  const second = await actions.prepare('11', '41');
  await assert.rejects(actions.confirm(second.confirmationToken, true), { code: 'GROUP_ENROLLMENT_NOT_SENT' });
  assert.deepEqual(native.posts, ['IsGroupFull']);
});

test('late native callbacks cannot send enrollment after the action reports no request sent', async () => {
  const { native, actions } = fixture(); native.lateEnrollment = true;
  const preview = await actions.prepare('11', '41');
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'GROUP_ENROLLMENT_NOT_SENT' });
  assert.ok(native.deferredEnrollment); await native.deferredEnrollment();
  assert.deepEqual(native.posts, ['IsGroupFull']);
});

test('uncertain enrollment is sanitized, never retried and never reported successful without membership', async () => {
  const { native, actions } = fixture(); native.enrollmentFails = true;
  const preview = await actions.prepare('11', '41');
  await assert.rejects(actions.confirm(preview.confirmationToken, true), (error: unknown) => {
    assert.ok(error instanceof BrightspaceError);
    assert.equal(error.code, 'GROUP_ENROLLMENT_OUTCOME_UNKNOWN'); assert.match(error.message, /Do not retry/);
    assert.ok(!error.message.includes('private transport')); return true;
  });
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  assert.equal(native.posts.filter(item => item === 'EnrollUser').length, 1);
});

test('native RPC identification rejects duplicates, extra arguments, wrong actions and cross-course targets', () => {
  const rpcUrl = origin + path + 'file?ou=11&d2l_rh=x&d2l_rt=call';
  assert.equal(identifyGroupRpc(rpcUrl, 'POST', rpcBody(), origin, '11', '41'), 'enroll');
  assert.equal(identifyGroupRpc(rpcUrl, 'POST', rpcBody('IsGroupFull'), origin, '11', '41'), 'capacity');
  for (const body of [rpcBody() + '&d2l_rf=EnrollUser', rpcBody() + '&params=%7B%22param1%22%3A42%7D',
    rpcBody() + '&d2l_action=rpc', rpcBody('DeleteGroup'), rpcBody('EnrollUser', '42'),
    rpcBody().replace(encodeURIComponent('{"param1":41}'), encodeURIComponent('{"param1":41,"param1":42}'))]) {
    assert.equal(identifyGroupRpc(rpcUrl, 'POST', body, origin, '11', '41'), undefined);
  }
  for (const target of [rpcUrl + '&ou=12', rpcUrl.replace('ou=11', 'ou=12'), rpcUrl.replace(origin, 'https://evil.example')]) {
    assert.equal(identifyGroupRpc(target, 'POST', rpcBody(), origin, '11', '41'), undefined);
  }
  assert.equal(identifyGroupRpc(rpcUrl, 'GET', rpcBody(), origin, '11', '41'), undefined);
});
