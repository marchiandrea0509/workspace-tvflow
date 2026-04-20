Project: TradingView / Pine workflow
Goal: Serve as the main coordination and continuity workspace for TradingView, Pine, screeners, chart analysis, and related TradingView automation
Current phase: Screener continuity plus Bitget futures execution harness setup
Last successful step: Reverted the Bitget deep-analysis workflow back to OHLCV-first with Bitget as source of truth by updating the active prompts and the Bitget packet builder to export/save 1D+4H Bitget OHLCV files
Next step: Run the next deep analysis through the updated OHLCV-first packet path and optionally simplify screenshots to best-effort validation only
Blockers: None immediate; current screener execution already runs elsewhere through existing mini/nano agents and cron jobs
Notes: tvflow is the main coordination and continuity agent for TradingView/Pine/screener work. Existing mini/nano agents and cron jobs already handle the current screener execution. tvflow is mainly for deeper analysis, future screener extensions, wiring to other tools, Discord delivery/routing, and additional Pine logic. tvflow is not the current runtime execution agent for the screener cron. A Bitget futures harness now exists under `bitget-futures-harness/` for API-side testing, starting with demo trading.
