<#
.SYNOPSIS
  Stage the verified CLI-only Ahton package and configuration without reloading VS Code.

.DESCRIPTION
  Preview is read-only. -Apply installs the matching VSIX and transactionally
  removes Ahton's Codex external notifier and configures CLI signals. It never closes or reloads a
  VS Code window. Reload and click acceptance remain attended actions.
#>

[CmdletBinding()]
param([switch] $Apply)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$vsix = Join-Path $repoRoot ("ahton-{0}.vsix" -f $manifest.version)
$installedRoot = Join-Path $env:USERPROFILE (".vscode\extensions\kidneys3.ahton-{0}" -f $manifest.version)
$builtExtension = Join-Path $repoRoot 'dist\extension.js'
$installedExtension = Join-Path $installedRoot 'dist\extension.js'
$configure = Join-Path $PSScriptRoot 'configure-ahton.mjs'

foreach ($required in @($vsix, $builtExtension, $configure)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required cutover artifact is unavailable: $required"
  }
}

function Get-Sha256([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'missing' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

$packageHash = Get-Sha256 $vsix
$builtHash = Get-Sha256 $builtExtension
$installedHash = Get-Sha256 $installedExtension
Write-Output "package_version=$($manifest.version)"
Write-Output "package_sha256=$packageHash"
Write-Output "installed_bundle=$($(if ($builtHash -eq $installedHash) { 'current' } else { 'stale_or_missing' }))"

$node = (Get-Command node -ErrorAction Stop).Source
$code = (Get-Command code -ErrorAction Stop).Source
if (-not $Apply) {
  & $node $configure
  if ($LASTEXITCODE -ne 0) { throw 'Ahton configuration preview failed.' }
  Write-Output 'AHTON_CUTOVER_PREVIEW_ONLY no files changed; no window reloaded'
  exit 0
}

& $code --install-extension $vsix --force
if ($LASTEXITCODE -ne 0) { throw 'Ahton VSIX installation failed.' }
if ((Get-Sha256 $builtExtension) -ne (Get-Sha256 $installedExtension)) {
  throw 'Installed Ahton bundle does not match the verified build.'
}

& $node $configure --apply
if ($LASTEXITCODE -ne 0) { throw 'Ahton configuration migration failed.' }
Write-Output 'AHTON_CUTOVER_STAGED no window was closed or reloaded'
Write-Output 'When your tabs are safe, reload each intended VS Code window and run the attended acceptance checklist.'
