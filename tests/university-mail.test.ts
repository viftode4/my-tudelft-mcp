import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { UniversityMail, PowerShellMailWorker, matchMailIdentity, mailLoginDiagnostic, mailLoginPrompt, mailBrowserCommand, type MailWorker } from '../src/university-mail.js';
import { BrightspaceError, safeError } from '../src/errors.js';

const account = { id: '11111111-1111-1111-1111-111111111111', tenantId: '22222222-2222-2222-2222-222222222222', userPrincipalName: 'teststudent@tudelft.nl', mail: 't.student@student.tudelft.nl', displayName: 'Test Student' };
const student = { accountId: '123', uniqueName: 'teststudent', emails: ['t.student@student.tudelft.nl'] };

test('browser prompt rejects arbitrary URLs and commands on every platform', () => {
  assert.equal(mailLoginPrompt({ verificationUrl: 'https://evil.example', userCode: 'ABC123XYZ' }), undefined);
  assert.equal(mailLoginPrompt({ verificationUrl: 'https://microsoft.com/devicelogin', userCode: 'x;calc' }), undefined);
  for (const platform of ['win32', 'darwin', 'linux']) {
    const [command, args] = mailBrowserCommand(platform);
    assert.equal(command, { win32: 'powershell.exe', darwin: 'open', linux: 'xdg-open' }[platform]);
    assert.ok(args.join(' ').includes('https://microsoft.com/devicelogin'));
  }
});

test('login prompt opens once, is exposed while waiting and cleared on logout; stale events are ignored', async () => {
  let opened = 0;
  const worker: MailWorker = { request: async () => new Promise(() => {}), close: async () => {} };
  const client: any = { config: {}, sessionIdentity: async () => '123', json: async () => ({ Identifier: '123', UniqueName: student.uniqueName }) };
  const mail = new UniversityMail(client, { workerFactory: async () => worker, openBrowser: () => { opened++; } });
  mail.beginLogin();
  await new Promise(resolve => setImmediate(resolve));
  const prompt = { verificationUrl: 'https://microsoft.com/devicelogin', userCode: 'ABC123XYZ' };
  worker.onLoginPrompt!(prompt); worker.onLoginPrompt!(prompt);
  assert.equal(opened, 1);
  assert.equal(mail.loginStatus().userCode, prompt.userCode);
  await mail.logout(); worker.onLoginPrompt!(prompt);
  assert.equal(mail.loginStatus().state, 'idle');
  assert.equal(mail.loginStatus().userCode, undefined);
  assert.equal(opened, 1);
});
test('login diagnostics emit only fixed classifications and allowlisted AADSTS references', () => {
  assert.deepEqual(mailLoginDiagnostic({ stage: 'sdk_login', reason: 'window_handle_required', exceptionType: 'Microsoft.Identity.Client.MsalClientException', aadsts: 'AADSTS65001', token: 'secret', message: 'secret' }), { stage: 'sdk_login', reason: 'window_handle_required', exceptionType: 'Microsoft.Identity.Client.MsalClientException', aadsts: 'AADSTS65001' });
  assert.deepEqual(mailLoginDiagnostic({ stage: 'sdk_login', reason: 'secret', exceptionType: 'secret', aadsts: 'AADSTS65001 secret' }), { stage: 'sdk_login', reason: 'unclassified', exceptionType: 'other' });
  assert.equal(mailLoginDiagnostic({ stage: 'secret' }), undefined);
});
const email = { id: 'message1', subject: 'Course update', from: { emailAddress: { name: 'Course team', address: 'course@example.org' } }, body: { contentType: 'text', content: 'A course update.' }, isDraft: false, webLink: 'https://outlook.office.com/mail/id/message1' };
type Callback = (op: string, args: any) => unknown | Promise<unknown>;
function fixture(callback?: Callback) {
  let current: string | undefined = '123';
  const calls: Array<{ op: string; args: any }> = [];
  let closed = 0;
  const worker: MailWorker = { request: async (op, args) => { calls.push({ op, args }); return await callback?.(op, args) ?? { identity: account, data: op === 'read' ? email : op === 'prepareReply' ? { permit: 'a'.repeat(32) } : op === 'createReply' ? { ...email, id: 'draft1', isDraft: true, bodyVerified: true, recipientsVerified: true, parentMessageId: 'message1', body: { contentType: 'text', content: 'My reply.' } } : { value: [] } }; }, close: async () => { closed++; } };
  const client: any = { config: {}, sessionIdentity: async () => current, json: async () => ({ Identifier: current, UniqueName: student.uniqueName, EmailAddress: student.emails[0] }) };
  const mail = new UniversityMail(client, { workerFactory: async () => worker });
  return { mail, calls, worker, client, setAccount: (value: string | undefined) => { current = value; }, closed: () => closed };
}
async function connect(mail: UniversityMail) {
  assert.equal(mail.beginLogin().state, 'waiting');
  for (let i = 0; i < 30 && mail.loginStatus().state === 'waiting'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(mail.loginStatus().state, 'connected', JSON.stringify(mail.loginStatus()));
}
function code(expected: string) { return (error: unknown) => error instanceof BrightspaceError && error.code === expected; }

test('mail identity requires stable Graph identity and matching institutional identifiers', () => {
  assert.deepEqual(matchMailIdentity(student, account), account);
  for (const row of [{ ...account, userPrincipalName: 'teststudent@tudelft.nl.evil.example' }, { ...account, userPrincipalName: 'someone@tudelft.nl', mail: 'other@student.tudelft.nl' }, { ...account, id: '' }, { ...account, tenantId: '' }, { ...account, mail: 'x'.repeat(100000) }]) assert.throws(() => matchMailIdentity(student, row), code('MAIL_ACCOUNT_MISMATCH'));
  assert.throws(() => matchMailIdentity({ ...student, uniqueName: 'unknown', emails: [] }, account), code('MAIL_ACCOUNT_MISMATCH'));
});

test('mail starts lazily, login is process scoped, and logout clears the worker', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0); await assert.rejects(f.mail.read('message1'), code('MAIL_AUTH_REQUIRED'));
  await connect(f.mail);
  assert.equal((await f.mail.checkAuth()).canSend, false);
  assert.equal((await f.mail.read('message1')).mailboxReadStateChanged, false);
  await f.mail.logout(); assert.equal(f.closed(), 1); assert.equal(f.mail.loginStatus().state, 'idle');
  await assert.rejects(f.mail.read('message1'), code('MAIL_AUTH_REQUIRED'));
});

test('mail validates arguments before any worker request and rejects response identity mismatch', async () => {
  const f = fixture(op => op === 'read' ? { identity: account, data: { ...email, id: 'wrong1' } } : undefined);
  await connect(f.mail); const baseline = f.calls.length;
  await assert.rejects(f.mail.read('../send'), code('INVALID_ARGUMENT'));
  await assert.rejects(f.mail.search('x', 51), code('INVALID_ARGUMENT'));
  await assert.rejects(f.mail.search('x\n'), code('INVALID_ARGUMENT'));
  await assert.rejects(f.mail.listMessages('inbox', 10, 'https://evil.example'), code('INVALID_ARGUMENT'));
  await assert.rejects(f.mail.createReplyDraft('message1', 'x'.repeat(20001)), code('INVALID_ARGUMENT'));
  assert.equal(f.calls.length, baseline);
  await assert.rejects(f.mail.read('message1'), code('MAIL_UNSAFE_RESPONSE')); await f.mail.close();
});

test('mail read/search outputs are bounded and exclude unrelated fields and external links', async () => {
  const f = fixture(op => op === 'read' ? { identity: account, data: { ...email, body: { contentType: 'html', content: '<p>' + 'x'.repeat(100000) + '</p><script>evil()</script>' }, subject: 's'.repeat(5000), access_token: 'secret', webLink: 'https://evil.example/read', toRecipients: Array.from({ length: 100 }, () => ({ emailAddress: { name: 'n'.repeat(1000), address: 'm'.repeat(1000) } })) } } : op === 'search' ? { identity: account, data: { value: [email], nextCursor: 'b'.repeat(32) } } : undefined);
  await connect(f.mail);
  const read = await f.mail.read('message1'); assert.equal(read.truncated, true); assert.equal(read.complete, false);
  assert.equal((read.message as any).webLink, undefined); assert.ok(JSON.stringify(read).length < 100000); assert.ok(!JSON.stringify(read).includes('access_token'));
  const search = await f.mail.search('subject:DSAIT4000'); assert.equal(search.complete, false); assert.equal(search.nextCursor, 'b'.repeat(32)); await f.mail.close();
});

test('draft preflight is followed by one create, verified as unsent, without send operations', async () => {
  const f = fixture(); await connect(f.mail);
  const result = await f.mail.createReplyDraft('message1', 'My reply.');
  assert.equal(result.sent, false); assert.equal(result.savedToOutlook, true); assert.equal((result.draft as any).isDraft, true);
  assert.deepEqual(f.calls.slice(1).map(call => call.op), ['prepareReply', 'createReply']);
  assert.deepEqual(f.calls[1]!.args, { messageId: 'message1', body: 'My reply.', replyAll: false });
  assert.deepEqual(Object.keys(f.calls[2]!.args), ['permit']); await f.mail.close();
});

test('uncertain or unverified draft creation is not retried or reported as saved', async () => {
  for (const failure of [new Error('raw protocol secret'), { identity: account, data: { ...email, isDraft: false } }, { identity: { ...account, id: '33333333-3333-3333-3333-333333333333' }, data: email }]) {
    const f = fixture(op => { if (op === 'createReply') { if (failure instanceof Error) throw failure; return failure; } });
    await connect(f.mail);
    await assert.rejects(f.mail.createReplyDraft('message1', 'My reply.'), error => { assert.ok(!JSON.stringify(safeError(error)).includes('secret')); return code('MAIL_DRAFT_RESULT_UNKNOWN')(error); });
    assert.equal(f.calls.filter(call => call.op === 'createReply').length, 1); await f.mail.close();
  }
});

test('changed Brightspace account during draft preflight blocks the write', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(op => { if (op === 'prepareReply') f.setAccount('999'); });
  await connect(f.mail); await assert.rejects(f.mail.createReplyDraft('message1', 'My reply.'), code('ACCOUNT_CHANGED'));
  assert.equal(f.calls.filter(call => call.op === 'createReply').length, 0); await f.mail.close();
});

test('Brightspace account change after draft dispatch reports an unknown result', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(op => { if (op === 'createReply') f.setAccount('999'); });
  await connect(f.mail); await assert.rejects(f.mail.createReplyDraft('message1', 'My reply.'), code('MAIL_DRAFT_RESULT_UNKNOWN'));
  assert.equal(f.calls.filter(call => call.op === 'createReply').length, 1); await f.mail.close();
});

test('queued operations cannot survive logout and reconnect', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async op => { if (op === 'read') await gate; }); await connect(f.mail);
  const reading = assert.rejects(f.mail.read('message1'), code('ACCOUNT_CHANGED'));
  await new Promise(resolve => setImmediate(resolve));
  const drafting = assert.rejects(f.mail.createReplyDraft('message1', 'My reply.'), code('ACCOUNT_CHANGED'));
  await f.mail.logout(); await connect(f.mail); release(); await Promise.all([reading, drafting]);
  assert.equal(f.calls.filter(call => call.op === 'prepareReply').length, 0); await f.mail.close();
});

test('logout during login cannot install a late connected session', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async op => { if (op === 'login') await gate; });
  f.mail.beginLogin(); await new Promise(resolve => setImmediate(resolve)); await f.mail.logout(); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.mail.loginStatus().state, 'idle'); assert.ok(f.closed() > 0);
});

test('worker stdin closure rejects safely instead of crashing the Node process', async () => {
  const worker = new PowerShellMailWorker(process.execPath, 'unused', 'unused');
  await assert.rejects(worker.request('createReply', { synthetic: 'x'.repeat(120000) }), code('MAIL_DRAFT_RESULT_UNKNOWN'));
  await new Promise(resolve => setTimeout(resolve, 20)); await worker.close();
});

const hasPowerShell = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true, encoding: 'utf8' }).status === 0;
const helper = fileURLToPath(new URL('../scripts/graph-mail.ps1', import.meta.url));
async function runPowerShell(script: string, input?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-worker-test-'));
  try {
    const path = join(directory, 'test.ps1');
    await writeFile(path, ". '" + helper.replaceAll("'", "''") + "' -LibraryOnly\nfunction Assert($value, [string]$message) { if (!$value) { throw $message } }\n" + script);
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', path], { windowsHide: true, encoding: 'utf8', timeout: 30000, input });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  } finally { assert.equal(resolve(dirname(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }
}

test('PowerShell pagination validates origin, query, arrays, duplicates and cursor loops', { skip: !hasPowerShell }, async () => {
  await runPowerShell(String.raw`
$q = [ordered]@{ '$top' = '2'; '$select' = $script:ListFields; '$orderby' = 'receivedDateTime desc' }
$path = '/me/mailFolders/inbox/messages'
$start = New-GraphUrl $path $q
$next = $start + '&%24skip=2'
Assert ((Assert-NextLink $next $path $q) -ceq $next) 'Valid next link failed'
foreach ($bad in @($next.Replace('graph.microsoft.com','evil.example'), $next.Replace('/me/','/users/other/'), ($next + '&%24top=2'), $next.Replace('%24top=2','%24top=3'), ($next + '&redirect_uri=x'))) {
  $blocked = $false; try { $null = Assert-NextLink $bad $path $q } catch { $blocked = $true }; Assert $blocked 'Unsafe next link accepted'
}
$script:page = @{ value = @(@{id='m1'}); '@odata.nextLink' = $next }
function Invoke-GraphJson { param($Method,$Url,$Body); return $script:page }
$args1 = @{ folderId='inbox'; limit=2 }
$result = Read-MailPage 'messages' $args1
Assert ($result.nextCursor -match '^[a-f0-9]{32}$') 'Cursor missing'
$script:page = @{value=@(@{id='m2'}); '@odata.nextLink'=$start}
$blocked=$false; try {$null=Read-MailPage 'messages' @{folderId='inbox';limit=2;cursor=$result.nextCursor}} catch {$blocked=$true}; Assert $blocked 'Loop accepted'
foreach ($value in @(@{id='m1'}, @(@{id='m1'},@{id='m1'}))) {
  $script:page=@{value=$value}; $blocked=$false; try {$null=Read-MailPage 'messages' $args1} catch {$blocked=$true}; Assert $blocked 'Invalid collection accepted'
}
$script:page=@{value=$null}; $blocked=$false; try {$null=Read-MailPage 'messages' $args1} catch {$blocked=$true}; Assert $blocked 'Null collection accepted'
$script:page=@{value=@(@{id='m1'});'@odata.nextLink'=$next}
$result=Read-MailPage 'messages' $args1
$entry=$script:Cursors[$result.nextCursor]
Assert (@($entry.seen)[0].Length -eq 64) 'Pagination history stores raw URLs'
for($i=0;$i -lt 98;$i++){$null=$entry.seen.Add((Get-UrlHash ('https://synthetic.example/'+$i)))}
$script:page=@{value=@(@{id='m2'});'@odata.nextLink'=($start+'&%24skip=4')}
$limited=Read-MailPage 'messages' @{folderId='inbox';limit=2;cursor=$result.nextCursor}
Assert ($limited.readLimitReached -and !$limited.nextCursor -and $limited.value.Count -eq 1) 'Pagination depth is unbounded or dropped final data'
Write-Output 'pagination passed'
`);
});

test('real hidden PowerShell worker fails closed before login and rejects send commands', { skip: !hasPowerShell }, async () => {
  const worker = new PowerShellMailWorker('pwsh', helper, 'unused');
  try {
    await assert.rejects(worker.request('check'), code('MAIL_AUTH_REQUIRED'));
    await assert.rejects(worker.request('sendMail', { body: 'never sent' }), code('INVALID_ARGUMENT'));
  } finally { await worker.close(); }
});

test('worker delivers SDK and structured prompts before login completes and rejects malformed prompts', { skip: !hasPowerShell }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-prompt-test-'));
  const path = join(directory, 'worker.ps1');
  await writeFile(path, String.raw`
param($ModulePath)
$null=[Console]::ReadLine()
[Console]::Out.WriteLine('GRAPH_MAIL_V1 {"id":1,"event":"login_prompt","prompt":{"verificationUrl":"https://evil.example","userCode":"ABC123XYZ"}}')
[Console]::Out.WriteLine('To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code ABC123XYZ to authenticate.')
[Console]::Out.WriteLine('GRAPH_MAIL_V1 {"id":1,"event":"login_prompt","prompt":{"verificationUrl":"https://microsoft.com/devicelogin","userCode":"DEF456XYZ"}}')
[Console]::Out.Flush()
Start-Sleep -Milliseconds 100
[Console]::Out.WriteLine('GRAPH_MAIL_V1 {"id":1,"ok":true,"result":{"finished":true}}')
$null=[Console]::ReadLine()
`);
  const worker = new PowerShellMailWorker('pwsh', path, 'unused');
  try {
    const codes: string[] = [];
    worker.onLoginPrompt = prompt => { codes.push(prompt.userCode); };
    assert.deepEqual(await worker.request('login'), { finished: true });
    assert.deepEqual(codes, ['ABC123XYZ', 'DEF456XYZ']);
  } finally {
    await worker.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser login forwards only the official display code and fixed URL', { skip: !hasPowerShell }, async () => {
  const output = await runPowerShell(String.raw`
$script:LoginRequestId = 7
Publish-MailLoginPrompt 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABC123XYZ to authenticate.'
Publish-MailLoginPrompt 'To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code ABC123XYZ to authenticate.'
Publish-MailLoginPrompt 'To sign in, use a web browser to open the page https://evil.example and enter the code ABC123XYZ to authenticate.'
Publish-MailLoginPrompt 'access_token=secret'
Publish-MailLoginPrompt @{message='secret'}
`);
  const lines = output.trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], lines[1]);
  const event = JSON.parse(lines[0]!.replace('GRAPH_MAIL_V1 ', ''));
  assert.deepEqual(event, { id: 7, event: 'login_prompt', prompt: { verificationUrl: 'https://microsoft.com/devicelogin', userCode: 'ABC123XYZ' } });
});

test('PowerShell SDK failure classification never returns raw identity or protocol material', { skip: !hasPowerShell }, async () => {
  await runPowerShell(String.raw`
$diagnostic = Get-MailLoginDiagnostic ([InvalidOperationException]::new('A window handle must be configured. secret@example.org https://example.org/?code=secret AADSTS65001', [Exception]::new('token=secret')))
Assert ($diagnostic.stage -eq 'sdk_login' -and $diagnostic.reason -eq 'window_handle_required' -and $diagnostic.aadsts -eq 'AADSTS65001') 'Known SDK error not classified'
Assert ((ConvertTo-Json $diagnostic -Compress) -notmatch 'secret|example') 'Raw SDK error escaped'
$unknown = Get-MailLoginDiagnostic ([Exception]::new('https://example.org/?code=secret AADSTS12345678'))
Assert ($unknown.reason -eq 'unclassified' -and $unknown.exceptionType -eq 'other' -and $unknown.Count -eq 3) 'Unrecognized failure leaked fields'
`);
});

test('PowerShell login requests only profile/mail draft access and validates identity before data', { skip: !hasPowerShell }, async () => {
  await runPowerShell(String.raw`
$script:logins=0;$script:reads=0;$script:badScope=$false
function Initialize-MailSdk {}
function Connect-MgGraph { param($Scopes,$ContextScope,[switch]$NoWelcome,[switch]$UseDeviceCode,$ErrorAction); Assert $UseDeviceCode 'Browser device flow missing'; Assert (($Scopes -join ',') -eq 'User.Read,Mail.ReadWrite') 'Unexpected requested scopes'; Assert ($ContextScope -eq 'Process') 'Session persisted'; $script:logins++ }
function Set-MailSdkTransport {}
function Get-MgContext { return [pscustomobject]@{AuthType='Delegated';ContextScope='Process';Scopes=$(if($script:badScope){@('User.Read','Mail.ReadWrite','Mail.Send')}else{@('User.Read','Mail.ReadWrite','openid','profile','offline_access')});TenantId='22222222-2222-2222-2222-222222222222';Account='teststudent@tudelft.nl'} }
function Invoke-GraphJson { param($Method,$Url,$Body); Assert ($Method -eq 'GET' -and $Url.StartsWith('https://graph.microsoft.com/v1.0/me?')) 'Unexpected identity request';$script:reads++;return @{id='11111111-1111-1111-1111-111111111111';userPrincipalName='teststudent@tudelft.nl';mail='t.student@student.tudelft.nl';displayName='Test Student'} }
$result=Invoke-MailCommand 'login' @{student=@{accountId='123';uniqueName='teststudent';emails=@('t.student@student.tudelft.nl')}}
Assert ($script:logins -eq 1 -and $script:reads -eq 1 -and $result.identity.id) 'Login identity not verified'
$script:badScope=$true;$blocked=$false;try{$null=Invoke-MailCommand 'check' @{}}catch{$blocked=$true};Assert $blocked 'Sending scope accepted';Assert ($script:reads -eq 1) 'Read occurred with unsupported scopes'
Write-Output 'login contract passed'
`);
});

test('PowerShell transport permits one exact draft POST and does not retry or follow redirects', { skip: !hasPowerShell }, async () => {
  await runPowerShell(String.raw`
Add-MailHandlerType
Add-Type -TypeDefinition @'
using System; using System.Net; using System.Net.Http; using System.Collections.Generic; using System.Threading; using System.Threading.Tasks;
public class MailTestProvider { public int Calls; public Task<string> GetAuthorizationTokenAsync(Uri uri, Dictionary<string,object> context, CancellationToken token) { Calls++; return Task.FromResult("synthetic-token"); } }
public class MailTestTerminal : HttpMessageHandler { public int Calls; public int Status=200; protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token) { Calls++; var response=new HttpResponseMessage((HttpStatusCode)Status); response.RequestMessage=request; response.Headers.Location=new Uri("https://evil.example/replay"); response.Content=new StringContent("{}"); return Task.FromResult(response); } }
'@
$provider=[MailTestProvider]::new(); $terminal=[MailTestTerminal]::new(); $handler=[UniversityMail.SdkHandler]::new($provider,$terminal); $client=[Net.Http.HttpClient]::new($handler)
$null=$client.GetAsync('https://graph.microsoft.com/v1.0/me').GetAwaiter().GetResult()
foreach($url in @('https://evil.example/v1.0/me','https://graph.microsoft.com/v1.0/users/other/messages','https://graph.microsoft.com/v1.0/me/sendMail')) { $blocked=$false; try{$null=$client.GetAsync($url).GetAwaiter().GetResult()}catch{$blocked=$true}; Assert $blocked 'Unsafe read accepted' }
Assert ($terminal.Calls -eq 1) 'Blocked request reached transport'
$target='https://graph.microsoft.com/v1.0/me/messages/m1/createReply'
foreach($status in @(307,401,429,503)) {
  $handler.PermitDraft($target); $terminal.Status=$status; $before=$terminal.Calls
  $response=$client.PostAsync($target,[Net.Http.StringContent]::new('{}')).GetAwaiter().GetResult()
  Assert ([int]$response.StatusCode -eq $status) 'Unexpected response'; Assert ($terminal.Calls -eq $before+1) 'Request retried'
  $blocked=$false; try{$null=$client.PostAsync($target,[Net.Http.StringContent]::new('{}')).GetAwaiter().GetResult()}catch{$blocked=$true}; Assert $blocked 'Draft permit reused'
}
$blocked=$false; try{$handler.PermitDraft('https://graph.microsoft.com/v1.0/me/messages/m1/send')}catch{$blocked=$true}; Assert $blocked 'Send permitted'
$client.Dispose(); Write-Output 'transport passed'
`);
});

test('PowerShell draft verification uses the exact own message, one use and exact reply text', { skip: !hasPowerShell }, async () => {
  await runPowerShell(String.raw`
$script:identity=@{id='11111111-1111-1111-1111-111111111111';tenantId='22222222-2222-2222-2222-222222222222';userPrincipalName='student@tudelft.nl';mail='student@tudelft.nl';displayName='Student'}
function Assert-MailBinding { return $script:identity }
$script:MailHandler=New-Object PSObject
$script:MailHandler | Add-Member -MemberType ScriptMethod -Name PermitDraft -Value { param($value) }
$script:posts=0; $script:mismatch=$false; $script:wrongId=$false
function Invoke-GraphJson { param($Method,$Url,$Body)
 if($Method -eq 'POST') { $script:posts++; return @{id='draft1'} }
 if($Url -match '/messages/draft1') { return @{id='draft1';isDraft=$true;toRecipients=@(@{emailAddress=@{address='course@example.org'}});ccRecipients=@();bccRecipients=@();body=@{contentType='text';content=$(if($script:mismatch){'reply'}else{' reply '})}} }
 return @{id=$(if($script:wrongId){'other'}else{'m1'});isDraft=$false;from=@{emailAddress=@{address='course@example.org'}}}
}
$prepared=Invoke-MailCommand 'prepareReply' @{messageId='m1';body=' reply ';replyAll=$false}
$result=Invoke-MailCommand 'createReply' @{permit=$prepared.data.permit}
Assert ($result.data.isDraft -and $result.data.bodyVerified) 'Draft not verified'; Assert ($script:posts -eq 1) 'Wrong POST count'
$blocked=$false;try{$null=Invoke-MailCommand 'createReply' @{permit=$prepared.data.permit}}catch{$blocked=$true};Assert $blocked 'Permit reused'
$prepared=Invoke-MailCommand 'prepareReply' @{messageId='m1';body=' reply ';replyAll=$true};$script:mismatch=$true
$blocked=$false;try{$null=Invoke-MailCommand 'createReply' @{permit=$prepared.data.permit}}catch{$blocked=$true};Assert $blocked 'Whitespace mismatch accepted'
$script:wrongId=$true;$blocked=$false;try{$null=Invoke-MailCommand 'prepareReply' @{messageId='m1';body=' reply ';replyAll=$false}}catch{$blocked=$true};Assert $blocked 'Wrong message accepted'
Assert ($script:posts -eq 2) 'Failed preflight made a POST'; Write-Output 'drafts passed'
`);
});

test('PowerShell recipient verification honors Reply-To, reply-all, self exclusion and empty Bcc', { skip: !hasPowerShell }, async () => {
  await runPowerShell(String.raw`
function Recipient([string]$email) { return @{emailAddress=@{address=$email}} }
$identity=@{userPrincipalName='student@tudelft.nl';mail='s.student@student.tudelft.nl'}
$original=@{from=(Recipient 'from@example.org');replyTo=@((Recipient 'reply@example.org'));toRecipients=@((Recipient 's.student@student.tudelft.nl'),(Recipient 'peer@example.org'));ccRecipients=@((Recipient 'copy@example.org'))}
$single=Get-ExpectedReplyRecipients $original $identity $false
Assert ($single.to.SetEquals([string[]]@('reply@example.org')) -and $single.cc.Count -eq 0) 'Reply-to override failed'
$all=Get-ExpectedReplyRecipients $original $identity $true
Assert ($all.to.SetEquals([string[]]@('reply@example.org','peer@example.org')) -and $all.cc.SetEquals([string[]]@('copy@example.org'))) 'Reply-all recipients wrong'
$draft=@{toRecipients=@((Recipient 'reply@example.org'),(Recipient 'peer@example.org'));ccRecipients=@((Recipient 'copy@example.org'));bccRecipients=@()}
Assert-DraftRecipients $draft $all
$draft.bccRecipients=@((Recipient 'hidden@example.org'));$blocked=$false;try{Assert-DraftRecipients $draft $all}catch{$blocked=$true};Assert $blocked 'Hidden Bcc accepted'
$draft.bccRecipients=@();$draft.toRecipients=@((Recipient 'from@example.org'),(Recipient 'peer@example.org'));$blocked=$false;try{Assert-DraftRecipients $draft $all}catch{$blocked=$true};Assert $blocked 'Unexpected To accepted'
Write-Output 'recipients passed'
`);
});

test('PowerShell response buffering rejects oversized content and redirects', { skip: !hasPowerShell }, async () => {
  await runPowerShell(String.raw`
$script:oversize=$true
function Invoke-MgGraphRequest { param($Method,$Uri,$OutputType,$SkipHttpErrorCheck,$Headers,$ErrorAction)
 $response=[Net.Http.HttpResponseMessage]::new($(if($script:oversize){[Net.HttpStatusCode]::OK}else{[Net.HttpStatusCode]::TemporaryRedirect}))
 $response.RequestMessage=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,$Uri)
 $response.Content=[Net.Http.StringContent]::new(('x' * ($script:MaxResponseBytes+1)))
 return $response
}
$blocked=$false;try{$null=Invoke-GraphJson 'GET' 'https://graph.microsoft.com/v1.0/me'}catch{$blocked=$true};Assert $blocked 'Oversized response accepted'
$script:oversize=$false;$blocked=$false;try{$null=Invoke-GraphJson 'GET' 'https://graph.microsoft.com/v1.0/me'}catch{$blocked=$true};Assert $blocked 'Redirect accepted'
Write-Output 'buffering passed'
`);
});

const modulePath = fileURLToPath(new URL('../.local/powershell/Modules/Microsoft.Graph.Authentication/2.39.0/Microsoft.Graph.Authentication.psd1', import.meta.url));
test('installed official SDK exposes the pinned process transport contract without authentication', { skip: !hasPowerShell || !existsSync(modulePath) }, async () => {
  await runPowerShell("$ModulePath='" + modulePath.replaceAll("'", "''") + "'\n" + String.raw`
Initialize-MailSdk
$providerType=[Microsoft.Graph.PowerShell.Authentication.Core.Utilities.AuthenticationHelpers].GetMethod('GetAuthenticationProviderAsync').ReturnType.GenericTypeArguments[0]
$method=$providerType.GetMethod('GetAuthorizationTokenAsync',[type[]]@([Uri],[Collections.Generic.Dictionary[string,object]],[Threading.CancellationToken]))
Assert ($method.ReturnType -eq [Threading.Tasks.Task[string]]) 'SDK provider method changed'
Assert ([Microsoft.Graph.PowerShell.Authentication.GraphSession].GetProperty('GraphHttpClient').CanWrite) 'SDK transport hook changed'
Assert (!(Get-MgContext)) 'A live SDK account was unexpectedly loaded'
Write-Output 'SDK compatibility passed without login'
`);
});
