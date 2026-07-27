#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) { out[key] = 'true'; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tvInterval(tf) {
  return ({ '4H': '240', '1H': '60', '1D': '1D', '15m': '15', '30m': '30' })[tf] || tf;
}

function fileSafe(s) { return String(s || '').replace(/[^a-z0-9._-]+/gi, '_'); }

function withQuery(baseUrl, params) {
  const u = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function fetchJson(url, timeoutMs = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function cdp(wsUrl, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`${method} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result || {});
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`${method}: websocket error`));
    };
  });
}

async function findTradingViewPage(chartUrl) {
  const pages = await fetchJson('http://127.0.0.1:9222/json/list', 10000);
  const chartId = String(chartUrl || '').match(/\/chart\/([^/]+)/)?.[1];
  const typed = pages.filter(p => p.type === 'page' && p.webSocketDebuggerUrl);
  if (chartId) {
    const exact = typed.find(p => String(p.url || '').includes(`/chart/${chartId}`));
    if (exact) return exact;
  }
  const tv = typed.find(p => /tradingview\.com\/chart\//i.test(String(p.url || '')));
  if (tv) return tv;
  throw new Error('No TradingView chart page found on Desktop CDP port 9222');
}

async function evalOnPage(wsUrl, expression, timeoutMs = 30000) {
  const result = await cdp(wsUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs);
  if (result?.result?.subtype === 'error') throw new Error(result.result.description || 'Runtime.evaluate failed');
  return result?.result?.value;
}

async function dismissOverlays(wsUrl) {
  await evalOnPage(wsUrl, `(() => {
    const needles = [
      'crypto sale', 'limited time offer', 'upgrade now', 'advertisement', 'ads',
      'don’t miss this', 'don\\'t miss this', 'explore offers',
      'press and hold to see detailed chart values'
    ];
    const lower = s => String(s || '').toLowerCase();
    for (const btn of Array.from(document.querySelectorAll('button, [role="button"]'))) {
      const label = lower(btn.innerText || btn.textContent || btn.getAttribute('aria-label') || btn.getAttribute('title'));
      if (/^(close|×|x)$/.test(label) || label.includes('close')) {
        const rootText = lower(btn.closest('[role="dialog"], .tv-dialog, div')?.innerText || '');
        if (needles.some(n => rootText.includes(n)) || label.includes('close')) {
          try { btn.click(); } catch {}
        }
      }
    }
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      try {
        const txt = lower(el.innerText || el.textContent || '');
        const cs = getComputedStyle(el);
        const z = Number(cs.zIndex || 0);
        const r = el.getBoundingClientRect();
        const bigOverlay = (cs.position === 'fixed' || cs.position === 'sticky') && z >= 20 && r.width > 200 && r.height > 100;
        const promo = needles.some(n => txt.includes(n));
        const dialog = el.getAttribute('role') === 'dialog' || /dialog|modal|popup|promo/i.test(String(el.className || ''));
        if (promo || dialog || (bigOverlay && txt.length > 20)) {
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      } catch {}
    }
    return true;
  })()`, 15000).catch(() => false);
}

async function waitForChartReady(wsUrl, symbol, layout, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const symNeedle = String(symbol || '').replace(/^BITGET:/i, '').replace(/\.P$/i, '').toUpperCase();
  while (Date.now() < deadline) {
    const state = await evalOnPage(wsUrl, `(() => {
      const body = document.body?.innerText || '';
      const panes = Array.from(document.querySelectorAll('.chart-markup-table.pane')).map(e => {
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), text: (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) };
      });
      return { title: document.title, url: location.href, body: body.slice(0, 2000), panes };
    })()`, 12000).catch(e => ({ error: String(e.message || e) }));
    const text = `${state.title || ''}\n${state.url || ''}\n${state.body || ''}`.toUpperCase();
    const hasSymbol = !symNeedle || text.includes(symNeedle);
    const hasLayout = !layout || text.toLowerCase().includes(String(layout).toLowerCase());
    const hasPane = Array.isArray(state.panes) && state.panes.some(p => p.w > 300 && p.h > 200);
    if (hasSymbol && hasLayout && hasPane) return state;
    await sleep(1500);
  }
  throw new Error(`Desktop chart did not become ready for ${symbol} / ${layout}`);
}

async function main() {
  const args = parseArgs();
  const symbol = args.symbol || 'BITGET:AAPLUSDT.P';
  const fileSymbol = fileSafe(args.fileSymbol || symbol.replace(/^BITGET:/i, ''));
  const timeframe = args.timeframe || '4H';
  const layout = args.layout || 'Openclaw-structure';
  const chartUrl = args.chartUrl || 'https://www.tradingview.com/chart/0ZPSKaZ4/';
  const outdir = path.resolve(args.outdir || path.join(process.cwd(), 'captures'));
  const width = Number.parseInt(args.width || '2560', 10);
  const height = Number.parseInt(args.height || '1600', 10);
  const waitMs = Number.parseInt(args.waitMs || '16000', 10);

  fs.mkdirSync(outdir, { recursive: true });
  const page = await findTradingViewPage(chartUrl);
  const wsUrl = page.webSocketDebuggerUrl;
  await cdp(wsUrl, 'Page.bringToFront', {}, 5000).catch(() => {});
  await cdp(wsUrl, 'Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  }, 8000).catch(() => {});

  const url = withQuery(chartUrl, { symbol, interval: tvInterval(timeframe) });
  await cdp(wsUrl, 'Page.navigate', { url }, 15000);
  await sleep(waitMs);
  await dismissOverlays(wsUrl);
  await sleep(800);
  const ready = await waitForChartReady(wsUrl, symbol, layout, 45000);
  await dismissOverlays(wsUrl);

  const shot = await cdp(wsUrl, 'Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  }, 30000);
  const base = `${fileSymbol}_${timeframe}_${fileSafe(layout)}_desktop.png`;
  const shotPath = path.join(outdir, base);
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  const meta = {
    capturedAt: new Date().toISOString(),
    backend: 'tradingview-desktop-cdp',
    symbol, fileSymbol, timeframe, layout, chartUrl, url,
    viewport: { width, height, deviceScaleFactor: 1 },
    desktopPage: { title: page.title, url: page.url, id: page.id },
    ready,
    shotPath,
  };
  fs.writeFileSync(path.join(outdir, base.replace(/\.png$/i, '_meta.json')), JSON.stringify(meta, null, 2));
  console.log(shotPath);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
