# BITGET Trades fast routing

Purpose: keep the Discord `BITGET Trades` thread useful as audit/history without forcing every routine operation through its large persistent context.

## Roles

- `BITGET Trades` (`channel:1499631210283008002`): durable audit/history room.
- `tvflow-fast`: fresh low-context operational agent for routine Bitget work.
- `tvflow`: full reasoning agent for discretionary analysis and high-risk decisions.

## Use `tvflow-fast` for

- order / position / plan status checks
- postchecks after an already explicit action
- journal refreshes
- read-only diagnostics
- mechanical execution of fully specified, already-approved non-RED tickets

## Escalate to full `tvflow` / GPT-5.5 for

- fresh trade analysis or A/B/C/D ticket construction
- ambiguous live execution instructions
- RED-liquidity override decisions
- changing risk, leverage, SL/TP, targets, thesis, or orderability judgment

## Config implemented

- OpenClaw agent: `tvflow-fast`
- Workspace: `C:\Users\anmar\.openclaw\workspace-tvflow`
- Agent dir: `C:\Users\anmar\.openclaw\agents\tvflow-fast\agent`
- Model: `openai-codex/gpt-5.4-mini`
- Mini model thinking default: `low`
- Nano model thinking default: `minimal`

Config backup before first edit:
`C:\Users\anmar\.openclaw\openclaw.json.bak-before-tvflow-fast-20260625-044914`
