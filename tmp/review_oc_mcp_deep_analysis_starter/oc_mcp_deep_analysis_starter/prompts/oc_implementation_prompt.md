# Prompt to paste into OpenClaw

Please implement an MCP-based deep-analysis packet builder for my manually selected TradingView/Pine Screener symbols.

Important workflow context:

- I usually run the Pine Screener separately.
- I manually select the symbol, usually when screener score is >=70.
- I then request a deep trade analysis for that selected symbol.
- The deep-analysis engine must not rely heavily on Pine Screener internals because I change the Pine Screener often.
- The screener's job is candidate selection.
- The deep-analysis engine's job is independent trade-ticket generation.

Use the files in this starter kit as the target architecture.

Main files:

- `scripts/build_deep_analysis_packet.py`
- `prompts/master_trade_analysis_prompt.md`
- `config/default_config.json`
- `schemas/packet_contract.md`

Goal:

Replace hardcoded per-symbol scripts like `aaplusdt_deep_analysis.py`, `nearusdt_deep_analysis.py`, etc. with one reusable command:

```bash
python scripts/build_deep_analysis_packet.py --symbol SYMBOL --tv-symbol TV_SYMBOL --side LONG --family LC --score 72.4 --risk-usdt 100 --max-margin-usdt 1500 --tv-export-dir PATH_TO_MCP_EXPORTS
```

Required output folder:

```text
reports/deep_analysis_packets/YYYYMMDD_HHMMSS_SYMBOL/
  manifest.json
  raw/
    bitget_SYMBOL_1D_ohlcv.csv
    bitget_SYMBOL_4H_ohlcv.csv
    bitget_SYMBOL_1H_ohlcv.csv
    market_snapshot.json
    execution_state.json optional
    tv_exports/...
  derived/
    analysis_summary.json
    candidate_levels.json
    freshness_check.json
  llm_input_packet.md
```

TradingView MCP tasks:

1. Open or connect to TradingView Desktop.
2. Set exact symbol from `--tv-symbol`, e.g. `BITGET:AAPLUSDT.P`.
3. Export clean neutral structure data for:
   - 1D
   - 4H
   - 1H
4. Capture clean screenshots for:
   - 1D
   - 4H
   - 1H
5. Optional: capture 4H screener/dashboard screenshot.
6. Save all MCP exports in a folder passed as `--tv-export-dir` to the Python packet builder.

Recommended screenshot indicators:

- Candles
- EMA 20
- EMA 50
- EMA 200
- support/resistance levels
- volume
- current price line

Avoid cluttering screenshots with many screener plots. Scores should be exported as data only if needed.

Screener context rule:

For Trading Mode, include only a small screener summary:

```json
{
  "screener_version": "...",
  "symbol": "...",
  "bias": "LONG/SHORT/AUTO",
  "family": "LC/SC/BREAKOUT/etc.",
  "score": 72.4,
  "rank": 1,
  "action_window_active": true,
  "bars_since_trigger": 3,
  "invalidation_state": "none",
  "latest_closed_bar_time": "..."
}
```

Do not require all internal component scores. They are for Research Mode only.

Bitget data tasks:

The Python packet builder should fetch public Bitget data:

- OHLCV 1D, 4H, 1H
- ticker
- mark/index price if available
- funding rate if available
- open interest if available
- contract specs if available

If authenticated access is configured safely, optionally fetch:

- current position
- open orders
- existing TP/SL
- available margin

Never place, cancel, or modify live orders unless I explicitly confirm in a separate instruction.

Derived summary requirements:

Python should compute or summarize:

- latest close/current price
- EMA 20/50/200
- ATR14
- RSI14
- ADX14 if implemented
- volume ratio
- recent pivot highs/lows
- support/resistance candidate levels
- distance to levels in ATR and percent
- suggested invalidation zone
- candidate ladder entry levels
- freshness status

Risk/ticket rules:

- Standard risk budget = 100 USDT.
- Max margin implication = 1500 USDT.
- If selected symbol came from score >=70, assume it is eligible for the full-risk plan.
- Do not reduce risk because of subjective confidence.
- The LLM should produce the best possible 100 USDT-risk ticket and separately list warnings.
- If impossible due to exchange sizing, margin, stale data, or missing data, output WAIT/NO_TRADE with reason.

Final LLM call:

Use `prompts/master_trade_analysis_prompt.md` plus the generated `llm_input_packet.md`.

The final output must include:

1. Human-readable trade analysis
2. Exact trade ticket table
3. Data usage check
4. Strict machine-readable JSON ticket
5. `requires_user_confirmation: true`

Please adapt paths and MCP command names to my local OpenClaw installation, but keep the architecture and data contract stable.
