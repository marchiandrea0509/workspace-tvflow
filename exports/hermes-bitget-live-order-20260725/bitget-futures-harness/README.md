# Bitget Futures Harness

A local Node.js harness to test **Bitget futures API trading**, starting safely with **demo trading**.

## What this does

- verifies API connectivity
- reads futures account state
- reads open positions
- can set margin mode and leverage
- can place/cancel futures orders
- can execute a JSON signal payload as the base for automation

## Strong recommendation

Start with **demo API keys only**.

Bitget's docs indicate demo trading is supported via API using a **Demo API Key** and the request header **`paptrading: 1`**. This harness defaults to that safe setup.

## Where to paste your keys

Paste them into this file on disk:

`C:\Users\anmar\.openclaw\workspace-tvflow\bitget-futures-harness\.env.local`

Do **not** paste API keys into Discord/chat.

## Key fields in `.env.local`

- `BITGET_API_KEY`
- `BITGET_API_SECRET`
- `BITGET_API_PASSPHRASE`

For demo trading keep:

- `BITGET_ENV=demo`
- `BITGET_PAPTRADING=1`
- `BITGET_ALLOW_ORDER_PLACEMENT=false` initially
- `BITGET_ALLOW_LIVE_TRADING=false`

## First tests

Open a terminal in:

`C:\Users\anmar\.openclaw\workspace-tvflow\bitget-futures-harness`

Then run:

```powershell
node scripts/account.js
node scripts/positions.js
```

If those work, you have authenticated connectivity.

## Safe order workflow

1. Keep `.env.local` on demo keys.
2. Review the example signal at `examples\open-long.market.json`.
3. Dry-run it first:

```powershell
node scripts/execute-signal.js --signal examples/open-long.market.json
```

4. Only when ready, enable sending in `.env.local`:

```text
BITGET_ALLOW_ORDER_PLACEMENT=true
```

5. Then send the order:

```powershell
node scripts/execute-signal.js --signal examples/open-long.market.json --send
```

6. After exchange postchecks for any confirmed live-order placement/replacement, run the mandatory delivery finalizer. It draws the exact live orders on TradingView Desktop, saves a screenshot, refreshes the semi-auto journal, posts the one-message live-order journal profile to `BITGET Trades`, and writes a machine-readable receipt:

```powershell
powershell -ExecutionPolicy Bypass -File ..\scripts\finalize_bitget_live_order_workflow.ps1 -PlanPath C:\Users\anmar\tools\trade_plan_from_oc.json -Symbols JDUSDT -MessagePrefix "Journal refreshed after JDUSDT live order."
```

The live-order workflow is complete only when the receipt contains a TradingView screenshot and at least one journal Discord `messageId`. Use `-ValidateOnly` to check plan shape/prerequisites without drawing or posting. `-NoSend` is diagnostic only and does not satisfy the normal live-order delivery gate.

For journal-only maintenance outside a live-order action, continue using `run_bitget_journal_update.ps1`. Its `-DeliveryProfile live-order` option combines the report summary and active-order rows into one atomic Discord message; `-ReceiptOut <path>` writes the delivery result for automation.

## Robustness / anti-regression workflow

After any meaningful live-order tooling change, do not rely on chat memory only.
Harden the workflow in this order:

1. Encode the fix in the tool or script where possible.
2. Dry-run or syntax-check the tool before live use.
3. Use live placement gates only for the exact send command; do not persistently loosen `.env.local` unless explicitly intended.
4. Postcheck Bitget state with `list-open-orders.js` / `positions.js` after live changes.
5. Run `finalize_bitget_live_order_workflow.ps1` and require both the TradingView screenshot and journal message-ID receipts.
6. Update project memory/docs with the lesson:
   - `PROJECT_STATE.md` for the latest operational state and known quirks
   - this README or another relevant README for reusable command/checklist behavior
   - `memory/YYYY-MM-DD.md` for durable decisions and safety boundaries

For each durable note, include: what changed, why, the discovered quirk/mistake,
what future runs must do differently, and the validation/postcheck evidence.

### Bitget timestamp drift guard

Authenticated requests sign with a server-adjusted timestamp by default. `lib/bitgetClient.js` fetches `/api/v2/public/time`, caches the offset, and applies it to `ACCESS-TIMESTAMP`. This avoids `40008 Request timestamp expired` when the Windows host clock drifts outside Bitget's acceptance window.

Optional env controls:

```text
BITGET_USE_SERVER_TIME=true
BITGET_SERVER_TIME_CACHE_MS=300000
```

If authenticated calls suddenly fail with timestamp errors, first verify public server time vs local time before changing order logic.

### TP trailing split / Bitget plan-order quirk

Use the split tool when an existing position has fixed TP rows that must be
converted into fixed TP + trailing TP rows:

```powershell
node scripts/set-tp-trailing-split.js --config path\to\split.json          # dry-run
node scripts/set-tp-trailing-split.js --config path\to\split.json --send   # live, gated
```

Important Bitget API behavior discovered live on CLUSDT:

- Existing TP/SL rows are listed with `orders-plan-pending planType=profit_loss`.
- Targeted cancellation of fixed TP rows must use `cancel-plan-order` with
  `planType: "profit_plan"` and `orderIdList`.
- Do **not** cancel these rows with only a top-level `orderId`; Bitget can ignore
  the intended TP row and affect other plan types unexpectedly.
- Always verify both `profit_loss` and `track_plan` after the change.

## Execution service project

The long-term execution-service plan is documented in:

`README_EXECUTION_SERVICE.md`

Phase 1 is intentionally dry-run/read-only. It introduces a shared audit format,
basic plan validation, override taxonomy, and optional live-state reads without
changing any existing live scripts.

Example dry-run audit:

```powershell
node scripts/execution-service-dry-run.js --plan path\to\execution-plan.json
```

Optional read-only account/order snapshot:

```powershell
node scripts/execution-service-dry-run.js --plan path\to\execution-plan.json --readLive
```

Audit JSON files are written to `reports/live_execution/audit/`.

## Position / order diagnostic

For read-only recommendations on currently open Bitget futures orders/positions, use:

```powershell
node scripts/position-order-diagnostic.js --markdownOut reports/diagnostics/latest.md --out reports/diagnostics/latest.json
```

This tool only classifies and recommends (`KEEP_UNCHANGED`, `CANCEL_UNFILLED`, `TP_REFRESH`, etc.). It never cancels, modifies, exits, or places exchange orders. See `README_POSITION_DIAGNOSTIC.md`.

## Live-trading safety

The harness refuses live order placement unless **both** are true:

- `BITGET_ENV=live`
- `BITGET_ALLOW_LIVE_TRADING=true`

That prevents accidental live execution if demo/live keys are mixed up.

Live open orders also run the liquidity gate before placement. `GREEN` is
technically placeable only after the normal explicit order request/confirmation;
`YELLOW` requires `--liquidityGateOverride YELLOW`; `RED` is blocked unless
Andrea explicitly gives a RED-liquidity override and acknowledges the named risk.
If the user explicitly accepts a RED liquidity/slippage risk, the placement
scripts require both of these flags on that specific send command:

```powershell
--liquidityGateOverride RED --liquidityGateOverrideReason "specific user-approved reason"
```

For ladder-looking order client IDs ending in `_L1`, `_B1`, `_S1`, etc., still
provide the full-ladder gate inputs so the gate evaluates worst-case stop size:
`--gateMaxQty`, `--gatePositionNotional`, and `--gatePlannedRisk`.

Current liquidity-gate decision hierarchy:

1. Primary execution gates:
   - haircutted stop-exit simulated slippage using 50% visible depth
   - near-market executable depth within 0.25% / 0.50% of current price
   - spread stability using the worst observed spread across samples
2. Supporting liquidity gates:
   - p10 / weak-minute volume stress from non-dead 120x1m quote-volume candles
   - dead 1m candles from median non-zero quote volume, not average
   - 24h quote-volume ratio
3. Visible depth-to-SL corridor is informational only and is not a hard gate.

If a live-order request fails liquidity/slippage gates, report two downsized
fallbacks rather than only rejecting:

- Proposal A: cap extra stop-market slippage to `slippage_pct x original/base planned risk`.
- Proposal B: cap extra stop-market slippage to `slippage_pct x new planned no-slippage risk`.

Default `slippage_pct` is `5%`. If the resulting size is too small to be
meaningful or still fails required gates, return `NO_TRADE`.

### RWA/tokenized-stock liquidity gate notes

Bitget `isRwa=YES` tokenized-stock futures use adapted supporting-gate
thresholds for p10 / weak-minute volume stress: GREEN when position notional is
below 25% of p10 non-dead 1m quote volume, YELLOW up to 50%, RED above 50% or
unavailable/zero.

RWA escalation rule: one RED supporting metric alone is confirmation-gated
YELLOW / `PLACEABLE_ONLY_WITH_CONFIRMATION`; two RED supporting metrics are
overall RED; one RED supporting metric combined with a YELLOW/RED primary gate
is overall RED. Primary execution gates remain strict for all symbols.

## Core commands

### Account

```powershell
node scripts/account.js
```

### Positions

```powershell
node scripts/positions.js
```

### Set margin mode

```powershell
node scripts/set-margin-mode.js --symbol BTCUSDT --marginMode isolated
```

`--help` is read-only and prints usage. Never omit `--symbol` on a live account.

### Set leverage

```powershell
node scripts/set-leverage.js --symbol BTCUSDT --leverage 3
```

`--help` is read-only and prints usage. Never omit `--symbol` on a live account.

### Place one order directly

```powershell
node scripts/place-order.js --symbol BTCUSDT --side buy --tradeSide open --orderType market --size 0.001 --send
```

### Cancel one order

```powershell
node scripts/cancel-order.js --symbol BTCUSDT --orderId YOUR_ORDER_ID
```

## Signal format

Example signal file:

```json
{
  "symbol": "BTCUSDT",
  "productType": "USDT-FUTURES",
  "marginCoin": "USDT",
  "marginMode": "isolated",
  "leverage": "3",
  "side": "buy",
  "tradeSide": "open",
  "orderType": "market",
  "size": "0.001"
}
```

## Notes

- This harness is intentionally minimal and explicit.
- It is a good base for the next step: receiving TradingView/Pine webhooks or routing screener outputs into execution rules.
- If you want, I can extend this next into a webhook receiver + rule engine for specific Pine signals.
