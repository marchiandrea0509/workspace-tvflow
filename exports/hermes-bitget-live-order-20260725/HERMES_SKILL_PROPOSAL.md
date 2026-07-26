---
name: "hermes-bitget-live-order"
description: "Validate, place, postcheck, chart, and journal Bitget futures live orders."
status: proposal
version: "v1"
workshop_proposal_id: "hermes-bitget-live-order-20260725-c43e659f82"
---

# Hermes Bitget live-order workflow

Use for explicit Bitget futures order placement, replacement, cancellation, or ladder changes. Default to read-only inspection. Never infer approval for live exchange writes.

## Hard safety gates

- Require an explicit live-action instruction containing symbol, side, entry type, quantity, entry, SL, TP, and margin/leverage intent.
- If execution instructions, side, symbol, quantities, SL/TP, cancellation scope, or risk are ambiguous, stop and ask.
- Require explicit RED-liquidity override language before bypassing a RED gate; record the exact user message or audit reference in the override reason.
- Never package or print API secrets. Load credentials only from `.env.local` or process environment.
- Use isolated margin unless the user explicitly requests another mode.
- Verify contract precision, min/max size, maximum leverage, and position-tier leverage before any write.
- Compute the whole ladder, not one leg: total quantity, notional, planned loss, planned reward, aggregate R:R, margin, and fee-adjusted liquidation.
- For a long, liquidation must remain below SL; for a short, above SL. Include maintenance margin and Bitget taker/liquidation fee. If the selected leverage fails, reduce leverage or do not place.
- Bitget live sends require both `BITGET_ALLOW_ORDER_PLACEMENT=true` and `BITGET_ALLOW_LIVE_TRADING=true`, preferably scoped to the exact placement process.

## Workflow

1. Read account, contract config, ticker, position tier, pending regular orders, positions, and `normal_plan`/`profit_loss`/`track_plan` rows.
2. Reconcile ticket math and precision. Reject duplicates or conflicting positions/orders unless the user explicitly authorized cancellation/replacement.
3. Run the full-ladder liquidity gate with worst-case quantity, blended entry, total notional, SL, planned risk, and planned leverage.
4. If GREEN, continue only under the original explicit live instruction. If YELLOW, require an explicit YELLOW/RED override. If RED, require an explicit RED override plus a specific risk acknowledgement.
5. Set/confirm margin mode and leverage. Re-read the result.
6. Place each regular order with unique client OID, preset SL/TP, and the full-ladder gate inputs. Never treat a process exit as proof of placement.
7. Independently postcheck exact order IDs, status, filled quantity, price, leverage, margin mode, attached SL/TP, positions, plan rows, and account locked-margin change.
8. Build the TradingView trade-plan JSON. Real exchange orders use `kind=live` and `lineStyle=solid`; include order timestamps and placement/current price. Draw Entry/SL/TP on TradingView Desktop, one group arrow for a ladder, and save a non-empty screenshot.
9. Refresh the Bitget journal. Produce the workbook/CSV/messages and deliver the concise live-order profile through the configured messaging adapter. Require a returned message ID or equivalent delivery receipt.
10. Report complete only when exchange postcheck, TradingView screenshot, and journal delivery receipt all pass. If exchange placement succeeded but either delivery task failed, say the order is live but delivery is incomplete and continue repairing delivery.

## Runtime layout

- `bitget-futures-harness/`: authenticated Bitget client, liquidity gate, placement, leverage/margin, order/position/history scripts.
- `scripts/`: post-live finalizer, journal wrapper/builders, and message adapter.
- `tradingview/`: TradingView Desktop CDP launcher, locally patched MCP bridge, drawing helper, and snapshot helper.
- `templates/`: `.env.example`, trade-plan JSON, and example live-order receipt.
- `examples/aapl-live-order/`: known-good end-to-end receipt artifacts.

## Validation

- Node syntax-check every packaged `.js` file.
- Python compile-check journal builders.
- PowerShell parser-check workflow and TradingView scripts.
- Parse every JSON template/receipt.
- Run the finalizer in `-ValidateOnly` mode.
- Confirm the ZIP contains no `.env.local`, API keys, secrets, `node_modules`, or `.git` data.
- Generate SHA-256 checksums and verify the archive can be extracted into a fresh directory.
