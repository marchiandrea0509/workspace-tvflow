#!/usr/bin/env python3
"""Evaluate Bitget trade MAE/MFE from execution history and public candles.

The script reconstructs completed position lifecycles from fills, snapshots the
lots held at maximum exposure, downloads bounded post-entry candle windows, and
reports active-trade and fixed-horizon excursions in price, USDT, and planned R.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import time
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


API_URL = "https://api.bitget.com/api/v2/mix/market/history-candles"
STEP_MS = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1H": 3_600_000,
}


def num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def iso(ms: int | None) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def floor_step(ms: int, step: int) -> int:
    return (ms // step) * step


def ceil_step(ms: int, step: int) -> int:
    return ((ms + step - 1) // step) * step


@dataclass
class Lot:
    qty: float
    price: float
    time_ms: int
    order_id: str
    sl: float | None
    tp: float | None

    def copy(self) -> "Lot":
        return Lot(self.qty, self.price, self.time_ms, self.order_id, self.sl, self.tp)


@dataclass
class Lifecycle:
    symbol: str
    side: str
    sequence: int
    first_fill_ms: int
    lots: deque[Lot] = field(default_factory=deque)
    events: list[dict[str, Any]] = field(default_factory=list)
    max_qty: float = 0.0
    max_exposure_ms: int = 0
    max_lots: list[Lot] = field(default_factory=list)
    close_profit: float = 0.0
    close_order_ids: set[str] = field(default_factory=set)
    final_close_ms: int | None = None
    reconciled_residual_qty: float = 0.0

    @property
    def qty(self) -> float:
        return sum(lot.qty for lot in self.lots)


def load_history(path: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    results = {row.get("label"): row.get("data") or [] for row in payload.get("results", [])}
    fills = list(results.get("fills", []))
    orders = {str(row.get("orderId")): row for row in results.get("orders-history", [])}
    return fills, orders


def order_levels(order: dict[str, Any] | None) -> tuple[float | None, float | None]:
    if not order:
        return None, None
    sl = num(order.get("presetStopLossPrice"), math.nan)
    tp = num(order.get("presetStopSurplusPrice"), math.nan)
    return (sl if math.isfinite(sl) and sl > 0 else None, tp if math.isfinite(tp) and tp > 0 else None)


def reconstruct_lifecycles(
    fills: list[dict[str, Any]],
    orders: dict[str, dict[str, Any]],
    tolerance: float = 1e-8,
    close_reconciliation_fraction: float = 0.001,
) -> tuple[list[Lifecycle], list[dict[str, Any]], dict[tuple[str, str], Lifecycle]]:
    active: dict[tuple[str, str], Lifecycle] = {}
    completed: list[Lifecycle] = []
    orphans: list[dict[str, Any]] = []
    sequences: dict[tuple[str, str], int] = defaultdict(int)
    fill_qty_by_order: dict[tuple[str, str], float] = defaultdict(float)
    last_fill_ms_by_order: dict[tuple[str, str], int] = defaultdict(int)
    for row in fills:
        row_trade_side = str(row.get("tradeSide") or "").lower()
        row_order_id = str(row.get("orderId") or "")
        if row_trade_side in {"open", "close"} and row_order_id:
            row_key = (row_trade_side, row_order_id)
            fill_qty_by_order[row_key] += num(row.get("baseVolume"))
            last_fill_ms_by_order[row_key] = max(last_fill_ms_by_order[row_key], int(row.get("cTime") or 0))

    def event_rank(fill: dict[str, Any]) -> tuple[int, int, str]:
        # An open preceding a close at the same millisecond best reflects the
        # position quantity Bitget used for a stop/TP event.
        rank = 0 if fill.get("tradeSide") == "open" else 1
        return int(fill.get("cTime") or 0), rank, str(fill.get("tradeId") or "")

    sorted_fills = sorted(fills, key=event_rank)
    event_batches: list[list[dict[str, Any]]] = []
    for fill in sorted_fills:
        batch_key = (
            int(fill.get("cTime") or 0),
            str(fill.get("symbol") or ""),
            str(fill.get("side") or "").lower(),
            str(fill.get("tradeSide") or "").lower(),
        )
        if (
            event_batches
            and batch_key[3] == "close"
            and batch_key
            == (
                int(event_batches[-1][0].get("cTime") or 0),
                str(event_batches[-1][0].get("symbol") or ""),
                str(event_batches[-1][0].get("side") or "").lower(),
                str(event_batches[-1][0].get("tradeSide") or "").lower(),
            )
        ):
            event_batches[-1].append(fill)
        else:
            event_batches.append([fill])

    for batch in event_batches:
        fill = batch[0]
        trade_side = str(fill.get("tradeSide") or "").lower()
        side = str(fill.get("side") or "").lower()
        symbol = str(fill.get("symbol") or "")
        ms = int(fill.get("cTime") or 0)
        qty = sum(num(row.get("baseVolume")) for row in batch)
        # Bitget occasionally omits small fill fragments from the fills export
        # even though orders-history carries the exact filled baseVolume. Add
        # the discrepancy once, on the order's final observed fill timestamp.
        for order_id in {str(row.get("orderId") or "") for row in batch}:
            row_key = (trade_side, order_id)
            order_qty = num(orders.get(order_id, {}).get("baseVolume"))
            exported_fill_qty = fill_qty_by_order.get(row_key, 0.0)
            if ms == last_fill_ms_by_order.get(row_key, -1) and order_qty > exported_fill_qty + tolerance:
                qty += order_qty - exported_fill_qty
        price = num(fill.get("price"))
        if not symbol or side not in {"buy", "sell"} or qty <= 0 or price <= 0 or ms <= 0:
            continue
        key = (symbol, side)

        if trade_side == "open":
            life = active.get(key)
            if life is None:
                sequences[key] += 1
                life = Lifecycle(symbol, side, sequences[key], ms, max_exposure_ms=ms)
                active[key] = life
            sl, tp = order_levels(orders.get(str(fill.get("orderId"))))
            lot = Lot(qty, price, ms, str(fill.get("orderId")), sl, tp)
            life.lots.append(lot)
            life.events.append(dict(fill))
            if life.qty > life.max_qty + tolerance:
                life.max_qty = life.qty
                life.max_exposure_ms = ms
                life.max_lots = [x.copy() for x in life.lots]
            continue

        if trade_side != "close":
            continue
        life = active.get(key)
        if life is None:
            orphans.append(fill)
            continue
        remaining = qty
        while remaining > tolerance and life.lots:
            lot = life.lots[0]
            take = min(lot.qty, remaining)
            lot.qty -= take
            remaining -= take
            if lot.qty <= tolerance:
                life.lots.popleft()
        if remaining > max(tolerance, qty * 1e-6):
            orphan = dict(fill)
            orphan["unmatched_qty"] = remaining
            orphans.append(orphan)
        life.events.extend(dict(row) for row in batch)
        life.close_profit += sum(num(row.get("profit")) for row in batch)
        life.close_order_ids.update(str(row.get("orderId")) for row in batch)
        reconciliation_tolerance = max(tolerance, life.max_qty * close_reconciliation_fraction)
        if life.qty <= reconciliation_tolerance:
            life.reconciled_residual_qty = life.qty
            life.lots.clear()
            life.final_close_ms = ms
            completed.append(life)
            del active[key]

    return completed, orphans, active


def merge_intervals(intervals: list[tuple[int, int]], step: int) -> list[tuple[int, int]]:
    merged: list[list[int]] = []
    for start, end in sorted(intervals):
        if not merged or start > merged[-1][1] + step:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return [(a, b) for a, b in merged]


def fetch_interval(
    symbol: str,
    product_type: str,
    granularity: str,
    start_ms: int,
    end_ms: int,
    pause_s: float,
    retries: int = 4,
) -> tuple[dict[int, list[Any]], int]:
    rows: dict[int, list[Any]] = {}
    cursor = end_ms
    calls = 0
    previous_oldest: int | None = None
    while True:
        query = urllib.parse.urlencode(
            {
                "symbol": symbol,
                "productType": product_type,
                "granularity": granularity,
                "limit": 200,
                "endTime": cursor,
            }
        )
        url = f"{API_URL}?{query}"
        last_error: Exception | None = None
        payload: dict[str, Any] | None = None
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(url, timeout=30) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                break
            except Exception as exc:  # pragma: no cover - network retry path
                last_error = exc
                time.sleep(0.5 * (attempt + 1))
        if payload is None:
            raise RuntimeError(f"Bitget request failed for {symbol}: {last_error}")
        calls += 1
        if payload.get("code") != "00000":
            raise RuntimeError(f"Bitget API error for {symbol}: {payload.get('code')} {payload.get('msg')}")
        batch = payload.get("data") or []
        if not batch:
            break
        timestamps = []
        for row in batch:
            if len(row) < 5:
                continue
            ts = int(row[0])
            timestamps.append(ts)
            if start_ms <= ts <= end_ms:
                rows[ts] = row
        if not timestamps:
            break
        oldest = min(timestamps)
        if oldest <= start_ms or (previous_oldest is not None and oldest >= previous_oldest):
            break
        previous_oldest = oldest
        cursor = oldest
        if pause_s:
            time.sleep(pause_s)
    return rows, calls


def snapshot_metrics(life: Lifecycle) -> dict[str, Any] | None:
    lots = [lot for lot in life.max_lots if lot.qty > 0]
    qty = sum(lot.qty for lot in lots)
    if qty <= 0:
        return None
    entry = sum(lot.qty * lot.price for lot in lots) / qty
    long_side = life.side == "buy"
    planned_risk = 0.0
    planned_reward = 0.0
    risk_known = True
    reward_known = True
    stop_levels: list[float] = []
    target_levels: list[float] = []
    for lot in lots:
        if lot.sl is None:
            risk_known = False
        else:
            risk = (lot.price - lot.sl) if long_side else (lot.sl - lot.price)
            if risk <= 0:
                risk_known = False
            else:
                planned_risk += lot.qty * risk
                stop_levels.append(lot.sl)
        if lot.tp is None:
            reward_known = False
        else:
            reward = (lot.tp - lot.price) if long_side else (lot.price - lot.tp)
            if reward <= 0:
                reward_known = False
            else:
                planned_reward += lot.qty * reward
                target_levels.append(lot.tp)
    return {
        "qty": qty,
        "entry": entry,
        "long": long_side,
        "planned_risk": planned_risk if risk_known and planned_risk > 0 else None,
        "planned_reward": planned_reward if reward_known and planned_reward > 0 else None,
        "stop_levels": stop_levels,
        "target_levels": target_levels,
        "lots": lots,
    }


def excursion(
    candles: list[list[Any]], entry: float, qty: float, long_side: bool, planned_risk: float | None
) -> dict[str, Any]:
    if not candles:
        return {"candles": 0}
    max_high = max(num(row[2], -math.inf) for row in candles)
    min_low = min(num(row[3], math.inf) for row in candles)
    if long_side:
        mfe_price = max(0.0, max_high - entry)
        mae_price = max(0.0, entry - min_low)
    else:
        mfe_price = max(0.0, entry - min_low)
        mae_price = max(0.0, max_high - entry)
    mfe_usdt = mfe_price * qty
    mae_usdt = mae_price * qty
    return {
        "candles": len(candles),
        "window_first_candle_utc": iso(int(candles[0][0])),
        "window_last_candle_utc": iso(int(candles[-1][0])),
        "max_high": max_high,
        "min_low": min_low,
        "mfe_price": mfe_price,
        "mae_price": mae_price,
        "mfe_pct": 100 * mfe_price / entry,
        "mae_pct": 100 * mae_price / entry,
        "mfe_usdt": mfe_usdt,
        "mae_usdt": mae_usdt,
        "mfe_r": (mfe_usdt / planned_risk) if planned_risk else None,
        "mae_r": (mae_usdt / planned_risk) if planned_risk else None,
    }


def close_sources(life: Lifecycle, orders: dict[str, dict[str, Any]]) -> list[str]:
    return sorted(
        {
            str(orders.get(order_id, {}).get("orderSource") or "unknown")
            for order_id in life.close_order_ids
        }
    )


def lifecycle_gross_profit(life: Lifecycle, orders: dict[str, dict[str, Any]]) -> float:
    order_values = []
    for order_id in life.close_order_ids:
        order = orders.get(order_id)
        if not order or order.get("totalProfits") in {None, ""}:
            return life.close_profit
        order_values.append(num(order.get("totalProfits")))
    return sum(order_values) if order_values else life.close_profit


def round_values(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 8) if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: round_values(v) for k, v in value.items()}
    if isinstance(value, list):
        return [round_values(v) for v in value]
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--history", default="reports/trade_journal/raw_bitget_history_latest.json")
    parser.add_argument("--out-dir", default="reports/trade_excursions")
    parser.add_argument("--horizon-days", type=float, default=8.0)
    parser.add_argument("--granularity", choices=sorted(STEP_MS), default="15m")
    parser.add_argument("--product-type", default="usdt-futures")
    parser.add_argument("--pause-ms", type=int, default=60)
    args = parser.parse_args()

    root = Path.cwd()
    history_path = Path(args.history)
    if not history_path.is_absolute():
        history_path = root / history_path
    out_root = Path(args.out_dir)
    if not out_root.is_absolute():
        out_root = root / out_root
    run_tag = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = out_root / f"bitget_mae_mfe_{run_tag}"
    candle_dir = out_dir / "candles"
    candle_dir.mkdir(parents=True, exist_ok=True)

    fills, orders = load_history(history_path)
    completed, orphans, active = reconstruct_lifecycles(fills, orders)
    step = STEP_MS[args.granularity]
    horizon_ms = int(args.horizon_days * 86_400_000)

    trade_specs: list[tuple[Lifecycle, dict[str, Any]]] = []
    intervals: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for life in completed:
        snap = snapshot_metrics(life)
        if not snap:
            continue
        # Preserve candles from the first actual fill (the literal entry date)
        # while retaining a full horizon after maximum ladder exposure.
        start = floor_step(life.first_fill_ms, step)
        end = ceil_step(max(life.first_fill_ms + horizon_ms, life.max_exposure_ms + horizon_ms), step)
        intervals[life.symbol].append((start, end))
        trade_specs.append((life, snap))

    candles_by_symbol: dict[str, dict[int, list[Any]]] = defaultdict(dict)
    api_calls = 0
    interval_manifest: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for symbol in sorted(intervals):
        for start, end in merge_intervals(intervals[symbol], step):
            rows, calls = fetch_interval(
                symbol,
                args.product_type,
                args.granularity,
                start,
                end,
                max(0, args.pause_ms) / 1000,
            )
            candles_by_symbol[symbol].update(rows)
            api_calls += calls
            interval_manifest[symbol].append(
                {"start_utc": iso(start), "end_utc": iso(end), "rows": len(rows), "api_calls": calls}
            )

        csv_path = candle_dir / f"{symbol}_{args.granularity}.csv"
        with csv_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["timestamp_ms", "open_time_utc", "open", "high", "low", "close", "base_volume", "quote_volume"])
            for ts, row in sorted(candles_by_symbol[symbol].items()):
                writer.writerow([ts, iso(ts), *row[1:7]])

    records: list[dict[str, Any]] = []
    for life, snap in trade_specs:
        start = life.max_exposure_ms
        horizon_end = start + horizon_ms
        active_end = min(life.final_close_ms or horizon_end, horizon_end)
        all_rows = [row for ts, row in sorted(candles_by_symbol[life.symbol].items()) if ts + step > start and ts < horizon_end]
        active_rows = [row for ts, row in sorted(candles_by_symbol[life.symbol].items()) if ts + step > start and ts < active_end]
        fixed = excursion(all_rows, snap["entry"], snap["qty"], snap["long"], snap["planned_risk"])
        active_exc = excursion(active_rows, snap["entry"], snap["qty"], snap["long"], snap["planned_risk"])
        planned_rr = None
        if snap["planned_risk"] and snap["planned_reward"]:
            planned_rr = snap["planned_reward"] / snap["planned_risk"]
        target_capture = None
        if fixed.get("mfe_usdt") is not None and snap["planned_reward"]:
            target_capture = fixed["mfe_usdt"] / snap["planned_reward"]
        records.append(
            round_values(
                {
                    "trade_id": f"{life.symbol}_{life.side}_{life.sequence:03d}",
                    "symbol": life.symbol,
                    "direction": "long" if life.side == "buy" else "short",
                    "first_fill_utc": iso(life.first_fill_ms),
                    "max_exposure_utc": iso(life.max_exposure_ms),
                    "final_close_utc": iso(life.final_close_ms),
                    "fill_span_hours": (life.max_exposure_ms - life.first_fill_ms) / 3_600_000,
                    "holding_hours_after_max_exposure": ((life.final_close_ms or life.max_exposure_ms) - life.max_exposure_ms) / 3_600_000,
                    "max_qty": snap["qty"],
                    "max_exposure_lots": len(snap["lots"]),
                    "blended_entry": snap["entry"],
                    "planned_risk_usdt": snap["planned_risk"],
                    "planned_reward_usdt": snap["planned_reward"],
                    "planned_rr": planned_rr,
                    "risk_distance_pct": (100 * snap["planned_risk"] / (snap["qty"] * snap["entry"])) if snap["planned_risk"] else None,
                    "reward_distance_pct": (100 * snap["planned_reward"] / (snap["qty"] * snap["entry"])) if snap["planned_reward"] else None,
                    "actual_gross_profit_usdt": lifecycle_gross_profit(life, orders),
                    "reconciled_residual_qty": life.reconciled_residual_qty,
                    "reconciled_residual_pct_of_max": 100 * life.reconciled_residual_qty / life.max_qty if life.max_qty else 0,
                    "close_sources": close_sources(life, orders),
                    "active_trade_excursion": active_exc,
                    "fixed_horizon_excursion": fixed,
                    "fixed_horizon_target_capture": target_capture,
                    "first_candle_partial_bias_minutes_max": STEP_MS[args.granularity] / 60_000,
                }
            )
        )

    records.sort(key=lambda row: row["max_exposure_utc"] or "")
    json_path = out_dir / "trade_excursions.json"
    json_path.write_text(json.dumps(records, indent=2), encoding="utf-8")

    flat_fields = [
        "trade_id", "symbol", "direction", "first_fill_utc", "max_exposure_utc", "final_close_utc",
        "fill_span_hours", "holding_hours_after_max_exposure", "max_qty", "max_exposure_lots", "blended_entry",
        "planned_risk_usdt", "planned_reward_usdt", "planned_rr", "risk_distance_pct", "reward_distance_pct",
        "actual_gross_profit_usdt", "reconciled_residual_qty", "reconciled_residual_pct_of_max", "close_sources", "active_mfe_r", "active_mae_r", "horizon_mfe_r",
        "horizon_mae_r", "horizon_target_capture",
    ]
    csv_path = out_dir / "trade_excursions.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=flat_fields)
        writer.writeheader()
        for row in records:
            writer.writerow(
                {
                    **{k: row.get(k) for k in flat_fields if k not in {"close_sources", "active_mfe_r", "active_mae_r", "horizon_mfe_r", "horizon_mae_r", "horizon_target_capture"}},
                    "close_sources": "|".join(row.get("close_sources") or []),
                    "active_mfe_r": row.get("active_trade_excursion", {}).get("mfe_r"),
                    "active_mae_r": row.get("active_trade_excursion", {}).get("mae_r"),
                    "horizon_mfe_r": row.get("fixed_horizon_excursion", {}).get("mfe_r"),
                    "horizon_mae_r": row.get("fixed_horizon_excursion", {}).get("mae_r"),
                    "horizon_target_capture": row.get("fixed_horizon_target_capture"),
                }
            )

    metadata = {
        "generated_at_utc": iso(int(time.time() * 1000)),
        "history_source": str(history_path),
        "candle_source": API_URL,
        "product_type": args.product_type,
        "granularity": args.granularity,
        "horizon_days": args.horizon_days,
        "completed_lifecycles": len(completed),
        "evaluated_trades": len(records),
        "orphan_close_fills": len(orphans),
        "still_active_lifecycles": len(active),
        "symbols": sorted(candles_by_symbol),
        "api_calls": api_calls,
        "trades_with_fill_residual_reconciliation": sum(1 for life, _ in trade_specs if life.reconciled_residual_qty > 0),
        "total_reconciled_residual_qty": sum(life.reconciled_residual_qty for life, _ in trade_specs),
        "download_intervals": interval_manifest,
        "method_note": "Primary reference is the FIFO lot snapshot at maximum filled exposure. Active excursion ends at final close; fixed excursion continues for the configured horizon. Candle extrema can include up to one partial first/last candle of bias.",
    }
    metadata_path = out_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(json.dumps({"out_dir": str(out_dir), "records": len(records), "symbols": len(candles_by_symbol), "api_calls": api_calls, "csv": str(csv_path), "json": str(json_path), "metadata": str(metadata_path)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
