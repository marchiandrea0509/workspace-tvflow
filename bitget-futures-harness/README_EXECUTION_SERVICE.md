# Bitget Execution Service Project

Status: phased migration plan. Existing live scripts remain the production path until a phase is explicitly validated and adopted.

## Purpose

Create one controlled front door for every Bitget live-write action so future tools do not repeat fixed mistakes or drift into inconsistent safety behavior.

The execution service is not meant to make trading decisions. It is a safety, consistency, and audit layer between a proposed trade/action and Bitget.

```text
Deep analysis / user request / GPT comparison
  -> structured execution plan JSON
  -> execution service
  -> precheck
  -> risk/liquidity/state gates
  -> optional explicit override for calibrated risk gates
  -> Bitget write
  -> postcheck
  -> audit log
  -> journal refresh / feedback loop
```

## Core principles

1. **No big-bang refactor.** Existing scripts stay usable while the service matures.
2. **Read-only first.** Phase 1 cannot place/cancel/modify anything.
3. **State safety is not overrideable.** Overrides may apply to calibrated risk gates, not to wrong-symbol/wrong-position/oversize/ambiguous-state problems.
4. **Every live write must eventually produce an audit record.** The audit record should make it easy to understand what was requested, what checks passed/failed, what was sent to Bitget, and what postcheck found.
5. **Human confirmation remains required for live execution.** The service can standardize checks but does not remove Andrea's explicit execution boundary.
6. **Every action needs an idempotency key.** Retries, timeouts, duplicated cron/scheduler runs, or duplicate assistant turns must not create duplicate orders.

## Idempotency model

Every execution plan should include:

```json
{
  "idempotency": {
    "cycleId": "20260525_4h_1600Z",
    "strategyId": "clusdt_optionB",
    "symbol": "CLUSDT",
    "intentType": "set_tp_trailing_split"
  }
}
```

Canonical key:

```text
cycle_id + strategy_id + symbol + intent_type
```

Future live behavior:

- same key + same payload + already succeeded -> return `already_done`, do not send a duplicate write
- same key + different payload -> `HARD_BLOCK`; require a new `cycleId` or explicit future supersede workflow
- same key + previous failed before Bitget write -> safe retry candidate
- same key + previous write sent but postcheck unknown -> `HARD_BLOCK` until manual reconciliation
- missing key in automated/scheduled live flow -> `HARD_BLOCK`

Phase 1 behavior:

- missing key is a `YELLOW` warning only, because Phase 1 is dry-run/read-only
- complete key is stored in the audit record with a payload hash
- dry-run checks existing audit records in the selected audit directory and flags same-key duplicates/conflicts

Idempotency keys should also be used as the root for future `clientOid` prefixes where exchange length limits allow it.

## Exchange adapter stance

The service is **Bitget-first, adapter-ready**. Do not implement Bybit/Hyperliquid adapters until there is a real use case.

Design seam for later:

```text
executionService
  -> exchangeAdapter interface
      -> bitgetAdapter
      -> future bybitAdapter
      -> future hyperliquidAdapter
```

Potential normalized methods:

- `getPositions()`
- `getOpenOrders()`
- `getContractSpec()`
- `normalizeSizePrice()`
- `placeOrder()`
- `cancelOrder()`
- `setLeverage()`
- `setTpSl()`
- `setTrailingTp()`

Do not hide dangerous exchange differences behind a fake generic abstraction. Hedge/one-way mode, TP/SL semantics, reduce-only behavior, trailing-stop rules, precision, liquidation/margin model, and client order ID constraints must remain explicit in each adapter.

## Live-write action scope

Eventually covered actions:

- place/open order
- cancel order
- cancel plan order
- set leverage
- set margin mode
- set fixed TP/SL
- set TP trailing split
- close/reduce position
- modify order/plan

Excluded or special-scope actions:

- transfers/withdrawals: separate stricter workflow, not part of normal trade execution service
- journal/report generation: downstream post-action process, not a Bitget live-write
- deep-analysis reasoning: upstream decision layer, not execution service

## Gate classes

### Overrideable calibrated gates

These are risk-quality/calibration checks. They may be overridden only with an explicit override level and reason.

- `YELLOW`: spread/liquidity/risk warning; proceed only with explicit reason.
- `RED`: normally blocked; can proceed only with explicit user risk acceptance and reason.

Examples:

- RWA p10 volume red but Andrea accepts liquidity override.
- Spread warning on thin TradFi perp.
- Stop-market slippage estimate above default tolerance but user accepts smaller/explicit size.

### Non-overrideable hard blocks

These protect against acting on the wrong thing or creating an unsafe/unknown state. No override should bypass them.

- expected position not found
- symbol mismatch
- side/holdSide mismatch
- close size exceeds available position
- action would open when intended to close
- missing SL for new risk-bearing order
- missing required action fields
- Bitget response ambiguous or failed
- postcheck does not confirm intended state
- plan would increase risk when request was reduce-only/protective

## Phase plan

## Phase 1 — Dry-run execution-service shell and audit format

Goal: introduce the service without touching existing live workflows.

Deliverables:

- `lib/executionService.js`
- `scripts/execution-service-dry-run.js`
- npm alias `execution-dry-run`
- audit records under `reports/live_execution/audit/`
- shared override taxonomy: `GREEN`, `YELLOW`, `RED`, `HARD_BLOCK`
- idempotency key parsing and dry-run ledger conflict checks
- design doc and memory/project-state updates

Capabilities:

- read a proposed execution plan JSON
- validate basic required fields
- classify hard blocks vs warnings
- optionally read live Bitget state with `--readLive`
- warn if idempotency key is missing; store key/payload hash when present
- check prior audit records for same idempotency key and detect same-payload duplicates vs different-payload conflicts
- write a dry-run audit log
- never send POST/write requests

Success criteria:

- `node --check lib/executionService.js`
- `node --check scripts/execution-service-dry-run.js`
- dry-run smoke test writes an audit file
- no existing live scripts are modified to use the service yet

Rollback:

- delete/ignore the new dry-run files; existing scripts are untouched.

## Phase 2 — Shared read-only precheck/postcheck helpers

Goal: make precheck/postcheck reusable and stronger while still not replacing live scripts.

Deliverables:

- structured helpers for positions, regular orders, `profit_loss`, `track_plan`
- symbol/side/size matching helpers
- precision/contract helper
- reusable postcheck assertions

Success criteria:

- can validate current positions/orders for CLUSDT-style TP split without sending anything
- can detect missing/duplicate/oversized target rows before live write

Rollback:

- existing scripts still independent.

## Phase 3 — First controlled live wrapper for one narrow workflow

Goal: use the service for exactly one known workflow while keeping old script available.

Recommended first candidate:

- TP trailing split, because we already discovered a Bitget plan-order cancellation quirk and it benefits from strict pre/postchecks.

Approach:

- add a new wrapper, not replace the current script
- service performs precheck, writes intent audit, calls existing proven function/path, postchecks, writes final audit
- if service fails precheck, old script remains available for emergency manual use only after review

Success criteria:

- dry-run and paper/safe test pass
- live use only after explicit user confirmation
- audit log contains request, checks, Bitget requests, postcheck

Rollback:

- use previous standalone script.

## Phase 4 — Migrate live order placement wrappers

Goal: route open-order workflows through the shared service.

Scope:

- `place-order.js`
- `execute-signal.js`
- OCO/ladder placement, if still active

Must preserve:

- existing liquidity gate behavior
- existing RWA/YELLOW/RED override behavior
- one-shot env gates for live placement
- post-fill liquidity monitor

Success criteria:

- all current live-order examples dry-run identically
- one live trade placement can be audited end-to-end

Rollback:

- keep legacy scripts or legacy mode flag until stable.

## Phase 5 — Centralize protective order modification

Goal: centralize TP/SL/cancel/modify/close position actions.

Scope:

- set fixed TP/SL
- set TP trailing split
- cancel TP/SL/plan rows
- close/reduce position

Hard-block emphasis:

- never open when intending close
- never cancel protection without replacement unless explicitly requested
- never leave ambiguous state without reporting a blocker

Success criteria:

- all protective changes include pre-replacement strategy, postcheck, and audit
- old Bitget cancellation quirks encoded in one place

## Phase 6 — Journal and feedback integration

Goal: connect execution logs to journal/deep-analysis feedback.

Deliverables:

- audit log ID included in live execution summary
- journal refresh reads latest audit IDs when possible
- deep-analysis feedback records can link audit ID + journal outcome

Success criteria:

- a trade can be traced: deep analysis -> execution audit -> journal outcome -> feedback lesson

## Phase 7 — Optional MCP/API facade

Goal: expose the service as a stable local API/MCP-like bridge if useful.

Only do this after phases 1-6 are stable.

Possible tools:

- `get_positions`
- `get_open_orders`
- `prepare_execution_plan`
- `dry_run_execution_plan`
- `place_ladder_with_audit`
- `set_tp_trailing_split_with_audit`

Security boundary:

- no external network-exposed service unless intentionally configured
- local-only by default
- live writes remain gated

## Recommended next step after Phase 1

Use Phase 1 for at least one or two real requests in dry-run/audit mode. Then proceed to Phase 2 if the audit format feels useful and not too noisy.
