Project: TradingView / Pine workflow
Goal: Serve as the main coordination and continuity workspace for TradingView, Pine, screeners, chart analysis, and related TradingView automation
Current phase: Screener continuity plus Bitget futures execution harness setup
Last successful step: Reset the active screener runtime/tooling defaults back to `OC Hybrid Edge Screener v6` and kept the benchmark collector available for export-only packaging
Next step: Verify the active TradingView screener flow opens and runs cleanly on `OC Hybrid Edge Screener v6`, then resolve any remaining benchmark symbol/watchlist mismatches under that version
Blockers: None immediate; current screener execution already runs elsewhere through existing mini/nano agents and cron jobs
Notes: tvflow is the main coordination and continuity agent for TradingView/Pine/screener work. Existing mini/nano agents and cron jobs already handle the current screener execution. tvflow is mainly for deeper analysis, future screener extensions, wiring to other tools, Discord delivery/routing, and additional Pine logic. tvflow is not the current runtime execution agent for the screener cron. A Bitget futures harness now exists under `bitget-futures-harness/` for API-side testing, starting with demo trading.
