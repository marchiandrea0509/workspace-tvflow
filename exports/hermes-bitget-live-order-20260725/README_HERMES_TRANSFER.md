# Hermes transfer bundle: Bitget live orders

This bundle contains the complete verified workflow used by `tvflow` for Bitget futures live-order placement:

- authenticated Bitget account/contract/order/position access
- isolated margin and leverage changes
- full-ladder liquidity and stop-exit checks
- explicit YELLOW/RED override enforcement
- regular limit orders with preset SL/TP
- independent exchange postchecks
- TradingView Desktop Entry/SL/TP drawing and screenshot receipts
- journal workbook/CSV/message generation
- Discord journal delivery through a webhook or OpenClaw fallback
- a known-good AAPLUSDT end-to-end example

No API credentials, Discord webhook, `.env.local`, `node_modules`, or Git metadata are included.

## Platform requirements

- Windows 10/11 for TradingView Desktop automation.
- TradingView Desktop installed from the Microsoft Store.
- Node.js 18 or newer.
- Python 3.9 or newer with timezone data available.
- Windows PowerShell 5.1 or PowerShell 7.
- A Bitget API key with only the permissions you intend to use.
- For journal delivery from Hermes, a Discord webhook in `DISCORD_WEBHOOK_URL`.

The Bitget and journal logic can be adapted to another OS, but the included TradingView Desktop launcher uses Windows AppX activation and CDP port `9222`.

## Install

1. Extract the ZIP.
2. Run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\INSTALL.ps1
   ```

3. Open `bitget-futures-harness\.env.local` and insert your own Bitget credentials.
4. Leave demo mode and both placement flags disabled until read-only checks pass.
5. Set `DISCORD_WEBHOOK_URL` in the Hermes process environment if journal delivery should post to Discord.
6. Start TradingView Desktop with:

   ```powershell
   .\tradingview\start-tv-debug-detached.cmd
   ```

7. Validate:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\validate_package.ps1
   ```

## Safe commissioning

Keep this initial configuration:

```text
BITGET_ENV=demo
BITGET_PAPTRADING=1
BITGET_ALLOW_ORDER_PLACEMENT=false
BITGET_ALLOW_LIVE_TRADING=false
```

Run read-only checks:

```powershell
Set-Location .\bitget-futures-harness
node .\scripts\account.js
node .\scripts\positions.js
node .\scripts\list-open-orders.js --symbol AAPLUSDT
```

Run a liquidity gate without placing:

```powershell
node .\scripts\liquidity-gate.js `
  --symbol AAPLUSDT `
  --holdSide long `
  --maxQty 15.35 `
  --entryPrice 325.310019544 `
  --positionNotional 4993.5088 `
  --slPrice 318.80 `
  --plannedRiskUsdt 99.9288 `
  --plannedLeverage 39 `
  --sampleCount 3 `
  --json
```

## Live placement contract for Hermes

Hermes should follow `HERMES_SKILL_PROPOSAL.md`. The critical sequence is:

1. Require an explicit live instruction.
2. Read contract, tier, ticker, account, orders, positions, and plan rows.
3. Reconcile the complete ladder and precision.
4. Calculate leverage, margin, and fee-adjusted liquidation against SL.
5. Run the complete-ladder liquidity gate.
6. Require explicit YELLOW/RED override when applicable.
7. Set/confirm isolated margin and leverage.
8. Place each order with unique client OID, preset SL/TP, and full-ladder gate inputs.
9. Independently postcheck exact exchange state.
10. Draw solid live Entry/SL/TP levels, add the group placement arrow, and save a screenshot.
11. Refresh/deliver the journal and require a message ID.
12. Report complete only after exchange, screenshot, and journal receipts all pass.

Do not persistently enable live flags. Scope them to the exact approved placement process where possible:

```powershell
$env:BITGET_ALLOW_ORDER_PLACEMENT='true'
$env:BITGET_ALLOW_LIVE_TRADING='true'
node .\scripts\place-order.js ... --send
Remove-Item Env:BITGET_ALLOW_ORDER_PLACEMENT
Remove-Item Env:BITGET_ALLOW_LIVE_TRADING
```

For a RED gate, every placement leg must include:

```text
--liquidityGateOverride RED
--liquidityGateOverrideReason "specific user-approved reason and audit/message reference"
```

For ladder-like client OIDs ending in `L1`, `B1`, or `S1`, also pass the full-ladder:

```text
--gateMaxQty
--gateEntryPrice
--gatePositionNotional
--gatePlannedRisk
--plannedLeverage
```

## TradingView marking

Edit `templates\trade_plan.json`, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tradingview\tv_draw_trade_plan.ps1 `
  -PlanPath .\templates\trade_plan.json
```

Real orders must use:

```json
{
  "kind": "live",
  "lineStyle": "solid"
}
```

Include `order_time` and `arrow_price`. Ladder plans should use one group arrow:

```json
{
  "arrow": {
    "enabled": true,
    "length_bars": 2,
    "mode": "single"
  }
}
```

## Journal and mandatory finalizer

Journal-only dry run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_bitget_journal_update.ps1 `
  -Symbols AAPLUSDT `
  -DeliveryProfile live-order `
  -NoSend
```

After an actual live-order postcheck:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\finalize_bitget_live_order_workflow.ps1 `
  -PlanPath .\templates\trade_plan.json `
  -Symbols AAPLUSDT `
  -Target 'channel:YOUR_DISCORD_CHANNEL_ID' `
  -MessagePrefix 'Journal refreshed after confirmed Bitget live-order action.'
```

The final receipt must contain:

- non-empty TradingView screenshot path
- expected drawing entity count
- journal workbook snapshot
- at least one Discord message ID

`-NoSend` is diagnostic only and does not satisfy the live-order delivery gate.

## Messaging adapter

`scripts\send_message_adapter.ps1` chooses:

1. `DISCORD_WEBHOOK_URL` when set—recommended for Hermes.
2. The `openclaw` CLI when available.
3. Otherwise it fails safely and prevents a false delivery-complete result.

Never place a webhook URL in a committed or shared file.

## Included example

`examples\aapl-live-order\` contains the exact AAPLUSDT example:

- exchange order IDs and postcheck receipt
- liquidity-gate JSON
- workflow and journal receipts
- TradingView screenshot
- execution summary

`examples\journal\` contains a sample workbook, CSV, and Discord message payload. These are examples only; regenerate them after connecting Hermes to the intended Bitget account.

## Skill Workshop status

The reusable procedure was created through OpenClaw Skill Workshop as pending proposal:

`hermes-bitget-live-order-20260725-c43e659f82`

It was not applied automatically. `HERMES_SKILL_PROPOSAL.md` is the exported transfer copy.
