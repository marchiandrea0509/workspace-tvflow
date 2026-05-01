from __future__ import annotations
import json, html, re
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT=Path.cwd()
REPORT_DIR=ROOT/'reports'/'trade_journal'
HISTORY=REPORT_DIR/'raw_bitget_history_90d_2026-04-30.json'
OPEN_FILES=[REPORT_DIR/'raw_open_orders_GOOGL_2026-04-30.json', REPORT_DIR/'raw_open_orders_GME_2026-04-30.json']
POSITIONS=REPORT_DIR/'raw_positions_2026-04-30.json'
OUT=REPORT_DIR/'bitget_futures_trade_report_2026-04-30.xls'
CSV=REPORT_DIR/'bitget_futures_order_history_2026-04-30.csv'
TZ=ZoneInfo('Europe/Berlin')

def load(path):
    path = Path(path)
    if not path.exists():
        return {}
    for enc in ('utf-8', 'utf-16', 'utf-8-sig'):
        try:
            return json.loads(path.read_text(encoding=enc))
        except UnicodeDecodeError:
            continue
    return json.loads(path.read_text(encoding='utf-8', errors='ignore'))

def ms_to_local(v):
    try:
        return datetime.fromtimestamp(int(v)/1000, tz=timezone.utc).astimezone(TZ).strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return ''

def as_float(v):
    try: return float(v or 0)
    except Exception: return 0.0

def get_result(history, label):
    for r in history.get('results',[]):
        if r.get('label')==label:
            return r
    return {}

def arr_from_data(data):
    if isinstance(data,list): return data
    if not isinstance(data,dict): return []
    for k in ['entrustedList','fillList','orderList','orders','list']:
        if isinstance(data.get(k),list): return data[k]
    return []

def flatten_fee_detail(fee_detail):
    if not isinstance(fee_detail,list): return ''
    bits=[]
    for f in fee_detail:
        bits.append(f"{f.get('feeCoin','')}: {f.get('totalFee','')}")
    return '; '.join(bits)

def esc(x):
    return html.escape('' if x is None else str(x))

def table(rows, cols):
    s=['<table border="1"><tr>']
    for c in cols: s.append(f'<th>{esc(c)}</th>')
    s.append('</tr>')
    for r in rows:
        s.append('<tr>')
        for c in cols:
            v = r.get(c,'') if isinstance(r,dict) else ''
            s.append(f'<td>{esc(v)}</td>')
        s.append('</tr>')
    s.append('</table>')
    return ''.join(s)

def sheet(name, rows, cols, note=''):
    return f'''<x:ExcelWorksheet><x:Name>{esc(name)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet>'''

def html_sheet(name, rows, cols, note=''):
    # Excel opens each h2/table fine; not true separate tabs, but preserves structure in .xls HTML.
    return f'<h2>{esc(name)}</h2>' + (f'<p>{esc(note)}</p>' if note else '') + table(rows, cols) + '<br/>'

history=load(HISTORY)
orders=arr_from_data(get_result(history,'orders-history').get('data'))
fills=arr_from_data(get_result(history,'fills').get('data'))
plans=arr_from_data(get_result(history,'orders-plan-history').get('data'))

open_orders=[]
for p in OPEN_FILES:
    j=load(p)
    open_orders += j.get('regular',[]) if isinstance(j,dict) else []
positions_raw=load(POSITIONS)
positions=((positions_raw.get('result') or {}).get('data') or []) if isinstance(positions_raw,dict) else []

order_rows=[]
for o in sorted(orders, key=lambda x:int(x.get('cTime') or 0), reverse=True):
    pnl=as_float(o.get('totalProfits'))+as_float(o.get('fee'))
    order_rows.append({
        'Time Berlin': ms_to_local(o.get('cTime')),
        'Update Berlin': ms_to_local(o.get('uTime')),
        'Exchange': 'Bitget Futures',
        'Symbol': o.get('symbol',''),
        'Status': o.get('status',''),
        'Trade Side': o.get('tradeSide',''),
        'Order Side': o.get('side',''),
        'Position Side': o.get('posSide',''),
        'Order Type': o.get('orderType',''),
        'Source': o.get('enterPointSource','') or o.get('orderSource',''),
        'Qty': o.get('baseVolume') or o.get('size',''),
        'Order Qty': o.get('size',''),
        'Limit Price': o.get('price',''),
        'Avg Price': o.get('priceAvg',''),
        'Quote Volume': o.get('quoteVolume',''),
        'Leverage': o.get('leverage',''),
        'Margin Mode': o.get('marginMode',''),
        'TP': o.get('presetStopSurplusPrice',''),
        'SL': o.get('presetStopLossPrice',''),
        'Fee': o.get('fee',''),
        'Realized PnL': o.get('totalProfits',''),
        'Net PnL Est': round(pnl,8),
        'Order ID': o.get('orderId',''),
        'Client OID': o.get('clientOid',''),
        'Notes': '',
    })

fill_rows=[]
for f in sorted(fills, key=lambda x:int(x.get('cTime') or 0), reverse=True):
    fill_rows.append({
        'Time Berlin': ms_to_local(f.get('cTime')),
        'Exchange': 'Bitget Futures',
        'Symbol': f.get('symbol',''),
        'Trade Side': f.get('tradeSide',''),
        'Order Side': f.get('side',''),
        'Scope': f.get('tradeScope',''),
        'Price': f.get('price',''),
        'Qty': f.get('baseVolume',''),
        'Quote Volume': f.get('quoteVolume',''),
        'Profit': f.get('profit',''),
        'Fee Detail': flatten_fee_detail(f.get('feeDetail')),
        'Order ID': f.get('orderId',''),
        'Trade ID': f.get('tradeId',''),
        'Source': f.get('enterPointSource',''),
    })

open_rows=[]
for o in sorted(open_orders, key=lambda x:int(x.get('cTime') or 0), reverse=True):
    open_rows.append({
        'Created Berlin': ms_to_local(o.get('cTime')),
        'Exchange': 'Bitget Futures',
        'Symbol': o.get('symbol',''),
        'Status': o.get('status',''),
        'Trade Side': o.get('tradeSide',''),
        'Order Side': o.get('side',''),
        'Position Side': o.get('posSide',''),
        'Order Type': o.get('orderType',''),
        'Qty': o.get('size',''),
        'Price': o.get('price',''),
        'TP': o.get('presetStopSurplusPrice',''),
        'SL': o.get('presetStopLossPrice',''),
        'Leverage': o.get('leverage',''),
        'Margin Mode': o.get('marginMode',''),
        'Order ID': o.get('orderId',''),
        'Client OID': o.get('clientOid',''),
    })

pos_rows=[]
for p in positions:
    pos_rows.append({
        'Symbol': p.get('symbol',''),
        'Side': p.get('holdSide',''),
        'Qty Total': p.get('total',''),
        'Available': p.get('available',''),
        'Avg Entry': p.get('openPriceAvg',''),
        'Mark Price': p.get('markPrice',''),
        'Unrealized PnL': p.get('unrealizedPL',''),
        'Leverage': p.get('leverage',''),
        'Margin Mode': p.get('marginMode',''),
        'Margin Size': p.get('marginSize',''),
        'Liquidation Price': p.get('liquidationPrice',''),
        'Break Even': p.get('breakEvenPrice',''),
    })

# Bitget semi-auto working log: each order row can later be grouped into a setup/campaign.
journal_rows=[]
for r in order_rows:
    journal_rows.append({
        'Trade Date': r['Time Berlin'][:10],
        'Exchange': 'Bitget Futures',
        'Symbol': r['Symbol'],
        'Execution Mode': 'semi-auto',
        'Signal/Setup': 'tvflow / Pine screener' if str(r['Client OID']).startswith('tvflow') else '',
        'Direction': r['Position Side'].upper(),
        'Action': r['Trade Side'],
        'Status': r['Status'],
        'Entry Time': r['Time Berlin'] if r['Trade Side']=='open' else '',
        'Exit Time': r['Time Berlin'] if r['Trade Side']=='close' else '',
        'Entry Price': r['Avg Price'] if r['Trade Side']=='open' else '',
        'Exit Price': r['Avg Price'] if r['Trade Side']=='close' else '',
        'Qty': r['Qty'],
        'Leverage': r['Leverage'],
        'TP Planned': r['TP'],
        'SL Planned': r['SL'],
        'Gross PnL': r['Realized PnL'],
        'Fees': r['Fee'],
        'Net PnL Est': r['Net PnL Est'],
        'TradingView/Analysis Ref': '',
        'Risk/Invalidation Notes': '',
        'Order ID': r['Order ID'],
        'Client OID': r['Client OID'],
        'Review Notes': '',
    })

realized=sum(as_float(r.get('Realized PnL')) for r in order_rows)
fees=sum(as_float(r.get('Fee')) for r in order_rows)
net=sum(as_float(r.get('Net PnL Est')) for r in order_rows)
summary=[
    {'Metric':'Generated at','Value':datetime.now(TZ).strftime('%Y-%m-%d %H:%M:%S %Z')},
    {'Metric':'History source','Value':str(HISTORY)},
    {'Metric':'History window requested','Value':'90 days'},
    {'Metric':'Closed/history orders','Value':len(order_rows)},
    {'Metric':'Fills','Value':len(fill_rows)},
    {'Metric':'Current open orders','Value':len(open_rows)},
    {'Metric':'Current positions','Value':len(pos_rows)},
    {'Metric':'Realized PnL gross from order history','Value':round(realized,8)},
    {'Metric':'Fees from order history','Value':round(fees,8)},
    {'Metric':'Net PnL estimate','Value':round(net,8)},
    {'Metric':'Workflow','Value':'Bitget semi-auto: TradingView/Pine signal context plus confirmed Bitget futures execution state.'},
    {'Metric':'Safety note','Value':'Read-only report/log. Do not infer permission to place, cancel, or modify orders from this workbook.'},
]

cols_summary=['Metric','Value']
cols_journal=['Trade Date','Exchange','Symbol','Execution Mode','Signal/Setup','Direction','Action','Status','Entry Time','Exit Time','Entry Price','Exit Price','Qty','Leverage','TP Planned','SL Planned','Gross PnL','Fees','Net PnL Est','TradingView/Analysis Ref','Risk/Invalidation Notes','Order ID','Client OID','Review Notes']
cols_orders=['Time Berlin','Update Berlin','Exchange','Symbol','Status','Trade Side','Order Side','Position Side','Order Type','Source','Qty','Order Qty','Limit Price','Avg Price','Quote Volume','Leverage','Margin Mode','TP','SL','Fee','Realized PnL','Net PnL Est','Order ID','Client OID','Notes']
cols_fills=['Time Berlin','Exchange','Symbol','Trade Side','Order Side','Scope','Price','Qty','Quote Volume','Profit','Fee Detail','Order ID','Trade ID','Source']
cols_open=['Created Berlin','Exchange','Symbol','Status','Trade Side','Order Side','Position Side','Order Type','Qty','Price','TP','SL','Leverage','Margin Mode','Order ID','Client OID']
cols_pos=['Symbol','Side','Qty Total','Available','Avg Entry','Mark Price','Unrealized PnL','Leverage','Margin Mode','Margin Size','Liquidation Price','Break Even']

html_doc=f'''<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><style>td,th{{font-family:Calibri,Arial;font-size:11pt;white-space:nowrap}} th{{background:#D9EAF7;font-weight:bold}} h2{{font-family:Calibri,Arial}}</style></head><body>
<h1>Bitget Semi-Auto Futures Trade Report</h1>
{html_sheet('Summary', summary, cols_summary)}
{html_sheet('Semi-Auto Trade Log', journal_rows, cols_journal, 'Bitget-specific working log. Group entries manually into setups/campaigns; add TradingView context, invalidation, and review notes as needed.')}
{html_sheet('Order History', order_rows, cols_orders)}
{html_sheet('Fills', fill_rows, cols_fills)}
{html_sheet('Open Orders', open_rows, cols_open)}
{html_sheet('Positions Snapshot', pos_rows, cols_pos)}
</body></html>'''
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(html_doc, encoding='utf-8')

# CSV order history sidecar
import csv
with CSV.open('w', newline='', encoding='utf-8-sig') as f:
    w=csv.DictWriter(f, fieldnames=cols_orders)
    w.writeheader(); w.writerows(order_rows)

print(json.dumps({'xls':str(OUT),'csv':str(CSV),'summary':summary}, indent=2))
