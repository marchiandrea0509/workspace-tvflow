# Bitget / TradingView Deep Analysis Workflow Bundle

This bundle documents the public/project files and tools used when Andrea asks tvflow to run a deep analysis.

## Important boundary
- Included: project prompt files, packet/build scripts, journal/report helper scripts, and one-off analysis scripts that have been used for recent OHLCV-first deep analyses.
- Not included: hidden OpenClaw system/developer prompts, internal model/tool schemas, credentials, API secrets, or private runtime state.

## Current active methodology
- Active deep-analysis source of truth: Bitget OHLCV-first.
- Primary data: Bitget REST OHLCV exports, usually 1H / 4H / 1D depending on symbol/request.
- Secondary context: latest local TradingView Pine screener and Strategy Test CSV artifacts when present.
- Optional validation: TradingView screenshots / dashboard screenshots.
- Safety: live Bitget order placement/cancel/modify requires explicit confirmation; ordinary deep analysis is read-only.

## Core active prompt files
- `data_pipeline/prompts/bitget_single_market_deep_dive_prompt.md`
- `data_pipeline/prompts/single_market_deep_dive_prompt.md` — active default alias/copy of the Bitget prompt
- `workspace-tvflow/prompts/bitget_llm_deep_analysis_prompt_v1.md` — older screenshot-first prompt retained for reference

## Core packet/script files
- `data_pipeline/scripts/build_bitget_llm_deep_analysis_packet.py` — builds a repeatable packet from latest Pine screener winner, Bitget OHLCV, and optional TradingView screenshots
- `workspace-tvflow/tmp/*_deep_analysis.py` — recent hardcoded OHLCV-first analysis scripts used for GOOGL/AAPL/NEAR/INTC runs
- `workspace-tvflow/scripts/run_bitget_journal_update.ps1` — read-only Bitget journal/report refresh after analysis/execution
- `workspace-tvflow/scripts/build_bitget_trade_report.py`
- `workspace-tvflow/scripts/build_bitget_thread_messages.py`

## TradingView context scripts usually referenced
- `workspace/tradingview/scripts/pine_screener_export.js`
- `workspace/tradingview/scripts/capture_live.js`
- `workspace/tradingview/scripts/export_strategy_test_symbols_csv.js`
- `workspace/tradingview/scripts/run_bitget_tradfi_strategy_export.ps1`

## Tools used conceptually
- OpenClaw file tools: read/write/edit/exec for local artifacts and scripts
- Python for OHLCV fetch/metrics/report generation
- Node/Playwright for TradingView screener/chart capture/export automation
- Bitget public REST API for candles/ticker/market data
- Bitget authenticated REST checks only for open orders/positions when needed
- TradingView local artifacts: latest screener JSON/CSV and Strategy Test CSVs
- Discord/OpenClaw delivery for summaries/reports

## Typical generated outputs
- `reports/deep_analysis/<date>_<SYMBOL>.md`
- `reports/deep_analysis/<date>_<SYMBOL>_metrics.json`
- `reports/deep_analysis/<date>_<SYMBOL>_1H_bitget_ohlcv.csv`
- `reports/deep_analysis/<date>_<SYMBOL>_4H_bitget_ohlcv.csv`
- `reports/deep_analysis/<date>_<SYMBOL>_1D_bitget_ohlcv.csv`
- optional open-order/position check JSONs

## Prompt skeleton used in active workflow
Use the active Bitget prompt file above as the canonical full text. The short operational version is:

1. Analyze one Bitget USDT perpetual market.
2. Treat Bitget OHLCV exports as primary truth.
3. Use screener row / dashboard state as signal context, not blind truth.
4. Use chart screenshots only as optional validation.
5. Produce a decision-useful swing plan for 1–10 days.
6. Classify market quality, entry quality, orderability, invalidation, and confidence.
7. If a trade is valid, provide exact entry/SL/TP/risk sizing ticket under hard risk and margin caps.
8. If not valid, say WAIT / NOT_PLACEABLE clearly.
