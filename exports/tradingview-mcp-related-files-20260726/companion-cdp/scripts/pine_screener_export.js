#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (['headful', 'help'].includes(key)) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node tradingview/scripts/pine_screener_export.js [options]',
    '',
    'Options:',
    '  --watchlist <name>          Watchlist name (default: BITGET_TRADFI)',
    '  --indicator <name>          Pine Screener indicator name',
    '  --timeframe <tf>            4H | 1D | 1H | etc (default: 4H)',
    '  --profile <path>            Playwright persistent profile path',
    '  --download-dir <path>       Temp export dir',
    '  --out <json_path>           Output JSON path',
    '  --min-best-setup <number>   Keep only rows where 01 Best Setup >= number',
    '  --headful                   Run visible browser',
    '  --help                      Show help',
  ].join('\n');
}

function normalizeTf(tf) {
  const raw = String(tf || '4H').trim().toUpperCase();
  const map = {
    '1M': '1 minute',
    '5M': '5 minutes',
    '15M': '15 minutes',
    '30M': '30 minutes',
    '1H': '1 hour',
    '2H': '2 hours',
    '4H': '4 hours',
    '1D': '1 day',
    '1W': '1 week',
    '1MO': '1 month',
    '1MON': '1 month',
    '1MONTH': '1 month',
  };
  return map[raw] || tf;
}

function csvSplit(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = csvSplit(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cols = csvSplit(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
  return { headers, rows };
}

function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'â€”') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function canonicalSymbol(row) {
  return row.Symbol || row.symbol || row.Ticker || row.ticker || null;
}

function summarizeRows(rows) {
  return rows.map((row) => ({
    symbol: canonicalSymbol(row),
    description: row.Description || row.description || null,
    bestSetupCode: toNum(row['01 Best Setup']),
    bestScore: toNum(row['02 Best Score']),
    finalLongScore: toNum(row['03 Final Long']),
    finalShortScore: toNum(row['04 Final Short']),
    longMeanRev: null,
    convictionState: toNum(row['08 Conviction']),
    raw: row,
  }));
}

function formatCell(v) {
  if (v == null) return 'â€”';
  const s = String(v).trim();
  if (!s || s === 'â€”') return 'â€”';
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(1);
  if (abs >= 10) return n.toFixed(1);
  if (abs >= 1) return n.toFixed(2);
  if (abs >= 0.01) return n.toFixed(3);
  if (abs === 0) return '0';
  return n.toPrecision(4);
}

function pad(str, width) {
  const s = String(str ?? '');
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function buildTransposedMarkdown(rows, orderedColumns) {
  const headers = ['TV Screener Column', ...rows.map((row, idx) => `#${idx + 1} ${row.symbol || 'NA'}`)];
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];

  for (const col of orderedColumns) {
    const cells = [col, ...rows.map((row) => formatCell(row.raw?.[col]))];
    lines.push(`| ${cells.join(' | ')} |`);
  }

  return lines.join('\n');
}

function buildChatTable(rows, orderedColumns, title = 'Top 5 by 02 Best Score (4H)') {
  const valueWidths = rows.map((row, idx) => Math.max((`#${idx + 1} ${row.symbol || 'NA'}`).length, ...orderedColumns.map((col) => formatCell(row.raw?.[col]).length), 8));
  const labelWidth = Math.max(...orderedColumns.map((c) => c.length), 18);
  const header = [pad('TV Column', labelWidth), ...rows.map((row, idx) => pad(`#${idx + 1} ${row.symbol || 'NA'}`, valueWidths[idx]))].join(' | ');
  const sep = [ '-'.repeat(labelWidth), ...valueWidths.map((w) => '-'.repeat(w)) ].join('-+-');
  const body = orderedColumns.map((col) => {
    const vals = rows.map((row, idx) => pad(formatCell(row.raw?.[col]), valueWidths[idx]));
    return [pad(col, labelWidth), ...vals].join(' | ');
  });
  return [title, header, sep, ...body].join('\n');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeMenus(page) {
  try { await page.keyboard.press('Escape'); } catch {}
  try { await page.keyboard.press('Escape'); } catch {}
  await sleep(150);
}

async function dismissOverlays(page) {
  try {
    const closeBtn = page.getByRole('button', { name: 'Close' }).last();
    if (await closeBtn.count()) {
      await closeBtn.click({ timeout: 2000, force: true });
      await sleep(500);
    }
  } catch {}

  try {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const node of buttons) {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        const data = node.getAttribute('data-name') || '';
        if (text === 'Close' || data.startsWith('toast-group-close-button-')) {
          try { node.click(); } catch {}
        }
      }
    });
  } catch {}

  await sleep(250);
}

async function openWatchlistMenu(page) {
  const btn = page.locator('button', { hasText: 'Watchlist' }).first();
  try {
    await btn.click({ timeout: 4000 });
  } catch {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const target = buttons.find((node) => {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        return text === 'Watchlist' || node.getAttribute('data-name') === 'pine-screener-watchlist-pill';
      });
      if (!target) throw new Error('Watchlist button not found');
      target.click();
    });
  }
  await sleep(500);
}

async function ensureWatchlist(page, watchlistName) {
  const body = await page.locator('body').innerText();
  if (new RegExp(`\\b${watchlistName}\\b`, 'i').test(body)) {
    // still explicitly select it for determinism
  }
  await openWatchlistMenu(page);
  const item = page.locator('[role="menuitemcheckbox"]', { hasText: watchlistName }).first();
  await item.click({ timeout: 10000, force: true });
  await sleep(800);
  await closeMenus(page);
}

async function ensureIndicator(page, indicatorName) {
  const indicatorBtn = page.locator('button[aria-label^="Indicator "]', { hasText: indicatorName }).first();
  if (await indicatorBtn.count()) return;

  await page.getByRole('button', { name: 'Choose indicator' }).click({ timeout: 10000, force: true });
  await sleep(700);
  const item = page.locator('.background-wJ4EfuBP', { hasText: indicatorName }).first();
  await item.click({ timeout: 10000, force: true });
  await sleep(1200);
}

async function ensureTimeframe(page, indicatorName, timeframeText) {
  await page.getByRole('button', { name: `Indicator ${indicatorName}` }).click({ timeout: 10000, force: true });
  await sleep(500);
  await page.getByRole('button', { name: /minute|minutes|hour|hours|day|week|month/i }).first().click({ timeout: 10000, force: true });
  await sleep(300);
  const item = page.locator('[role="menuitemcheckbox"]', { hasText: timeframeText }).first();
  await item.click({ timeout: 10000, force: true });
  await sleep(600);
  await closeMenus(page);
}

async function isColumnChecked(page, name) {
  return await page.evaluate((target) => {
    const items = Array.from(document.querySelectorAll('.background-wJ4EfuBP'));
    const el = items.find((node) => (node.textContent || '').replace(/\s+/g, ' ').trim() === target);
    if (!el) return null;
    const box = el.querySelector('.box-vgla_e5o');
    if (!box) return null;
    return box.classList.contains('checked-vgla_e5o');
  }, name);
}

async function ensureColumns(page, columns) {
  await page.getByTitle('Manage columns').click({ timeout: 10000, force: true });
  await sleep(600);
  for (const name of columns) {
    const checked = await isColumnChecked(page, name);
    if (checked !== true) {
      const option = page.locator('.background-wJ4EfuBP', { hasText: name }).first();
      if (await option.count()) {
        await option.click({ timeout: 10000, force: true });
        await sleep(250);
        const after = await isColumnChecked(page, name);
        if (after !== true) {
          console.warn(`Column did not confirm as enabled: ${name}`);
        }
      } else {
        console.warn(`Column not found in selector, skipping: ${name}`);
      }
    }
  }
  await closeMenus(page);
  await sleep(1200);
}

async function runScan(page) {
  const btn = page.getByRole('button', { name: /Scan|Rescan/i }).first();
  await btn.click({ timeout: 10000, force: true });
  // TV scan looks silent in this UI; give indicator columns extra time to populate before export.
  await sleep(30000);
}

async function waitForNewFile(dir, beforeNames, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const names = fs.readdirSync(dir);
    const added = names.filter((n) => !beforeNames.has(n));
    if (added.length) return added[0];
    await sleep(250);
  }
  return null;
}

async function exportCsv(page, downloadDir, outCsvPath) {
  const beforeNames = new Set(fs.readdirSync(downloadDir));
  await page.locator('[role="button"]', { hasText: 'Pine Screener' }).first().click({ timeout: 10000, force: true });
  await sleep(500);
  await page.locator('.background-wJ4EfuBP', { hasText: 'Download results as CSV' }).first().click({ timeout: 10000, force: true });
  const added = await waitForNewFile(downloadDir, beforeNames, 20000);
  if (!added) throw new Error('Export file did not appear in download directory');
  const src = path.join(downloadDir, added);
  const data = fs.readFileSync(src);
  fs.writeFileSync(outCsvPath, data);
  return outCsvPath;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const workspaceRoot = path.resolve(__dirname, '..');
  const watchlist = args.watchlist || 'BITGET_TRADFI';
  const indicator = args.indicator || 'OC Hybrid Edge Screener v9.3';
  const timeframeText = normalizeTf(args.timeframe || '4H');
  const minBestSetup = args['min-best-setup'] != null ? Number(args['min-best-setup']) : null;
  if (minBestSetup != null && !Number.isFinite(minBestSetup)) {
    throw new Error('--min-best-setup must be a number');
  }
  const headless = !args.headful;
  const profileDir = path.resolve(args.profile || path.join(workspaceRoot, 'profile'));
  const downloadDir = path.resolve(args['download-dir'] || path.join(workspaceRoot, 'downloads', 'pine_screener'));
  const reportsDir = path.resolve(path.join(workspaceRoot, 'reports', 'pine_screener'));
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outJson = path.resolve(args.out || path.join(reportsDir, `pine_screener_${stamp}.json`));
  const outCsv = outJson.replace(/\.json$/i, '.csv');
  const screenshotPath = outJson.replace(/\.json$/i, '.png');

  const screenerColumns = [
    'EMA Fast',
    'EMA Medium',
    'EMA Slow',
    '01 Best Setup',
    '02 Best Score',
    '03 Final Long',
    '04 Final Short',
    '05 Trend Dir',
    '06 Macro Dir',
    '07 Verdict',
    '08 Conviction',
    '09 Signal Dir',
    'SQ01 Signals',
    '10 Score_v6',
    'SQ03 AvgMFE_ATR',
    'SQ04 AvgMAE_ATR',
    'SQ05 AvgEdgeRatio',
    'SQ06 PlusATR1stPct',
    'SQ07 AvgAdverseBars',
    'SQ08 AvgBarsToGreen',
    'SQ09 AvgCloseATR',
    'SQ10 AdverseBarPct',
    'SQ11 MinSampleFlag',
    'SQ12 ResearchValid',
    'D01 TacticalLong',
    'D02 TacTrendLong',
    'D03 TacBreakoutLong',
    'D04 MacroLong',
    'D05 StructLongCont',
    'D06 FreshStructLong',
    'D07 ADXContLong',
    'D08 LifecycleLong',
    'D09 ContextLongBoost',
    'D10 BullPenaltyTotal',
    'D11 LC Raw',
    'D12 LC AfterDiag',
    'D13 LC Final',
    'D14 SC Raw',
    'D15 SC AfterDiag',
    'D16 SC Final',
    'D17 LC ConfirmPenalty',
    'D18 LC ConfirmReason',
    'D19 SC ConfirmPenalty',
    'D20 SC ConfirmReason',
    'G01 Diag Long Adj',
    'G02 Diag Short Adj',
    'G03 Diag Long Conf',
    'G04 Diag Short Conf',
    'G05 Diag Long Break',
    'G06 Diag Short Break',
    'G07 Diag Long Stable',
    'G08 Diag Short Stable',
    'P01 Penalty_RSI_OB',
    'P02 Penalty_ADX_Weak',
    'P03 Penalty_TrendConflict',
    'P04 Penalty_NoBullStructure',
    'P05 Penalty_FastEMAStretch',
    'P06 Penalty_EMASpreadStretch',
    'P07 Penalty_VolumeWeak',
    'P08 Penalty_FailedRetest',
    'P09 Penalty_BearRetest',
    'P10 Penalty_BearSweep',
  ];
  let context = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      channel: 'chromium',
      viewport: { width: 1800, height: 1100 },
      acceptDownloads: true,
      downloadsPath: downloadDir,
      args: ['--enable-gpu', '--use-angle=d3d11', '--disable-dev-shm-usage']
    });

    for (const p of context.pages()) {
      try { await p.close({ runBeforeUnload: false }); } catch {}
    }

    const page = await context.newPage();
    await page.goto('https://www.tradingview.com/pine-screener/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(5000);
    await dismissOverlays(page);

    await ensureWatchlist(page, watchlist);
    await ensureIndicator(page, indicator);
    await ensureTimeframe(page, indicator, timeframeText);
    await runScan(page);
    await ensureColumns(page, screenerColumns);
    // Newly enabled Pine output columns may remain blank until the screener is rescanned.
    await runScan(page);

    const csvPath = await exportCsv(page, downloadDir, outCsv);
    const csvText = fs.readFileSync(csvPath, 'utf8');
    const parsed = parseCsv(csvText);
    const requiredColumns = ['01 Best Setup', '02 Best Score', '03 Final Long', '04 Final Short'];
    const missingRequired = requiredColumns.filter((col) => !parsed.headers.includes(col));
    if (missingRequired.length) {
      throw new Error(`v9.3 export missing required columns: ${missingRequired.join(', ')}. Headers: ${parsed.headers.join(', ')}`);
    }
    const summarized = summarizeRows(parsed.rows)
      .filter((row) => row.symbol)
      .filter((row) => minBestSetup == null || (row.bestSetupCode != null && row.bestSetupCode >= minBestSetup))
      .sort((a, b) => (b.bestScore ?? -Infinity) - (a.bestScore ?? -Infinity));

    const top5 = summarized.slice(0, 5);
    const markdownTable = buildTransposedMarkdown(top5, screenerColumns);
    const chatTitle = minBestSetup == null
      ? 'Top 5 by 02 Best Score (4H)'
      : `Top 5 by 02 Best Score (4H, 01 Best Setup >= ${formatCell(minBestSetup)})`;
    const chatTable = buildChatTable(top5, screenerColumns, chatTitle);
    const markdownPath = outJson.replace(/\.json$/i, '.md');
    const textPath = outJson.replace(/\.json$/i, '.txt');

    await page.screenshot({ path: screenshotPath, fullPage: false });

    const payload = {
      generatedAt: new Date().toISOString(),
      watchlist,
      indicator,
      timeframe: timeframeText,
      screenerColumns,
      filters: {
        minBestSetup: minBestSetup,
      },
      csvPath,
      rowCount: summarized.length,
      headers: parsed.headers,
      top5,
      top10: summarized.slice(0, 10),
      transposedTop5Markdown: markdownTable,
      transposedTop5Text: chatTable,
      markdownPath,
      textPath,
      screenshotPath,
    };

    fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(markdownPath, markdownTable, 'utf8');
    fs.writeFileSync(textPath, chatTable, 'utf8');
    console.log(JSON.stringify({ ok: true, outJson, csvPath, markdownPath, textPath, top5Symbols: top5.map((x) => x.symbol) }, null, 2));
    await context.close();
    process.exit(0);
  } catch (err) {
    const payload = {
      ok: false,
      error: err.message,
      stack: err.stack,
      generatedAt: new Date().toISOString(),
      outJson,
    };
    try { fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), 'utf8'); } catch {}
    if (context) {
      try { await context.close(); } catch {}
    }
    console.error(err.message);
    process.exit(1);
  }
})();

