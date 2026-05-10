param(
  [Parameter(Mandatory=$true)][string]$Symbol,
  [ValidateSet('LONG','SHORT','AUTO')][string]$Side = 'AUTO',
  [string]$Family = 'AUTO',
  [double]$Score = [double]::NaN,
  [int]$Rank = -1,
  [double]$RiskUsdt = 100.0,
  [double]$MaxMarginUsdt = 1500.0,
  [double]$PlannedLeverage = 4.0,
  # Deprecated compatibility input. Prefer -MaxMarginUsdt.
  [double]$MaxNotionalUsdt = [double]::NaN,
  [string]$TvSymbol = '',
  [string]$TvExportDir = '',
  [string]$ScreenerDataFile = '',
  [string]$ExecutionStateJson = '',
  [string]$OutRoot = 'reports/deep_analysis_packets_v2',
  [switch]$CaptureTv,
  [switch]$CaptureStrict,
  [string]$CaptureLayout = 'Openclaw-structure',
  [string]$CaptureChartUrl = 'https://www.tradingview.com/chart/0ZPSKaZ4/'
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $PSScriptRoot 'build_deep_analysis_packet_v2.py'
$TradingViewRoot = Join-Path (Split-Path -Parent $Repo) 'workspace\tradingview'
$CaptureJs = Join-Path $TradingViewRoot 'scripts\capture_live.js'

function Normalize-ApiSymbol([string]$s) {
  $x = $s.ToUpper().Replace('BITGET:', '').Replace('.P', '')
  return $x
}

function Normalize-TvSymbol([string]$api, [string]$explicit) {
  if ($explicit -ne '') { return $explicit }
  return "BITGET:$api.P"
}

function Normalize-CaptureSymbol([string]$tv) {
  # capture_live.js uses the symbol in filenames; strip exchange prefix to avoid ':' in Windows paths.
  return $tv.ToUpper().Replace('BITGET:', '')
}

$ApiSymbol = Normalize-ApiSymbol $Symbol
$EffectiveTvSymbol = Normalize-TvSymbol $ApiSymbol $TvSymbol

if ($CaptureTv -and $TvExportDir -eq '') {
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $TvExportDir = Join-Path $Repo "reports\deep_analysis_tv_exports\${stamp}_${ApiSymbol}"
}

if ($CaptureTv) {
  if (-not (Test-Path $CaptureJs)) {
    throw "TradingView capture script not found: $CaptureJs"
  }
  New-Item -ItemType Directory -Force -Path $TvExportDir | Out-Null
  $captureLog = Join-Path $TvExportDir 'capture.log'
  $captureSymbol = Normalize-CaptureSymbol $EffectiveTvSymbol
  $exports = @()
  $failures = @()

  foreach ($tf in @('1D', '4H', '1H')) {
    $nodeArgs = @(
      $CaptureJs,
      '--symbol', $captureSymbol,
      '--timeframe', $tf,
      '--layout', $CaptureLayout,
      '--chartUrl', $CaptureChartUrl,
      '--preset', 'deep',
      '--panelShot', 'false',
      '--outdir', $TvExportDir,
      '--log', $captureLog
    )
    Push-Location (Split-Path -Parent $TradingViewRoot)
    try {
      $out = & node @nodeArgs 2>&1
      if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
      $exports += [ordered]@{ type = 'screenshot'; timeframe = $tf; path = ($out | Select-Object -First 1); layout = $CaptureLayout; chart_url = $CaptureChartUrl }
    } catch {
      $msg = "${tf}: $($_.Exception.Message)"
      $failures += $msg
      if ($CaptureStrict) { throw "TradingView capture failed: $msg" }
      Write-Warning "TradingView capture failed but continuing because -CaptureStrict was not set: $msg"
    } finally {
      Pop-Location
    }
  }

  $manifest = [ordered]@{
    symbol = $ApiSymbol
    tv_symbol = $EffectiveTvSymbol
    capture_symbol = $captureSymbol
    created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    method = 'existing Playwright/browser capture_live.js'
    chart_url = $CaptureChartUrl
    layout = $CaptureLayout
    exports = $exports
    failures = $failures
    note = 'TradingView evidence is optional validation; Bitget OHLCV remains primary truth.'
  }
  $manifestPath = Join-Path $TvExportDir 'manifest.json'
  $manifestJson = $manifest | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
}

$argsList = @(
  $Script,
  '--symbol', $ApiSymbol,
  '--tv-symbol', $EffectiveTvSymbol,
  '--side', $Side,
  '--family', $Family,
  '--risk-usdt', ([string]$RiskUsdt),
  '--max-margin-usdt', ([string]$MaxMarginUsdt),
  '--planned-leverage', ([string]$PlannedLeverage),
  '--out-root', $OutRoot
)

if (-not [double]::IsNaN($Score)) { $argsList += @('--score', ([string]$Score)) }
if ($Rank -ge 0) { $argsList += @('--rank', ([string]$Rank)) }
if (-not [double]::IsNaN($MaxNotionalUsdt)) { $argsList += @('--max-notional-usdt', ([string]$MaxNotionalUsdt)) }
if ($TvExportDir -ne '') { $argsList += @('--tv-export-dir', $TvExportDir) }
if ($ScreenerDataFile -ne '') { $argsList += @('--screener-data-file', $ScreenerDataFile) }
if ($ExecutionStateJson -ne '') { $argsList += @('--execution-state-json', $ExecutionStateJson) }

Push-Location $Repo
try {
  python @argsList
} finally {
  Pop-Location
}
