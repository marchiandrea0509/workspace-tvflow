# Deep Analysis Packet Contract v2

Default workflow for read-only Bitget deep analysis.

## Key decisions

- Primary truth: Bitget REST closed OHLCV candles.
- TradingView evidence: optional validation; prefer existing Playwright/browser capture unless TradingView Desktop MCP proves more robust or cheaper.
- Screener: summary/context only; current context `OC Hybrid Edge Screener v11.6.x`.
- No hard screener-score threshold.
- Target planned risk: 100 USDT by default.
- Cap: 1500 USDT **max margin** at planned leverage, not total notional.
- Live execution: excluded; requires separate explicit user request.

## Folder

```text
reports/deep_analysis_packets_v2/YYYYMMDD_HHMMSS_SYMBOL/
  manifest.json
  raw/
    bitget_SYMBOL_1D_closed_ohlcv.csv
    bitget_SYMBOL_4H_closed_ohlcv.csv
    bitget_SYMBOL_1H_closed_ohlcv.csv
    market_snapshot.json
    execution_state.json
    tv_exports/ optional
  derived/
    analysis_summary.json
    candidate_levels.json
    freshness_check.json
  llm_input_packet.md
```

## Candidate trade design requirements

`derived/analysis_summary.json.candidate_trade_design` must include:

- `target_total_risk_usdt`
- `max_margin_usdt`
- `planned_leverage`
- `max_effective_notional_usdt`
- `target_orders_before_margin_cap`
- `target_total_notional_before_cap_usdt`
- `target_estimated_margin_before_cap_usdt`
- `target_risk_feasible_under_margin_cap`
- `cap_adjusted_orders_if_needed`
- `expected_pullback_policy`
- `structure_risk_diagnostics`
- `omitted_too_deep_levels_sample`
- `warnings`

## Ladder rule

Legs must be plausible for expected pullback depth. Deep LC/DIP structural levels can be valid when they improve R:R without implying a character change. Do not reject a ladder merely because current price is near resistance or RSI is high; use stronger reasons such as CHoCH, degraded trend, likely SL hit, stale data, liquidity/fee issue, or objectively poor R:R.

## Screener / strategy-test export context

If a TradingView strategy-test or screener export CSV/JSON is available, pass it into the packet builder as read-only context. The packet should expose the selected screener/export fields under `screener_summary.extracted_data` and use them only after the blind OHLCV review.
