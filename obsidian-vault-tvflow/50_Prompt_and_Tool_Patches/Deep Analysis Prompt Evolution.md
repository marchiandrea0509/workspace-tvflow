---
tags:
  - tvflow
  - deep-analysis
  - prompt-evolution
  - continuous-improvement
  - approved_rule
created: 2026-06-09
status: active-history
source_prompt: prompts/master_trade_analysis_prompt_v2.md
---

# Deep Analysis Prompt Evolution

This note documents the continuous improvement history of the deep-analysis LLM prompt and its adjacent tooling.

The active prompt file is:

```text
prompts/master_trade_analysis_prompt_v2.md
```

Important: these are retrospective semantic versions for documentation. The repository mostly used timestamped backups and sync commits, not formal semver tags.

## Current one-line summary

The deep-analysis workflow evolved from a generic/Bitget packet prompt into a screenshot-first, A/B/C/D swing-plan analyst with strict ticket formatting, explicit liquidity/orderability gates, VOCO alert-only wrappers, feedback records, outcome audits, mechanical validation/render gates, structure-first TP optimization, and explicit previous-week/range-high plus shelf-loss SL audits for pullbacks near major resistance/support.

## Version timeline

| Version | Date | Theme | Main change | Evidence / source |
|---|---:|---|---|---|
| v0 | 2026-04-10 | Bitget-specific baseline | Replaced generic deep-dive prompt with Bitget-specific prompt path and packet builder; first screenshot-grounded Bitget LLM packet tested on CRCLUSDT.P. | `memory/2026-04-10.md` lines 4-7 |
| v1 | 2026-05-10 | Deep Analysis V2 / OHLCV-first default | Created `build_deep_analysis_packet_v2.py`, runner, `master_trade_analysis_prompt_v2.md`, and schema. Set risk target, margin/leverage concepts, no live execution inside analysis, no hard screener-score eligibility. | `memory/2026-05-10.md` lines 3-21 |
| v1.1 | 2026-05-12 | A/B option framework | Added two mutually exclusive options: A = BEST QUALITY, B = BEST FILL PROBABILITY. Risk/margin caps apply per option, not combined. | `memory/2026-05-12.md` lines 66-75 |
| v1.2 | 2026-05-12 | Best-fill R:R exception | Added Option B shallow-L1 exception: L1 R:R may be 0.90-0.99 only if structure, risk share, L1+L2, all-filled R:R, SL/TP realism, margin/leverage all pass. | `memory/2026-05-12.md` lines 88-103 |
| v1.3 | 2026-05-13 | Active breakout + per-leg TP/R:R | Added active breakout/unconfirmed high logic, single-limit handling, non-blocking warnings, separate TP per leg, and per-leg/all-filled R:R calculations. | `memory/2026-05-13.md` lines 133-141 |
| v2 | 2026-05-13 | Screenshot-first policy | Andrea changed strategy back to screenshot-first: 1D/4H/1H TradingView screenshots are primary truth; OHLCV/Bitget data validate sizing/current price/margin/leverage/liquidation. | `memory/2026-05-13.md` lines 142-148 |
| v2.1 | 2026-05-14 | Always show A/B validity | Prompt must always output Option A and Option B sections, even when rejected, with exact failing metrics. | `memory/2026-05-14.md` lines 3-10 |
| v3 | 2026-05-14 | Attached master prompt v3 | Replaced active prompt with Andrea's attached “MASTER PROMPT v3 — Screenshot-First Bitget Deep Trade Analysis”; backup created. | `memory/2026-05-14.md` lines 13-18 |
| v3.1 | 2026-05-17 | 3-timeframe discipline + full output sections | Required explicit 1D/4H/1H screenshot reads and mandatory report sections from Chart Context through Final Verdict; no compressed replies. | `memory/2026-05-17.md` lines 5-50 |
| v3.2 | 2026-05-18 | Resting-entry distance + screenshot delivery | Added near-market/resting-entry distance policy; changed default Discord media delivery to analysis first, then 4H and 1D screenshots separately. | `memory/2026-05-18.md` lines 18-27 |
| v3.3 | 2026-05-18 | Structural SL / TP realism hierarchy | Added structural SL hierarchy audit and far-TP realism hierarchy so shallow/tight stops or distant TPs cannot fake good R:R. | `memory/2026-05-18.md` lines 60-63 |
| v4 | 2026-05-24 | Quant swing analyst A/B/C/D framework | Replaced prompt with Andrea's screenshot-based Bitget quant swing analyst framework: A pullback quality, B fill probability, C breakout/breakdown, D OC wrapper (`VIRTUAL_OCO` / `COMBO_100`). | `memory/2026-05-24.md` lines 3-8 |
| v4.1 | 2026-05-24 | Detected level map + impulse comparison | Required dense Detected Level Map before tickets and confirmed-vs-active impulse comparison; fixed AUTO side mapping. | `memory/2026-05-24.md` lines 23-29 |
| v4.2 | 2026-05-24 | A/B pullback replacement | Reworked DIP_LADDER/SELL_RALLY rules: valid 4H impulse, A uses cleanest levels, B maximizes valid fill ladder only if spacing/SL/TP/R:R/margin checks pass. | `memory/2026-05-24.md` lines 29-33 |
| v4.3 | 2026-05-25 | Feedback system starts | Created continuous-improvement feedback records comparing tvflow, GPT, Andrea-preferred ticket, issue tags, and improvement actions. GPT is audit/teacher, not execution authority. | `memory/2026-05-25.md` lines 16-22 |
| v4.4 | 2026-05-27 | Margin and impulse anti-regression | Margin >1500 at current leverage is not a chart-quality reject if leverage can be adjusted safely <=20x. Prompt must compare materially different local/broad impulses and print fib levels. | `memory/2026-05-27.md` lines 3-8 |
| v4.5 | 2026-05-29 | EWY feedback: broad parent swing + orderability table | Packet/static scan became audit aid only; broad visible parent swing near major R/S overrides local packet impulse unless local-BO exception passes; liquidity table required. | `memory/2026-05-29.md` lines 19-24 |
| v4.6 | 2026-05-30 | CL feedback: compact 5-day swing-plan format | Chat must include header/classification, Context/State, Key Levels, Pullback Impulse Used, A/B/C/D tickets, Orderability table, Final Verdict; avoid stale 1D pivot over-broadening. | `memory/2026-05-30.md` lines 3-5 |
| v4.7 | 2026-06-01 | No hidden rejected/conditional sections | TSLA regression led to rule: never hide rejected B/C/D/VOCO sections; every option must show status, numeric candidate/trigger, exact rejection reason, and what would fix it. | `memory/2026-06-01.md` lines 3-7 |
| v4.8 | 2026-06-02 | VOCO modes integrated into prompt | D/VOCO now distinguishes `PURE_VOCO`, `HYBRID_VOCO`, and `HYBRID_C100`; watchdog remains alert-only. | `memory/2026-06-02.md` lines 7-15 |
| v4.9 | 2026-06-04 | GPT comparison: support-sweep exception | TQQQ case added rule: bearish/corrective 1H blocks market buys but does not automatically veto passive B limits at visible support shelf after liquidity sweep. Square liquidity table required. | `memory/2026-06-04.md` lines 3-7 |
| v5 | 2026-06-04 | Validator pass is necessary, not sufficient | ASML case showed saved report passed validation but chat was compressed and GPT shelf SL was not tested. Added chat/report parity and manual testing of user/GPT shelf SL candidates. | `memory/2026-06-04.md` lines 23-29 |
| v5.1 | 2026-06-05 | Outcome-first improvement loop | Continuous improvement must be judged primarily by real Bitget/TradingView outcomes; GPT remains audit benchmark. Patch prompts only when evidence is repeated, clear, or safety-critical. | `memory/2026-06-05.md` lines 10-17 |
| v5.2 | 2026-06-05 | Liquidity/orderability redesign | Split orderability into liquidity/executable orderability, operational safety, and risk/feasibility; primary vs supporting liquidity gates; downsized fallback proposals. | `memory/2026-06-05.md` lines 38-46 |
| v5.3 | 2026-06-05 | Mechanical chat renderer gate | Added `render_deep_analysis_chat_reply.py`; future reports must validate saved markdown and rendered Discord reply, then send rendered reply or chunks, not hand-compressed summaries. | `memory/2026-06-05.md` lines 55-60 |
| v6 | 2026-06-09 | Structure-first TP design | TP selection became structure-first and independently optimized per order leg. Poor R:R rejection must first test ranked TP candidates and realistic per-leg assignments. | `memory/2026-06-09.md` lines 3-9 |
| v6.1 | 2026-06-09 | Contradiction audit after TP patch | Cleaned stale contradictions: A/B/C always emit status/audit sections; only valid/conditional setups get tickets. VOCO clarified as alert/proposal-only, never exchange execution. | `memory/2026-06-09.md` lines 10-15 |
| v6.2 | 2026-06-09 | ASML previous-week high / shelf-loss SL regression | ASMLUSDT comparison showed tvflow overfiltered GPT's valid Option B by capping impulse/TP around packet highs and forcing SL down to older supports. Prompt/docs/schema now require auditing previous-week/range high as parent high/TP and testing shelf-loss SL before WAIT. | `reports/deep_analysis_feedback/20260609T071221Z_ASMLUSDT_feedback.json` |

## Major design pivots

### 1. From generic analysis to Bitget-specific trade tickets

The first durable change was moving away from a generic market-analysis prompt into a Bitget-specific packet/prompt path. That introduced TradingView screenshot context, Bitget symbols, and practical conditional ladder execution ideas.

### 2. From OHLCV-first automation to screenshot-first discretionary structure

The V2 workflow began as OHLCV-first because it was cheap and deterministic. After repeated cases where static scans chose stale or too-local levels, Andrea shifted the policy back to screenshot-first:

1. TradingView 1D/4H/1H screenshots = primary truth.
2. User/GPT supplied key levels = important audit/reference input.
3. Bitget OHLCV/ticker/export = validation/sizing/safety/current price.
4. Packet static scans = audit aids, never final authority.

### 3. From one ticket to A/B/C/D alternatives

The prompt evolved from one static ticket into a structured swing-plan family:

- **A — BEST QUALITY:** cleaner structure, cleaner invalidation, better R:R, often fewer legs.
- **B — BEST FILL PROBABILITY:** higher chance of fill, can accept weaker shallow L1 if total ladder remains structurally valid.
- **C — Breakout / Breakdown:** separate trigger family, must use closed-candle confirmation and no-chase logic.
- **D — OC wrapper:** alert-only `VIRTUAL_OCO`, `HYBRID_VOCO`, `HYBRID_C100`, or `COMBO_100` analysis only when useful.

### 4. From prompt instructions to mechanical anti-regression gates

Repeated compressed Discord replies showed prompt text alone was insufficient. The workflow added:

- `scripts/validate_deep_analysis_report.py`
- `docs/ARM_APPROVED_DEEP_ANALYSIS_TEMPLATE.md`
- `scripts/render_deep_analysis_chat_reply.py`

The core lesson: saved report validation is not enough; the actual chat reply must preserve the validated section family.

### 5. From GPT comparison to outcome-first learning

GPT is useful as a benchmark, especially for level maps and alternative tickets, but not a source of truth. The newer workflow judges rules primarily against real trade outcomes, Bitget execution evidence, and OHLCV/TradingView market path.

### 6. From hard liquidity rejection to structured orderability

Orderability is now separated into:

1. Liquidity / executable orderability.
2. Operational safety.
3. Risk / feasibility.

The liquidity gate distinguishes primary execution gates from supporting gates and gives downsized fallback proposals when a full ticket fails.

### 7. From naive TP uniqueness to structural TP assignment

The latest TP patch removed an artificial unique-TP bias. Each order still has one TP, but identical TPs are allowed when the same visible structural target is objectively best. Rejections for poor R:R now require a real TP candidate audit first.

## Prompt backup / source snapshots

Known prompt backup snapshots found in `prompts/`:

```text
master_trade_analysis_prompt_v2.pre_v3_replace_20260514_0739.md
master_trade_analysis_prompt_v2.pre_screenshot_3tf_replace_20260517_145531.md
master_trade_analysis_prompt_v2.pre_screenshot_structure_primary_replace_20260517_173756.md
master_trade_analysis_prompt_v2.pre_ticket_output_patch_20260517_175438.md
master_trade_analysis_prompt_v2.pre_option_ab_path_patch_20260517_181321.md
master_trade_analysis_prompt_v2.pre_remove_symbol_examples_20260517_182911.md
master_trade_analysis_prompt_v2.pre_attached_quant_prompt_20260524_150419.md
master_trade_analysis_prompt_v2.pre_ewy_impulse_liquidity_patch_20260529_1405.md
master_trade_analysis_prompt_v2.md
```

Git has periodic sync checkpoints touching the prompt from 2026-05-10 through 2026-06-05, but the memory notes and timestamped backups are more informative than the generic commit subjects.

## Current active principles

- Use screenshot-first chart structure for actual levels.
- Use packet/OHLCV/static scans as validation and audit aids.
- Always output A/B/C/D status sections, even if rejected.
- Only valid/conditional setups get full trade tickets.
- Use explicit rejection audits with observed value, required value, reason, and what would fix it.
- When price is extended just below previous-week/range resistance, audit that high as parent-swing high and realistic TP; test shelf-loss SL below the immediate breakout/retest shelf before forcing stops to older support clusters.
- Treat live execution as separate: deep analysis proposes only.
- VOCO/watchdogs are alert/proposal-only unless a future separately approved executor is explicitly created.
- Validate saved report and rendered chat reply before delivery.
- Compare against GPT and Andrea feedback, but patch prompts/tools only when evidence is clear, repeated, or safety-critical.
- Use real outcomes as the strongest feedback signal.

## Open documentation gaps / possible next refinements

- Add a diff-based prompt archive with one exported copy per semantic version.
- Link each feedback JSON to the corresponding Obsidian note once more cases are curated.
- Build a small “prompt changelog generator” from memory notes + git diffs + backup filenames.
- Add outcome tags to each prompt rule: helped / hurt / neutral / unknown.

## Related files

- `prompts/master_trade_analysis_prompt_v2.md`
- `README_DEEP_ANALYSIS_V2.md`
- `README_DEEP_ANALYSIS_FEEDBACK.md`
- `docs/ARM_APPROVED_DEEP_ANALYSIS_TEMPLATE.md`
- `docs/OUTCOME_FEEDBACK_LOOP.md`
- `scripts/build_deep_analysis_packet_v2.py`
- `scripts/validate_deep_analysis_report.py`
- `scripts/render_deep_analysis_chat_reply.py`
- `reports/deep_analysis_feedback/`
- `reports/outcome_audits/`
