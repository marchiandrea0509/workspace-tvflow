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
- Rejection audit: every rejected side/option/candidate and every broken rule must be justified with the exact rule/gate, observed value, required value/threshold, why it blocks orderability, and what would fix it.

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
- `target_actual_risk_before_cap_usdt`
- `target_reward_before_cap_usdt`
- `target_blended_entry`
- `target_blended_rr`
- `max_margin_usdt`
- `planned_leverage`
- `max_effective_notional_usdt`
- `target_orders_before_margin_cap`
- `target_total_notional_before_cap_usdt`
- `target_estimated_margin_before_cap_usdt`
- `target_risk_feasible_under_margin_cap`
- `cap_adjusted_orders_if_needed`
- `expected_pullback_policy`
- `oc_static_ladder_rules`
- `impulse_analysis_4h`
- `value_zone`
- `structure_risk_diagnostics`
- `static_ticket_safe`
- `static_ticket_reject_reasons`
- `omitted_too_deep_levels_sample`
- `warnings`

Final V2 reports must also include a `rejection_audit` section/table whenever the final decision is WAIT/NO_TRADE or any option/candidate is rejected. Use `static_ticket_reject_reasons`, `warnings`, `static_optimisation_scan.best_candidate.reject_reasons`, and `rejected_candidate_examples_compact` as source evidence.

## Static 4H ladder rule

Deep Analysis v2 now builds only static OC 4H pullback tickets: `DIP_LADDER long` or `SELL_RALLY short`. Entries must come from the latest valid 4H impulse pullback value zone (38.2/50/61.8 retracement plus structural confluence), use 2-3 legs maximum, use common structural SL with 0.25-0.50 ATR buffer, fixed TP/SL at order creation, and risk splits by risk not quantity. A valid ticket must remain risk-controlled near the target risk if all entries fill and price immediately goes to SL. No ticket may depend on future cancellation, trailing, SL movement, or post-fill adjustment.

## Screener / strategy-test export context

If a TradingView strategy-test or screener export CSV/JSON is available, pass it into the packet builder as read-only context. The packet should expose the selected screener/export fields under `screener_summary.extracted_data` and use them only after the blind OHLCV review.
