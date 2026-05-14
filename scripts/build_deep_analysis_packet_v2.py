#!/usr/bin/env python3
"""
Deep Analysis Packet Builder v2 - screenshot-first Bitget deep analysis, read-only.

Design decisions:
- User-selected screener symbol is context, not proof.
- No hard screener score threshold.
- Target planned risk remains 100 USDT by default.
- 1500 cap means max margin at the planned leverage, not max total notional.
- Live execution is excluded; this script never places/cancels/modifies orders.
- Ladder entries must be plausible for the expected pullback, not simply deep supports.
- --screener-data-file accepts TradingView Screener/strategy-test CSV or JSON exports.
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
    # PowerShell-created JSON can include a UTF-8 BOM on Windows.
    return json.loads(path.read_text(encoding="utf-8-sig"))


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


def as_float(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if value in (None, "", "NaN", "nan"):
            return default
        return float(value)
    except Exception:
        return default


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
            elif price > current:
                # A prior pivot low above current can act as overhead supply/resistance after price loses it.
                resistances.append({"price": price, "source": f"{tf} prior pivot low resistance", "time_utc": p.get("time_utc")})
        for p in s.get("recent_pivot_highs", []):
            price = float(p["price"])
            if price > current:
                resistances.append({"price": price, "source": f"{tf} pivot high", "time_utc": p.get("time_utc")})
            elif price < current:
                # Prior highs below current are valid support / breakout retest levels.
                supports.append({"price": price, "source": f"{tf} prior pivot high support", "time_utc": p.get("time_utc")})
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
            scored = []
            for x in natural:
                p = float(x["price"])
                rr = (p - entry) / risk_per_unit if risk_per_unit else 0.0
                scored.append((rr, p, x))
            good = [t for t in scored if t[0] >= 1.20]
            if good:
                # Use the first meaningful natural resistance with acceptable R:R.
                rr, p, x = sorted(good, key=lambda t: t[1])[0]
                return {"price": p, "source": x["source"], "type": "natural_resistance", "rr": rr}
            # Do not hide poor R:R by inventing an optimistic projected target when
            # natural resistance is visible. Surface the weak natural target instead.
            rr, p, x = max(scored, key=lambda t: t[0])
            return {"price": p, "source": x["source"], "type": "natural_resistance_weak_rr", "rr": rr}
        p = entry + max(1.5 * risk_per_unit, 1.2 * atr4h)
        return {"price": p, "source": "projected_rr_target", "type": "projected_requires_follow_through", "rr": (p - entry) / risk_per_unit if risk_per_unit else None}
    natural = [x for x in levels["supports"] if float(x["price"]) < entry]
    if natural:
        scored = []
        for x in natural:
            p = float(x["price"])
            rr = (entry - p) / risk_per_unit if risk_per_unit else 0.0
            scored.append((rr, p, x))
        good = [t for t in scored if t[0] >= 1.20]
        if good:
            rr, p, x = sorted(good, key=lambda t: t[1], reverse=True)[0]
            return {"price": p, "source": x["source"], "type": "natural_support", "rr": rr}
        rr, p, x = max(scored, key=lambda t: t[0])
        return {"price": p, "source": x["source"], "type": "natural_support_weak_rr", "rr": rr}
    p = entry - max(1.5 * risk_per_unit, 1.2 * atr4h)
    return {"price": p, "source": "projected_rr_target", "type": "projected_requires_follow_through", "rr": (entry - p) / risk_per_unit if risk_per_unit else None}


def classify_expected_pullback(side: str, family: str, summaries: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    atr4h = float(summaries.get("4H", {}).get("atr14") or summaries.get("1H", {}).get("atr14") or 0.0)
    close = float(summaries.get("4H", {}).get("latest_close") or summaries.get("1H", {}).get("latest_close"))
    fam = family.upper()
    # LC/DIP ladders can legitimately use deeper structural supports.  Do not reject
    # a deep level merely because price is currently near resistance; reject/flag it
    # only when it implies a likely change of character, unacceptable SL-hit risk, or
    # broken trend structure.
    if fam in ("LC", "DIP", "DIP_LADDER", "AUTO"):
        return {
            "style": "DIP_LADDER" if side == "LONG" else "SELL_RALLY",
            "shallow_atr": 0.35,
            "normal_atr": 0.80,
            "deep_atr": 5.50,
            "max_leg_depth_atr": 6.00,
            "max_leg_depth_pct": 6.25,
            "atr4h": atr4h,
            "current_price": close,
            "logic": "LC/DIP ladders may include deeper structural support; omit only for change-of-character/SL-hit/trend-risk reasons, not simply because current price is near resistance.",
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
        "deep_atr": 5.50,
        "max_leg_depth_atr": 6.00,
        "max_leg_depth_pct": 6.25,
        "atr4h": atr4h,
        "current_price": close,
        "logic": "Default pullback window allows meaningful structural legs; rejection should cite CHoCH/trend-risk/SL-hit risk/R:R, not resistance alone.",
    }


def structure_risk_diagnostics(side: str, summaries: Dict[str, Dict[str, Any]], levels: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    """Cheap structure/CHoCH proxy for deciding whether rejecting a ladder is meaningful.

    This is intentionally explainable rather than predictive: it flags when a pullback
    would likely be normal trend retest vs. a probable character change.
    """
    side = side.upper()
    tf4 = summaries.get("4H", {})
    tf1 = summaries.get("1H", {})
    close = float(tf4.get("latest_close") or tf1.get("latest_close") or 0.0)
    atr4h = float(tf4.get("atr14") or tf1.get("atr14") or 0.0)
    ema20 = tf4.get("ema20")
    ema50 = tf4.get("ema50")
    ema200 = tf4.get("ema200")
    trend = tf4.get("trend_state")
    rsi4h = tf4.get("rsi14")
    adx4h = tf4.get("adx14")

    supports = levels.get("supports", [])
    resistances = levels.get("resistances", [])
    four_h_lows = [float(x["price"]) for x in supports if str(x.get("source", "")) == "4H pivot low"]
    four_h_highs = [float(x["price"]) for x in resistances if str(x.get("source", "")) == "4H pivot high"]

    if side == "LONG":
        key_structure = max(four_h_lows) if four_h_lows else None
        choch_level = key_structure
        if key_structure is not None and atr4h:
            danger_zone = key_structure - 0.5 * atr4h
        else:
            danger_zone = None
        choch_triggered = bool(key_structure is not None and close < key_structure)
        trend_degraded = bool(ema20 and ema50 and close < float(ema50) and float(ema20) < float(ema50))
        reasons = []
        if choch_triggered:
            reasons.append("latest 4H close is below the most recent 4H swing-low support")
        if trend_degraded:
            reasons.append("4H close/EMA stack has degraded below EMA50")
    else:
        key_structure = min(four_h_highs) if four_h_highs else None
        choch_level = key_structure
        danger_zone = key_structure + 0.5 * atr4h if key_structure is not None and atr4h else None
        choch_triggered = bool(key_structure is not None and close > key_structure)
        trend_degraded = bool(ema20 and ema50 and close > float(ema50) and float(ema20) > float(ema50))
        reasons = []
        if choch_triggered:
            reasons.append("latest 4H close is above the most recent 4H swing-high resistance")
        if trend_degraded:
            reasons.append("4H close/EMA stack has degraded above EMA50 against the short")

    if not reasons:
        reasons.append("no decisive 4H change-of-character proxy detected")

    return {
        "side": side,
        "trend_state_4h": trend,
        "rsi14_4h": rsi4h,
        "adx14_4h": adx4h,
        "ema20_4h": ema20,
        "ema50_4h": ema50,
        "ema200_4h": ema200,
        "choch_reference_level": rn(choch_level),
        "sl_hit_danger_zone": rn(danger_zone),
        "choch_triggered_now": choch_triggered,
        "trend_degraded_now": trend_degraded,
        "ladder_rejection_guidance": "Do not reject LC/DIP solely because price is near resistance or RSI is high. Stronger rejection needs CHoCH, degraded trend, stale data, poor R:R, liquidity/fee issue, or high probability of stop hit before a realistic TP.",
        "reasons": reasons,
    }



def build_ladder(side: str, family: str, summaries: Dict[str, Dict[str, Any]], levels: Dict[str, List[Dict[str, Any]]], risk_usdt: float, max_margin: float, planned_leverage: float, rules: Dict[str, Any], screener_data: Optional[Dict[str, Any]] = None, current_price_reference: Optional[float] = None) -> Dict[str, Any]:
    """Build a static OC 4H pullback ladder ticket.

    The ladder is intentionally static: all entries, quantities, SLs and TPs must be
    valid at order creation. It must not rely on later cancellation, SL movement,
    trailing stops, or post-fill management to keep risk near the target.
    """
    side = side.upper()
    if side not in ("LONG", "SHORT"):
        return {"side": side, "decision_hint": "NO_TRADE", "warnings": ["No LONG/SHORT side supplied; cannot construct static 4H ladder."], "target_risk_usdt": risk_usdt, "max_margin_usdt": max_margin, "planned_leverage": planned_leverage, "max_effective_notional_usdt": rn(max_margin * planned_leverage, 2)}

    closed_current = float(summaries.get("4H", {}).get("latest_close") or summaries.get("1H", {}).get("latest_close"))
    current = float(current_price_reference or closed_current)
    tf4 = summaries.get("4H", {})
    atr4h = float(tf4.get("atr14") or summaries.get("1H", {}).get("atr14") or 0.0)
    max_effective_notional = max_margin * planned_leverage
    warnings: List[str] = []
    omitted: List[Dict[str, Any]] = []
    screener_row = (screener_data or {}).get("selected_row") or {}

    if atr4h <= 0:
        return {"side": side, "decision_hint": "NO_TRADE", "warnings": ["ATR(14) unavailable; cannot construct robust static 4H ladder."], "target_risk_usdt": risk_usdt, "max_margin_usdt": max_margin, "planned_leverage": planned_leverage, "max_effective_notional_usdt": rn(max_effective_notional, 2)}

    def parse_time_ms(value: Any) -> int:
        try:
            text = str(value or "").replace("Z", "+00:00")
            return int(datetime.fromisoformat(text).timestamp() * 1000)
        except Exception:
            return 0

    def pivot_list(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        out = []
        for item in items or []:
            try:
                out.append({"price": float(item["price"]), "time_utc": item.get("time_utc"), "time_ms": parse_time_ms(item.get("time_utc"))})
            except Exception:
                continue
        return sorted(out, key=lambda x: int(x.get("time_ms") or 0))

    def find_impulse() -> Dict[str, Any]:
        highs = pivot_list(tf4.get("recent_pivot_highs", []))
        lows = pivot_list(tf4.get("recent_pivot_lows", []))
        min_range = 1.2 * atr4h
        if side == "LONG":
            latest_high_price = max(
                current,
                as_float(tf4.get("latest_high"), current) or current,
                as_float(summaries.get("1H", {}).get("latest_high"), current) or current,
            )
            latest_pivot_high = highs[-1] if highs else None
            bullish_ok = str(tf4.get("trend_state") or "") in ("bullish", "neutral_mixed")
            if latest_pivot_high and bullish_ok and latest_high_price >= float(latest_pivot_high["price"]) + 0.75 * atr4h:
                low_candidates: List[Dict[str, Any]] = []
                pivot_high_time = int(latest_pivot_high.get("time_ms") or 0)
                lower_bound = float(latest_pivot_high["price"]) - 3.0 * atr4h
                for low in lows:
                    if int(low.get("time_ms") or 0) < pivot_high_time and lower_bound <= float(low["price"]) < float(latest_pivot_high["price"]):
                        low_candidates.append({**low, "source": "latest 4H pivot low before breakout"})
                # Include the structural base immediately below the prior pivot high (EMA/support cluster,
                # prior resistance turned support).  This prevents fresh breakouts from anchoring to a
                # tiny already-confirmed pivot high instead of the active breakout high.
                for item in levels.get("supports", [])[:24]:
                    try:
                        p = float(item["price"])
                    except Exception:
                        continue
                    src = str(item.get("source") or "")
                    structural = any(token in src for token in ("4H", "1H", "1D", "ema", "prior pivot high", "pivot low"))
                    if structural and lower_bound <= p < float(latest_pivot_high["price"]):
                        low_candidates.append({"price": p, "time_utc": item.get("time_utc"), "time_ms": parse_time_ms(item.get("time_utc")), "source": src})
                if low_candidates:
                    # Prefer the lower edge of the local breakout base, but only within the recent
                    # 3 ATR breakout shelf. For AAPL-like fresh breakouts this selects the 4H/1H
                    # support base around 290.5/291.5 rather than the tiny old 293 value zone or
                    # stale historical lows.
                    base = min(low_candidates, key=lambda x: float(x["price"]))
                    rng = latest_high_price - float(base["price"])
                    if rng >= min_range:
                        return {
                            "valid": True,
                            "side": side,
                            "mode": "ACTIVE_BREAKOUT_UNCONFIRMED_HIGH",
                            "impulse_low": rn(base["price"]),
                            "impulse_low_time_utc": base.get("time_utc"),
                            "impulse_low_source": base.get("source"),
                            "impulse_high": rn(latest_high_price),
                            "impulse_high_time_utc": "active/live_or_latest_high",
                            "confirmed_pivot_high": rn(float(latest_pivot_high["price"])),
                            "breakout_above_confirmed_pivot_atr": rn((latest_high_price - float(latest_pivot_high["price"])) / atr4h, 3),
                            "range": rn(rng),
                            "range_atr": rn(rng / atr4h, 3),
                            "minimum_required_range": rn(min_range),
                        }
            for high in reversed(highs):
                lows_before = [x for x in lows if int(x["time_ms"]) < int(high["time_ms"]) and float(x["price"]) < float(high["price"])]
                for low in reversed(lows_before):
                    rng = float(high["price"]) - float(low["price"])
                    if rng >= min_range:
                        return {"valid": True, "side": side, "impulse_low": rn(low["price"]), "impulse_low_time_utc": low.get("time_utc"), "impulse_high": rn(high["price"]), "impulse_high_time_utc": high.get("time_utc"), "range": rn(rng), "range_atr": rn(rng / atr4h, 3), "minimum_required_range": rn(min_range)}
            return {"valid": False, "side": side, "reason": "No recent 4H bullish pivot-low -> pivot-high impulse >= 1.2 ATR found."}
        latest_low_price = min(
            current,
            as_float(tf4.get("latest_low"), current) or current,
            as_float(summaries.get("1H", {}).get("latest_low"), current) or current,
        )
        latest_pivot_low = lows[-1] if lows else None
        bearish_ok = str(tf4.get("trend_state") or "") in ("bearish", "neutral_mixed")
        if latest_pivot_low and bearish_ok and latest_low_price <= float(latest_pivot_low["price"]) - 0.75 * atr4h:
            high_candidates: List[Dict[str, Any]] = []
            pivot_low_time = int(latest_pivot_low.get("time_ms") or 0)
            for high in highs:
                if int(high.get("time_ms") or 0) < pivot_low_time and float(high["price"]) > float(latest_pivot_low["price"]):
                    high_candidates.append({**high, "source": "latest 4H pivot high before breakdown"})
            upper_bound = float(latest_pivot_low["price"]) + 3.0 * atr4h
            for item in levels.get("resistances", [])[:24]:
                try:
                    p = float(item["price"])
                except Exception:
                    continue
                src = str(item.get("source") or "")
                structural = any(token in src for token in ("4H", "1H", "1D", "ema", "prior pivot low", "pivot high"))
                if structural and float(latest_pivot_low["price"]) < p <= upper_bound:
                    high_candidates.append({"price": p, "time_utc": item.get("time_utc"), "time_ms": parse_time_ms(item.get("time_utc")), "source": src})
            if high_candidates:
                base = max(high_candidates, key=lambda x: float(x["price"]))
                rng = float(base["price"]) - latest_low_price
                if rng >= min_range:
                    return {
                        "valid": True,
                        "side": side,
                        "mode": "ACTIVE_BREAKOUT_UNCONFIRMED_LOW",
                        "impulse_high": rn(base["price"]),
                        "impulse_high_time_utc": base.get("time_utc"),
                        "impulse_high_source": base.get("source"),
                        "impulse_low": rn(latest_low_price),
                        "impulse_low_time_utc": "active/live_or_latest_low",
                        "confirmed_pivot_low": rn(float(latest_pivot_low["price"])),
                        "breakdown_below_confirmed_pivot_atr": rn((float(latest_pivot_low["price"]) - latest_low_price) / atr4h, 3),
                        "range": rn(rng),
                        "range_atr": rn(rng / atr4h, 3),
                        "minimum_required_range": rn(min_range),
                    }
        for low in reversed(lows):
            highs_before = [x for x in highs if int(x["time_ms"]) < int(low["time_ms"]) and float(x["price"]) > float(low["price"])]
            for high in reversed(highs_before):
                rng = float(high["price"]) - float(low["price"])
                if rng >= min_range:
                    return {"valid": True, "side": side, "impulse_high": rn(high["price"]), "impulse_high_time_utc": high.get("time_utc"), "impulse_low": rn(low["price"]), "impulse_low_time_utc": low.get("time_utc"), "range": rn(rng), "range_atr": rn(rng / atr4h, 3), "minimum_required_range": rn(min_range)}
        return {"valid": False, "side": side, "reason": "No recent 4H bearish pivot-high -> pivot-low impulse >= 1.2 ATR found."}

    def screener_lc_action_inactive() -> bool:
        if not screener_row:
            return False
        action = as_float(screener_row.get("W01 LC ActionScore"), 0.0) or 0.0
        window = as_float(screener_row.get("W02 LC WindowActive"), 0.0) or 0.0
        entry_state = as_float(screener_row.get("W03 LC EntryState"), 0.0) or 0.0
        return action <= 0 and window <= 0 and entry_state <= 0

    nearest_res_atr = levels.get("resistances", [{}])[0].get("distance_atr") if levels.get("resistances") else None
    nearest_sup_atr = levels.get("supports", [{}])[0].get("distance_atr") if levels.get("supports") else None
    near_major_resistance = bool(side == "LONG" and nearest_res_atr is not None and float(nearest_res_atr) <= 0.25)
    near_major_support = bool(side == "SHORT" and nearest_sup_atr is not None and float(nearest_sup_atr) <= 0.25)
    rsi4h = as_float(tf4.get("rsi14"), 0.0) or 0.0
    hot_or_at_resistance = bool(side == "LONG" and (rsi4h >= 75 or (nearest_res_atr is not None and float(nearest_res_atr) <= 1.0)))
    cold_or_at_support = bool(side == "SHORT" and (rsi4h <= 25 or (nearest_sup_atr is not None and float(nearest_sup_atr) <= 1.0)))

    if screener_lc_action_inactive() and side == "LONG":
        warnings.append("Screener LC action/window fields are inactive; static ladder must rely on 4H impulse/value-zone structure, not near-market noise.")
    if hot_or_at_resistance:
        warnings.append("Price is hot/near resistance; L1 must be a genuine 4H pullback level and the final verdict may be WAIT if R:R is weak.")
    if cold_or_at_support:
        warnings.append("Price is cold/near support; S1 must be a genuine 4H sell-rally level and the final verdict may be WAIT if R:R is weak.")

    pull = classify_expected_pullback(side, family, summaries)
    structure_risk = structure_risk_diagnostics(side, summaries, levels)
    impulse = find_impulse()
    trend = str(tf4.get("trend_state") or "unknown")
    hard_reject_reasons: List[str] = []
    if not impulse.get("valid"):
        hard_reject_reasons.append(str(impulse.get("reason")))
    if side == "LONG" and trend == "bearish":
        hard_reject_reasons.append("4H trend is bearish; DIP_LADDER long requires bullish or bullish-neutral 4H structure.")
    if side == "SHORT" and trend == "bullish":
        hard_reject_reasons.append("4H trend is bullish; SELL_RALLY short requires bearish or bearish-neutral 4H structure.")
    if near_major_resistance:
        warnings.append("Current price is very close to detected resistance (<0.25 ATR); static long ladder should usually WAIT unless entries are clearly in the value zone.")
    if near_major_support:
        warnings.append("Current price is very close to detected support (<0.25 ATR); static short ladder should usually WAIT unless entries are clearly in the value zone.")

    def empty_result(decision: str) -> Dict[str, Any]:
        return {
            "side": side,
            "style_hint": "DIP_LADDER" if side == "LONG" else "SELL_RALLY",
            "decision_hint": decision,
            "current_price_reference": rn(current),
            "atr4h_reference": rn(atr4h),
            "expected_pullback_policy": pull,
            "oc_static_ladder_rules": {
                "version": "OC_4H_PULLBACK_LADDER_STATIC_V1",
                "static_only": True,
                "no_dynamic_management": True,
                "max_legs": 3,
                "risk_split_policy": "3 legs 25/35/40; 2 legs 40/60; split by risk, not quantity",
                "spacing_min_atr": 0.25,
                "spacing_ideal_atr": "0.30-0.60",
                "sl_buffer_atr": "0.25-0.50",
            },
            "impulse_analysis_4h": impulse,
            "value_zone": None,
            "stop_loss_candidate": None,
            "invalidation_logic": "No static ladder: invalid/missing 4H impulse or trend context.",
            "structure_risk_diagnostics": structure_risk,
            "target_total_risk_usdt": risk_usdt,
            "max_margin_usdt": max_margin,
            "planned_leverage": planned_leverage,
            "max_effective_notional_usdt": rn(max_effective_notional, 2),
            "target_orders_before_margin_cap": [],
            "target_total_notional_before_cap_usdt": 0.0,
            "target_estimated_margin_before_cap_usdt": 0.0,
            "target_actual_risk_before_cap_usdt": 0.0,
            "target_reward_before_cap_usdt": 0.0,
            "target_blended_entry": None,
            "target_blended_rr": None,
            "target_risk_feasible_under_margin_cap": True,
            "cap_adjusted_orders_if_needed": [],
            "omitted_too_deep_levels_sample": omitted[:8],
            "static_ticket_safe": False,
            "static_ticket_reject_reasons": hard_reject_reasons,
            "warnings": warnings + hard_reject_reasons,
        }

    if hard_reject_reasons:
        return empty_result("NO_TRADE")

    impulse_low = float(impulse["impulse_low"])
    impulse_high = float(impulse["impulse_high"])
    impulse_range = abs(impulse_high - impulse_low)
    if side == "LONG":
        fibs = {
            "38.2": impulse_high - 0.382 * impulse_range,
            "50.0": impulse_high - 0.500 * impulse_range,
            "61.8": impulse_high - 0.618 * impulse_range,
        }
        value_zone_low, value_zone_high = fibs["61.8"], fibs["38.2"]
        structural_side = levels.get("supports", [])
        tp_side = levels.get("resistances", [])
    else:
        fibs = {
            "38.2": impulse_low + 0.382 * impulse_range,
            "50.0": impulse_low + 0.500 * impulse_range,
            "61.8": impulse_low + 0.618 * impulse_range,
        }
        value_zone_low, value_zone_high = fibs["38.2"], fibs["61.8"]
        structural_side = levels.get("resistances", [])
        tp_side = levels.get("supports", [])

    value_zone_width_atr = abs(value_zone_high - value_zone_low) / atr4h if atr4h else None
    value_zone = {
        "basis": "latest valid 4H impulse fib pullback zone",
        "impulse_mode": impulse.get("mode", "CONFIRMED_PIVOT_IMPULSE"),
        "impulse_low": rn(impulse_low),
        "impulse_high": rn(impulse_high),
        "fib_38_2": rn(fibs["38.2"]),
        "fib_50_0": rn(fibs["50.0"]),
        "fib_61_8": rn(fibs["61.8"]),
        "zone_low": rn(min(value_zone_low, value_zone_high)),
        "zone_high": rn(max(value_zone_low, value_zone_high)),
        "zone_width_atr": rn(value_zone_width_atr, 3),
    }

    def source_quality(source: str) -> int:
        s = str(source or "")
        if "4H pivot" in s:
            return 0
        if "4H ema50" in s or "4H ema20" in s:
            return 1
        if "1H ema200" in s:
            return 2
        if "1D ema20" in s or "1D ema50" in s:
            return 3
        if "1H pivot" in s or "1H ema" in s:
            return 4
        return 5

    def choose_leg_price(role: str, fib_key: str) -> Optional[Dict[str, Any]]:
        target = float(fibs[fib_key])
        tolerance = max(0.35 * atr4h, current * 0.002)
        nearby = []
        for item in structural_side:
            try:
                p = float(item["price"])
            except Exception:
                continue
            in_value_zone = min(value_zone_low, value_zone_high) - 0.25 * atr4h <= p <= max(value_zone_low, value_zone_high) + 0.25 * atr4h
            if not in_value_zone:
                continue
            if abs(p - target) <= tolerance:
                nearby.append({**item, "distance_to_fib_atr": abs(p - target) / atr4h if atr4h else None, "quality": source_quality(str(item.get("source", "")))})
        if nearby:
            nearby.sort(key=lambda x: (int(x["quality"]), float(x.get("distance_to_fib_atr") or 999), abs(float(x["price"]) - target)))
            chosen = nearby[0]
            return {"leg_role": role, "entry": round_price(float(chosen["price"]), rules), "entry_source": f"{chosen.get('source')} near {fib_key}% fib", "fib_price": rn(target), "confluence_count": len(nearby), "nearby_confluence": [{"price": rn(float(x["price"])), "source": x.get("source")} for x in nearby[:4]]}
        warnings.append(f"{role} uses {fib_key}% fib without nearby EMA/pivot confluence; validate visually before treating as TAKE.")
        return {"leg_role": role, "entry": round_price(target, rules), "entry_source": f"4H impulse {fib_key}% retracement (fib-only)", "fib_price": rn(target), "confluence_count": 0, "nearby_confluence": []}

    def breakout_retest_entry_candidates() -> List[Dict[str, Any]]:
        if not str(impulse.get("mode") or "").startswith("ACTIVE_BREAKOUT"):
            return []
        out: List[Dict[str, Any]] = []
        lo = min(value_zone_low, value_zone_high) - 0.35 * atr4h
        hi = max(value_zone_low, value_zone_high) + 0.35 * atr4h
        structural_tokens = (
            "prior pivot high", "prior pivot low", "pivot high", "pivot low",
            "4H ema", "1H ema", "1D ema", "4H", "1H", "1D",
        )
        for item in structural_side:
            try:
                p = float(item["price"])
            except Exception:
                continue
            if not (lo <= p <= hi):
                continue
            src = str(item.get("source") or "")
            if not any(tok in src for tok in structural_tokens):
                continue
            if side == "LONG" and p >= current:
                continue
            if side == "SHORT" and p <= current:
                continue
            out.append({
                "leg_role": "retest",
                "entry": round_price(p, rules),
                "entry_source": f"active breakout retest structural level: {src}",
                "fib_price": None,
                "confluence_count": 1,
                "nearby_confluence": [{"price": rn(p), "source": src}],
                "active_breakout_retest": True,
                "quality": source_quality(src),
            })
        # Add the fib levels themselves as retest candidates.  They often represent the cleanest
        # pullback geometry in fresh breakouts before confirmed pivot highs/lows exist.
        for k in ("38.2", "50.0", "61.8"):
            p = round_price(float(fibs[k]), rules)
            if lo <= p <= hi and ((side == "LONG" and p < current) or (side == "SHORT" and p > current)):
                out.append({
                    "leg_role": "retest",
                    "entry": p,
                    "entry_source": f"active breakout {k}% retracement",
                    "fib_price": rn(float(fibs[k])),
                    "confluence_count": 0,
                    "nearby_confluence": [],
                    "active_breakout_retest": True,
                    "quality": 3,
                })
        dedup: Dict[float, Dict[str, Any]] = {}
        for item in out:
            key = round(float(item["entry"]), 6)
            prev = dedup.get(key)
            if prev is None or int(item.get("quality", 9)) < int(prev.get("quality", 9)):
                dedup[key] = item
        vals = list(dedup.values())
        if side == "LONG":
            vals.sort(key=lambda x: (-float(x["entry"]), int(x.get("quality", 9))))
        else:
            vals.sort(key=lambda x: (float(x["entry"]), int(x.get("quality", 9))))
        return vals[:5]

    requested_roles = [("L1", "38.2"), ("L2", "50.0"), ("L3", "61.8")]
    if value_zone_width_atr is not None and value_zone_width_atr < 0.60:
        warnings.append("Useful 4H pullback zone is <0.60 ATR wide; using 2-leg ladder per OC rules.")
        requested_roles = [("L1", "50.0"), ("L2", "61.8")]

    raw_entries = [x for x in (choose_leg_price(role, fib) for role, fib in requested_roles) if x]
    active_retest_entries = breakout_retest_entry_candidates()
    if active_retest_entries:
        warnings.append("Active breakout mode: adding breakout-retest structural levels and active fib retracements as direct entry candidates.")
        raw_entries.extend(active_retest_entries)

    # Optional relaxation: allow a deep structural L3 outside the 38.2/50/61.8 fib value zone
    # when it is a strong prior HTF level (e.g. prior 1D/4H pivot high retest) and has not
    # crossed the impulse invalidation.  This keeps L1/L2 anchored to the active value zone,
    # but lets the scan test a deeper structural catch-bid/sell-rally level instead of
    # rejecting it solely for sitting below/above the fib zone.
    def deep_structural_l3() -> Optional[Dict[str, Any]]:
        if not atr4h:
            return None
        candidates: List[Dict[str, Any]] = []
        if side == "LONG":
            lower_bound = impulse_low + 0.25 * atr4h
            upper_bound = min(value_zone_low, value_zone_high) - 0.35 * atr4h
            for item in structural_side:
                try:
                    p = float(item["price"])
                except Exception:
                    continue
                src = str(item.get("source") or "")
                strong = ("1D prior pivot high" in src or "4H prior pivot high" in src or "4H pivot low" in src or "4H ema50" in src or "1H ema200" in src)
                if strong and lower_bound <= p <= upper_bound:
                    candidates.append({**item, "quality": source_quality(src), "distance_below_value_zone_atr": (min(value_zone_low, value_zone_high) - p) / atr4h})
            if not candidates:
                return None
            candidates.sort(key=lambda x: (int(x.get("quality", 9)), abs(float(x["price"]) - float(fibs["61.8"]))))
        else:
            upper_bound = impulse_high - 0.25 * atr4h
            lower_bound = max(value_zone_low, value_zone_high) + 0.35 * atr4h
            for item in structural_side:
                try:
                    p = float(item["price"])
                except Exception:
                    continue
                src = str(item.get("source") or "")
                strong = ("1D prior pivot low" in src or "4H prior pivot low" in src or "4H pivot high" in src or "4H ema50" in src or "1H ema200" in src)
                if strong and lower_bound <= p <= upper_bound:
                    candidates.append({**item, "quality": source_quality(src), "distance_above_value_zone_atr": (p - max(value_zone_low, value_zone_high)) / atr4h})
            if not candidates:
                return None
            candidates.sort(key=lambda x: (int(x.get("quality", 9)), abs(float(x["price"]) - float(fibs["61.8"]))))
        chosen = candidates[0]
        return {
            "leg_role": "L3" if side == "LONG" else "S3",
            "entry": round_price(float(chosen["price"]), rules),
            "entry_source": f"deep structural L3 outside fib value zone: {chosen.get('source')}",
            "fib_price": rn(float(fibs["61.8"])),
            "confluence_count": len(candidates),
            "nearby_confluence": [{"price": rn(float(x["price"])), "source": x.get("source")} for x in candidates[:4]],
            "deep_structural_l3": True,
        }

    deep_l3 = deep_structural_l3()
    if deep_l3 and all(abs(float(deep_l3["entry"]) - float(x["entry"])) >= 0.20 * atr4h for x in raw_entries):
        warnings.append("Relaxed rule active: testing a strong deep structural L3 outside the 4H fib value zone; final ticket must still pass SL/R:R/margin/liquidation checks.")
        raw_entries.append(deep_l3)

    if side == "LONG":
        raw_entries = [x for x in raw_entries if float(x["entry"]) < current]
        raw_entries.sort(key=lambda x: float(x["entry"]), reverse=True)
    else:
        raw_entries = [x for x in raw_entries if float(x["entry"]) > current]
        raw_entries.sort(key=lambda x: float(x["entry"]))

    entries: List[Dict[str, Any]] = []
    min_spacing = 0.25 * atr4h
    for item in raw_entries:
        if all(abs(float(item["entry"]) - float(prev["entry"])) >= min_spacing for prev in entries):
            entries.append(item)
        else:
            omitted.append({**item, "reason": "omitted_spacing_less_than_0_25_atr"})
    for i, item in enumerate(entries):
        item["leg"] = f"L{i+1}" if side == "LONG" else f"S{i+1}"

    if len(entries) < 2:
        warnings.append("Fewer than two static ladder legs remain after value-zone and spacing checks.")

    buffer_atr = 0.35
    if side == "LONG":
        lower_edge = min(float(fibs["61.8"]), impulse_low)
        stop = round_price(lower_edge - buffer_atr * atr4h, rules)
        invalidation_source = "below 4H impulse low / lower edge of 61.8% value zone plus 0.35 ATR buffer"
        entries = [x for x in entries if float(x["entry"]) > stop + 0.25 * atr4h]
    else:
        upper_edge = max(float(fibs["61.8"]), impulse_high)
        stop = round_price(upper_edge + buffer_atr * atr4h, rules)
        invalidation_source = "above 4H impulse high / upper edge of 61.8% value zone plus 0.35 ATR buffer"
        entries = [x for x in entries if float(x["entry"]) < stop - 0.25 * atr4h]

    if len(entries) < 2:
        warnings.append("After SL placement, fewer than two legs are at least 0.25 ATR away from the stop; static ticket is weak/invalid.")

    if len(entries) >= 3:
        risk_split = [0.25, 0.35, 0.40]
    elif len(entries) == 2:
        risk_split = [0.40, 0.60]
    else:
        risk_split = [1.00]

    def fixed_tp(entry: float, idx: int) -> Dict[str, Any]:
        if side == "LONG":
            natural = []
            for x in tp_side:
                try:
                    p = float(x["price"])
                except Exception:
                    continue
                if p > entry:
                    natural.append({"price": p, "source": x.get("source")})
            if impulse_high > entry:
                natural.append({"price": impulse_high, "source": "4H impulse high"})
            natural = sorted({round(float(x["price"]), 6): x for x in natural}.values(), key=lambda x: float(x["price"]))
            if natural:
                chosen = natural[min(idx, len(natural) - 1)]
                return {"price": round_price(float(chosen["price"]), rules), "source": chosen.get("source"), "type": "fixed_natural_resistance"}
            projected = entry + max(1.2 * abs(entry - stop), 1.2 * atr4h)
            warnings.append("No natural resistance found above long entry; TP is projected and should be treated cautiously.")
            return {"price": round_price(projected, rules), "source": "projected_fixed_tp_no_natural_resistance", "type": "projected"}
        natural = []
        for x in tp_side:
            try:
                p = float(x["price"])
            except Exception:
                continue
            if p < entry:
                natural.append({"price": p, "source": x.get("source")})
        if impulse_low < entry:
            natural.append({"price": impulse_low, "source": "4H impulse low"})
        natural = sorted({round(float(x["price"]), 6): x for x in natural}.values(), key=lambda x: float(x["price"]), reverse=True)
        if natural:
            chosen = natural[min(idx, len(natural) - 1)]
            return {"price": round_price(float(chosen["price"]), rules), "source": chosen.get("source"), "type": "fixed_natural_support"}
        projected = entry - max(1.2 * abs(entry - stop), 1.2 * atr4h)
        warnings.append("No natural support found below short entry; TP is projected and should be treated cautiously.")
        return {"price": round_price(projected, rules), "source": "projected_fixed_tp_no_natural_support", "type": "projected"}

    def risk_split_for_count(count: int) -> List[float]:
        if count >= 3:
            return [0.25, 0.35, 0.40]
        if count == 2:
            return [0.40, 0.60]
        return [1.0]

    def entry_combinations(source_entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        combos: List[Dict[str, Any]] = []
        def near_fib(entry: Dict[str, Any], key: str, tol_atr: float = 0.18) -> bool:
            try:
                fp = entry.get("fib_price")
                if fp is not None and abs(float(fp) - float(fibs[key])) <= tol_atr * atr4h:
                    return True
                return abs(float(entry["entry"]) - float(fibs[key])) <= tol_atr * atr4h
            except Exception:
                return False

        def first_near(key: str) -> Optional[Dict[str, Any]]:
            vals = [x for x in source_entries if near_fib(x, key)]
            if not vals:
                return None
            vals.sort(key=lambda x: abs(float(x["entry"]) - float(fibs[key])))
            return vals[0]

        fib38 = first_near("38.2")
        fib50 = first_near("50.0")
        fib618 = first_near("61.8")
        if str(impulse.get("mode") or "").startswith("ACTIVE_BREAKOUT") and fib50 and fib618:
            # Acceptance-test shape for fresh breakouts: use the middle/deep retest shelf first
            # (AAPL-like ~296.00 / ~294.60) instead of letting a nearby 1H pivot crowd out
            # the 61.8% retest level.
            combos.append({"name": "active_breakout_option_A_50_618", "entries": [fib50, fib618]})
            if fib38:
                combos.append({"name": "active_breakout_option_B_38_50_618", "entries": [fib38, fib50, fib618]})
        if len(source_entries) >= 3:
            if str(impulse.get("mode") or "").startswith("ACTIVE_BREAKOUT"):
                combos.append({"name": "active_breakout_retest_3_leg", "entries": source_entries[:3]})
                combos.append({"name": "active_breakout_quality_2_leg", "entries": source_entries[1:3]})
            combos.append({"name": "balanced_3_leg_value_zone", "entries": source_entries[:3]})
            combos.append({"name": "shallow_2_leg_38_50", "entries": source_entries[:2]})
            combos.append({"name": "deep_2_leg_50_618", "entries": source_entries[1:3]})
            deep = [x for x in source_entries if x.get("deep_structural_l3")]
            if deep:
                combos.append({"name": "relaxed_3_leg_deep_structural_L3", "entries": source_entries[:2] + deep[:1]})
                combos.append({"name": "relaxed_2_leg_deep_structural", "entries": [source_entries[1], deep[0]]})
        elif len(source_entries) == 2:
            combos.append({"name": "standard_2_leg_value_zone", "entries": source_entries[:2]})
        elif len(source_entries) == 1:
            combos.append({"name": "single_leg_probe_only", "entries": source_entries[:1]})
        return combos[:8]

    def sl_candidates_for(combo_entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = [{"price": stop, "source": invalidation_source, "type": "conservative"}]
        deepest = min(float(x["entry"]) for x in combo_entries) if side == "LONG" else max(float(x["entry"]) for x in combo_entries)
        structural_prices: List[Dict[str, Any]] = []
        for item in structural_side:
            try:
                p = float(item["price"])
            except Exception:
                continue
            structural_prices.append({"price": p, "source": item.get("source")})
        structural_prices.append({"price": float(fibs["61.8"]), "source": "4H impulse 61.8% retracement"})
        structural_prices.append({"price": impulse_low if side == "LONG" else impulse_high, "source": "4H impulse invalidation pivot"})

        for item in structural_prices:
            p = float(item["price"])
            cand = p - 0.35 * atr4h if side == "LONG" else p + 0.35 * atr4h
            cand = round_price(cand, rules)
            # Tighter stops are allowed only beyond a real level and outside normal 4H noise.
            if side == "LONG":
                if cand >= deepest - 0.70 * atr4h:
                    continue
                if cand >= current - 0.45 * atr4h:
                    continue
            else:
                if cand <= deepest + 0.70 * atr4h:
                    continue
                if cand <= current + 0.45 * atr4h:
                    continue
            out.append({"price": cand, "source": f"beyond {item.get('source')} with 0.35 ATR buffer", "type": "tighter_structural"})

        dedup: Dict[float, Dict[str, Any]] = {}
        for item in out:
            dedup[round(float(item["price"]), 6)] = item
        vals = list(dedup.values())
        if side == "LONG":
            conservative = [x for x in vals if float(x["price"]) <= stop + 1e-9]
            tighter = sorted([x for x in vals if float(x["price"]) > stop + 1e-9], key=lambda x: float(x["price"]))
        else:
            conservative = [x for x in vals if float(x["price"]) >= stop - 1e-9]
            tighter = sorted([x for x in vals if float(x["price"]) < stop - 1e-9], key=lambda x: float(x["price"]), reverse=True)
        return (conservative[:1] + tighter)[:4]

    daily_strong = bool(str(summaries.get("1D", {}).get("trend_state") or "") == "bullish" and (as_float(summaries.get("1D", {}).get("adx14"), 0.0) or 0.0) >= 25) if side == "LONG" else bool(str(summaries.get("1D", {}).get("trend_state") or "") == "bearish" and (as_float(summaries.get("1D", {}).get("adx14"), 0.0) or 0.0) >= 25)

    def tp_candidates() -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        def meaningful_tp_source(src: Any) -> bool:
            s = str(src or "")
            return any(token in s for token in ("4H pivot", "1D pivot", "4H impulse", "impulse"))
        if side == "LONG":
            for x in tp_side:
                try:
                    p = float(x["price"])
                except Exception:
                    continue
                if p > min(float(e["entry"]) for e in entries or raw_entries) and meaningful_tp_source(x.get("source")):
                    out.append({"price": round_price(p, rules), "source": x.get("source"), "type": "natural_resistance"})
            out.append({"price": round_price(impulse_high, rules), "source": "4H impulse high", "type": "natural_resistance"})
            out.append({"price": round_price(impulse_high + 0.118 * impulse_range, rules), "source": "4H impulse 1.118 extension", "type": "measured_extension"})
            out.append({"price": round_price(impulse_high + 0.272 * impulse_range, rules), "source": "4H impulse 1.272 extension", "type": "measured_extension"})
            out.append({"price": round_price(impulse_high + 0.618 * impulse_range, rules), "source": "4H impulse 1.618 extension", "type": "measured_extension"})
            out = [x for x in out if float(x["price"]) > current - 2 * atr4h]
            out = sorted({round(float(x["price"]), 6): x for x in out}.values(), key=lambda x: float(x["price"]))
        else:
            for x in tp_side:
                try:
                    p = float(x["price"])
                except Exception:
                    continue
                if p < max(float(e["entry"]) for e in entries or raw_entries) and meaningful_tp_source(x.get("source")):
                    out.append({"price": round_price(p, rules), "source": x.get("source"), "type": "natural_support"})
            out.append({"price": round_price(impulse_low, rules), "source": "4H impulse low", "type": "natural_support"})
            out.append({"price": round_price(impulse_low - 0.118 * impulse_range, rules), "source": "4H impulse 1.118 extension", "type": "measured_extension"})
            out.append({"price": round_price(impulse_low - 0.272 * impulse_range, rules), "source": "4H impulse 1.272 extension", "type": "measured_extension"})
            out.append({"price": round_price(impulse_low - 0.618 * impulse_range, rules), "source": "4H impulse 1.618 extension", "type": "measured_extension"})
            out = [x for x in out if float(x["price"]) < current + 2 * atr4h]
            out = sorted({round(float(x["price"]), 6): x for x in out}.values(), key=lambda x: float(x["price"]), reverse=True)
        return out[:4]

    def liquidation_estimate(blended: float, lev: float) -> Optional[float]:
        if not blended or not lev:
            return None
        maintenance = 0.006
        if side == "LONG":
            return blended * (1.0 - (1.0 / lev) + maintenance)
        return blended * (1.0 + (1.0 / lev) - maintenance)

    def choose_leverage(total_notional: float, blended: Optional[float], sl_price: float) -> Dict[str, Any]:
        options = sorted({planned_leverage, 6.0, 8.0, 10.0, 12.0, 15.0, 20.0})
        checks = []
        chosen = None
        for lev in options:
            if lev <= 0:
                continue
            margin = total_notional / lev if lev else float("inf")
            liq = liquidation_estimate(float(blended or 0), lev)
            if side == "LONG":
                liq_safe = bool(liq is not None and liq < sl_price - 0.25 * atr4h)
                liq_gap_atr = ((sl_price - liq) / atr4h) if liq is not None else None
            else:
                liq_safe = bool(liq is not None and liq > sl_price + 0.25 * atr4h)
                liq_gap_atr = ((liq - sl_price) / atr4h) if liq is not None else None
            ok = margin <= max_margin + 1e-9 and liq_safe
            # Above 10x is allowed only when liquidation is still safely beyond SL.
            if lev > 10.0 and not liq_safe:
                ok = False
            checks.append({"leverage": rn(lev, 2), "estimated_margin_usdt": rn(margin, 2), "estimated_liquidation": rn(liq), "liquidation_vs_sl_gap_atr": rn(liq_gap_atr, 3), "liquidation_beyond_sl": liq_safe, "passes": ok})
            if ok and chosen is None:
                chosen = checks[-1]
        return {"chosen": chosen, "checks": checks}

    def build_orders_for(combo_entries: List[Dict[str, Any]], sl_item: Dict[str, Any], tp_item: Dict[str, Any]) -> Dict[str, Any]:
        split = risk_split_for_count(len(combo_entries))
        available_tps = list(scan_tps or [])
        try:
            start_idx = next((i for i, x in enumerate(available_tps) if float(x.get("price")) == float(tp_item.get("price"))), 0)
        except Exception:
            start_idx = 0
        per_leg_tps: List[Dict[str, Any]] = []
        for idx in range(len(combo_entries)):
            use_idx = min(start_idx + idx, max(0, len(available_tps) - 1))
            per_leg_tps.append(available_tps[use_idx] if available_tps else tp_item)
        distinct_tp_count = len({round(float(x.get("price", 0.0)), 6) for x in per_leg_tps if x})
        orders = []
        for idx, item in enumerate(combo_entries):
            leg = f"L{idx+1}" if side == "LONG" else f"S{idx+1}"
            entry = float(item["entry"])
            sl_price = float(sl_item["price"])
            leg_tp = per_leg_tps[idx] if idx < len(per_leg_tps) else tp_item
            tp_price = float(leg_tp["price"])
            risk_per_unit = abs(entry - sl_price)
            if risk_per_unit <= 0:
                continue
            risk_alloc = risk_usdt * split[idx]
            qty = floor_qty(risk_alloc / risk_per_unit, rules)
            actual_risk = qty * risk_per_unit
            reward = qty * abs(tp_price - entry)
            notional = qty * entry
            spacing_prev_atr = abs(entry - float(combo_entries[idx - 1]["entry"])) / atr4h if idx > 0 else None
            orders.append({
                "leg": leg,
                "order_type": "limit",
                "entry": round_price(entry, rules),
                "entry_source": item.get("entry_source"),
                "fib_price": item.get("fib_price"),
                "confluence_count": item.get("confluence_count"),
                "nearby_confluence": item.get("nearby_confluence"),
                "qty_target_risk_before_margin_cap": rn(qty),
                "stop_loss": round_price(sl_price, rules),
                "stop_loss_source": sl_item.get("source"),
                "take_profit_candidate": round_price(tp_price, rules),
                "take_profit_source": leg_tp.get("source"),
                "take_profit_type": leg_tp.get("type"),
                "allocated_target_risk_usdt": rn(risk_alloc, 2),
                "actual_risk_before_notional_cap_usdt": rn(actual_risk, 2),
                "estimated_reward_usdt": rn(reward, 2),
                "notional_before_margin_cap_usdt": rn(notional, 2),
                "estimated_margin_before_cap_usdt": rn(notional / planned_leverage if planned_leverage else None, 2),
                "rr_estimate": rn(abs(tp_price - entry) / risk_per_unit, 2),
                "spacing_from_prior_leg_atr": rn(spacing_prev_atr, 3),
            })
        total_notional_local = sum(float(o["notional_before_margin_cap_usdt"] or 0) for o in orders)
        total_risk_local = sum(float(o["actual_risk_before_notional_cap_usdt"] or 0) for o in orders)
        total_reward_local = sum(float(o["estimated_reward_usdt"] or 0) for o in orders)
        total_qty_local = sum(float(o["qty_target_risk_before_margin_cap"] or 0) for o in orders)
        blended_local = sum(float(o["entry"]) * float(o["qty_target_risk_before_margin_cap"] or 0) for o in orders) / total_qty_local if total_qty_local else None
        sl_dist_atr = abs(float(blended_local or 0) - float(sl_item["price"])) / atr4h if blended_local else None
        weighted_tp_price = sum(float(o["take_profit_candidate"]) * float(o["qty_target_risk_before_margin_cap"] or 0) for o in orders) / total_qty_local if total_qty_local else None
        tp_dist_atr = abs(float(weighted_tp_price or 0) - float(blended_local or 0)) / atr4h if blended_local and weighted_tp_price else None
        max_tp_dist_atr = max([abs(float(o["take_profit_candidate"]) - float(blended_local or 0)) / atr4h for o in orders], default=None) if blended_local else None
        l1 = orders[:1]
        l12 = orders[:2]
        def scen(sub: List[Dict[str, Any]]) -> Optional[float]:
            r = sum(float(o["actual_risk_before_notional_cap_usdt"] or 0) for o in sub)
            w = sum(float(o["estimated_reward_usdt"] or 0) for o in sub)
            return w / r if r else None
        lev = choose_leverage(total_notional_local, blended_local, float(sl_item["price"]))
        scenario_l1 = scen(l1)
        scenario_l12 = scen(l12) if len(orders) >= 2 else None
        scenario_all = total_reward_local / total_risk_local if total_risk_local else None
        l1_risk_share = (float(orders[0].get("actual_risk_before_notional_cap_usdt") or 0) / total_risk_local) if orders and total_risk_local else None
        sl_quality_ok = bool(sl_dist_atr is not None and 0.70 <= sl_dist_atr <= 2.00)
        sl_fill_warning_ok = bool(sl_dist_atr is not None and 0.70 <= sl_dist_atr <= 2.20)
        sl_fill_strong_ok = bool(sl_dist_atr is not None and 2.20 < sl_dist_atr <= 2.75 and daily_strong)
        sl_fill_ok = bool(sl_fill_warning_ok or sl_fill_strong_ok)
        tp_quality_ok = bool(tp_dist_atr is not None and tp_dist_atr >= 1.20 and (tp_dist_atr <= 3.50 or (daily_strong and tp_dist_atr <= 4.20)))
        tp_fill_ok = tp_quality_ok
        base_safety_ok = bool(
            total_risk_local > 0
            and total_risk_local <= risk_usdt * 1.05
            and (scenario_all or 0) >= 1.5
            and lev.get("chosen") is not None
        )
        single_limit_ok = bool(len(orders) == 1 and base_safety_ok and sl_quality_ok and tp_quality_ok and (scenario_l1 or 0) >= 1.5)
        multi_leg_ok = bool(len(orders) >= 2 and (scenario_l12 or 0) >= 1.2 and distinct_tp_count >= len(orders))
        # A slightly wider HTF-supported SL can still be a valid static pullback ticket;
        # surface it as a warning instead of hard-rejecting an otherwise sound ladder.
        common_safety_ok = bool(base_safety_ok and (multi_leg_ok or single_limit_ok) and (sl_quality_ok or sl_fill_ok) and tp_quality_ok)
        valid_quality = bool(common_safety_ok and (scenario_l1 or 0) >= 1.0)
        l12_fill_soft_ok = bool((scenario_l12 or 0) >= 1.15)
        valid_fill_probability = bool(
            base_safety_ok
            and (scenario_l1 or 0) >= 0.90
            and (scenario_l1 or 0) < 1.0
            and l1_risk_share is not None
            and l1_risk_share <= 0.25
            and l12_fill_soft_ok
            and sl_fill_ok
            and tp_fill_ok
        )
        valid = valid_quality or valid_fill_probability
        rejects = []
        warnings_local = []
        if len(orders) < 2 and not single_limit_ok:
            rejects.append("fewer than two valid legs and single-limit pullback checks did not pass")
        if len(orders) >= 2 and distinct_tp_count < len(orders):
            rejects.append("fewer distinct realistic TP levels than ladder legs")
        if (scenario_l1 or 0) < 0.90:
            rejects.append("L1-only R:R below 0.90 fill-probability floor")
        elif (scenario_l1 or 0) < 1.0:
            if l1_risk_share is not None and l1_risk_share <= 0.25:
                warnings_local.append("L1-only R:R is 0.90-0.99; can be BEST FILL PROBABILITY only if all total ladder quality / ATR / TP / margin / structure gates pass.")
            else:
                rejects.append("Rejected due to total ladder quality / ATR / TP / margin / structure gates, not because L1 R:R is below 1.0: L1 risk share is too large for BEST FILL PROBABILITY exception")
        if (scenario_l12 or 0) < 1.15:
            rejects.append("L1+L2 R:R below 1.2")
        elif (scenario_l12 or 0) < 1.2:
            warnings_local.append("L1+L2 R:R is in 1.15-1.20 soft-warning zone for BEST FILL PROBABILITY.")
        if (scenario_all or 0) < 1.5:
            rejects.append("all-filled R:R below 1.5")
        if sl_dist_atr is None or sl_dist_atr < 0.70:
            rejects.append("SL distance below minimum preferred 0.70 ATR")
        elif sl_dist_atr > 2.50 and not daily_strong:
            rejects.append("SL distance >2.50 ATR without exceptional HTF structure")
        elif sl_dist_atr > 2.20 and not daily_strong:
            rejects.append("SL distance >2.20 ATR requires very strong HTF structure")
        elif sl_dist_atr > 2.50:
            warnings_local.append("SL distance is >2.50 ATR; accepted only because exceptional 1D/HTF structure and realistic TP support the fill-probability exception.")
        elif sl_dist_atr > 2.00:
            warnings_local.append("SL distance is above strict quality range; acceptable only as warning/HTF-supported fill-probability context.")
        if tp_dist_atr is None or tp_dist_atr < 1.20 or not (tp_dist_atr <= 3.50 or (daily_strong and tp_dist_atr <= 4.20)):
            rejects.append("TP distance outside preferred realistic ATR range")
        elif max_tp_dist_atr is not None and max_tp_dist_atr > 4.20:
            rejects.append("highest leg TP distance exceeds extended realistic ATR range")
        elif tp_dist_atr > 3.50:
            warnings_local.append("TP distance is >3.50 ATR; accepted only because 1D/4H structure supports the target.")
        if lev.get("chosen") is None:
            rejects.append("no leverage option fits margin cap with liquidation safely beyond SL")
        valid = bool(valid and not rejects)
        valid_quality = bool(valid_quality and valid)
        valid_fill_probability = bool(valid_fill_probability and valid)
        if valid_fill_probability and not valid_quality:
            warnings_local.append("VALID_FOR_BEST_FILL_PROBABILITY_ONLY: L1-only R:R is about 0.90+, L1 risk share is reduced, L2/L3 carry the ladder, all-filled R:R is above 1.5, and total risk/margin/leverage/TP/ATR gates pass.")
        return {
            "entries_name": None,
            "orders": orders,
            "stop_loss": round_price(float(sl_item["price"]), rules),
            "stop_loss_source": sl_item.get("source"),
            "take_profit": round_price(float(tp_item["price"]), rules),
            "take_profit_source": tp_item.get("source"),
            "take_profit_type": tp_item.get("type"),
            "per_leg_take_profits": [{"leg": o.get("leg"), "tp": o.get("take_profit_candidate"), "source": o.get("take_profit_source"), "type": o.get("take_profit_type")} for o in orders],
            "distinct_tp_count": distinct_tp_count,
            "total_planned_risk_usdt": rn(risk_usdt, 2),
            "actual_risk_usdt": rn(total_risk_local, 2),
            "estimated_reward_usdt": rn(total_reward_local, 2),
            "total_notional_usdt": rn(total_notional_local, 2),
            "estimated_margin_at_planned_leverage_usdt": rn(total_notional_local / planned_leverage if planned_leverage else None, 2),
            "selected_leverage_check": lev.get("chosen"),
            "leverage_checks": lev.get("checks"),
            "blended_entry": rn(blended_local),
            "rr_l1_only": rn(scenario_l1, 2),
            "rr_l1_l2": rn(scenario_l12, 2),
            "rr_all_filled": rn(scenario_all, 2),
            "l1_risk_share": rn(l1_risk_share, 3),
            "sl_distance_atr_from_blended": rn(sl_dist_atr, 3),
            "tp_distance_atr_from_blended": rn(tp_dist_atr, 3),
            "max_tp_distance_atr_from_blended": rn(max_tp_dist_atr, 3),
            "single_limit_pullback_valid": single_limit_ok,
            "valid_static_ticket": valid,
            "valid_best_quality": valid_quality,
            "valid_best_fill_probability": valid_fill_probability,
            "option_compliance": [x for x, ok in (("BEST_QUALITY", valid_quality), ("BEST_FILL_PROBABILITY", valid_fill_probability or valid_quality)) if ok] + (["VALID_FOR_BEST_FILL_PROBABILITY_ONLY"] if valid_fill_probability and not valid_quality else []),
            "reject_reasons": rejects,
            "warning_reasons": warnings_local,
        }

    scan_entries = entry_combinations(entries)
    scan_tps = tp_candidates() if scan_entries else []
    scan_results: List[Dict[str, Any]] = []
    for combo in scan_entries:
        for sl_item in sl_candidates_for(combo["entries"]):
            for tp_item in scan_tps:
                r = build_orders_for(combo["entries"], sl_item, tp_item)
                r["entries_name"] = combo["name"]
                r["entry_prices"] = [float(x["entry"]) for x in combo["entries"]]
                scan_results.append(r)

    def scan_sort_key(item: Dict[str, Any]) -> Tuple[int, float, float, float]:
        # Prefer valid, nearest realistic TP, better all-filled R:R, then lower leverage.
        valid_rank = 0 if item.get("valid_static_ticket") else 1
        tp_atr = float(item.get("tp_distance_atr_from_blended") or 999)
        rr_all = float(item.get("rr_all_filled") or 0)
        lev = float((item.get("selected_leverage_check") or {}).get("leverage") or 999)
        return (valid_rank, abs(tp_atr - 1.8), -rr_all, lev)

    scan_results.sort(key=scan_sort_key)
    best = scan_results[0] if scan_results else None
    target_orders = list((best or {}).get("orders") or [])
    if best:
        stop = float(best["stop_loss"])
        invalidation_source = str(best.get("stop_loss_source") or invalidation_source)
        selected_leverage = float((best.get("selected_leverage_check") or {}).get("leverage") or planned_leverage)
    else:
        selected_leverage = planned_leverage

    for o in target_orders:
        try:
            notional_o = float(o.get("notional_before_margin_cap_usdt") or 0)
            o["estimated_margin_before_cap_usdt"] = rn(notional_o / selected_leverage if selected_leverage else None, 2)
            o["estimated_margin_leverage_used"] = rn(selected_leverage, 2)
        except Exception:
            pass

    total_notional = sum(float(o["notional_before_margin_cap_usdt"] or 0) for o in target_orders)
    total_margin = total_notional / selected_leverage if selected_leverage else float("inf")
    total_risk = sum(float(o["actual_risk_before_notional_cap_usdt"] or 0) for o in target_orders)
    total_reward = sum(float(o["estimated_reward_usdt"] or 0) for o in target_orders)
    total_qty = sum(float(o["qty_target_risk_before_margin_cap"] or 0) for o in target_orders)
    blended_entry = sum(float(o["entry"]) * float(o["qty_target_risk_before_margin_cap"] or 0) for o in target_orders) / total_qty if total_qty else None
    blended_rr = total_reward / total_risk if total_risk else None
    target_risk_feasible_under_margin_cap = total_margin <= max_margin + 1e-9
    cap_adjusted_orders = []
    if not target_risk_feasible_under_margin_cap and total_notional > 0:
        scale = (max_margin * selected_leverage) / total_notional
        warnings.append(f"Target {risk_usdt:.2f} USDT risk exceeds max margin {max_margin:.2f} USDT at selected {selected_leverage:.2f}x leverage. Static OC rules forbid silently resizing; cap-adjusted sizing is informational only.")
        for o in target_orders:
            qty = floor_qty(float(o["qty_target_risk_before_margin_cap"] or 0) * scale, rules)
            entry = float(o["entry"])
            risk = qty * abs(entry - float(o["stop_loss"]))
            cap_adjusted_orders.append({**o, "qty_cap_adjusted": rn(qty), "notional_cap_adjusted_usdt": rn(qty * entry, 2), "estimated_margin_cap_adjusted_usdt": rn((qty * entry) / selected_leverage if selected_leverage else None, 2), "actual_risk_cap_adjusted_usdt": rn(risk, 2)})

    static_rejects: List[str] = []
    best_single_valid = bool((best or {}).get("single_limit_pullback_valid"))
    if len(target_orders) < 2 and not best_single_valid:
        static_rejects.append("Static ladder has fewer than two valid legs after optimisation scan.")
    if total_risk <= 0 or total_risk > risk_usdt * 1.05:
        static_rejects.append("Total actual risk is not controlled near the target if all entries fill and price goes directly to SL.")
    if total_risk < risk_usdt * 0.85 and target_orders:
        warnings.append("Actual risk after contract rounding is materially below target; do not silently add unsafe size to force exactly 100 USDT.")
    if not target_risk_feasible_under_margin_cap:
        static_rejects.append("Full static ticket breaches max margin cap at selected leverage.")
    if not (best or {}).get("valid_static_ticket"):
        static_rejects.append("Static optimisation scan found no candidate meeting R:R, ATR-distance, margin, and liquidation safety rules.")
    if near_major_resistance and side == "LONG":
        warnings.append("Long setup is near major resistance; this blocks market orders, but does not block valid resting pullback limits if static checks pass.")
    if near_major_support and side == "SHORT":
        warnings.append("Short setup is near major support; this blocks market orders, but does not block valid resting sell-rally limits if static checks pass.")

    static_ticket_safe = not static_rejects
    if static_rejects:
        decision_hint = "NO_TRADE"
    elif best_single_valid:
        decision_hint = "SINGLE_LIMIT_PULLBACK"
    else:
        decision_hint = "PLACEABLE_NOW"

    if omitted:
        warnings.append("Some levels were omitted by OC static ladder rules (spacing, stop distance, or value-zone constraints).")

    return {
        "side": side,
        "style_hint": ("SINGLE_LIMIT_PULLBACK" if best_single_valid else ("DIP_LADDER" if side == "LONG" else "SELL_RALLY")),
        "decision_hint": decision_hint,
        "market_order_allowed": False,
        "current_price_reference": rn(current),
        "atr4h_reference": rn(atr4h),
        "expected_pullback_policy": pull,
        "oc_static_ladder_rules": {
            "version": "OC_4H_PULLBACK_LADDER_STATIC_OPTIMIZED_V2",
            "static_only": True,
            "no_dynamic_management": True,
            "no_trailing_or_post_fill_adjustment": True,
            "max_legs": 3,
            "risk_split_used": risk_split_for_count(len(target_orders))[:len(target_orders)],
            "spacing_min_atr": 0.25,
            "spacing_ideal_atr": "0.30-0.60",
            "sl_buffer_atr_used": buffer_atr,
            "l3_min_distance_from_sl_atr": 0.25,
            "fixed_tp_required": True,
            "separate_tp_per_leg_required": True,
            "static_optimisation_required": True,
            "rr_thresholds": {"l1_only_min": 1.0, "l1_l2_min": 1.2, "all_filled_min": 1.5},
            "atr_limits_4h": {"sl_from_blended_ideal": "0.70-1.80", "sl_from_blended_avoid_above": 2.0, "tp_from_blended_ideal": "1.20-2.80", "tp_from_blended_max_normal": 3.5},
            "atr_source": "4H ATR(14) only",
        },
        "impulse_analysis_4h": impulse,
        "value_zone": value_zone,
        "stop_loss_candidate": stop,
        "invalidation_logic": invalidation_source,
        "structure_risk_diagnostics": structure_risk,
        "screener_action_context_used": {
            "available": bool(screener_row),
            "W01 LC ActionScore": screener_row.get("W01 LC ActionScore"),
            "W02 LC WindowActive": screener_row.get("W02 LC WindowActive"),
            "W03 LC EntryState": screener_row.get("W03 LC EntryState"),
            "D13 LC ContextFinal": screener_row.get("D13 LC ContextFinal"),
            "D16 SC Final": screener_row.get("D16 SC Final"),
        },
        "target_total_risk_usdt": risk_usdt,
        "target_actual_risk_before_cap_usdt": rn(total_risk, 2),
        "target_reward_before_cap_usdt": rn(total_reward, 2),
        "target_blended_entry": rn(blended_entry),
        "target_blended_rr": rn(blended_rr, 2),
        "max_margin_usdt": max_margin,
        "planned_leverage": planned_leverage,
        "selected_leverage": rn(selected_leverage, 2),
        "selected_leverage_reason": "Minimum scanned leverage that fits the margin cap and keeps estimated liquidation safely beyond SL; >10x is allowed only if that liquidation-vs-SL check passes.",
        "max_effective_notional_usdt": rn(max_margin * selected_leverage, 2),
        "target_orders_before_margin_cap": target_orders,
        "target_total_notional_before_cap_usdt": rn(total_notional, 2),
        "target_estimated_margin_before_cap_usdt": rn(total_margin, 2),
        "target_risk_feasible_under_margin_cap": target_risk_feasible_under_margin_cap,
        "cap_adjusted_orders_if_needed": cap_adjusted_orders,
        "static_optimisation_scan": {
            "entry_combinations_tested": [{"name": x["name"], "entries": [rn(float(e["entry"])) for e in x["entries"]]} for x in scan_entries],
            "tp_candidates_tested": scan_tps,
            "candidate_count": len(scan_results),
            "best_candidate": {k: v for k, v in (best or {}).items() if k != "orders"},
            "top_candidates": [{k: v for k, v in x.items() if k != "orders"} for x in scan_results],
        },
        "omitted_too_deep_levels_sample": omitted[:8],
        "static_ticket_safe": static_ticket_safe,
        "static_ticket_reject_reasons": static_rejects,
        "warnings": warnings + static_rejects,
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
        notes.append("No TradingView capture/export copied; screenshot-first structure read is unavailable, so Bitget OHLCV can only provide numeric validation/context.")
    return {"status": status, "ticker_vs_last_closed_4h_diff_pct": rn(diff, 4), "current_ticker_reference": rn(cur), "latest_closed_4h_close": close4h, "tv_exports_available": tv_available, "notes": notes, "checked_at_utc": utc_now_iso()}


def copy_tv_exports(tv_export_dir: Optional[Path], raw_dir: Path) -> Dict[str, Any]:
    out = {"available": False, "files": [], "manifest": None, "method_preference": "screenshots first: existing Playwright/browser capture or TradingView Desktop CDP when available"}
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


def load_screener_data(screener_data_file: Optional[Path], symbol: str, raw_dir: Path) -> Dict[str, Any]:
    """Load optional screener/strategy-test export context.

    Supports JSON exports and CSV chart-data/strategy-test exports.  For CSV we keep
    the newest row that has useful screener-like fields (Best Score, LC/SC, SQ, D*,
    W*) and/or a symbol match.  This is read-only secondary context used after the
    screenshot-first structure read.
    """
    if not screener_data_file:
        return {"available": False, "reason": "No screener/strategy-test export supplied."}
    if not screener_data_file.exists():
        return {"available": False, "reason": f"Screener data file not found: {screener_data_file}"}

    dest = raw_dir / f"screener_data{''.join(screener_data_file.suffixes[-1:]) or '.dat'}"
    shutil.copy2(screener_data_file, dest)
    sym = api_symbol(symbol)

    def interesting(row: Dict[str, Any]) -> Dict[str, Any]:
        keep: Dict[str, Any] = {}
        wanted_substrings = ("score", "setup", "conviction", "verdict", "signal", "trend", "macro", "final", "action", "research", "valid")
        wanted_prefixes = ("D", "G", "P", "SQ", "W")
        for k, v in row.items():
            if v in (None, "", "NaN", "nan"):
                continue
            key = str(k).strip()
            low = key.lower()
            if any(s in low for s in wanted_substrings) or key.startswith(wanted_prefixes) or low in ("symbol", "ticker", "time", "datetime", "date"):
                keep[key] = v
        return keep

    try:
        suffix = screener_data_file.suffix.lower()
        if suffix == ".json":
            data = read_json(screener_data_file, default={})
            candidates: List[Dict[str, Any]] = []
            if isinstance(data, list):
                candidates = [x for x in data if isinstance(x, dict)]
            elif isinstance(data, dict):
                for key in ("rows", "data", "results", "records"):
                    if isinstance(data.get(key), list):
                        candidates = [x for x in data[key] if isinstance(x, dict)]
                        break
                if not candidates:
                    candidates = [data]
            matches = [r for r in candidates if sym in json.dumps(r, ensure_ascii=False).upper().replace("BITGET:", "").replace(".P", "")]
            row = (matches or candidates or [{}])[-1]
            return {"available": True, "source_file": str(dest), "format": "json", "matched_symbol": bool(matches), "row_count": len(candidates), "selected_row": interesting(row)}

        with screener_data_file.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            rows = [r for r in reader]
        matches = []
        for r in rows:
            blob = json.dumps(r, ensure_ascii=False).upper().replace("BITGET:", "").replace(".P", "")
            if sym in blob:
                matches.append(r)
        useful = [r for r in (matches or rows) if interesting(r)]
        row = (useful or matches or rows or [{}])[-1]
        return {"available": True, "source_file": str(dest), "format": "csv", "matched_symbol": bool(matches), "row_count": len(rows), "selected_row": interesting(row)}
    except Exception as exc:
        return {"available": False, "source_file": str(dest), "error": str(exc)}


def compact_level_list(items: Any, limit: int = 8) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not isinstance(items, list):
        return out
    for x in items[:limit]:
        if not isinstance(x, dict):
            continue
        out.append({
            "price": x.get("price"),
            "source": x.get("source"),
            "time_utc": x.get("time_utc"),
            "distance_pct": x.get("distance_pct"),
            "distance_atr": x.get("distance_atr"),
        })
    return out


def compact_tf_summary(summary: Dict[str, Any]) -> Dict[str, Any]:
    keep = [
        "timeframe", "bars", "closed_candles_only", "latest_closed_bar_time_utc",
        "latest_close", "latest_high", "latest_low", "ema20", "ema50", "ema200",
        "atr14", "atr14_pct", "rsi14", "adx14", "volume_ratio_20", "trend_state",
    ]
    out = {k: summary.get(k) for k in keep if k in summary}
    # Full pivot history stays in analysis_summary.json; compact packet uses nearest merged key levels.
    return out


def compact_order(order: Dict[str, Any]) -> Dict[str, Any]:
    keep = [
        "leg", "order_type", "entry", "entry_source", "qty_target_risk_before_margin_cap",
        "stop_loss", "stop_loss_source", "take_profit_candidate", "take_profit_source",
        "take_profit_type", "allocated_target_risk_usdt", "actual_risk_before_notional_cap_usdt",
        "estimated_reward_usdt", "notional_before_margin_cap_usdt", "estimated_margin_before_cap_usdt",
        "estimated_margin_leverage_used", "rr_estimate", "spacing_from_prior_leg_atr",
    ]
    return {k: order.get(k) for k in keep if k in order}


def compact_candidate(candidate: Dict[str, Any]) -> Dict[str, Any]:
    keep = [
        "entries_name", "entry_prices", "stop_loss", "stop_loss_source", "take_profit",
        "take_profit_source", "take_profit_type", "per_leg_take_profits", "distinct_tp_count",
        "actual_risk_usdt", "estimated_reward_usdt",
        "total_notional_usdt", "estimated_margin_at_planned_leverage_usdt", "blended_entry",
        "rr_l1_only", "rr_l1_l2", "rr_all_filled", "l1_risk_share", "sl_distance_atr_from_blended",
        "tp_distance_atr_from_blended", "max_tp_distance_atr_from_blended",
        "single_limit_pullback_valid", "valid_static_ticket", "valid_best_quality",
        "valid_best_fill_probability", "option_compliance", "reject_reasons", "warning_reasons",
    ]
    out = {k: candidate.get(k) for k in keep if k in candidate}
    if isinstance(candidate.get("selected_leverage_check"), dict):
        out["selected_leverage_check"] = candidate["selected_leverage_check"]
    return out


def compact_execution_state(execution_state: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(execution_state, dict):
        return {"available": False}
    if not execution_state.get("available"):
        return {k: execution_state.get(k) for k in ("available", "reason", "usage_note") if k in execution_state}
    keep = ["available", "symbol", "positions", "orders", "plan_orders", "usage_note"]
    return {k: execution_state.get(k) for k in keep if k in execution_state}


def make_compact_decision_payload(manifest: Dict[str, Any], analysis_summary: Dict[str, Any], execution_state: Dict[str, Any], files: Dict[str, Any]) -> Dict[str, Any]:
    ladder = analysis_summary.get("candidate_trade_design") or {}
    levels = analysis_summary.get("levels") or {}
    scan = ladder.get("static_optimisation_scan") or {}
    best = scan.get("best_candidate") or {}
    top_candidates = scan.get("top_candidates") if isinstance(scan.get("top_candidates"), list) else []
    screener_summary = analysis_summary.get("screener_summary") or {}
    screener_data = screener_summary.get("extracted_data") or {}
    contract_rules = analysis_summary.get("contract_rules") or {}
    valid_candidates = [x for x in top_candidates if isinstance(x, dict) and (x.get("valid_static_ticket") or x.get("valid_best_fill_probability"))]
    rejected_candidates = [x for x in top_candidates if isinstance(x, dict) and not x.get("valid_static_ticket")]
    side = str(ladder.get("side") or manifest.get("side") or "").upper()
    quality_candidates = [x for x in valid_candidates if x.get("valid_best_quality")]
    fill_candidates = [x for x in valid_candidates if "BEST_FILL_PROBABILITY" in (x.get("option_compliance") or [])]

    def quality_sort_key(x: Dict[str, Any]) -> tuple:
        tp_atr = float(x.get("tp_distance_atr_from_blended") or 999)
        rr_all = float(x.get("rr_all_filled") or 0)
        lev = float((x.get("selected_leverage_check") or {}).get("leverage") or 999)
        return (abs(tp_atr - 1.8), -rr_all, lev)

    def fill_sort_key(x: Dict[str, Any]) -> tuple:
        entries = x.get("entry_prices") if isinstance(x.get("entry_prices"), list) else []
        first = float(entries[0]) if entries else 0.0
        fill_first = -first if side == "LONG" else first
        rr_all = float(x.get("rr_all_filled") or 0)
        tp_atr = float(x.get("tp_distance_atr_from_blended") or 999)
        return (-len(entries), fill_first, abs(tp_atr - 2.8), -rr_all)

    def rr_for(entry: Any, sl: Any, tp: Any) -> Optional[float]:
        e = as_float(entry)
        s = as_float(sl)
        t = as_float(tp)
        if e is None or s is None or t is None or abs(e - s) <= 0:
            return None
        return abs(t - e) / abs(e - s)

    def next_tp_after(tp: Any, tp_candidates: List[Dict[str, Any]]) -> Optional[float]:
        base = as_float(tp)
        if base is None:
            return None
        vals = [as_float(x.get("price")) for x in tp_candidates if isinstance(x, dict)]
        vals = sorted({float(x) for x in vals if x is not None}, reverse=(side == "SHORT"))
        for v in vals:
            if side == "SHORT" and v < base - 1e-9:
                return v
            if side != "SHORT" and v > base + 1e-9:
                return v
        return None

    def shallow_fill_probability_leg_audit(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        audit: List[Dict[str, Any]] = []
        seen = set()
        tp_candidates_tested = scan.get("tp_candidates_tested") if isinstance(scan.get("tp_candidates_tested"), list) else []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            entries = candidate.get("entry_prices") if isinstance(candidate.get("entry_prices"), list) else []
            if not entries:
                continue
            rr_l1 = as_float(candidate.get("rr_l1_only"))
            reject_reasons = list(candidate.get("reject_reasons") or [])
            warning_reasons = list(candidate.get("warning_reasons") or [])
            reason_pool = reject_reasons + warning_reasons
            reason_text_all = "; ".join(str(x) for x in reason_pool if x)
            is_shallow_fill_case = bool(
                (rr_l1 is not None and rr_l1 < 1.0)
                or "L1-only" in reason_text_all
                or "fill-probability" in reason_text_all.lower()
                or "BEST_FILL_PROBABILITY" in (candidate.get("option_compliance") or [])
            )
            if not is_shallow_fill_case:
                continue
            entry = as_float(entries[0])
            sl = as_float(candidate.get("stop_loss"))
            per_leg_tps = candidate.get("per_leg_take_profits") if isinstance(candidate.get("per_leg_take_profits"), list) else []
            nearest_tp = None
            if per_leg_tps and isinstance(per_leg_tps[0], dict):
                nearest_tp = as_float(per_leg_tps[0].get("tp"))
            if nearest_tp is None:
                nearest_tp = as_float(candidate.get("take_profit"))
            next_tp = None
            if len(per_leg_tps) > 1 and isinstance(per_leg_tps[1], dict):
                next_tp = as_float(per_leg_tps[1].get("tp"))
            if next_tp is None:
                next_tp = next_tp_after(nearest_tp, tp_candidates_tested)
            key = (candidate.get("entries_name"), entry, sl, nearest_tp, next_tp)
            if key in seen:
                continue
            seen.add(key)
            accepted = bool(candidate.get("valid_best_fill_probability") or candidate.get("valid_best_quality"))
            reason_text = "; ".join(str(x) for x in (warning_reasons if accepted else reject_reasons) if x)
            audit.append({
                "candidate": candidate.get("entries_name"),
                "candidate_entry": rn(entry),
                "sl": rn(sl),
                "nearest_tp": rn(nearest_tp),
                "next_tp": rn(next_tp),
                "rr_to_nearest_tp": rn(rr_for(entry, sl, nearest_tp), 2),
                "rr_to_next_tp": rn(rr_for(entry, sl, next_tp), 2),
                "rr_l1_only": rn(rr_l1, 2),
                "rr_l1_l2": rn(as_float(candidate.get("rr_l1_l2")), 2),
                "rr_all_filled": rn(as_float(candidate.get("rr_all_filled")), 2),
                "status": "ACCEPTED" if accepted else "REJECTED",
                "accepted_rejected_reason": reason_text or ("passes BEST FILL PROBABILITY gates" if accepted else "candidate failed static ticket gates"),
            })
            if len(audit) >= 10:
                break
        return audit

    rejected_fill_probability_candidates = [
        x for x in top_candidates
        if isinstance(x, dict)
        and not x.get("valid_best_fill_probability")
        and (
            as_float(x.get("rr_l1_only")) is not None
            or "L1-only" in "; ".join(str(r) for r in (x.get("reject_reasons") or []) + (x.get("warning_reasons") or []))
        )
    ]
    best_quality_candidate = sorted(quality_candidates, key=quality_sort_key)[0] if quality_candidates else (best if isinstance(best, dict) else {})
    best_fill_probability_candidate = sorted(fill_candidates, key=fill_sort_key)[0] if fill_candidates else (rejected_fill_probability_candidates[0] if rejected_fill_probability_candidates else {})
    shallow_fill_audit = shallow_fill_probability_leg_audit(top_candidates)

    compact_valid_candidates = []
    seen_candidate_keys = set()
    for x in [best_quality_candidate, best_fill_probability_candidate] + valid_candidates:
        if not isinstance(x, dict) or not x:
            continue
        key = (x.get("entries_name"), tuple(x.get("entry_prices") or []), x.get("stop_loss"), x.get("take_profit"))
        if key in seen_candidate_keys:
            continue
        seen_candidate_keys.add(key)
        compact_valid_candidates.append(x)

    return {
        "packet_type": "compact_deep_analysis_decision_packet_v2",
        "usage": "Feed this compact packet to the final LLM/report step. Full raw/audit data remains in analysis_summary.json, candidate_levels.json, and raw files.",
        "non_negotiable_rules": {
            "primary_truth": "Screenshots / visible TradingView chart structure first; user key levels second; Bitget OHLCV/ticker/execution validate numbers and feasibility; TradingView OHLCV/export only for cross-check.",
            "trade_style": "Static 4H pullback only: DIP_LADDER long, SELL_RALLY short, or AUTO/SINGLE_LIMIT_PULLBACK if exactly one valid level survives all checks.",
            "risk_target": "Default target planned risk is 100 USDT unless overridden.",
            "margin_cap": "1500 USDT max margin at selected/planned leverage, not max total notional.",
            "static_safety": "If all entries fill and price goes directly to SL, total loss must remain near planned risk.",
            "forbidden_assumptions": ["no live execution", "no dynamic management", "no trailing", "no future cancellation assumption", "no SL movement or post-fill adjustment"],
            "confirmation": "Any live order placement requires a separate explicit user confirmation; final JSON must keep requires_user_confirmation=true.",
            "rejection_audit": "Always justify rejected sides/options/candidates and broken rules with item, exact rule/gate, observed value, required value/threshold, why it blocks, and what would fix it. Prefer packet fields static_ticket_reject_reasons, warnings, best_candidate.reject_reasons, and rejected_candidate_examples_compact.",
            "option_framework": "Always output both sections: Option A — BEST QUALITY: VALID/REJECTED and Option B — BEST FILL PROBABILITY: VALID/REJECTED. Never hide the rejected option; include rejected levels, exact failing reason, and key failed metric.",
            "shallow_fill_probability_leg_audit": "For every rejected shallow fill-probability leg, report candidate entry, SL, nearest TP, next TP, R:R to nearest TP, R:R to next TP, and accepted/rejected reason. Use shallow_fill_probability_leg_audit_compact when present.",
            "focus_window": "Analyze screenshots first: 4H last 40 candles, 1H last 80 candles, 1D last 80 candles. Older data only for major HTF levels.",
            "do_not": ["choose old pivots just because they are confirmed", "ignore fresh breakout highs/lows", "reject resting limit ladders only because current price is hot", "require 2+ ladder legs if one valid single pullback limit survives all checks"],
            "screenshot_delivery": "Final chat output should include the 1D and 4H screenshots/contact sheet when available.",
        },
        "manifest": {k: manifest.get(k) for k in [
            "symbol", "tv_symbol", "side", "family", "score", "rank", "screener_version",
            "risk_usdt_target", "max_margin_usdt", "planned_leverage", "max_effective_notional_usdt",
            "created_at_utc", "price_truth_source", "screener_usage", "live_execution_scope",
        ] if k in manifest},
        "freshness": analysis_summary.get("freshness"),
        "ladder_price_reference": analysis_summary.get("ladder_price_reference"),
        "contract_rules_compact": {k: contract_rules.get(k) for k in ["price_place", "volume_place", "size_multiplier", "min_trade_num", "min_trade_usdt"] if k in contract_rules},
        "timeframes": {tf: compact_tf_summary(s) for tf, s in (analysis_summary.get("timeframes") or {}).items() if isinstance(s, dict)},
        "key_levels_nearest": {
            "supports": compact_level_list(levels.get("supports"), 8),
            "resistances": compact_level_list(levels.get("resistances"), 8),
        },
        "candidate_trade_design": {
            "side": ladder.get("side"),
            "style_hint": ladder.get("style_hint"),
            "decision_hint": ladder.get("decision_hint"),
            "market_order_allowed": ladder.get("market_order_allowed"),
            "current_price_reference": ladder.get("current_price_reference"),
            "atr4h_reference": ladder.get("atr4h_reference"),
            "impulse_analysis_4h": ladder.get("impulse_analysis_4h"),
            "value_zone": ladder.get("value_zone"),
            "invalidation_logic": ladder.get("invalidation_logic"),
            "stop_loss_candidate": ladder.get("stop_loss_candidate"),
            "structure_risk_diagnostics": ladder.get("structure_risk_diagnostics"),
            "target_total_risk_usdt": ladder.get("target_total_risk_usdt"),
            "target_actual_risk_before_cap_usdt": ladder.get("target_actual_risk_before_cap_usdt"),
            "target_reward_before_cap_usdt": ladder.get("target_reward_before_cap_usdt"),
            "target_blended_entry": ladder.get("target_blended_entry"),
            "target_blended_rr": ladder.get("target_blended_rr"),
            "selected_leverage": ladder.get("selected_leverage"),
            "selected_leverage_reason": ladder.get("selected_leverage_reason"),
            "target_total_notional_before_cap_usdt": ladder.get("target_total_notional_before_cap_usdt"),
            "target_estimated_margin_before_cap_usdt": ladder.get("target_estimated_margin_before_cap_usdt"),
            "target_risk_feasible_under_margin_cap": ladder.get("target_risk_feasible_under_margin_cap"),
            "static_ticket_safe": ladder.get("static_ticket_safe"),
            "static_ticket_reject_reasons": ladder.get("static_ticket_reject_reasons"),
            "warnings": ladder.get("warnings"),
            "orders": [compact_order(o) for o in (ladder.get("target_orders_before_margin_cap") or []) if isinstance(o, dict)],
            "static_rules_summary": {
                "static_only": True,
                "max_legs": 3,
                "risk_split_used": (ladder.get("oc_static_ladder_rules") or {}).get("risk_split_used"),
                "rr_thresholds": (ladder.get("oc_static_ladder_rules") or {}).get("rr_thresholds"),
                "atr_limits_4h": (ladder.get("oc_static_ladder_rules") or {}).get("atr_limits_4h"),
                "atr_source": "4H ATR(14) only",
            },
            "static_optimisation_scan_summary": {
                "candidate_count": scan.get("candidate_count"),
                "entry_combinations_tested": scan.get("entry_combinations_tested"),
                "tp_candidates_tested": [
                    {"price": x.get("price"), "source": x.get("source"), "type": x.get("type")}
                    for x in (scan.get("tp_candidates_tested") or [])[:4] if isinstance(x, dict)
                ],
                "best_candidate": compact_candidate(best) if isinstance(best, dict) else {},
                "best_quality_candidate": compact_candidate(best_quality_candidate) if isinstance(best_quality_candidate, dict) else {},
                "best_fill_probability_candidate": compact_candidate(best_fill_probability_candidate) if isinstance(best_fill_probability_candidate, dict) else {},
                "option_framework_required": {
                    "option_a": "Option A — BEST QUALITY: VALID / REJECTED",
                    "option_b": "Option B — BEST FILL PROBABILITY: VALID / REJECTED",
                    "rule": "Always output both sections; rejected options must show levels, exact failing reason, and key failed metric.",
                },
                "shallow_fill_probability_leg_audit_compact": shallow_fill_audit,
                "valid_candidate_alternatives_compact": [compact_candidate(x) for x in compact_valid_candidates[:10]],
                "rejected_candidate_examples_compact": [compact_candidate(x) for x in rejected_candidates[:5]],
            },
        },
        "screener_context": {
            "available": screener_data.get("available"),
            "source_file": screener_data.get("source_file"),
            "row_count": screener_data.get("row_count"),
            "selected_row_essentials": screener_data.get("selected_row"),
            "usage_note": screener_summary.get("usage_note"),
        },
        "execution_state": compact_execution_state(execution_state),
        "evidence_files": {
            "analysis_summary_full": (files.get("derived") or {}).get("analysis_summary"),
            "candidate_levels_full": (files.get("derived") or {}).get("candidate_levels"),
            "freshness_check": (files.get("derived") or {}).get("freshness_check"),
            "tv_exports": files.get("tv_exports", []),
            "preferred_media_files": files.get("preferred_media_files", []),
            "discord_media_lines": files.get("discord_media_lines", []),
            "bitget_ohlcv": files.get("bitget_ohlcv", {}),
        },
    }


def make_compact_llm_packet(path: Path, master_prompt: str, compact_payload: Dict[str, Any]) -> None:
    content = f"""# Compact LLM Decision Packet v2 - {compact_payload.get('manifest', {}).get('symbol')}

Use this compact packet with `{master_prompt}` for the final short report.

The full raw/audit packet remains on disk. Do not infer live-execution permission from this packet.

```json
{json.dumps(compact_payload, indent=2, ensure_ascii=False)}
```
"""
    path.write_text(content, encoding="utf-8")


def make_full_llm_packet(path: Path, master_prompt: str, manifest: Dict[str, Any], analysis_summary: Dict[str, Any], market_snapshot: Dict[str, Any], execution_state: Dict[str, Any], files: Dict[str, Any]) -> None:
    def j(x: Any) -> str:
        return json.dumps(x, indent=2, ensure_ascii=False)
    content = f"""# LLM Input Packet v2 - {manifest['symbol']}

Use this packet with `{master_prompt}`.

## 1. Manifest

```json
{j(manifest)}
```

## 2. Decision rules reminder

- Screenshots / visible TradingView chart structure are primary truth for structure and levels.
- User-provided key levels are second priority.
- Bitget OHLCV/ticker/execution state validate numbers, current price, sizing, margin/leverage/liquidation, and feasibility.
- TradingView OHLCV/export data is only for cross-checks when needed.
- Focus window: 4H last 40 candles, 1H last 80 candles, 1D last 80 candles; older data only for major HTF levels.
- Screener context is candidate-selection context only, not proof.
- No hard screener-score eligibility rule.
- Target planned risk is 100 USDT unless user supplied another value.
- Max cap is margin, not notional: {manifest['max_margin_usdt']} USDT margin at planned leverage {manifest['planned_leverage']}x (effective notional cap {manifest['max_effective_notional_usdt']} USDT).
- Final ticket must follow the static OC 4H ladder rules in `candidate_trade_design.oc_static_ladder_rules`.
- Final report must always show both sections: `Option A — BEST QUALITY: VALID / REJECTED` and `Option B — BEST FILL PROBABILITY: VALID / REJECTED`. Never hide the rejected option; show rejected levels, exact failing reason, and key failed metric.
- For every rejected shallow fill-probability leg, report candidate entry, SL, nearest TP, next TP, R:R to nearest TP, R:R to next TP, and accepted/rejected reason.
- Only propose `DIP_LADDER long`, `SELL_RALLY short`, or `AUTO / SINGLE_LIMIT_PULLBACK` static tickets with fixed entries, quantities, SLs, and TPs valid at order creation.
- Do not assume future cancellation, stop movement, trailing, or post-fill management.
- If all entries fill and price immediately goes to SL, total loss must remain near the planned risk.
- If 100 USDT risk cannot fit structure/R:R/margin/freshness, give a strong warning or WAIT/NO_TRADE.
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
    p = argparse.ArgumentParser(description="Build a read-only screenshot-first Bitget deep-analysis packet v2.")
    p.add_argument("--symbol", required=True, help="Bitget symbol, e.g. AAPLUSDT or BITGET:AAPLUSDT.P")
    p.add_argument("--tv-symbol", default=None)
    p.add_argument("--side", default="AUTO", choices=["LONG", "SHORT", "AUTO"])
    p.add_argument("--family", default="AUTO")
    p.add_argument("--score", type=float, default=None)
    p.add_argument("--rank", type=int, default=None)
    p.add_argument("--screener-version", default=DEFAULT_SCREENER_VERSION)
    p.add_argument("--risk-usdt", type=float, default=100.0)
    p.add_argument("--max-margin-usdt", type=float, default=1500.0, help="Maximum margin budget in USDT, not total notional.")
    p.add_argument("--planned-leverage", type=float, default=4.0, help="Planned leverage used to estimate effective notional cap from margin cap.")
    p.add_argument("--max-notional-usdt", type=float, default=None, help="Deprecated compatibility flag; if supplied, converted to margin using --planned-leverage.")
    p.add_argument("--bars-1d", type=int, default=400)
    p.add_argument("--bars-4h", type=int, default=500)
    p.add_argument("--bars-1h", type=int, default=500)
    p.add_argument("--include-15m", action="store_true")
    p.add_argument("--bars-15m", type=int, default=300)
    p.add_argument("--tv-export-dir", default=None)
    p.add_argument("--screener-data-file", default=None, help="Optional screener/strategy-test CSV or JSON exported from TradingView/MCP.")
    p.add_argument("--execution-state-json", default=None, help="Optional read-only account/order context JSON")
    p.add_argument("--out-root", default="reports/deep_analysis_packets_v2")
    p.add_argument("--master-prompt", default="prompts/master_trade_analysis_prompt_v2.md")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    symbol = api_symbol(args.symbol)
    tv_symbol = args.tv_symbol or f"BITGET:{symbol}.P"
    max_margin_usdt = args.max_margin_usdt
    if args.max_notional_usdt is not None:
        # Backward compatibility with older wrappers.  The durable policy is now
        # margin-cap semantics, so convert a legacy notional cap to equivalent
        # margin at the planned leverage rather than keeping the old meaning.
        max_margin_usdt = args.max_notional_usdt / args.planned_leverage if args.planned_leverage else args.max_margin_usdt
    max_effective_notional = max_margin_usdt * args.planned_leverage
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
        "max_margin_usdt": max_margin_usdt,
        "planned_leverage": args.planned_leverage,
        "max_effective_notional_usdt": max_effective_notional,
        "cap_semantics": "max margin at planned leverage, not max total notional",
        "legacy_max_notional_usdt_input": args.max_notional_usdt,
        "created_at_local": datetime.now().replace(microsecond=0).isoformat(),
        "created_at_utc": utc_now_iso(),
        "timezone": "Europe/Berlin",
        "price_truth_source": "Screenshots/visible chart structure first; Bitget REST closed OHLCV/ticker validate numbers and execution feasibility",
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

    screener_data = load_screener_data(Path(args.screener_data_file) if args.screener_data_file else None, symbol, raw_dir)
    if screener_data.get("source_file"):
        files["other"]["screener_data"] = screener_data.get("source_file")

    summaries = {tf: summarize_tf(tf, candles) for tf, candles in candles_by_tf.items()}
    closed_current = float(summaries.get("4H", {}).get("latest_close") or summaries.get("1H", {}).get("latest_close"))
    ticker_current = current_ticker_price(market_snapshot)
    ticker_diff_pct = abs(float(ticker_current) - closed_current) / closed_current * 100.0 if ticker_current and closed_current else None
    # Closed candles remain the primary analytical truth, but ladder order placement must
    # be based on the live/current price when the market has moved materially away from
    # the last closed 4H bar.  Otherwise a fast move near highs can make all useful
    # pullback levels look too shallow/deep and collapse the ladder to one leg.
    current = float(ticker_current) if ticker_current and ticker_diff_pct is not None and ticker_diff_pct > 0.15 else closed_current
    levels = collect_levels(summaries, current)
    rules = contract_rules(market_snapshot)
    ladder = build_ladder(args.side, args.family, summaries, levels, args.risk_usdt, max_margin_usdt, args.planned_leverage, rules, screener_data=screener_data, current_price_reference=current)
    fresh = freshness(market_snapshot, summaries, bool(tv_summary.get("available")))

    screener_summary = {
        "screener_version": args.screener_version,
        "symbol": tv_symbol,
        "bias": args.side,
        "family": args.family,
        "score": args.score,
        "rank": args.rank,
        "extracted_data": screener_data,
        "usage_note": "Candidate-selection context only. No hard score threshold; target 100 USDT risk by default, warn if trade quality/constraints are weak.",
    }

    analysis_summary = {
        "symbol": symbol,
        "tv_symbol": tv_symbol,
        "side": args.side,
        "family": args.family,
        "risk_usdt_target": args.risk_usdt,
        "max_margin_usdt": max_margin_usdt,
        "planned_leverage": args.planned_leverage,
        "max_effective_notional_usdt": max_effective_notional,
        "contract_rules": rules,
        "timeframes": summaries,
        "levels": levels,
        "candidate_trade_design": ladder,
        "ladder_price_reference": {
            "used": rn(current),
            "closed_4h_reference": rn(closed_current),
            "ticker_reference": rn(ticker_current),
            "ticker_vs_closed_4h_diff_pct": rn(ticker_diff_pct, 4),
            "reason": "ticker used for ladder geometry when it differs materially from latest closed 4H; closed candles remain primary analysis truth"
        },
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
    tv_screenshot_files = [p for p in files.get("tv_exports", []) if str(p).lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
    discord_sheets = [p for p in tv_screenshot_files if "contact_sheet_discord" in Path(str(p)).name.lower()]
    contact_sheets = [p for p in tv_screenshot_files if "contact_sheet" in Path(str(p)).name.lower()]
    preferred_media_files = discord_sheets or contact_sheets or tv_screenshot_files
    files["preferred_media_files"] = preferred_media_files
    files["discord_media_lines"] = [f"MEDIA:{p}" for p in preferred_media_files]

    compact_payload = make_compact_decision_payload(manifest, analysis_summary, execution_state, files)
    write_json(derived_dir / "decision_packet_compact.json", compact_payload)
    files["derived"]["decision_packet_compact"] = str(derived_dir / "decision_packet_compact.json")

    # Keep the original verbose packet for audit/debug, but make the canonical
    # llm_input_packet.md compact so normal deep-analysis runs are cheaper and
    # less distractible for the final LLM step.
    v2_full_packet = out_dir / "llm_input_packet_V2.full.md"
    make_full_llm_packet(v2_full_packet, args.master_prompt, manifest, analysis_summary, market_snapshot, execution_state, files)
    # Backward-compatible alias for older notes/tools; V2.full is the explicit comparison name.
    shutil.copy2(v2_full_packet, out_dir / "llm_input_packet_full.md")
    make_compact_llm_packet(out_dir / "llm_input_packet.md", args.master_prompt, compact_payload)
    print(json.dumps({
        "packet_dir": str(out_dir),
        "llm_input_packet": str(out_dir / "llm_input_packet.md"),
        "llm_input_packet_kind": "compact",
        "full_llm_input_packet": str(v2_full_packet),
        "full_llm_input_packet_alias": str(out_dir / "llm_input_packet_full.md"),
        "decision_packet_compact_json": str(derived_dir / "decision_packet_compact.json"),
        "analysis_summary": str(derived_dir / "analysis_summary.json"),
        "symbol": symbol,
        "side": args.side,
        "risk_usdt_target": args.risk_usdt,
        "max_margin_usdt": max_margin_usdt,
        "planned_leverage": args.planned_leverage,
        "max_effective_notional_usdt": max_effective_notional,
        "tv_screenshot_files": tv_screenshot_files,
        "preferred_media_files": preferred_media_files,
        "discord_media_lines": [f"MEDIA:{p}" for p in preferred_media_files],
        "reporting_note": "When answering in Discord, include the 1D and 4H chart evidence with the output results. Prefer the merged horizontal 1D|4H contact sheet when present; use separate screenshots as fallback/readability evidence."
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
