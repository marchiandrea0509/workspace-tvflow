import json, importlib.util
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
print('STOP_EVENTS', len(stop))
print('SYMBOL_METRICS')
for r in sorted([x for x in sym if x.get('Stop Events')], key=lambda x: float(x.get('Extra Stop Slippage $') or 0), reverse=True):
    print(r)
print('\nSTOP_ROWS')
for r in sorted(stop, key=lambda x: float(x.get('Extra Slippage $') or 0), reverse=True):
    print(r)
