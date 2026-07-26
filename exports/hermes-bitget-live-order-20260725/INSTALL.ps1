$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

foreach ($command in @('node', 'npm', 'python', 'powershell')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $command"
  }
}

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) { throw "Node.js 18+ is required; found $(node --version)." }

$mcpDir = Join-Path $root 'tradingview\tradingview-mcp'
if (-not (Test-Path -LiteralPath (Join-Path $mcpDir 'package-lock.json'))) {
  throw "TradingView MCP package-lock.json not found: $mcpDir"
}

Push-Location $mcpDir
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$envExample = Join-Path $root 'bitget-futures-harness\.env.example'
$envLocal = Join-Path $root 'bitget-futures-harness\.env.local'
if (-not (Test-Path -LiteralPath $envLocal)) {
  Copy-Item -LiteralPath $envExample -Destination $envLocal
  Write-Host "Created credential template: $envLocal"
} else {
  Write-Host "Preserved existing credential file: $envLocal"
}

Write-Host ''
Write-Host 'INSTALL_OK'
Write-Host 'Next: edit bitget-futures-harness\.env.local, keep demo mode enabled, then run validate_package.ps1.'
