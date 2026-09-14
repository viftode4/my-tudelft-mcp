import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { chromium, type Route } from 'playwright';
import type { BrowserReader } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { TextSubmissionActions, observeTextSubmissionForm, textSubmissionFormFields, textSubmissionHtml } from '../src/text-submissions.js';

const origin = 'https://brightspace.tudelft.nl';
const formPath = '/d2l/lms/dropbox/user/folder_submit_files.d2l';
const fieldNames = ['d2l_action', 'd2l_actionparam', 'd2l_hitCode', 'd2l_rf', 'd2l_controlMapPrev',
  'confMessage', 'confWarning', 'dropboxId', 'hasStartedSubmission', 'REDT_comments$id',
  'REDT_comments$htmlOrgUnitId', 'REDT_comments$html', 'REDT_comments_hc', 'd2l_controlMap', 'd2l_state', 'd2l_referrer'];
const handlers = ["function Upload(){Nav.SubmitAction( 'Update' );}", 'function DoUpload(){Upload();}', 'function DoOverwrite(){DoUpload();}'];
const boundary = '----NativeBoundary';
const contentType = 'multipart/form-data; boundary=' + boundary;
const lineEndings = (text: string) => text.replace(/\r\n|\r|\n/g, '\r\n');
function multipart(fields: [string, string][]) {
  return Buffer.from(fields.map(([key, value]) => '--' + boundary + '\r\nContent-Disposition: form-data; name="'
    + key + '"\r\n\r\n' + value + '\r\n').join('') + '--' + boundary + '--\r\n');
}

function fixture(group = false) {
  const client = {
    config: loadConfig({}), account: '17', ownGroups: ['41'], membershipComplete: true,
    folder: { Id: 21, Name: 'Reflection', SubmissionType: 1, DropboxType: group ? 1 : 2,
      GroupTypeId: group ? 31 : null, Availability: null as unknown, DueDate: 'invalid', SubmissionRule: 0 },
    submissions: [] as Array<{ Id: number; SubmittedBy: { Id: string }; Comment: { Html: string; Text: string }; SubmissionDate: string }>,
    receiptActor: '17', receiptEntity: undefined as string | undefined, receiptText: undefined as string | undefined,
    identityHook: undefined as (() => void) | undefined,
    async sessionIdentity() { this.identityHook?.(); return this.account; },
    async json(product: 'le' | 'lp', resource: string): Promise<unknown> {
      if (product === 'lp' && resource === 'courses/11') return { Identifier: 11, Name: 'Mechanics', Code: 'ME101' };
      if (product === 'le' && resource === '11/dropbox/folders/21') return structuredClone(this.folder);
      if (product === 'le' && resource === '11/dropbox/folders/21/submissions/mysubmissions/') return [
        { Entity: { EntityType: group ? 'Group' : 'User', EntityId: this.receiptEntity ?? (group ? '41' : this.account) },
          Submissions: structuredClone(this.submissions) },
      ];
      if (product === 'lp' && resource === '11/groupcategories/31') return { GroupCategoryId: 31, Name: 'Project teams', Groups: [41, 42] };
      if (product === 'lp' && resource === '11/groupcategories/31/groups/41/noenrollments') return { GroupId: 41, Name: 'Team A' };
      throw new Error('Unexpected API request: ' + resource);
    },
    async list(product: 'le' | 'lp', resource: string) {
      assert.equal(product, 'lp'); assert.equal(resource, 'enrollments/myenrollments/');
      return { items: this.ownGroups.map(Id => ({ OrgUnit: { Id, Name: 'Own group' } })), complete: this.membershipComplete };
    },
  };
  const url = origin + formPath + '?db=21&grpid=' + (group ? '41' : '0') + '&isprv=0&bp=0&ou=11';
  const native = {
    url, observation: { editor: true, action: url, method: 'post', folderId: '21', editorCourse: '11', fields: [...fieldNames],
      fileInputs: 0, maxLength: 1_048_575, button: 'Submit', hasConfirm: false, single: false, textAndFile: false, handlers: [...handlers] },
    opened: 0, closed: 0, posts: 0, conversions: 0, aborted: 0, edits: 0, yesClicks: 0,
    bootstrapBodies: [] as string[], bootstrapSent: [] as string[],
    duplicate: false, transportFailure: false, persistReceipt: true, mutateHtml: false, mutateTarget: false, extraField: false,
    redirect: false, conversionQuery: '?ou=11', late: false, deferred: undefined as (() => Promise<void>) | undefined,
    beforePost: undefined as (() => void) | undefined,
    async open(input: string) {
      assert.equal(input, origin + '/d2l/lms/dropbox/user/folders_list.d2l?ou=11'); this.opened++;
      let gate: ((route: Route) => Promise<void>) | undefined, html = '', confirmationsLeft = 0;
      const invoke = async (conversion: boolean) => {
        const fields: [string, string][] = fieldNames.map(key => [key, 'internal-state']);
        for (const [key, value] of [['d2l_action', 'Update'], ['dropboxId', this.mutateTarget ? '999' : '21'],
          ['REDT_comments$htmlOrgUnitId', '11'], ['REDT_comments$html', lineEndings(this.mutateHtml ? html + 'changed' : html)]]) {
          fields.find(item => item[0] === key)![1] = value!;
        }
        if (this.extraField) fields.push(['unexpectedTarget', '42']);
        const body = conversion ? Buffer.from(new URLSearchParams({ html, filterMode: 'default', isXhr: 'true', requestId: '1', d2l_referrer: 'private' }).toString())
          : multipart(fields);
        const route = {
          request: () => ({ method: () => 'POST', url: () => conversion ? origin + '/d2l/lp/htmleditor/converttoabsolute' + this.conversionQuery : url,
            postData: () => body.toString(), postDataBuffer: () => body,
            headers: () => ({ 'content-type': conversion ? 'application/x-www-form-urlencoded' : contentType }), isNavigationRequest: () => !conversion }),
          fetch: async (options: Record<string, unknown>) => {
            assert.equal(options.maxRedirects, 0); assert.equal(options.maxRetries, 0);
            if (conversion) this.conversions++;
            else {
              this.posts++;
              if (this.transportFailure) throw new Error('private-session-secret');
              if (this.persistReceipt) client.submissions.push({ Id: 100, SubmittedBy: { Id: client.receiptActor },
                Comment: { Html: client.receiptText ?? html, Text: '' }, SubmissionDate: '2026-09-14T10:00:00Z' });
            }
            return { status: () => this.redirect ? 302 : 200, dispose: async () => undefined };
          },
          fulfill: async () => undefined, fallback: async () => undefined, abort: async () => { this.aborted++; },
        };
        assert.ok(gate); await gate(route as unknown as Route);
      };
      const send = async () => {
        this.beforePost?.();
        if (this.late) { this.deferred = () => invoke(false); return; }
        if (this.duplicate) await Promise.all([invoke(false), invoke(false)]);
        else await invoke(false);
      };
      return {
        page: {
          url: () => url,
          goto: async () => {
            for (const body of this.bootstrapBodies) {
              const route = {
                request: () => ({ method: () => 'POST', url: () => origin + '/d2l/api/oslo/batch', postData: () => body, isNavigationRequest: () => false }),
                fetch: async (options: { postData: string; maxRedirects: number; maxRetries: number }) => {
                  assert.equal(options.maxRedirects, 0); assert.equal(options.maxRetries, 0); this.bootstrapSent.push(options.postData);
                  return { status: () => 200, dispose: async () => undefined };
                },
                fulfill: async () => undefined, abort: async () => { this.aborted++; },
              };
              assert.ok(gate); await gate(route as unknown as Route);
            }
          },
          waitForLoadState: async () => undefined,
          locator: () => ({ evaluateAll: async () => [url] }),
          evaluate: async (_callback: unknown, value?: string) => {
            if (value === undefined) return structuredClone(this.observation);
            this.edits++; html = value; await invoke(true);
          },
          getByRole: (_role: string, options: { name: string }) => ({
            count: async () => 1,
            click: async () => {
              if (options.name !== 'Yes') {
                confirmationsLeft = Number(this.observation.button === 'Overwrite') + Number(this.observation.single);
                if (!confirmationsLeft) await send();
              } else { this.yesClicks++; if (--confirmationsLeft === 0) await send(); }
            },
          }),
          getByText: () => ({ waitFor: async () => undefined, count: async () => 1 }),
        },
        context: { route: async (_pattern: string, callback: (route: Route) => Promise<void>) => { gate = callback; } },
        close: async () => { this.closed++; },
      };
    },
  };
  const actions = new TextSubmissionActions(client, native as unknown as Pick<BrowserReader, 'open'>);
  return { client, native, actions };
}

test('text is literal and bounded, and preview performs no editor changes or submission', async () => {
  const { actions, native, client } = fixture(), text = '<script>x</script>\n  "quote" & \'value\'\r\n';
  client.folder.Availability = { StartDate: 'bad', EndDate: '2026-10-01T00:00:00Z', AccessToken: 'private-secret' };
  const preview = await actions.prepare('11', '21', text);
  assert.equal(preview.text, text); assert.equal(preview.bytes, Buffer.byteLength(text));
  assert.equal(preview.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(preview.dueDate, null); assert.equal(preview.availability.startDate, null);
  assert.equal(preview.overwritesPrevious, false); assert.equal(preview.affectsGroup, false);
  assert.ok(!JSON.stringify(preview).includes('private-secret'));
  assert.equal(native.posts, 0); assert.equal(native.edits, 0); assert.equal(native.opened, native.closed);
  assert.equal(textSubmissionHtml('<a>&"\''), '<pre>&lt;a&gt;&amp;&quot;&#39;</pre>');
  for (const invalid of ['', '   ', '\0', 'x'.repeat(256 * 1024 + 1)]) assert.throws(() => textSubmissionHtml(invalid), { code: 'INVALID_TEXT' });
  actions.close();
});

test('native form inspection sees the external action bar and actual Chromium CRLF multipart serialization', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), url = origin + formPath + '?db=21&grpid=0&isprv=0&bp=0&ou=11';
    let posted: Map<string, string> | undefined;
    await page.route('**/*', async route => {
      if (route.request().method() === 'POST') {
        posted = textSubmissionFormFields(route.request().postDataBuffer()!, route.request().headers()['content-type']!);
        await route.abort(); return;
      }
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><form id="native" method="post" enctype="multipart/form-data" action="' + url + '">'
        + '<d2l-htmleditor id="REDT_comments" max-length="1048575"></d2l-htmleditor>'
        + fieldNames.map(name => '<input type="hidden" name="' + name + '" value="' + (name === 'dropboxId' ? '21' : name === 'REDT_comments$htmlOrgUnitId' ? '11' : '') + '">').join('')
        + '</form><button form="native" type="submit">Submit</button><script>window.hasConfirm=false;window.hasSingleFileConfirm=false;window.isTextFileSubmission=false;'
        + handlers.join(';') + '</script>' });
    });
    await page.goto(url);
    assert.equal((await observeTextSubmissionForm(page, origin, '11', '21', '0')).button, 'Submit');
    const text = 'line 1\nline 2\r\nline 3\rlast <tag>';
    await page.locator('input[name="REDT_comments$html"]').evaluate((element, html) => { (element as HTMLInputElement).value = html; }, textSubmissionHtml(text));
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    assert.equal(posted?.get('REDT_comments$html'), lineEndings(textSubmissionHtml(text)));
  } finally { await browser.close(); }
});

test('preview bootstrap permits only the observed editor resources and sends canonical validated JSON', async () => {
  const { actions, native } = fixture();
  native.bootstrapBodies = [
    '{"resources":["/@d2l/htmleditor/htmleditor"]}',
    '{"resources":["/unrelated/action"],"resources":["/@d2l/htmleditor/htmleditor"]}',
    '{"resources":["/@d2l/htmleditor/htmleditor"],"action":"submit"}',
    '{"resources":["/@d2l/htmleditor/htmleditor","/@d2l/unobserved/resource"]}',
  ];
  await actions.prepare('11', '21', 'Answer');
  assert.deepEqual(native.bootstrapSent, [
    '{"resources":["/@d2l/htmleditor/htmleditor"]}', '{"resources":["/@d2l/htmleditor/htmleditor"]}',
  ]);
  assert.equal(native.aborted, 2); assert.equal(native.posts, 0); assert.equal(native.edits, 0);
  actions.close();
});

test('multipart parser rejects duplicated fields, uploaded files, malformed boundaries and oversized bodies', () => {
  assert.equal(textSubmissionFormFields(multipart([['a', 'one'], ['a', 'two']]), contentType), undefined);
  assert.equal(textSubmissionFormFields(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\nx\r\n--' + boundary + '--\r\n'), contentType), undefined);
  assert.equal(textSubmissionFormFields(multipart([['a', 'one']]), 'application/json'), undefined);
  assert.equal(textSubmissionFormFields(Buffer.alloc(2 * 1024 * 1024 + 1), contentType), undefined);
});

test('the stateless native converter is limited to the exact approved course query', async () => {
  for (const query of ['', '?ou=999', '?ou=11&ou=999', '?ou=11&action=Update']) {
    const { actions, native } = fixture(), preview = await actions.prepare('11', '21', 'Answer');
    native.conversionQuery = query;
    // The mock still produces the exact approved multipart body; only the unscoped helper is blocked.
    await actions.confirm(preview.confirmationToken, true);
    assert.equal(native.conversions, 0); assert.equal(native.aborted, 1);
  }
});

test('confirmation requires explicit preview approval and a token can send once despite concurrent native POSTs', async () => {
  const { actions, native } = fixture(), preview = await actions.prepare('11', '21', 'line 1\nline 2');
  await assert.rejects(actions.confirm(preview.confirmationToken), { code: 'CONFIRMATION_REQUIRED' });
  native.duplicate = true;
  const receipt = await actions.confirm(preview.confirmationToken, true);
  assert.equal(receipt.status, 'submitted'); assert.equal(receipt.receipt.id, '100');
  assert.equal(native.posts, 1); assert.equal(native.conversions, 1); assert.equal(native.aborted, 1);
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  assert.equal(native.opened, native.closed);
});

test('known overwrite and one-submission effects are previewed and both native confirmations complete', async () => {
  const { actions, native } = fixture();
  native.observation.button = 'Overwrite'; native.observation.single = true;
  const preview = await actions.prepare('11', '21', 'Approved answer');
  assert.equal(preview.overwritesPrevious, true); assert.equal(preview.onlyOneSubmission, true);
  await actions.confirm(preview.confirmationToken, true);
  assert.equal(native.yesClicks, 2); assert.equal(native.posts, 1);
});

test('group text previews require exact own membership and bind the group without returning peer history', async () => {
  const { actions, native, client } = fixture(true);
  client.submissions.push({ Id: 90, SubmittedBy: { Id: 'peer-private' }, Comment: { Html: 'peer answer', Text: '' }, SubmissionDate: '2026-01-01' });
  await assert.rejects(actions.prepare('11', '21', 'Answer'), { code: 'GROUP_SELECTION_REQUIRED' });
  await assert.rejects(actions.prepare('11', '21', 'Answer', '42'), { code: 'GROUP_MEMBERSHIP_UNVERIFIED' });
  const preview = await actions.prepare('11', '21', 'Answer', '41');
  assert.equal(preview.affectsGroup, true); assert.equal(preview.target.group?.id, '41'); assert.equal(preview.previousSubmissionCount, 1);
  assert.ok(!JSON.stringify(preview).includes('peer'));
  preview.target.group!.id = '42';
  const receipt = await actions.confirm(preview.confirmationToken, true);
  assert.equal(receipt.group?.id, '41'); assert.equal(native.posts, 1);
});

test('lost or incomplete group membership prevents confirmed submission', async () => {
  for (const incomplete of [false, true]) {
    const { actions, native, client } = fixture(true), preview = await actions.prepare('11', '21', 'Answer', '41');
    if (incomplete) client.membershipComplete = false; else client.ownGroups = [];
    await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'GROUP_MEMBERSHIP_UNVERIFIED' });
    assert.equal(native.posts, 0);
  }
});

test('account, assignment rules, history and native form changes each invalidate a preview', async () => {
  for (const change of ['account', 'rule', 'history', 'form']) {
    const { actions, native, client } = fixture(), preview = await actions.prepare('11', '21', 'Answer');
    if (change === 'account') client.account = '18';
    if (change === 'rule') client.folder.SubmissionRule = 1;
    if (change === 'history') client.submissions.push({ Id: 90, SubmittedBy: { Id: '17' }, Comment: { Html: 'new', Text: '' }, SubmissionDate: 'today' });
    if (change === 'form') native.observation.single = true;
    await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: change === 'account' ? 'ACCOUNT_CHANGED' : 'PREVIEW_STALE' });
    assert.equal(native.posts, 0);
  }
});

test('expiry and close invalidate pending previews', async () => {
  const { actions, native } = fixture(), preview = await actions.prepare('11', '21', 'Answer');
  const original = Date.now;
  try { Date.now = () => original() + 6 * 60 * 1000; await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' }); }
  finally { Date.now = original; }
  const second = await actions.prepare('11', '21', 'Answer'); actions.close();
  await assert.rejects(actions.confirm(second.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  assert.equal(native.posts, 0);
});

test('changed text, target IDs and unfamiliar body fields cannot pass the native request gate', async () => {
  for (const change of ['html', 'target', 'field']) {
    const { actions, native } = fixture(), preview = await actions.prepare('11', '21', 'Answer');
    if (change === 'html') native.mutateHtml = true;
    if (change === 'target') native.mutateTarget = true;
    if (change === 'field') native.extraField = true;
    await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'TEXT_SUBMISSION_NOT_SENT' });
    assert.equal(native.posts, 0);
  }
});

test('a session change or close immediately before the native POST prevents any mutation', async () => {
  for (const close of [false, true]) {
    const { actions, native, client } = fixture(), preview = await actions.prepare('11', '21', 'Answer');
    native.beforePost = () => { if (close) actions.close(); else client.account = '18'; };
    await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'TEXT_SUBMISSION_NOT_SENT' });
    assert.equal(native.posts, 0);
  }
});

test('late native callbacks cannot send after a not-sent result', async () => {
  const { actions, native } = fixture(), preview = await actions.prepare('11', '21', 'Answer');
  native.late = true;
  await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'TEXT_SUBMISSION_NOT_SENT' });
  await native.deferred!();
  assert.equal(native.posts, 0);
});

test('transport failure or missing exact receipt reports outcome unknown without retries or private errors', async () => {
  for (const failure of ['transport', 'missing', 'actor', 'text', 'entity', 'redirect']) {
    const { actions, native, client } = fixture(true), preview = await actions.prepare('11', '21', 'Answer', '41');
    if (failure === 'transport') native.transportFailure = true;
    if (failure === 'missing') native.persistReceipt = false;
    if (failure === 'actor') client.receiptActor = 'peer';
    if (failure === 'text') client.receiptText = 'different';
    if (failure === 'entity') native.beforePost = () => { client.receiptEntity = '42'; };
    if (failure === 'redirect') { native.redirect = true; native.persistReceipt = false; }
    await assert.rejects(actions.confirm(preview.confirmationToken, true), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'TEXT_SUBMISSION_OUTCOME_UNKNOWN');
      assert.ok(!String(error).includes('private-session-secret')); return true;
    });
    assert.equal(native.posts, 1);
    await assert.rejects(actions.confirm(preview.confirmationToken, true), { code: 'INVALID_PREVIEW' });
  }
});

test('CRLF receipt equivalence preserves original text hash and rejects any substantive text change', async () => {
  const { actions, client } = fixture(), text = 'first\nsecond\r\nthird\rlast';
  const preview = await actions.prepare('11', '21', text);
  client.receiptText = lineEndings(textSubmissionHtml(text));
  const result = await actions.confirm(preview.confirmationToken, true);
  assert.equal(result.sha256, preview.sha256);
});

test('unsupported file-or-text assignments, wrong native targets and unknown confirmations fail closed', async () => {
  for (const change of ['type', 'folder', 'course', 'confirmation', 'duplicateFields']) {
    const { actions, client, native } = fixture();
    if (change === 'type') client.folder.SubmissionType = 4;
    if (change === 'folder') native.observation.folderId = '999';
    if (change === 'course') native.observation.editorCourse = '999';
    if (change === 'confirmation') native.observation.hasConfirm = true;
    if (change === 'duplicateFields') native.observation.fields.push('dropboxId');
    await assert.rejects(actions.prepare('11', '21', 'Answer'));
    assert.equal(native.posts, 0); assert.equal(native.edits, 0); assert.equal(native.opened, native.closed);
  }
});
