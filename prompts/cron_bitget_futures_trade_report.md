# Cron Prompt — Bitget Futures Trade Report

Build a reusable Bitget futures trade report package and Discord-safe trade-thread messages.

## Goal
- Pull Bitget USDT futures history, current open orders, and positions using the local `bitget-futures-harness`.
- Build/refresh the local MT5-style Bitget workbook.
- Build compact Discord-safe messages that can be posted to the Bitget/Pine trade-reporting thread.
- Do not place, cancel, or modify orders from this reporting job.

## Do exactly this
1. Work in `C:\Users\anmar\.openclaw\workspace-tvflow`.
2. Refresh 90-day Bitget futures history:
   - `node bitget-futures-harness\scripts\export-history.js --days 90 --out reports\trade_journal\raw_bitget_history_latest.json`
3. Refresh current open orders for active/tracked symbols. Minimum current tracked symbols:
   - `node bitget-futures-harness\scripts\list-open-orders.js --symbol GOOGLUSDT > reports\trade_journal\raw_open_orders_GOOGL_latest.json`
   - `node bitget-futures-harness\scripts\list-open-orders.js --symbol GMEUSDT > reports\trade_journal\raw_open_orders_GME_latest.json`
4. Refresh positions:
   - `node bitget-futures-harness\scripts\positions.js > reports\trade_journal\raw_positions_latest.json`
5. Build/update the local workbook. Current one-off builder is `tmp\build_bitget_trade_report.py`; if promoted later, use the promoted script path.
6. Build Discord-safe thread messages:
   - `python scripts\build_bitget_thread_messages.py --history-json reports\trade_journal\raw_bitget_history_latest.json --open-orders-json reports\trade_journal\raw_open_orders_GOOGL_latest.json --open-orders-json reports\trade_journal\raw_open_orders_GME_latest.json --positions-json reports\trade_journal\raw_positions_latest.json --out reports\trade_journal\bitget_thread_messages_latest.json`
7. Read `reports\trade_journal\bitget_thread_messages_latest.json`.
8. Post each message, in order, to the configured Bitget/Pine trade-reporting Discord thread when a target thread is configured.
9. If no target thread is configured, do not guess; return the message count and artifact paths.

## Reused from MT5 flow
- The reusable part is the thread-message pattern from `workspace-mt5\scripts\build_mt5_thread_messages.py`: compact summary first, chunked Discord-safe messages, transparent status, then detailed recent history.
- The MT5 execution/planner/validation pieces are intentionally not reused because Bitget execution and account state are different.

## Safety
- This job is read/report only.
- Never set live-order flags.
- Never call cancel/place scripts.
- Never expose API secrets or env file contents.
