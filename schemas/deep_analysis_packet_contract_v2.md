# Deep Analysis Packet Contract v2

Default workflow for read-only Bitget deep analysis.

## Key decisions

- Primary truth: Bitget REST closed OHLCV candles.
- TradingView evidence: optional validation; prefer existing Playwright/browser capture unless TradingView Desktop MCP proves more robust or cheaper.
- Screener: summary/context only; current context `OC Hybrid Edge Screener v11.6.x`.
- No hard screener-score threshold.
- Target planned risk: 100 USDT by default.
- Cap: 1500 USDT **max total notional**, not margin.
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
- `max_total_notional_usdt`
- `target_orders_before_notional_cap`
- `target_total_notional_before_cap_usdt`
- `target_risk_feasible_under_notional_cap`
- `cap_adjusted_orders_if_needed`
- `expected_pullback_policy`
- `omitted_too_deep_levels_sample`
- `warnings`

## Ladder rule

Legs must be plausible for expected pullback depth. Deep structural levels should be omitted/flagged when they exceed the expected pullback window rather than forced into the ladder.
