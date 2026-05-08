# AAPLUSDT Dip Analysis

Date: 2026-05-08 00:38 Europe/Berlin
Method: fresh Bitget OHLCV/market data + local TradingView strategy/screener artifact check + live Bitget order/position check
Symbol: BITGET:AAPLUSDT.P / AAPLUSDT perpetual futures

## Context
- Previous AAPLUSDT ladder from 2026-05-05/06 was manually cancelled by the user.
- Current live/API check confirms AAPLUSDT has no active regular orders, no plan orders, and no current futures position.
- This analysis treats AAPL as a fresh dip candidate, not an active/order-management task.

## Data snapshot
- Last/mark price: `287.84 / 287.85`
- 24h range: `286.18` to `292.31`; 24h change: about `-0.02%`
- 24h volume: `11,008.07 AAPL` / `3.18M USDT`
- Funding: `0.0000%` per 8h; open interest / holding amount: `13,553.61 AAPL`
- Contract precision: price `2` decimals, size `2` decimals, min size `0.01`, min notional `5 USDT`, max leverage `100x`

## Indicator state
### 4H
- Close: `287.84`
- EMA8 / EMA20 / EMA50 / EMA100 / EMA200: `287.36 / 284.74 / 280.68 / 276.29 / 270.24`
- RSI14: `66.57`
- ATR14: `2.33`
- ADX14: `41.66`, +DI `32.76`, -DI `14.07` — strong bullish trend, but not early
- 4H 20-bar range: `275.68` to `292.31`
- 4H change over 20 bars: `+3.90%`

### 1H
- Close: `287.84`
- EMA8 / EMA20 / EMA50 / EMA100 / EMA200: `288.05 / 287.98 / 286.17 / 283.75 / 280.62`
- RSI14: `51.50`
- ATR14: `1.29`
- ADX14: `34.53`, +DI `27.39`, -DI `20.64`
- Read: short-term momentum is neutral after rejection from `292.31`; not a clean fresh breakout.

### 1D
- Close: `287.84`
- EMA8 / EMA20 / EMA50 / EMA100 / EMA200: `282.88 / 276.43 / 268.97 / 267.34 / 269.39`
- RSI14: `66.43`
- ATR14: `5.74`
- ADX14: `29.15`, +DI `31.47`, -DI `11.92`
- 1D 20-bar range: `265.49` to `292.31`

## TradingView artifact check
- Latest local Strategy Test CSV found: `C:\Users\anmar\.openclaw\workspace\tradingview\reports\strategy_test_watchlist_csv\BITGET_TRADFI_subset_wait10_2026-05-06T05-35-54-740Z\AAPLUSDT.P_strategy_test_4h.csv`
  - Last valid row close `282.18`, Best Score `78.15`, Final Long `78.15`, Final Short `9.85`, Trend Dir `+1`, Macro Dir `+1`, ResearchValid `1`, LC Final `80.86`, SC Final `35.85`.
- Older recurring screener row from 2026-05-01 was weak/stale: Best Score `30.79`, Conviction `0`, Trend Dir `-1`, Macro Dir `+1`.
- Read: current strategy-test context is strongly long-biased; the older screener is stale and less relevant than the fresh OHLCV/strategy-test read.

## Dip read
AAPL remains a bullish continuation market, but current price is not a good dip entry. The prior cancelled ladder's first TP area around `287.50` has effectively been reached, and price has already rejected from `292.31`. That means the best new entry is not current price; it is a reset into the 4H support stack.

## Key dip zones
### Good dip / first value
- `280.50` to `280.00` — 4H EMA50 plus recent pivot shelf. This is the first zone where the R:R becomes acceptable again.

### Better dip / high-value continuation
- `276.50` to `275.70` — daily EMA20/4H support area and recent 4H swing low zone. This is the preferred reload zone if the market actually flushes.

### Deep invalidation shelf
- `270.50` to `270.30` — 4H EMA200 / prior structural invalidation. Losing this weakens the whole continuation thesis.

## Resistance / targets
- `288.32` to `288.46` — immediate 1H resistance/reclaim band
- `292.31` — current 24h/local high and first major target
- `296.00` — extension target if `292.31` breaks with acceptance
- `299.00` — stretch target only if trend accelerates again

## Trade quality
**GOOD MARKET + WAIT FOR DIP**

AAPL has strong 4H and constructive daily alignment. The problem is that current price is near the upper half of the recent range and close to the rejection high. A shallow bid near `286–288` has poor asymmetry versus a structural SL. The cleaner dip plan starts near `280.50`, and the best value is closer to `276–275.70`.

## Primary dip plan
- Bias: **LONG**
- Entry method: **DIP_LADDER only**
- Market order now: **NO**
- Structural SL / invalidation: `270.30`

| Leg | Entry | Qty example | Notional | Margin @4x | SL | Risk | Primary TP | Est. profit | R:R |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| L1 | 280.50 | 4.00 | 1,122.00 | 280.50 | 270.30 | 40.80 | 292.30 | 47.20 | 1.16R |
| L2 | 275.70 | 10.00 | 2,757.00 | 689.25 | 270.30 | 54.00 | 296.00 / trail | 203.00 | 3.76R |

- Total example planned margin @4x: `969.75 USDT`
- Total example planned risk: `94.80 USDT`
- Total estimated primary reward: `250.20 USDT` (`~2.64R` blended)

Sizing note: I intentionally avoided a shallow `286–288` leg because it has weak R:R against the structural stop and would mostly be a chase/reclaim trade rather than a dip trade.

## Aggressive reclaim alternative
Use only if price refuses to dip and reclaims strength:
- Trigger: sustained acceptance above `288.50`, then ideally a retest holding `288.30–288.50`.
- Entry: small tactical continuation only, not full ladder sizing.
- Stop: below `286.10` or the reclaim candle low.
- Targets: `292.30`, then `296.00`.
- This is lower quality than the dip ladder because it buys close to the prior rejection zone.

## Orderability decision
**PLACEABLE_CONDITIONAL_ONLY**

- Market order now: **NO**.
- Dip ladder: **YES**, preferably `280.50 / 275.70` with structural SL `270.30`.
- Reclaim trade: **YES only after confirmation** above `288.50`, reduced size.

## Final verdict
- Bias: **LONG**, but current price is not the dip.
- Best action: wait for `280.50`, better at `275.70`; keep SL at `270.30` if using swing-continuation structure.
- Confidence: `72/100` directional; `42/100` immediate-entry quality; `68/100` dip-ladder quality if entries are reached.

## Artifacts
- Metrics: `reports/deep_analysis/2026-05-08_AAPLUSDT_metrics.json`
- 1H OHLCV: `reports/deep_analysis/2026-05-08_AAPLUSDT_1H_bitget_ohlcv.csv`
- 4H OHLCV: `reports/deep_analysis/2026-05-08_AAPLUSDT_4H_bitget_ohlcv.csv`
- 1D OHLCV: `reports/deep_analysis/2026-05-08_AAPLUSDT_1D_bitget_ohlcv.csv`
- Open-order check: `reports/deep_analysis/2026-05-08_AAPLUSDT_open_orders_check.json`
- Position check: `reports/deep_analysis/2026-05-08_AAPLUSDT_positions_check.json`

No orders were placed, modified, or cancelled during this analysis.

## Less-conservative same-risk variant - 2026-05-08 00:40 Europe/Berlin

User said the primary dip ladder was too deep and asked for a less-conservative setup with approximately the same planned risk.

Important tradeoff: to move entries higher while keeping total risk near `95 USDT`, the stop must move up from structural `270.30` to a tighter tactical invalidation below the 4H EMA50 / `280` shelf. This increases fill probability but also increases stop-out risk.

### Tactical dip ladder variant
- Bias: **LONG**
- Execution style: less-conservative tactical dip ladder
- Tactical SL / invalidation: `279.80`

| Leg | Entry | Qty example | Notional | Margin @4x | SL | Risk | Primary TP | Est. profit | R:R |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| L1 | 286.20 | 4.20 | 1,202.04 | 300.51 | 279.80 | 26.88 | 292.30 | 25.62 | 0.95R |
| L2 | 284.70 | 6.00 | 1,708.20 | 427.05 | 279.80 | 29.40 | 292.30 | 45.60 | 1.55R |
| L3 | 282.20 | 16.00 | 4,515.20 | 1,128.80 | 279.80 | 38.40 | 296.00 / trail | 220.80 | 5.75R |

- Total example planned margin @4x: `1,856.36 USDT`
- Total example planned risk: `94.68 USDT`
- Total estimated primary reward: `292.02 USDT` (`~3.08R` blended)

Read: this variant is more likely to fill and still keeps risk near the original plan, but it is no longer the same structural swing idea. If `279.80` breaks, the setup should be considered tactically wrong rather than held down to `270.30`.

## Live execution update - 2026-05-08 00:53 Europe/Berlin

User explicitly confirmed the less-conservative tactical AAPLUSDT ladder.

Pre-placement checks:
- Existing AAPLUSDT open regular orders: 0
- Existing AAPLUSDT plan orders: 0
- Existing open futures positions returned by all-position response: 0
- Account mode reported live, not paper trading; available USDT about `4,867.34`
- Current ticker check before placement: last/mark about `287.96 / 287.96`, bid/ask about `288.01 / 288.02`

Execution setup:
- Set/confirmed `AAPLUSDT` margin mode: isolated
- Set/confirmed leverage: 4x long / 4x short under isolated margin
- Used one-shot environment unlock for the placement command only; no persistent harness config change was made.

Execution:
- Placed live Bitget `AAPLUSDT` long limit tactical ladder with fixed TP and fixed SL:

| leg | orderId | clientOid | side | qty | entry | SL | TP | status | margin mode | leverage |
|---|---|---|---|---:|---:|---:|---:|---|---|---:|
| L1 | `1436416624356388865` | `tvflow_aapl_20260508_tactical_L1` | buy/open long | 4.20 | 286.20 | 279.80 | 292.30 | live/resting | isolated | 4x |
| L2 | `1436416627011383297` | `tvflow_aapl_20260508_tactical_L2` | buy/open long | 6.00 | 284.70 | 279.80 | 292.30 | live/resting | isolated | 4x |
| L3 | `1436416629611851897` | `tvflow_aapl_20260508_tactical_L3` | buy/open long | 16.00 | 282.20 | 279.80 | 296.00 | live/resting | isolated | 4x |

Verification immediately after placement:
- Regular pending order count for AAPLUSDT: 3
- Plan pending order count for AAPLUSDT: 0
- All three orders reported `status: live`, `tradeSide: open`, `posSide: long`, `orderType: limit`, `force: gtc`, `marginMode: isolated`, `leverage: 4`, `baseVolume: 0`.
- No AAPLUSDT position listed immediately after placement, as expected because limits were resting and unfilled.

Risk summary:
- Total planned risk to tactical SL `279.80`: `94.68 USDT`
- Total primary reward to fixed TPs: `292.02 USDT`
- Estimated planned margin at 4x: `1,856.36 USDT`

Reporting update:
- Bitget journal artifacts refreshed after placement with tracked symbols `GOOGLUSDT,GMEUSDT,AAPLUSDT,NEARUSDT,INTCUSDT`.
- Latest workbook: `reports/trade_journal/bitget_futures_trade_report_latest.xls`
- Timestamped snapshot: `reports/trade_journal/bitget_futures_trade_report_2026-05-07T22-52-40-625Z.xls`
- Journal state-change detector correctly reported three new active AAPLUSDT orders; active orders now total 8: three AAPLUSDT, two INTCUSDT, three NEARUSDT, positions 0.

TradingView Desktop MCP markup:
- Drew `BITGET:AAPLUSDT.P` on `4H`.
- Drew 3 tactical order groups with Entry / SL / TP segments:
  - L1: Entry `286.20`, SL `279.80`, TP `292.30`
  - L2: Entry `284.70`, SL `279.80`, TP `292.30`
  - L3: Entry `282.20`, SL `279.80`, TP `296.00`
- Drawing script returned success for all 9 line segments.
