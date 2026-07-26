# AAPLUSDT DIP_LADDER 39x RED-liquidity override

Executed: 2026-07-25
Authorization: Discord message `1530645816501604372`
Environment: Bitget live / USDT futures / hedge mode / isolated long

## Ticket

- L1: buy/open limit `3.86 @ 329.15`, SL `318.80`, TP `338.78`
- L2: buy/open limit `11.49 @ 324.02`, SL `318.80`, TP `338.78`
- Total quantity: `15.35`
- Total notional: `4993.5088 USDT`
- Planned no-slippage risk: `99.9288 USDT`
- Planned reward: `206.7642 USDT`
- Aggregate R:R: `2.0691`

## Leverage, margin, and liquidation

- Selected leverage: isolated `39x`
- Simple initial margin: `128.0387 USDT`
- Incremental exchange locked margin: `132.33015986 USDT`
- Tier at fill/liquidation: level 1 (`0-5000 USDT`), MMR `0.005`
- Contract taker/liquidation fee ratio: `0.0006`
- Blended entry: `325.310019544`
- Official-formula estimated liquidation: `318.7538`
- SL: `318.80`
- Liquidation below SL by: `0.0462`
- `40x` was rejected as unsafe because its fee-adjusted estimate is about `318.9635`, above SL.

## Liquidity override

Fresh full-ladder gate: `RED`.

- Stop-exit simulated slippage: GREEN
- Near-market executable depth: GREEN
- Spread stability: GREEN
- Weak-minute/p10 turnover: RED
- Dead 1-minute candles: RED (`70%`)
- 24h volume ratio: YELLOW

Andrea explicitly authorized the RED-liquidity override and accepted the sparse RWA turnover/dead-candle execution risk.

## Live orders and postcheck

- L1 orderId `1464982910485041153`, clientOid `oc-aapl-dip-39x-red-20260725-L1`
- L2 orderId `1464982995767824385`, clientOid `oc-aapl-dip-39x-red-20260725-L2`
- Both orders postchecked live/unfilled with exact quantity, price, `39x` isolated leverage, and preset SL/TP.
- No AAPL position and no `normal_plan`, `profit_loss`, or `track_plan` rows after placement.
- Post-fill liquidity monitor PIDs: `9996`, `2956`.

## Delivery receipts

- TradingView: `BITGET:AAPLUSDT.P`, 4H, two solid live Entry/SL/TP drawings and one white group placement arrow.
- Screenshot: `reports/tv_mcp_snapshots/20260725_204650/screenshot.png`
- Journal workbook: `reports/trade_journal/bitget_futures_trade_report_2026-07-25T18-49-12-673Z.xls`
- Discord journal message ID: `1530648538235801611`
- Journal receipt: `reports/live_execution/20260725_aaplusdt_dip_ladder_39x_red_override/journal_receipt.json`

The first combined finalizer attempt completed the drawing and screenshot, then falsely stopped because OpenClaw plugin-loading diagnostics arrived on stderr. The journal was rerun directly and delivered successfully. `scripts/finalize_bitget_live_order_workflow.ps1` was hardened to capture harmless stderr without bypassing exit-code and receipt validation; PowerShell parse and `-ValidateOnly` passed.
