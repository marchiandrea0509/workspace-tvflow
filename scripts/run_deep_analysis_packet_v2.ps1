param(
  [Parameter(Mandatory=$true)][string]$Symbol,
  [ValidateSet('LONG','SHORT','AUTO')][string]$Side = 'AUTO',
  [string]$Family = 'AUTO',
  [double]$Score = [double]::NaN,
  [int]$Rank = -1,
  [double]$RiskUsdt = 100.0,
  [double]$MaxNotionalUsdt = 1500.0,
  [string]$TvSymbol = '',
  [string]$TvExportDir = '',
  [string]$ExecutionStateJson = '',
  [string]$OutRoot = 'reports/deep_analysis_packets_v2'
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $PSScriptRoot 'build_deep_analysis_packet_v2.py'

$argsList = @(
  $Script,
  '--symbol', $Symbol,
  '--side', $Side,
  '--family', $Family,
  '--risk-usdt', ([string]$RiskUsdt),
  '--max-notional-usdt', ([string]$MaxNotionalUsdt),
  '--out-root', $OutRoot
)

if ($TvSymbol -ne '') { $argsList += @('--tv-symbol', $TvSymbol) }
if (-not [double]::IsNaN($Score)) { $argsList += @('--score', ([string]$Score)) }
if ($Rank -ge 0) { $argsList += @('--rank', ([string]$Rank)) }
if ($TvExportDir -ne '') { $argsList += @('--tv-export-dir', $TvExportDir) }
if ($ExecutionStateJson -ne '') { $argsList += @('--execution-state-json', $ExecutionStateJson) }

Push-Location $Repo
try {
  python @argsList
} finally {
  Pop-Location
}
