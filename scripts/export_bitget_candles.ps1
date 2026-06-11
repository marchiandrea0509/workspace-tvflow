param(
  [string]$Symbol = 'NVDAUSDT',
  [string]$ProductType = 'usdt-futures',
  [string]$Granularity = '4H',
  [string]$OutDir = 'reports/bitget_exports',
  [int]$Limit = 200
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path '.').Path
$outDirAbs = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }
New-Item -ItemType Directory -Force -Path $outDirAbs | Out-Null

$tsRun = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$baseName = "${Symbol}_${ProductType}_${Granularity}_bitget_full_history_${tsRun}"
$csvPath = Join-Path $outDirAbs ($baseName + '.csv')
$metaPath = Join-Path $outDirAbs ($baseName + '.metadata.json')
$zipPath = Join-Path $outDirAbs ($baseName + '.zip')

$baseUrl = 'https://api.bitget.com/api/v2/mix/market/history-candles'
$all = @{}
$endTime = $null
$prevOldest = $null
$calls = 0

while ($true) {
  $query = "symbol=$Symbol&granularity=$Granularity&limit=$Limit&productType=$ProductType"
  if ($endTime) { $query += "&endTime=$endTime" }
  $url = "$baseUrl`?$query"
  $resp = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 30
  $calls++
  if ($resp.code -ne '00000') { throw "Bitget API error: code=$($resp.code) msg=$($resp.msg) url=$url" }
  $batch = @($resp.data)
  if ($batch.Count -eq 0) { break }

  foreach ($row in $batch) {
    if ($null -ne $row -and $row.Count -ge 7) { $all[[string]$row[0]] = $row }
  }

  $oldest = ($batch | ForEach-Object { [int64]$_[0] } | Measure-Object -Minimum).Minimum
  if ($null -eq $oldest) { break }
  if ($prevOldest -ne $null -and [int64]$oldest -ge [int64]$prevOldest) { break }
  $prevOldest = [int64]$oldest
  if ($batch.Count -lt $Limit) { break }
  # Bitget history-candles treats endTime as an aligned candle boundary.
  # Using oldest-1ms skips the candle immediately before the page on 1H.
  # Use oldest open time for the next page; rows are de-duplicated by timestamp.
  $endTime = ([int64]$oldest).ToString()
  Start-Sleep -Milliseconds 180
}

$rows = $all.Values | Sort-Object { [int64]$_[0] }
if ($rows.Count -eq 0) { throw "No candle data returned for $Symbol $ProductType $Granularity" }

$header = 'timestamp_ms,open_time_utc,symbol,product_type,granularity,open,high,low,close,base_volume,quote_volume'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add($header)
foreach ($r in $rows) {
  $dt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$r[0]).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $lines.Add((@($r[0], $dt, $Symbol, $ProductType, $Granularity, $r[1], $r[2], $r[3], $r[4], $r[5], $r[6]) -join ','))
}
[System.IO.File]::WriteAllLines($csvPath, $lines, [System.Text.UTF8Encoding]::new($false))

$first = $rows[0]
$last = $rows[$rows.Count - 1]
$meta = [ordered]@{
  source = 'Bitget public API /api/v2/mix/market/history-candles'
  symbol = $Symbol
  tradingview_symbol = "$Symbol.P"
  productType = $ProductType
  granularity = $Granularity
  limit_per_call = $Limit
  api_calls = $calls
  rows = $rows.Count
  first_timestamp_ms = [string]$first[0]
  first_open_time_utc = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$first[0]).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
  last_timestamp_ms = [string]$last[0]
  last_open_time_utc = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$last[0]).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
  exported_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  csv_file = [System.IO.Path]::GetFileName($csvPath)
}
$meta | ConvertTo-Json -Depth 5 | Set-Content -Path $metaPath -Encoding UTF8

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $csvPath, $metaPath -DestinationPath $zipPath -CompressionLevel Optimal

[pscustomobject]@{
  csvPath = $csvPath
  metaPath = $metaPath
  zipPath = $zipPath
  rows = $rows.Count
  apiCalls = $calls
  firstUtc = $meta.first_open_time_utc
  lastUtc = $meta.last_open_time_utc
  zipBytes = (Get-Item $zipPath).Length
} | ConvertTo-Json -Depth 4
