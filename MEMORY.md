# MEMORY.md — Pine Screener System

## Purpose

The Pine Screener system exists to run a repeatable TradingView-based scan over a curated watchlist, extract the highest-value setups, and publish a compact decision-useful report for chat delivery. Its role is not to replace deeper discretionary analysis; it is the fast recurring shortlist engine that surfaces what deserves attention.

The screener is optimized for:
- recurring TradingView scans on a fixed schedule
- stable shortlist ranking across a defined watchlist
- chat-friendly output rather than raw TradingView UI dumps
- handoff into deeper review, future automation, and strategy extensions

This system should remain part of long-term project memory because it is the operational backbone for recurring TradingView signal collection.

## Current Architecture

The current screener runtime is **not** owned by `tvflow` directly.

Operational split:
- **Runtime execution** is already handled by existing mini/nano agents and cron jobs.
- **Main continuity and coordination** for Pine / TradingView / screener evolution should move to `tvflow`.
- `tvflow` should be treated as the long-term project brain for:
 - deeper post-screener analysis
 - screener extensions
 - wiring to other tools
 - Discord delivery/routing
 - additional Pine logic
 - durable memory and design decisions

Current working runtime stack:
- Relay-free TradingView browser automation using a persistent logged-in Playwright profile
- Main export runner: `tradingview/scripts/pine_screener_export.js`
- Chat wrapper: `tradingview/scripts/pine_screener_telegram_report.ps1`
- Cron prompt: `tradingview/prompts/cron_pine_screener_4h.md`
- Recurring cron job: **TV Pine Screener 4H**
- Current cron delivery model: isolated cron run, lightweight context, direct in-run messaging to the dedicated Discord thread `TV Pine Screener 4H`

This separation matters: keep execution helpers lightweight, but keep durable project thinking in `tvflow`.

## Core Screener Configuration

Canonical operating setup:
- **Watchlist:** `BITGET_TRADFI`
- **Indicator:** `OC Hybrid Edge Screener v9.3`
- **Timeframe:** `4H`
- **Inputs:** default indicator inputs unless explicitly changed

The active runtime default indicator is now `OC Hybrid Edge Screener v9.3`.

The screener uses relay-free TradingView automation and exports results to artifacts under:
- `tradingview/reports/pine_screener/`

Typical artifacts:
- `.json`
- `.csv`
- `.md`
- `.txt`
- `.png`

## Signal Logic and Column Meanings

The system’s primary ranking convention for v9.3 is:
- **`02 Best Score` = main sort key**

Important v9.3 operational fields:
- **`01 Best Setup`**: setup classifier / pattern code
- **`02 Best Score`**: primary ranking score for shortlist ordering
- **`03 Final Long` / `04 Final Short`**: directional composite strength
- **`05 Trend Dir`**: trend direction context
- **`06 Macro Dir`**: higher-timeframe macro context
- **`07 Verdict`**: coarse verdict/state marker
- **`08 Conviction`**: coarse confidence / state marker
- **`09 Signal Dir`**: coarse directional output
- **`SQ*` columns**: setup-quality / research validation metrics
- **`D*` columns**: score decomposition and diagnostics
- **`G*` columns**: diagnostic adjustment/stability fields
- **`P*` columns**: penalty components

Durable interpretation rule:
- Use **`02 Best Score`** to rank.
- Use `03 Final Long` / `04 Final Short` plus `D*`, `G*`, and `P*` fields to understand *why* an asset ranked.
- Use `08 Conviction` as supporting context, not as the sole decision rule.

## Timeframe, Sorting, and Filtering Conventions

Durable reporting convention:
- Run on **4H**
- Rank by **`02 Best Score` descending**
- User-facing output should show the **top 5 assets**
- Present the v9.3 TradingView screener columns in a **transposed chat-friendly table**
- Best asset appears leftmost; weaker ranked assets move to the right

Historical note that still matters:
- An earlier v1 filtered to `10 Conviction State = 3` / equivalent conviction state
- That filter was later removed from the main user-facing report
- Current durable rule: **do not hard-filter the final report by conviction unless deliberately reintroduced**

Parity rule:
- If manual and automated results differ, verify **timeframe first**
- A past mismatch was caused by manual TradingView being left on `1D` while automation was correctly using `4H`

## Known Limitations and Quirks

Important durable quirks:
- TradingView Pine Screener column templates are not reliably persistent; visible columns should be re-applied during runs
- CSV export may behave differently from expected browser download flows; in practice it writes a file directly into the configured downloads directory
- UI automation is sensitive to TradingView frontend changes, so selectors and timing remain a maintenance surface
- Column checkbox state previously failed because an unchecked CSS class name contained the substring `checked`; exact class inspection is required for reliable column toggling

Practical implication:
- Treat column enforcement and export validation as first-class parts of the runtime, not optional polish

## Planned Upgrades

Long-term direction:
- keep cron execution lean
- move durable design memory into `tvflow`
- add deeper analysis workflows on top of the screener shortlist
- extend screener logic and Pine logic without overloading the runtime cron agent
- add cleaner routing/delivery beyond Telegram, especially Discord
- wire screener outputs into broader toolchains when useful

Current routing note:
- The 4H screener cron has been retargeted from Telegram to a dedicated Discord thread: `TV Pine Screener 4H`
- Discord thread id: `1487830028120231979`
- The cron still uses direct in-run messaging (delivery mode remains `none`), so routing is controlled by the prompt/script path rather than top-level cron delivery settings

Deep-analysis source-of-truth rule:
- The active Bitget deep-analysis workflow has been reverted to **OHLCV-first**
- Primary truth source: **Bitget OHLCV exports**
- Screenshots are now secondary / optional validation rather than the main analytical source

## Durable Project Rule

The Pine Screener system is the **recurring shortlist engine**, not the full reasoning layer. Runtime helpers may execute it, but project continuity, architecture decisions, report evolution, and future feature growth should live in `tvflow`.
