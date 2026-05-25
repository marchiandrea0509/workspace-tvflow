# Deep Analysis Feedback Loop v0

Purpose: continuously improve tvflow deep analysis without making live execution more complex or less safe.

This workflow captures cases where:
- Andrea compares tvflow's deep analysis with GPT or another analyst.
- GPT proposes a better ticket or level map.
- Andrea manually edits a ticket before live execution.
- A placed trade outcome teaches something about entry quality, SL, TP, ladder spacing, liquidity, or orderability.

The goal is not to blindly imitate GPT. GPT is treated as an audit/teacher source. tvflow should compare, decide what is genuinely better, and only then patch prompts/tools/docs/memory.

## Files

- Schema: `schemas/deep_analysis_feedback.schema.json`
- Records: `reports/deep_analysis_feedback/*.json`
- Helper: `scripts/create_deep_analysis_feedback.py`
- Main deep-analysis docs: `README_DEEP_ANALYSIS_V2.md`

## v0 workflow

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
