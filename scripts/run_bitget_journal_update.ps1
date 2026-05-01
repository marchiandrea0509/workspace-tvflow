param(
  [string]$Target = '1499631210283008002',
  [string]$Since = '2020-01-01',
  [string]$Symbols = 'GOOGLUSDT,GMEUSDT',
  [string]$MessagePrefix = '',
  [switch]$NoSend,
  [switch]$Strict
)

$ErrorActionPreference = 'Stop'

function SafeStamp {
  return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
}

function Parse-Symbols([string]$Raw) {
  if (-not $Raw) { return @() }
  return @($Raw -split '[,\s]+' | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim().ToUpperInvariant() } | Select-Object -Unique)
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$stamp = SafeStamp
$reportDir = Join-Path $root 'reports\trade_journal'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$historyLatest = Join-Path $reportDir 'raw_bitget_history_latest.json'
$historyStamped = Join-Path $reportDir "raw_bitget_history_$stamp.json"
$positionsLatest = Join-Path $reportDir 'raw_positions_latest.json'
$positionsStamped = Join-Path $reportDir "raw_positions_$stamp.json"
$workbookLatest = Join-Path $reportDir 'bitget_futures_trade_report_latest.xls'
$workbookStamped = Join-Path $reportDir "bitget_futures_trade_report_$stamp.xls"
$csvLatest = Join-Path $reportDir 'bitget_futures_order_history_latest.csv'
$csvStamped = Join-Path $reportDir "bitget_futures_order_history_$stamp.csv"
$messagesLatest = Join-Path $reportDir 'bitget_thread_messages_latest.json'
$messagesStamped = Join-Path $reportDir "bitget_thread_messages_$stamp.json"

& node bitget-futures-harness\scripts\export-history-mirror.js --since $Since --out $historyLatest
if ($LASTEXITCODE -ne 0) { throw "export-history-mirror.js failed with exit code $LASTEXITCODE" }
Copy-Item $historyLatest $historyStamped -Force

& node bitget-futures-harness\scripts\positions.js > $positionsLatest
if ($LASTEXITCODE -ne 0) { throw "positions.js failed with exit code $LASTEXITCODE" }
Copy-Item $positionsLatest $positionsStamped -Force

# Include explicit tracked symbols plus any currently open position symbols.
$tracked = Parse-Symbols $Symbols
try {
  $posJson = Get-Content $positionsLatest -Raw | ConvertFrom-Json
  $posSymbols = @($posJson.result.data | ForEach-Object { $_.symbol } | Where-Object { $_ })
  $tracked = @($tracked + $posSymbols | Select-Object -Unique)
} catch {}

$openOrderFiles = @()
foreach ($sym in $tracked) {
  $safe = $sym -replace '[^A-Z0-9_\-]', '_'
  $openLatest = Join-Path $reportDir "raw_open_orders_${safe}_latest.json"
  $openStamped = Join-Path $reportDir "raw_open_orders_${safe}_$stamp.json"
  & node bitget-futures-harness\scripts\list-open-orders.js --symbol $sym > $openLatest
  if ($LASTEXITCODE -ne 0) {
    if ($Strict) { throw "list-open-orders.js failed for $sym with exit code $LASTEXITCODE" }
    continue
  }
  Copy-Item $openLatest $openStamped -Force
  $openOrderFiles += $openLatest
}

$openArgs = @()
foreach ($f in $openOrderFiles) { $openArgs += @('--open-orders-json', $f) }

& python scripts\build_bitget_trade_report.py --history-json $historyLatest @openArgs --positions-json $positionsLatest --out-xls $workbookLatest --out-csv $csvLatest
if ($LASTEXITCODE -ne 0) { throw "build_bitget_trade_report.py failed with exit code $LASTEXITCODE" }
Copy-Item $workbookLatest $workbookStamped -Force
Copy-Item $csvLatest $csvStamped -Force

& python scripts\build_bitget_thread_messages.py --history-json $historyLatest @openArgs --positions-json $positionsLatest --workbook $workbookLatest --out $messagesLatest
if ($LASTEXITCODE -ne 0) { throw "build_bitget_thread_messages.py failed with exit code $LASTEXITCODE" }
Copy-Item $messagesLatest $messagesStamped -Force

$sentIds = @()
if (-not $NoSend) {
  $payload = Get-Content $messagesLatest -Raw | ConvertFrom-Json
  foreach ($msg in $payload.messages) {
    $body = if ($MessagePrefix) { "$MessagePrefix`n$msg" } else { [string]$msg }
    $raw = & openclaw message send --channel discord --target $Target --message $body --json --verbose
    if ($LASTEXITCODE -ne 0) { throw "openclaw message send failed with exit code $LASTEXITCODE`n$raw" }
    try {
      $parsed = ($raw -join "`n") | ConvertFrom-Json
      $sentIds += $parsed.payload.result.messageId
    } catch {}
  }
}

$history = Get-Content $historyLatest -Raw | ConvertFrom-Json
$summary = @($history.results | ForEach-Object { [pscustomobject]@{ label = $_.label; ok = $_.ok; count = $_.count } })

[pscustomobject]@{
  ok = $true
  modelRecommended = 'gpt-nano for normal refresh; gpt-mini only if API/reporting fails'
  target = $Target
  since = $Since
  trackedSymbols = $tracked
  historySummary = $summary
  workbook = $workbookLatest
  workbookSnapshot = $workbookStamped
  csv = $csvLatest
  messages = $messagesLatest
  messagesSnapshot = $messagesStamped
  sent = -not [bool]$NoSend
  sentMessageIds = $sentIds
} | ConvertTo-Json -Depth 8
