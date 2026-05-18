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
  # Screenshots are now the default deep-analysis evidence path. Use -NoCaptureTv only for explicit OHLCV-only/debug runs.
  [switch]$CaptureTv = $true,
  [switch]$NoCaptureTv,
  [switch]$CaptureStrict,
  [ValidateSet('Auto','Web','DesktopCdp')][string]$CaptureBackend = 'Auto',
  [string]$CaptureLayout = 'Openclaw-structure',
  [string]$CaptureChartUrl = 'https://www.tradingview.com/chart/0ZPSKaZ4/'
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $PSScriptRoot 'build_deep_analysis_packet_v2.py'
$TradingViewRoot = Join-Path (Split-Path -Parent $Repo) 'workspace\tradingview'
$CaptureJs = Join-Path $TradingViewRoot 'scripts\capture_live.js'
$CaptureDesktopCdpJs = Join-Path $TradingViewRoot 'scripts\capture_live_desktop_cdp.js'

function Test-DesktopCdpAvailable() {
  try {
    $res = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3
    return [bool]$res.webSocketDebuggerUrl
  } catch {
    return $false
  }
}

function Normalize-ApiSymbol([string]$s) {
  $x = $s.ToUpper().Replace('BITGET:', '').Replace('.P', '')
  return $x
}

function Normalize-TvSymbol([string]$api, [string]$explicit) {
  if ($explicit -ne '') { return $explicit }
  return "BITGET:$api.P"
}

function Normalize-CaptureSymbol([string]$tv) {
  # Keep the exchange prefix for TradingView routing; capture_live.js now has a separate safe --fileSymbol.
  return $tv.ToUpper()
}

function Normalize-CaptureFileSymbol([string]$tv) {
  return $tv.ToUpper().Replace('BITGET:', '')
}

function Test-CaptureImageUsable([string]$path) {
  if (-not (Test-Path $path)) { return $false }
  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue | Out-Null
    $bmp = [System.Drawing.Bitmap]::new((Resolve-Path $path))
    try {
      $w = $bmp.Width; $h = $bmp.Height
      $step = [Math]::Max(1, [int]([Math]::Min($w, $h) / 120))
      $n = 0; $dark = 0; $sum = 0.0
      for ($y = 0; $y -lt $h; $y += $step) {
        for ($x = 0; $x -lt $w; $x += $step) {
          $c = $bmp.GetPixel($x, $y)
          $lum = ($c.R + $c.G + $c.B) / 3.0
          $sum += $lum; $n++
          if ($c.R -lt 35 -and $c.G -lt 35 -and $c.B -lt 35) { $dark++ }
        }
      }
      if ($n -le 0) { return $false }
      $mean = $sum / $n
      $darkRatio = $dark / $n
      # TradingView dark theme is naturally dark, but fully broken captures are near-black.
      return ($mean -ge 12.0 -and $darkRatio -le 0.94)
    } finally {
      $bmp.Dispose()
    }
  } catch {
    # If validation itself fails, do not block capture; return true so the original file is preserved.
    return $true
  }
}

$ApiSymbol = Normalize-ApiSymbol $Symbol
$EffectiveTvSymbol = Normalize-TvSymbol $ApiSymbol $TvSymbol
if ($NoCaptureTv) { $CaptureTv = $false }

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
  $captureFileSymbol = Normalize-CaptureFileSymbol $EffectiveTvSymbol
  # Use a fresh profile per run for web fallback. This avoids visible-profile locking, but protected/private
  # TradingView studies can show red exclamation marks and fail to render in that fresh headless profile.
  # For Openclaw-structure evidence, prefer the logged-in TradingView Desktop CDP session when available.
  $captureProfile = "profile-deep-headless-$((Get-Date -Format 'yyyyMMddHHmmss'))-$ApiSymbol"
  $desktopAvailable = Test-DesktopCdpAvailable
  $useDesktopCdp = ($CaptureBackend -eq 'DesktopCdp') -or (($CaptureBackend -eq 'Auto') -and $desktopAvailable -and (Test-Path $CaptureDesktopCdpJs))
  if ($CaptureBackend -eq 'DesktopCdp' -and -not $desktopAvailable) { throw 'TradingView Desktop CDP is not reachable on port 9222.' }
  if ($CaptureBackend -eq 'DesktopCdp' -and -not (Test-Path $CaptureDesktopCdpJs)) { throw "TradingView Desktop CDP capture script not found: $CaptureDesktopCdpJs" }
  if ($CaptureBackend -eq 'Auto' -and $desktopAvailable -and -not (Test-Path $CaptureDesktopCdpJs)) {
    Write-Warning "TradingView Desktop CDP is reachable but capture script is missing; falling back to web capture: $CaptureDesktopCdpJs"
  }
  $exports = @()
  $failures = @()

  foreach ($tf in @('1D', '4H', '1H')) {
    if ($useDesktopCdp) {
      $nodeArgs = @(
        $CaptureDesktopCdpJs,
        '--symbol', $captureSymbol,
        '--fileSymbol', $captureFileSymbol,
        '--timeframe', $tf,
        '--layout', $CaptureLayout,
        '--chartUrl', $CaptureChartUrl,
        '--outdir', $TvExportDir
      )
    } else {
      $nodeArgs = @(
        $CaptureJs,
        '--symbol', $captureSymbol,
        '--fileSymbol', $captureFileSymbol,
        '--timeframe', $tf,
        '--layout', $CaptureLayout,
        '--chartUrl', $CaptureChartUrl,
        '--preset', 'deep',
        '--panelShot', 'false',
        '--mainPaneOnly', 'false',
        '--focusRecent', 'true',
        '--headless', 'true',
        '--profile', $captureProfile,
        '--outdir', $TvExportDir,
        '--log', $captureLog
      )
    }
    Push-Location (Split-Path -Parent $TradingViewRoot)
    try {
      $out = & node @nodeArgs 2>&1
      if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
      $capturePath = [string]($out | Select-Object -First 1)
      if (-not (Test-CaptureImageUsable $capturePath)) { throw "TradingView capture appears black/unusable: $capturePath" }
      $exports += [ordered]@{ type = 'screenshot'; timeframe = $tf; path = $capturePath; layout = $CaptureLayout; chart_url = $CaptureChartUrl }
    } catch {
      $msg = "${tf}: $($_.Exception.Message)"
      $failures += $msg
      if ($CaptureStrict) { throw "TradingView capture failed: $msg" }
      Write-Warning "TradingView capture failed but continuing because -CaptureStrict was not set: $msg"
    } finally {
      Pop-Location
    }
  }

  # Keep a merged preview sheet for fallback/debug, but the final prompt now requires
  # explicit 1D, 4H, and 1H screenshot reads. Discord delivery is handled later by
  # the builder as separate follow-up messages with only full-resolution 4H and 1D.
  $byTf = @{}
  foreach ($item in $exports) { if ($item.type -eq 'screenshot') { $byTf[$item.timeframe] = [string]$item.path } }
  if ($byTf.ContainsKey('1D') -and $byTf.ContainsKey('4H') -and $byTf.ContainsKey('1H')) {
    $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($ffmpeg) {
      $sheetPath = Join-Path $TvExportDir "${ApiSymbol}_1D_4H_1H_contact_sheet.png"
      $sheetLog = Join-Path $TvExportDir 'contact_sheet_ffmpeg.log'
      $ffArgs = @(
        '-y',
        '-i', $byTf['1D'],
        '-i', $byTf['4H'],
        '-i', $byTf['1H'],
        '-filter_complex', '[0:v]scale=-2:3000[v0];[1:v]scale=-2:3000[v1];[2:v]scale=-2:3000[v2];[v0][v1][v2]hstack=inputs=3[out]',
        '-map', '[out]',
        '-frames:v', '1',
        $sheetPath
      )
      $oldEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        $ffOut = & ffmpeg @ffArgs 2>&1
        $ffExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $oldEap
      }
      [System.IO.File]::WriteAllText($sheetLog, ($ffOut | Out-String), [System.Text.UTF8Encoding]::new($false))
      if ($ffExitCode -eq 0 -and (Test-Path $sheetPath)) {
        $discordSheetPath = Join-Path $TvExportDir "${ApiSymbol}_1D_4H_1H_contact_sheet_discord.png"
        $scaleArgs = @(
          '-y',
          '-i', $sheetPath,
          '-vf', 'scale=9216:-2',
          '-frames:v', '1',
          $discordSheetPath
        )
        $oldEap2 = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
          $scaleOut = & ffmpeg @scaleArgs 2>&1
          $scaleExitCode = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $oldEap2
        }
        [System.IO.File]::AppendAllText($sheetLog, "`n=== discord-scale ===`n" + ($scaleOut | Out-String), [System.Text.UTF8Encoding]::new($false))
        if ($scaleExitCode -eq 0 -and (Test-Path $discordSheetPath)) {
          $exports += [ordered]@{ type = 'contact_sheet_discord'; timeframe = '1D|4H|1H'; path = $discordSheetPath; layout = $CaptureLayout; chart_url = $CaptureChartUrl; note = 'Fallback Discord preview: merged horizontal 1D, 4H, and 1H screenshot. Prefer individual timeframe screenshots for final evidence when possible.' }
        }
        $exports += [ordered]@{ type = 'contact_sheet_fullres'; timeframe = '1D|4H|1H'; path = $sheetPath; layout = $CaptureLayout; chart_url = $CaptureChartUrl; note = 'Full-resolution merged horizontal 1D, 4H, and 1H screenshot.' }
      } else {
        $failures += "contact_sheet: ffmpeg failed; see $sheetLog"
        if ($CaptureStrict) { throw "TradingView contact sheet generation failed; see $sheetLog" }
        Write-Warning "TradingView contact sheet generation failed but continuing; see $sheetLog"
      }
    } else {
      $failures += 'contact_sheet: ffmpeg not found'
      if ($CaptureStrict) { throw 'TradingView contact sheet generation failed: ffmpeg not found' }
      Write-Warning 'TradingView contact sheet generation skipped because ffmpeg was not found.'
    }
  }

  $manifest = [ordered]@{
    symbol = $ApiSymbol
    tv_symbol = $EffectiveTvSymbol
    capture_symbol = $captureSymbol
    capture_file_symbol = $captureFileSymbol
    created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    method = if ($useDesktopCdp) { 'TradingView Desktop CDP capture_live_desktop_cdp.js' } else { 'existing Playwright/browser capture_live.js' }
    capture_backend = if ($useDesktopCdp) { 'DesktopCdp' } else { 'Web' }
    desktop_cdp_available = $desktopAvailable
    chart_url = $CaptureChartUrl
    layout = $CaptureLayout
    exports = $exports
    failures = $failures
    note = 'Screenshot-first deep analysis evidence. Analyze visible 1D, 4H, and 1H chart structure first; use Bitget OHLCV/ticker/execution to validate numbers and feasibility. For Discord delivery, send analysis text first, then separate full-resolution 4H and 1D screenshots only; use the merged 1D|4H|1H sheet only as fallback/preview.'
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
