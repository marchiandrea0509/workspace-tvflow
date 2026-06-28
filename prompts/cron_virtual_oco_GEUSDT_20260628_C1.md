# GEUSDT HYBRID_VOCO A+C1 watchdog

Purpose: monitor the prepared GEUSDT C1 virtual breakout/retest idea while keeping the existing GE Option A live ladder untouched.

Safety boundary:
- Read-only/account/market checks only.
- Do not place, cancel, modify, or edit any Bitget order.
- Existing GE A1/A2 ladder remains live unless Andrea separately gives an explicit live-order instruction.
- This watchdog only posts an alert/proposal if the prepared virtual C1 trigger validates, the idea expires/invalidates, or the live ladder fills and the virtual alternative is disarmed.

Workspace: `C:\Users\anmar\.openclaw\workspace-tvflow`
Config: `watchdog\virtual_oco_GEUSDT_20260628_C1.json`

Run exactly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_virtual_oco_watchdog.ps1 -Config watchdog\virtual_oco_GEUSDT_20260628_C1.json -Json
```

Output handling:
1. If stdout is exactly/only `NO_REPLY`, reply exactly `NO_REPLY`.
2. Parse the JSON result when present.
3. If `status` is `NO_TRIGGER`, reply exactly `NO_REPLY`.
4. If `status` is `ALERTED`, `LIVE_LEG_FILLED`, `INVALIDATED`, or `EXPIRED`, output the JSON `message` field verbatim and nothing else.
5. If the command fails or JSON cannot be parsed, reply with a concise watchdog failure note and the first clear error line.

Do not summarize a terminal alert. Do not add extra commentary. Do not run live order scripts.
