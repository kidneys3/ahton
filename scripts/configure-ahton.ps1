[CmdletBinding()]
param(
  [switch] $Apply,
  [string] $RollbackJournal
)
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'configure-ahton.mjs'
$arguments = @($scriptPath)
if ($Apply) { $arguments += '--apply' }
if ($RollbackJournal) { $arguments += @('--rollback', $RollbackJournal) }
& (Get-Command node -CommandType Application -ErrorAction Stop).Source @arguments
exit $LASTEXITCODE
