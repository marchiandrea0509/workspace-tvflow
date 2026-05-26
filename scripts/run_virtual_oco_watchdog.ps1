param(
  [Parameter(Mandatory=$true)][string]$Config,
  [ValidateSet('main','status','rearm','disarm')][string]$Mode = 'main',
  [string]$State = '',
  [switch]$Send,
  [switch]$Json,
  [switch]$Force,
  [switch]$Feedback,
  [switch]$NoStateUpdate
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $PSScriptRoot 'virtual_oco_watchdog.js'

$argsList = @($Script, '--config', (Resolve-Path $Config), '--mode', $Mode)
if ($State -ne '') { $argsList += @('--state', $State) }
if ($Send) { $argsList += @('--send', 'true') }
if ($Json) { $argsList += '--json' }
if ($Force) { $argsList += @('--force', 'true') }
if ($Feedback) { $argsList += @('--feedback', 'true') }
if ($NoStateUpdate) { $argsList += @('--updateState', 'false') }

Push-Location $Repo
try {
  & node @argsList
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
