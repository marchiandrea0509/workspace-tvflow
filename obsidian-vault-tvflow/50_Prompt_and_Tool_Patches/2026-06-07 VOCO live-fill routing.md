# 2026-06-07 — VOCO live-fill routing

Labels: `approved_rule`, `safety_critical`, `tool_patch`

## Rule

VOCO Discord DMs are only for **virtual order/branch trigger proposals**.

When the real/live leg of a `HYBRID_VOCO` fills (`PARTIALLY_FILLED` or `FULLY_FILLED`), the watchdog must:

1. cancel/disarm the remaining virtual alternative in watchdog state,
2. send a Bitget Trades room update only,
3. not DM Andrea,
4. not place/cancel/modify any exchange order.

## Implementation

Patched `scripts/virtual_oco_watchdog.js`:
- added terminal status `LIVE_LEG_FILLED`
- added message `VIRTUAL OCO LIVE LEG FILLED — VIRTUAL ALTERNATIVE CANCELLED`
- sets `notificationKind=room`
- includes `LIVE_LEG_FILLED` in terminal cron-disable behavior

Updated docs/template/prompts:
- `README_VIRTUAL_OCO_WATCHDOG.md`
- `watchdog/virtual_oco_watchdog.template.json`
- `prompts/cron_virtual_oco_CLUSDT_20260605_GPTB_C2.md`
- `prompts/cron_virtual_oco_GEUSDT_20260605_BC1.md`

## Validation

- `node --check scripts\virtual_oco_watchdog.js`
- Forced CL dry-run with `-NoStateUpdate -Force` returned:
  - `status=LIVE_LEG_FILLED`
  - ladder `FULLY_FILLED`
  - position size `37.5`
  - `notificationKind=room`
