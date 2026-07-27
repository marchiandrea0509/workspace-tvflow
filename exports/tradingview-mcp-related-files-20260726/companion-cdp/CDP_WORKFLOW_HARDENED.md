# TradingView CDP Workflow (Hardened)

## Goal
Deterministic Pine automation with strong identity checks and export-first metrics retrieval.

## Preconditions
1. Start a **single** Chromium/Chrome process with:
   - `--remote-debugging-port=<PORT>`
   - dedicated `--user-data-dir=<PROFILE>`
2. Open target TradingView chart tab and log in.
3. Do not run parallel browser sessions against the same profile.

## Runner
Use:

```bash
node tradingview/scripts/tv_pine_apply.js \
  --cdp-url http://127.0.0.1:9223 \
  --chart-url "https://www.tradingview.com/chart/<ID>/" \
  --script-name "<Exact Script Name>" \
  --code-file tradingview/scripts/<file>.pine
```

Optional:
- `--run-marker RUN_...`
- `--download-dir tradingview/downloads`
- `--no-export-first` (forces DOM-only metrics)

## Workflow gates

### 1) Session gate
- Verify URL is TradingView `/chart/`
- Verify page title contains TradingView
- Bring tab to front before hotkeys

### 2) Editor gate
- Open Pine editor
- If `--script-name` provided, open by exact name (best effort)
- Ensure editable state (not historical lock)

### 3) Identity gate
- Parse script declaration (`strategy|indicator|study` + name)
- Inject `RUN=...` marker into title
- After apply, verify expected script name + run marker is visible

### 4) Apply gate
- Apply via Update/Add to chart or `Ctrl+Enter`
- Handle `Save and add to chart` prompt
- Wait for outcome:
  - compile error
  - or chart/tester refresh

### 5) Metrics gate (export-first)
If script is a strategy and run succeeded:
1. Open Strategy Report
2. Export **Performance Summary** CSV
3. Export **List of Trades** CSV
4. Validate download handshake:
   - download event happened
   - file exists
   - file size > 0
5. Parse CSV as source of truth

If export fails, fallback to DOM metrics.

## Failure buckets
- `session`: attach/tab/url/title/security blocker issues
- `editor`: Pine not open, wrong script, marker/name mismatch
- `compile`: compiler errors present
- `apply`: no refresh/update after apply wait
- `tester`: strategy tester/export access failures

## Artifacts
- JSON report: `tradingview/logs/tv_pine_apply_<stamp>.json`
- Screenshot: `tradingview/logs/tv_pine_apply_<stamp>.png`
- CSV exports: `tradingview/downloads/`

## Notes
- Keep screenshots as audit trail, not primary truth.
- Prefer CSV exports over visual scraping for P&L/trades.
- One browser process + CDP attach is required for consistent editor state.
