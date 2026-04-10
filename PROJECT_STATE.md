Project: TradingView / Pine workflow
Goal: Serve as the main coordination and continuity workspace for TradingView, Pine, screeners, chart analysis, and related TradingView automation
Current phase: Screener continuity plus Bitget futures execution harness setup
Last successful step: Swapped the default deep-analysis prompt to the Bitget version, preserved a legacy generic prompt copy, added a clear Bitget packet-builder runtime path, and produced the first screenshot-grounded LLM-style deep analysis packet on a live screener winner
Next step: Repeat the Bitget packet+analysis flow on demand per winner, and optionally wire automatic posting of the deep-analysis output to the screener thread
Blockers: None immediate; current screener execution already runs elsewhere through existing mini/nano agents and cron jobs
Notes: tvflow is the main coordination and continuity agent for TradingView/Pine/screener work. Existing mini/nano agents and cron jobs already handle the current screener execution. tvflow is mainly for deeper analysis, future screener extensions, wiring to other tools, Discord delivery/routing, and additional Pine logic. tvflow is not the current runtime execution agent for the screener cron. A Bitget futures harness now exists under `bitget-futures-harness/` for API-side testing, starting with demo trading.
