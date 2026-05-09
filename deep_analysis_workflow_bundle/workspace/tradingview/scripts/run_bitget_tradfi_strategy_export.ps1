param(
  [string]$Target = '1487602980093165658',
  [string]$ReplyTo = '',
  [string]$SourceCsv = '',
  [string]$Symbols = '',
  [string]$SymbolsFile = '',
  [string]$ZipDir = 'C:\Users\anmar\.openclaw\workspace-tvflow',
  [string]$MessagePrefix = 'BITGET_TRADFI strategy-test CSV export zip attached.',
  [int]$ExportAttempts = 4,
  [switch]$NoSend,
  [switch]$DryRun,
  [switch]$Strict
)

$ErrorActionPreference = 'Stop'

function Resolve-LatestPineScreenerCsv {
  param([string]$ReportsDir)
  $csv = Get-ChildItem $ReportsDir -Filter 'pine_screener_*.csv' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $csv) { throw "No pine_screener_*.csv found under $ReportsDir" }
  return $csv.FullName
}

function ConvertTo-SafeStamp {
  return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tradingviewRoot = Split-Path -Parent $scriptDir
$workspaceRoot = Split-Path -Parent $tradingviewRoot
$reportsRoot = Join-Path $tradingviewRoot 'reports\strategy_test_watchlist_csv'
$pineReports = Join-Path $tradingviewRoot 'reports\pine_screener'
$exportScript = Join-Path $tradingviewRoot 'scripts\export_strategy_test_symbols_csv.js'

if (-not (Test-Path $exportScript)) { throw "Missing export script: $exportScript" }
if ($Symbols -and $SymbolsFile) { throw 'Use either -Symbols or -SymbolsFile, not both.' }
if ($SymbolsFile -and -not (Test-Path $SymbolsFile)) { throw "Symbols file not found: $SymbolsFile" }
if (-not $Symbols -and -not $SymbolsFile) {
  if (-not $SourceCsv) { $SourceCsv = Resolve-LatestPineScreenerCsv -ReportsDir $pineReports }
  if (-not (Test-Path $SourceCsv)) { throw "Source CSV not found: $SourceCsv" }
}
if (-not (Test-Path $ZipDir)) { New-Item -ItemType Directory -Force -Path $ZipDir | Out-Null }

$stamp = ConvertTo-SafeStamp
$outDirSuffix = if ($Symbols -or $SymbolsFile) { "BITGET_TRADFI_subset_$stamp" } else { "BITGET_TRADFI_$stamp" }
$zipName = if ($Symbols -or $SymbolsFile) { "BITGET_TRADFI_strategy_test_subset_$stamp.zip" } else { "BITGET_TRADFI_strategy_test_csv_$stamp.zip" }
$outDir = Join-Path $reportsRoot $outDirSuffix
$zipPath = Join-Path $ZipDir $zipName

if ($DryRun) {
  [pscustomobject]@{
    ok = $true
    dryRun = $true
    model = 'openai-codex/gpt-5.4-nano'
    sourceCsv = $SourceCsv
    symbols = $Symbols
    symbolsFile = $SymbolsFile
    exportScript = $exportScript
    exportAttempts = $ExportAttempts
    outDir = $outDir
    zipPath = $zipPath
    target = $Target
    noSend = [bool]$NoSend
  } | ConvertTo-Json -Depth 6
  exit 0
}

$nodeArgs = @('tradingview/scripts/export_strategy_test_symbols_csv.js', '--watchlist', 'BITGET_TRADFI', '--exchange', 'BITGET', '--outdir', $outDir, '--export-attempts', $ExportAttempts)
if ($Symbols) {
  $nodeArgs += @('--symbols', $Symbols)
} elseif ($SymbolsFile) {
  $nodeArgs += @('--symbols-file', $SymbolsFile)
} else {
  $nodeArgs += @('--symbols-csv', $SourceCsv)
}

Push-Location $workspaceRoot
try {
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "export_strategy_test_symbols_csv.js failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$manifestPath = Join-Path $outDir 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "Manifest missing: $manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $outDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
if (-not (Test-Path $zipPath)) { throw "Zip creation failed: $zipPath" }

$failed = @($manifest.results | Where-Object { -not $_.ok } | ForEach-Object { $_.symbol })
$summary = if ($failed.Count -gt 0) {
  "$($manifest.okCount) charts exported, $($manifest.failCount) failed/empty: $($failed -join ', ')."
} else {
  "$($manifest.okCount) charts exported, 0 failed."
}

$messageId = $null
$sendPayload = $null
if (-not $NoSend) {
  $args = @(
    'message', 'send',
    '--channel', 'discord',
    '--target', $Target,
    '--message', "$MessagePrefix $summary",
    '--media', $zipPath,
    '--json',
    '--verbose'
  )
  if ($ReplyTo) { $args += @('--reply-to', $ReplyTo) }
  $raw = & openclaw @args
  if ($LASTEXITCODE -ne 0) { throw "openclaw message send failed with exit code $LASTEXITCODE`n$raw" }
  $sendPayload = ($raw -join "`n")
  try {
    $parsed = $sendPayload | ConvertFrom-Json
    $messageId = $parsed.payload.result.messageId
  } catch {}
}

$ok = if ($Strict) { [int]$manifest.failCount -eq 0 } else { $true }
$result = [pscustomobject]@{
  ok = $ok
  model = 'openai-codex/gpt-5.4-nano'
  sourceCsv = $SourceCsv
  symbols = $Symbols
  symbolsFile = $SymbolsFile
  outDir = $outDir
  zipPath = $zipPath
  zipSize = (Get-Item $zipPath).Length
  requested = $manifest.requestedSymbols.Count
  okCount = [int]$manifest.okCount
  failCount = [int]$manifest.failCount
  failedSymbols = $failed
  sent = -not [bool]$NoSend
  discordMessageId = $messageId
  manifestPath = $manifestPath
}

$result | ConvertTo-Json -Depth 8
if (-not $ok) { exit 2 }
