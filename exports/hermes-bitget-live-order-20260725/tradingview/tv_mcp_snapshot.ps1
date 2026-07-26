param(
    [string]$OutRoot = "$env:USERPROFILE\OpenClaw_TV_MCP_Snapshots",
    [string]$Region = "chart"
)

$ErrorActionPreference = "Stop"

$mcpDir = Join-Path $PSScriptRoot 'tradingview-mcp'
$cli = "$mcpDir\src\cli\index.js"

if (-not (Test-Path $cli)) {
    throw "TradingView MCP CLI not found: $cli"
}

Write-Host "Checking TradingView debug port..."
try {
    $version = Invoke-RestMethod "http://127.0.0.1:9222/json/version" -TimeoutSec 3
    Write-Host "CDP OK:" $version.Browser
} catch {
    throw "TradingView debug port 9222 is not reachable. Start TradingView Desktop with --remote-debugging-port=9222 first."
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$out = Join-Path $OutRoot $stamp
New-Item -ItemType Directory -Path $out -Force | Out-Null

Push-Location $mcpDir

try {
    Write-Host "Saving MCP snapshot to:"
    Write-Host $out

    node $cli status | Out-File "$out\status.json" -Encoding utf8
    node $cli ohlcv --summary | Out-File "$out\ohlcv_summary.json" -Encoding utf8
    node $cli data tables | Out-File "$out\pine_tables.json" -Encoding utf8

    $shotJson = node $cli screenshot -r $Region
    $shotJson | Out-File "$out\screenshot_result.json" -Encoding utf8

    $shot = $shotJson | ConvertFrom-Json
    if ($shot.success -and (Test-Path $shot.file_path)) {
        Copy-Item $shot.file_path "$out\screenshot.png" -Force
    } else {
        Write-Warning "Screenshot file not found or screenshot failed."
    }

    Write-Host "`nSnapshot complete:"
    Get-ChildItem $out

    Write-Host "`nSnapshot folder:"
    Write-Host $out
}
finally {
    Pop-Location
}
