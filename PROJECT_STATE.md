Project: TradingView / Pine workflow
Goal: Serve as the main coordination and continuity workspace for TradingView, Pine, screeners, chart analysis, and related TradingView automation
Current phase: Screener continuity plus Bitget futures execution harness setup
Last successful step: Built a local Bitget futures API test harness with demo-first safety rails, dry-run signal execution, and a dedicated on-disk secrets file path
Next step: Paste demo Bitget API keys into the local env file, verify account/positions connectivity, then test one tiny demo order end-to-end
Blockers: None immediate; current screener execution already runs elsewhere through existing mini/nano agents and cron jobs
Notes: tvflow is the main coordination and continuity agent for TradingView/Pine/screener work. Existing mini/nano agents and cron jobs already handle the current screener execution. tvflow is mainly for deeper analysis, future screener extensions, wiring to other tools, Discord delivery/routing, and additional Pine logic. tvflow is not the current runtime execution agent for the screener cron. A Bitget futures harness now exists under `bitget-futures-harness/` for API-side testing, starting with demo trading.
