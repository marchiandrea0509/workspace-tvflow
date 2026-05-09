#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function toTvInterval(tf) {
  const m = {
    '1H': '60',
    '1D': '1D',
    '4H': '240',
    '15m': '15',
    '30m': '30'
  };
  return m[tf] || tf;
}

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

function extractMarketFromTitle(title, symbol) {
  // Example: "USOXUSDT.P 113.30 ▲ +17.79% Openclaw-Flow"
  const out = {
    title,
    symbol,
    price: null,
    changePct: null,
  };
  if (!title) return out;

  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const p = title.match(new RegExp(`${escapedSymbol}\\s+([0-9]+(?:\\.[0-9]+)?)`));
  if (p) out.price = Number(p[1]);

  const c = title.match(/([+-][0-9]+(?:\.[0-9]+)?)%/);
  if (c) out.changePct = Number(c[1]);

  return out;
}

async function chartCanvasLooksRendered(page) {
  try {
    return await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'))
        .map((c) => ({ c, r: c.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 500 && r.height > 260);
      if (!canvases.length) return false;

      canvases.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
      const target = canvases[0].c;

      const w = Math.max(120, Math.floor(target.width || target.clientWidth || 0));
      const h = Math.max(80, Math.floor(target.height || target.clientHeight || 0));
      if (w < 120 || h < 80) return false;

      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;

      ctx.drawImage(target, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h).data;

      let n = 0, sum = 0, sum2 = 0, nonBlack = 0;
      const stepX = Math.max(4, Math.floor(w / 120));
      const stepY = Math.max(4, Math.floor(h / 80));

      for (let y = 0; y < h; y += stepY) {
        for (let x = 0; x < w; x += stepX) {
          const i = (y * w + x) * 4;
          const lum = (img[i] + img[i + 1] + img[i + 2]) / 3;
          sum += lum;
          sum2 += lum * lum;
          n++;
          if (lum > 12) nonBlack++;
        }
      }

      if (!n) return false;
      const mean = sum / n;
      const variance = Math.max(0, (sum2 / n) - mean * mean);
      const std = Math.sqrt(variance);
      const nonBlackRatio = nonBlack / n;

      // A fully blank/black chart tends to have near-zero variance and almost no non-black pixels.
      return nonBlackRatio > 0.08 && std > 10;
    });
  } catch {
    return false;
  }
}

async function waitForChartReady(page, symbol, timeoutMs = 30000) {
  const start = Date.now();
  const symNorm = String(symbol || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  while (Date.now() - start < timeoutMs) {
    try {
      const txt = (await page.locator('body').innerText()).toLowerCase();
      const txtNorm = txt.replace(/[^a-z0-9]/g, '');
      const hasSymbolHeader = symNorm ? txtNorm.includes(symNorm) : false;
      const hasTimeAxis = /\bjan\b|\bfeb\b|\bmar\b|\bapr\b|\bmay\b|\bjun\b|\bjul\b|\baug\b|\bsep\b|\boct\b|\bnov\b|\bdec\b/i.test(txt);
      const hasOhlcLegend = /\bo\s*[0-9]|\bh\s*[0-9]|\bl\s*[0-9]|\bc\s*[0-9]/i.test(txt);
      const canvasRendered = await chartCanvasLooksRendered(page);
      if (canvasRendered && (hasSymbolHeader || hasTimeAxis || hasOhlcLegend)) return true;
    } catch {}
    await page.waitForTimeout(700);
  }
  return false;
}

async function clearTransientPanels(page) {
  // Dismiss popovers/modals/side-panels that steal chart area (e.g., economic calendar).
  try { await page.keyboard.press('Escape'); } catch {}
  try { await page.keyboard.press('Escape'); } catch {}

  const closeSelectors = [
    'button[aria-label="Close"]',
    'button[title="Close"]',
    '[data-name="close"]',
    '[data-name="close-button"]',
    'button:has-text("Close")',
  ];

  for (const sel of closeSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout: 500 });
        await page.waitForTimeout(150);
      }
    } catch {}
  }
}

async function getPaneRects(page) {
  try {
    const rects = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.chart-markup-table.pane')) {
        const r = el.getBoundingClientRect();
        if (r.width < 300 || r.height < 40) continue;
        out.push({
          left: Math.floor(r.left),
          top: Math.floor(r.top),
          right: Math.floor(r.right),
          bottom: Math.floor(r.bottom),
          width: Math.floor(r.width),
          height: Math.floor(r.height),
        });
      }
      out.sort((a, b) => a.top - b.top);
      return out;
    });
    return Array.isArray(rects) ? rects : [];
  } catch {
    return [];
  }
}

async function forceCloseRightDock(page) {
  try {
    const getPaneWidth = async () => page.evaluate(() => {
      const pane = [...document.querySelectorAll('.chart-markup-table.pane')]
        .map((e) => e.getBoundingClientRect().width)
        .sort((a, b) => b - a)[0] || 0;
      return { viewport: window.innerWidth, pane: Math.round(pane) };
    });

    let before = await getPaneWidth();
    let changed = false;

    // A dock is considered open when main pane width is notably reduced.
    const isOpen = (v) => v.pane > 0 && v.pane < (v.viewport * 0.78);

    for (let attempt = 0; attempt < 2 && isOpen(before); attempt++) {
      try {
        const watchlist = page.locator('button[aria-label="Watchlist, details and news"]').first();
        if (await watchlist.count()) {
          await watchlist.click({ timeout: 1200 });
          await page.waitForTimeout(450);
          changed = true;
        }
      } catch {}

      try { await page.keyboard.press('Escape'); } catch {}
      await page.waitForTimeout(180);
      before = await getPaneWidth();
    }

    return changed;
  } catch {
    return false;
  }
}

async function detectChartAxisX(page, width) {
  const panes = await getPaneRects(page);
  if (panes.length) return Math.max(10, panes[0].right - 6);
  return Math.floor(width * 0.92);
}

async function resetPanelScales(page, width, height) {
  const panes = await getPaneRects(page);
  if (!panes.length) return;

  // Reset indicator panes (RSI/ATR) by focusing each pane and using TV reset shortcut.
  // This is safer than axis double-clicks (which can open context menus in some layouts).
  const indicatorPanes = panes.length > 1 ? panes.slice(1) : panes;
  for (const pane of indicatorPanes) {
    const x = Math.floor(pane.left + pane.width * 0.55);
    const y = Math.floor(pane.top + pane.height * 0.55);
    try {
      await page.mouse.click(x, y);
      await page.keyboard.press('Alt+R');
      await page.waitForTimeout(220);
    } catch {}
  }

  // Extra ATR pass on the bottom pane.
  if (panes.length >= 2) {
    const atrPane = panes[panes.length - 1];
    const x = Math.floor(atrPane.left + atrPane.width * 0.55);
    const y = Math.floor(atrPane.top + atrPane.height * 0.60);
    try {
      await page.mouse.click(x, y);
      await page.keyboard.press('Alt+R');
      await page.waitForTimeout(240);
    } catch {}
  }
}

async function enforceCandles(page) {
  // If current style isn't Candles, switch to Candles using the style menu.
  try {
    const hasCandles = await page.locator('button[aria-label="Candles"]').count();
    if (hasCandles) return;

    const styleBtn = page.locator('button[aria-label*="Line"], button[aria-label*="Bars"], button[aria-label*="Area"], button[aria-label*="Baseline"], button[aria-label*="Heikin"]').first();
    if (await styleBtn.count()) {
      await styleBtn.click({ timeout: 1200 });
      await page.waitForTimeout(250);
      const candlesItem = page.locator('div[role="menu"] [role="menuitem"], div[role="listbox"] [role="option"]').filter({ hasText: /^Candles$/i }).first();
      if (await candlesItem.count()) {
        await candlesItem.click({ timeout: 1200 });
        await page.waitForTimeout(250);
      }
    }
  } catch {}
}

async function adaptTimeAxis(page, timeframe, width, height, options = {}) {
  const panes = await getPaneRects(page);
  const main = panes[0] || {
    left: Math.floor(width * 0.06),
    top: Math.floor(height * 0.06),
    width: Math.floor(width * 0.86),
    height: Math.floor(height * 0.52),
  };

  const x = Math.floor(main.left + main.width * 0.55);
  const y = Math.floor(main.top + main.height * 0.45);

  try {
    await page.mouse.click(x, y);
    // Normalize active pane scale first.
    await page.keyboard.press('Alt+R');
    await page.waitForTimeout(220);

    // Keep 1D flow untouched horizontally (it was getting over-compressed).
    if (!options.skipHorizontalZoom) {
      const outSteps = timeframe === '1D' ? 1 : (timeframe === '4H' ? 2 : 1);
      for (let i = 0; i < outSteps; i++) {
        await page.mouse.wheel(0, 160);
      }
      await page.waitForTimeout(320);
    }
  } catch {}
}

async function finalizeViewForShot(page) {
  // Clear context menus/crosshair overlays and leave cursor outside chart area.
  try { await page.keyboard.press('Escape'); } catch {}
  try { await page.keyboard.press('Escape'); } catch {}
  try {
    await page.evaluate(() => {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    });
  } catch {}
  try { await page.mouse.move(20, 12); } catch {}
  await page.waitForTimeout(420);
}

(async () => {
  const args = parseArgs();

  const symbol = args.symbol;
  const timeframe = args.timeframe;
  const outdir = args.outdir;
  const logPath = args.log;
  const layout = args.layout || '';

  if (!symbol || !timeframe || !outdir || !logPath) {
    console.error('Missing args: --symbol --timeframe --outdir --log [--layout] [--chartUrl] [--width] [--height] [--scale] [--panelShot]');
    process.exit(2);
  }

  const preset = String(args.preset || '').toLowerCase();

  let defaultWidth = 1600;
  let defaultHeight = 1000;
  let defaultScale = 1;
  let defaultPanelShot = false;

  if (preset === 'deep') {
    defaultWidth = 2560;
    defaultHeight = 1600;
    defaultScale = 2;
    defaultPanelShot = true;
  }
  if (preset === 'ultra') {
    defaultWidth = 3440;
    defaultHeight = 2160;
    defaultScale = 2;
    defaultPanelShot = true;
  }

  const width = Number(args.width || defaultWidth);
  const height = Number(args.height || defaultHeight);
  const scale = Number(args.scale || defaultScale);
  const panelShot = String(args.panelShot || String(defaultPanelShot)).toLowerCase() === 'true';
  const fixedZoom = String(args.fixedZoom || 'true').toLowerCase() !== 'false';
  const resetScales = String(args.resetScales || 'true').toLowerCase() !== 'false';
  const isFlowLayout = /openclaw-flow/i.test(layout || '');

  const interval = toTvInterval(timeframe);
  let url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`;
  if (args.chartUrl) {
    try {
      const u = new URL(args.chartUrl);
      u.searchParams.set('symbol', symbol);
      u.searchParams.set('interval', interval);
      url = u.toString();
    } catch {
      url = args.chartUrl;
    }
  }

  const suffix = layout ? `_${layout.replace(/[^a-z0-9-_]+/gi, '-')}` : '';
  const baseShotPath = path.join(outdir, `${symbol}_${timeframe}${suffix}`);
  const shotPath = `${baseShotPath}.png`;
  const panelPath = `${baseShotPath}_panels.png`;
  const metaPath = `${baseShotPath}_meta.json`;
  fs.mkdirSync(outdir, { recursive: true });

  const profileName = args.profile || 'profile';
  const profileDir = path.resolve(__dirname, '..', profileName);

  let context;
  try {
    const headless = String(args.headless || 'true').toLowerCase() !== 'false';

    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      channel: 'chromium',
      viewport: { width, height },
      deviceScaleFactor: scale,
      isMobile: false,
      hasTouch: false,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      args: ['--enable-gpu', '--use-angle=d3d11', '--disable-dev-shm-usage']
    });

    // Hard reset UI state: close any restored tabs/pages from previous runs,
    // then use one fresh page only.
    const existingPages = context.pages();
    for (const p of existingPages) {
      try { await p.close({ runBeforeUnload: false }); } catch {}
    }

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    try { await page.keyboard.press('Control+0'); } catch {}
    await page.waitForTimeout(5500);

    // Gate screenshots on chart readiness to avoid capturing transient/broken states.
    let ready = await waitForChartReady(page, symbol, 22000);

    // Self-heal once when TradingView opens with empty canvas state.
    if (!ready) {
      try {
        await page.keyboard.press('Control+R');
        await page.waitForTimeout(4500);
      } catch {}
      ready = await waitForChartReady(page, symbol, 22000);
    }

    await clearTransientPanels(page);
    const collapsedPanel = await forceCloseRightDock(page);
    await enforceCandles(page);
    await page.waitForTimeout(250);

    if (fixedZoom) {
      await adaptTimeAxis(page, timeframe, width, height, {
        skipHorizontalZoom: isFlowLayout && timeframe === '1D'
      });
      await page.waitForTimeout(500);
    }

    if (resetScales) {
      await resetPanelScales(page, width, height);
      await page.waitForTimeout(350);
    }

    // Final dock close pass after interactions + clean UI overlays before snapshot.
    await forceCloseRightDock(page);
    await finalizeViewForShot(page);

    await page.screenshot({ path: shotPath, fullPage: false });

    let panelTaken = false;
    if (panelShot) {
      const clipY = Math.floor(height * 0.58);
      const clipH = Math.max(200, height - clipY);
      await page.screenshot({
        path: panelPath,
        fullPage: false,
        clip: { x: 0, y: clipY, width, height: clipH }
      });
      panelTaken = true;
    }

    const title = await page.title();
    const market = extractMarketFromTitle(title, symbol);
    const meta = {
      capturedAt: new Date().toISOString(),
      symbol,
      timeframe,
      layout: layout || 'default',
      preset: preset || 'standard',
      width,
      height,
      scale,
      fixedZoom,
      profile: profileName,
      ready,
      url,
      shotPath,
      panelPath: panelTaken ? panelPath : null,
      market,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    fs.appendFileSync(
      logPath,
      `[live-ok] symbol=${symbol} timeframe=${timeframe} layout=${layout || 'default'} preset=${preset || 'standard'} profile=${profileName} width=${width} height=${height} scale=${scale} headless=${headless} fixedZoom=${fixedZoom} resetScales=${resetScales} chartReady=${ready} collapsedRightPanel=${collapsedPanel} panelShot=${panelTaken} url=${url} file=${shotPath}${panelTaken ? ` panelFile=${panelPath}` : ''} metaFile=${metaPath} price=${market.price ?? 'na'} changePct=${market.changePct ?? 'na'}\n`
    );

    console.log(shotPath);
    if (panelTaken) console.log(panelPath);

    await context.close();
    process.exit(0);
  } catch (e) {
    fs.appendFileSync(logPath, `[live-fail] symbol=${symbol} timeframe=${timeframe} layout=${layout || 'default'} error=${e.message}\n`);
    if (context) {
      try { await context.close(); } catch {}
    }
    console.error(e.message);
    process.exit(1);
  }
})();
