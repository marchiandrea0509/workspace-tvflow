param(
  [switch]$ArchiveClean
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$required = @(
  'README_HERMES_TRANSFER.md',
  'HERMES_SKILL_PROPOSAL.md',
  'bitget-futures-harness\.env.example',
  'bitget-futures-harness\lib\bitgetClient.js',
  'bitget-futures-harness\lib\liquidityGate.js',
  'bitget-futures-harness\scripts\place-order.js',
  'scripts\finalize_bitget_live_order_workflow.ps1',
  'scripts\run_bitget_journal_update.ps1',
  'scripts\send_message_adapter.ps1',
  'tradingview\tv_draw_trade_plan.ps1',
  'tradingview\tv_mcp_snapshot.ps1',
  'tradingview\tradingview-mcp\src\cli\index.js',
  'templates\trade_plan.json',
  'examples\aapl-live-order\workflow_receipt.json',
  'examples\aapl-live-order\tradingview-screenshot.png',
  'examples\journal\bitget_futures_trade_report_latest.xls'
)

foreach ($rel in $required) {
  $path = Join-Path $root $rel
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing required file: $rel" }
  $item = Get-Item -LiteralPath $path
  if (-not $item.PSIsContainer -and $item.Length -le 0) { throw "Empty required file: $rel" }
}

if ($ArchiveClean) {
  $forbidden = Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object {
    $_.Name -eq '.env.local' -or $_.Name -eq 'node_modules' -or $_.Name -eq '.git'
  }
  if ($forbidden) {
    throw "Forbidden archive path(s): $($forbidden.FullName -join ', ')"
  }
}

$secretPatterns = @(
  'BITGET_API_KEY\s*=\s*(?!PASTE_)',
  'BITGET_API_SECRET\s*=\s*(?!PASTE_)',
  'BITGET_API_PASSPHRASE\s*=\s*(?!PASTE_)',
  'discord\.com/api/webhooks/\d+/'
)
$textFiles = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object {
  $_.Extension -in @('.js', '.json', '.md', '.ps1', '.cmd', '.py', '.txt', '.example') -or $_.Name -eq '.env.example'
}
foreach ($file in $textFiles) {
  $text = Get-Content -LiteralPath $file.FullName -Raw
  foreach ($pattern in $secretPatterns) {
    if ($text -match $pattern) { throw "Potential secret in $($file.FullName): $pattern" }
  }
}

$jsFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $root 'bitget-futures-harness') -Recurse -File -Filter '*.js'
  Get-ChildItem -LiteralPath (Join-Path $root 'tradingview\tradingview-mcp\src') -Recurse -File -Filter '*.js'
)
foreach ($file in $jsFiles) {
  & node --check $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed: $($file.FullName)" }
}

$pythonFiles = Get-ChildItem -LiteralPath (Join-Path $root 'scripts') -File -Filter '*.py'
foreach ($file in $pythonFiles) {
  & python -c "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))" $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "Python syntax check failed: $($file.FullName)" }
}

$psFiles = Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.ps1'
foreach ($file in $psFiles) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) { throw "PowerShell parse failed: $($file.FullName): $($errors[0].Message)" }
}

$jsonFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $root 'templates') -Recurse -File -Filter '*.json'
  Get-ChildItem -LiteralPath (Join-Path $root 'examples\aapl-live-order') -Recurse -File -Filter '*.json'
)
foreach ($file in $jsonFiles) {
  Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json | Out-Null
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\finalize_bitget_live_order_workflow.ps1') `
  -PlanPath (Join-Path $root 'templates\trade_plan.json') `
  -Symbols 'AAPLUSDT' `
  -ValidateOnly | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Finalizer ValidateOnly failed with exit code $LASTEXITCODE." }

Write-Host "VALIDATION_PASS files=$((Get-ChildItem -LiteralPath $root -Recurse -File).Count)"
