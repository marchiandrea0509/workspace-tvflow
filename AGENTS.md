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
4. Update `PROJECT_STATE.md` when milestones or blockers change

## Continuity
Prefer storing durable decisions, workflows, architecture notes, screener rules, and Pine design choices in workspace files so the project remains coherent over time.
