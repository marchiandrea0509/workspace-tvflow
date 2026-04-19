# SHARED_FROM_MAIN.md

Safe cross-workspace bridge from the main workspace.

This file is intentionally shareable with non-main agents/workspaces. It should contain only facts that are safe to expose in secondary workspaces and group-routed agents.

## How to use

- Read this at session start if it exists.
- Treat it as a continuity bridge, not as permission to read or reveal main `MEMORY.md`.
- Do not infer private facts that are not written here.
- If something from main should be shared broadly, add it here on purpose.

## Human

- Name: Andrea
- Timezone: Europe/Berlin
- Prefers concise, direct, action-first help.
- Open to assertive guidance when it is respectful and practical.
- Keyword `lock session` = run the end-of-session backup + sync routine.

## Shared communication preferences

- For trade deep-dives: default to a quantitative structure (setup, levels, invalidation, targets, risk quality, orderability), then give a clear discretionary judgment.
- For YouTube/transcript summaries: use a structured asset-by-asset format with clear trade hints and forecast per mentioned asset.

## Cross-workspace active projects

- OpenClaw setup and hardening
- TradingView screenshot automation
- MT5 / MQL5 debugging
- DATA_PIPELINE trading-context workflow

## Shared operational notes

- `DATA_PIPELINE` is the canonical name for the market-data extraction system.
- `PRICE_FIRST_CONTEXT_SECOND` is a saved trading principle.
- Preferred long-term discretionary execution backbone shifted to MT5 (OANDA), with paper trading first.
- Llamy Discord routing was repaired on 2026-04-18; normal room replies should be in-channel, and exact quota snapshots should use `exec` with `openclaw status --usage`.

## Privacy boundary

- Main `MEMORY.md` stays private to the main direct session.
- This file is the safe bridge for secondary workspaces.
- If a fact is sensitive or personal, keep it out of this file.
