# Weekly TV Outcome Feedback Digest

Purpose: produce a low-frequency Discord-thread digest that improves tvflow from real outcomes, not just GPT comparisons.

Dedicated thread:
- `TV Outcome Feedback Loop`
- Discord thread/channel id: `1512319160607314051`

Safety boundaries:
- Read-only only.
- Never place, cancel, edit, or modify live Bitget orders.
- Never infer execution authorization from this digest.
- If evidence is incomplete, mark the case deferred instead of guessing.
- Verification must be consistent: Bitget export/journal for execution truth, TradingView or Bitget OHLCV/export for market-path truth, screenshots only as supporting visual evidence.
- Do not finalize an outcome audit from screenshots alone unless explicitly labeled provisional visual review.
- Keep API/tool usage modest: max 5 cases per weekly digest.

Primary docs:
- `docs/OUTCOME_FEEDBACK_LOOP.md`
- `README_DEEP_ANALYSIS_FEEDBACK.md`
- Schema: `schemas/trade_outcome_feedback.schema.json`

Weekly procedure:

1. Inspect `reports/deep_analysis_feedback/*.json`.
2. Prefer records with schemaVersion `trade_outcome_feedback_v1` and statuses:
   - `ready_for_outcome_audit`
   - `waiting_for_close_or_expiry`
   - `waiting_for_fill`
   - old v0 records with `journalOutcome.status` pending/open/partial/cancelled/closed.
3. Refresh/read Bitget journal artifacts only if needed and safe/read-only.
4. Use TradingView/Bitget OHLCV exports for market-path verification. Screenshots may support structure interpretation but are not sufficient for final MFE/MAE/TP-before-SL judgments.
5. If Bitget execution evidence or OHLCV/export evidence is missing, mark the case `deferred_missing_export_evidence` or `evidence_incomplete` instead of guessing.
6. For each selected case, answer:
   - Did entry react?
   - Was SL structural?
   - Was TP realistic?
   - Did ladder spacing help?
   - Did liquidity warning matter?
   - Which prompt rule helped/hurt?
   - Which candidate won counterfactual replay: tvflow, GPT, Andrea/manual, hybrid, or no-trade?
7. Patch nothing automatically unless the evidence is safety-critical and the patch is small/obvious. Otherwise queue actions.
8. Post a concise digest to thread id `1512319160607314051`.

Digest format:

```text
WEEKLY TV OUTCOME FEEDBACK — YYYY-MM-DD

Cases reviewed: N
Deferred: N

1) SYMBOL — outcome_category
- Outcome: ...
- Counterfactual winner: tvflow / GPT / Andrea / hybrid / no-trade / unclear
- Rule audit: helped [...], hurt [...]
- Lesson: ...
- Action: none / memory / prompt patch queued / tool patch queued

Patch queue:
- ...

Next focus:
- ...
```

If there are no meaningful cases, reply only with `NO_REPLY` unless a real blocker or required setup step exists.
