from __future__ import annotations
import csv, json, math, statistics, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE='https://api.bitget.com'
SYMBOL='GOOGLUSDT'
PRODUCT='USDT-FUTURES'
OUT=Path('reports/deep_analysis')
OUT.mkdir(parents=True, exist_ok=True)

def fetch(path, params):
    url=BASE+path+'?'+urllib.parse.urlencode(params)
    req=urllib.request.Request(url, headers={'User-Agent':'OpenClaw-tvflow'})
    with urllib.request.urlopen(req, timeout=60) as r:
        payload=json.loads(r.read().decode())
    if payload.get('code') not in (None,'00000'):
        raise RuntimeError(payload)
    return payload.get('data')

def candles(gran, limit=200):
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
    gains=[]; losses=[]; out=[None]*len(vals)
    for i in range(1,len(vals)):
        d=vals[i]-vals[i-1]; gains.append(max(d,0)); losses.append(max(-d,0))
        if i==n:
            ag=sum(gains[:n])/n; al=sum(losses[:n])/n
        elif i>n:
            ag=(ag*(n-1)+gains[-1])/n; al=(al*(n-1)+losses[-1])/n
        else: continue
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

def pivots(rows, look=3):
    highs=[]; lows=[]
    for i in range(look, len(rows)-look):
        h=rows[i]['high']; l=rows[i]['low']
        if all(h>=rows[j]['high'] for j in range(i-look,i+look+1) if j!=i): highs.append((i,h,rows[i]['dt']))
        if all(l<=rows[j]['low'] for j in range(i-look,i+look+1) if j!=i): lows.append((i,l,rows[i]['dt']))
    return highs,lows

def enrich(rows):
    c=[r['close'] for r in rows]
    for n in [20,21,50,100,200]:
        e=ema(c,n)
        for r,v in zip(rows,e): r[f'ema{n}']=v
    rs=rsi(c,14); atr,pdi,mdi,adx=atr_adx(rows,14)
    for i,r in enumerate(rows):
        r['rsi14']=rs[i]; r['atr14']=atr[i]; r['plus_di14']=pdi[i]; r['minus_di14']=mdi[i]; r['adx14']=adx[i]
    return rows

def snap(rows):
    r=rows[-1]; last20=rows[-20:]; last50=rows[-50:]
    highs,lows=pivots(rows[-80:],3)
    # adjust pivot indices ignored
    above=[x for _,x,_ in highs if x>r['close']]
    below=[x for _,x,_ in lows if x<r['close']]
    return {
        'last':r,
        'range20_high':max(x['high'] for x in last20),'range20_low':min(x['low'] for x in last20),
        'range50_high':max(x['high'] for x in last50),'range50_low':min(x['low'] for x in last50),
        'piv_res': sorted(above)[:5],
        'piv_sup': sorted(below, reverse=True)[:5],
        'vol_sma20': statistics.mean([x['base_volume'] for x in last20]),
    }

rows4=enrich(candles('4H',220)); rows1=enrich(candles('1D',220))
ticker=fetch('/api/v2/mix/market/ticker', {'symbol':SYMBOL,'productType':PRODUCT})
contracts=fetch('/api/v2/mix/market/contracts', {'productType':PRODUCT}) or []
contract=next((x for x in contracts if x.get('symbol')==SYMBOL),{})
fund=fetch('/api/v2/mix/market/current-fund-rate', {'symbol':SYMBOL,'productType':PRODUCT})
oi=fetch('/api/v2/mix/market/open-interest', {'symbol':SYMBOL,'productType':PRODUCT})
for gran, rows in [('4H',rows4),('1D',rows1)]:
    path=OUT/f'2026-04-30_GOOGLUSDT_{gran}_bitget_ohlcv.csv'
    with path.open('w', newline='', encoding='utf-8') as f:
        w=csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
s4=snap(rows4); s1=snap(rows1)
summary={'generated_utc':datetime.now(timezone.utc).isoformat(),'symbol':SYMBOL,'ticker':ticker,'funding':fund,'open_interest':oi,'contract':contract,'snap4h':s4,'snap1d':s1}
(OUT/'2026-04-30_GOOGLUSDT_metrics.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps(summary, indent=2))
