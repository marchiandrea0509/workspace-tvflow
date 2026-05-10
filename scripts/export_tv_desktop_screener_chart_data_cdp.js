const fs = require('fs');
const path = require('path');

async function getJson(url){ const r=await fetch(url); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
class CDP{
  constructor(ws){ this.ws=new WebSocket(ws); this.id=0; this.pending=new Map(); this.events=[]; this.ws.onmessage=(ev)=>{ const msg=JSON.parse(ev.data); if(msg.id&&this.pending.has(msg.id)){ const {res,rej}=this.pending.get(msg.id); this.pending.delete(msg.id); msg.error?rej(new Error(JSON.stringify(msg.error))):res(msg.result); } else if(msg.method){ this.events.push(msg); } }; }
  async open(){ await new Promise((res,rej)=>{ this.ws.onopen=res; this.ws.onerror=()=>rej(new Error('ws error')); setTimeout(()=>rej(new Error('ws timeout')),10000); }); }
  send(method,params={},timeout=15000){ const id=++this.id; this.ws.send(JSON.stringify({id,method,params})); return new Promise((res,rej)=>{ this.pending.set(id,{res,rej}); setTimeout(()=>{ if(this.pending.has(id)){this.pending.delete(id); rej(new Error(`${method} timeout`));}},timeout); }); }
  close(){ try{this.ws.close();}catch{} }
}
function csvSplit(line){ const out=[]; let cur='', q=false; for(let i=0;i<line.length;i++){ const ch=line[i]; if(ch==='"'){ if(q && line[i+1]==='"'){cur+='"'; i++;} else q=!q; continue;} if(ch===','&&!q){out.push(cur); cur=''; continue;} cur+=ch;} out.push(cur); return out; }
function validateCsv(p){ const text=fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''); const lines=text.split(/\r?\n/).filter(x=>x.trim()); const headers=lines.length?csvSplit(lines[0]).map(x=>x.trim()):[]; const required=['02 Best Score','D13 LC Final','D16 SC Final','W04 SC ActionScore','SQ12 ResearchValid']; return {path:p,size:fs.statSync(p).size,rowCount:Math.max(0,lines.length-1),headers,requiredPresent:required.filter(c=>headers.includes(c)),requiredMissing:required.filter(c=>!headers.includes(c)),sampleHeaders:headers.slice(0,80)}; }
async function main(){
  const outDir=path.resolve('reports','mcp_screener_export_test',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(outDir,{recursive:true});
  const version=await getJson('http://127.0.0.1:9222/json/version');
  const browser=new CDP(version.webSocketDebuggerUrl); await browser.open();
  try { await browser.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:outDir,eventsEnabled:true},5000); } catch(e){ console.error('[warn] Browser.setDownloadBehavior failed:', e.message); }

  const pages=(await getJson('http://127.0.0.1:9222/json')).filter(p=>p.type==='page' && /^https:\/\/www\.tradingview\.com\/chart\//.test(p.url||''));
  let chosen=null, chosenInfo=null;
  for(const p of pages){
    const c=new CDP(p.webSocketDebuggerUrl); await c.open();
    try{
      await c.send('Runtime.enable');
      const expr=`(()=>{ const body=document.body?.innerText||''; const active=[...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')||'').find(x=>/Active layout:/i.test(x))||''; const symbol=(body.match(/BITGET:[A-Z0-9]+USDT\\.P/)||body.match(/[A-Z0-9]+USDT\\.P/)||[''])[0]; return {active, symbol, title:document.title, url:location.href, body:body.slice(0,1000)}; })()`;
      const r=await c.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
      const val=r.result.value;
      if(/Active layout:\s*Screener/i.test(val.active||'')){ chosen=p; chosenInfo=val; c.close(); break; }
    } finally { c.close(); }
  }
  if(!chosen) throw new Error('No TradingView chart page with Active layout: Screener found');

  const page=new CDP(chosen.webSocketDebuggerUrl); await page.open();
  const manifest={outDir, version, target:chosen, chosenInfo, steps:[]};
  try{
    await page.send('Runtime.enable');
    await page.send('Page.enable').catch(()=>null);
    await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',windowsVirtualKeyCode:27,code:'Escape'}).catch(()=>null);
    await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',windowsVirtualKeyCode:27,code:'Escape'}).catch(()=>null);
    await sleep(500);
    let r=await page.send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:`(()=>{ const b=document.querySelector('button[data-name="save-load-menu"], [data-name="save-load-menu"]'); if(!b) return {ok:false, reason:'save-load-menu not found'}; b.click(); return {ok:true, text:b.innerText, aria:b.getAttribute('aria-label')}; })()`});
    manifest.steps.push({openMenu:r.result.value});
    if(!r.result.value?.ok) throw new Error('Could not open save/load menu');
    await sleep(900);
    r=await page.send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:`(()=>{ const visible=e=>{const r=e.getBoundingClientRect(); const cs=getComputedStyle(e); return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'}; const items=[...document.querySelectorAll('[role="row"],[role="menuitem"],button,span,div')].filter(e=>visible(e)&&/Download chart data/i.test((e.innerText||e.textContent||'')+' '+(e.getAttribute('aria-label')||''))).map(e=>{const txt=(e.innerText||e.textContent||'').trim(); const r=e.getBoundingClientRect(); return {e,txt,x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,score:txt.length + (e.getAttribute('role')==='row'? -100:0) + (e.getAttribute('role')==='menuitem'? -100:0)};}).sort((a,b)=>a.score-b.score); const hit=items[0]; if(!hit) return {ok:false, reason:'Download chart data menu item not found', body:(document.body.innerText||'').slice(0,2000)}; return {ok:true, text:hit.txt, x:hit.x, y:hit.y, w:hit.w, h:hit.h, candidates:items.slice(0,5).map(i=>({text:i.txt,w:i.w,h:i.h,score:i.score}))}; })()`});
    const item=r.result.value; manifest.steps.push({downloadItem:item});
    if(!item.ok) throw new Error(item.reason);
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:item.x,y:item.y,button:'left',clickCount:1});
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:item.x,y:item.y,button:'left',clickCount:1});
    await sleep(1200);
    r=await page.send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:`(()=>{ const body=document.body.innerText||''; const visible=e=>{const r=e.getBoundingClientRect(); const cs=getComputedStyle(e); return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'}; const btn=[...document.querySelectorAll('button,[role="button"]')].find(e=>visible(e)&&/^Download$/i.test((e.innerText||e.textContent||'').trim())); return {dialog:/Download chart data/i.test(body), hasCsv:/CSV file/i.test(body), button:!!btn, body:body.slice(0,2500)}; })()`});
    manifest.steps.push({dialog:r.result.value});
    if(!r.result.value?.button) throw new Error('Download button not found after dialog open');
    const before=new Set(fs.existsSync(outDir)?fs.readdirSync(outDir):[]);
    r=await page.send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:`(()=>{ const visible=e=>{const r=e.getBoundingClientRect(); const cs=getComputedStyle(e); return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'}; const btn=[...document.querySelectorAll('button,[role="button"]')].find(e=>visible(e)&&/^Download$/i.test((e.innerText||e.textContent||'').trim())); if(!btn) return false; btn.click(); return true; })()`});
    manifest.steps.push({clickedDownload:r.result.value});
    let csv=null;
    for(let i=0;i<90;i++){
      await sleep(1000);
      const files=fs.readdirSync(outDir).filter(f=>!before.has(f) && !/\.crdownload$/i.test(f));
      const csvs=files.filter(f=>/\.csv$/i.test(f));
      if(csvs.length){ csvs.sort((a,b)=>fs.statSync(path.join(outDir,b)).mtimeMs-fs.statSync(path.join(outDir,a)).mtimeMs); csv=path.join(outDir,csvs[0]); break; }
      const events=browser.events.filter(e=>/^Browser\.download/.test(e.method));
      manifest.downloadEvents=events;
    }
    if(!csv) throw new Error('No CSV appeared in MCP download folder');
    const final=path.join(outDir,'screener_layout_chart_data.csv');
    if(csv!==final) fs.renameSync(csv,final);
    manifest.csv=validateCsv(final);
    fs.writeFileSync(path.join(outDir,'manifest.json'),JSON.stringify(manifest,null,2));
    console.log(JSON.stringify({ok:true,outDir,manifest:path.join(outDir,'manifest.json'),csv:final,validation:manifest.csv},null,2));
  }catch(e){
    manifest.error=e.message;
    try { const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},20000); fs.writeFileSync(path.join(outDir,'failure.png'),Buffer.from(shot.data,'base64')); manifest.failureScreenshot=path.join(outDir,'failure.png'); } catch{}
    fs.writeFileSync(path.join(outDir,'manifest.json'),JSON.stringify(manifest,null,2));
    console.error(JSON.stringify({ok:false,outDir,manifest:path.join(outDir,'manifest.json'),error:e.message},null,2));
    process.exitCode=1;
  } finally { page.close(); browser.close(); }
}
main().catch(e=>{ console.error(e.stack||e.message); process.exit(1); });
