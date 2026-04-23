# GOOGLUSDT Bitget Deep Analysis

Date: 2026-04-22 22:14 Europe/Berlin
Method: OHLCV-first Bitget public market data
Symbol: GOOGLUSDT (Bitget USDT perpetual)

## Data snapshot
- Last price: 338.01
- 1D: EMA20 325.19, EMA50 315.01, ATR14 5.62 (1.66%)
- 4H: EMA20 337.06, EMA50 334.09, ATR14 2.32 (0.69%)
- 1D 20-bar high/low: 342.14 / 293.50
- 4H 20-bar high/low: 341.19 / 331.51

## Trend read
- 1D trend: bullish
- 4H trend: bullish
- Alignment: aligned
- Volatility regime: normal
- Structure: steady grind up into local resistance

## Key levels
### Support
- 337.0 to 335.6
- 334.8 to 333.2
- 331.5
- 310.1
- 302.5

### Resistance
- 339.5 to 342.1
- 346.8
- 353.8

## Trade quality
- GOOD MARKET + BAD ENTRY
- Trend is constructive on both 1D and 4H.
- Price is sitting just under nearby resistance rather than pulling back into support.
- That makes a market long less attractive than either a dip-buy or confirmed breakout entry.

## Primary plan
- Bias: LONG
- Entry method: ladder limits
- Execution style: DIP_LADDER
- Entry zone: 336.20 / 334.80 / 333.20
- Stop loss: 330.70
- TP1: 341.20
- TP2: 346.80
- TP3: 353.80
- Orderability: PLACEABLE_CONDITIONAL_ONLY
- Market order now: NO
- Ladder limits allowed now: YES
- Stop-entry allowed now: YES above 342.30

## Example ticket assumptions
Assume isolated 4x leverage for sizing example only.

| order level | order type | entry price | margin used $ | notional size $ | qty | stop loss | effective loss at stop $ | TP1 | TP2 | TP3 |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| L1 | limit buy | 336.20 | 100 | 400 | 1.19 | 330.70 | 6.55 | 341.20 | 346.80 | 353.80 |
| L2 | limit buy | 334.80 | 100 | 400 | 1.19 | 330.70 | 4.88 | 341.20 | 346.80 | 353.80 |
| L3 | limit buy | 333.20 | 100 | 400 | 1.20 | 330.70 | 3.00 | 341.20 | 346.80 | 353.80 |

- Total planned risk: about 14.43 USDT
- Total margin implication: 300 USDT
- Margin cap status: within 1500 USDT cap

## Backup plan
- Bias: LONG breakout
- Trigger: 342.30 stop-entry only after 4H continuation above local range
- Stop: 338.90
- TP1: 346.80
- TP2: 353.80
- TP3: trail if acceptance above 353.80

## Final verdict
- Bias: LONG
- Best setup: buy dip into 336.2 to 333.2, not market chase
- Orderability: conditional only
- Confidence: 68
- Invalidation: 4H failure back through 331.5, especially if daily closes weaken under that pivot
- Action now: wait for dip or wait for confirmed breakout above 342.3
