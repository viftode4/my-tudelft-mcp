#requires -Version 7.4
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$version = '2.39.0'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = Join-Path $project '.local/powershell/Modules'
$manifest = Join-Path $destination "Microsoft.Graph.Authentication/$version/Microsoft.Graph.Authentication.psd1"
$expectedHash = '85CD3433D6772FC0C67AC594B489FBFB6BC400E9CCEF622C67E9AA56BF675F2E'
if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Save-PSResource -Name Microsoft.Graph.Authentication -Version $version -Repository PSGallery -Path $destination -TrustRepository -ErrorAction Stop
}
if ((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash -ne $expectedHash) { throw 'The pinned Microsoft Graph module manifest did not match its verified hash.' }
if ($IsWindows) {
    $signature = Get-AuthenticodeSignature -LiteralPath $manifest
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') { throw 'The Microsoft Graph module signature could not be verified.' }
}
Write-Output "Microsoft.Graph.Authentication $version is installed locally. No Microsoft login or consent has been performed."
