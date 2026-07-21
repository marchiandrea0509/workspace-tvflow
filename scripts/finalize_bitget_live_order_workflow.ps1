param(
  [Parameter(Mandatory = $true)]
  [string]$PlanPath,
  [Parameter(Mandatory = $true)]
  [string]$Symbols,
  [string]$Target = '1499631210283008002',
  [string]$MessagePrefix = 'Journal refreshed after confirmed Bitget live-order action.',
  [string]$ReceiptOut = '',
  [switch]$NoSend,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$drawScript = 'C:\Users\anmar\tools\tv_draw_trade_plan.ps1'
$snapshotScript = 'C:\Users\anmar\tools\tv_mcp_snapshot.ps1'
$snapshotRoot = Join-Path $workspaceRoot 'reports\tv_mcp_snapshots'
$receiptRoot = Join-Path $workspaceRoot 'reports\live_execution\workflow_receipts'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')

if (-not (Test-Path -LiteralPath $PlanPath)) { throw "Trade-plan JSON not found: $PlanPath" }
if (-not (Test-Path -LiteralPath $drawScript)) { throw "TradingView drawing script not found: $drawScript" }
if (-not (Test-Path -LiteralPath $snapshotScript)) { throw "TradingView snapshot script not found: $snapshotScript" }

$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
$orders = @($plan.orders)
if (-not $plan.symbol) { throw 'Trade-plan JSON is missing symbol.' }
if (-not $plan.timeframe) { throw 'Trade-plan JSON is missing timeframe.' }
if ($orders.Count -lt 1) { throw 'Trade-plan JSON must contain at least one order.' }
foreach ($order in $orders) {
  if (-not $order.name) { throw 'Every drawn order needs a name.' }
  foreach ($field in @('entry', 'sl', 'tp')) {
    $value = $order.$field
    if ($null -eq $value -or -not [double]::TryParse([string]$value, [ref]([double]$parsed = 0))) {
      throw "Order '$($order.name)' has invalid $field value: $value"
    }
  }
  if ([string]$order.kind -ne 'live' -or [string]$order.lineStyle -ne 'solid') {
    throw "Order '$($order.name)' must be kind=live and lineStyle=solid for post-live delivery."
  }
}

if ($ValidateOnly) {
  [pscustomobject]@{
    ok = $true
    mode = 'validate-only'
    symbol = $plan.symbol
    timeframe = $plan.timeframe
    orderCount = $orders.Count
    symbolsForJournal = $Symbols
    deliveryProfile = 'live-order'
  } | ConvertTo-Json -Depth 5
  exit 0
}

try {
  $version = Invoke-RestMethod 'http://127.0.0.1:9222/json/version' -TimeoutSec 3
} catch {
  throw 'TradingView Desktop MCP is not reachable on port 9222. Please check whether TradingView Desktop opened correctly.'
}
if (-not $version.webSocketDebuggerUrl) { throw 'TradingView Desktop MCP did not return webSocketDebuggerUrl.' }

$drawOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $drawScript -PlanPath $PlanPath 2>&1
$drawExit = $LASTEXITCODE
$drawText = $drawOutput -join "`n"
Write-Output $drawText
if ($drawExit -ne 0) { throw "TradingView drawing failed with exit code $drawExit." }
$entityCount = ([regex]::Matches($drawText, '"entity_id"')).Count
$expectedEntityCount = ($orders.Count * 3) + 1
if ($entityCount -lt $expectedEntityCount) {
  throw "TradingView drawing receipt is incomplete: expected at least $expectedEntityCount entities, got $entityCount."
}

New-Item -ItemType Directory -Force -Path $snapshotRoot | Out-Null
$snapshotOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $snapshotScript -OutRoot $snapshotRoot -Region chart 2>&1
$snapshotExit = $LASTEXITCODE
Write-Output ($snapshotOutput -join "`n")
if ($snapshotExit -ne 0) { throw "TradingView snapshot failed with exit code $snapshotExit." }
$snapshotDirs = @(Get-ChildItem -LiteralPath $snapshotRoot -Directory | Sort-Object LastWriteTime -Descending)
if ($snapshotDirs.Count -lt 1) { throw 'TradingView snapshot folder was not created.' }
$snapshotPath = Join-Path $snapshotDirs[0].FullName 'screenshot.png'
$snapshotFile = Get-Item -LiteralPath $snapshotPath -ErrorAction Stop
if ($snapshotFile.Length -le 0) { throw "TradingView screenshot is empty: $snapshotPath" }

New-Item -ItemType Directory -Force -Path $receiptRoot | Out-Null
$journalReceipt = Join-Path $receiptRoot "${stamp}_journal.json"
$journalArgs = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $PSScriptRoot 'run_bitget_journal_update.ps1'),
  '-Symbols', $Symbols,
  '-Target', $Target,
  '-MessagePrefix', $MessagePrefix,
  '-DeliveryProfile', 'live-order',
  '-ReceiptOut', $journalReceipt
)
if ($NoSend) { $journalArgs += '-NoSend' }
$journalOutput = & powershell @journalArgs 2>&1
$journalExit = $LASTEXITCODE
Write-Output ($journalOutput -join "`n")
if ($journalExit -ne 0) { throw "Journal refresh/delivery failed with exit code $journalExit." }
if (-not (Test-Path -LiteralPath $journalReceipt)) { throw 'Journal receipt was not created.' }
$journal = Get-Content -LiteralPath $journalReceipt -Raw | ConvertFrom-Json
if (-not $journal.ok) { throw 'Journal receipt did not report ok=true.' }
if (-not $NoSend -and @($journal.sentMessageIds).Count -lt 1) {
  throw 'Journal delivery did not return a Discord messageId.'
}

if (-not $ReceiptOut) { $ReceiptOut = Join-Path $receiptRoot "${stamp}_live_order_workflow.json" }
$receipt = [pscustomobject]@{
  ok = $true
  completedAt = (Get-Date).ToUniversalTime().ToString('o')
  symbol = $plan.symbol
  timeframe = $plan.timeframe
  orderCount = $orders.Count
  orders = $orders
  tradingView = [pscustomobject]@{
    entityCount = $entityCount
    screenshot = $snapshotPath
  }
  journal = [pscustomobject]@{
    workbookSnapshot = $journal.workbookSnapshot
    sent = $journal.sent
    sentMessageIds = @($journal.sentMessageIds)
    receipt = $journalReceipt
  }
}
$receiptJson = $receipt | ConvertTo-Json -Depth 12
$receiptDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($ReceiptOut))
if ($receiptDir) { New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null }
Set-Content -LiteralPath $ReceiptOut -Value $receiptJson -Encoding utf8
$receiptJson
