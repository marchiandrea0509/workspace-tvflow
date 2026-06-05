# Virtual OCO Watchdog Tool

Reusable read-only Bitget Virtual OCO alert watchdog for prepared D/VOCO trade ideas.

## Safety boundary

- Alerting only.
- Never places live orders.
- Never imports or calls live order scripts.
- Never cancels or modifies live orders.
- Uses prepared ticket levels/size/SL/TP only; it does not creatively redesign the trade.
- Sends alert text only when one prepared family becomes valid, or when the idea expires/invalidates.
- Routine watchdog status/no-trigger feedback should land in the Bitget Trades room/thread.
- Actual `VIRTUAL OCO ALERT` trade triggers should land in Andrea's Discord DM first, with room mention fallback if DM attempts fail.
- For scheduled Discord VOCOs, **do not rely on cron runner DM delivery**. Use the in-agent Discord message tool / direct message-tool route for critical DM alerts.
- After alert/expiry/invalidation, state stops until explicitly re-armed.
- For scheduled watchdogs, set `scheduler.cronId` and keep `scheduler.cancelCronAfterTerminal: true`; after the terminal state is committed, the tool disables that OpenClaw cron job so it does not keep waking uselessly.

## Files

- `scripts/virtual_oco_watchdog.js` — reusable Node CLI.
- `scripts/run_virtual_oco_watchdog.ps1` — PowerShell wrapper.
- `watchdog/virtual_oco_watchdog.template.json` — copy/edit per trade idea.
- State output: `reports/watchdogs/virtual_oco/<OCO_GROUP_ID>.state.json`.

## Basic flow

1. Copy the template:

```powershell
Copy-Item watchdog\virtual_oco_watchdog.template.json watchdog\virtual_oco_MYTRADE.json
```

2. Edit the copy:

- set `enabled: true`
- set `ocoGroupId`
- set `symbol`
- set `mainTf`, `checkTf`, `expiryUtc`
- set `risk_cap_usd`; if omitted, the tool defaults to `100`
- optionally set `execution_mode` to `PURE_VOCO`, `HYBRID_VOCO`, or `HYBRID_C100`; if omitted, the tool infers from read-only live state
- paste the prepared A/B pullback ticket and/or C breakout/breakdown ticket exactly from the deep analysis
- set `preferredFamily` if both sides pass on the same check
- for scheduled jobs, set `scheduler.cronId` to the OpenClaw cron job id and keep `scheduler.cancelCronAfterTerminal: true`
- keep `discord.target` as Andrea user DM for ad-hoc `-Send`; for scheduled cron jobs use the direct message-tool routing pattern below

3. Dry-run/check without sending:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_virtual_oco_watchdog.ps1 `
  -Config watchdog\virtual_oco_MYTRADE.json `
  -Json
```

4. Ad-hoc live alert mode (still no order placement):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_virtual_oco_watchdog.ps1 `
  -Config watchdog\virtual_oco_MYTRADE.json `
  -Send
```

For recurring cron/watchdog jobs, prefer the robust scheduled pattern below instead of `-Send` or runner announce DM delivery.

The script prints `NO_REPLY` when nothing should be surfaced.

If you want visible feedback on every scheduled check, set `feedbackOnEveryCheck: true` in the config, or pass `-Feedback` to the wrapper. The feedback remains alert-only: it prints current price, checked candle, and the first blocking gate for each family, and it never places/cancels orders.

## Execution modes

The watchdog supports three alert-only modes:

- `PURE_VOCO`: A/B pullback and C breakout/breakdown are both virtual alternatives. First valid family triggers a DM proposal, blocks the other family, and stops the watchdog.
- `HYBRID_VOCO`: A/B ladder orders may already be live while C remains virtual. A/B and C are alternatives; if C triggers while ladder orders may still be live, the DM warns that ladder exposure must be cancelled/blocked through the normal live-order workflow before accepting C.
- `HYBRID_C100`: A/B ladder and C may coexist only when the original analysis/config explicitly approves C100 or a C100 plan/order is already active. C trigger requires combined all-filled risk verification against `risk_cap_usd`.

Mode inference when `execution_mode` is blank:

- no live ladder and no C100 order/plan detected → `PURE_VOCO`
- live ladder detected and no C100 order/plan detected → `HYBRID_VOCO`
- C100 order/plan active or explicitly marked active → `HYBRID_C100`
- unclear live state → no trade proposal; DM manual-review warning

Every alert/manual-review message reports:

- `Execution mode`: `PURE_VOCO`, `HYBRID_VOCO`, `HYBRID_C100`, or `UNKNOWN`
- `Execution mode source`: `user_specified`, `inferred_no_live_ladder`, `inferred_live_ladder`, `inferred_c100_active`, or `unknown`
- `Risk cap USD`
- `Ladder status`: `NONE`, `OPEN_UNFILLED`, `PARTIALLY_FILLED`, `FULLY_FILLED`, or `UNKNOWN`
- `C100 status`: `INACTIVE`, `ACTIVE`, or `UNKNOWN`
- `Risk mode`: alternative risk for `PURE_VOCO`/`HYBRID_VOCO`, combined risk for `HYBRID_C100`

Read-only live-state inference checks regular orders, positions, and configured plan types. The default plan-type list is `normal_plan`, `profit_loss`, and `track_plan` so conditional C100 plans and TP/SL/trailing rows are all visible to the classifier.

Risk rules:

- `risk_cap_usd` is the planned-risk cap. If missing, it defaults to `100`.
- All VOCO/HYBRID/C100 risk checks compare against `risk_cap_usd`; no hardcoded `$100` gate is used.
- If risk cannot be calculated or verified, the tool does not approve the trigger and sends a refresh/manual-review alert instead of a trade proposal.
- For `HYBRID_C100`, configure the `c100` block (`approved`, planned ladder risk, proposed C risk, combined margin/leverage/R:R/liquidation checks) or ensure a C100 plan/order is detectable in live state.

For `HYBRID_C100` C alerts, the message includes a `C100 compliance` block with risk cap, combined risk, combined-risk pass/fail, shared-invalidation pass/fail, blended-R:R pass/fail, and margin/leverage/liquidation pass/fail.

## Scheduling

Run a few minutes after the closed candle for the selected check TF.

When multiple virtual OCO watchdogs are active on the same timeframe, stagger them in deterministic 3-minute slots to avoid parallel agent/API/Discord load. For 4H jobs use UTC close+5m for the first active watchdog, then close+8m, +11m, +14m, etc. Match each config's `checkDelayMinutes` to its cron minute so `latestClosed` logic remains explicit.

### Robust Discord routing pattern

For Andrea's mobile alerts, actual `VIRTUAL OCO ALERT` triggers must arrive by DM. The proven route is **direct in-agent Discord message-tool send** to `user:1322306175865323552`, not cron runner `announce` delivery to `dm:<id>`.

Hard anti-regression check: a scheduled VOCO job is misconfigured for critical alerts if its top-level cron delivery is `announce` to a room/user and the payload does not explicitly perform direct message-tool routing. A room-delivered alert is not evidence that DM worked; confirm run history contains `messageToolSentTo user:1322306175865323552` for DM tests/triggers.

Recommended scheduled job behavior:

1. Set cron delivery mode to `none` / no runner fallback delivery.
2. Allow the cron agent to use `exec` plus the Discord message tool.
3. Run the watchdog first with `-Json -Feedback -NoStateUpdate` so a trigger is not marked alerted before notification is attempted.
4. If the message is routine `VIRTUAL OCO CHECK`, send it by message tool to the Bitget Trades room (`channel:1499631210283008002`).
5. If the message is an actual `VIRTUAL OCO ALERT`, send it by message tool to `user:1322306175865323552` first; retry `dm:1322306175865323552` if needed; room fallback with `<@1322306175865323552>` only after DM attempts fail.
6. If the message is `VIRTUAL OCO INVALIDATED` or `VIRTUAL OCO EXPIRED`, send it to the Bitget Trades room unless it contains an actual `VIRTUAL OCO ALERT`.
7. After the notification attempt completes, run the watchdog once without `-NoStateUpdate` to persist state. If notification could not be attempted at all, do not commit state; leave it armed for retry.
8. On the commit run, if the watchdog returns `ALERTED`, `EXPIRED`, or `INVALIDATED` and `scheduler.cancelCronAfterTerminal` is enabled, the tool runs `openclaw cron disable <scheduler.cronId>` automatically.

This avoids the failure mode where cron runner delivery resolves `dm:<id>` but returns `not-delivered`, while preserving DM-first mobile alerts.

For a normal 4H watchdog, schedule around minute `5` after 00:00/04:00/08:00/12:00/16:00/20:00 UTC; if another 4H watchdog already uses that slot, use the next 3-minute slot (`8`, then `11`, etc.).

For a ticket that explicitly requires 1H tactical confirmation, set `checkTf: "1H"` and schedule hourly 1-3 minutes after the hour.

## State controls

```powershell
# Show state
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_virtual_oco_watchdog.ps1 -Config watchdog\virtual_oco_MYTRADE.json -Mode status -Json

# Re-arm after an alert/expiry/invalidation, only when Andrea explicitly wants it re-armed
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_virtual_oco_watchdog.ps1 -Config watchdog\virtual_oco_MYTRADE.json -Mode rearm -Json

# Disarm manually
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_virtual_oco_watchdog.ps1 -Config watchdog\virtual_oco_MYTRADE.json -Mode disarm -Json
```

## Trigger model

### Global checks first

The watchdog stops if:

- expiry is reached
- global invalidation condition passes
- prepared risk/margin/leverage/R:R gates fail for the triggering family
- prepared `structuralValid` or `tpOpenSpaceValid` is false

### Pullback family A/B

Default trigger is `touch_entry_zone`:

- uses `entryZone` if present
- otherwise derives a zone from `entries[].entry`
- a closed check candle touching the zone or current price inside the zone can trigger
- optional `confirmations[]` can require a closed-candle condition

### Breakout/breakdown family C

Default confirmation:

- `BREAKOUT` / long: closed check candle above `trigger`
- `BREAKDOWN` / short: closed check candle below `trigger`

Optional `confirmationRule` values:

- `closed_above_trigger`
- `closed_below_trigger`
- `crossed_above`
- `crossed_below`
- `wick_cross_above`
- `wick_cross_below`

`maxStalenessDistance` + `maxStalenessUnit: "ATR"` implements max chase.

## Generic confirmation conditions

Example:

```json
{
  "description": "4H close above trigger",
  "field": "checkClosed.close",
  "op": ">=",
  "value": 193.5
}
```

Supported fields include:

- `currentPrice`
- `checkClosed.open/high/low/close`
- `prevCheckClosed.open/high/low/close`
- `mainClosed.open/high/low/close`
- `prevMainClosed.open/high/low/close`
- `atr4h`

Supported ops: `>`, `>=`, `<`, `<=`, `==`, `!=`.

## Discord output

When a family triggers, the alert starts with:

```text
VIRTUAL OCO ALERT — TRADE PROPOSAL READY
```

The action line always says the watchdog did not place any live order. Andrea must place separately using the normal live-order flow if accepted.

## Breakout candle quality gate

For breakout/breakdown family C, the watchdog now applies two objective candle-quality checks in addition to the existing closed-candle trigger and max-chase checks.

Defaults:

- `minCloseBufferAtr`: `0.10`
- `minClosePositionLong`: `0.60`
- `maxClosePositionShort`: `0.40`

Definitions:

```text
closePosition = (close - low) / (high - low)
```

LONG breakout passes the candle-quality gate only if:

```text
close - trigger >= minCloseBufferAtr * ATR4H
closePosition >= minClosePositionLong
```

SHORT breakdown passes the candle-quality gate only if:

```text
trigger - close >= minCloseBufferAtr * ATR4H
closePosition <= maxClosePositionShort
```

This prevents marginal closes just beyond the trigger and weak/rejection candles from producing a VOCO C alert.
