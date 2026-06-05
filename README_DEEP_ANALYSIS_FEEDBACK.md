# Deep Analysis Feedback Loop

Purpose: continuously improve tvflow deep analysis without making live execution more complex or less safe.

The workflow is now **outcome-first**:

`ticket -> frozen thesis -> real outcome -> counterfactual replay -> rule scorecard -> weekly digest -> patch only if justified`

GPT comparison remains useful, but GPT is an audit/teacher source, not the judge. The primary judge is real market evidence from Bitget outcomes and TradingView/Bitget exports.

Strict verification source rule:
- Bitget export/journal = execution truth.
- TradingView or Bitget OHLCV/export = market-path truth.
- Screenshots = supporting visual evidence only.
- If export/journal/OHLCV evidence is missing, defer the outcome audit instead of producing a final judgment from screenshots alone.

Dedicated Discord thread:
- `TV Outcome Feedback Loop`
- Thread id: `1512319160607314051`
- Parent channel: `#pine-screener` (`1487602980093165658`)

This workflow captures cases where:
- Andrea compares tvflow's deep analysis with GPT or another analyst.
- GPT proposes a better ticket or level map.
- Andrea manually edits a ticket before live execution.
- A placed/live/watch trade outcome teaches something about entry quality, SL, TP, ladder spacing, liquidity, prompt rules, or orderability.

The goal is not to blindly imitate GPT. tvflow should compare, decide what is genuinely better, and only then patch prompts/tools/docs/memory.

## Files

Comparison-first v0:
- Schema: `schemas/deep_analysis_feedback.schema.json`
- Helper: `scripts/create_deep_analysis_feedback.py`

Outcome-first v1:
- Schema: `schemas/trade_outcome_feedback.schema.json`
- Helper: `scripts/create_trade_outcome_feedback.py`
- Detailed procedure: `docs/OUTCOME_FEEDBACK_LOOP.md`

Shared records folder:
- `reports/deep_analysis_feedback/*.json`

Main deep-analysis docs:
- `README_DEEP_ANALYSIS_V2.md`

## Outcome-first v1 workflow

### 1. Freeze the pre-trade thesis

When a live order, alert-only VOCO, or meaningful watch ticket is created, save a v1 outcome feedback record.

Example:

```powershell
python scripts\create_trade_outcome_feedback.py `
  --symbol BTCUSDT `
  --side SHORT `
  --family B `
  --timeframe 4H `
  --thesis "Sell-rally ladder expects BTC to reject 65.5k/67.2k resistance before invalidation above 68.6k." `
  --impulse "4H bearish continuation / failed recovery" `
  --key-level "65500 first resistance" `
  --key-level "67200 second resistance" `
  --key-level "68600 structural invalidation" `
  --entry-thesis "Passive sell limits should fill on relief rally, not chase support." `
  --sl-thesis "SL above failed-recovery shelf protects short thesis." `
  --tp-thesis "Targets sit at next visible support zones." `
  --liquidity-thesis "Full-ladder Bitget liquidity gate GREEN." `
  --prompt-rule no_chase `
  --prompt-rule passive_sell_rally `
  --live-execution-summary reports\live_execution\...\summary.json `
  --planned-risk-usdt 99.91 `
  --planned-reward-usdt 362.34
```

This record freezes what the analysis believed before outcome, so later review does not become hindsight-biased.

### 2. After close/cancel/expiry

Update the record with Bitget/TradingView evidence:

- fill status and fill timing
- realized PnL and R multiple
- MFE / MAE
- entry touch / missed-entry distance
- whether TP area was reached before SL/invalidation
- slippage/liquidity impact
- TradingView OHLCV/export evidence around the trade window

### 3. Counterfactual replay

Replay the same market path against:

- tvflow original ticket
- GPT ticket
- Andrea/manual ticket
- hybrid ticket if applicable
- no-trade / wait decision

This asks which decision was actually best under the same market path.

### 4. Rule outcome audit

For each prompt rule used, mark:

- `helped`
- `hurt`
- `neutral`
- `unknown`

Examples: no-chase, passive support retest, support-sweep SL exception, liquidity RED override, margin cap handling, broad-vs-active impulse selection.

### 5. Weekly digest

Run low-frequency weekly digest in the dedicated Discord thread, max 5 cases:

- cases reviewed
- outcome categories
- counterfactual winners
- rules that helped/hurt
- patch queue
- deferred cases needing more evidence

## v0 comparison workflow

### 1. After a deep-analysis comparison

When Andrea pastes a GPT analysis/ticket or says GPT did better:

1. Create a feedback record.
2. Link the tvflow report/packet if available.
3. Paste or summarize the GPT ticket.
4. Compare tvflow vs GPT vs Andrea's preferred ticket.
5. Tag the failure mode.
6. Decide whether this needs a prompt patch, tool patch, docs/memory patch, or only a regression-case note.

Example:

```powershell
python scripts\create_deep_analysis_feedback.py `
  --symbol AAPLUSDT `
  --side LONG `
  --family LC `
  --tvflow-report reports\deep_analysis\2026-05-24_AAPLUSDT_deep_analysis.md `
  --packet-dir reports\deep_analysis_packets_v2\20260524_171320_AAPLUSDT `
  --preferred-source gpt `
  --issue-tag wrong_impulse_selection `
  --issue-tag level_map_incomplete `
  --summary "GPT used the fresher active swing and produced a better level map." `
  --lesson "When confirmed and active impulse maps differ, explicitly compare both before ticket selection."
```

### 2. If a live trade is placed

Do not make the feedback workflow block live execution. Keep live execution separate.

The feedback record can optionally link:
- live execution summary
- order IDs
- journal snapshot
- later trade outcome

At first, this can be updated manually after journal refresh. Later we can automate outcome linking from the journal.

### 3. After journal update / trade outcome

When the journal shows enough result data, update the feedback record's `journalOutcome` section:

- Did the entry fill?
- Did the proposed pullback level react?
- Was SL structurally correct or too tight/wide?
- Was TP realistic or too optimistic/conservative?
- Was ladder spacing good?
- Did liquidity/slippage alter the practical quality?
- Did the trade outcome support tvflow, GPT, or neither?

This is useful but optional. If no trade was placed, mark `journalOutcome.status = not_placed`.

## Why journal feedback does not overcomplicate v0

It stays simple because outcome feedback is an optional block inside the same record:

- Before trade outcome: `journalOutcome.status = pending` or `not_linked`.
- After journal refresh: add a short summary and lessons.
- Only repeated lessons trigger prompt/tool changes.

So the loop is:

`analysis -> comparison -> optional live execution -> journal outcome -> durable lesson -> patch only when justified`

## Failure tags

Use one or more tags from the schema:

- `missed_support_resistance`
- `wrong_impulse_selection`
- `level_map_incomplete`
- `ignored_1h_refinement`
- `bad_entry_quality`
- `bad_ladder_spacing`
- `sl_too_tight`
- `sl_too_wide`
- `tp_unrealistic`
- `weak_rr_accepted`
- `valid_trade_overfiltered`
- `orderability_misjudged`
- `liquidity_or_slippage_issue`
- `margin_or_leverage_issue`
- `prompt_format_issue`
- `tool_packet_issue`
- `execution_followup_issue`
- `journal_outcome_learning`

## Patch rule

Do not patch the master prompt for every single disagreement. Patch when:

- the issue repeats,
- the issue is safety-critical,
- GPT/user feedback exposes a clear structural weakness,
- a journal outcome confirms that tvflow's analysis rule was wrong or incomplete.

Always update `PROJECT_STATE.md` and dated memory when a feedback case produces a durable rule change.
