# AGENTS.md - tvflow Workspace

This workspace belongs to the `tvflow` agent.

## Purpose
This is the main project workspace for TradingView, Pine Script, screeners, chart workflows, and related trading-analysis tooling.

## Scope rules
- Keep this agent focused on TradingView / Pine / screener work.
- Do not mix in CV or job-hunting topics.
- Do not mix in MT5 paper-trading operations unless directly needed for TradingView strategy translation.
- Treat mini/nano Pine or screener agents only as helper agents.
- Keep main continuity, decisions, and project memory here.

## BITGET Trades routing / speed rule

The Discord thread `BITGET Trades` (`channel:1499631210283008002`) is the durable audit/history room. It is intentionally allowed to keep full context, but it must not be the default place for small routine operations when speed matters.

Use the configured `tvflow-fast` agent for fresh, low-context Bitget operations:
- routine order/position/status checks
- postchecks after already-explicit user actions
- journal refreshes and read-only diagnostics
- mechanical execution of a fully specified, already-approved non-RED ticket

`tvflow-fast` runs on `openai-codex/gpt-5.4-mini` with low thinking. It should keep replies concise, avoid deep trade reconstruction, and write artifacts/audit notes back into this workspace.

Escalate back to full `tvflow` / `gpt-5.5` for:
- fresh discretionary trade judgment or A/B/C/D ticket construction
- ambiguous live execution instructions
- any RED-liquidity override decision
- changing risk, leverage, SL/TP, or thesis rather than merely reading/verifying state

If a routine request arrives inside the heavy BITGET Trades thread, do not carry the entire audit context through a long tool chain if avoidable. Start/route it as a clean `tvflow-fast` run, then post only the concise result or artifact reference back to BITGET Trades. Runbook: `README_BITGET_FAST_ROUTING.md`.

## Session start / timeout discipline
Do **not** spend the first Discord turn rereading broad project files by default. Deep-analysis and live-trading requests can exceed the channel run timeout if startup burns time on generic context.

Fast startup rules:
1. Read `SESSION_START.txt` first; it contains the lightweight routing checklist.
2. Use targeted reads of `PROJECT_STATE.md` only when the task needs current live-order state, blockers, or recent operational context.
3. Read today's `memory/YYYY-MM-DD.md` only when same-day live orders, diagnostics, or workflow patches may matter. Read yesterday only if today references it or the task is explicitly historical.
4. If `memory/SHARED_FROM_MAIN.md` exists, read it only when the user asks about cross-workspace/main-session context.
5. Update `PROJECT_STATE.md` and/or dated memory when milestones, blockers, safety rules, or workflow changes occur.

For fresh `Analyse SYMBOL` / stock-to-Bitget comparison requests, start the optimized deep-analysis path immediately. Do not reread full README/schema/script files unless changing/debugging the workflow; rely on the mandatory delivery gates below.

Screenshot reliability rule: all three timeframes remain mandatory. Prefer one multi-image analysis call containing the 1D, 4H, and 1H screenshots when the image tool supports multiple images, explicitly labeling each image by timeframe in the prompt. This is a batching optimization only, not evidence reduction. If multi-image comparison is unavailable, ambiguous, or appears to degrade interpretation, fall back to separate image reads for 1D/4H/1H.

## Continuity
Prefer storing durable decisions, workflows, architecture notes, screener rules, and Pine design choices in workspace files so the project remains coherent over time.

## Durable learning / anti-regression loop
When a workflow, prompt, live-order tool, or safety rule changes, do not treat the change as temporary chat context only. Preserve the lesson so future runs do not repeat fixed mistakes.

For meaningful changes, update the smallest useful set of files:
- `PROJECT_STATE.md` for the latest operational state, known quirks, and current best next behavior
- the relevant README / schema / prompt file for the reusable procedure or contract
- dated `memory/YYYY-MM-DD.md` for durable decisions, especially live-trading safety boundaries and discovered exchange/API quirks

For live Bitget order workflows, durable notes should include:
- what changed
- why it changed
- the mistake/quirk discovered
- what future runs must do differently
- validation/postcheck evidence

Never rely only on memory of the chat for a fixed weakness; encode it in code, docs, or project state before considering the workflow hardened.

For deep-analysis quality feedback, use `README_DEEP_ANALYSIS_FEEDBACK.md` and create records under `reports/deep_analysis_feedback/` when Andrea provides GPT comparisons, preferred tickets, or journal/outcome lessons. Treat GPT as an audit source, not an authority: compare, tag the failure mode, then patch prompts/tools/docs only when justified by a repeated, clear, or safety-critical weakness.

## Deep-analysis delivery hard stop
For any user request like `Analyse SYMBOL.P`, `analyze SYMBOL`, or a fresh Bitget deep-analysis request, the chat answer itself must use the full validated 5-day swing-plan section family. Do **not** manually summarize from memory, screenshots, or packet output.

Fast-path renderer note: when using the optimized final-decision workflow, the model may output `deep_analysis_decision_v1` JSON from `llm_decision_request_ultra_compact.md`, but the report must then be rendered by `python scripts\render_deep_analysis_from_decision_json.py --decision <decision.json> --out reports\deep_analysis\<REPORT>.md`. The renderer, finalizer, and audit own the delivery format; never send the decision JSON itself as the user-facing analysis.

Mandatory final step before sending the analysis:

```powershell
python scripts\finalize_deep_analysis_delivery.py --report reports\deep_analysis\<REPORT>.md
python scripts\audit_deep_analysis_delivery.py --report reports\deep_analysis\<REPORT>.md
```

Fast delivery profile is now the default: `finalize_deep_analysis_delivery.py` renders compact Discord chunks that preserve required square ticket tables, orderability/risk traffic-light tables, and final verdict while leaving the full saved report intact. Use `--delivery-profile full` only when Andrea explicitly asks for the full long-form Discord report.

If either command fails, the correct response is to say the report is not delivery-valid yet and continue fixing it. If both pass, send generated clean `discord_chunks/chunk_*.md` content verbatim and in order.

Do **not** spawn or wait for the optional delivery-auditor subagent after deterministic `AUDIT_PASS` during normal Discord delivery. That subagent is now reserved for debugging an `AUDIT_FAIL`, repeated formatting regressions, or explicit QA requests. The deterministic finalizer+auditor is the hard gate.

A short verdict-only reply is allowed only when Andrea explicitly asks for a short summary.
