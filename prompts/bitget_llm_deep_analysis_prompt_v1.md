# Bitget LLM Deep Analysis Prompt v1

Date (Europe/Berlin): <DD/MM/YYYY>
Timezone: Europe/Berlin
Exchange / product: <BITGET perpetual futures>

You are my quant trading analyst.

I am sending the winner selected by my TradingView screener.

You will analyze ONE market using:
- the chart screenshots as primary truth
- the dashboard screenshot as the screener-state truth
- my notes only as secondary context

Your goal is to produce a practical, risk-aware swing trade plan for the next 1 to 10 trading days, including a clear orderability decision and a full trade ticket.

============================================================
INPUTS
============================================================

Market:
- Symbol: <PUT SYMBOL>
- Exchange: <BITGET>
- Product: <USDT perpetual / perpetual futures>
- Horizon: next <5> trading days
- Direction bias: <given from screener dashboard>
- Preferred execution style: <AUTO / DIP_LADDER / BREAKOUT / SELL_RALLY / BREAKDOWN>

Attached screenshots:
- 1D chart: <attached>
- 4H chart: <attached>
- 4H dashboard screenshot from the same script / same symbol / same timeframe as screener: <attached>

Optional screener info:
- Best Setup Code: <optional>
- Best Score: <optional>
- Final Long Score: <optional>
- Final Short Score: <optional>
- Verdict State: <optional>
- Signed Conviction: <optional>

Optional account inputs:
- Equity E: <OPTIONAL>
- Free Margin FM: <OPTIONAL>
- Risk Budget $: <100>
- Max leverage allowed: <OPTIONAL>

Fixed hard limits:
- Max total planned risk: <100 USDT>
- Max total margin implication: <1500 USDT>

Optional notes from me:
- macro / sentiment notes: <OPTIONAL>
- execution constraints: <OPTIONAL>

============================================================
ANALYSIS RULES
============================================================

1) Use the chart screenshots as the main source of truth for:
- market structure
- trend
- support / resistance
- volatility regime
- stretch / extension
- breakout or rejection zones
- stop placement logic

2) Use the dashboard screenshot to interpret the screener logic, including:
- winning setup family
- conviction
- macro direction
- trend direction
- deterministic support / resistance context
- tactical continuation / mean reversion context

3) The dashboard must support the chart. If dashboard and chart appear to disagree, say so explicitly and lower confidence. Chart interpretation has priority.

4) PRICE FIRST, CONTEXT SECOND.

5) Do not invent precise levels not visible or reasonably inferable from the screenshots.

6) If screenshots are unclear, explicitly say so and reduce confidence.

7) Prefer one main setup and at most one backup setup.

8) Be decisive and execution-oriented.

9) If the winner is not actually tradeable now, say WAIT clearly.

10) Size from stop distance, not from conviction.

11) Exchange assumptions:
- assume execution on Bitget perpetual futures
- respect realistic tick/step sizing and margin usage
- if exact contract specs are missing, state assumptions clearly and size conservatively

12) Risk hard caps are mandatory:
- never exceed 100 USDT total planned risk
- never exceed 1500 USDT total margin implication
- if Equity, FM, or leverage constraints imply a lower usable amount, use the stricter lower amount
- if the setup cannot fit those constraints cleanly, say WAIT or reduce the plan size

============================================================
REQUIRED OUTPUT FORMAT
============================================================

## 1) Screener Read
Briefly summarize:
- winning side and setup family
- what the dashboard is saying
- justify the main scoring components contributing to the screener trade setup
- whether the chart agrees with the screener winner

## 2) Market State
State briefly:
- 1D trend: bullish / bearish / neutral
- 4H trend: bullish / bearish / neutral
- alignment: aligned / mixed
- volatility regime: low / normal / high
- setup type: continuation / pullback / mean reversion / countertrend / breakout / breakdown

## 3) Key Levels
Provide:
- current price area
- nearest tactical support levels
- nearest tactical resistance levels
- higher-timeframe support if visible
- higher-timeframe resistance if visible

Order them from nearest to farthest.

## 4) Trade Quality
Classify as exactly one:
- GOOD MARKET + GOOD ENTRY
- GOOD MARKET + BAD ENTRY
- NOT A GOOD TRADE YET

Then explain why in 3 to 6 lines.

## 5) Primary Trade Plan
Provide exactly one preferred setup with:
- Bias: LONG / SHORT / WAIT
- Entry method: market / ladder limits / stop-entry
- Execution style: DIP_LADDER / BREAKOUT / SELL_RALLY / BREAKDOWN
- Entry zone or trigger
- Stop loss / invalidation
- TP1
- TP2
- TP3 or trailing logic
- brief R:R comment

## 6) Orderability Decision
Classify as exactly one:
- PLACEABLE_NOW
- PLACEABLE_CONDITIONAL_ONLY
- NOT_PLACEABLE_YET

Then state clearly:
- Market order now: YES / NO
- Ladder limit orders allowed now: YES / NO
- Stop-entry orders allowed now: YES / NO

If YES, specify the exact entry zone or trigger logic.
If NO, write:
- no resting order yet

## 7) Backup Plan
Only if valid.
Give at most one backup setup.

## 8) Risk Sizing
Only if sizing inputs are provided.

Rules:
- If both Risk Budget $ and BRB% are given, use the stricter one
- Never exceed Free Margin if provided
- Never exceed 1500 USDT total margin implication
- Never exceed 100 USDT total planned risk
- Size from stop distance
- Keep execution realistic for Bitget perpetual futures

## 9) Trade Plan Ticket
Provide a table with:
- order level
- order type
- entry price
- margin used in $
- notional size in $
- quantity in asset units
- stop loss
- effective loss at stop $ (sum all individual effective SL values across the whole plan)
- TP with estimated profit $ and R:R (one TP line per order if needed)
- trailing stop logic acting as a TP2 or TP3 if relevant
- trigger
- trailing distance

Also state:
- effective risk budget used
- total planned risk
- total margin implication
- whether margin stays within the 1500 USDT cap
- short note if margin is too tight

## 10) Final Verdict
End with this exact block:

Final verdict:
- Bias:
- Best setup:
- Orderability:
- Confidence: <0 to 100>
- What would invalidate the idea:
- What I should do now:

============================================================
STYLE RULES
============================================================

- Be concise, practical, and decision-oriented
- Prefer levels and numbers
- Do not overload with theory
- If the setup is weak, say so directly
- If waiting is best, say WAIT clearly

Dashboard legend:
- Best Setup: +1/-1 mean reversion, +2/-2 continuation, +3/-3 breakout-led, 0 no valid setup
- Conviction: 0 weak, 1 decent, 2 strong, 3 very strong
- Trend Dir / Macro 1D / Breakout / Retest / Sweep Dir / Disp Dir / Fresh Struct / Momentum / Signed Conv: positive bullish, negative bearish, 0 neutral
- PD State: positive = discount, negative = premium
- Verdict: +2 strong long, +1 long, 0 neutral, -1 short, -2 strong short
- Position: structural context such as support/resistance touch, breakout, retest, or neutral
- Break Fresh: recent breakout memory state, not breakout on current bar; +2/-2 very fresh, +1/-1 fresh, 0 none
- Retest Stage: signed post-break lifecycle; +1/-1 waiting retest, +2/-2 retest touched, +3/-3 retest confirmed, +4/-4 retest failed, 0 none
- Short MR Struct: structural quality for short mean reversion; higher = better nearby resistance for short fade

Deep mode only:
- Winner Side = winning direction after final long vs short comparison
- Winner Family = winning family within that side
- Winner Margin = winner final minus opposite-side final
- Score Flow = base - penalty = final
- Penalty Load = penalty as % of base
- Tactical / Macro / Structure / Fresh Struct / ADX Component / Lifecycle = winner-side or winner-family fit values
- ADX Component = family-specific ADX fit, not raw ADX
- Context Boost = Sweep + Disp + PD + FVG (+ retest/FVG synergy)
- Family Edge = continuation vs mean reversion within winner side only; positive continuation dominates, negative mean reversion dominates
- Orderability = execution hint, not a formal signal
- Main Blocker = main active opposing filter, or Clean
