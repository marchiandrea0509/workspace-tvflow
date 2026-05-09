# Prompt — Bitget Semi-Auto Futures Journal Update

Refresh the Bitget semi-auto futures journal and Discord-safe mini-report messages.

## When to run
- Manual: whenever the user asks to update/refresh the Bitget journal/report.
- Automatic: immediately after any confirmed Bitget auto-trade action, including place, cancel, reduce/close, TP/SL/order adjustment, or campaign arm/update.
- This report mirrors Bitget state/history; it must include past trades, not only the latest trade.

## Model routing
- Normal refresh is deterministic and safe for **gpt-nano**.
- Use **gpt-mini** only if the wrapper fails, Bitget API output changes, history counts look suspicious, or script/debug work is needed.
- Do not use a larger/manual UI workflow unless nano/mini reports a concrete blocker.

## Goal
- Mirror all reachable Bitget USDT futures order/fill/plan history from the API into local artifacts.
- Refresh current active orders and positions.
- Build/update the local Bitget semi-auto trade log/workbook.
- Build compact Discord-safe messages for the Bitget live-trading thread.
- Optionally post those messages to the Bitget trades thread when the runtime has a safe Discord send path.
- Do not place, cancel, or modify orders from this reporting job.

## Discord target
- Primary target for all Bitget auto trades and mini reports: Discord thread/channel `1499631210283008002` (`#bitget-trades` / thread `BITGET Trades`).
- Use this target for Bitget execution summaries, read-only trade-report mini summaries, open-order/position snapshots, and recurring trade-report messages.
- Do not route Bitget auto-trade execution or mini-report updates to the Pine screener 4H thread unless explicitly requested for a specific run.

## Deterministic wrapper
Work in `C:\Users\anmar\.openclaw\workspace-tvflow`.

Manual/no-send refresh:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_bitget_journal_update.ps1 -NoSend
```

Refresh and post to the Bitget trades thread when sending is available:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_bitget_journal_update.ps1
```

After an auto-trade, run the same wrapper immediately after the trade action is verified. If useful, include a short prefix:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_bitget_journal_update.ps1 -MessagePrefix "Journal refreshed after Bitget auto-trade."
```

Optional parameters:
- `-Since YYYY-MM-DD`: history mirror start date. Default is `2020-01-01` to approximate all reachable Bitget history.
- `-Symbols "GOOGLUSDT,GMEUSDT,..."`: symbols to check for active orders. Position symbols are added automatically.
- `-NoSend`: build artifacts/messages only; do not post.
- `-Strict`: fail if an active-order lookup fails for a tracked symbol.

## Wrapper behavior
The wrapper runs:
1. `node bitget-futures-harness\scripts\export-history-mirror.js --since <Since> --out reports\trade_journal\raw_bitget_history_latest.json`
2. `node bitget-futures-harness\scripts\positions.js > reports\trade_journal\raw_positions_latest.json`
3. `node bitget-futures-harness\scripts\list-open-orders.js --symbol <tracked>` for tracked/position symbols.
4. `python scripts\build_bitget_trade_report.py ...`
5. `python scripts\build_bitget_thread_messages.py ...`
6. Creates both `latest` artifacts and timestamped snapshots.
7. If not `-NoSend`, posts the generated messages to Discord target `1499631210283008002`.

Primary outputs:
- `reports\trade_journal\raw_bitget_history_latest.json`
- `reports\trade_journal\raw_positions_latest.json`
- `reports\trade_journal\bitget_futures_trade_report_latest.xls`
- `reports\trade_journal\bitget_futures_order_history_latest.csv`
- `reports\trade_journal\bitget_thread_messages_latest.json`

## Bitget-specific scope
- This is not the MT5 workflow.
- Only the generic Discord-safe reporting pattern is reused: compact summary first, chunked messages, transparent artifact/source paths, then current state/recent executions.
- Do not include MT5 planner/executor/validator/open-compact-report assumptions.
- Treat Bitget as a semi-automatic workflow: TradingView/Pine provides signal/setup context; Bitget API provides exchange state; live order changes require explicit user confirmation unless a separate approved execution workflow says otherwise.

## Safety
- This job is read/report only.
- Never set live-order flags.
- Never call cancel/place scripts.
- Never expose API secrets or env file contents.
- If Discord posting is unavailable in the current runtime, do not guess another destination; return the message count and artifact paths so tvflow can post or summarize manually.
