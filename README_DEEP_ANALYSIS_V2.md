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

Discord/reporting rule: when `-CaptureTv` succeeds, the final chat reply should attach the merged horizontal `1D | 4H` contact sheet as the preferred Discord artifact. Discord has dropped/rendered only one image when multiple separate screenshot `MEDIA:` lines were sent, and the old 3-panel `1D | 4H | 1H` sheet made charts too small to read. The wrapper therefore captures only `1D` and `4H`, then generates both `SYMBOL_1D_4H_contact_sheet.png` and a Discord-safe `SYMBOL_1D_4H_contact_sheet_discord.png` scaled to 6144px width when `ffmpeg` is available. The builder prefers the `_discord.png` path in `discord_media_lines`. Keep the separate full-resolution original screenshots in the packet as fallback/debug evidence when price/Y-axis readability matters.

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

The wrapper captures clean `1D` and `4H` screenshots using:

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
    analysis_summary.json              # full audit/debug payload
    candidate_levels.json              # full levels + candidate design
    freshness_check.json
    decision_packet_compact.json       # compact final-decision payload
  llm_input_packet.md                   # compact packet for normal final LLM/report step
  llm_input_packet_V2.full.md           # verbose full packet for comparison/audit/debug
  llm_input_packet_full.md              # backward-compatible alias of V2.full
```

Feed compact `llm_input_packet.md` together with `prompts/master_trade_analysis_prompt_v2.md` into the normal final analysis step. Keep `llm_input_packet_V2.full.md`, `analysis_summary.json`, and raw files for comparison/audit/debug only. The compact packet preserves mandatory rules, selected decision facts, and compact valid/rejected candidate alternatives for Option A/B selection while removing duplicated raw data, repeated leverage arrays, long pivot histories, and bulky manifests.

Comparison rule: if comparing compact vs `V2.full`, run each final LLM analysis in an isolated context with only its own packet and the same master prompt/model. Do not paste the first result into the second run, or the second result can be influenced by the first.

## Static OC 4H ladder requirement

The builder now follows Andrea's OC 4H Pullback Ladder Ticket Rules. It creates static 4H pullback ticket candidates: `DIP_LADDER long` or `SELL_RALLY short`. The final prompt may output up to two mutually exclusive options when both are valid: Option A = best quality, Option B = best fill probability. A and B are alternatives, never simultaneous; do not sum their risk.

Core constraints:
- No dynamic management, trailing, future cancellation assumption, SL movement, or post-fill adjustment.
- All entries, quantities, SLs, and TPs must be valid at order creation.
- If all entries fill and price immediately goes to SL, total loss must still be around the target risk, normally `100 USDT`.
- Use the latest valid 4H impulse and build L1/L2 from the 38.2/50/61.8 pullback value zone plus EMA/pivot/support/resistance confluence.
- Relaxed L3 rule: a strong deep structural L3 outside the fib value zone may be tested when it is a clear HTF level (for example a prior 1D/4H pivot-high retest for longs), has not crossed trend-failure/CHoCH invalidation, and still passes static SL/R:R/margin/liquidation checks. This permits testing deep levels but does not override safety gates.
- Use 2 or 3 legs maximum.
- Use risk split, not raw quantity split: 3 legs = `25/35/40`, 2 legs = `40/60`.
- Minimum spacing is `0.25 ATR(14)`; ideal spacing is `0.30-0.60 ATR(14)`.
- Common structural SL uses a `0.25-0.50 ATR` buffer and must not be moved just to make a ticket fit.
- Fixed TP/SL per order at creation time.
- If the static ticket is unsafe, the builder marks `static_ticket_safe=false` and exposes `static_ticket_reject_reasons`; final analysis should output `NO TRADE` or `WAIT`, not an unsafe ladder.

## Static optimisation scan requirement

Before selecting the final static ladder, the builder now scans candidate combinations instead of accepting the first generated geometry:

- 2-3 entry ladder combinations inside the 4H pullback value zone.
- 2-4 structural SL candidates.
- 2-4 meaningful TP candidates.
- For each candidate: L1-only R:R, L1+L2 R:R, all-filled R:R, planned risk, rounded quantity, estimated margin, 4H ATR distance to SL/TP, selected leverage, and estimated liquidation-vs-SL safety.

All ATR checks use **4H ATR(14)** only.

Preferred gates:
- SL from blended entry: ideally `0.70-1.80 ATR`; `1.80-2.20 ATR` is warning zone; `>2.20 ATR` requires very strong HTF structure; `>2.50 ATR` normally rejects unless exceptional 1D structure and realistic TP support it.
- TP from blended entry: ideally `1.20-2.80 ATR`, normal max around `3.50 ATR`; `>3.50 ATR` requires clear 1D/4H support and must not be lifted only to force R:R.
- Option A / BEST QUALITY: L1-only R:R at least `~1.0`, L1+L2 at least `~1.2`, all-filled at least `~1.5`.
- Option B / BEST FILL PROBABILITY: shallow L1-only R:R may be `0.90-0.99` only if L1 is structurally valid, inside/near the valid pullback/retest zone, not a chase into resistance/support, has reduced risk share normally `<=25%`, L1+L2 remains around `1.2` (`1.15-1.20` soft-warning only), all-filled remains `>=1.5` hard gate, margin/leverage/risk pass, and TP is realistic. Mark passing exception candidates as `VALID_FOR_BEST_FILL_PROBABILITY_ONLY`.

The scan chooses the best valid static ticket, not the most optimistic one. Tighter SLs are allowed only beyond real support/invalidation and outside normal 4H noise. Far TP targets must be structurally meaningful.

Leverage above `10x` may be considered only as a margin-efficiency adjustment after checking that estimated liquidation remains safely beyond the SL; it must not increase planned risk.

Screenshot capture fix: deep-analysis capture now routes TradingView with the full exchange symbol while writing a safe filename, uses a visible `profile-deep-visible` browser profile to avoid black headless GPU screenshots, and rejects near-black/unusable captures before generating a Discord sheet.
