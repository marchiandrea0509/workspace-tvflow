# Deep Analysis Packet Contract

This document defines the stable data contract between OpenClaw/MCP, Python processing, and the LLM.

The goal is to keep the deep-analysis engine robust even when Pine Screener internals change.

---

## Folder contract

```text
reports/deep_analysis_packets/YYYYMMDD_HHMMSS_SYMBOL/
  manifest.json
  raw/
    bitget_SYMBOL_1D_ohlcv.csv
    bitget_SYMBOL_4H_ohlcv.csv
    bitget_SYMBOL_1H_ohlcv.csv
    market_snapshot.json
    execution_state.json optional
    tv_exports/ optional
  derived/
    analysis_summary.json
    candidate_levels.json
    freshness_check.json
  llm_input_packet.md
```

---

## manifest.json

Required fields:

```json
{
  "symbol": "AAPLUSDT",
  "tv_symbol": "BITGET:AAPLUSDT.P",
  "side": "LONG",
  "family": "LC",
  "score": 72.4,
  "risk_usdt": 100.0,
  "max_margin_usdt": 1500.0,
  "created_at_local": "2026-05-10T12:00:00+02:00",
  "created_at_utc": "2026-05-10T10:00:00Z",
  "timezone": "Europe/Berlin",
  "price_truth_source": "Bitget REST",
  "tv_export_source": "MCP",
  "screener_usage": "summary_only"
}
```

---

## OHLCV CSV format

Required columns:

```text
symbol,timeframe,open_time_ms,open_time_utc,open,high,low,close,base_volume,quote_volume
```

---

## market_snapshot.json

Recommended fields:

```json
{
  "symbol": "AAPLUSDT",
  "product_type": "USDT-FUTURES",
  "ticker": {},
  "funding_rate": {},
  "open_interest": {},
  "contract_specs": {},
  "fetched_at_utc": "..."
}
```

Missing values are allowed, but must be explicit.

---

## execution_state.json

Optional, authenticated data.

```json
{
  "position": {
    "has_position": false,
    "side": null,
    "size": 0,
    "entry_price": null
  },
  "open_orders": [],
  "tpsl_orders": [],
  "available_margin": null,
  "fetched_at_utc": "..."
}
```

If unavailable, the packet builder should write:

```json
{
  "available": false,
  "reason": "No authenticated execution-state source provided"
}
```

---

## analysis_summary.json

Required top-level fields:

```json
{
  "symbol": "AAPLUSDT",
  "side": "LONG",
  "risk_usdt": 100.0,
  "max_margin_usdt": 1500.0,
  "timeframes": {
    "1D": {},
    "4H": {},
    "1H": {}
  },
  "levels": {},
  "candidate_trade_design": {},
  "screener_summary": {},
  "freshness": {}
}
```

Each timeframe should include:

```json
{
  "latest_close": 0.0,
  "latest_closed_bar_time_utc": "...",
  "ema20": 0.0,
  "ema50": 0.0,
  "ema200": 0.0,
  "atr14": 0.0,
  "rsi14": 0.0,
  "trend_state": "bullish/bearish/neutral",
  "volume_ratio": 0.0,
  "recent_pivot_highs": [],
  "recent_pivot_lows": []
}
```

---

## candidate_levels.json

Recommended fields:

```json
{
  "supports": [
    {"price": 0.0, "source": "4H pivot low", "distance_pct": 0.0, "distance_atr": 0.0}
  ],
  "resistances": [
    {"price": 0.0, "source": "1H pivot high", "distance_pct": 0.0, "distance_atr": 0.0}
  ],
  "long_design": {
    "stop_loss_candidate": 0.0,
    "entries": []
  },
  "short_design": {
    "stop_loss_candidate": 0.0,
    "entries": []
  }
}
```

---

## llm_input_packet.md

This is the compact decision packet. It should contain:

1. Manifest summary
2. Data priority reminders
3. Screener summary only
4. Processed timeframe summaries
5. Candidate levels
6. Candidate trade design
7. Market/execution snapshot
8. Freshness check
9. File list for raw evidence

The LLM should use this packet with `prompts/master_trade_analysis_prompt.md`.
