# Manual TV Outcome Feedback Audit

Use when Andrea asks in the `TV Outcome Feedback Loop` thread to audit a closed/cancelled/expired trade without waiting for the weekly cron.

Recognized trigger examples:

```text
AUDIT OUTCOME TQQQUSDT
AUDIT OUTCOME BTCUSDT orderId=1446430135388106753
AUDIT OUTCOME ASMLUSDT compare=tvflow,gpt,andrea,no-trade
```

Safety boundaries:
- Read-only only.
- Never place, cancel, edit, or modify live Bitget orders.
- Never infer execution authorization from an audit request.
- If required evidence is missing, return what is missing and defer final judgment.

Verification source hierarchy:
1. Bitget export/journal = mandatory execution truth.
2. TradingView or Bitget OHLCV/export = mandatory market-path truth.
3. Screenshots = supporting visual evidence only.

Do not finalize MFE/MAE, TP-before-SL, entry-touch, or structural outcome from screenshots alone unless clearly labeled `provisional_visual_review`.

Procedure:

1. Identify symbol/order/record/date range from Andrea's message.
2. Locate the best matching `trade_outcome_feedback_v1` record under `reports/deep_analysis_feedback/`.
3. If no record exists, create/freeze a minimal record only if enough pre-trade thesis artifacts exist; otherwise ask for the missing identifier/report/order.
4. Collect read-only evidence:
   - Bitget journal/export/order/fill state for execution truth.
   - TradingView or Bitget OHLCV/export for market-path truth.
   - Screenshots only as supporting structure evidence.
5. Compute or estimate deterministic metrics first:
   - fill status/time
   - realized PnL and R if closed
   - MFE/MAE and MFE-R/MAE-R
   - missed-entry distance
   - whether TP was reached before SL/invalidation
   - slippage/liquidity impact where available
6. Audit outcome attribution:
   - `correct_setup_random_loss`
   - `correct_setup_external_catalyst_loss`
   - `correct_setup_execution_issue`
   - `analysis_improvement_possible`
   - `bad_analysis`
   - `mixed_or_unclear`
7. Run counterfactual replay against meaningful candidates: tvflow, GPT, Andrea/manual, hybrid, no-trade.
8. Review deep-analysis workflow improvement:
   - data-source quality
   - method quality
   - efficiency
   - prompt/tool/schema improvement
9. Update the feedback record with evidence and learning when safe.
10. Reply in the thread with concise sections:

```text
MANUAL OUTCOME AUDIT — SYMBOL

Evidence status: complete / deferred_missing_export_evidence / evidence_incomplete
Outcome attribution: ...
Trade result: ...
Decision quality: ...
Setup vs result: ...
Counterfactual winner: ...
Rule audit: helped [...], hurt [...], neutral [...]
Workflow improvement: ...
Action: none / memory only / prompt patch queued / tool patch queued / defer
```

Patch threshold:
- Do not patch solely because a trade lost.
- Patch only when evidence shows repeated, clear, or safety-critical analysis/process weakness.
