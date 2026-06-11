param(
  [Parameter(Mandatory=$true)][string]$Symbol,
  [string]$ProductType = 'usdt-futures',
  [string]$Granularity = '1H',
  [Parameter(Mandatory=$true)][string]$StartUtc,
  [string]$OutDir = 'reports/bitget_exports',
  [int]$Limit = 200,
  [int]$PauseMs = 350
)

$ErrorActionPreference = 'Stop'

function Get-StepMs([string]$g) {
  switch -Regex ($g) {
    '^1m$' { return 60 * 1000 }
    '^3m$' { return 3 * 60 * 1000 }
    '^5m$' { return 5 * 60 * 1000 }
    '^15m$' { return 15 * 60 * 1000 }
    '^30m$' { return 30 * 60 * 1000 }
    '^1H$' { return 60 * 60 * 1000 }
    '^2H$' { return 2 * 60 * 60 * 1000 }
    '^4H$' { return 4 * 60 * 60 * 1000 }
    '^6H$' { return 6 * 60 * 60 * 1000 }
    '^12H$' { return 12 * 60 * 60 * 1000 }
    '^1D$' { return 24 * 60 * 60 * 1000 }
    default { throw "Unsupported granularity for integrity check: $g" }
  }
}

$root = (Resolve-Path '.').Path
$outDirAbs = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }
New-Item -ItemType Directory -Force -Path $outDirAbs | Out-Null

$startMs = ([DateTimeOffset]::Parse($StartUtc).ToUniversalTime()).ToUnixTimeMilliseconds()
$stepMs = Get-StepMs $Granularity
$tsRun = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$startTag = ([DateTimeOffset]::FromUnixTimeMilliseconds($startMs).UtcDateTime.ToString('yyyyMMddTHHmmssZ'))
$baseName = "${Symbol}_${ProductType}_${Granularity}_from_${startTag}_bitget_${tsRun}"
$csvPath = Join-Path $outDirAbs ($baseName + '.csv')
$metaPath = Join-Path $outDirAbs ($baseName + '.metadata.json')
$integrityPath = Join-Path $outDirAbs ($baseName + '.integrity.json')
$zipPath = Join-Path $outDirAbs ($baseName + '.zip')

$baseUrl = 'https://api.bitget.com/api/v2/mix/market/history-candles'
$all = @{}
$endTime = $null
$prevOldest = $null
$calls = 0
$stopReason = $null

while ($true) {
  $query = "symbol=$Symbol&granularity=$Granularity&limit=$Limit&productType=$ProductType"
  if ($endTime) { $query += "&endTime=$endTime" }
  $url = "$baseUrl`?$query"
  $resp = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 30
  $calls++
  if ($resp.code -ne '00000') { throw "Bitget API error: code=$($resp.code) msg=$($resp.msg) url=$url" }
  $batch = @($resp.data)
  if ($batch.Count -eq 0) { $stopReason = 'empty_batch'; break }

  foreach ($row in $batch) {
    if ($null -ne $row -and $row.Count -ge 7) {
      $t = [int64]$row[0]
      if ($t -ge $startMs) { $all[[string]$row[0]] = $row }
    }
  }

  $oldest = ($batch | ForEach-Object { [int64]$_[0] } | Measure-Object -Minimum).Minimum
  if ($null -eq $oldest) { $stopReason = 'null_oldest'; break }
  if ([int64]$oldest -le $startMs) { $stopReason = 'reached_start'; break }
  if ($prevOldest -ne $null -and [int64]$oldest -ge [int64]$prevOldest) { $stopReason = 'no_backward_progress'; break }
  $prevOldest = [int64]$oldest

  # Bitget history-candles endTime is candle-boundary aligned. Use oldest open time
  # for the next page and de-duplicate by timestamp to avoid page-boundary skips.
  $endTime = ([int64]$oldest).ToString()
  Start-Sleep -Milliseconds $PauseMs
}

$rows = $all.Values | Sort-Object { [int64]$_[0] }
if ($rows.Count -eq 0) { throw "No candle data returned for $Symbol $ProductType $Granularity from $StartUtc" }

$header = 'timestamp_ms,open_time_utc,symbol,product_type,granularity,open,high,low,close,base_volume,quote_volume'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add($header)
foreach ($r in $rows) {
  $dt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$r[0]).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $lines.Add((@($r[0], $dt, $Symbol, $ProductType, $Granularity, $r[1], $r[2], $r[3], $r[4], $r[5], $r[6]) -join ','))
}
[System.IO.File]::WriteAllLines($csvPath, $lines, [System.Text.UTF8Encoding]::new($false))

$gaps = New-Object System.Collections.Generic.List[object]
$dupes = @{}
$prev = $null
foreach ($r in $rows) {
  $t = [int64]$r[0]
  if ($dupes.ContainsKey($t)) { $dupes[$t]++ } else { $dupes[$t] = 1 }
  if ($prev -ne $null) {
    $d = $t - $prev
    if ($d -ne $stepMs) {
      $gaps.Add([ordered]@{
        prev_open_time_utc = [DateTimeOffset]::FromUnixTimeMilliseconds($prev).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
        next_expected_open_time_utc = [DateTimeOffset]::FromUnixTimeMilliseconds($prev + $stepMs).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
        actual_next_open_time_utc = [DateTimeOffset]::FromUnixTimeMilliseconds($t).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
        delta_ms = $d
      }) | Out-Null
    }
  }
  $prev = $t
}
$duplicateCount = ($dupes.GetEnumerator() | Where-Object { $_.Value -gt 1 } | Measure-Object).Count
$first = $rows[0]
$last = $rows[$rows.Count - 1]
$expectedRows = [int64]((([int64]$last[0] - [int64]$first[0]) / $stepMs) + 1)
$pass = ($rows.Count -eq $expectedRows -and $gaps.Count -eq 0 -and $duplicateCount -eq 0)
$gapArray = @($gaps | ForEach-Object { $_ })

$meta = [ordered]@{
  source = 'Bitget public API /api/v2/mix/market/history-candles'
  symbol = $Symbol
  tradingview_symbol = "$Symbol.P"
  productType = $ProductType
  granularity = $Granularity
  requested_start_utc = [DateTimeOffset]::FromUnixTimeMilliseconds($startMs).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
  limit_per_call = $Limit
  pause_ms_between_calls = $PauseMs
  api_calls = $calls
  stop_reason = $stopReason
  rows = $rows.Count
  first_timestamp_ms = [string]$first[0]
  first_open_time_utc = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$first[0]).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
  last_timestamp_ms = [string]$last[0]
  last_open_time_utc = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$last[0]).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
  exported_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  csv_file = [System.IO.Path]::GetFileName($csvPath)
}
$meta | ConvertTo-Json -Depth 5 | Set-Content -Path $metaPath -Encoding UTF8

$integrity = [ordered]@{
  symbol = $Symbol
  tradingview_symbol = "$Symbol.P"
  productType = $ProductType
  granularity = $Granularity
  requested_start_utc = $meta.requested_start_utc
  first_open_time_utc = $meta.first_open_time_utc
  last_open_time_utc = $meta.last_open_time_utc
  rows = $rows.Count
  expected_rows_from_first_to_last = $expectedRows
  expected_step_ms = $stepMs
  gaps = $gaps.Count
  duplicate_timestamps = $duplicateCount
  pass = $pass
  gap_details = $gapArray
}
$integrity | ConvertTo-Json -Depth 8 | Set-Content -Path $integrityPath -Encoding UTF8

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $csvPath, $metaPath, $integrityPath -DestinationPath $zipPath -CompressionLevel Optimal

[pscustomobject]@{
  csvPath = $csvPath
  metaPath = $metaPath
  integrityPath = $integrityPath
  zipPath = $zipPath
  rows = $rows.Count
  expectedRows = $expectedRows
  gaps = $gaps.Count
  duplicateTimestamps = $duplicateCount
  pass = $pass
  apiCalls = $calls
  pauseMs = $PauseMs
  firstUtc = $meta.first_open_time_utc
  lastUtc = $meta.last_open_time_utc
  zipBytes = (Get-Item $zipPath).Length
} | ConvertTo-Json -Depth 5

if (-not $pass) { exit 2 }
