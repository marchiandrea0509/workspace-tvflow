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
  # Use a fresh profile per run. The capture script runs headless with software GL/SwiftShader to avoid
  # black GPU screenshots on this host and to avoid visible-profile locking.
  $captureProfile = "profile-deep-headless-$((Get-Date -Format 'yyyyMMddHHmmss'))-$ApiSymbol"
  $exports = @()
  $failures = @()

  foreach ($tf in @('1D', '4H')) {
    $nodeArgs = @(
      $CaptureJs,
      '--symbol', $captureSymbol,
      '--fileSymbol', $captureFileSymbol,
      '--timeframe', $tf,
      '--layout', $CaptureLayout,
      '--chartUrl', $CaptureChartUrl,
      '--preset', 'deep',
      '--panelShot', 'false',
      '--mainPaneOnly', 'true',
      '--focusRecent', 'true',
      '--headless', 'true',
      '--profile', $captureProfile,
      '--outdir', $TvExportDir,
      '--log', $captureLog
    )
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

  # Discord often renders/delivers only one of several screenshot attachments in this workflow.
  # Build a single horizontal 1D | 4H contact sheet and make it the preferred chat artifact.
  # 1H was removed from the default sheet because it made the evidence too small/unusable in Discord.
  $byTf = @{}
  foreach ($item in $exports) { if ($item.type -eq 'screenshot') { $byTf[$item.timeframe] = [string]$item.path } }
  if ($byTf.ContainsKey('1D') -and $byTf.ContainsKey('4H')) {
    $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($ffmpeg) {
      $sheetPath = Join-Path $TvExportDir "${ApiSymbol}_1D_4H_contact_sheet.png"
      $sheetLog = Join-Path $TvExportDir 'contact_sheet_ffmpeg.log'
      $ffArgs = @(
        '-y',
        '-i', $byTf['1D'],
        '-i', $byTf['4H'],
        '-filter_complex', '[0:v]scale=-2:3000[v0];[1:v]scale=-2:3000[v1];[v0][v1]hstack=inputs=2[out]',
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
        $discordSheetPath = Join-Path $TvExportDir "${ApiSymbol}_1D_4H_contact_sheet_discord.png"
        $scaleArgs = @(
          '-y',
          '-i', $sheetPath,
          '-vf', 'scale=6144:-2',
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
          $exports += [ordered]@{ type = 'contact_sheet_discord'; timeframe = '1D|4H'; path = $discordSheetPath; layout = $CaptureLayout; chart_url = $CaptureChartUrl; note = 'Preferred Discord artifact: merged horizontal 1D and 4H screenshot scaled for reliable Discord delivery/readability.' }
        }
        $exports += [ordered]@{ type = 'contact_sheet_fullres'; timeframe = '1D|4H'; path = $sheetPath; layout = $CaptureLayout; chart_url = $CaptureChartUrl; note = 'Full-resolution merged horizontal 1D and 4H screenshot.' }
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
    method = 'existing Playwright/browser capture_live.js'
    chart_url = $CaptureChartUrl
    layout = $CaptureLayout
    exports = $exports
    failures = $failures
    note = 'TradingView evidence is optional validation; Bitget OHLCV remains primary truth. Prefer the merged horizontal 1D|4H contact sheet for Discord delivery/readability.'
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
