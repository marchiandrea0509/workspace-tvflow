$ErrorActionPreference = 'Stop'

$target = '1487602980093165658'
$replyTo = '1501456980965982238'
$symbolsFile = 'C:\Users\anmar\.openclaw\workspace-tvflow\tmp\bitget_tradfi_19_strategy_symbols_2026-05-06.txt'
$exportScript = 'C:\Users\anmar\.openclaw\workspace\tradingview\scripts\export_strategy_test_symbols_csv.js'
$reportsRoot = 'C:\Users\anmar\.openclaw\workspace\tradingview\reports\strategy_test_watchlist_csv'
$zipRoot = 'C:\Users\anmar\.openclaw\workspace-tvflow'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$outDir = Join-Path $reportsRoot "BITGET_TRADFI_subset_wait10_$stamp"
$retryDir = Join-Path $reportsRoot "BITGET_TRADFI_subset_wait10_retry_$stamp"
$zipPath = Join-Path $zipRoot "BITGET_TRADFI_strategy_test_subset_wait10_$stamp.zip"

function Invoke-ExportRun {
  param(
    [string]$SymbolsPath,
    [string]$OutputDir
  )
  & node $exportScript --watchlist BITGET_TRADFI --exchange BITGET --outdir $OutputDir --export-attempts 5 --symbols-file $SymbolsPath --post-export-wait-ms 10000
  if ($LASTEXITCODE -ne 0) { throw "export_strategy_test_symbols_csv.js failed with exit code $LASTEXITCODE" }
  $manifestPath = Join-Path $OutputDir 'manifest.json'
  if (-not (Test-Path $manifestPath)) { throw "Manifest missing: $manifestPath" }
  return (Get-Content $manifestPath -Raw | ConvertFrom-Json)
}

function Get-SafeName([string]$s) {
  return ($s -replace '[^a-zA-Z0-9._-]+', '_')
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$manifest = Invoke-ExportRun -SymbolsPath $symbolsFile -OutputDir $outDir

$failed = @($manifest.results | Where-Object { -not $_.ok } | ForEach-Object { $_.symbol })
if ($failed.Count -gt 0) {
  New-Item -ItemType Directory -Force -Path $retryDir | Out-Null
  $retrySymbolsFile = Join-Path $retryDir 'retry_failed_symbols.txt'
  Set-Content -Path $retrySymbolsFile -Value ($failed -join "`n") -Encoding ascii
  $retryManifest = Invoke-ExportRun -SymbolsPath $retrySymbolsFile -OutputDir $retryDir

  foreach ($r in @($retryManifest.results | Where-Object { $_.ok })) {
    $safe = Get-SafeName $r.symbol
    $src = [string]$r.csvPath
    $dst = Join-Path $outDir "${safe}_strategy_test_4h.csv"
    Copy-Item -Path $src -Destination $dst -Force
    $r.csvPath = $dst
    $r | Add-Member -NotePropertyName retried -NotePropertyValue $true -Force
    for ($i = 0; $i -lt $manifest.results.Count; $i++) {
      if ($manifest.results[$i].symbol -eq $r.symbol) {
        $manifest.results[$i] = $r
        break
      }
    }
  }

  Copy-Item -Path (Join-Path $retryDir 'manifest.json') -Destination (Join-Path $outDir 'retry_manifest.json') -Force
  $manifest.okCount = @($manifest.results | Where-Object { $_.ok }).Count
  $manifest.failCount = @($manifest.results | Where-Object { -not $_.ok }).Count
  $manifest | Add-Member -NotePropertyName retryDir -NotePropertyValue $retryDir -Force
  $manifest | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $outDir 'manifest.json') -Encoding utf8
}

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $outDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
if (-not (Test-Path $zipPath)) { throw "Zip creation failed: $zipPath" }

$failedFinal = @($manifest.results | Where-Object { -not $_.ok } | ForEach-Object { $_.symbol })
$summary = if ($failedFinal.Count -gt 0) {
  "$($manifest.okCount) charts exported, $($manifest.failCount) failed: $($failedFinal -join ', ')."
} else {
  "$($manifest.okCount) charts exported, 0 failed."
}

$sendArgs = @(
  'message', 'send',
  '--channel', 'discord',
  '--target', $target,
  '--reply-to', $replyTo,
  '--message', "Strategy Test CSV export zip attached: $summary",
  '--media', $zipPath,
  '--json',
  '--verbose'
)
$raw = & openclaw @sendArgs
if ($LASTEXITCODE -ne 0) { throw "openclaw message send failed with exit code $LASTEXITCODE`n$raw" }
$sendPayload = ($raw -join "`n")
$messageId = $null
try { $messageId = ($sendPayload | ConvertFrom-Json).payload.result.messageId } catch {}

[pscustomobject]@{
  ok = ($failedFinal.Count -eq 0)
  outDir = $outDir
  retryDir = if (Test-Path $retryDir) { $retryDir } else { $null }
  zipPath = $zipPath
  zipSize = (Get-Item $zipPath).Length
  requested = $manifest.requestedSymbols.Count
  okCount = [int]$manifest.okCount
  failCount = [int]$manifest.failCount
  failedSymbols = $failedFinal
  sent = $true
  discordMessageId = $messageId
  manifestPath = (Join-Path $outDir 'manifest.json')
} | ConvertTo-Json -Depth 8

if ($failedFinal.Count -gt 0) { exit 2 }
