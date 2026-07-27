# TradingView MCP related files

This bundle contains the local TradingView Desktop MCP source and the helper
files currently used by `tvflow`.

## Included

- `tradingview-mcp/`
  - Active local MCP/CLI source from
    `C:\Users\anmar\tools\tradingview-mcp`
  - Includes source, tests, package metadata, documentation, bundled skills,
    and launch scripts.
- `wrappers/`
  - Windows launch scripts.
  - MCP status/screenshot wrapper.
  - Entry/SL/TP trade-plan drawing wrapper.
- `openclaw-skill/tv-draw-trade-plan/`
  - The OpenClaw skill instructions used for visual trade-plan drawing.
- `workspace-integration/`
  - The Bitget live-order finalizer that calls the drawing wrapper and requires
    a TradingView screenshot receipt.
- `companion-cdp/`
  - TradingView Desktop CDP capture/export helpers used alongside the MCP for
    1D/4H/1H chart evidence and Pine screener export.
- `MANIFEST.sha256`
  - SHA-256 hashes for every included file except the manifest itself.

## Excluded for safety and size

- API credentials, `.env` files, OpenClaw configuration, tokens, and webhooks.
- Browser/TradingView profiles, cookies, sessions, and login state.
- `.git`, `node_modules`, caches, logs, generated screenshots, chart exports,
  reports, and other runtime artifacts.

## Active local paths

- MCP source: `C:\Users\anmar\tools\tradingview-mcp`
- Trade-plan wrapper: `C:\Users\anmar\tools\tv_draw_trade_plan.ps1`
- MCP snapshot wrapper: `C:\Users\anmar\tools\tv_mcp_snapshot.ps1`
- OpenClaw skill:
  `C:\Users\anmar\.openclaw\skills\tv-draw-trade-plan\SKILL.md`

The MCP attaches to TradingView Desktop through Chrome DevTools Protocol on
`127.0.0.1:9222`.

