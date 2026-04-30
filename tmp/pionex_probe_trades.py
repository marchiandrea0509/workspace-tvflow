from __future__ import annotations
import hashlib,hmac,json,time
from pathlib import Path
from urllib.parse import urlencode
import requests

BASE='https://api.pionex.com'
ENV=Path(r'C:\Users\anmar\.openclaw\credentials\pionex.env')

def load_env(path):
    d={}
    for line in path.read_text().splitlines():
        line=line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k,v=line.split('=',1); d[k.strip()]=v.strip()
    return d

def get(key,secret,path,params=None):
    p=dict(params or {}); p['timestamp']=str(int(time.time()*1000))
    qs=urlencode(sorted((str(k),str(v)) for k,v in p.items()), safe=':_')
    path_url=f'{path}?{qs}'
    sig=hmac.new(secret.encode(),('GET'+path_url).encode(),hashlib.sha256).hexdigest()
    r=requests.get(BASE+path_url,headers={'PIONEX-KEY':key,'PIONEX-SIGNATURE':sig},timeout=20)
    try: js=r.json()
    except Exception: js=None
    return {'status':r.status_code,'json':js,'text':r.text[:500]}

env=load_env(ENV); key=env['PIONEX_API_KEY']; secret=env['PIONEX_API_SECRET']
for path,params in [
    ('/uapi/v1/trade/historyOrders',{}),
    ('/uapi/v1/trade/historyOrders',{'limit':'100'}),
    ('/uapi/v1/trade/fills',{}),
    ('/uapi/v1/trade/fills',{'limit':'100'}),
    ('/uapi/v1/trade/fills',{'symbol':'BTC_USDT_PERP'}),
]:
    res=get(key,secret,path,params)
    print('\n###',path,params)
    print(json.dumps({'status':res['status'],'json':res['json']},indent=2)[:4000])
