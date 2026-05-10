#!/usr/bin/env python3
"""
Generic MCP/Bitget deep-analysis packet builder.

Purpose:
- Replace hardcoded per-symbol deep-analysis scripts.
- Fetch Bitget OHLCV and public market data.
- Copy optional TradingView MCP exports/screenshots.
- Compute compact derived summaries for the LLM.
- Generate llm_input_packet.md using a stable data contract.

This script intentionally does not place, cancel, or modify orders.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import shutil
import statistics
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

BITGET_BASE = "https://api.bitget.com"
PRODUCT_TYPE = "USDT-FUTURES"


@dataclass
class Candle:
    open_time_ms: int
    open_time_utc: str
    open: float
    high: float
    low: float
    close: float
    base_volume: float
    quote_volume: float


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def local_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path, default: Any = None) -> Any:
    if not path or not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def bitget_get(endpoint: str, params: Dict[str, Any]) -> Dict[str, Any]:
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{BITGET_BASE}{endpoint}?{query}"
    req = urllib.request.Request(url, headers={"User-Agent": "OpenClaw-MCP-DeepAnalysis/1.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("code") not in (None, "00000"):
        raise RuntimeError(f"Bitget error at {endpoint}: {payload.get('code')} {payload.get('msg')}")
    return payload


def api_symbol(symbol: str) -> str:
    return symbol.upper().replace("BITGET:", "").replace(".P", "")


def fetch_candles(symbol: str, granularity: str, limit: int) -> List[Candle]:
    payload = bitget_get(
        "/api/v2/mix/market/candles",
        {
            "symbol": api_symbol(symbol),
            "productType": PRODUCT_TYPE,
            "granularity": granularity,
            "limit": limit,
        },
    )
    rows = payload.get("data") or []
    candles: List[Candle] = []
    for row in rows:
        # Bitget rows: [ts, open, high, low, close, baseVol, quoteVol]
        ts = int(row[0])
        candles.append(
            Candle(
                open_time_ms=ts,
                open_time_utc=datetime.fromtimestamp(ts / 1000, tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                open=float(row[1]),
                high=float(row[2]),
                low=float(row[3]),
                close=float(row[4]),
                base_volume=float(row[5]) if len(row) > 5 and row[5] not in (None, "") else 0.0,
                quote_volume=float(row[6]) if len(row) > 6 and row[6] not in (None, "") else 0.0,
            )
        )
    return sorted(candles, key=lambda c: c.open_time_ms)


def write_ohlcv_csv(path: Path, symbol: str, timeframe: str, candles: List[Candle]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            "symbol", "timeframe", "open_time_ms", "open_time_utc", "open", "high", "low", "close", "base_volume", "quote_volume"
        ])
        for c in candles:
            w.writerow([symbol, timeframe, c.open_time_ms, c.open_time_utc, c.open, c.high, c.low, c.close, c.base_volume, c.quote_volume])


def fetch_optional_market_snapshot(symbol: str) -> Dict[str, Any]:
    """Fetch best-effort public market data. Missing endpoints should not kill the packet."""
    snap: Dict[str, Any] = {
        "symbol": api_symbol(symbol),
        "product_type": PRODUCT_TYPE,
        "fetched_at_utc": utc_now_iso(),
        "ticker": None,
        "funding_rate": None,
        "open_interest": None,
        "contract_specs": None,
        "errors": [],
    }

    calls = [
        ("ticker", "/api/v2/mix/market/ticker", {"symbol": api_symbol(symbol), "productType": PRODUCT_TYPE}),
        ("funding_rate", "/api/v2/mix/market/current-fund-rate", {"symbol": api_symbol(symbol), "productType": PRODUCT_TYPE}),
        ("open_interest", "/api/v2/mix/market/open-interest", {"symbol": api_symbol(symbol), "productType": PRODUCT_TYPE}),
        ("contract_specs", "/api/v2/mix/market/contracts", {"symbol": api_symbol(symbol), "productType": PRODUCT_TYPE}),
    ]
    for key, endpoint, params in calls:
        try:
            snap[key] = bitget_get(endpoint, params).get("data")
        except Exception as exc:  # best effort only
            snap["errors"].append({"source": key, "error": str(exc)})
    return snap


def ema(values: List[float], period: int) -> Optional[float]:
    if len(values) < period or period <= 0:
        return None
    k = 2.0 / (period + 1.0)
    e = sum(values[:period]) / period
    for v in values[period:]:
        e = v * k + e * (1.0 - k)
    return e


def sma(values: List[float], period: int) -> Optional[float]:
    if len(values) < period or period <= 0:
        return None
    return sum(values[-period:]) / period


def atr(candles: List[Candle], period: int = 14) -> Optional[float]:
    if len(candles) < period + 1:
        return None
    trs: List[float] = []
    for i in range(1, len(candles)):
        c = candles[i]
        prev_close = candles[i - 1].close
        trs.append(max(c.high - c.low, abs(c.high - prev_close), abs(c.low - prev_close)))
    if len(trs) < period:
        return None
    return sum(trs[-period:]) / period


def rsi(candles: List[Candle], period: int = 14) -> Optional[float]:
    if len(candles) < period + 1:
        return None
    gains: List[float] = []
    losses: List[float] = []
    closes = [c.close for c in candles]
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def adx(candles: List[Candle], period: int = 14) -> Optional[float]:
    """Simple ADX approximation for summary use."""
    if len(candles) < period * 2 + 1:
        return None
    trs: List[float] = []
    plus_dm: List[float] = []
    minus_dm: List[float] = []
    for i in range(1, len(candles)):
        cur, prev = candles[i], candles[i - 1]
        up = cur.high - prev.high
        down = prev.low - cur.low
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
        trs.append(max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close)))
    dxs: List[float] = []
    for i in range(period, len(trs) + 1):
        tr = sum(trs[i - period:i])
        if tr == 0:
            continue
        pdi = 100 * sum(plus_dm[i - period:i]) / tr
        mdi = 100 * sum(minus_dm[i - period:i]) / tr
        denom = pdi + mdi
        if denom > 0:
            dxs.append(100 * abs(pdi - mdi) / denom)
    if len(dxs) < period:
        return None
    return sum(dxs[-period:]) / period


def detect_pivots(candles: List[Candle], left: int = 3, right: int = 3, max_items: int = 8) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    highs: List[Dict[str, Any]] = []
    lows: List[Dict[str, Any]] = []
    n = len(candles)
    for i in range(left, n - right):
        window = candles[i - left:i + right + 1]
        c = candles[i]
        if c.high == max(x.high for x in window):
            highs.append({"time_utc": c.open_time_utc, "price": c.high})
        if c.low == min(x.low for x in window):
            lows.append({"time_utc": c.open_time_utc, "price": c.low})
    return highs[-max_items:], lows[-max_items:]


def volume_ratio(candles: List[Candle], period: int = 20) -> Optional[float]:
    vols = [c.quote_volume or c.base_volume for c in candles]
    if len(vols) < period + 1:
        return None
    avg = sum(vols[-period-1:-1]) / period
    if avg == 0:
        return None
    return vols[-1] / avg


def round_or_none(x: Optional[float], ndigits: int = 6) -> Optional[float]:
    if x is None or not math.isfinite(x):
        return None
    return round(float(x), ndigits)


def trend_state(close: float, ema20: Optional[float], ema50: Optional[float], ema200: Optional[float]) -> str:
    if ema20 is None or ema50 is None:
        return "unknown"
    if close > ema20 > ema50 and (ema200 is None or close > ema200):
        return "bullish"
    if close < ema20 < ema50 and (ema200 is None or close < ema200):
        return "bearish"
    return "neutral_mixed"


def summarize_timeframe(timeframe: str, candles: List[Candle]) -> Dict[str, Any]:
    closes = [c.close for c in candles]
    e20, e50, e200 = ema(closes, 20), ema(closes, 50), ema(closes, 200)
    a14 = atr(candles, 14)
    r14 = rsi(candles, 14)
    adx14 = adx(candles, 14)
    piv_highs, piv_lows = detect_pivots(candles)
    latest = candles[-1] if candles else None
    if latest is None:
        return {"timeframe": timeframe, "error": "no candles"}
    return {
        "timeframe": timeframe,
        "bars": len(candles),
        "latest_closed_bar_time_utc": latest.open_time_utc,
        "latest_close": round_or_none(latest.close),
        "latest_high": round_or_none(latest.high),
        "latest_low": round_or_none(latest.low),
        "ema20": round_or_none(e20),
        "ema50": round_or_none(e50),
        "ema200": round_or_none(e200),
        "atr14": round_or_none(a14),
        "atr14_pct": round_or_none((a14 / latest.close * 100.0) if a14 and latest.close else None, 4),
        "rsi14": round_or_none(r14, 2),
        "adx14": round_or_none(adx14, 2),
        "volume_ratio_20": round_or_none(volume_ratio(candles, 20), 3),
        "trend_state": trend_state(latest.close, e20, e50, e200),
        "recent_pivot_highs": piv_highs,
        "recent_pivot_lows": piv_lows,
    }


def unique_sorted_levels(levels: Iterable[Dict[str, Any]], reverse: bool = False) -> List[Dict[str, Any]]:
    # Merge nearly identical prices by rounded value.
    seen: Dict[float, Dict[str, Any]] = {}
    for item in levels:
        price = item.get("price")
        if price is None:
            continue
        key = round(float(price), 6)
        if key not in seen:
            seen[key] = item
    return sorted(seen.values(), key=lambda x: float(x["price"]), reverse=reverse)


def build_levels(summaries: Dict[str, Dict[str, Any]], current_price: float) -> Dict[str, Any]:
    raw_supports: List[Dict[str, Any]] = []
    raw_resistances: List[Dict[str, Any]] = []
    atr4h = summaries.get("4H", {}).get("atr14") or summaries.get("1H", {}).get("atr14") or 0

    for tf, summ in summaries.items():
        for p in summ.get("recent_pivot_lows", []):
            price = float(p["price"])
            if price < current_price:
                raw_supports.append({
                    "price": price,
                    "source": f"{tf} pivot low",
                    "time_utc": p.get("time_utc"),
                    "distance_pct": (current_price - price) / current_price * 100.0,
                    "distance_atr": ((current_price - price) / atr4h) if atr4h else None,
                })
        for p in summ.get("recent_pivot_highs", []):
            price = float(p["price"])
            if price > current_price:
                raw_resistances.append({
                    "price": price,
                    "source": f"{tf} pivot high",
                    "time_utc": p.get("time_utc"),
                    "distance_pct": (price - current_price) / current_price * 100.0,
                    "distance_atr": ((price - current_price) / atr4h) if atr4h else None,
                })

    supports = unique_sorted_levels(raw_supports, reverse=True)[:10]
    resistances = unique_sorted_levels(raw_resistances, reverse=False)[:10]
    for coll in (supports, resistances):
        for item in coll:
            item["price"] = round_or_none(item["price"])
            item["distance_pct"] = round_or_none(item.get("distance_pct"), 3)
            item["distance_atr"] = round_or_none(item.get("distance_atr"), 3)
    return {"supports": supports, "resistances": resistances}


def nearest_tp(entry: float, side: str, resistances: List[Dict[str, Any]], supports: List[Dict[str, Any]], atr4h: float) -> float:
    side = side.upper()
    if side == "LONG":
        above = [float(x["price"]) for x in resistances if float(x["price"]) > entry]
        return min(above) if above else entry + max(atr4h * 1.5, entry * 0.02)
    below = [float(x["price"]) for x in supports if float(x["price"]) < entry]
    return max(below) if below else entry - max(atr4h * 1.5, entry * 0.02)


def build_candidate_trade_design(side: str, summaries: Dict[str, Dict[str, Any]], levels: Dict[str, Any], risk_usdt: float, max_margin_usdt: float) -> Dict[str, Any]:
    side = side.upper()
    current_price = float(summaries.get("4H", {}).get("latest_close") or summaries.get("1H", {}).get("latest_close"))
    atr4h = float(summaries.get("4H", {}).get("atr14") or current_price * 0.02)
    buffer = 0.25 * atr4h
    split = [0.25, 0.35, 0.40]

    supports = levels.get("supports", [])
    resistances = levels.get("resistances", [])

    def make_order(idx: int, entry: float, stop: float, tp: float, leg_risk: float) -> Dict[str, Any]:
        risk_per_unit = abs(entry - stop)
        qty = leg_risk / risk_per_unit if risk_per_unit > 0 else 0.0
        notional = qty * entry
        rr = abs(tp - entry) / risk_per_unit if risk_per_unit > 0 else None
        return {
            "leg": f"L{idx}",
            "entry": round_or_none(entry),
            "stop_loss": round_or_none(stop),
            "take_profit_candidate": round_or_none(tp),
            "allocated_risk_usdt": round_or_none(leg_risk, 2),
            "estimated_qty_before_exchange_rounding": round_or_none(qty, 6),
            "estimated_notional_usdt": round_or_none(notional, 2),
            "rr_estimate": round_or_none(rr, 2),
        }

    if side == "LONG":
        # Stop below meaningful 4H support/pivot. Prefer lower of recent 4H support candidates.
        support_prices = [float(x["price"]) for x in supports if float(x["price"]) < current_price]
        if support_prices:
            invalidation_base = min(support_prices[:5]) if len(support_prices) >= 2 else support_prices[0]
        else:
            invalidation_base = current_price - 1.5 * atr4h
        stop = invalidation_base - buffer

        entry_candidates = [p for p in support_prices if p > stop]
        # Add ATR bands if there are not enough structural levels.
        entry_candidates += [current_price - 0.4 * atr4h, current_price - 0.8 * atr4h, current_price - 1.2 * atr4h]
        entry_candidates = sorted({round(p, 6) for p in entry_candidates if stop < p < current_price}, reverse=True)
        entries = entry_candidates[:3]
        # If sorted descending gives shallow to deep, ok.
        orders = []
        for i, entry in enumerate(entries, start=1):
            tp = nearest_tp(entry, "LONG", resistances, supports, atr4h)
            orders.append(make_order(i, entry, stop, tp, risk_usdt * split[min(i - 1, 2)]))
        return {
            "side": "LONG",
            "style_hint": "DIP_LADDER",
            "current_price_reference": round_or_none(current_price),
            "atr4h_reference": round_or_none(atr4h),
            "stop_loss_candidate": round_or_none(stop),
            "invalidation_logic": "Below meaningful 4H/support pivot plus 0.25 ATR buffer",
            "candidate_orders": orders,
            "target_total_risk_usdt": risk_usdt,
            "max_margin_usdt": max_margin_usdt,
        }

    if side == "SHORT":
        resistance_prices = [float(x["price"]) for x in resistances if float(x["price"]) > current_price]
        if resistance_prices:
            invalidation_base = max(resistance_prices[:5]) if len(resistance_prices) >= 2 else resistance_prices[0]
        else:
            invalidation_base = current_price + 1.5 * atr4h
        stop = invalidation_base + buffer

        entry_candidates = [p for p in resistance_prices if p < stop]
        entry_candidates += [current_price + 0.4 * atr4h, current_price + 0.8 * atr4h, current_price + 1.2 * atr4h]
        entry_candidates = sorted({round(p, 6) for p in entry_candidates if current_price < p < stop})
        entries = entry_candidates[:3]
        orders = []
        for i, entry in enumerate(entries, start=1):
            tp = nearest_tp(entry, "SHORT", resistances, supports, atr4h)
            orders.append(make_order(i, entry, stop, tp, risk_usdt * split[min(i - 1, 2)]))
        return {
            "side": "SHORT",
            "style_hint": "SELL_RALLY",
            "current_price_reference": round_or_none(current_price),
            "atr4h_reference": round_or_none(atr4h),
            "stop_loss_candidate": round_or_none(stop),
            "invalidation_logic": "Above meaningful 4H/resistance pivot plus 0.25 ATR buffer",
            "candidate_orders": orders,
            "target_total_risk_usdt": risk_usdt,
            "max_margin_usdt": max_margin_usdt,
        }

    return {
        "side": side,
        "style_hint": "AUTO",
        "note": "No side supplied; LLM should infer from technical state and screener summary.",
        "target_total_risk_usdt": risk_usdt,
        "max_margin_usdt": max_margin_usdt,
    }


def copy_tv_exports(tv_export_dir: Optional[Path], raw_dir: Path) -> Dict[str, Any]:
    tv_summary: Dict[str, Any] = {"available": False, "files": [], "manifest": None}
    if not tv_export_dir or not tv_export_dir.exists():
        return tv_summary
    dest = ensure_dir(raw_dir / "tv_exports")
    for item in tv_export_dir.iterdir():
        if item.is_file():
            target = dest / item.name
            shutil.copy2(item, target)
            tv_summary["files"].append(str(target))
            if item.name.lower().endswith("manifest.json"):
                tv_summary["manifest"] = read_json(item, default=None)
    tv_summary["available"] = bool(tv_summary["files"])
    return tv_summary


def load_execution_state(execution_state_json: Optional[Path], raw_dir: Path) -> Dict[str, Any]:
    if execution_state_json and execution_state_json.exists():
        data = read_json(execution_state_json, default={})
        shutil.copy2(execution_state_json, raw_dir / "execution_state.json")
        return data
    data = {"available": False, "reason": "No authenticated execution-state source provided"}
    write_json(raw_dir / "execution_state.json", data)
    return data


def freshness_check(market_snapshot: Dict[str, Any], summaries: Dict[str, Dict[str, Any]], tv_summary: Dict[str, Any]) -> Dict[str, Any]:
    ticker = market_snapshot.get("ticker")
    current = None
    if isinstance(ticker, dict):
        # Bitget may return dict or list depending endpoint behavior.
        for key in ("lastPr", "last", "close", "markPrice"):
            if key in ticker:
                try:
                    current = float(ticker[key])
                    break
                except Exception:
                    pass
    elif isinstance(ticker, list) and ticker:
        t0 = ticker[0]
        if isinstance(t0, dict):
            for key in ("lastPr", "last", "close", "markPrice"):
                if key in t0:
                    try:
                        current = float(t0[key])
                        break
                    except Exception:
                        pass

    close4h = summaries.get("4H", {}).get("latest_close")
    diff_pct = None
    if current and close4h:
        diff_pct = abs(current - float(close4h)) / float(close4h) * 100.0
    status = "OK"
    notes = []
    if diff_pct is not None and diff_pct > 0.15:
        status = "PRICE_MOVED_FROM_4H_CLOSE"
        notes.append("Current ticker differs from latest 4H close by more than 0.15%.")
    if not tv_summary.get("available"):
        notes.append("No TradingView MCP exports copied; analysis can still use Bitget OHLCV but screenshots/TV validation are absent.")
    return {
        "status": status,
        "ticker_vs_4h_close_diff_pct": round_or_none(diff_pct, 4),
        "current_ticker_reference": round_or_none(current),
        "latest_4h_close": close4h,
        "tv_exports_available": bool(tv_summary.get("available")),
        "notes": notes,
        "checked_at_utc": utc_now_iso(),
    }


def make_llm_packet(path: Path, manifest: Dict[str, Any], analysis_summary: Dict[str, Any], market_snapshot: Dict[str, Any], execution_state: Dict[str, Any], files: Dict[str, Any]) -> None:
    def j(data: Any) -> str:
        return json.dumps(data, indent=2, ensure_ascii=False)

    content = f"""# LLM Input Packet — {manifest['symbol']}

This packet is generated for one manually selected symbol. Use it together with `prompts/master_trade_analysis_prompt.md`.

## 1. Manifest

```json
{j(manifest)}
```

## 2. Data priority reminder

1. Processed summary below is the primary compact analysis source.
2. Bitget OHLCV is the price/execution truth.
3. TradingView exports and screenshots are validation only.
4. Screener summary is candidate-selection context only.
5. If position/open-order data exists, it overrides new-ticket creation.

## 3. Processed analysis summary

```json
{j(analysis_summary)}
```

## 4. Market snapshot

```json
{j(market_snapshot)}
```

## 5. Execution state

```json
{j(execution_state)}
```

## 6. Raw evidence files

```json
{j(files)}
```

## 7. Required output

Follow the master prompt exactly, including:

- executive decision
- blind technical analysis
- levels/invalidation
- trade ticket table
- screener alignment check
- warnings
- data usage check
- final strict JSON ticket
"""
    path.write_text(content, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build a generic deep-analysis packet for one manually selected Bitget symbol.")
    p.add_argument("--symbol", required=True, help="Bitget API symbol, e.g. AAPLUSDT or AAPLUSDT.P")
    p.add_argument("--tv-symbol", default=None, help="TradingView symbol, e.g. BITGET:AAPLUSDT.P")
    p.add_argument("--side", default="AUTO", choices=["LONG", "SHORT", "AUTO"], help="User/screener selected side")
    p.add_argument("--family", default="AUTO", help="Screener family, e.g. LC, SC, BREAKOUT")
    p.add_argument("--score", type=float, default=None, help="Optional screener score/rank context")
    p.add_argument("--rank", type=int, default=None, help="Optional screener rank")
    p.add_argument("--screener-version", default=None)
    p.add_argument("--action-window-active", default=None, choices=["true", "false", "unknown", None])
    p.add_argument("--bars-since-trigger", type=int, default=None)
    p.add_argument("--invalidation-state", default=None)
    p.add_argument("--risk-usdt", type=float, default=100.0)
    p.add_argument("--max-margin-usdt", type=float, default=1500.0)
    p.add_argument("--bars-1d", type=int, default=400)
    p.add_argument("--bars-4h", type=int, default=500)
    p.add_argument("--bars-1h", type=int, default=500)
    p.add_argument("--include-15m", action="store_true")
    p.add_argument("--bars-15m", type=int, default=300)
    p.add_argument("--tv-export-dir", default=None, help="Folder containing MCP TradingView exports/screenshots to copy")
    p.add_argument("--execution-state-json", default=None, help="Optional authenticated position/open-order JSON")
    p.add_argument("--out-root", default="reports/deep_analysis_packets")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    symbol = api_symbol(args.symbol)
    tv_symbol = args.tv_symbol or f"BITGET:{symbol}.P"
    out_dir = ensure_dir(Path(args.out_root) / f"{local_stamp()}_{symbol}")
    raw_dir = ensure_dir(out_dir / "raw")
    derived_dir = ensure_dir(out_dir / "derived")

    manifest = {
        "symbol": symbol,
        "tv_symbol": tv_symbol,
        "side": args.side,
        "family": args.family,
        "score": args.score,
        "rank": args.rank,
        "risk_usdt": args.risk_usdt,
        "max_margin_usdt": args.max_margin_usdt,
        "created_at_local": datetime.now().replace(microsecond=0).isoformat(),
        "created_at_utc": utc_now_iso(),
        "timezone": "Europe/Berlin",
        "price_truth_source": "Bitget REST",
        "tv_export_source": "MCP files copied from --tv-export-dir" if args.tv_export_dir else "not provided",
        "screener_usage": "summary_only",
    }
    write_json(out_dir / "manifest.json", manifest)

    timeframes = [("1D", args.bars_1d), ("4H", args.bars_4h), ("1H", args.bars_1h)]
    if args.include_15m:
        timeframes.append(("15m", args.bars_15m))

    candles_by_tf: Dict[str, List[Candle]] = {}
    raw_files: Dict[str, Any] = {"bitget_ohlcv": {}, "tv_exports": [], "other": {}}
    for tf, limit in timeframes:
        candles = fetch_candles(symbol, tf, limit)
        candles_by_tf[tf] = candles
        csv_path = raw_dir / f"bitget_{symbol}_{tf}_ohlcv.csv"
        write_ohlcv_csv(csv_path, symbol, tf, candles)
        raw_files["bitget_ohlcv"][tf] = str(csv_path)

    market_snapshot = fetch_optional_market_snapshot(symbol)
    write_json(raw_dir / "market_snapshot.json", market_snapshot)
    raw_files["other"]["market_snapshot"] = str(raw_dir / "market_snapshot.json")

    tv_summary = copy_tv_exports(Path(args.tv_export_dir) if args.tv_export_dir else None, raw_dir)
    raw_files["tv_exports"] = tv_summary.get("files", [])

    execution_state = load_execution_state(Path(args.execution_state_json) if args.execution_state_json else None, raw_dir)
    raw_files["other"]["execution_state"] = str(raw_dir / "execution_state.json")

    summaries = {tf: summarize_timeframe(tf, candles) for tf, candles in candles_by_tf.items()}
    current_price = float(summaries.get("4H", {}).get("latest_close") or summaries.get("1H", {}).get("latest_close"))
    levels = build_levels(summaries, current_price)
    candidate_design = build_candidate_trade_design(args.side, summaries, levels, args.risk_usdt, args.max_margin_usdt)
    fresh = freshness_check(market_snapshot, summaries, tv_summary)

    screener_summary = {
        "screener_version": args.screener_version,
        "symbol": tv_symbol,
        "bias": args.side,
        "family": args.family,
        "score": args.score,
        "rank": args.rank,
        "action_window_active": args.action_window_active,
        "bars_since_trigger": args.bars_since_trigger,
        "invalidation_state": args.invalidation_state,
        "usage_note": "Screener is candidate-selection context only; do not use score as proof of trade quality.",
    }

    analysis_summary = {
        "symbol": symbol,
        "tv_symbol": tv_symbol,
        "side": args.side,
        "family": args.family,
        "risk_usdt": args.risk_usdt,
        "max_margin_usdt": args.max_margin_usdt,
        "timeframes": summaries,
        "levels": levels,
        "candidate_trade_design": candidate_design,
        "screener_summary": screener_summary,
        "freshness": fresh,
        "tv_exports_summary": tv_summary,
    }
    write_json(derived_dir / "analysis_summary.json", analysis_summary)
    write_json(derived_dir / "candidate_levels.json", {**levels, "candidate_trade_design": candidate_design})
    write_json(derived_dir / "freshness_check.json", fresh)

    raw_files["derived"] = {
        "analysis_summary": str(derived_dir / "analysis_summary.json"),
        "candidate_levels": str(derived_dir / "candidate_levels.json"),
        "freshness_check": str(derived_dir / "freshness_check.json"),
    }

    make_llm_packet(out_dir / "llm_input_packet.md", manifest, analysis_summary, market_snapshot, execution_state, raw_files)

    print(json.dumps({
        "packet_dir": str(out_dir),
        "llm_input_packet": str(out_dir / "llm_input_packet.md"),
        "analysis_summary": str(derived_dir / "analysis_summary.json"),
        "symbol": symbol,
        "side": args.side,
        "risk_usdt": args.risk_usdt,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
