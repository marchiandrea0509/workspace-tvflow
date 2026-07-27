param(
    [Parameter(Mandatory=$true)]
    [string]$PlanPath
)

$ErrorActionPreference = "Stop"

$mcpDir = "$env:USERPROFILE\tools\tradingview-mcp"
$cli = "$mcpDir\src\cli\index.js"

if (-not (Test-Path $PlanPath)) { throw "Trade plan JSON not found: $PlanPath" }
if (-not (Test-Path $cli)) { throw "TradingView MCP CLI not found: $cli" }

function Draw-LineSegment {
    param(
        [double]$Price,
        [int64]$T1,
        [int64]$T2,
        [string]$Color,
        [int]$Width,
        [int]$LineStyle = 0
    )

    $override = "{`"linecolor`":`"$Color`",`"linewidth`":$Width,`"linestyle`":$LineStyle}"
    $overrideForCmd = $override.Replace('"', '\"')

    $cmd = 'node "' + $cli + '" draw shape --type trend_line --price ' + $Price + ' --time ' + $T1 + ' --price2 ' + $Price + ' --time2 ' + $T2 + ' --overrides "' + $overrideForCmd + '"'

    cmd.exe /c $cmd
}

function Convert-ToDoubleOrNull {
    param(
        [AllowNull()]
        $Value
    )

    if ($null -eq $Value) { return $null }
    $s = [string]$Value
    if ([string]::IsNullOrWhiteSpace($s)) { return $null }
    $num = 0.0
    if ([double]::TryParse($s, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$num)) { return $num }
    return $null
}

function Convert-ToUnixSecondsOrNull {
    param(
        [AllowNull()]
        $Value
    )

    if ($null -eq $Value) { return $null }
    $s = [string]$Value
    if ([string]::IsNullOrWhiteSpace($s)) { return $null }

    $num = 0.0
    if ([double]::TryParse($s, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$num)) {
        if ($num -gt 1000000000000) { return [int64]($num / 1000) }
        return [int64]$num
    }

    $dto = [DateTimeOffset]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal)
    return [int64]$dto.ToUnixTimeSeconds()
}

function Get-FirstPresentValue {
    param(
        [Parameter(Mandatory=$true)]
        $Object,
        [Parameter(Mandatory=$true)]
        [string[]]$Names
    )

    if ($null -eq $Object) { return $null }
    $props = $Object.PSObject.Properties
    foreach ($name in $Names) {
        $prop = $props[$name]
        if ($null -ne $prop -and $null -ne $prop.Value -and -not [string]::IsNullOrWhiteSpace([string]$prop.Value)) {
            return $prop.Value
        }
    }
    return $null
}

function Resolve-LineStyle {
    param(
        [AllowNull()]
        $Order,
        [int]$Default = 0
    )

    $raw = Get-FirstPresentValue -Object $Order -Names @('line_style', 'lineStyle', 'linestyle', 'dash', 'dashed')
    if ($null -ne $raw) {
        $s = ([string]$raw).ToLowerInvariant()
        if ($s -eq 'true' -or $s -eq 'dashed' -or $s -eq 'dash' -or $s -eq '2') { return 2 }
        if ($s -eq 'dotted' -or $s -eq 'dot' -or $s -eq '1') { return 1 }
        if ($s -eq 'false' -or $s -eq 'solid' -or $s -eq '0') { return 0 }
    }

    $kind = ([string](Get-FirstPresentValue -Object $Order -Names @('kind', 'status', 'mode', 'execution', 'execution_mode', 'order_type', 'orderType', 'type'))).ToLowerInvariant()
    if ($kind -match 'virtual|alert|watch|conditional|paper') { return 2 }
    if ($kind -match 'real|live|exchange') { return 0 }
    return $Default
}

function Format-LineStyleName {
    param([int]$LineStyle)
    if ($LineStyle -eq 2) { return 'dashed' }
    if ($LineStyle -eq 1) { return 'dotted' }
    return 'solid'
}

function Resolve-ArrowPrice {
    param(
        [AllowNull()]
        $Order,
        [AllowNull()]
        $Plan,
        [double]$FallbackEntry
    )

    $orderArrowPrice = Convert-ToDoubleOrNull (Get-FirstPresentValue -Object $Order -Names @('arrow_price', 'arrowPrice', 'current_price', 'currentPrice', 'placement_price', 'placementPrice', 'market_price', 'marketPrice', 'last_price', 'lastPrice'))
    if ($null -ne $orderArrowPrice) { return $orderArrowPrice }

    $planArrowPrice = Convert-ToDoubleOrNull (Get-FirstPresentValue -Object $Plan -Names @('arrow_price', 'arrowPrice', 'current_price', 'currentPrice', 'placement_price', 'placementPrice', 'market_price', 'marketPrice', 'last_price', 'lastPrice'))
    if ($null -ne $planArrowPrice) { return $planArrowPrice }

    return $FallbackEntry
}

function Draw-ArrowSegment {
    param(
        [double]$Price,
        [int64]$TipTime,
        [int64]$CandleSeconds,
        [int]$LengthBars,
        [string]$Color,
        [int]$Width,
        [string]$Shape
    )

    $t1 = $TipTime - ([int64]$LengthBars * $CandleSeconds)
    $t2 = $TipTime

    $override = "{`"linecolor`":`"$Color`",`"linewidth`":$Width,`"color`":`"$Color`"}"
    $overrideForCmd = $override.Replace('"', '\"')

    $cmd = 'node "' + $cli + '" draw shape --type ' + $Shape + ' --price ' + $Price + ' --time ' + $t1 + ' --price2 ' + $Price + ' --time2 ' + $t2 + ' --overrides "' + $overrideForCmd + '"'

    cmd.exe /c $cmd
}

$plan = Get-Content $PlanPath -Raw | ConvertFrom-Json

Push-Location $mcpDir
try {
    Write-Host "Setting chart:"
    Write-Host "  Symbol:   " $plan.symbol
    Write-Host "  Timeframe:" $plan.timeframe

    node $cli symbol $plan.symbol | Out-Host
    Start-Sleep -Seconds 3
    node $cli timeframe $plan.timeframe | Out-Host
    Start-Sleep -Seconds 3

    $ohlcv = node $cli ohlcv --summary | ConvertFrom-Json
    $bars = $ohlcv.last_5_bars

    $baseT1 = [int64]$bars[-1].time
    $prevT  = [int64]$bars[-2].time
    $candleSec = $baseT1 - $prevT

    Write-Host ""
    Write-Host "Drawing trade plan:"
    Write-Host "  Base start:" $baseT1
    Write-Host "  Candle seconds:" $candleSec
    Write-Host "  Length bars:" $plan.length_bars
    Write-Host "  Ladder shift: 1 candle per order"

    $arrowEnabled = $true
    if ($null -ne $plan.arrow -and $null -ne $plan.arrow.enabled) { $arrowEnabled = [bool]$plan.arrow.enabled }
    if ($null -ne $plan.style -and $null -ne $plan.style.arrow -and $null -ne $plan.style.arrow.enabled) { $arrowEnabled = [bool]$plan.style.arrow.enabled }

    $arrowLengthBars = 2
    if ($null -ne $plan.arrow -and $null -ne $plan.arrow.length_bars) { $arrowLengthBars = [int]$plan.arrow.length_bars }
    elseif ($null -ne $plan.style -and $null -ne $plan.style.arrow -and $null -ne $plan.style.arrow.length_bars) { $arrowLengthBars = [int]$plan.style.arrow.length_bars }

    $arrowColor = "#FFFFFF"
    if ($null -ne $plan.style -and $null -ne $plan.style.arrow -and $null -ne $plan.style.arrow.color) { $arrowColor = [string]$plan.style.arrow.color }

    $arrowWidth = 2
    if ($null -ne $plan.style -and $null -ne $plan.style.arrow -and $null -ne $plan.style.arrow.width) { $arrowWidth = [int]$plan.style.arrow.width }

    $arrowShape = "arrow"
    if ($null -ne $plan.style -and $null -ne $plan.style.arrow -and $null -ne $plan.style.arrow.shape) { $arrowShape = [string]$plan.style.arrow.shape }

    $topLevelOrderTime = Convert-ToUnixSecondsOrNull (Get-FirstPresentValue -Object $plan -Names @('order_time', 'live_order_time', 'placed_at', 'placedAt', 'timestamp'))
    $arrowMode = "per_order"
    if ($null -ne $plan.arrow -and $null -ne $plan.arrow.mode) { $arrowMode = ([string]$plan.arrow.mode).ToLowerInvariant() }
    elseif ($null -ne $plan.style -and $null -ne $plan.style.arrow -and $null -ne $plan.style.arrow.mode) { $arrowMode = ([string]$plan.style.arrow.mode).ToLowerInvariant() }
    $groupArrowDrawn = $false

    if ($arrowEnabled) {
        if ($arrowMode -eq "single" -or $arrowMode -eq "group" -or $arrowMode -eq "first") {
            Write-Host "  Placement arrow: enabled, single/group mode, white/right, length $arrowLengthBars candle(s); tip at first/top-level order time and current/placement price when provided"
        } else {
            Write-Host "  Placement arrows: enabled, per-order mode, white/right, length $arrowLengthBars candle(s); tip at order time and current/placement price when provided"
        }
    }

    for ($i = 0; $i -lt $plan.orders.Count; $i++) {
        $order = $plan.orders[$i]

        $shiftBars = $i
        $t1 = $baseT1 + ($shiftBars * $candleSec)
        $t2 = $t1 + ([int]$plan.length_bars * $candleSec)

        Write-Host ""
        $lineStyle = Resolve-LineStyle -Order $order -Default 0
        $lineStyleName = Format-LineStyleName -LineStyle $lineStyle

        Write-Host "$($order.name) | shift +$shiftBars candle(s)"
        Write-Host "  Start:" $t1
        Write-Host "  End:  " $t2
        Write-Host "  Line style:" $lineStyleName

        Write-Host "  Entry:" $order.entry
        Draw-LineSegment -Price $order.entry -T1 $t1 -T2 $t2 -Color $plan.style.entry.color -Width $plan.style.entry.width -LineStyle $lineStyle | Out-Host

        if ($arrowEnabled) {
            $singleArrowMode = ($arrowMode -eq "single" -or $arrowMode -eq "group" -or $arrowMode -eq "first")
            if (-not $singleArrowMode -or -not $groupArrowDrawn) {
                $orderTimeRaw = Get-FirstPresentValue -Object $order -Names @('order_time', 'live_order_time', 'placed_at', 'placedAt', 'timestamp')
                $tipTime = Convert-ToUnixSecondsOrNull $orderTimeRaw
                if ($null -eq $tipTime) { $tipTime = $topLevelOrderTime }
                if ($null -eq $tipTime) { $tipTime = $t1 }

                $arrowPriceForOrder = Resolve-ArrowPrice -Order $order -Plan $plan -FallbackEntry ([double]$order.entry)
                Write-Host "  Placement arrow: tip time $tipTime, price $arrowPriceForOrder, length $arrowLengthBars candle(s), color $arrowColor"
                Draw-ArrowSegment -Price $arrowPriceForOrder -TipTime $tipTime -CandleSeconds $candleSec -LengthBars $arrowLengthBars -Color $arrowColor -Width $arrowWidth -Shape $arrowShape | Out-Host
                if ($singleArrowMode) { $groupArrowDrawn = $true }
            }
        }

        Write-Host "  SL:   " $order.sl
        Draw-LineSegment -Price $order.sl -T1 $t1 -T2 $t2 -Color $plan.style.sl.color -Width $plan.style.sl.width -LineStyle $lineStyle | Out-Host

        Write-Host "  TP:   " $order.tp
        Draw-LineSegment -Price $order.tp -T1 $t1 -T2 $t2 -Color $plan.style.tp.color -Width $plan.style.tp.width -LineStyle $lineStyle | Out-Host
    }
}
finally {
    Pop-Location
}
