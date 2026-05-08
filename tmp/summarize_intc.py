import json
from pathlib import Path
j=json.loads(Path('reports/deep_analysis/2026-05-08_INTCUSDT_metrics.json').read_text())
def rr(x,n=4):
    try: return round(float(x),n)
    except Exception: return x
def last(s): return j[s]['last']
print('ticker', j['ticker'])
print('funding', j['funding'])
print('oi', j['open_interest'])
print('contract', {k:j['contract'].get(k) for k in ['pricePlace','volumePlace','minTradeNum','minTradeUSDT','maxLever','symbolStatus']})
for s in ['snap1h','snap4h','snap1d']:
    l=last(s); print('\n'+s)
    print({k:rr(l.get(k)) for k in ['open','high','low','close','ema8','ema20','ema21','ema50','ema100','ema200','rsi14','atr14','plus_di14','minus_di14','adx14']}, 'dt', l.get('dt'))
    print('ranges', {k:rr(j[s][k]) if isinstance(j[s].get(k),(int,float)) else j[s].get(k) for k in ['range20_high','range20_low','range50_high','range50_low','range80_high','range80_low','change_20bars_pct','change_50bars_pct','last_volume_vs_sma20']})
    print('piv_res', j[s]['piv_res'][:8])
    print('piv_sup', j[s]['piv_sup'][:8])
    print('sw highs', j[s]['recent_swings']['highs'][-5:])
    print('sw lows', j[s]['recent_swings']['lows'][-5:])
print('\nstrategy', j['strategy_csv'])
print('\nscreener', j['screener_row'])
