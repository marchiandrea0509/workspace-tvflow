# Position / Order Diagnostic Tool

Read-only diagnostic for open Bitget futures orders and positions.

## Purpose

`position-order-diagnostic.js` checks current open regular orders, open positions, TP/SL plan rows, Bitget OHLCV state, and liquidity/orderability, then outputs recommendations such as:

- `KEEP_UNCHANGED`
- `KEEP_BUT_MONITOR`
- `REDUCE_RISK`
- `TP_REFRESH`
- `CANCEL_UNFILLED`
- `FULL_REFRESH`
- `EXIT_OR_INVALID`

The tool **never places, cancels, exits, or modifies exchange orders**. Any suggested change requires a separate explicit user confirmation and the normal live-execution safety workflow.

## Command

```powershell
node scripts/position-order-diagnostic.js --markdownOut reports/diagnostics/latest.md --out reports/diagnostics/latest.json
```

Optional scope:

```powershell
node scripts/position-order-diagnostic.js --symbols UNHUSDT,GEUSDT
```

Optional faster/no-liquidity run:

```powershell
node scripts/position-order-diagnostic.js --liquidity false
```

## Current v1 checks

For every active symbol the tool reads:

- all pending regular futures orders
- all open futures positions
- pending `normal_plan`, `profit_loss`, and `track_plan` rows
- current ticker
- recent 1H / 4H / 1D candles
- local structured execution summaries where `summary.json` exists
- liquidity gate state using the existing harness gate

Diagnostics include:

- open risk to SL
- remaining or order-level R:R
- distance to entry in ATR4H
- distance to SL / TP in ATR4H
- 1D / 4H / 1H trend snapshot
- nearest simple 1H/4H support/resistance from recent candles
- stale-ticket detection using a default 5-day horizon
- unfilled pullback-order TP handling: for a buy limit with `entry < TP < current`, current price already being above TP is **not** stale by itself; it remains a valid deeper pullback order if the TP is still profitable relative to entry
- deep-distance decay warning: if an unfilled pullback order is more than `deepPullbackMonitorAtr` away from current price (default `4.0 ATR4H`), classify it as `KEEP_BUT_MONITOR` / deep contingency rather than `KEEP_UNCHANGED`; distance alone is not a cancel/refresh trigger
- partially-filled static campaign handling: when an open position already exists and a same-side remaining leg is still pending, ticket age beyond the 5-day horizon is a monitor/optional-risk-reduction warning, not an automatic `FULL_REFRESH`
- missing TP/SL plan detection for positions
- liquidity/orderability gate summary

## Safety boundaries

- No automatic cancel.
- No automatic SL move.
- No automatic TP edit.
- No automatic partial close or exit.
- Recommendations are advisory only.
- If a symbol needs action, use the normal live-order workflow with explicit confirmation.

## Known limitations

This is a deterministic v1 diagnostic, not a full discretionary deep-analysis replacement. It uses Bitget OHLCV and simple structure approximations. If it returns `FULL_REFRESH`, `TP_REFRESH`, or an uncertain `KEEP_BUT_MONITOR`, run a fresh full ticket analysis before making a live change.

Some older live placements only have `summary.md`, not structured `summary.json`; those still diagnose from live exchange order data, but original thesis text may be unavailable to the tool.
