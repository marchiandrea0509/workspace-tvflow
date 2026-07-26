# Bitget isolated liquidation and margin

For USDT futures isolated margin, Bitget documents:

`estimated liquidation = [position margin + offset - size × average entry × direction] / [size × (MMR + taker fee ratio - direction)]`

- `direction = 1` for long and `-1` for short.
- Use the live position-tier maintenance-margin rate.
- Use the contract taker/liquidation fee rate.
- Validate the whole ladder at its blended entry and selected leverage.
- Long liquidation must be below SL; short liquidation must be above SL.
- Recheck the tier at the planned fill/liquidation value.
- Formula output is an estimate, not exchange proof. Re-read Bitget after placement and after fills.

For the included AAPL example, tier-1 MMR was `0.005`, taker/liquidation fee was `0.0006`, blended entry was `325.310019544`, and `39x` estimated liquidation was `318.7538`, just below SL `318.80`. `40x` failed.
