const symbol='GOOGLUSDT'; const productType='USDT-FUTURES';
const base='https://api.bitget.com';
async function get(path, params){ const url=base+path+'?'+new URLSearchParams(params); const r=await fetch(url); const j=await r.json(); if(j.code!=='00000') throw new Error(url+' '+JSON.stringify(j)); return j.data; }
function num(x){return Number(x)}
function toCandles(data){return data.map(d=>({ts:+d[0], time:new Date(+d[0]).toISOString(), open:num(d[1]), high:num(d[2]), low:num(d[3]), close:num(d[4]), vol:num(d[5]), quoteVol:num(d[6])})).sort((a,b)=>a.ts-b.ts)}
function ema(vals, n){ const k=2/(n+1); let out=[]; let e=null; for(let i=0;i<vals.length;i++){ const v=vals[i]; if(e==null){ if(i<n-1){ out.push(null); continue;} e=vals.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n; } else e=v*k+e*(1-k); out.push(e);} return out; }
function atr(c,n){ let trs=[]; for(let i=0;i<c.length;i++){ const prev=i?c[i-1].close:c[i].close; trs.push(Math.max(c[i].high-c[i].low, Math.abs(c[i].high-prev), Math.abs(c[i].low-prev)));} return ema(trs,n); }
function rsi(c,n=14){ let gains=[], losses=[], out=[]; for(let i=1;i<c.length;i++){ const ch=c[i].close-c[i-1].close; gains.push(Math.max(ch,0)); losses.push(Math.max(-ch,0)); }
 let ag=null, al=null; out=[null]; for(let i=0;i<gains.length;i++){ if(ag==null){ if(i<n-1){out.push(null); continue;} ag=gains.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n; al=losses.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n; } else { ag=(ag*(n-1)+gains[i])/n; al=(al*(n-1)+losses[i])/n;} out.push(al===0?100:100-(100/(1+ag/al))); } return out; }
function adx(c,n=14){ let tr=[], pdm=[], mdm=[]; for(let i=1;i<c.length;i++){ const up=c[i].high-c[i-1].high; const down=c[i-1].low-c[i].low; pdm.push((up>down&&up>0)?up:0); mdm.push((down>up&&down>0)?down:0); tr.push(Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close))); }
 function wilder(arr){let out=[]; let s=null; for(let i=0;i<arr.length;i++){ if(s==null){ if(i<n-1){out.push(null); continue;} s=arr.slice(i-n+1,i+1).reduce((a,b)=>a+b,0); } else s=s-(s/n)+arr[i]; out.push(s);} return out;}
 const atrs=wilder(tr), p=wilder(pdm), m=wilder(mdm); let dx=[]; for(let i=0;i<tr.length;i++){ if(atrs[i]==null){dx.push(null); continue;} const pdi=100*p[i]/atrs[i], mdi=100*m[i]/atrs[i]; dx.push((pdi+mdi===0)?0:100*Math.abs(pdi-mdi)/(pdi+mdi)); }
 let ad=[]; let s=null; for(let i=0;i<dx.length;i++){ if(dx[i]==null){ad.push(null); continue;} if(s==null){ const recent=dx.slice(Math.max(0,i-n+1),i+1).filter(x=>x!=null); if(recent.length<n){ad.push(null); continue;} s=recent.reduce((a,b)=>a+b,0)/n; } else s=(s*(n-1)+dx[i])/n; ad.push(s);} return [null,...ad];}
function pivots(c,left=2,right=2){ let highs=[], lows=[]; for(let i=left;i<c.length-right;i++){ let ph=true,pl=true; for(let j=i-left;j<=i+right;j++){ if(j===i)continue; if(c[j].high>=c[i].high) ph=false; if(c[j].low<=c[i].low) pl=false; } if(ph) highs.push({i, time:c[i].time, price:c[i].high}); if(pl) lows.push({i, time:c[i].time, price:c[i].low}); } return {highs,lows}; }
function fmt(x){return x==null?null:+x.toFixed(4)}
function summarize(tf,c){ const closes=c.map(x=>x.close); const e20=ema(closes,20), e50=ema(closes,50), e100=ema(closes,100), a14=atr(c,14), r14=rsi(c,14), ad=adx(c,14); const p=pivots(c,2,2); const last=c.at(-1); const prev=c.at(-2); const hi20=Math.max(...c.slice(-20).map(x=>x.high)); const lo20=Math.min(...c.slice(-20).map(x=>x.low)); const hi50=Math.max(...c.slice(-50).map(x=>x.high)); const lo50=Math.min(...c.slice(-50).map(x=>x.low)); const volAvg20=c.slice(-21,-1).reduce((s,x)=>s+x.quoteVol,0)/20; const relVol=last.quoteVol/(volAvg20||1); return {tf, bars:c.length,last,prev, ema20:fmt(e20.at(-1)), ema50:fmt(e50.at(-1)), ema100:fmt(e100.at(-1)), atr14:fmt(a14.at(-1)), atrPct:fmt(a14.at(-1)/last.close*100), rsi14:fmt(r14.at(-1)), adx14:fmt(ad.at(-1)), hi20:fmt(hi20), lo20:fmt(lo20), hi50:fmt(hi50), lo50:fmt(lo50), relVol:fmt(relVol), recentPivotHighs:p.highs.slice(-8).map(x=>({time:x.time, price:fmt(x.price)})), recentPivotLows:p.lows.slice(-8).map(x=>({time:x.time, price:fmt(x.price)})), last10:c.slice(-10).map(x=>({time:x.time,o:x.open,h:x.high,l:x.low,c:x.close,quoteVol:fmt(x.quoteVol)}))}; }
(async()=>{
 const [d4h,d1h,d1d,ticker,oi,fr] = await Promise.all([
  get('/api/v2/mix/market/candles',{symbol,productType,granularity:'4H',limit:'200'}).then(toCandles),
  get('/api/v2/mix/market/candles',{symbol,productType,granularity:'1H',limit:'200'}).then(toCandles).catch(e=>({error:e.message})),
  get('/api/v2/mix/market/candles',{symbol,productType,granularity:'1D',limit:'200'}).then(toCandles),
  get('/api/v2/mix/market/ticker',{symbol,productType}).catch(e=>({error:e.message})),
  get('/api/v2/mix/market/open-interest',{symbol,productType}).catch(e=>({error:e.message})),
  get('/api/v2/mix/market/current-fund-rate',{symbol,productType}).catch(e=>({error:e.message}))
 ]);
 const out={now:new Date().toISOString(), symbol, ticker, openInterest:oi, funding:fr, summaries:[summarize('1D',d1d), summarize('4H',d4h), Array.isArray(d1h)?summarize('1H',d1h):d1h]};
 console.log(JSON.stringify(out,null,2));
})();
