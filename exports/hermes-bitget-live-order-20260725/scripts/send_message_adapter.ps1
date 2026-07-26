param(
  [Parameter(Mandatory = $true)]
  [string]$Target,
  [Parameter(Mandatory = $true)]
  [string]$Message
)

$ErrorActionPreference = 'Stop'

function Write-StandardReceipt([string]$MessageId, [string]$Provider) {
  [pscustomobject]@{
    ok = $true
    provider = $Provider
    payload = [pscustomobject]@{
      result = [pscustomobject]@{
        messageId = $MessageId
      }
    }
  } | ConvertTo-Json -Depth 8
}

if ($env:DISCORD_WEBHOOK_URL) {
  $url = [string]$env:DISCORD_WEBHOOK_URL
  $url = if ($url.Contains('?')) { "$url&wait=true" } else { "$url?wait=true" }
  $payload = @{ content = $Message } | ConvertTo-Json -Compress
  $response = Invoke-RestMethod -Method Post -Uri $url -ContentType 'application/json' -Body $payload
  if (-not $response.id) { throw 'Discord webhook send succeeded without a returned message id.' }
  Write-StandardReceipt -MessageId ([string]$response.id) -Provider 'discord-webhook'
  exit 0
}

$openclaw = Get-Command openclaw -ErrorAction SilentlyContinue
if ($openclaw) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $stdout = & openclaw message send --channel discord --target $Target --message $Message --json --verbose 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) { throw "openclaw message send failed with exit code $exitCode." }
  $parsed = ($stdout -join "`n") | ConvertFrom-Json
  $messageId = [string]$parsed.payload.result.messageId
  if (-not $messageId) { throw 'OpenClaw send succeeded without a returned message id.' }
  Write-StandardReceipt -MessageId $messageId -Provider 'openclaw'
  exit 0
}

throw 'No messaging provider is configured. Set DISCORD_WEBHOOK_URL for Hermes, or install/configure the openclaw CLI.'
