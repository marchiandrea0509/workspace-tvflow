# OC MCP Deep Analysis Starter Kit

This starter kit is for Andrea's OpenClaw workflow where the Pine Screener is run separately, then a manually selected symbol is passed into a deep-analysis workflow.

The main design principle is:

```text
Screener = candidate selection
Deep analysis = independent trade ticket generation
```

The deep-analysis engine should not depend on unstable Pine Screener internals. It should primarily use neutral market structure, Bitget execution data, and processed summaries. Screener data is used only as a small alignment/context block.

---

## What this bundle contains

```text
oc_mcp_deep_analysis_starter/
  README.md
  prompts/
    master_trade_analysis_prompt.md
    oc_implementation_prompt.md
  scripts/
    build_deep_analysis_packet.py
  config/
    default_config.json
  schemas/
    packet_contract.md
  examples/
    mcp_tv_export_manifest.example.json
    execution_state.example.json
```

---

## Recommended architecture

```text
1. User runs Pine Screener manually
2. User selects symbol + direction/family, normally score >=70
3. OC/MCP opens TradingView Desktop on the selected symbol
4. MCP exports neutral TradingView structure data and clean screenshots
5. Python fetches Bitget OHLCV + public execution data
6. Python creates derived summaries: trend, levels, ATR, freshness, candidate ladder zones
7. LLM receives one structured prompt + compact packet
8. LLM outputs human analysis + strict JSON trade ticket
9. No live order execution without explicit user confirmation
```

---

## Data philosophy

Use three layers:

```text
raw exports        = evidence / audit
processed summary  = compressed facts
LLM prompt         = judgement + trade ticket
```

Do not ask the LLM to manually discover everything from huge CSV files. Let Python calculate the stable facts first.

---

## Screener usage rule

For Trading Mode:

- Keep only a small screener summary.
- Do not feed all internal screener components by default.
- Do not let the LLM reduce risk only because it has subjective doubts.
- If user selected a symbol from threshold >=70, assume it is eligible for the standard 100 USDT-risk plan.

Recommended screener context fields:

```json
{
  "screener_version": "OC Hybrid Edge Screener v11.5.x",
  "symbol": "AAPLUSDT.P",
  "bias": "LONG",
  "family": "LC",
  "score": 72.4,
  "rank": 1,
  "action_window_active": true,
  "bars_since_trigger": 3,
  "invalidation_state": "none",
  "latest_closed_bar_time": "..."
}
```

Full screener internals should be used only in Research Mode when debugging why the screener selected a symbol.

---

## Screenshot usage rule

Screenshots are optional validation, not primary analysis truth.

Best standard set:

```text
1D clean chart screenshot
4H clean chart screenshot
1H clean chart screenshot
optional 4H screener dashboard screenshot
```

Recommended visual indicators:

```text
Candles
EMA 20
EMA 50
EMA 200
Support/resistance levels
Volume
Current price line
```

Avoid cluttering screenshots with every score plot, RSI, ADX, etc. Those are better exported numerically.

---

## How to run the packet builder

Example:

```bash
python scripts/build_deep_analysis_packet.py \
  --symbol AAPLUSDT \
  --tv-symbol BITGET:AAPLUSDT.P \
  --side LONG \
  --family LC \
  --score 72.4 \
  --risk-usdt 100 \
  --max-margin-usdt 1500 \
  --tv-export-dir C:\\path\\to\\mcp_exports\\AAPLUSDT
```

The script creates:

```text
reports/deep_analysis_packets/YYYYMMDD_HHMMSS_AAPLUSDT/
  manifest.json
  raw/
    bitget_AAPLUSDT_1D_ohlcv.csv
    bitget_AAPLUSDT_4H_ohlcv.csv
    bitget_AAPLUSDT_1H_ohlcv.csv
    market_snapshot.json
    tv_exports/...
  derived/
    analysis_summary.json
    candidate_levels.json
    freshness_check.json
  llm_input_packet.md
```

Then paste/send `llm_input_packet.md` plus `prompts/master_trade_analysis_prompt.md` to the LLM, or let OC do that automatically.

---

## Important implementation note

The included Python script is a starter implementation. It fetches public Bitget data and creates deterministic summaries. It does not directly call your MCP tools because each OC installation may expose MCP commands differently.

The intended OC task is:

1. Use `prompts/oc_implementation_prompt.md` to ask OC to connect this packet builder to your actual MCP export functions.
2. Keep `master_trade_analysis_prompt.md` as the stable LLM instruction.
3. Keep `build_deep_analysis_packet.py` as the central packet builder, replacing hardcoded per-symbol scripts.

---

## Risk design

For a user-selected screener candidate, normally score >=70:

```text
Target planned risk = 100 USDT
Max margin implication = 1500 USDT
```

The LLM should build the best 100 USDT-risk ticket and report warnings separately. It should not silently reduce risk because of subjective confidence.

If no trade is possible, the JSON ticket should still be produced with `decision: WAIT` or `NO_TRADE`, but this should be reserved for hard problems such as missing data, impossible sizing, stale packet, or explicit user instruction.

---

## Ladder/SL design

The stop is defined first from invalidation:

```text
LONG: below valid 4H support / swing low + ATR buffer
SHORT: above valid 4H resistance / swing high + ATR buffer
```

Ladder entries are then selected from neutral structure:

```text
LONG DIP_LADDER:
  L1 shallow pullback: 1H support / EMA20 / minor pivot
  L2 normal pullback: 4H support / EMA50 / 0.6-1.0 ATR pullback
  L3 deep pullback: stronger 4H support above SL

SHORT SELL_RALLY:
  mirrored logic using resistance zones
```

Quantity is mechanical:

```text
qty = allocated_leg_risk / abs(entry - stop)
```

Use one shared SL by default.

---

## Recommended next OC task

Paste the contents of `prompts/oc_implementation_prompt.md` into OC and ask it to adapt this starter kit to your local MCP command names and folder paths.
