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

## Session start
At the start of each session:
1. Read `PROJECT_STATE.md`
2. Read `SESSION_START.txt`
3. Read today and yesterday under `memory/` if present
4. If `memory/SHARED_FROM_MAIN.md` exists, read it as the safe cross-workspace bridge
5. Update `PROJECT_STATE.md` when milestones or blockers change

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
