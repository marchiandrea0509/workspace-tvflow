#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import html
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

WORKSPACE = Path(__file__).resolve().parents[1]
REPORT_DIR = WORKSPACE / 'reports' / 'trade_journal'


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


def ms_to_local(v: Any, tz: ZoneInfo) -> str:
    try:
        return datetime.fromtimestamp(int(v) / 1000, tz=timezone.utc).astimezone(tz).strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return ''


def as_float(v: Any) -> float:
    try:
        return float(v or 0)
    except Exception:
        return 0.0


def safe_div(a: float, b: float) -> float:
    return a / b if b else 0.0


def round_or_blank(v: float, ndigits: int = 4) -> float | str:
    if v == 0:
        return ''
    return round(v, ndigits)


def signed_order_risk_reward(o: dict[str, Any]) -> dict[str, Any]:
    """Derived static-risk metrics for a Bitget order row.

    Uses the original preset TP/SL fields when available. This is intentionally
    mechanical: it gives journal/statistical review fields, not a recommendation.
    """
    qty = as_float(o.get('baseVolume') or o.get('size'))
    order_qty = as_float(o.get('size'))
    entry = as_float(o.get('priceAvg') or o.get('price'))
    limit_price = as_float(o.get('price'))
    sl = as_float(o.get('presetStopLossPrice'))
    tp = as_float(o.get('presetStopSurplusPrice'))
    leverage = as_float(o.get('leverage'))
    quote_volume = as_float(o.get('quoteVolume')) or (entry * qty if entry and qty else 0.0)
    side = str(o.get('posSide') or '').lower()
    trade_side = str(o.get('tradeSide') or '').lower()
    risk_per_unit = reward_per_unit = 0.0
    if trade_side == 'open' and qty and entry and sl:
        if side == 'long':
            risk_per_unit = max(entry - sl, 0.0)
        elif side == 'short':
            risk_per_unit = max(sl - entry, 0.0)
    if trade_side == 'open' and qty and entry and tp:
        if side == 'long':
            reward_per_unit = max(tp - entry, 0.0)
        elif side == 'short':
            reward_per_unit = max(entry - tp, 0.0)
    planned_risk = risk_per_unit * qty
    planned_reward = reward_per_unit * qty
    rr = safe_div(planned_reward, planned_risk)
    fill_ratio = safe_div(qty, order_qty)
    entry_slip_per_unit = 0.0
    if trade_side == 'open' and entry and limit_price and qty:
        if side == 'long':
            entry_slip_per_unit = entry - limit_price
        elif side == 'short':
            entry_slip_per_unit = limit_price - entry
    return {
        'Planned Risk $': round_or_blank(planned_risk, 4),
        'Planned Reward $': round_or_blank(planned_reward, 4),
        'Planned R:R': round_or_blank(rr, 4),
        'Risk/Unit': round_or_blank(risk_per_unit, 6),
        'Reward/Unit': round_or_blank(reward_per_unit, 6),
        'Notional $': round_or_blank(quote_volume, 4),
        'Est Margin $': round_or_blank(safe_div(quote_volume, leverage), 4),
        'Fill Ratio': round_or_blank(fill_ratio, 4),
        'Entry Slip/Unit $': round_or_blank(entry_slip_per_unit, 6),
        'Entry Slip $': round_or_blank(entry_slip_per_unit * qty, 4),
        'Entry Slip bps': round_or_blank(safe_div(entry_slip_per_unit, limit_price) * 10000, 4) if limit_price else '',
    }


def most_common_sl_before(open_orders: list[dict[str, Any]], close_order: dict[str, Any]) -> float:
    symbol = close_order.get('symbol')
    pos_side = close_order.get('posSide')
    close_t = int(close_order.get('cTime') or 0)
    buckets: dict[str, float] = {}
    for row in open_orders:
        if row.get('symbol') != symbol or row.get('posSide') != pos_side:
            continue
        if row.get('tradeSide') != 'open' or not row.get('presetStopLossPrice'):
            continue
        if int(row.get('cTime') or 0) > close_t:
            continue
        qty = as_float(row.get('baseVolume') or row.get('size'))
        key = str(row.get('presetStopLossPrice'))
        buckets[key] = buckets.get(key, 0.0) + qty
    if not buckets:
        return 0.0
    return as_float(max(buckets.items(), key=lambda kv: kv[1])[0])


def build_stop_slippage_rows(orders: list[dict[str, Any]], tz: ZoneInfo) -> list[dict[str, Any]]:
    open_rows = [o for o in orders if o.get('tradeSide') == 'open']
    rows: list[dict[str, Any]] = []
    for o in sorted(orders, key=lambda x: int(x.get('cTime') or 0), reverse=True):
        if o.get('tradeSide') != 'close' or o.get('orderSource') != 'loss_market':
            continue
        qty = as_float(o.get('baseVolume') or o.get('size'))
        exit_px = as_float(o.get('priceAvg'))
        pos_avg = as_float(o.get('posAvg'))
        planned_sl = most_common_sl_before(open_rows, o)
        if not (qty and exit_px and planned_sl):
            continue
        side = str(o.get('posSide') or '').lower()
        if side == 'long':
            adverse_per_unit = planned_sl - exit_px
            actual_loss_unit = max(pos_avg - exit_px, 0.0) if pos_avg else 0.0
            planned_loss_unit = max(pos_avg - planned_sl, 0.0) if pos_avg else 0.0
            execution_side = 'sell into bid liquidity'
        elif side == 'short':
            adverse_per_unit = exit_px - planned_sl
            actual_loss_unit = max(exit_px - pos_avg, 0.0) if pos_avg else 0.0
            planned_loss_unit = max(planned_sl - pos_avg, 0.0) if pos_avg else 0.0
            execution_side = 'buy into ask liquidity'
        else:
            continue
        adverse_slip = max(adverse_per_unit, 0.0)
        planned_loss = planned_loss_unit * qty
        actual_price_loss = actual_loss_unit * qty
        extra_slippage = adverse_slip * qty
        fee = abs(as_float(o.get('fee')))
        rows.append({
            'Time Berlin': ms_to_local(o.get('cTime'), tz),
            'Symbol': o.get('symbol', ''),
            'Position Side': o.get('posSide', ''),
            'Qty': o.get('baseVolume') or o.get('size') or '',
            'Pos Avg': o.get('posAvg', ''),
            'Planned SL': planned_sl,
            'Exit Avg': o.get('priceAvg', ''),
            'Adverse Slip/Unit $': round(adverse_slip, 6),
            'Adverse Slip bps': round(safe_div(adverse_slip, planned_sl) * 10000, 4),
            'Planned Price Loss $': round(planned_loss, 4),
            'Actual Price Loss $': round(actual_price_loss, 4),
            'Extra Slippage $': round(extra_slippage, 4),
            'Close Fee $': round(fee, 4),
            'Actual/Planned Loss x': round(safe_div(actual_price_loss, planned_loss), 4),
            'Execution Side': execution_side,
            'Order ID': o.get('orderId', ''),
            'Order Source': o.get('orderSource', ''),
            'Review Note': 'Stop-market execution: compare adverse slippage with symbol liquidity/depth before adjusting thresholds.',
        })
    return rows


def build_market_liquidity_rows(path: str | Path) -> list[dict[str, Any]]:
    raw = load_json(path)
    rows: list[dict[str, Any]] = []
    for r in (raw.get('rows') or []) if isinstance(raw, dict) else []:
        if not r.get('ok'):
            rows.append({'Symbol': r.get('symbol', ''), 'Status': 'ERROR', 'Notes': r.get('error', '')})
            continue
        spread_bps = as_float(r.get('spreadBps'))
        qv = as_float(r.get('quoteVolume24h'))
        min_depth_1 = min(as_float(r.get('bidDepth1Quote')), as_float(r.get('askDepth1Quote')))
        if qv < 2_000_000 or min_depth_1 < 25_000 or spread_bps > 25:
            tier = 'HIGH_RISK_THIN'
        elif qv < 10_000_000 or min_depth_1 < 100_000 or spread_bps > 10:
            tier = 'WATCH'
        else:
            tier = 'OK'
        rows.append({
            'Captured UTC': r.get('capturedAt', ''),
            'Symbol': r.get('symbol', ''),
            'Status': tier,
            'Last': round_or_blank(as_float(r.get('last')), 6),
            'Mark': round_or_blank(as_float(r.get('mark')), 6),
            'Bid': round_or_blank(as_float(r.get('bid')), 6),
            'Ask': round_or_blank(as_float(r.get('ask')), 6),
            'Spread bps': round(spread_bps, 4),
            '24h Quote Vol $': round(qv, 2),
            'Holding Amount': round_or_blank(as_float(r.get('holdingAmount')), 4),
            'Bid Depth 0.5% $': round(as_float(r.get('bidDepth05Quote')), 2),
            'Ask Depth 0.5% $': round(as_float(r.get('askDepth05Quote')), 2),
            'Bid Depth 1% $': round(as_float(r.get('bidDepth1Quote')), 2),
            'Ask Depth 1% $': round(as_float(r.get('askDepth1Quote')), 2),
            'Bid Depth 2% $': round(as_float(r.get('bidDepth2Quote')), 2),
            'Ask Depth 2% $': round(as_float(r.get('askDepth2Quote')), 2),
            'Notes': 'Bid depth matters for long SL sell exits; ask depth matters for short SL buy exits.',
        })
    return rows


def build_symbol_metric_rows(stop_rows: list[dict[str, Any]], market_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_symbol: dict[str, list[dict[str, Any]]] = {}
    for row in stop_rows:
        by_symbol.setdefault(str(row.get('Symbol')), []).append(row)
    market_by_symbol = {str(r.get('Symbol')): r for r in market_rows}
    symbols = sorted(set(by_symbol) | set(market_by_symbol))
    rows: list[dict[str, Any]] = []
    for sym in symbols:
        srows = by_symbol.get(sym, [])
        planned = sum(as_float(r.get('Planned Price Loss $')) for r in srows)
        actual = sum(as_float(r.get('Actual Price Loss $')) for r in srows)
        extra = sum(as_float(r.get('Extra Slippage $')) for r in srows)
        qty = sum(as_float(r.get('Qty')) for r in srows)
        worst_bps = max([as_float(r.get('Adverse Slip bps')) for r in srows] or [0.0])
        worst_x = max([as_float(r.get('Actual/Planned Loss x')) for r in srows] or [0.0])
        m = market_by_symbol.get(sym, {})
        rows.append({
            'Symbol': sym,
            'Stop Events': len(srows),
            'Stopped Qty': round_or_blank(qty, 4),
            'Planned Stop Loss $': round_or_blank(planned, 4),
            'Actual Stop Price Loss $': round_or_blank(actual, 4),
            'Extra Stop Slippage $': round_or_blank(extra, 4),
            'Extra/Planned %': round_or_blank(safe_div(extra, planned) * 100, 2),
            'Worst Slip bps': round_or_blank(worst_bps, 4),
            'Worst Actual/Planned x': round_or_blank(worst_x, 4),
            'Liquidity Status': m.get('Status', ''),
            'Spread bps Now': m.get('Spread bps', ''),
            '24h Quote Vol $ Now': m.get('24h Quote Vol $', ''),
            'Bid Depth 1% $ Now': m.get('Bid Depth 1% $', ''),
            'Ask Depth 1% $ Now': m.get('Ask Depth 1% $', ''),
            'Threshold Review Hint': 'raise slippage buffer / reduce size' if extra > 0 else ('watch liquidity before placement' if m.get('Status') in ('WATCH', 'HIGH_RISK_THIN') else ''),
        })
    return rows


def get_result(history: dict[str, Any], label: str) -> dict[str, Any]:
    for row in history.get('results') or []:
        if row.get('label') == label:
            return row
    return {}


def arr_from_data(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ('entrustedList', 'fillList', 'orderList', 'orders', 'list'):
        value = data.get(key)
        if isinstance(value, list):
            return value
    return []


def flatten_fee_detail(fee_detail: Any) -> str:
    if not isinstance(fee_detail, list):
        return ''
    return '; '.join(f"{f.get('feeCoin', '')}: {f.get('totalFee', '')}" for f in fee_detail)


def esc(x: Any) -> str:
    return html.escape('' if x is None else str(x))


def table(rows: list[dict[str, Any]], cols: list[str]) -> str:
    out = ['<table border="1"><tr>']
    out.extend(f'<th>{esc(c)}</th>' for c in cols)
    out.append('</tr>')
    for row in rows:
        out.append('<tr>')
        out.extend(f'<td>{esc(row.get(c, ""))}</td>' for c in cols)
        out.append('</tr>')
    out.append('</table>')
    return ''.join(out)


def html_sheet(name: str, rows: list[dict[str, Any]], cols: list[str], note: str = '') -> str:
    return f'<h2>{esc(name)}</h2>' + (f'<p>{esc(note)}</p>' if note else '') + table(rows, cols) + '<br/>'


def list_open_orders(paths: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        raw = load_json(path)
        if isinstance(raw, dict):
            rows.extend(raw.get('regular') or [])
            rows.extend(raw.get('plan') or [])
    return rows


def order_key(o: dict[str, Any]) -> str:
    return str(o.get('orderId') or o.get('planOrderId') or o.get('clientOid') or '')


def history_by_order_id(orders: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in orders:
        key = str(row.get('orderId') or row.get('planOrderId') or '')
        if key and key not in out:
            out[key] = row
    return out


def detect_open_order_change_rows(previous: list[dict[str, Any]], current: list[dict[str, Any]], orders: list[dict[str, Any]], tz: ZoneInfo) -> list[dict[str, Any]]:
    prev_by_id = {order_key(o): o for o in previous if order_key(o)}
    curr_by_id = {order_key(o): o for o in current if order_key(o)}
    hist_by_id = history_by_order_id(orders)
    rows: list[dict[str, Any]] = []

    def base(event: str, oid: str, src: dict[str, Any]) -> dict[str, Any]:
        h = hist_by_id.get(oid, {})
        return {
            'Detected At': datetime.now(tz).strftime('%Y-%m-%d %H:%M:%S'),
            'Event': event,
            'Symbol': src.get('symbol', ''),
            'Order ID': oid,
            'Client OID': src.get('clientOid', ''),
            'Trade Side': src.get('tradeSide', ''),
            'Order Side': src.get('side', ''),
            'Position Side': src.get('posSide', ''),
            'Qty': src.get('size', ''),
            'Price': src.get('price', ''),
            'TP': src.get('presetStopSurplusPrice', ''),
            'SL': src.get('presetStopLossPrice', ''),
            'History Status': h.get('status', ''),
            'History Fill Qty': h.get('baseVolume', ''),
            'History Avg Price': h.get('priceAvg', ''),
            'Details': '',
        }

    for oid in sorted(prev_by_id.keys() - curr_by_id.keys()):
        row = base('REMOVED_FROM_ACTIVE', oid, prev_by_id[oid])
        row['Details'] = 'Order existed in previous open-order snapshot but is absent now; check History Status for cancel/fill outcome.'
        rows.append(row)

    for oid in sorted(curr_by_id.keys() - prev_by_id.keys()):
        row = base('NEW_ACTIVE', oid, curr_by_id[oid])
        row['Details'] = 'Order is active now but was absent from previous open-order snapshot.'
        rows.append(row)

    watched = [
        ('size', 'Qty'),
        ('price', 'Price'),
        ('presetStopSurplusPrice', 'TP'),
        ('presetStopLossPrice', 'SL'),
        ('status', 'Status'),
        ('baseVolume', 'Filled'),
        ('leverage', 'Leverage'),
        ('marginMode', 'Margin Mode'),
    ]
    for oid in sorted(prev_by_id.keys() & curr_by_id.keys()):
        old = prev_by_id[oid]
        new = curr_by_id[oid]
        diffs = []
        for key, label in watched:
            if str(old.get(key) or '') != str(new.get(key) or ''):
                diffs.append(f"{label}: {old.get(key, '')} -> {new.get(key, '')}")
        if diffs:
            row = base('UPDATED_ACTIVE', oid, new)
            row['Details'] = '; '.join(diffs)
            rows.append(row)

    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description='Build a Bitget semi-auto futures trade log workbook from mirrored Bitget API artifacts.')
    ap.add_argument('--history-json', default=str(REPORT_DIR / 'raw_bitget_history_latest.json'))
    ap.add_argument('--open-orders-json', action='append', default=[])
    ap.add_argument('--previous-open-orders-json', action='append', default=[])
    ap.add_argument('--positions-json', default=str(REPORT_DIR / 'raw_positions_latest.json'))
    ap.add_argument('--market-metrics-json', default='')
    ap.add_argument('--out-xls', default=str(REPORT_DIR / 'bitget_futures_trade_report_latest.xls'))
    ap.add_argument('--out-csv', default=str(REPORT_DIR / 'bitget_futures_order_history_latest.csv'))
    ap.add_argument('--timezone', default='Europe/Berlin')
    args = ap.parse_args()

    tz = ZoneInfo(args.timezone)
    history = load_json(args.history_json)
    orders = arr_from_data(get_result(history, 'orders-history').get('data'))
    fills = arr_from_data(get_result(history, 'fills').get('data'))
    plans = arr_from_data(get_result(history, 'orders-plan-history').get('data'))
    open_orders = list_open_orders(args.open_orders_json)
    previous_open_orders = list_open_orders(args.previous_open_orders_json)
    positions_raw = load_json(args.positions_json)
    positions = ((positions_raw.get('result') or {}).get('data') or []) if isinstance(positions_raw, dict) else []
    market_rows = build_market_liquidity_rows(args.market_metrics_json) if args.market_metrics_json else []

    order_rows: list[dict[str, Any]] = []
    for o in sorted(orders, key=lambda x: int(x.get('cTime') or 0), reverse=True):
        pnl = as_float(o.get('totalProfits')) + as_float(o.get('fee'))
        derived = signed_order_risk_reward(o)
        order_rows.append({
            'Time Berlin': ms_to_local(o.get('cTime'), tz),
            'Update Berlin': ms_to_local(o.get('uTime'), tz),
            'Exchange': 'Bitget Futures',
            'Symbol': o.get('symbol', ''),
            'Status': o.get('status', ''),
            'Trade Side': o.get('tradeSide', ''),
            'Order Side': o.get('side', ''),
            'Position Side': o.get('posSide', ''),
            'Order Type': o.get('orderType', ''),
            'Source': o.get('enterPointSource', '') or o.get('orderSource', ''),
            'Qty': o.get('baseVolume') or o.get('size', ''),
            'Order Qty': o.get('size', ''),
            'Limit Price': o.get('price', ''),
            'Avg Price': o.get('priceAvg', ''),
            'Quote Volume': o.get('quoteVolume', ''),
            'Leverage': o.get('leverage', ''),
            'Margin Mode': o.get('marginMode', ''),
            'TP': o.get('presetStopSurplusPrice', ''),
            'SL': o.get('presetStopLossPrice', ''),
            'Fee': o.get('fee', ''),
            'Realized PnL': o.get('totalProfits', ''),
            'Net PnL Est': round(pnl, 8),
            **derived,
            'Order ID': o.get('orderId', ''),
            'Client OID': o.get('clientOid', ''),
            'Notes': '',
        })

    fill_rows: list[dict[str, Any]] = []
    for f in sorted(fills, key=lambda x: int(x.get('cTime') or 0), reverse=True):
        fill_rows.append({
            'Time Berlin': ms_to_local(f.get('cTime'), tz),
            'Exchange': 'Bitget Futures',
            'Symbol': f.get('symbol', ''),
            'Trade Side': f.get('tradeSide', ''),
            'Order Side': f.get('side', ''),
            'Scope': f.get('tradeScope', ''),
            'Price': f.get('price', ''),
            'Qty': f.get('baseVolume', ''),
            'Quote Volume': f.get('quoteVolume', ''),
            'Profit': f.get('profit', ''),
            'Fee Detail': flatten_fee_detail(f.get('feeDetail')),
            'Order ID': f.get('orderId', ''),
            'Trade ID': f.get('tradeId', ''),
            'Source': f.get('enterPointSource', ''),
        })

    open_rows: list[dict[str, Any]] = []
    for o in sorted(open_orders, key=lambda x: int(x.get('cTime') or 0), reverse=True):
        open_rows.append({
            'Created Berlin': ms_to_local(o.get('cTime'), tz),
            'Exchange': 'Bitget Futures',
            'Symbol': o.get('symbol', ''),
            'Status': o.get('status', ''),
            'Trade Side': o.get('tradeSide', ''),
            'Order Side': o.get('side', ''),
            'Position Side': o.get('posSide', ''),
            'Order Type': o.get('orderType', ''),
            'Qty': o.get('size', ''),
            'Price': o.get('price', ''),
            'TP': o.get('presetStopSurplusPrice', ''),
            'SL': o.get('presetStopLossPrice', ''),
            'Leverage': o.get('leverage', ''),
            'Margin Mode': o.get('marginMode', ''),
            'Order ID': o.get('orderId', ''),
            'Client OID': o.get('clientOid', ''),
        })

    pos_rows = [{
        'Symbol': p.get('symbol', ''),
        'Side': p.get('holdSide', ''),
        'Qty Total': p.get('total', ''),
        'Available': p.get('available', ''),
        'Avg Entry': p.get('openPriceAvg', ''),
        'Mark Price': p.get('markPrice', ''),
        'Unrealized PnL': p.get('unrealizedPL', ''),
        'Leverage': p.get('leverage', ''),
        'Margin Mode': p.get('marginMode', ''),
        'Margin Size': p.get('marginSize', ''),
        'Liquidation Price': p.get('liquidationPrice', ''),
        'Break Even': p.get('breakEvenPrice', ''),
    } for p in positions]

    change_rows = detect_open_order_change_rows(previous_open_orders, open_orders, orders, tz) if previous_open_orders else []
    stop_slippage_rows = build_stop_slippage_rows(orders, tz)
    symbol_metric_rows = build_symbol_metric_rows(stop_slippage_rows, market_rows)

    journal_rows: list[dict[str, Any]] = []
    for r in order_rows:
        journal_rows.append({
            'Trade Date': r['Time Berlin'][:10],
            'Exchange': 'Bitget Futures',
            'Symbol': r['Symbol'],
            'Execution Mode': 'semi-auto',
            'Signal/Setup': 'tvflow / Pine screener' if str(r['Client OID']).startswith('tvflow') else '',
            'Direction': str(r['Position Side']).upper(),
            'Action': r['Trade Side'],
            'Status': r['Status'],
            'Entry Time': r['Time Berlin'] if r['Trade Side'] == 'open' else '',
            'Exit Time': r['Time Berlin'] if r['Trade Side'] == 'close' else '',
            'Entry Price': r['Avg Price'] if r['Trade Side'] == 'open' else '',
            'Exit Price': r['Avg Price'] if r['Trade Side'] == 'close' else '',
            'Qty': r['Qty'],
            'Leverage': r['Leverage'],
            'TP Planned': r['TP'],
            'SL Planned': r['SL'],
            'Planned Risk $': r.get('Planned Risk $', ''),
            'Planned Reward $': r.get('Planned Reward $', ''),
            'Planned R:R': r.get('Planned R:R', ''),
            'Notional $': r.get('Notional $', ''),
            'Est Margin $': r.get('Est Margin $', ''),
            'Fill Ratio': r.get('Fill Ratio', ''),
            'Gross PnL': r['Realized PnL'],
            'Fees': r['Fee'],
            'Net PnL Est': r['Net PnL Est'],
            'TradingView/Analysis Ref': '',
            'Risk/Invalidation Notes': '',
            'Order ID': r['Order ID'],
            'Client OID': r['Client OID'],
            'Review Notes': '',
        })

    realized = sum(as_float(r.get('Realized PnL')) for r in order_rows)
    fees = sum(as_float(r.get('Fee')) for r in order_rows)
    net = sum(as_float(r.get('Net PnL Est')) for r in order_rows)
    total_extra_slip = sum(as_float(r.get('Extra Slippage $')) for r in stop_slippage_rows)
    worst_stop_bps = max([as_float(r.get('Adverse Slip bps')) for r in stop_slippage_rows] or [0.0])
    high_risk_liquidity_count = sum(1 for r in market_rows if r.get('Status') == 'HIGH_RISK_THIN')
    summary = [
        {'Metric': 'Generated at', 'Value': datetime.now(tz).strftime('%Y-%m-%d %H:%M:%S %Z')},
        {'Metric': 'History source', 'Value': str(args.history_json)},
        {'Metric': 'Mirror scope', 'Value': 'All reachable Bitget futures history returned by the API artifact'},
        {'Metric': 'Closed/history orders', 'Value': len(order_rows)},
        {'Metric': 'Fills', 'Value': len(fill_rows)},
        {'Metric': 'Plan/order-plan history', 'Value': len(plans)},
        {'Metric': 'Current active orders', 'Value': len(open_rows)},
        {'Metric': 'Current positions', 'Value': len(pos_rows)},
        {'Metric': 'Open-order state changes vs previous refresh', 'Value': len(change_rows) if previous_open_orders else 'previous snapshot unavailable'},
        {'Metric': 'Stop-market slippage events tracked', 'Value': len(stop_slippage_rows)},
        {'Metric': 'Total extra stop slippage $', 'Value': round(total_extra_slip, 8)},
        {'Metric': 'Worst stop slippage bps', 'Value': round(worst_stop_bps, 4)},
        {'Metric': 'Market liquidity symbols captured', 'Value': len(market_rows)},
        {'Metric': 'High-risk thin liquidity symbols now', 'Value': high_risk_liquidity_count},
        {'Metric': 'Realized PnL gross from order history', 'Value': round(realized, 8)},
        {'Metric': 'Fees from order history', 'Value': round(fees, 8)},
        {'Metric': 'Net PnL estimate', 'Value': round(net, 8)},
        {'Metric': 'Workflow', 'Value': 'Bitget semi-auto: TradingView/Pine signal context plus confirmed Bitget futures execution state.'},
        {'Metric': 'Safety note', 'Value': 'Read-only report/log. Do not infer permission to place, cancel, or modify orders from this workbook.'},
    ]

    cols_summary = ['Metric', 'Value']
    cols_journal = ['Trade Date', 'Exchange', 'Symbol', 'Execution Mode', 'Signal/Setup', 'Direction', 'Action', 'Status', 'Entry Time', 'Exit Time', 'Entry Price', 'Exit Price', 'Qty', 'Leverage', 'TP Planned', 'SL Planned', 'Planned Risk $', 'Planned Reward $', 'Planned R:R', 'Notional $', 'Est Margin $', 'Fill Ratio', 'Gross PnL', 'Fees', 'Net PnL Est', 'TradingView/Analysis Ref', 'Risk/Invalidation Notes', 'Order ID', 'Client OID', 'Review Notes']
    cols_orders = ['Time Berlin', 'Update Berlin', 'Exchange', 'Symbol', 'Status', 'Trade Side', 'Order Side', 'Position Side', 'Order Type', 'Source', 'Qty', 'Order Qty', 'Limit Price', 'Avg Price', 'Quote Volume', 'Leverage', 'Margin Mode', 'TP', 'SL', 'Planned Risk $', 'Planned Reward $', 'Planned R:R', 'Risk/Unit', 'Reward/Unit', 'Notional $', 'Est Margin $', 'Fill Ratio', 'Entry Slip/Unit $', 'Entry Slip $', 'Entry Slip bps', 'Fee', 'Realized PnL', 'Net PnL Est', 'Order ID', 'Client OID', 'Notes']
    cols_fills = ['Time Berlin', 'Exchange', 'Symbol', 'Trade Side', 'Order Side', 'Scope', 'Price', 'Qty', 'Quote Volume', 'Profit', 'Fee Detail', 'Order ID', 'Trade ID', 'Source']
    cols_open = ['Created Berlin', 'Exchange', 'Symbol', 'Status', 'Trade Side', 'Order Side', 'Position Side', 'Order Type', 'Qty', 'Price', 'TP', 'SL', 'Leverage', 'Margin Mode', 'Order ID', 'Client OID']
    cols_pos = ['Symbol', 'Side', 'Qty Total', 'Available', 'Avg Entry', 'Mark Price', 'Unrealized PnL', 'Leverage', 'Margin Mode', 'Margin Size', 'Liquidation Price', 'Break Even']
    cols_changes = ['Detected At', 'Event', 'Symbol', 'Order ID', 'Client OID', 'Trade Side', 'Order Side', 'Position Side', 'Qty', 'Price', 'TP', 'SL', 'History Status', 'History Fill Qty', 'History Avg Price', 'Details']
    cols_stop_slip = ['Time Berlin', 'Symbol', 'Position Side', 'Qty', 'Pos Avg', 'Planned SL', 'Exit Avg', 'Adverse Slip/Unit $', 'Adverse Slip bps', 'Planned Price Loss $', 'Actual Price Loss $', 'Extra Slippage $', 'Close Fee $', 'Actual/Planned Loss x', 'Execution Side', 'Order ID', 'Order Source', 'Review Note']
    cols_market = ['Captured UTC', 'Symbol', 'Status', 'Last', 'Mark', 'Bid', 'Ask', 'Spread bps', '24h Quote Vol $', 'Holding Amount', 'Bid Depth 0.5% $', 'Ask Depth 0.5% $', 'Bid Depth 1% $', 'Ask Depth 1% $', 'Bid Depth 2% $', 'Ask Depth 2% $', 'Notes']
    cols_symbol_metrics = ['Symbol', 'Stop Events', 'Stopped Qty', 'Planned Stop Loss $', 'Actual Stop Price Loss $', 'Extra Stop Slippage $', 'Extra/Planned %', 'Worst Slip bps', 'Worst Actual/Planned x', 'Liquidity Status', 'Spread bps Now', '24h Quote Vol $ Now', 'Bid Depth 1% $ Now', 'Ask Depth 1% $ Now', 'Threshold Review Hint']

    html_doc = f'''<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><style>td,th{{font-family:Calibri,Arial;font-size:11pt;white-space:nowrap}} th{{background:#D9EAF7;font-weight:bold}} h2{{font-family:Calibri,Arial}}</style></head><body>
<h1>Bitget Semi-Auto Futures Trade Report</h1>
{html_sheet('Summary', summary, cols_summary)}
{html_sheet('Semi-Auto Trade Log', journal_rows, cols_journal, 'Bitget-specific working log. Group entries manually into setups/campaigns; add TradingView context, invalidation, and review notes as needed.')}
{html_sheet('Order History', order_rows, cols_orders)}
{html_sheet('Fills', fill_rows, cols_fills)}
{html_sheet('Liquidity & Slippage Metrics', symbol_metric_rows, cols_symbol_metrics, 'Per-symbol review surface for threshold tuning. Combines historical stop-market slippage with current spread/volume/depth snapshots when available.')}
{html_sheet('Stop Slippage Events', stop_slippage_rows, cols_stop_slip, 'Derived from Bitget loss_market close orders. Planned SL is inferred from prior filled open orders on the same symbol/side; use this to tune liquidity/slippage gates.')}
{html_sheet('Market Liquidity Snapshot', market_rows, cols_market, 'Current ticker/orderbook snapshot for tracked symbols. Bid depth matters for long stop exits; ask depth matters for short stop exits.')}
{html_sheet('Open Order State Changes', change_rows, cols_changes, 'Diff between previous and current open-order snapshots for tracked symbols; catches manual cancels/modifications made directly on Bitget.')}
{html_sheet('Active Orders', open_rows, cols_open)}
{html_sheet('Positions Snapshot', pos_rows, cols_pos)}
</body></html>'''

    out_xls = Path(args.out_xls)
    out_csv = Path(args.out_csv)
    out_xls.parent.mkdir(parents=True, exist_ok=True)
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    out_xls.write_text(html_doc, encoding='utf-8')
    with out_csv.open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=cols_orders)
        writer.writeheader()
        writer.writerows(order_rows)

    print(json.dumps({'ok': True, 'xls': str(out_xls), 'csv': str(out_csv), 'orders': len(order_rows), 'fills': len(fill_rows), 'openOrders': len(open_rows), 'positions': len(pos_rows), 'netPnlEst': round(net, 8)}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
