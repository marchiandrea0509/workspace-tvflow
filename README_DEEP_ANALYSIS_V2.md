# Deep Analysis v2 — OHLCV-first Bitget workflow

This is the default deep-analysis packet workflow for manually selected Pine Screener symbols.

## Policy

- Screener selection is context only; no hard `score >=70` rule.
- Current screener context: `OC Hybrid Edge Screener v11.6.x`.
- Primary truth: Bitget REST closed OHLCV candles.
- TradingView screenshots/exports: optional validation only.
- Preferred TradingView evidence path: existing Playwright/browser capture, unless TradingView Desktop MCP proves clearly more robust or cheaper.
- Target planned risk: `100 USDT` by default.
- Cap: `1500 USDT max margin` at planned leverage, not total notional.
- Live execution is excluded. Any real order placement requires a separate explicit user request.
- Delegate simple deterministic support tasks to cheap mini/nano subagents using Codex OAuth/local zero-cost routes, not paid API keys. Keep `tvflow` responsible for coordination, final trade judgment, and any user-confirmation boundary.

## Main files

- `scripts/build_deep_analysis_packet_v2.py` — core packet builder.
- `scripts/run_deep_analysis_packet_v2.ps1` — normal wrapper; can optionally run Playwright chart captures.
- `prompts/master_trade_analysis_prompt_v2.md` — prompt for final LLM analysis.
- `schemas/deep_analysis_packet_contract_v2.md` — output contract.

Old deep-analysis files remain available for comparison/reference during transition.

## Normal run, OHLCV only

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_deep_analysis_packet_v2.ps1 `
  -Symbol AAPLUSDT `
  -Side LONG `
  -Family LC `
  -Score 72.4 `
  -RiskUsdt 100 `
  -MaxMarginUsdt 1500 `
  -PlannedLeverage 4
```

## Run with Playwright TradingView validation screenshots

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_deep_analysis_packet_v2.ps1 `
  -Symbol AAPLUSDT `
  -Side LONG `
  -Family LC `
  -Score 72.4 `
  -RiskUsdt 100 `
  -MaxMarginUsdt 1500 `
  -PlannedLeverage 4 `
  -CaptureTv
```

Use `-CaptureStrict` when you want the run to fail if any screenshot fails.

Discord/reporting rule: when `-CaptureTv` succeeds, the final chat reply should attach the merged horizontal `1D | 4H | 1H` contact sheet as the preferred Discord artifact. Discord has dropped/rendered only one image when multiple separate screenshot `MEDIA:` lines were sent, and very large full-resolution contact sheets can fail delivery. The wrapper therefore generates both `SYMBOL_1D_4H_1H_contact_sheet.png` and a Discord-safe `SYMBOL_1D_4H_1H_contact_sheet_discord.png` scaled to 7680px width when `ffmpeg` is available. The builder prefers the `_discord.png` path in `discord_media_lines`. Keep the separate full-resolution original screenshots in the packet as fallback/debug evidence when price/Y-axis readability matters.

If you have a TradingView strategy-test / screener export CSV or JSON, pass it with:

```powershell
  -ScreenerDataFile path\to\export.csv
```

The packet ingests useful screener/strategy columns as context after the blind OHLCV review.

## TradingView Desktop MCP screener-layout export test

When TradingView Desktop MCP/CDP is reachable on `127.0.0.1:9222`, the `Screener` layout can be exported through:

```powershell
node scripts\export_tv_desktop_screener_chart_data_cdp.js
```

The script finds the open Desktop chart with `Active layout: Screener`, opens **Download chart data**, saves a CSV under `reports/mcp_screener_export_test/`, and writes `manifest.json`. The resulting CSV can be passed to `-ScreenerDataFile`.

The wrapper captures clean `1D`, `4H`, and `1H` screenshots using:

- `../workspace/tradingview/scripts/capture_live.js`
- layout: `Openclaw-structure`
- chart URL: `https://www.tradingview.com/chart/0ZPSKaZ4/`

## Output

```text
reports/deep_analysis_packets_v2/YYYYMMDD_HHMMSS_SYMBOL/
  manifest.json
  raw/
    bitget_SYMBOL_1D_closed_ohlcv.csv
    bitget_SYMBOL_4H_closed_ohlcv.csv
    bitget_SYMBOL_1H_closed_ohlcv.csv
    market_snapshot.json
    execution_state.json
    tv_exports/ optional
  derived/
    analysis_summary.json
    candidate_levels.json
    freshness_check.json
  llm_input_packet.md
```

Feed `llm_input_packet.md` together with `prompts/master_trade_analysis_prompt_v2.md` into the final analysis step.

## Ladder-quality requirement

The builder now allows deeper LC/DIP structural legs when they are meaningful, e.g. 4H supports that may improve R:R. A level should not be rejected merely because current price is near resistance or RSI is high. A strong no-ladder reason should cite change of character, degraded trend, high SL-hit probability, stale data, liquidity/fee issue, or objectively poor R:R. If the full 100 USDT risk target would breach the 1500 USDT margin cap at planned leverage, this is shown as a strong warning; cap-adjusted sizing is informational, not a silent replacement.

For LC/DIP ladders, do not fill L1/L2 from near-market 1H noise just because those levels fit shallow ATR buckets. When price is hot/near resistance or the screener LC action/window fields are inactive, prefer meaningful structural zones: 4H EMA50 / 1H EMA200 area, 4H pivot shelf, and deeper 4H structural support. Show weak natural R:R instead of inventing optimistic projected targets before nearby resistance is cleared.
