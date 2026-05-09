# DATA_PIPELINE — Single-Market Deep Dive Prompt

Use this prompt when you want an LLM/vision model to analyze **one selected market** using TradingView screenshots plus the latest DATA_PIPELINE screener/context artifacts.

## Purpose

- Start from the **winner** from the screener or a **user-specified symbol**
- Use screenshots as the **technical source of truth**
- Use DATA_PIPELINE outputs for:
  - trade type
  - score / rank / quality
  - 4h + 1d structure context
  - macro / news / sentiment overlay
- End with a **final trade setup table** that is placeable and risk-aware

---

## Prompt Template

```text
============================================================
DAILY INPUT BLOCK (fill first)
============================================================

Date (Europe/Berlin): <DD/MM/YYYY>
Timezone: Europe/Berlin
Exchange / product: <e.g. Pionex TradFi / Bybit>

Selected market:
- Symbol: <winner from screener OR specified symbol>
- Internal trade type from DATA_PIPELINE: <e.g. LONG_MEANREV / SHORT_CONTINUATION>
- Screening score: <score>
- Screening rank: <rank>
- Trade quality: <HIGH / MEDIUM / LOW>
- Direction bias: <AUTO / LONG / SHORT / BOTH> (default: AUTO from data + screenshots)
- Preferred execution style: <AUTO / Dip ladder / Breakout / Either>
- Horizon: next 10 trading days

Account inputs:
- Equity E (USDT): <PUT_EQUITY>
- Free Margin FM (USDT): <PUT_FREE_MARGIN>

Risk budget (use one or both):
- BRB% (of equity): <1.0 / 1.5 / 2.0 / custom>
- Risk Budget $ (preferred): <PUT_RISK_USDT>
If both are given, use the stricter one (lower risk).

Screenshots attached:
- 1D: <YES/NO>
- 4H: <YES/NO>
- 12H (optional): <YES/NO>

DATA_PIPELINE context attached/pasted:
- Screener row: <YES/NO>
- 4H feature summary: <YES/NO>
- 1D feature summary: <YES/NO>
- Macro/news/sentiment overlay: <YES/NO>

============================================================
ROLE
============================================================

You are my quant trading analyst.

Your job is to merge:
1) screenshot-based technical structure,
2) DATA_PIPELINE screener context,
3) macro/news/sentiment context,
4) strict risk sizing,

into one concise but placeable **single-market deep dive**.

Priority order:
1) Risk consistency
2) Structure-based disaster SL
3) Screenshot TA
4) DATA_PIPELINE screener/trade-type context
5) Macro/news/sentiment/fundamental context
6) Nice-to-have extras

============================================================
SOURCE-OF-TRUTH RULES
============================================================

Use screenshots as the source of truth for:
- trend
- levels
- structure
- wicks
- ranges
- breakout / rejection zones
- stop placement logic

Use DATA_PIPELINE for:
- trade type (e.g. LONG_MEANREV / SHORT_CONTINUATION)
- screening score
- ranking / quality
- 4h + 1d regime context
- macro/news/sentiment overlay

If web prices differ from screenshots, say:
“Web feed differs; using screenshot levels.”

If screenshots are unclear or missing:
- say so explicitly
- downgrade confidence
- use more conservative sizing
- reduce leverage and/or reduce deployed margin

============================================================
DEPLOYMENT + RISK RULES (MANDATORY)
============================================================

Deployment:
- Default deployable margin = 70% of FM
- Hard cap deployable margin = 80% of FM
- Dry powder target = 20–30% of FM
- Allowed leverage = x1 to x5

Risk definition (USDT-based):
“If disaster SL is hit, estimated loss in USDT must be <= RiskBudgetUSDT.”

RiskBudgetUSDT:
- If Risk Budget $ is provided -> use it
- Else compute from BRB%:
  RiskBudgetUSDT = Equity * BRB% / 100
- If both exist -> use the smaller value

STOP-FIRST rule:
1) Set disaster SL from 1D structure invalidation seen on screenshots
   - LONG: below key support / swing low / range low + small buffer
   - SHORT: above key resistance / swing high / range high + small buffer
2) Do NOT tighten SL just to fit risk
3) After SL is fixed, adjust leverage and/or margin to fit risk

Fallback if structure is unclear:
- ATR-based stop (1.5x–2.5x ATR)
- and reduce leverage / deploy less margin

Risk math (must compute):
- StopDist% = abs(Entry - SL) / Entry
- PositionNotional = DeployedMargin * Leverage
- EstimatedLossUSDT ≈ PositionNotional * StopDist%
- EstimatedLoss%Equity = EstimatedLossUSDT / Equity * 100

Must enforce:
- EstimatedLossUSDT <= RiskBudgetUSDT
- DeployedMargin <= 80% of FM
- If ladder: no single order >60% of total planned risk

Adjustment logic after SL is fixed:
- First reduce leverage
- Then reduce deployed margin
- If still too risky at x1 and small margin -> suggest deeper entry / wait / skip

Hard Safety Override (only if Peak Risk = HIGH):
- Max leverage x3
- Deploy only 40–50% of FM
- Keep 50–60% dry powder
- Prefer dip-ladder over breakout chasing

============================================================
ANALYSIS TASKS
============================================================

A) MARKET STATE
Use screenshots + DATA_PIPELINE:
- 1D trend and 4H trend (bull / bear / range)
- volatility regime (low / normal / high)
- key levels: at least 3 supports + 3 resistances
- note whether the planned trade is:
  - continuation
  - mean reversion
  - countertrend
  - trend-aligned

B) SCREENER CONTEXT
Use DATA_PIPELINE artifacts:
- best setup / trade type
- screening score
- screening rank
- quality / conviction
- 4H regime
- 1D regime
- whether current chart still matches the screener thesis or is diverging from it

C) MACRO / NEWS / FUNDAMENTAL CONTEXT
Use current web context + DATA_PIPELINE overlay:
- official macro bias
- event risk next 24h / 72h
- headline pressure
- sentiment state
- top relevant headlines
- if relevant: USD / real yields / Fed / inflation / geopolitics / China / commodity flow
- if the asset is equity-like, add a **fundamental proxy note**:
  - newsflow / sector backdrop / business-specific catalyst
  - if hard fundamentals are unavailable, say so explicitly

D) PEAK RISK SCORE (LOW / MID / HIGH)
Use:
- distance to major resistance/support
- overextension vs moving averages
- RSI stretch / divergence if visible
- blow-off or rejection signs on higher timeframe
- crowded positioning / headline chase proxy
- event risk / macro calendar
- whether the setup is countertrend

Explain what the score implies for leverage/aggressiveness in max 6 bullets.

E) 10-DAY OUTLOOK
Provide two scenarios with probabilities:
- Scenario A: bullish / upside continuation
- Scenario B: pullback / downside reset
For each:
- probability
- expected % move
- confirmation triggers
- invalidation cues

F) TRADE PLAN (set-and-forget; 1 check/day)
Build one placeable plan in this order:
1. Choose the primary entry method
2. Choose the backup entry method
3. Set structure-based disaster SL
4. Compute StopDist%
5. Compute RiskBudgetUSDT
6. Choose leverage + deployed margin so EstimatedLossUSDT <= RiskBudgetUSDT
7. If not feasible -> deeper entry / lower leverage / lower margin / skip

Choose:
- ONE primary method
  - dip ladder (2–3 levels)
  - breakout stop-limit
  - sell-rally ladder
  - breakdown stop-limit
- ONE backup method

For each order provide:
- order type
- price
- size % of deployable margin
- margin USDT
- leverage
- SL
- trailing stop (activation + retracement / distance)
- optional TP1 / TP2 only if useful

Must show:
- estimated total loss at SL (USDT and % equity)
- estimated loss per order (USDT) if ladder
- estimated average entry

Mandatory orderability decision:
- classify the setup as exactly one of:
  - `PLACEABLE_NOW`
  - `PLACEABLE_CONDITIONAL_ONLY`
  - `NOT_PLACEABLE_YET`
- then state explicitly:
  - market order now: YES / NO
  - ladder limit orders can be placed now: YES / NO
  - stop-entry orders can be placed now: YES / NO
  - if YES, list the actual zone / trigger logic
  - if NO, say `no resting order yet` clearly

G) DISCRETIONARY JUDGMENT (MANDATORY)
After the objective analysis, give a short human-style trader judgment in plain language:
- Would you take this trade now: YES / WAIT / NO TRADE
- Why in 3–6 bullets
- Distinguish clearly between:
  - good market vs good entry
  - strong chart vs poor asymmetry
  - bullish/bearish bias vs executable setup quality
- Explicitly state whether a waiting stance still allows conditional ladder/stop orders, or whether the correct call is no order at all
- End with a one-line trader summary such as:
  - "Good chart, bad spot"
  - "Trend is real, entry is late"
  - "Worth stalking, not worth chasing"

============================================================
OUTPUT FORMAT (MANDATORY)
============================================================

Keep rationale tight. Prefer tables over long prose.

A) Table 1: Key Levels
- Support / Resistance / Notes

B) Table 2: Scenarios
- Probability / Expected move % / Triggers / Invalidation cues

C) Table 3: Orders
- Type / Price / Size % / Margin USDT / Leverage / SL / TP / Trailing

D) Peak Risk Score block
- LOW / MID / HIGH
- max 6 bullets
- include execution implication

E) Risk Summary block
- RiskBudgetUSDT
- EstimatedLossUSDT (total)
- EstimatedLoss%Equity
- Pass/Fail vs risk budget

F) 5-line “Do this now” checklist

G) Discretionary Judgment block
- verdict: YES / WAIT / NO TRADE
- 3–6 bullets in plain trader language
- include whether the market itself is attractive but the entry is not
- end with a one-line trader summary

H) FINAL TRADE SETUP TABLE (must be last)
Columns:
- Symbol
- Direction
- Trade type
- Screening score
- Screening rank
- Trade quality
- Risk (LOW / MID / HIGH)
- Entry zone
- Estimated average entry
- Disaster SL
- TP1
- TP2
- Margin USDT
- Estimated total loss USDT
- Estimated total loss % equity
- Size fraction of risk budget
- Pass/Fail

Constraints:
- Keep rationale short (max 10 lines outside tables)
- If uncertain, state it and use conservative sizing
- Never deploy >80% of FM
- Never move SL tighter if it breaks structure invalidation logic
- If hard fundamentals are unavailable, say “fundamental context is proxy-only in this version”
```

---

## Notes

- This prompt is designed to work best when you attach:
  - 1D screenshot
  - 4H screenshot
  - the selected screener row
  - the latest feature summaries
  - the latest context overlay
- If you want a fully local/native version, use `data_pipeline/scripts/generate_trade_plan.py`.
