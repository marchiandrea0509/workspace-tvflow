# ARM-approved Deep Analysis Output Template

Reference accepted by Andrea: `reports/deep_analysis/2026-06-01_ARMUSDT_deep_analysis.md`.

Use this template for every future Bitget deep-analysis chat answer and saved report unless Andrea explicitly asks for a shorter format.

## Header / classification
- Symbol
- Mode / no-live-execution boundary
- Verdict
- Classification
- Primary idea
- Live blocker / orderability state

## Context and state
| TF | State | Key read | Bias |
|---|---|---|---|
| 1D |  |  |  |
| 4H |  |  |  |
| 1H |  |  |  |

Existing exposure check: regular orders / plan orders / position.

## Detected level map / Structure and key levels
| Type | Levels | Notes |
|---|---|---|
| Immediate support |  |  |
| Tactical support |  |  |
| Main pullback support |  |  |
| Structural support |  |  |
| Deeper support |  |  |
| Resistance |  |  |

## Pullback impulse used
| Candidate impulse | Fibs / zones | Decision |
|---|---|---|
| Local / micro impulse |  |  |
| Packet / closed-candle impulse |  |  |
| Broad visible 4H/1D parent impulse |  | Used/rejected with reason |

Rule: compare local, packet/closed, and broad visible parent when materially different. Prefer broad visible parent near major S/R when it explains A/B ladder structure better.

## A — BEST QUALITY PULLBACK
**Status:**

Ticket table required if valid:
| Leg | Entry | Type | Qty | Notional | SL | Loss | TP | Profit | RR | Trigger |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|

If rejected, show candidate levels and exact rejection reason.

## B — BEST FILL-PROBABILITY PULLBACK
**Status:**

Ticket table required if valid. If rejected, include shallow-leg audit:
| Candidate leg | Entry | SL | Nearest TP | Next TP | RR to nearest | RR to next | Decision |
|---|---:|---:|---:|---:|---:|---:|---|

## C — BREAKOUT / BREAKDOWN
### C1 — Long breakout
**Status:**

Ticket table required if valid or conditionally placeable.

### C2 — Short breakdown
**Status:**

Explain rejection/trigger conditions.

## D — OC EXECUTION WRAPPER / VOCO
| Wrapper | Status | Reason |
|---|---|---|
| VIRTUAL_OCO |  |  |
| COMBO_100 |  |  |

## Orderability / liquidity traffic-light table
State which gate/ticket size was used.

| Gate | Value observed | Pass / limit | Light | Note |
|---|---:|---:|---|---|
| Existing orders/position |  |  | 🟢/🟡/🔴/⚪ |  |
| Spread |  |  | 🟢/🟡/🔴/⚪ |  |
| 24h quote volume |  |  | 🟢/🟡/🔴/⚪ |  |
| Dead 1m candles |  |  | 🟢/🟡/🔴/⚪ |  |
| Volume stress / RWA active-session effective mode |  |  | 🟢/🟡/🔴/⚪ |  |
| Stop-exit sim |  |  | 🟢/🟡/🔴/⚪ |  |
| Depth to SL |  |  | 🟢/🟡/🔴/⚪ |  |
| User live confirmation |  |  | 🟢/🟡/🔴/⚪ |  |

## Risk sizing summary
| Plan | Status | Risk | Reward | RR | Notional | Margin |
|---|---|---:|---:|---:|---:|---:|

## Final verdict
- Best structural plan
- Preferred option
- What not to do
- Live execution boundary / override requirement
- Saved packet/report references
