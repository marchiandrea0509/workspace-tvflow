# Virtual OCO Watchdog Tool

Reusable read-only Bitget Virtual OCO alert watchdog for prepared D/VOCO trade ideas.

## Safety boundary

- Alerting only.
- Never places live orders.
- Never imports or calls live order scripts.
- Uses prepared ticket levels/size/SL/TP only; it does not creatively redesign the trade.
- Sends alert text only when one prepared family becomes valid, or when the idea expires/invalidates.
- For scheduled Discord VOCOs, **do not rely on cron runner DM delivery**. Use the in-agent Discord message tool / direct message-tool route for critical DM alerts.
- After alert/expiry/invalidation, state stops until explicitly re-armed.

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
- paste the prepared A/B pullback ticket and/or C breakout/breakdown ticket exactly from the deep analysis
- set `preferredFamily` if both sides pass on the same check
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

## Scheduling

Run 1-3 minutes after the closed candle for the selected check TF.

### Robust Discord routing pattern

For Andrea's mobile alerts, actual `VIRTUAL OCO ALERT` triggers must arrive by DM. The proven route is **direct in-agent Discord message-tool send** to `user:1322306175865323552`, not cron runner `announce` delivery to `dm:<id>`.

Recommended scheduled job behavior:

1. Set cron delivery mode to `none` / no runner fallback delivery.
2. Allow the cron agent to use `exec` plus the Discord message tool.
3. Run the watchdog first with `-Json -Feedback -NoStateUpdate` so a trigger is not marked alerted before notification is attempted.
4. If the message is routine `VIRTUAL OCO CHECK`, send it by message tool to the Bitget Trades room.
5. If the message is `VIRTUAL OCO ALERT`, send it by message tool to `user:1322306175865323552` first; retry `dm:1322306175865323552` if needed; room fallback only after DM attempts fail.
6. After the notification attempt completes, run the watchdog once without `-NoStateUpdate` to persist state. If notification could not be attempted at all, do not commit state; leave it armed for retry.

This avoids the failure mode where cron runner delivery resolves `dm:<id>` but returns `not-delivered`, while preserving DM-first mobile alerts.

For a normal 4H watchdog, schedule around minute `2` after 00:00/04:00/08:00/12:00/16:00/20:00 UTC.

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
