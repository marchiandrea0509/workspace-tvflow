# TV Outcome Feedback Loop

Purpose: improve tvflow trade analysis from real market outcomes, not from GPT comparison alone.

Dedicated Discord thread: `TV Outcome Feedback Loop`
- Parent channel: `#pine-screener` (`1487602980093165658`)
- Thread id: `1512319160607314051`

## Core principle

Every live order, alert-only VOCO, expired ladder, or meaningful GPT/user comparison should be treated as a testable hypothesis.

The frozen pre-trade thesis is judged later against Bitget and TradingView evidence:

`ticket -> frozen thesis -> real outcome -> counterfactual replay -> rule scorecard -> weekly digest -> patch only if justified`

GPT is an audit benchmark, not the judge. The judge is the real market path plus Bitget execution/outcome data.

## Verification source policy

Use a consistent source hierarchy for every outcome audit:

1. **Bitget export/journal is mandatory for execution truth**
   - fills, partial fills, cancellations, expiry
   - realized PnL and fees when available
   - TP/SL execution status
   - actual order ids, sizes, average fills, slippage/orderability evidence

2. **TradingView or Bitget OHLCV/export is mandatory for market-path truth**
   - entry touch / missed-entry distance
   - MFE and MAE
   - whether price reached TP before SL/invalidation
   - whether SL/TP was structurally valid in the intended window

3. **Screenshots are supporting evidence only**
   - screenshots may explain visible structure and make the digest easier to understand
   - screenshots must not be the primary source for outcome metrics when OHLCV/export data is available

If the required export/journal evidence is missing, mark the case `deferred_missing_export_evidence` or `evidence_incomplete`. Do not produce a final outcome judgment from screenshots alone unless explicitly labeled as a provisional visual review.

## Intake triggers

Create or update a feedback record when one of these happens:

1. Andrea says GPT was better or manually changes a ticket.
2. tvflow places a live order.
3. tvflow arms an alert-only VOCO/watch plan.
4. A tracked order is closed, cancelled, expired, partially filled then abandoned, or remains unfilled beyond the intended window.
5. A large miss happens: unexpected SL, missed strong move, invalid liquidity read, or bad prompt-format regression.

Do not audit every tiny noise event. Outcome audits should be low-frequency and evidence-rich.

## Pre-trade freeze

Before or immediately after placement/arming, freeze:

- symbol, side, setup family, timeframe
- tvflow proposed ticket
- GPT proposed ticket if available
- Andrea final preferred/placed ticket
- impulse and key levels used
- entry thesis: why this entry should react
- SL thesis: what structure SL protects
- TP thesis: why target is realistic
- liquidity/orderability thesis: GREEN/RED gates and override if any
- prompt rules that influenced the decision, e.g. no-chase, passive support retest, support-sweep SL, liquidity RED override
- source artifacts: deep-analysis report, packet, execution summary, Bitget journal/export snapshot, TradingView/Bitget OHLCV export, screenshots as support only

This prevents hindsight bias.

## Post-outcome audit questions

When the order/watch ends, answer these fixed questions:

1. Did the entry level react?
2. Was the SL structurally correct, too tight, or too wide?
3. Was TP realistic within the intended holding window?
4. Did price reach target area before invalidation?
5. Did ladder spacing improve or hurt fill quality and R:R?
6. Did liquidity/slippage warnings matter in practice?
7. Which prompt rules helped, hurt, or were irrelevant?
8. Was tvflow, GPT, Andrea/manual, hybrid, or no-trade closest to the best practical decision?
9. What should change: nothing, memory note, prompt patch, tool/schema patch, execution safety patch, or regression case?

## Deterministic metrics first

Prefer cheap/mechanical evidence before AI interpretation:

- fill status and fill time
- entry touch / missed-entry distance
- MFE and MAE after first fill or after planned entry touch
- realized PnL vs planned risk
- R multiple: realized PnL / planned risk
- max favorable R and max adverse R
- time to TP, SL, cancellation, or expiry
- whether TP was reached before SL/invalidation
- estimated slippage and liquidity impact
- dead-candle / volume behavior during the trade window

Use AI only for compact interpretation and rule learning.

## Counterfactual replay

Replay the same market path against each meaningful ticket:

- tvflow original ticket
- GPT ticket
- Andrea final/manual ticket
- hybrid ticket if used
- no-trade / wait decision

The goal is not to overfit the last outcome. The goal is to identify which analysis rule created the most robust practical decision under the same evidence.

## Outcome categories

Use one primary category:

- `evidence_incomplete`
- `deferred_missing_export_evidence`
- `validated_thesis`
- `good_thesis_bad_execution`
- `bad_thesis`
- `good_setup_missed_by_entry`
- `good_entry_bad_sl`
- `good_entry_tp_too_ambitious`
- `liquidity_warning_confirmed`
- `liquidity_warning_too_conservative`
- `valid_trade_overfiltered`
- `no_trade_was_best`
- `no_lesson_noise`

## Patch threshold

Do not patch the master prompt for every single disagreement or trade result.

Patch when:

- the same failure repeats,
- real outcome clearly disproves a prompt rule,
- issue is safety/orderability critical,
- GPT/user comparison and outcome evidence agree,
- a tool/schema weakness caused a wrong or missing decision.

Always update durable memory/project files when a patch is made.

## Weekly digest

Cadence: weekly, low frequency, max 5 cases.

Digest sections:

1. Cases reviewed
2. Outcome categories
3. Best/worst prompt rules this week
4. Counterfactual winner summary
5. Patch queue
6. Deferred cases needing more evidence
7. One-line next focus

Post weekly digest to the dedicated Discord thread.
