# GEUSDT HYBRID B + C1 Virtual OCO Watchdog Cron

Run the reusable GEUSDT alert-only VOCO watchdog. Hard safety: do NOT place, cancel, or modify any exchange order. This is alert-only.

Workdir: `C:\Users\anmar\.openclaw\workspace-tvflow`

Primary read-only command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_virtual_oco_watchdog.ps1 -Config watchdog\virtual_oco_GEUSDT_20260605_BC1.json -Json -Feedback -NoStateUpdate
```

Routing requirement:
- Use the Discord message tool directly when available. Do NOT rely on cron/runner announce delivery for DM alerts.
- Routine `VIRTUAL OCO CHECK` / no-trigger status: send to Discord `channel:1499631210283008002`.
- Actual `VIRTUAL OCO ALERT` trade trigger: send to Discord DM target `user:1322306175865323552` first. Andrea's mobile alerts depend on DM.
- If the DM message tool reports failure, retry once to `dm:1322306175865323552`. If both DM attempts fail, send urgent fallback to `channel:1499631210283008002` with `<@1322306175865323552>` and the exact alert text, then report the DM failure. Never silently lose a trigger.
- `VIRTUAL OCO INVALIDATED` / `EXPIRED`: send to `channel:1499631210283008002` unless the text contains `VIRTUAL OCO ALERT`.

State commit rule:
- The primary command uses `-NoStateUpdate` so a trigger is not marked alerted before notification is attempted.
- After the appropriate message-tool notification attempt is complete, run this commit command once to persist watchdog state:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_virtual_oco_watchdog.ps1 -Config watchdog\virtual_oco_GEUSDT_20260605_BC1.json -Json -Feedback
```

- If notification could not be attempted at all, do NOT run the commit command; leave state armed so the next run retries.

Interpretation:
- Parse JSON stdout from the primary command.
- If status/message is exactly `NO_REPLY`, final reply exactly `NO_REPLY`.
- If message starts with `VIRTUAL OCO CHECK`, send that message to the room, commit state, then final reply exactly `NO_REPLY`.
- If message starts with `VIRTUAL OCO ALERT`, send that exact message by DM as above, commit state after the notification attempt, then final reply exactly `NO_REPLY`.
- If the watchdog says it is already `ALERTED` / `INVALIDATED` / `EXPIRED`, do not send another alert; disable the cron if possible and final reply exactly `NO_REPLY`.
- If command errors or state is unclear, send a concise room alert saying the GEUSDT virtual OCO watchdog check failed and no order was placed, including the blocker, then final reply exactly `NO_REPLY`.

This job checks only the latest fully CLOSED 4H candle after close+17m and never triggers from intrabar wicks. GE B ladder is live/resting; C1 is virtual alert-only and must never auto-place live.
