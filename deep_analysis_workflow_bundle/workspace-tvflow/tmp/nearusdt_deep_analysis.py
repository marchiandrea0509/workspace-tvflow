from __future__ import annotations
import csv, json, statistics, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE='https://api.bitget.com'
SYMBOL='NEARUSDT'
TV_SYMBOL='NEARUSDT.P'
PRODUCT='USDT-FUTURES'
DATE='2026-05-07'
OUT=Path('reports/deep_analysis')
OUT.mkdir(parents=True, exist_ok=True)


def fetch(path, params):
    url=BASE+path+'?'+urllib.parse.urlencode(params)
    req=urllib.request.Request(url, headers={'User-Agent':'OpenClaw-tvflow'})
    with urllib.request.urlopen(req, timeout=60) as r:
        payload=json.loads(r.read().decode())
    if payload.get('code') not in (None,'00000'):
        raise RuntimeError({'url':url,'payload':payload})
    return payload.get('data')


def candles(gran, limit=300):
    rows=fetch('/api/v2/mix/market/candles', {'symbol':SYMBOL,'productType':PRODUCT,'granularity':gran,'limit':limit}) or []
    out=[]
    for row in sorted(rows, key=lambda x:int(x[0])):
        out.append({'ts':int(row[0]), 'dt':datetime.fromtimestamp(int(row[0])/1000, tz=timezone.utc).isoformat(),
                    'open':float(row[1]), 'high':float(row[2]), 'low':float(row[3]), 'close':float(row[4]),
                    'base_volume':float(row[5]), 'quote_volume':float(row[6])})
    return out


def ema(vals, n):
    k=2/(n+1); e=None; arr=[]
    for v in vals:
        e = v if e is None else v*k + e*(1-k)
        arr.append(e)
    return arr


def rsi(vals, n=14):
    gains=[]; losses=[]; out=[None]*len(vals); ag=al=None
    for i in range(1,len(vals)):
        d=vals[i]-vals[i-1]; gains.append(max(d,0)); losses.append(max(-d,0))
        if i==n:
            ag=sum(gains[:n])/n; al=sum(losses[:n])/n
        elif i>n:
            ag=(ag*(n-1)+gains[-1])/n; al=(al*(n-1)+losses[-1])/n
        else:
            continue
        out[i]=100 if al==0 else 100 - 100/(1+ag/al)
    return out


def atr_adx(rows,n=14):
    trs=[None]; pdm=[0]; mdm=[0]
    for i in range(1,len(rows)):
        h,l,pc=rows[i]['high'],rows[i]['low'],rows[i-1]['close']
        up=h-rows[i-1]['high']; dn=rows[i-1]['low']-l
        trs.append(max(h-l, abs(h-pc), abs(l-pc)))
        pdm.append(up if up>dn and up>0 else 0)
        mdm.append(dn if dn>up and dn>0 else 0)
    atr=[None]*len(rows); pdi=[None]*len(rows); mdi=[None]*len(rows); dx=[None]*len(rows); adx=[None]*len(rows)
    if len(rows)>n:
        trn=sum(x for x in trs[1:n+1]); pp=sum(pdm[1:n+1]); mm=sum(mdm[1:n+1])
        for i in range(n,len(rows)):
            if i>n:
                trn=trn-(trn/n)+trs[i]; pp=pp-(pp/n)+pdm[i]; mm=mm-(mm/n)+mdm[i]
            atr[i]=trn/n
            pdi[i]=100*(pp/trn) if trn else 0; mdi[i]=100*(mm/trn) if trn else 0
            dx[i]=100*abs(pdi[i]-mdi[i])/(pdi[i]+mdi[i]) if (pdi[i]+mdi[i]) else 0
        vals=[x for x in dx[n:n+n] if x is not None]
        if len(vals)==n:
            adx[2*n-1]=sum(vals)/n
            for i in range(2*n,len(rows)):
                adx[i]=(adx[i-1]*(n-1)+dx[i])/n
    return atr,pdi,mdi,adx


def enrich(rows):
    c=[r['close'] for r in rows]
    for n in [8,20,21,50,100,200]:
        e=ema(c,n)
        for r,v in zip(rows,e): r[f'ema{n}']=v
    rs=rsi(c,14); atr,pdi,mdi,adx=atr_adx(rows,14)
    for i,r in enumerate(rows):
        r['rsi14']=rs[i]; r['atr14']=atr[i]; r['plus_di14']=pdi[i]; r['minus_di14']=mdi[i]; r['adx14']=adx[i]
    return rows


def pivots(rows, look=3):
    highs=[]; lows=[]
    for i in range(look, len(rows)-look):
        h=rows[i]['high']; l=rows[i]['low']
        if all(h>=rows[j]['high'] for j in range(i-look,i+look+1) if j!=i): highs.append((i,h,rows[i]['dt']))
        if all(l<=rows[j]['low'] for j in range(i-look,i+look+1) if j!=i): lows.append((i,l,rows[i]['dt']))
    return highs,lows


def recent_swings(rows, look=3, n=8):
    highs,lows=pivots(rows, look)
    return {
        'highs': [{'i':i,'price':p,'dt':dt} for i,p,dt in highs[-n:]],
        'lows': [{'i':i,'price':p,'dt':dt} for i,p,dt in lows[-n:]],
    }


def snap(rows):
    r=rows[-1]; last20=rows[-20:]; last50=rows[-50:]; last80=rows[-80:]
    highs,lows=pivots(last80,3)
    above=[x for _,x,_ in highs if x>r['close']]
    below=[x for _,x,_ in lows if x<r['close']]
    prior_close=rows[-2]['close'] if len(rows)>1 else r['close']
    return {
        'last':r,
        'prior_close':prior_close,
        'range20_high':max(x['high'] for x in last20),'range20_low':min(x['low'] for x in last20),
        'range50_high':max(x['high'] for x in last50),'range50_low':min(x['low'] for x in last50),
        'range80_high':max(x['high'] for x in last80),'range80_low':min(x['low'] for x in last80),
        'piv_res': sorted(set(round(x,6) for x in above))[:10],
        'piv_sup': sorted(set(round(x,6) for x in below), reverse=True)[:10],
        'vol_sma20': statistics.mean([x['base_volume'] for x in last20]),
        'quote_vol_sma20': statistics.mean([x['quote_volume'] for x in last20]),
        'change_20bars_pct': (r['close']/rows[-21]['close']-1)*100 if len(rows)>21 else None,
        'change_50bars_pct': (r['close']/rows[-51]['close']-1)*100 if len(rows)>51 else None,
        'last_volume_vs_sma20': r['base_volume']/statistics.mean([x['base_volume'] for x in last20]) if statistics.mean([x['base_volume'] for x in last20]) else None,
        'recent_swings': recent_swings(rows[-120:],3,8),
    }


def find_latest_strategy_csv():
    root=Path(r'C:\Users\anmar\.openclaw\workspace\tradingview\reports\strategy_test_watchlist_csv')
    if not root.exists(): return None
    candidates=sorted(root.glob(f'**/{TV_SYMBOL}_strategy_test_4h.csv'), key=lambda p:p.stat().st_mtime, reverse=True)
    if not candidates: return None
    p=candidates[0]
    with p.open(encoding='utf-8-sig', newline='') as f:
        rows=list(csv.DictReader(f))
    good=[r for r in rows if r.get('02 Best Score') not in ('',None)]
    last=good[-1] if good else (rows[-1] if rows else {})
    fields=['time','open','high','low','close','EMA Fast','EMA Medium','EMA Slow','01 Best Setup','02 Best Score','03 Final Long','04 Final Short','05 Trend Dir','06 Macro Dir','07 Verdict','08 Conviction','09 Signal Dir','SQ01 Signals','SQ05 AvgEdgeRatio','SQ12 ResearchValid','D01 TacticalLong','D02 TacTrendLong','D03 TacBreakoutLong','D04 MacroLong','D10 BullPenaltyTotal','D13 LC Final','D16 SC Final','W01 LC ActionScore','W04 SC ActionScore','G01 Diag Long Adj','G02 Diag Short Adj','P01 Penalty_RSI_OB','P03 Penalty_TrendConflict','P04 Penalty_NoBullStructure','Volume','Volume MA']
    return {'path':str(p),'mtime':datetime.fromtimestamp(p.stat().st_mtime).isoformat(),'rows':len(rows),'last':{k:last.get(k) for k in fields if k in last}}


def find_latest_screener_row():
    root=Path(r'C:\Users\anmar\.openclaw\workspace\tradingview\reports\pine_screener')
    if not root.exists(): return None
    for p in sorted(root.glob('*.csv'), key=lambda p:p.stat().st_mtime, reverse=True)[:40]:
        try:
            with p.open(encoding='utf-8-sig', newline='') as f:
                rows=list(csv.DictReader(f))
        except Exception:
            continue
        row=next((r for r in rows if r.get('Symbol') in (TV_SYMBOL, f'BITGET:{TV_SYMBOL}')), None)
        if row:
            keys=['Symbol','01 Best Setup','02 Best Score','03 Final Long','04 Final Short','05 Trend Dir','06 Macro Dir','07 Verdict','08 Conviction','09 Signal Dir','SQ12 ResearchValid','D13 LC Final','D16 SC Final']
            return {'path':str(p),'mtime':datetime.fromtimestamp(p.stat().st_mtime).isoformat(),'row':{k:row.get(k) for k in keys if k in row}}
    return None

rows4=enrich(candles('4H',300)); rows1=enrich(candles('1D',300)); rows1h=enrich(candles('1H',300))
ticker=fetch('/api/v2/mix/market/ticker', {'symbol':SYMBOL,'productType':PRODUCT})
contracts=fetch('/api/v2/mix/market/contracts', {'productType':PRODUCT}) or []
contract=next((x for x in contracts if x.get('symbol')==SYMBOL),{})
fund=fetch('/api/v2/mix/market/current-fund-rate', {'symbol':SYMBOL,'productType':PRODUCT})
oi=fetch('/api/v2/mix/market/open-interest', {'symbol':SYMBOL,'productType':PRODUCT})
for gran, rows in [('4H',rows4),('1D',rows1),('1H',rows1h)]:
    path=OUT/f'{DATE}_{SYMBOL}_{gran}_bitget_ohlcv.csv'
    with path.open('w', newline='', encoding='utf-8') as f:
        w=csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
summary={'generated_utc':datetime.now(timezone.utc).isoformat(),'symbol':SYMBOL,'tv_symbol':TV_SYMBOL,'ticker':ticker,'funding':fund,'open_interest':oi,'contract':contract,'snap1h':snap(rows1h),'snap4h':snap(rows4),'snap1d':snap(rows1),'strategy_csv':find_latest_strategy_csv(),'screener_row':find_latest_screener_row()}
(OUT/f'{DATE}_{SYMBOL}_metrics.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps(summary, indent=2))
