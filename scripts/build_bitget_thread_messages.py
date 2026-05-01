#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

WORKSPACE = Path(__file__).resolve().parents[1]
DEFAULT_REPORT_DIR = WORKSPACE / 'reports' / 'trade_journal'
MAX_CHARS = 1800


def load_json(path: str | Path) -> Any:
    p = Path(path)
    if not p.exists():
        return {}
    for enc in ('utf-8', 'utf-16', 'utf-8-sig'):
        try:
            return json.loads(p.read_text(encoding=enc))
        except UnicodeDecodeError:
            continue
    return json.loads(p.read_text(encoding='utf-8', errors='ignore'))


def fmt(x: Any) -> str:
    if x is None or x == '':
        return 'n/a'
    if isinstance(x, float):
        return f'{x:.2f}'
    return str(x)


def as_float(x: Any) -> float:
    try:
        return float(x or 0)
    except Exception:
        return 0.0


def ms_to_local(v: Any, tz: ZoneInfo) -> str:
    try:
        return datetime.fromtimestamp(int(v) / 1000, tz=timezone.utc).astimezone(tz).strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return 'n/a'


def chunk_text(text: str, max_chars: int = MAX_CHARS) -> list[str]:
    blocks = text.split('\n\n')
    out: list[str] = []
    current = ''
    for block in blocks:
        candidate = block if not current else current + '\n\n' + block
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            out.append(current)
            current = ''
        while len(block) > max_chars:
            split_at = block.rfind('\n', 0, max_chars)
            if split_at <= 0:
                split_at = max_chars
            out.append(block[:split_at])
            block = block[split_at:].lstrip('\n')
        current = block
    if current:
        out.append(current)
    return out


def result_by_label(history: dict[str, Any], label: str) -> dict[str, Any]:
    for row in history.get('results') or []:
        if row.get('label') == label:
            return row
    return {}


def list_from_data(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ('entrustedList', 'fillList', 'orderList', 'orders', 'list'):
        value = data.get(key)
        if isinstance(value, list):
            return value
    return []


def open_orders_from_file(path: str | Path) -> list[dict[str, Any]]:
    raw = load_json(path)
    if not isinstance(raw, dict):
        return []
    rows: list[dict[str, Any]] = []
    for key in ('regular', 'plan'):
        value = raw.get(key)
        if isinstance(value, list):
            rows.extend(value)
    return rows


def positions_from_file(path: str | Path) -> list[dict[str, Any]]:
    raw = load_json(path)
    if not isinstance(raw, dict):
        return []
    return ((raw.get('result') or {}).get('data') or [])


def build_summary(history: dict[str, Any], open_orders: list[dict[str, Any]], positions: list[dict[str, Any]], workbook: str, tz: ZoneInfo) -> str:
    orders = list_from_data((result_by_label(history, 'orders-history').get('data') or {}))
    fills = list_from_data((result_by_label(history, 'fills').get('data') or {}))
    plan_history = list_from_data((result_by_label(history, 'orders-plan-history').get('data') or {}))
    gross = sum(as_float(o.get('totalProfits')) for o in orders)
    fees = sum(as_float(o.get('fee')) for o in orders)
    net = gross + fees
    lines = []
    lines.append('Bitget semi-auto trade report')
    lines.append(f"Generated: {datetime.now(tz).strftime('%Y-%m-%d %H:%M:%S %Z')}")
    lines.append('Mode: TradingView/Pine signal side + confirmed Bitget futures execution')
    lines.append(f"History: orders {len(orders)} | fills {len(fills)} | plan/order-plan history {len(plan_history)}")
    lines.append(f"Current: active orders {len(open_orders)} | positions {len(positions)}")
    lines.append(f"Realized PnL gross: {gross:.2f} USDT | fees: {fees:.2f} | net est: {net:.2f} USDT")
    if workbook:
        lines.append(f"Local log/workbook: {workbook}")
    lines.append('Read-only snapshot; not an instruction to place/cancel/modify orders.')
    return '\n'.join(lines)


def build_open_orders_message(open_orders: list[dict[str, Any]], tz: ZoneInfo) -> str:
    if not open_orders:
        return 'Active Bitget futures orders: none.'
    lines = ['Active Bitget futures orders / planned legs']
    for o in sorted(open_orders, key=lambda x: int(x.get('cTime') or 0), reverse=True)[:12]:
        lines.append(
            f"- {o.get('symbol')} {o.get('tradeSide')}/{o.get('side')} {o.get('posSide')} "
            f"qty {fmt(o.get('size'))} @ {fmt(o.get('price'))} | TP {fmt(o.get('presetStopSurplusPrice'))} "
            f"SL {fmt(o.get('presetStopLossPrice'))} | {fmt(o.get('marginMode'))} {fmt(o.get('leverage'))}x | "
            f"id {o.get('orderId')}"
        )
    if len(open_orders) > 12:
        lines.append(f"... plus {len(open_orders) - 12} more")
    return '\n'.join(lines)


def build_positions_message(positions: list[dict[str, Any]]) -> str:
    if not positions:
        return 'Current Bitget futures positions: none.'
    lines = ['Current Bitget futures positions']
    for p in positions:
        lines.append(
            f"- {p.get('symbol')} {p.get('holdSide')} qty {fmt(p.get('total'))} | avg {fmt(p.get('openPriceAvg'))} "
            f"mark {fmt(p.get('markPrice'))} | uPnL {fmt(p.get('unrealizedPL'))} | liq {fmt(p.get('liquidationPrice'))} | "
            f"{fmt(p.get('marginMode'))} {fmt(p.get('leverage'))}x"
        )
    return '\n'.join(lines)


def build_recent_history_message(history: dict[str, Any], tz: ZoneInfo, limit: int) -> str:
    orders = list_from_data((result_by_label(history, 'orders-history').get('data') or {}))
    orders = sorted(orders, key=lambda x: int(x.get('cTime') or 0), reverse=True)[:limit]
    if not orders:
        return 'Recent Bitget futures executions: none found.'
    lines = [f'Recent Bitget futures executions (latest {len(orders)})']
    for o in orders:
        pnl = as_float(o.get('totalProfits')) + as_float(o.get('fee'))
        lines.append(
            f"- {ms_to_local(o.get('cTime'), tz)} | {o.get('symbol')} {o.get('tradeSide')}/{o.get('side')} {o.get('posSide')} "
            f"qty {fmt(o.get('baseVolume') or o.get('size'))} avg {fmt(o.get('priceAvg'))} | "
            f"status {o.get('status')} | PnL {as_float(o.get('totalProfits')):.2f} fee {as_float(o.get('fee')):.2f} net {pnl:.2f} | "
            f"id {o.get('orderId')}"
        )
    return '\n'.join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description='Build Discord-safe Bitget futures trade report messages.')
    ap.add_argument('--history-json', default=str(DEFAULT_REPORT_DIR / 'raw_bitget_history_90d_2026-04-30.json'))
    ap.add_argument('--open-orders-json', action='append', default=[])
    ap.add_argument('--positions-json', default=str(DEFAULT_REPORT_DIR / 'raw_positions_2026-04-30.json'))
    ap.add_argument('--workbook', default=str(DEFAULT_REPORT_DIR / 'bitget_futures_trade_report_2026-04-30.xls'))
    ap.add_argument('--recent-limit', type=int, default=8)
    ap.add_argument('--timezone', default='Europe/Berlin')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    tz = ZoneInfo(args.timezone)
    history = load_json(args.history_json)
    open_paths = args.open_orders_json or [
        str(DEFAULT_REPORT_DIR / 'raw_open_orders_GOOGL_2026-04-30.json'),
        str(DEFAULT_REPORT_DIR / 'raw_open_orders_GME_2026-04-30.json'),
    ]
    open_orders: list[dict[str, Any]] = []
    for path in open_paths:
        open_orders.extend(open_orders_from_file(path))
    positions = positions_from_file(args.positions_json)

    messages: list[str] = []
    messages.extend(chunk_text(build_summary(history, open_orders, positions, args.workbook, tz)))
    messages.extend(chunk_text(build_open_orders_message(open_orders, tz)))
    messages.extend(chunk_text(build_positions_message(positions)))
    messages.extend(chunk_text(build_recent_history_message(history, tz, args.recent_limit)))

    payload = {
        'messages': messages,
        'source': {
            'history_json': args.history_json,
            'open_orders_json': open_paths,
            'positions_json': args.positions_json,
            'workbook': args.workbook,
        },
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'ok': True, 'out': str(out), 'message_count': len(messages)}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
