# Cron: ASMLUSDT GPT Option B HYBRID VOCO C1 watchdog

Purpose: run the alert-only virtual OCO watchdog for the ASMLUSDT GPT Option B HYBRID VOCO setup.

Safety boundary:
- Read-only checks plus Discord alert output only.
- Do not place, cancel, modify, or resize exchange orders.
- Do not import or call live order placement tools.
- The watchdog script itself may send Discord messages only for terminal statuses (`ALERTED`, `INVALIDATED`, `EXPIRED`, `LIVE_LEG_FILLED`).

Run exactly from workspace:

```powershell
node scripts\virtual_oco_watchdog.js --config watchdog\virtual_oco_ASMLUSDT_20260614_GPTB_C1.json --send true --json
```

Response rules:
- If the command exits successfully and the JSON/status is routine/no trigger (`NO_REPLY`, `NO_TRIGGER`, `CHECKED`, or `CHECKED_ALREADY`), reply exactly `NO_REPLY`.
- If the command exits successfully with terminal status (`ALERTED`, `INVALIDATED`, `EXPIRED`, or `LIVE_LEG_FILLED`), the script should already have sent the operational Discord alert; reply exactly `NO_REPLY` unless the JSON says `sentDiscord` is missing/false.
- If the command fails, reply with one concise blocker line including the first clear error.
