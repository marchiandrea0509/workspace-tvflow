import csv, importlib.util
from pathlib import Path
from zoneinfo import ZoneInfo
spec=importlib.util.spec_from_file_location('b', 'scripts/build_bitget_trade_report.py')
b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
h=b.load_json('reports/trade_journal/raw_bitget_history_latest.json')
orders=[]
for row in h.get('results',[]):
    if row.get('label')=='orders-history': orders=row.get('data') or []
market=b.build_market_liquidity_rows('reports/trade_journal/raw_market_metrics_latest.json')
stop=b.build_stop_slippage_rows(orders, ZoneInfo('Europe/Berlin'))
sym=b.build_symbol_metric_rows(stop, market)
out=Path('reports/trade_journal')
stop_path=out/'old_trade_stop_slippage_events_latest.csv'
sym_path=out/'old_trade_liquidity_slippage_metrics_latest.csv'
cols_stop=['Time Berlin','Symbol','Position Side','Qty','Pos Avg','Planned SL','Exit Avg','Adverse Slip/Unit $','Adverse Slip bps','Planned Price Loss $','Actual Price Loss $','Extra Slippage $','Close Fee $','Actual/Planned Loss x','Execution Side','Order ID','Order Source','Review Note']
cols_sym=['Symbol','Stop Events','Stopped Qty','Planned Stop Loss $','Actual Stop Price Loss $','Extra Stop Slippage $','Extra/Planned %','Worst Slip bps','Worst Actual/Planned x','Liquidity Status','Spread bps Now','24h Quote Vol $ Now','Bid Depth 1% $ Now','Ask Depth 1% $ Now','Threshold Review Hint']
for p, rows, cols in [(stop_path, stop, cols_stop),(sym_path, sym, cols_sym)]:
    with p.open('w', newline='', encoding='utf-8-sig') as f:
        w=csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader(); w.writerows(rows)
print(stop_path)
print(sym_path)
