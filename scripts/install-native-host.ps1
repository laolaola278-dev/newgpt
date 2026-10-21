<#
.SYNOPSIS
    GPT++ Native Host installer for Windows (development).

.DESCRIPTION
    Builds the Rust native host, copies it to a per-user install directory,
    writes the Chrome Native Messaging manifest (`com.gptpp.native.json`),
    registers it under HKCU (no admin rights needed), and verifies the result.

    The extension ID changes between unpacked reloads; re-run this script with
    the current ID whenever Chrome regenerates it.

.PARAMETER ExtensionId
    The GPT++ extension ID from chrome://extensions (32 chars, a-p).

.PARAMETER InstallDir
    Target directory. Defaults to %LOCALAPPDATA%\GPT++\native-host.

.EXAMPLE
    .\scripts\install-native-host.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,

    [string]$InstallDir = "$env:LOCALAPPDATA\GPT++\native-host"
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$HostProject = Join-Path $RepoRoot 'native-host'
$HostName = 'com.gptpp.native'
$TemplateName = "$HostName.template.json"
$ManifestName = "$HostName.json"
$RegistryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

# 1. Build (release)
Write-Host '==> cargo build --release'
cargo build --release --manifest-path (Join-Path $HostProject 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }

$ExeSource = Join-Path $HostProject 'target\release\gptpp-native.exe'
if (-not (Test-Path $ExeSource)) { throw "built binary not found at $ExeSource" }

# 2. Install directory + binary
Write-Host "==> installing to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$ExeDest = Join-Path $InstallDir 'gptpp-native.exe'
Copy-Item $ExeSource $ExeDest -Force

# 3. Manifest (literal string replacement avoids regex $ group corruption)
$TemplatePath = Join-Path $HostProject "manifest\$TemplateName"
$ManifestJson = (Get-Content $TemplatePath -Raw)
$ManifestJson = $ManifestJson.Replace('__NATIVE_HOST_PATH__', $ExeDest.Replace('\', '\\'))
$ManifestJson = $ManifestJson.Replace('__EXTENSION_ID__', $ExtensionId)

# Validate before writing.
$null = $ManifestJson | ConvertFrom-Json
$ManifestPath = Join-Path $InstallDir $ManifestName
Set-Content -Path $ManifestPath -Value $ManifestJson -Encoding UTF8

# 4. HKCU registration (per-user, no admin)
Write-Host "==> registering $RegistryKey"
New-Item -Path $RegistryKey -Force | Out-Null
Set-ItemProperty -Path $RegistryKey -Name '(default)' -Value $ManifestPath

# 5. Verify
Write-Host '==> verifying'
$ok = $true
foreach ($item in @($ExeDest, $ManifestPath)) {
    if (-not (Test-Path $item)) { Write-Error "missing: $item"; $ok = $false }
}
$registered = (Get-ItemProperty $RegistryKey).'(default)'
if ($registered -ne $ManifestPath) { Write-Error "registry mismatch: $registered"; $ok = $false }

if ($ok) {
    Write-Host ''
    Write-Host 'GPT++ native host installed:' -ForegroundColor Green
    Write-Host "  host     : $HostName"
    Write-Host "  binary   : $ExeDest"
    Write-Host "  manifest : $ManifestPath"
    Write-Host "  registry : $RegistryKey -> $registered"
    Write-Host "  origin   : chrome-extension://$ExtensionId/"
    Write-Host ''
    Write-Host 'Reload the GPT++ extension, then check the Side Panel for:'
    Write-Host '  Native Host: Connected (protocol v1, capabilities: native_echo)'
} else {
    throw 'installation verification failed'
}
