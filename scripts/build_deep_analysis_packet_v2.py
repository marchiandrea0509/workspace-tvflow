#!/usr/bin/env python3
"""
Deep Analysis Packet Builder v2 — Bitget OHLCV-first, read-only.

Design decisions:
- User-selected screener symbol is context, not proof.
- No hard screener score threshold.
- Target planned risk remains 100 USDT by default.
- 1500 cap means max total notional, not max margin.
- Live execution is excluded; this script never places/cancels/modifies orders.
- Ladder entries must be plausible for the expected pullback, not simply deep supports.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import shutil
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

BITGET_BASE = "https://api.bitget.com"
PRODUCT_TYPE = "USDT-FUTURES"
DEFAULT_SCREENER_VERSION = "OC Hybrid Edge Screener v11.6.x"
TF_MS = {"1D": 86_400_000, "4H": 14_400_000, "1H": 3_600_000, "15m": 900_000}


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


def api_symbol(symbol: str) -> str:
    return symbol.upper().replace("BITGET:", "").replace(".P", "")


def bitget_get(endpoint: str, params: Dict[str, Any]) -> Dict[str, Any]:
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{BITGET_BASE}{endpoint}?{query}"
    req = urllib.request.Request(url, headers={"User-Agent": "OpenClaw-DeepAnalysisV2/1.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("code") not in (None, "00000"):
        raise RuntimeError(f"Bitget error at {endpoint}: {payload.get('code')} {payload.get('msg')}")
    return payload


def fetch_candles(symbol: str, granularity: str, limit: int, closed_only: bool = True) -> List[Candle]:
    payload = bitget_get(
        "/api/v2/mix/market/candles",
        {"symbol": api_symbol(symbol), "productType": PRODUCT_TYPE, "granularity": granularity, "limit": limit},
    )
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    tf_ms = TF_MS.get(granularity)
    candles: List[Candle] = []
    for row in payload.get("data") or []:
        ts = int(row[0])
        if closed_only and tf_ms and ts + tf_ms > now_ms:
            continue
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
        w.writerow(["symbol", "timeframe", "open_time_ms", "open_time_utc", "open", "high", "low", "close", "base_volume", "quote_volume"])
        for c in candles:
            w.writerow([symbol, timeframe, c.open_time_ms, c.open_time_utc, c.open, c.high, c.low, c.close, c.base_volume, c.quote_volume])


def fetch_market_snapshot(symbol: str) -> Dict[str, Any]:
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
        except Exception as exc:
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


def atr(candles: List[Candle], period: int = 14) -> Optional[float]:
    if len(candles) < period + 1:
        return None
    trs = []
    for i in range(1, len(candles)):
        c, prev = candles[i], candles[i - 1]
        trs.append(max(c.high - c.low, abs(c.high - prev.close), abs(c.low - prev.close)))
    return sum(trs[-period:]) / period if len(trs) >= period else None


def rsi(candles: List[Candle], period: int = 14) -> Optional[float]:
    if len(candles) < period + 1:
        return None
    gains, losses = [], []
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
    if len(candles) < period * 2 + 1:
        return None
    trs, plus_dm, minus_dm = [], [], []
    for i in range(1, len(candles)):
        cur, prev = candles[i], candles[i - 1]
        up = cur.high - prev.high
        down = prev.low - cur.low
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
        trs.append(max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close)))
    dxs = []
    for i in range(period, len(trs) + 1):
        tr = sum(trs[i - period:i])
        if tr == 0:
            continue
        pdi = 100 * sum(plus_dm[i - period:i]) / tr
        mdi = 100 * sum(minus_dm[i - period:i]) / tr
        denom = pdi + mdi
        if denom > 0:
            dxs.append(100 * abs(pdi - mdi) / denom)
    return sum(dxs[-period:]) / period if len(dxs) >= period else None


def pivots(candles: List[Candle], left: int = 3, right: int = 3, max_items: int = 10) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    highs, lows = [], []
    for i in range(left, len(candles) - right):
        win = candles[i - left:i + right + 1]
        c = candles[i]
        if c.high == max(x.high for x in win):
            highs.append({"time_utc": c.open_time_utc, "price": c.high})
        if c.low == min(x.low for x in win):
            lows.append({"time_utc": c.open_time_utc, "price": c.low})
    return highs[-max_items:], lows[-max_items:]


def volume_ratio(candles: List[Candle], period: int = 20) -> Optional[float]:
    vols = [c.quote_volume or c.base_volume for c in candles]
    if len(vols) < period + 1:
        return None
    avg = sum(vols[-period - 1:-1]) / period
    return None if avg == 0 else vols[-1] / avg


def rn(x: Optional[float], ndigits: int = 6) -> Optional[float]:
    if x is None or not math.isfinite(float(x)):
        return None
    return round(float(x), ndigits)


def trend_state(close: float, e20: Optional[float], e50: Optional[float], e200: Optional[float]) -> str:
    if e20 is None or e50 is None:
        return "unknown"
    if close > e20 > e50 and (e200 is None or close > e200):
        return "bullish"
    if close < e20 < e50 and (e200 is None or close < e200):
        return "bearish"
    return "neutral_mixed"


def summarize_tf(tf: str, candles: List[Candle]) -> Dict[str, Any]:
    if not candles:
        return {"timeframe": tf, "error": "no closed candles"}
    closes = [c.close for c in candles]
    e20, e50, e200 = ema(closes, 20), ema(closes, 50), ema(closes, 200)
    a14 = atr(candles, 14)
    ph, pl = pivots(candles)
    latest = candles[-1]
    return {
        "timeframe": tf,
        "bars": len(candles),
        "closed_candles_only": True,
        "latest_closed_bar_time_utc": latest.open_time_utc,
        "latest_close": rn(latest.close),
        "latest_high": rn(latest.high),
        "latest_low": rn(latest.low),
        "ema20": rn(e20),
        "ema50": rn(e50),
        "ema200": rn(e200),
        "atr14": rn(a14),
        "atr14_pct": rn((a14 / latest.close * 100.0) if a14 and latest.close else None, 4),
        "rsi14": rn(rsi(candles, 14), 2),
        "adx14": rn(adx(candles, 14), 2),
        "volume_ratio_20": rn(volume_ratio(candles, 20), 3),
        "trend_state": trend_state(latest.close, e20, e50, e200),
        "recent_pivot_highs": ph,
        "recent_pivot_lows": pl,
    }


def collect_levels(summaries: Dict[str, Dict[str, Any]], current: float) -> Dict[str, List[Dict[str, Any]]]:
    supports, resistances = [], []
    atr_ref = summaries.get("4H", {}).get("atr14") or summaries.get("1H", {}).get("atr14") or 0.0
    for tf, s in summaries.items():
        for p in s.get("recent_pivot_lows", []):
            price = float(p["price"])
            if price < current:
                supports.append({"price": price, "source": f"{tf} pivot low", "time_utc": p.get("time_utc")})
        for p in s.get("recent_pivot_highs", []):
            price = float(p["price"])
            if price > current:
                resistances.append({"price": price, "source": f"{tf} pivot high", "time_utc": p.get("time_utc")})
        for name in ("ema20", "ema50", "ema200"):
            val = s.get(name)
            if val:
                price = float(val)
                item = {"price": price, "source": f"{tf} {name}", "time_utc": s.get("latest_closed_bar_time_utc")}
                if price < current:
                    supports.append(item)
                elif price > current:
                    resistances.append(item)
    def finish(items: List[Dict[str, Any]], reverse: bool) -> List[Dict[str, Any]]:
        seen: Dict[float, Dict[str, Any]] = {}
        for item in items:
            key = round(float(item["price"]), 6)
            if key not in seen:
                price = float(item["price"])
                item["distance_pct"] = rn(abs(current - price) / current * 100.0, 3)
                item["distance_atr"] = rn(abs(current - price) / atr_ref, 3) if atr_ref else None
                seen[key] = item
        return sorted(seen.values(), key=lambda x: float(x["price"]), reverse=reverse)
    return {"supports": finish(supports, True), "resistances": finish(resistances, False)}


def first_contract(market_snapshot: Dict[str, Any]) -> Dict[str, Any]:
    specs = market_snapshot.get("contract_specs")
    if isinstance(specs, list) and specs:
        return specs[0] if isinstance(specs[0], dict) else {}
    if isinstance(specs, dict):
        data = specs.get("data")
        if isinstance(data, list) and data:
            return data[0]
        return specs
    return {}


def contract_rules(market_snapshot: Dict[str, Any]) -> Dict[str, Any]:
    c = first_contract(market_snapshot)
    def i(key: str, default: int) -> int:
        try:
            return int(c.get(key, default))
        except Exception:
            return default
    def f(key: str, default: float) -> float:
        try:
            return float(c.get(key, default))
        except Exception:
            return default
    return {
        "price_place": i("pricePlace", 4),
        "volume_place": i("volumePlace", 4),
        "size_multiplier": f("sizeMultiplier", 0.0),
        "min_trade_num": f("minTradeNum", 0.0),
        "min_trade_usdt": f("minTradeUSDT", 0.0),
        "raw": c,
    }


def round_price(price: float, rules: Dict[str, Any]) -> float:
    return round(float(price), int(rules.get("price_place", 4)))


def floor_qty(qty: float, rules: Dict[str, Any]) -> float:
    place = int(rules.get("volume_place", 4))
    step = float(rules.get("size_multiplier") or 10 ** (-place))
    if step <= 0:
        step = 10 ** (-place)
    floored = math.floor(float(qty) / step) * step
    return round(floored, place)


def nearest_tp(entry: float, side: str, levels: Dict[str, List[Dict[str, Any]]], stop: float, atr4h: float) -> Dict[str, Any]:
    risk_per_unit = abs(entry - stop)
    if side == "LONG":
        natural = [x for x in levels["resistances"] if float(x["price"]) > entry]
        if natural:
            p = float(natural[0]["price"])
            rr = (p - entry) / risk_per_unit if risk_per_unit else 0.0
            if rr >= 1.0:
                return {"price": p, "source": natural[0]["source"], "type": "natural_resistance", "rr": rr}
        p = entry + max(1.5 * risk_per_unit, 1.2 * atr4h)
        return {"price": p, "source": "projected_rr_target", "type": "projected_requires_follow_through", "rr": (p - entry) / risk_per_unit if risk_per_unit else None}
    natural = [x for x in levels["supports"] if float(x["price"]) < entry]
    if natural:
        p = float(natural[0]["price"])
        rr = (entry - p) / risk_per_unit if risk_per_unit else 0.0
        if rr >= 1.0:
            return {"price": p, "source": natural[0]["source"], "type": "natural_support", "rr": rr}
    p = entry - max(1.5 * risk_per_unit, 1.2 * atr4h)
    return {"price": p, "source": "projected_rr_target", "type": "projected_requires_follow_through", "rr": (entry - p) / risk_per_unit if risk_per_unit else None}


def classify_expected_pullback(side: str, family: str, summaries: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    atr4h = float(summaries.get("4H", {}).get("atr14") or summaries.get("1H", {}).get("atr14") or 0.0)
    close = float(summaries.get("4H", {}).get("latest_close") or summaries.get("1H", {}).get("latest_close"))
    fam = family.upper()
    # Pullback windows are deliberately conservative: avoid deep legs that need a regime change to fill.
    if fam in ("LC", "DIP", "DIP_LADDER", "AUTO"):
        return {
            "style": "DIP_LADDER" if side == "LONG" else "SELL_RALLY",
            "shallow_atr": 0.35,
            "normal_atr": 0.80,
            "deep_atr": 1.25,
            "max_leg_depth_atr": 1.80,
            "max_leg_depth_pct": 2.50,
            "atr4h": atr4h,
            "current_price": close,
            "logic": "Legs beyond 1.8x 4H ATR or 2.5% are omitted unless user explicitly wants deeper resting orders.",
        }
    if fam in ("BO", "BREAKOUT", "BREAKDOWN"):
        return {
            "style": "BREAKOUT" if side == "LONG" else "BREAKDOWN",
            "shallow_atr": -0.10,
            "normal_atr": 0.00,
            "deep_atr": 0.35,
            "max_leg_depth_atr": 0.80,
            "max_leg_depth_pct": 1.25,
            "atr4h": atr4h,
            "current_price": close,
            "logic": "Breakout plans should avoid deep passive legs; use trigger/near-trigger logic.",
        }
    return {
        "style": "AUTO",
        "shallow_atr": 0.35,
        "normal_atr": 0.80,
        "deep_atr": 1.25,
        "max_leg_depth_atr": 1.80,
        "max_leg_depth_pct": 2.50,
        "atr4h": atr4h,
        "current_price": close,
        "logic": "Default conservative pullback window.",
    }


def build_ladder(side: str, family: str, summaries: Dict[str, Dict[str, Any]], levels: Dict[str, List[Dict[str, Any]]], risk_usdt: float, max_notional: float, rules: Dict[str, Any]) -> Dict[str, Any]:
    side = side.upper()
    if side not in ("LONG", "SHORT"):
        return {"side": side, "decision_hint": "WAIT", "warnings": ["No LONG/SHORT side supplied; LLM must infer or ask for confirmation."], "target_risk_usdt": risk_usdt, "max_total_notional_usdt": max_notional}

    current = float(summaries.get("4H", {}).get("latest_close") or summaries.get("1H", {}).get("latest_close"))
    atr4h = float(summaries.get("4H", {}).get("atr14") or summaries.get("1H", {}).get("atr14") or 0.0)
    if atr4h <= 0:
        return {"side": side, "decision_hint": "WAIT", "warnings": ["ATR unavailable; cannot construct robust ladder."], "target_risk_usdt": risk_usdt, "max_total_notional_usdt": max_notional}

    pull = classify_expected_pullback(side, family, summaries)
    split = [0.25, 0.35, 0.40]
    warnings: List[str] = []
    omitted: List[Dict[str, Any]] = []

    if side == "LONG":
        supports = [x for x in levels["supports"] if float(x["price"]) < current]
        # Stop is below the nearest meaningful 4H support if available; otherwise 2 ATR below current.
        four_h_supports = [x for x in supports if str(x.get("source", "")).startswith("4H")]
        stop_base = float(four_h_supports[0]["price"]) if four_h_supports else current - 2.0 * atr4h
        stop = round_price(stop_base - 0.25 * atr4h, rules)
        raw_targets = [current - pull["shallow_atr"] * atr4h, current - pull["normal_atr"] * atr4h, current - pull["deep_atr"] * atr4h]
        # Prefer nearby structural supports/EMAs inside each expected pullback band.
        bands = [(0.15, 0.55), (0.55, 1.05), (1.05, pull["max_leg_depth_atr"])]
        entries = []
        for i, (lo, hi) in enumerate(bands):
            candidates = []
            for s in supports:
                depth_atr = (current - float(s["price"])) / atr4h
                depth_pct = (current - float(s["price"])) / current * 100.0
                if lo <= depth_atr <= hi and depth_pct <= pull["max_leg_depth_pct"]:
                    candidates.append((abs(depth_atr - [pull["shallow_atr"], pull["normal_atr"], pull["deep_atr"]][i]), float(s["price"]), s.get("source")))
                elif depth_atr > pull["max_leg_depth_atr"] or depth_pct > pull["max_leg_depth_pct"]:
                    omitted.append({**s, "reason": "too_deep_for_expected_pullback"})
            price = sorted(candidates)[0][1] if candidates else raw_targets[i]
            if stop < price < current:
                entries.append((f"L{i+1}", round_price(price, rules), "structure_or_expected_pullback" if candidates else "expected_pullback_atr"))
    else:
        resistances = [x for x in levels["resistances"] if float(x["price"]) > current]
        four_h_res = [x for x in resistances if str(x.get("source", "")).startswith("4H")]
        stop_base = float(four_h_res[0]["price"]) if four_h_res else current + 2.0 * atr4h
        stop = round_price(stop_base + 0.25 * atr4h, rules)
        raw_targets = [current + pull["shallow_atr"] * atr4h, current + pull["normal_atr"] * atr4h, current + pull["deep_atr"] * atr4h]
        bands = [(0.15, 0.55), (0.55, 1.05), (1.05, pull["max_leg_depth_atr"])]
        entries = []
        for i, (lo, hi) in enumerate(bands):
            candidates = []
            for r in resistances:
                depth_atr = (float(r["price"]) - current) / atr4h
                depth_pct = (float(r["price"]) - current) / current * 100.0
                if lo <= depth_atr <= hi and depth_pct <= pull["max_leg_depth_pct"]:
                    candidates.append((abs(depth_atr - [pull["shallow_atr"], pull["normal_atr"], pull["deep_atr"]][i]), float(r["price"]), r.get("source")))
                elif depth_atr > pull["max_leg_depth_atr"] or depth_pct > pull["max_leg_depth_pct"]:
                    omitted.append({**r, "reason": "too_deep_for_expected_pullback"})
            price = sorted(candidates)[0][1] if candidates else raw_targets[i]
            if current < price < stop:
                entries.append((f"L{i+1}", round_price(price, rules), "structure_or_expected_pullback" if candidates else "expected_pullback_atr"))

    if len(entries) < 2:
        warnings.append("Fewer than two plausible ladder entries inside the expected pullback window; this may be WAIT/conditional rather than a full ladder.")

    target_orders = []
    for idx, (leg, entry, source) in enumerate(entries[:3]):
        risk_alloc = risk_usdt * split[idx]
        risk_per_unit = abs(entry - stop)
        if risk_per_unit <= 0:
            warnings.append(f"{leg} has invalid entry/stop geometry.")
            continue
        qty_raw = risk_alloc / risk_per_unit
        qty = floor_qty(qty_raw, rules)
        tp = nearest_tp(entry, side, levels, stop, atr4h)
        tp_price = round_price(float(tp["price"]), rules)
        notional = qty * entry
        actual_risk = qty * risk_per_unit
        rr = abs(tp_price - entry) / risk_per_unit if risk_per_unit else None
        if rr is not None and rr < 1.0:
            warnings.append(f"{leg} natural/projected R:R is weak ({rr:.2f}); LLM should strongly warn or WAIT if no better target exists.")
        if qty <= 0 or qty < float(rules.get("min_trade_num") or 0):
            warnings.append(f"{leg} quantity is below Bitget minimum after rounding.")
        if notional < float(rules.get("min_trade_usdt") or 0):
            warnings.append(f"{leg} notional is below Bitget minTradeUSDT after rounding.")
        target_orders.append({
            "leg": leg,
            "order_type": "limit",
            "entry": entry,
            "entry_source": source,
            "qty_target_risk_before_notional_cap": rn(qty),
            "stop_loss": stop,
            "take_profit_candidate": tp_price,
            "take_profit_source": tp["source"],
            "allocated_target_risk_usdt": rn(risk_alloc, 2),
            "actual_risk_before_notional_cap_usdt": rn(actual_risk, 2),
            "notional_before_notional_cap_usdt": rn(notional, 2),
            "rr_estimate": rn(rr, 2),
        })

    total_notional = sum(float(o["notional_before_notional_cap_usdt"] or 0) for o in target_orders)
    target_risk_feasible_under_notional_cap = total_notional <= max_notional + 1e-9
    cap_adjusted_orders = []
    if not target_risk_feasible_under_notional_cap and total_notional > 0:
        scale = max_notional / total_notional
        warnings.append(f"Target 100 USDT risk exceeds max total notional {max_notional:.2f} USDT; cap-adjusted sizing is shown for feasibility, but this is a strong warning.")
        for o in target_orders:
            qty = floor_qty(float(o["qty_target_risk_before_notional_cap"] or 0) * scale, rules)
            entry = float(o["entry"])
            risk = qty * abs(entry - float(o["stop_loss"]))
            cap_adjusted_orders.append({**o, "qty_cap_adjusted": rn(qty), "notional_cap_adjusted_usdt": rn(qty * entry, 2), "actual_risk_cap_adjusted_usdt": rn(risk, 2)})

    if omitted:
        warnings.append("Some structural levels were omitted because they are too deep for the expected pullback window; this is intentional to avoid unrealistic resting legs.")

    return {
        "side": side,
        "style_hint": pull["style"],
        "current_price_reference": rn(current),
        "atr4h_reference": rn(atr4h),
        "expected_pullback_policy": pull,
        "stop_loss_candidate": stop,
        "invalidation_logic": "Shared SL beyond structural invalidation plus ATR buffer; entries constrained to plausible pullback depth.",
        "target_total_risk_usdt": risk_usdt,
        "max_total_notional_usdt": max_notional,
        "target_orders_before_notional_cap": target_orders,
        "target_total_notional_before_cap_usdt": rn(total_notional, 2),
        "target_risk_feasible_under_notional_cap": target_risk_feasible_under_notional_cap,
        "cap_adjusted_orders_if_needed": cap_adjusted_orders,
        "omitted_too_deep_levels_sample": omitted[:8],
        "warnings": warnings,
    }


def current_ticker_price(snapshot: Dict[str, Any]) -> Optional[float]:
    ticker = snapshot.get("ticker")
    items = ticker if isinstance(ticker, list) else [ticker] if isinstance(ticker, dict) else []
    for t in items:
        if isinstance(t, dict):
            for key in ("lastPr", "last", "close", "markPrice"):
                if key in t:
                    try:
                        return float(t[key])
                    except Exception:
                        pass
    return None


def freshness(snapshot: Dict[str, Any], summaries: Dict[str, Dict[str, Any]], tv_available: bool) -> Dict[str, Any]:
    cur = current_ticker_price(snapshot)
    close4h = summaries.get("4H", {}).get("latest_close")
    diff = abs(cur - float(close4h)) / float(close4h) * 100.0 if cur and close4h else None
    notes = []
    status = "OK"
    if diff is not None and diff > 0.15:
        status = "PRICE_MOVED_FROM_LAST_CLOSED_4H"
        notes.append("Ticker differs from latest closed 4H close by more than 0.15%.")
    if not tv_available:
        notes.append("No TradingView capture/export copied; Bitget OHLCV remains primary truth, visual validation absent.")
    return {"status": status, "ticker_vs_last_closed_4h_diff_pct": rn(diff, 4), "current_ticker_reference": rn(cur), "latest_closed_4h_close": close4h, "tv_exports_available": tv_available, "notes": notes, "checked_at_utc": utc_now_iso()}


def copy_tv_exports(tv_export_dir: Optional[Path], raw_dir: Path) -> Dict[str, Any]:
    out = {"available": False, "files": [], "manifest": None, "method_preference": "existing Playwright/browser capture unless TradingView Desktop MCP proves more robust/cheaper"}
    if not tv_export_dir or not tv_export_dir.exists():
        return out
    dest = ensure_dir(raw_dir / "tv_exports")
    for item in tv_export_dir.iterdir():
        if item.is_file():
            target = dest / item.name
            shutil.copy2(item, target)
            out["files"].append(str(target))
            if item.name.lower().endswith("manifest.json"):
                out["manifest"] = read_json(item, default=None)
    out["available"] = bool(out["files"])
    return out


def load_execution_state(execution_state_json: Optional[Path], raw_dir: Path) -> Dict[str, Any]:
    if execution_state_json and execution_state_json.exists():
        data = read_json(execution_state_json, default={})
        shutil.copy2(execution_state_json, raw_dir / "execution_state.json")
        data["usage_note"] = "Read-only context only; no live execution in deep-analysis round."
        return data
    data = {"available": False, "reason": "Execution state intentionally excluded unless supplied as read-only context", "usage_note": "Live execution is out of scope for deep analysis."}
    write_json(raw_dir / "execution_state.json", data)
    return data


def make_llm_packet(path: Path, master_prompt: str, manifest: Dict[str, Any], analysis_summary: Dict[str, Any], market_snapshot: Dict[str, Any], execution_state: Dict[str, Any], files: Dict[str, Any]) -> None:
    def j(x: Any) -> str:
        return json.dumps(x, indent=2, ensure_ascii=False)
    content = f"""# LLM Input Packet v2 — {manifest['symbol']}

Use this packet with `{master_prompt}`.

## 1. Manifest

```json
{j(manifest)}
```

## 2. Decision rules reminder

- Bitget OHLCV and processed summaries are primary truth.
- TradingView captures/exports are optional validation.
- Screener context is candidate-selection context only, not proof.
- No hard screener-score eligibility rule.
- Target planned risk is 100 USDT unless user supplied another value.
- Max cap is total notional, not margin: {manifest['max_total_notional_usdt']} USDT.
- If 100 USDT risk cannot fit structure/R:R/notional/freshness, give a strong warning or WAIT/NO_TRADE.
- Live execution is excluded; final JSON must keep `requires_user_confirmation: true`.

## 3. Processed analysis summary

```json
{j(analysis_summary)}
```

## 4. Market snapshot

```json
{j(market_snapshot)}
```

## 5. Execution state / read-only context

```json
{j(execution_state)}
```

## 6. Evidence files

```json
{j(files)}
```
"""
    path.write_text(content, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build a read-only Bitget OHLCV-first deep-analysis packet v2.")
    p.add_argument("--symbol", required=True, help="Bitget symbol, e.g. AAPLUSDT or BITGET:AAPLUSDT.P")
    p.add_argument("--tv-symbol", default=None)
    p.add_argument("--side", default="AUTO", choices=["LONG", "SHORT", "AUTO"])
    p.add_argument("--family", default="AUTO")
    p.add_argument("--score", type=float, default=None)
    p.add_argument("--rank", type=int, default=None)
    p.add_argument("--screener-version", default=DEFAULT_SCREENER_VERSION)
    p.add_argument("--risk-usdt", type=float, default=100.0)
    p.add_argument("--max-notional-usdt", type=float, default=1500.0)
    p.add_argument("--bars-1d", type=int, default=400)
    p.add_argument("--bars-4h", type=int, default=500)
    p.add_argument("--bars-1h", type=int, default=500)
    p.add_argument("--include-15m", action="store_true")
    p.add_argument("--bars-15m", type=int, default=300)
    p.add_argument("--tv-export-dir", default=None)
    p.add_argument("--execution-state-json", default=None, help="Optional read-only account/order context JSON")
    p.add_argument("--out-root", default="reports/deep_analysis_packets_v2")
    p.add_argument("--master-prompt", default="prompts/master_trade_analysis_prompt_v2.md")
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
        "screener_version": args.screener_version,
        "risk_usdt_target": args.risk_usdt,
        "max_total_notional_usdt": args.max_notional_usdt,
        "created_at_local": datetime.now().replace(microsecond=0).isoformat(),
        "created_at_utc": utc_now_iso(),
        "timezone": "Europe/Berlin",
        "price_truth_source": "Bitget REST closed OHLCV candles",
        "tv_export_source": "files copied from --tv-export-dir" if args.tv_export_dir else "not provided",
        "screener_usage": "summary_only_no_score_threshold",
        "live_execution_scope": "excluded_requires_separate_explicit_user_request",
    }
    write_json(out_dir / "manifest.json", manifest)

    timeframes = [("1D", args.bars_1d), ("4H", args.bars_4h), ("1H", args.bars_1h)]
    if args.include_15m:
        timeframes.append(("15m", args.bars_15m))

    candles_by_tf: Dict[str, List[Candle]] = {}
    files: Dict[str, Any] = {"bitget_ohlcv": {}, "tv_exports": [], "other": {}, "derived": {}}
    for tf, limit in timeframes:
        candles = fetch_candles(symbol, tf, limit, closed_only=True)
        candles_by_tf[tf] = candles
        csv_path = raw_dir / f"bitget_{symbol}_{tf}_closed_ohlcv.csv"
        write_ohlcv_csv(csv_path, symbol, tf, candles)
        files["bitget_ohlcv"][tf] = str(csv_path)

    market_snapshot = fetch_market_snapshot(symbol)
    write_json(raw_dir / "market_snapshot.json", market_snapshot)
    files["other"]["market_snapshot"] = str(raw_dir / "market_snapshot.json")

    tv_summary = copy_tv_exports(Path(args.tv_export_dir) if args.tv_export_dir else None, raw_dir)
    files["tv_exports"] = tv_summary.get("files", [])

    execution_state = load_execution_state(Path(args.execution_state_json) if args.execution_state_json else None, raw_dir)
    files["other"]["execution_state"] = str(raw_dir / "execution_state.json")

    summaries = {tf: summarize_tf(tf, candles) for tf, candles in candles_by_tf.items()}
    current = float(summaries.get("4H", {}).get("latest_close") or summaries.get("1H", {}).get("latest_close"))
    levels = collect_levels(summaries, current)
    rules = contract_rules(market_snapshot)
    ladder = build_ladder(args.side, args.family, summaries, levels, args.risk_usdt, args.max_notional_usdt, rules)
    fresh = freshness(market_snapshot, summaries, bool(tv_summary.get("available")))

    screener_summary = {
        "screener_version": args.screener_version,
        "symbol": tv_symbol,
        "bias": args.side,
        "family": args.family,
        "score": args.score,
        "rank": args.rank,
        "usage_note": "Candidate-selection context only. No hard score threshold; target 100 USDT risk by default, warn if trade quality/constraints are weak.",
    }

    analysis_summary = {
        "symbol": symbol,
        "tv_symbol": tv_symbol,
        "side": args.side,
        "family": args.family,
        "risk_usdt_target": args.risk_usdt,
        "max_total_notional_usdt": args.max_notional_usdt,
        "contract_rules": rules,
        "timeframes": summaries,
        "levels": levels,
        "candidate_trade_design": ladder,
        "screener_summary": screener_summary,
        "freshness": fresh,
        "tv_exports_summary": tv_summary,
    }
    write_json(derived_dir / "analysis_summary.json", analysis_summary)
    write_json(derived_dir / "candidate_levels.json", {**levels, "candidate_trade_design": ladder})
    write_json(derived_dir / "freshness_check.json", fresh)
    files["derived"] = {
        "analysis_summary": str(derived_dir / "analysis_summary.json"),
        "candidate_levels": str(derived_dir / "candidate_levels.json"),
        "freshness_check": str(derived_dir / "freshness_check.json"),
    }

    make_llm_packet(out_dir / "llm_input_packet.md", args.master_prompt, manifest, analysis_summary, market_snapshot, execution_state, files)
    print(json.dumps({"packet_dir": str(out_dir), "llm_input_packet": str(out_dir / "llm_input_packet.md"), "analysis_summary": str(derived_dir / "analysis_summary.json"), "symbol": symbol, "side": args.side, "risk_usdt_target": args.risk_usdt, "max_total_notional_usdt": args.max_notional_usdt}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
