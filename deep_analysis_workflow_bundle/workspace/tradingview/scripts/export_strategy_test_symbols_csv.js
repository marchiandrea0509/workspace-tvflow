#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LAYOUT_URL = 'https://www.tradingview.com/chart/0PgkxOVV/';
const LAYOUT_NAME_EXPECTED = /Startegy test|Strategy test/i;
const DEFAULT_WATCHLIST_NAME = 'tradingview_real_market_stocks_watchlist';
const DEFAULT_EXCHANGE = 'BATS';
const DEFAULT_SYMBOLS = [
  'NVDA','MSFT','AAPL','AMZN','META','GOOGL','TSLA','AMD','AVGO','NFLX',
  'ADBE','ORCL','CRM','JPM','UNH','XOM','DIS','SHOP','ARM','COIN',
  'MSTR','PLTR','HOOD','INTC','MRVL','ASML','BABA','RDDT','GME','MCD'
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'headful' || key === 'skip-validation') { out[key] = true; continue; }
    out[key] = next; i++;
  }
  return out;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeName(s) { return String(s).replace(/[^a-z0-9._-]+/gi, '_'); }

const REQUIRED_INDICATOR_COLUMNS = [
  '02 Best Score',
  'D13 LC Final',
  'D16 SC Final',
  'W04 SC ActionScore',
  'SQ12 ResearchValid',
];

const DEFAULT_EXPORT_ATTEMPTS = 4;

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function valueLooksPresent(value) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  return !/^(nan|na|n\/a|null|undefined)$/i.test(s);
}

function csvSplit(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function uniq(xs) {
  const seen = new Set();
  const out = [];
  for (const raw of xs) {
    const s = String(raw || '').trim();
    if (!s || seen.has(s.toUpperCase())) continue;
    seen.add(s.toUpperCase());
    out.push(s);
  }
  return out;
}

function loadSymbols(args) {
  if (args.symbols) return uniq(String(args.symbols).split(/[\s,]+/));
  if (args['symbols-file']) {
    const text = fs.readFileSync(path.resolve(args['symbols-file']), 'utf8');
    return uniq(text.split(/[\r\n,\s]+/));
  }
  if (args['symbols-csv']) {
    const text = fs.readFileSync(path.resolve(args['symbols-csv']), 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const headers = csvSplit(lines[0]);
    const wanted = args['symbol-column'] || 'Symbol';
    const idxFound = headers.findIndex((h) => h.trim().toLowerCase() === wanted.toLowerCase());
    const idx = idxFound >= 0 ? idxFound : 0;
    return uniq(lines.slice(1).map((line) => csvSplit(line)[idx]));
  }
  return DEFAULT_SYMBOLS;
}

function tvSymbol(symbol, exchange) {
  const s = String(symbol).trim();
  return s.includes(':') ? s : exchange + ':' + s;
}

function validateStrategyCsv(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, reason: 'CSV has no data rows', size: fs.statSync(csvPath).size };
  }

  const headers = csvSplit(lines[0]).map(h => h.trim());
  const missingColumns = REQUIRED_INDICATOR_COLUMNS.filter(col => !headers.includes(col));
  if (missingColumns.length) {
    return { ok: false, reason: `Required indicator columns missing: ${missingColumns.join(', ')}`, size: fs.statSync(csvPath).size, missingColumns };
  }

  const columnIndexes = Object.fromEntries(REQUIRED_INDICATOR_COLUMNS.map(col => [col, headers.indexOf(col)]));
  const seenValues = Object.fromEntries(REQUIRED_INDICATOR_COLUMNS.map(col => [col, false]));

  for (const line of lines.slice(1)) {
    const row = csvSplit(line);
    for (const col of REQUIRED_INDICATOR_COLUMNS) {
      if (valueLooksPresent(row[columnIndexes[col]])) seenValues[col] = true;
    }
  }

  const emptyColumns = REQUIRED_INDICATOR_COLUMNS.filter(col => !seenValues[col]);
  const size = fs.statSync(csvPath).size;
  if (emptyColumns.length) {
    return { ok: false, reason: `Required indicator columns empty/NaN: ${emptyColumns.join(', ')}`, size, emptyColumns };
  }

  return { ok: true, size, checkedColumns: REQUIRED_INDICATOR_COLUMNS };
}

async function chartLooksReady(page, symbol, timeoutMs = 45000) {
  const want = symbol.toUpperCase();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const title = await page.title();
      const body = await page.locator('body').innerText({ timeout: 2000 });
      if ((title.toUpperCase().includes(want) || body.toUpperCase().includes(want)) && LAYOUT_NAME_EXPECTED.test(body)) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function closeDialogs(page) {
  try { await page.keyboard.press('Escape'); } catch {}
  try { await page.keyboard.press('Escape'); } catch {}
  await sleep(200);
}

async function openDownloadDialog(page) {
  await closeDialogs(page);
  await page.locator('button[data-name="save-load-menu"]').first().click({ timeout: 10000, force: true });
  await sleep(650);

  // The menu item is role=row in current TV UI; coordinate click is more reliable than accessible locators.
  const rect = await page.evaluate(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const items = Array.from(document.querySelectorAll('[role="row"], .button-HZXWyU6m, .background-wJ4EfuBP'));
    const hit = items.find((e) => visible(e) && /Download chart data/i.test((e.innerText || e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!rect) throw new Error('Download chart data menu item not found');
  await page.mouse.click(rect.x, rect.y);
  await sleep(1000);

  const text = await page.locator('body').innerText({ timeout: 5000 });
  if (!/Download chart data/i.test(text) || !/CSV file/i.test(text)) {
    throw new Error('Download chart data dialog did not open');
  }
}

async function exportCurrentChart(page, outDir, symbol, candidatePath) {
  await openDownloadDialog(page);
  const before = new Set(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
  const clicked = await page.evaluate(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const btn = buttons.find((e) => visible(e) && /^Download$/i.test((e.innerText || e.textContent || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error('Download button not found in chart data dialog');

  let downloadedPath = null;
  const dl = await downloadPromise;
  if (dl) {
    downloadedPath = candidatePath;
    await dl.saveAs(downloadedPath);
  } else {
    // Fallback: TV sometimes writes directly into downloadsPath without emitting a download object.
    const start = Date.now();
    while (Date.now() - start < 60000) {
      const now = fs.readdirSync(outDir);
      const added = now.filter(n => !before.has(n));
      if (added.length) {
        added.sort((a,b) => fs.statSync(path.join(outDir,b)).mtimeMs - fs.statSync(path.join(outDir,a)).mtimeMs);
        const src = path.join(outDir, added[0]);
        downloadedPath = candidatePath;
        fs.renameSync(src, downloadedPath);
        break;
      }
      await sleep(500);
    }
  }

  await closeDialogs(page);
  if (!downloadedPath || !fs.existsSync(downloadedPath) || fs.statSync(downloadedPath).size <= 0) {
    throw new Error('CSV download missing or empty');
  }
  return downloadedPath;
}

async function exportCurrentChartValidated(page, outDir, symbol, maxAttempts, skipValidation = false) {
  const finalPath = path.join(outDir, `${safeName(symbol)}_strategy_test_4h.csv`);
  if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);

  if (skipValidation) {
    const csvPath = await exportCurrentChart(page, outDir, symbol, finalPath);
    return { csvPath, validation: { ok: true, skipped: true, reason: 'validation skipped by --skip-validation' } };
  }

  let lastValidation = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidatePath = path.join(outDir, `${safeName(symbol)}_strategy_test_4h_candidate_attempt${attempt}.csv`);
    if (fs.existsSync(candidatePath)) fs.unlinkSync(candidatePath);

    const csvPath = await exportCurrentChart(page, outDir, symbol, candidatePath);
    const validation = validateStrategyCsv(csvPath);
    lastValidation = validation;

    if (validation.ok) {
      fs.renameSync(csvPath, finalPath);
      return { csvPath: finalPath, validation };
    }

    try { fs.unlinkSync(csvPath); } catch {}
    console.warn(`[retry] ${symbol} CSV validation failed on attempt ${attempt}/${maxAttempts}: ${validation.reason}; size=${validation.size}`);
    if (attempt < maxAttempts) {
      await sleep(10000 + attempt * 5000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => null);
      await sleep(10000 + attempt * 5000);
      await chartLooksReady(page, symbol, 60000);
    }
  }

  throw new Error(`CSV validation failed after ${maxAttempts} attempts: ${lastValidation ? `${lastValidation.reason}; size=${lastValidation.size}` : 'unknown validation error'}`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = path.resolve(__dirname, '..');
  const watchlistName = args.watchlist || DEFAULT_WATCHLIST_NAME;
  const exchange = args.exchange || DEFAULT_EXCHANGE;
  const symbols = loadSymbols(args);
  const exportAttempts = parsePositiveInt(args['export-attempts'], DEFAULT_EXPORT_ATTEMPTS);
  const skipValidation = Boolean(args['skip-validation']);
  const postExportWaitMs = parsePositiveInt(args['post-export-wait-ms'], 0);
  if (!symbols.length) throw new Error('No symbols resolved for export');
  const profileDir = path.resolve(args.profile || path.join(root, 'profile'));
  const outDir = path.resolve(args.outdir || path.join(root, 'reports', 'strategy_test_watchlist_csv', stamp));
  fs.mkdirSync(outDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !args.headful,
    channel: 'chromium',
    viewport: { width: 1800, height: 1100 },
    acceptDownloads: true,
    downloadsPath: outDir,
    args: ['--enable-gpu', '--use-angle=d3d11', '--disable-dev-shm-usage'],
  });

  const results = [];
  try {
    for (const p of context.pages()) { try { await p.close({ runBeforeUnload: false }); } catch {} }
    const page = await context.newPage();

    for (const symbol of symbols) {
      const url = `${LAYOUT_URL}?symbol=${encodeURIComponent(tvSymbol(symbol, exchange))}&interval=240`;
      console.log(`[start] ${symbol} ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await sleep(7000);
        const ready = await chartLooksReady(page, symbol, 45000);
        if (!ready) throw new Error('Chart did not become ready on strategy-test layout');
        const title = await page.title();
        const { csvPath, validation } = await exportCurrentChartValidated(page, outDir, symbol, exportAttempts, skipValidation);
        const size = fs.statSync(csvPath).size;
        console.log(`[ok] ${symbol} ${size} ${csvPath}`);
        results.push({ symbol, ok: true, title, csvPath, size, validation });
        if (postExportWaitMs > 0) {
          console.log(`[wait] ${symbol} post-export ${postExportWaitMs}ms`);
          await sleep(postExportWaitMs);
        }
      } catch (err) {
        console.error(`[fail] ${symbol}: ${err.message}`);
        try { await page.screenshot({ path: path.join(outDir, `${safeName(symbol)}_failure.png`), fullPage: false }); } catch {}
        results.push({ symbol, ok: false, error: err.message });
      }
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      layoutUrl: LAYOUT_URL,
      layoutNameExpected: String(LAYOUT_NAME_EXPECTED),
      watchlist: watchlistName,
      exchange,
      interval: '240 / 4H',
      requestedSymbols: symbols,
      okCount: results.filter(r => r.ok).length,
      failCount: results.filter(r => !r.ok).length,
      results,
    };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ ok: manifest.failCount === 0, outDir, okCount: manifest.okCount, failCount: manifest.failCount, manifest: path.join(outDir, 'manifest.json') }, null, 2));
  } finally {
    await context.close();
  }
})();
