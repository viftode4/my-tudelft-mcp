#requires -Version 7.4
param([string] $ModulePath, [switch] $LibraryOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$script:GraphRoot = 'https://graph.microsoft.com/v1.0'
$script:Binding = $null
$script:ExpectedStudent = $null
$script:MailHandler = $null
$script:Cursors = @{}
$script:Drafts = @{}
$script:LoginDiagnostic = $null
$script:MaxResponseBytes = 2 * 1024 * 1024
$script:ListFields = 'id,subject,from,sender,receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,bodyPreview,webLink,conversationId'
$script:ReadFields = $script:ListFields + ',body,toRecipients,ccRecipients,bccRecipients,replyTo'

function Stop-Mail([string] $Code) { throw [InvalidOperationException]::new($Code) }
function Get-MailLoginDiagnostic([Exception] $Exception) {
    # Raw SDK errors may contain OAuth values or account identifiers. Inspect a
    # bounded exception chain locally and return only fixed diagnostic labels.
    $reason = 'unclassified'; $type = 'other'; $aadsts = $null
    $current = $Exception
    for ($depth = 0; $null -ne $current -and $depth -lt 6; $depth++) {
        $name = $current.GetType().FullName
        if ($name -in @('Azure.Identity.AuthenticationFailedException','Microsoft.Identity.Client.MsalClientException','Microsoft.Identity.Client.MsalServiceException','System.OperationCanceledException','System.TimeoutException','System.InvalidOperationException')) { $type = $name }
        $message = [string]$current.Message
        if ($message.Length -gt 8192) { $message = $message.Substring(0,8192) }
        if ($message -match '(?i)(window handle must be configured|parent window handle|parent_window_handle_required)') { $reason = 'window_handle_required' }
        elseif ($reason -eq 'unclassified' -and $message -match '(?i)(authentication_canceled|authentication_cancelled|user canceled|user cancelled)') { $reason = 'user_cancelled' }
        elseif ($reason -eq 'unclassified' -and $message -match '(?i)(unable to open a web page|failed to launch.*browser|browser.*could not be started)') { $reason = 'browser_unavailable' }
        elseif ($reason -eq 'unclassified' -and $message -match '(?i)(timed out|timeout)') { $reason = 'timeout' }
        if ($message -match '\bAADSTS(65001|65004|90094|50076|50079|53003|700016|50011)\b') { $aadsts = 'AADSTS' + $Matches[1] }
        $current = $current.InnerException
    }
    $result = @{ stage = 'sdk_login'; reason = $reason; exceptionType = $type }
    if ($aadsts) { $result['aadsts'] = $aadsts }
    return $result
}
function Get-UrlHash([string] $Value) { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))) }
function Get-Field($Value, [string] $Name) { if ($null -ne $Value -and $Value.Contains($Name)) { return $Value[$Name] }; return $null }
function Assert-MailId([string] $Value) {
    if ($Value -cnotmatch '^[A-Za-z0-9_+=/-]{1,2048}$') { Stop-Mail 'INVALID_ARGUMENT' }
    return [Uri]::EscapeDataString($Value)
}
function Get-Principal([string] $Value) { if ($Value.ToLowerInvariant() -match '^([a-z0-9._-]{1,100})@(tudelft\.nl|student\.tudelft\.nl)$') { return $Matches[1] }; return $null }
function Assert-GraphIdentity($Identity, $Student) {
    $netid = Get-Principal ([string]$Student.uniqueName)
    if (!$netid -and [string]$Student.uniqueName -match '^[a-zA-Z0-9._-]{1,100}$') { $netid = ([string]$Student.uniqueName).ToLowerInvariant() }
    $guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    if ([string]$Identity.id -notmatch $guid -or [string]$Identity.tenantId -notmatch $guid -or ([string]$Identity.mail).Length -gt 320 -or !(Get-Principal ([string]$Identity.userPrincipalName))) { Stop-Mail 'MAIL_ACCOUNT_MISMATCH' }
    $matching = $false
    foreach ($address in @($Identity.userPrincipalName, $Identity.mail)) {
        $value = ([string]$address).ToLowerInvariant()
        $principal = Get-Principal $value
        if ($principal -and (($netid -and $principal -eq $netid) -or @($Student.emails) -contains $value -or $value -eq ([string]$Student.uniqueName).ToLowerInvariant())) { $matching = $true }
    }
    if (!$matching) { Stop-Mail 'MAIL_ACCOUNT_MISMATCH' }
}

function Add-MailHandlerType {
    if ('UniversityMail.SdkHandler' -as [type]) { return }
    # The actual SDK's provider owns credentials. Its bearer value stays inside
    # this handler, never becoming a PowerShell, Node, MCP or saved-file value.
    Add-Type -TypeDefinition @"
using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
namespace UniversityMail {
  public static class LoginConsole {
    private static bool owned;
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AllocConsole();
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetStdHandle(int kind, IntPtr value);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint GetFileType(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    public static bool IsReady { get { return RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && GetAncestor(GetConsoleWindow(), 3) != IntPtr.Zero; } }
    public static bool IsOwnedConsoleHidden { get { return owned && !IsWindowVisible(GetConsoleWindow()); } }
    public static void Ensure() {
      if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || IsReady) return;
      // The SDK itself obtains WAM's parent via GetConsoleWindow/GetAncestor.
      // A hidden piped child lacks that console. Preserve the private RPC pipes
      // when allocating our own hidden console; never attach another process.
      var input = GetStdHandle(-10); var output = GetStdHandle(-11); var error = GetStdHandle(-12);
      // CREATE_NO_WINDOW may still attach this child to a windowless console.
      // Detach only this dedicated, fully piped process, never a visible host.
      if (GetConsoleWindow() != IntPtr.Zero || GetFileType(input) != 3 || GetFileType(output) != 3 || GetFileType(error) != 3) throw new InvalidOperationException("MAIL_LOGIN_HOST_UNAVAILABLE");
      bool restored = true;
      try {
        if (!FreeConsole()) throw new InvalidOperationException("MAIL_LOGIN_HOST_UNAVAILABLE");
        if (!AllocConsole()) throw new InvalidOperationException("MAIL_LOGIN_HOST_UNAVAILABLE");
        owned = true; ShowWindow(GetConsoleWindow(), 0);
      } finally {
        restored = SetStdHandle(-10, input) & SetStdHandle(-11, output) & SetStdHandle(-12, error);
      }
      if (!restored || !IsReady || !IsOwnedConsoleHidden) throw new InvalidOperationException("MAIL_LOGIN_HOST_UNAVAILABLE");
    }
    public static void Close() { if (owned) { FreeConsole(); owned = false; } }
  }
  public sealed class SdkHandler : DelegatingHandler {
    private readonly object provider;
    private readonly MethodInfo tokenMethod;
    private string draftTarget;
    private int draftPermit;
    public SdkHandler(object sdkProvider, HttpMessageHandler inner) : base(inner) {
      provider = sdkProvider;
      tokenMethod = sdkProvider.GetType().GetMethod("GetAuthorizationTokenAsync", new Type[] { typeof(Uri), typeof(Dictionary<string,object>), typeof(CancellationToken) });
      if (tokenMethod == null || tokenMethod.ReturnType != typeof(Task<string>)) throw new InvalidOperationException("MAIL_SDK_INCOMPATIBLE");
    }
    public void PermitDraft(string target) {
      var uri = new Uri(target);
      if (!OriginAllowed(uri) || !Regex.IsMatch(uri.AbsolutePath, @"^/v1\.0/me/messages/[A-Za-z0-9_%+=-]+/createReply(?:All)?$")) throw new InvalidOperationException("MAIL_UNSAFE_TARGET");
      draftTarget = uri.AbsoluteUri; Interlocked.Exchange(ref draftPermit, 1);
    }
    private static bool OriginAllowed(Uri uri) { return uri.Scheme == "https" && uri.Host == "graph.microsoft.com" && uri.Port == 443 && uri.UserInfo.Length == 0 && uri.Fragment.Length == 0; }
    private static bool ReadAllowed(Uri uri) {
      return Regex.IsMatch(uri.AbsolutePath, @"^/v1\.0/me(?:/messages(?:/[A-Za-z0-9_%+=-]+)?|/mailFolders(?:/[A-Za-z0-9_%+=-]+/(?:childFolders|messages))?)?$", RegexOptions.CultureInvariant);
    }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) {
      if (!OriginAllowed(request.RequestUri)) throw new InvalidOperationException("MAIL_UNSAFE_TARGET");
      if (request.Method == HttpMethod.Post) {
        if (request.RequestUri.AbsoluteUri != draftTarget || Interlocked.Exchange(ref draftPermit, 0) != 1) throw new InvalidOperationException("MAIL_DRAFT_NOT_PERMITTED");
      } else if (request.Method != HttpMethod.Get || !ReadAllowed(request.RequestUri)) throw new InvalidOperationException("MAIL_UNSAFE_TARGET");
      var token = await (Task<string>)tokenMethod.Invoke(provider, new object[] { request.RequestUri, null, cancellationToken });
      if (String.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("MAIL_AUTH_REQUIRED");
      request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
      // No retry/redirect middleware. The terminal handler also disables redirects.
      return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
  }
}
"@ *> $null
}

function Initialize-MailSdk {
    if (!$ModulePath -or !(Test-Path -LiteralPath $ModulePath -PathType Leaf)) { Stop-Mail 'MAIL_DEPENDENCY_MISSING' }
    Import-Module -Name $ModulePath -ErrorAction Stop 3>$null 4>$null 5>$null 6>$null
    if ((Get-Module Microsoft.Graph.Authentication).Version.ToString() -ne '2.39.0') { Stop-Mail 'MAIL_DEPENDENCY_MISSING' }
    Add-MailHandlerType
}
function Set-MailSdkTransport {
    $session = [Microsoft.Graph.PowerShell.Authentication.GraphSession]::Instance
    $provider = [Microsoft.Graph.PowerShell.Authentication.Core.Utilities.AuthenticationHelpers]::GetAuthenticationProviderAsync($session.AuthContext).GetAwaiter().GetResult()
    $terminal = [System.Net.Http.HttpClientHandler]::new()
    $terminal.AllowAutoRedirect = $false
    $terminal.UseCookies = $false
    $script:MailHandler = [UniversityMail.SdkHandler]::new($provider, $terminal)
    $client = [System.Net.Http.HttpClient]::new($script:MailHandler, $true)
    $client.BaseAddress = [Uri]'https://graph.microsoft.com/'
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $client.MaxResponseContentBufferSize = $script:MaxResponseBytes
    if ($session.GraphHttpClient) { $session.GraphHttpClient.Dispose() }
    $session.GraphHttpClient = $client
}
function Initialize-MailLoginHost {
    Add-MailHandlerType
    [UniversityMail.LoginConsole]::Ensure()
}

function New-GraphUrl([string] $Path, [System.Collections.IDictionary] $Query = @{}) {
    $parts = @($Query.GetEnumerator() | Sort-Object Key | ForEach-Object { [Uri]::EscapeDataString([string]$_.Key) + '=' + [Uri]::EscapeDataString([string]$_.Value) })
    $url = $script:GraphRoot + $Path
    if ($parts.Count) { $url += '?' + ($parts -join '&') }
    return $url
}
function Assert-NextLink([string] $Value, [string] $Path, [System.Collections.IDictionary] $Query) {
    try { $uri = [Uri]::new($Value) } catch { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
    if ($Value.Length -gt 24000 -or !$uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.Host -ne 'graph.microsoft.com' -or $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Fragment -or $uri.AbsolutePath -cne ('/v1.0' + $Path)) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
    $actual = @{}
    foreach ($pair in $uri.Query.TrimStart('?').Split('&', [StringSplitOptions]::RemoveEmptyEntries)) {
        $parts = $pair.Split('=', 2)
        $key = [Uri]::UnescapeDataString($parts[0].Replace('+', ' '))
        $value = if ($parts.Count -gt 1) { [Uri]::UnescapeDataString($parts[1].Replace('+', ' ')) } else { '' }
        if ($actual.ContainsKey($key) -or (!$Query.Contains($key) -and $key -cnotin @('$skip', '$skiptoken'))) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
        $actual[$key] = $value
    }
    foreach ($key in $Query.Keys) { if (!$actual.ContainsKey($key) -or $actual[$key] -cne [string]$Query[$key]) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' } }
    if ($actual.ContainsKey('$skip') -and $actual['$skip'] -notmatch '^\d{1,12}$') { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
    if ($actual.ContainsKey('$skiptoken') -and ([string]$actual['$skiptoken']).Length -gt 16000) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
    return $uri.AbsoluteUri
}
function Invoke-GraphJson([string] $Method, [string] $Url, $Body = $null) {
    $parameters = @{ Method = $Method; Uri = $Url; OutputType = 'HttpResponseMessage'; SkipHttpErrorCheck = $true; Headers = @{ Prefer = 'outlook.body-content-type="text"' }; ErrorAction = 'Stop' }
    if ($null -ne $Body) { $parameters.Body = ConvertTo-Json -InputObject $Body -Compress -Depth 8; $parameters.ContentType = 'application/json' }
    $response = $null
    try {
        $response = Invoke-MgGraphRequest @parameters 2>$null 3>$null 4>$null 5>$null 6>$null
        if ($response.RequestMessage.RequestUri.AbsoluteUri -cne $Url) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
        $status = [int]$response.StatusCode
        if ($status -ge 300 -and $status -lt 400) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
        if ($status -eq 404) { Stop-Mail 'MAIL_NOT_FOUND' }
        if ($status -eq 401) { Stop-Mail 'MAIL_AUTH_REQUIRED' }
        if ($status -lt 200 -or $status -ge 300) { Stop-Mail 'MAIL_REQUEST_FAILED' }
        $response.Content.LoadIntoBufferAsync($script:MaxResponseBytes).GetAwaiter().GetResult()
        $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($content) -gt $script:MaxResponseBytes) { Stop-Mail 'MAIL_RESPONSE_TOO_LARGE' }
        return ConvertFrom-Json -InputObject $content -AsHashtable -Depth 30
    } finally { if ($response) { $response.Dispose() } }
}
function Get-MailIdentity {
    $context = Get-MgContext
    if (!$context -or $context.AuthType -ne 'Delegated' -or $context.ContextScope -ne 'Process') { Stop-Mail 'MAIL_AUTH_REQUIRED' }
    $scopes = @($context.Scopes | ForEach-Object { $_.ToLowerInvariant() })
    if ($scopes -notcontains 'user.read' -or $scopes -notcontains 'mail.readwrite' -or @($scopes | Where-Object { $_ -notin @('user.read','mail.read','mail.readwrite','openid','profile','email','offline_access') }).Count) { Stop-Mail 'MAIL_SCOPE_MISMATCH' }
    $me = Invoke-GraphJson 'GET' (New-GraphUrl '/me' @{ '$select' = 'id,displayName,mail,userPrincipalName' })
    $identity = @{ id = [string]$me.id; tenantId = [string]$context.TenantId; userPrincipalName = [string]$me.userPrincipalName; mail = [string](Get-Field $me 'mail'); displayName = [string](Get-Field $me 'displayName') }
    if (([string]$context.Account).ToLowerInvariant() -notin @($identity.userPrincipalName.ToLowerInvariant(), $identity.mail.ToLowerInvariant())) { Stop-Mail 'MAIL_ACCOUNT_MISMATCH' }
    return $identity
}
function Assert-MailBinding {
    if (!$script:Binding -or !$script:ExpectedStudent) { Stop-Mail 'MAIL_AUTH_REQUIRED' }
    $identity = Get-MailIdentity
    Assert-GraphIdentity $identity $script:ExpectedStudent
    if ($identity.id -cne $script:Binding.id -or $identity.tenantId -cne $script:Binding.tenantId) { Stop-Mail 'MAIL_ACCOUNT_CHANGED' }
    return $identity
}
function Read-MailMessage([string] $MessageId) {
    $id = Assert-MailId $MessageId
    $message = Invoke-GraphJson 'GET' (New-GraphUrl ('/me/messages/' + $id) @{ '$select' = $script:ReadFields })
    if ([string]$message.id -cne $MessageId) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
    return $message
}

function Get-RecipientSet($Values) {
    $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($null -eq $Values) { return ,$set }
    if (@($Values).Count -gt 100) { Stop-Mail 'MAIL_DRAFT_INVALID' }
    foreach ($value in @($Values)) {
        $address = [string](Get-Field (Get-Field $value 'emailAddress') 'address')
        $parsed = $null
        if (!$address -or $address.Length -gt 320 -or $address -match '[\r\n\x00]' -or ![Net.Mail.MailAddress]::TryCreate($address, [ref]$parsed) -or $parsed.Address -ine $address) { Stop-Mail 'MAIL_DRAFT_INVALID' }
        if (!$set.Add($address)) { Stop-Mail 'MAIL_DRAFT_INVALID' }
    }
    return ,$set
}
function Get-ExpectedReplyRecipients($Original, $Identity, [bool] $ReplyAll) {
    $own = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($address in @($Identity.mail, $Identity.userPrincipalName)) { if ($address) { $null = $own.Add([string]$address) } }
    foreach ($address in @(Get-Field $script:ExpectedStudent 'emails')) { if ($address -and (Get-Principal ([string]$address))) { $null = $own.Add([string]$address) } }
    $replyTo = Get-RecipientSet (Get-Field $Original 'replyTo')
    $to = if ($replyTo.Count) { $replyTo } else { Get-RecipientSet @((Get-Field $Original 'from')) }
    # Prevent PowerShell enumeration from changing the set into an array.
    $toSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($address in $to) { $null = $toSet.Add($address) }
    $cc = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($ReplyAll) {
        $toSet.UnionWith((Get-RecipientSet (Get-Field $Original 'toRecipients')))
        $cc.UnionWith((Get-RecipientSet (Get-Field $Original 'ccRecipients')))
    }
    $toSet.ExceptWith($own); $cc.ExceptWith($own); $cc.ExceptWith($toSet)
    if (!$toSet.Count -or $toSet.Count -gt 100 -or $cc.Count -gt 100) { Stop-Mail 'MAIL_DRAFT_INVALID' }
    return @{ to = $toSet; cc = $cc }
}
function Assert-DraftRecipients($Draft, $Expected) {
    $to = Get-RecipientSet (Get-Field $Draft 'toRecipients')
    $cc = Get-RecipientSet (Get-Field $Draft 'ccRecipients')
    $bcc = Get-RecipientSet (Get-Field $Draft 'bccRecipients')
    if (!$Expected.to.SetEquals($to) -or !$Expected.cc.SetEquals($cc) -or $bcc.Count) { Stop-Mail 'MAIL_DRAFT_RESULT_UNKNOWN' }
}

function Read-MailPage([string] $Operation, $Arguments) {
    $query = [ordered]@{}
    $limit = if ($Operation -eq 'folders') { 50 } else { [int]$Arguments.limit }
    if ($limit -lt 1 -or $limit -gt 50) { Stop-Mail 'INVALID_ARGUMENT' }
    $query['$top'] = [string]$limit
    if ($Operation -eq 'folders') {
        $path = '/me/mailFolders'
        if (Get-Field $Arguments 'parentId') { $path += '/' + (Assert-MailId $Arguments.parentId) + '/childFolders' }
        $query['$select'] = 'id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount'
    } else {
        $query['$select'] = $script:ListFields
        if ($Operation -eq 'messages') { $path = '/me/mailFolders/' + (Assert-MailId $Arguments.folderId) + '/messages'; $query['$orderby'] = 'receivedDateTime desc' }
        else {
            $path = '/me/messages'; $search = [string]$Arguments.query
            if (!$search.Trim() -or $search.Length -gt 1000 -or $search -match '[\x00-\x1f\x7f]') { Stop-Mail 'INVALID_ARGUMENT' }
            $query['$search'] = '"' + $search.Replace('\', '\\').Replace('"', '\"') + '"'
        }
    }
    $scope = $Operation + ':' + (New-GraphUrl $path $query)
    $cursor = [string](Get-Field $Arguments 'cursor')
    $url = New-GraphUrl $path $query
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    if ($cursor) {
        if (!$script:Cursors.ContainsKey($cursor)) { Stop-Mail 'MAIL_CURSOR_INVALID' }
        $entry = $script:Cursors[$cursor]; $script:Cursors.Remove($cursor)
        if ($entry.scope -cne $scope -or $entry.expires -lt [DateTime]::UtcNow) { Stop-Mail 'MAIL_CURSOR_INVALID' }
        $url = Assert-NextLink $entry.url $path $query
        $seen = $entry.seen
    }
    if ($seen.Count -ge 100) { Stop-Mail 'MAIL_READ_LIMIT' }
    if (!$seen.Add((Get-UrlHash $url))) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
    $result = Invoke-GraphJson 'GET' $url
    if (!$result.Contains('value') -or $result.value -isnot [array] -or $result.value.Count -gt $limit) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
    $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $result.value) {
        $id = [string](Get-Field $item 'id'); $null = Assert-MailId $id
        if (!$ids.Add($id)) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
    }
    $next = $null
    $limitReached = $false
    if (Get-Field $result '@odata.nextLink') {
        $url = Assert-NextLink $result['@odata.nextLink'] $path $query
        if ($seen.Contains((Get-UrlHash $url))) { Stop-Mail 'MAIL_UNSAFE_RESPONSE' }
        foreach ($key in @($script:Cursors.Keys)) { if ($script:Cursors[$key].expires -lt [DateTime]::UtcNow) { $script:Cursors.Remove($key) } }
        if ($script:Cursors.Count -ge 100) { $script:Cursors.Clear() }
        if ($seen.Count -ge 100) { $limitReached = $true }
        else { $next = [Guid]::NewGuid().ToString('N'); $script:Cursors[$next] = @{ url = $url; scope = $scope; seen = $seen; expires = [DateTime]::UtcNow.AddMinutes(15) } }
    }
    return @{ value = @($result.value); nextCursor = $next; readLimitReached = $limitReached }
}

function Invoke-MailCommand([string] $Operation, $Arguments) {
    $script:LoginDiagnostic = $null
    if ($Operation -eq 'login') {
        if ($script:Binding) { Stop-Mail 'MAIL_ACCOUNT_CHANGED' }
        Initialize-MailSdk
        Initialize-MailLoginHost
        $script:ExpectedStudent = $Arguments.student
        # Ordinary SDK default application. No client ID, secret, device code or
        # imported bearer token is supplied. The user handles any consent/MFA.
        try { Connect-MgGraph -Scopes 'User.Read','Mail.ReadWrite' -ContextScope Process -NoWelcome -ErrorAction Stop *> $null }
        catch { $script:LoginDiagnostic = Get-MailLoginDiagnostic $_.Exception; Stop-Mail 'MAIL_LOGIN_FAILED' }
        Set-MailSdkTransport
        $identity = Get-MailIdentity
        Assert-GraphIdentity $identity $script:ExpectedStudent
        $script:Binding = $identity
        return @{ identity = $identity; data = @{} }
    }
    if ($Operation -notin @('check','folders','messages','search','read','prepareReply','createReply')) { Stop-Mail 'INVALID_ARGUMENT' }
    $identity = Assert-MailBinding
    switch ($Operation) {
        'check' { $data = @{} }
        { $_ -in @('folders','messages','search') } { $data = Read-MailPage $Operation $Arguments }
        'read' { $data = Read-MailMessage ([string]$Arguments.messageId) }
        'prepareReply' {
            $body = [string]$Arguments.body
            if (!$body.Trim() -or $body.Length -gt 20000 -or $body.Contains([char]0) -or $Arguments.replyAll -isnot [bool]) { Stop-Mail 'INVALID_ARGUMENT' }
            $original = Read-MailMessage ([string]$Arguments.messageId)
            if ((Get-Field $original 'isDraft') -eq $true -or !(Get-Field $original 'from')) { Stop-Mail 'MAIL_DRAFT_INVALID' }
            $recipients = Get-ExpectedReplyRecipients $original $identity $Arguments.replyAll
            foreach ($key in @($script:Drafts.Keys)) { if ($script:Drafts[$key].expires -lt [DateTime]::UtcNow) { $script:Drafts.Remove($key) } }
            if ($script:Drafts.Count -ge 20) { $script:Drafts.Clear() }
            $permit = [Guid]::NewGuid().ToString('N')
            $script:Drafts[$permit] = @{ messageId = [string]$original.id; body = $body; replyAll = $Arguments.replyAll; recipients = $recipients; expires = [DateTime]::UtcNow.AddMinutes(1) }
            $data = @{ permit = $permit }
        }
        'createReply' {
            $permit = [string]$Arguments.permit
            if (!$script:Drafts.ContainsKey($permit)) { Stop-Mail 'MAIL_DRAFT_INVALID' }
            $prepared = $script:Drafts[$permit]; $script:Drafts.Remove($permit)
            if ($prepared.expires -lt [DateTime]::UtcNow) { Stop-Mail 'MAIL_DRAFT_INVALID' }
            $operation = if ($prepared.replyAll) { 'createReplyAll' } else { 'createReply' }
            $target = New-GraphUrl ('/me/messages/' + (Assert-MailId $prepared.messageId) + '/' + $operation)
            $script:MailHandler.PermitDraft($target)
            try {
                $created = Invoke-GraphJson 'POST' $target @{ message = @{ body = @{ contentType = 'Text'; content = $prepared.body } } }
                $data = Read-MailMessage ([string]$created.id)
                $actualBody = Get-Field $data 'body'
                if ($data.isDraft -ne $true -or !$actualBody -or ([string]$actualBody.contentType).ToLowerInvariant() -ne 'text' -or ([string]$actualBody.content).Replace("`r`n", "`n") -cne ([string]$prepared.body).Replace("`r`n", "`n")) { Stop-Mail 'MAIL_DRAFT_RESULT_UNKNOWN' }
                Assert-DraftRecipients $data $prepared.recipients
                $data['bodyVerified'] = $true; $data['recipientsVerified'] = $true; $data['parentMessageId'] = $prepared.messageId
            } catch { Stop-Mail 'MAIL_DRAFT_RESULT_UNKNOWN' }
        }
    }
    $identity = Assert-MailBinding
    return @{ identity = $identity; data = $data }
}

if (!$LibraryOnly) {
    try {
        while ($null -ne ($line = [Console]::ReadLine())) {
            $requestId = 0
            try {
                if ($line.Length -gt 100000) { Stop-Mail 'INVALID_ARGUMENT' }
                $request = ConvertFrom-Json -InputObject $line -AsHashtable -Depth 12
                $requestId = [int]$request.id
                if ($requestId -le 0) { Stop-Mail 'INVALID_ARGUMENT' }
                $result = Invoke-MailCommand ([string]$request.op) $request.args
                $response = @{ id = $requestId; ok = $true; result = $result }
            } catch {
                $code = [string]$_.Exception.Message
                if ($code -cnotmatch '^(MAIL_[A-Z_]{1,60}|INVALID_ARGUMENT)$') { $code = 'MAIL_REQUEST_FAILED' }
                $response = @{ id = $requestId; ok = $false; error = @{ code = $code } }
                if ($code -eq 'MAIL_LOGIN_FAILED' -and $script:LoginDiagnostic) { $response.error['details'] = $script:LoginDiagnostic }
            }
            $json = ConvertTo-Json -InputObject $response -Compress -Depth 15
            if ([Text.Encoding]::UTF8.GetByteCount($json) -gt ($script:MaxResponseBytes - 100)) { $json = '{"id":' + $requestId + ',"ok":false,"error":{"code":"MAIL_RESPONSE_TOO_LARGE"}}' }
            [Console]::Out.WriteLine('GRAPH_MAIL_V1 ' + $json)
            [Console]::Out.Flush()
        }
    } finally {
        $script:Drafts.Clear(); $script:Cursors.Clear()
        if (Get-Command Disconnect-MgGraph -ErrorAction SilentlyContinue) { Disconnect-MgGraph -ErrorAction SilentlyContinue *> $null }
        if ('UniversityMail.LoginConsole' -as [type]) { [UniversityMail.LoginConsole]::Close() }
    }
}
