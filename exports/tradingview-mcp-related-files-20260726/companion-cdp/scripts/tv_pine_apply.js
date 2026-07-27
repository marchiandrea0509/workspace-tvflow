#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let chromium = null;

function parseArgs(argv) {
  const out = { replace: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'help') out.help = true;
    else if (key === 'symbol') out.symbol = next, i++;
    else if (key === 'chart-url') out.chartUrl = next, i++;
    else if (key === 'profile') out.profile = next, i++;
    else if (key === 'code-file') out.codeFile = next, i++;
    else if (key === 'max-iters') out.maxIters = Number(next), i++;
    else if (key === 'headful') out.headful = true;
    else if (key === 'replace') out.replace.push(next), i++;
    else if (key === 'out') out.out = next, i++;
    else if (key === 'cdp-url') out.cdpUrl = next, i++;
    else if (key === 'script-name') out.scriptName = next, i++;
    else if (key === 'run-marker') out.runMarker = next, i++;
    else if (key === 'download-dir') out.downloadDir = next, i++;
    else if (key === 'no-export-first') out.noExportFirst = true;
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node tradingview/scripts/tv_pine_apply.js [options]',
    '',
    'Options:',
    '  --symbol <TV_SYMBOL>         TradingView symbol (default: PAXGUSDT.P)',
    '  --chart-url <url>            Chart URL to use/attach',
    '  --profile <path>             Persistent Playwright profile path',
    '  --code-file <path>           Pine file to load into editor (optional)',
    '  --replace "old=>new"         Targeted text replacement (repeatable)',
    '  --max-iters <n>              Max compile/patch attempts (default: 5)',
    '  --headful                    Run with visible browser',
    '  --out <json_path>            Custom JSON report output path',
    '  --cdp-url <http://host:port> Attach to an already running Chromium via CDP',
    '  --script-name <name>         Open script by exact name before editing (best effort)',
    '  --run-marker <id>            Unique marker appended to strategy/indicator title',
    '  --download-dir <path>        Directory for Strategy Tester CSV exports',
    '  --no-export-first            Skip CSV export path and rely on DOM metrics only',
    '  --help                       Show this help',
    '',
    'Behavior:',
    '  - Default mode: launch persistent Playwright profile and reuse login/session state',
    '  - CDP mode (--cdp-url): attach to an already running Chromium/Chrome process',
    '  - Never logs out/clears session',
    '  - Avoids refresh by default (navigates only when needed)',
    '  - Adds deterministic run markers to script titles for identity checks',
    '  - Prefers Strategy Tester CSV export as source-of-truth (export-first)',
    '  - Reads compiler/log feedback and auto-patches small common Pine issues',
    '  - Iterates up to max-iters and writes JSON+PNG artifacts'
  ].join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

try {
  ({ chromium } = require('playwright'));
} catch (err) {
  console.error('Missing dependency: playwright');
  console.error('Install it in this workspace with: npm i playwright');
  process.exit(1);
}

const PROFILE = args.profile || process.env.TV_PROFILE || '/home/andrea/openclaw/workspace/tradingview/profile';
const SYMBOL = args.symbol || process.env.TV_SYMBOL || 'PAXGUSDT.P';
const MAX_ITERS = Number.isFinite(args.maxIters) && args.maxIters > 0 ? Math.min(args.maxIters, 20) : 5;
const CHART_URL = args.chartUrl || `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(SYMBOL)}`;
const CDP_URL = args.cdpUrl || process.env.TV_CDP_URL || null;
const SCRIPT_NAME = args.scriptName || process.env.TV_SCRIPT_NAME || null;
const RUN_MARKER = args.runMarker || process.env.TV_RUN_MARKER || `RUN_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
const EXPORT_FIRST = !args.noExportFirst;
const DOWNLOAD_DIR = args.downloadDir || process.env.TV_DOWNLOAD_DIR || '/home/andrea/openclaw/workspace/tradingview/downloads';

const LOG_DIR = '/home/andrea/openclaw/workspace/tradingview/logs';
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const STAMP = Date.now();
const REPORT_PATH = args.out || path.join(LOG_DIR, `tv_pine_apply_${STAMP}.json`);
const SCREENSHOT_PATH = path.join(LOG_DIR, `tv_pine_apply_${STAMP}.png`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickFirst(page, selectors, timeout = 3000) {
  for (const s of selectors) {
    const el = page.locator(s).first();
    try {
      await el.waitFor({ state: 'visible', timeout });
      await el.click({ timeout });
      return s;
    } catch {}
  }
  return null;
}

function uniqCompact(lines, max = 40) {
  const out = [];
  const seen = new Set();
  for (const raw of lines || []) {
    const line = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line.length > 260) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

async function detectSecurityBlocker(page) {
  const text = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
  const checks = [
    { k: 'captcha', r: /captcha|i am not a robot|robot check/ },
    { k: 'mfa', r: /two-factor|2fa|authenticator|verification code|one-time code|otp/ },
    { k: 'security_prompt', r: /security check|verify you are human|suspicious activity|confirm it'?s you/ }
  ];
  for (const c of checks) {
    if (c.r.test(text)) return c.k;
  }
  return null;
}

async function openPine(page) {
  const alreadyOpen = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    if (document.querySelector('.monaco-editor')) return true;
    if (document.querySelector('textarea[aria-label^="Editor content"]')) return true;
    if (/Pine Script® v\d+/i.test(body)) return true;
    if (/Publish script/i.test(body) && /Untitled script|Pine/i.test(body)) return true;
    return false;
  });
  if (alreadyOpen) return 'already_open';

  const opened = await clickFirst(page, [
    'button[aria-label="Pine"]',
    'button:has-text("Pine Editor")',
    '[role="tab"]:has-text("Pine Editor")',
    'button:has-text("Pine")',
    'text=Pine Editor'
  ], 5000);
  await sleep(700);
  return opened;
}

async function ensureEditorEditable(page) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const hasHistoricalBanner = await page.evaluate(() => {
      const txt = (document.body?.innerText || '').toLowerCase();
      return txt.includes('historical version of the script');
    });

    if (!hasHistoricalBanner) return { restored: false };

    let restoreBtn = await clickFirst(page, [
      'button:has-text("Restore this version")',
      'button:has-text("Restore version")',
      'a:has-text("Restore this version")',
      'text=Restore this version',
      'text=restore this version'
    ], 1200);

    if (!restoreBtn) {
      try {
        const link = page.locator('text=/restore this version/i').first();
        await link.click({ timeout: 1200 });
        restoreBtn = 'text=/restore this version/i';
      } catch {}
    }

    if (!restoreBtn) {
      const jsClicked = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('a,button,span,div'));
        const target = candidates.find(el => /restore this version/i.test(el.textContent || ''));
        if (!target) return false;
        target.click();
        return true;
      });
      if (jsClicked) restoreBtn = 'js:textContent restore this version';
    }

    if (restoreBtn) {
      await sleep(700);
      await clickFirst(page, [
        'button:has-text("Restore")',
        'button:has-text("Confirm")',
        'button:has-text("OK")'
      ], 1200);
      await sleep(1000);

      const stillHistorical = await page.evaluate(() => {
        const txt = (document.body?.innerText || '').toLowerCase();
        return txt.includes('historical version of the script');
      });

      if (!stillHistorical) return { restored: true, via: restoreBtn, attempt };
    }

    await sleep(700);
  }

  return { restored: false, blocked: true };
}

async function readEditorText(page) {
  const res = await page.evaluate(() => {
    const byTextarea = document.querySelector('textarea[aria-label^="Editor content"]')
      || document.querySelector('.monaco-editor textarea.inputarea')
      || document.querySelector('textarea.inputarea');

    if (byTextarea && typeof byTextarea.value === 'string' && byTextarea.value.length > 0) {
      return { ok: true, source: 'textarea', text: byTextarea.value };
    }

    try {
      const models = window.monaco?.editor?.getModels?.() || [];
      if (models.length > 0) {
        const text = models[0].getValue();
        return { ok: true, source: 'monaco-model', text };
      }
    } catch {}

    return { ok: false, source: 'none', text: '' };
  });

  return res;
}

async function setEditorText(page, code) {
  const res = await page.evaluate((src) => {
    try {
      const models = window.monaco?.editor?.getModels?.() || [];
      if (models.length > 0) {
        models[0].setValue(src);
        return { ok: true, source: 'monaco-model' };
      }
    } catch {}

    const ta = document.querySelector('textarea[aria-label^="Editor content"]')
      || document.querySelector('.monaco-editor textarea.inputarea')
      || document.querySelector('textarea.inputarea');
    if (ta) {
      // TradingView's textarea is often just Monaco's hidden input shim.
      // Writing ta.value directly is unreliable and can produce false positives.
      ta.focus();
      return { ok: false, source: 'textarea-input-shim' };
    }

    return { ok: false, source: 'none' };
  }, code);

  if (res.ok) return res;

  const focused = await clickFirst(page, [
    '.monaco-editor',
    '.view-lines',
    'textarea.inputarea'
  ], 2500);

  if (!focused) return { ok: false, source: 'keyboard-failed' };

  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(code, { delay: 0 });
  return { ok: true, source: 'keyboard' };
}

async function applyCompile(page) {
  const btn = await clickFirst(page, [
    'button:has-text("Update on chart")',
    'button:has-text("Add to chart")',
    '[data-name="apply-common-tooltip"]',
    'text=Update on chart',
    'text=Add to chart'
  ], 4000);

  if (!btn) {
    await page.keyboard.press('Control+Enter');
  }

  // TradingView may prompt when script has unsaved changes.
  await sleep(600);
  const saveAndAdd = await clickFirst(page, [
    'button:has-text("Save and add to chart")',
    'button:has-text("Save & add to chart")',
    'text=Save and add to chart'
  ], 1500);

  if (saveAndAdd) {
    await sleep(1500);
  }

  await sleep(1200);
  return saveAndAdd ? `${btn || 'Ctrl+Enter'} + save_and_add` : (btn || 'Ctrl+Enter');
}

async function saveLayout(page) {
  await page.keyboard.press('Control+S');
  await sleep(900);
  await clickFirst(page, [
    'button:has-text("Save")',
    'button:has-text("Save all charts")',
    'button:has-text("OK")'
  ], 1200);
}

async function verifySessionGate(page, expectedChartUrl) {
  try { await page.bringToFront(); } catch {}
  const title = await page.title().catch(() => '');
  const url = page.url() || '';
  const onChart = /tradingview\.com\/chart\//i.test(url);
  const titleOk = Boolean(String(title || '').trim().length > 0);
  const expectedOk = expectedChartUrl
    ? (url.startsWith(expectedChartUrl) || new URL(url).pathname.startsWith('/chart/'))
    : true;
  return {
    ok: onChart && titleOk,
    onChart,
    titleOk,
    expectedOk,
    url,
    title
  };
}

async function openScriptByName(page, scriptName) {
  if (!scriptName) return { ok: false, reason: 'no-script-name' };

  const openedPine = await openPine(page);
  if (!openedPine) return { ok: false, reason: 'pine-not-open' };

  let clickedHeader = null;
  clickedHeader = await clickFirst(page, [
    '[data-name="pine-dialog"] .nameButton-jEEqIAK2',
    '.tv-script-widget .nameButton-jEEqIAK2',
    'div.nameButton-jEEqIAK2'
  ], 1500);

  if (!clickedHeader) {
    return { ok: false, reason: 'script-menu-not-opened' };
  }

  await sleep(500);

  const selected = await clickFirst(page, [
    `text=${scriptName}`,
    `[role="menuitem"]:has-text("${scriptName}")`,
    `button:has-text("${scriptName}")`,
    `div:has-text("${scriptName}")`
  ], 1600);

  if (!selected) return { ok: false, reason: 'script-name-not-found' };
  await sleep(700);
  return { ok: true, selected, clickedHeader };
}

async function waitForApplyOutcome(page, expectedScriptName = null, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await page.evaluate((expectedName) => {
      const body = document.body?.innerText || '';
      const lines = body.split(/\n+/).map(s => s.trim()).filter(Boolean);
      const hasCompileError = /error at|indicator error|cannot use|mismatched input|no viable alternative/i.test(body);
      const hasReport = lines.includes('Strategy Report');
      const hasExpected = expectedName ? body.toLowerCase().includes(String(expectedName).toLowerCase()) : null;
      return { hasCompileError, hasReport, hasExpected };
    }, expectedScriptName);

    if (snapshot.hasCompileError) return { outcome: 'compile_error', snapshot };
    if (snapshot.hasReport || snapshot.hasExpected) return { outcome: 'applied', snapshot };
    await sleep(500);
  }
  return { outcome: 'timeout', snapshot: null };
}

async function exportStrategyCsv(page, context, downloadDir, kind = 'Performance Summary') {
  try { await page.bringToFront(); } catch {}

  await clickFirst(page, [
    'button:has-text("Strategy Report")',
    '.tab-n3UmcVi3 button:has-text("Strategy Report")'
  ], 1200);

  await sleep(350);
  await clickFirst(page, [
    'button:has-text("More")',
    '[aria-label="More"]',
    '.container-rQLA_iPz button:has-text("More")'
  ], 1400);

  await sleep(350);

  const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  const clicked = await clickFirst(page, [
    `text=Download ${kind}`,
    `text=Export ${kind}`,
    'text=Download',
    'text=Export'
  ], 1600);

  if (!clicked) {
    return { ok: false, reason: 'download-menu-item-not-found', kind };
  }

  const dl = await downloadPromise;
  if (!dl) return { ok: false, reason: 'download-event-timeout', kind };

  const suggested = dl.suggestedFilename();
  const target = path.join(downloadDir, `${Date.now()}_${suggested}`);
  await dl.saveAs(target);

  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!stat || stat.size <= 0) {
    return { ok: false, reason: 'download-empty', path: target, kind };
  }

  const head = fs.readFileSync(target, 'utf8').slice(0, 500);
  return {
    ok: true,
    kind,
    path: target,
    filename: suggested,
    size: stat.size,
    header: head
  };
}

function extractMetricsFromCsv(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(0, 500);
    const joined = lines.join('\n');

    let totalPnL = null;
    let totalTrades = null;

    const pnlMatch = joined.match(/Total\s*P&L[^\n]*[;,]\s*([+\-]?[\d.,]+)/i)
      || joined.match(/Net\s*P&L[^\n]*[;,]\s*([+\-]?[\d.,]+)/i);
    if (pnlMatch) totalPnL = pnlMatch[1];

    const tradesMatch = joined.match(/Total\s*trades[^\n]*[;,]\s*(\d+)/i)
      || joined.match(/Number\s*of\s*trades[^\n]*[;,]\s*(\d+)/i);
    if (tradesMatch) totalTrades = tradesMatch[1];

    return {
      ok: true,
      totalPnL,
      totalTrades,
      header: lines.slice(0, 8)
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function extractScriptName(code) {
  const src = String(code || '');
  const m1 = src.match(/\bindicator\s*\(\s*"([^"]+)"/i);
  if (m1 && m1[1]) return m1[1].trim();
  const m2 = src.match(/\bstudy\s*\(\s*"([^"]+)"/i);
  if (m2 && m2[1]) return m2[1].trim();
  const m3 = src.match(/\bstrategy\s*\(\s*"([^"]+)"/i);
  if (m3 && m3[1]) return m3[1].trim();
  return null;
}

function detectScriptType(code) {
  const src = String(code || '');
  if (/\bstrategy\s*\(/i.test(src)) return 'strategy';
  if (/\bindicator\s*\(/i.test(src)) return 'indicator';
  if (/\bstudy\s*\(/i.test(src)) return 'study';
  return 'unknown';
}

function injectRunMarker(code, marker) {
  const src = String(code || '');
  if (!marker) return { code: src, changed: false, name: extractScriptName(src), type: detectScriptType(src) };

  const appendMarker = (name) => {
    const base = String(name || '').trim();
    if (!base) return marker;
    if (/\bRUN[=:]/i.test(base) || base.includes(marker)) return base;
    return `${base} | ${marker}`;
  };

  let changed = false;
  let out = src;

  out = out.replace(/\b(strategy|indicator|study)\s*\(\s*"([^"]+)"/i, (m, kind, title) => {
    const next = appendMarker(title);
    if (next !== title) changed = true;
    return `${kind}("${next}"`;
  });

  return {
    code: out,
    changed,
    name: extractScriptName(out),
    type: detectScriptType(out)
  };
}

async function collectFeedback(page, expectedScriptName = null, expectedRunMarker = null) {
  const hasIndicatorError = (await page.locator('button:has-text("Indicator error")').count()) > 0;

  const diag = await page.evaluate(({ expectedName, runMarker }) => {
    const body = document.body?.innerText || '';
    const lines = body.split(/\n+/).map(s => s.trim()).filter(Boolean);

    const keep = [];
    const key = /(error|warning|compiling|opened|pine|script|line \d+|undeclared|mismatched input|cannot call|no viable alternative)/i;
    for (const ln of lines) {
      if (key.test(ln)) keep.push(ln);
      if (keep.length > 250) break;
    }

    const errors = keep.filter(l => /(error\b|error at|indicator error|undeclared|mismatched input|cannot call|no viable alternative|syntax)/i.test(l));
    const warnings = keep.filter(l => /\bwarning\b/i.test(l));
    const pineRows = keep.filter(l => /(compiling|opened|pine)/i.test(l)).slice(0, 25);

    const hasScriptName = expectedName
      ? body.toLowerCase().includes(String(expectedName).toLowerCase())
      : null;
    const hasRunMarker = runMarker
      ? body.toLowerCase().includes(String(runMarker).toLowerCase())
      : null;

    return {
      errors,
      warnings,
      pineRows,
      hasScriptName,
      hasRunMarker,
      bodySample: lines.slice(0, 120)
    };
  }, { expectedName: expectedScriptName, runMarker: expectedRunMarker });

  const errors = uniqCompact(diag.errors, 20);
  const warnings = uniqCompact(diag.warnings, 20);
  const pineRows = uniqCompact(diag.pineRows, 30);

  return {
    hasIndicatorError,
    hasScriptName: diag.hasScriptName,
    hasRunMarker: diag.hasRunMarker,
    errors,
    warnings,
    pineRows,
    ok: !hasIndicatorError && errors.length === 0
  };
}

function applyReplaceDirectives(code, replaceDirectives) {
  if (!replaceDirectives || replaceDirectives.length === 0) return { code, changes: [] };
  let out = code;
  const changes = [];
  for (const rule of replaceDirectives) {
    const idx = rule.indexOf('=>');
    if (idx <= 0) continue;
    const oldText = rule.slice(0, idx);
    const newText = rule.slice(idx + 2);
    if (!oldText) continue;
    if (out.includes(oldText)) {
      out = out.split(oldText).join(newText);
      changes.push(`replace: "${oldText}" => "${newText}"`);
    }
  }
  return { code: out, changes };
}

function patchCode(code, feedback) {
  let out = code;
  const changes = [];
  const diagText = `${(feedback.errors || []).join('\n')}\n${(feedback.warnings || []).join('\n')}`;

  const smartQuoteFixed = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  if (smartQuoteFixed !== out) {
    out = smartQuoteFixed;
    changes.push('normalized smart quotes to plain ASCII quotes');
  }

  if (!/^\s*\/\/@version=\d+/m.test(out)) {
    out = `//@version=5\n${out}`;
    changes.push('added missing //@version=5 directive');
  }

  if (/\bstudy\s*\(/.test(out)) {
    out = out.replace(/\bstudy\s*\(/g, 'indicator(');
    changes.push('replaced deprecated study(...) with indicator(...)');
  }

  if (/\bsecurity\s*\(/.test(out) && !/\brequest\.security\s*\(/.test(out)) {
    out = out.replace(/\bsecurity\s*\(/g, 'request.security(');
    changes.push('updated security(...) to request.security(...) for v5');
  }

  if (/input\.integer\s*\(/.test(out)) {
    out = out.replace(/input\.integer\s*\(/g, 'input.int(');
    changes.push('updated input.integer(...) to input.int(...)');
  }

  if (/input\.bool\s*\(/.test(out) && /Undeclared identifier/i.test(diagText)) {
    out = out.replace(/input\.bool\s*\(/g, 'input.bool(');
  }

  if (/mismatched input|no viable alternative|syntax/i.test(diagText)) {
    const trimmedTrailingSpaces = out.replace(/[ \t]+$/gm, '');
    if (trimmedTrailingSpaces !== out) {
      out = trimmedTrailingSpaces;
      changes.push('trimmed trailing spaces to reduce parser noise');
    }
  }

  return {
    changed: out !== code,
    code: out,
    summary: changes.length ? changes.join('; ') : 'no safe auto-patch available'
  };
}

function summarizeIteration(iter) {
  return {
    iteration: iter.iteration,
    observed_issue: iter.observedIssue,
    code_change: iter.codeChange,
    compile_result: iter.compileResult,
    next_action: iter.nextAction
  };
}

(async () => {
  const report = {
    ok: false,
    stamp: STAMP,
    chartUrl: CHART_URL,
    symbol: SYMBOL,
    profile: PROFILE,
    mode: CDP_URL ? 'cdp-attach' : 'persistent-launch',
    cdpUrl: CDP_URL,
    scriptName: SCRIPT_NAME,
    runMarker: RUN_MARKER,
    exportFirst: EXPORT_FIRST,
    downloadDir: DOWNLOAD_DIR,
    maxIters: MAX_ITERS,
    blockedManual: false,
    blockedReason: null,
    failureBucket: null,
    steps: [],
    iterations: [],
    final: null,
    artifacts: {
      screenshot: SCREENSHOT_PATH,
      report: REPORT_PATH
    }
  };

  const usingCDP = Boolean(CDP_URL);
  let browser = null;
  let context = null;
  let page = null;

  if (usingCDP) {
    browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    const allPages = contexts.flatMap(c => c.pages());

    page = allPages.find(p => (p.url() || '') === CHART_URL)
      || allPages.find(p => /tradingview\.com/i.test(p.url() || ''))
      || null;

    if (!page) {
      const baseContext = contexts[0];
      if (!baseContext) throw new Error('No open browser context over CDP. Open at least one browser tab first.');
      page = await baseContext.newPage();
    }

    context = page.context();
    report.steps.push('attached_cdp_browser');
  } else {
    context = await chromium.launchPersistentContext(PROFILE, {
      headless: !args.headful,
      channel: 'chromium',
      viewport: { width: 1600, height: 1000 },
      args: ['--disable-dev-shm-usage']
    });

    page = context.pages().find(p => /tradingview\.com/i.test(p.url()));
    if (!page) page = context.pages()[0] || await context.newPage();
  }

  try {
    const currentUrl = page.url() || '';
    const onTradingView = /tradingview\.com/i.test(currentUrl);
    const onChart = /\/chart\//.test(currentUrl);
    const explicitChartRequested = Boolean(args.chartUrl);

    if (!onTradingView) {
      await page.goto(CHART_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      report.steps.push('opened_chart');
    } else if (!onChart) {
      await page.goto(CHART_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      report.steps.push('navigated_to_chart');
    } else if (explicitChartRequested && currentUrl !== CHART_URL) {
      await page.goto(CHART_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      report.steps.push('navigated_to_explicit_chart_url');
    } else {
      report.steps.push('attached_existing_chart_tab');
    }

    await sleep(3000);

    await clickFirst(page, [
      'button:has-text("Accept")',
      'button:has-text("Got it")',
      'button:has-text("No thanks")',
      'button[aria-label="Close"]'
    ], 1000);

    const sessionGate = await verifySessionGate(page, CHART_URL);
    report.steps.push(`session_gate:${sessionGate.ok ? 'ok' : 'fail'}`);
    report.sessionGate = sessionGate;
    if (!sessionGate.ok) {
      report.failureBucket = 'session';
      throw new Error(`Session gate failed (onChart=${sessionGate.onChart}, titleOk=${sessionGate.titleOk})`);
    }

    const blocker = await detectSecurityBlocker(page);
    if (blocker) {
      report.blockedManual = true;
      report.blockedReason = blocker;
      report.failureBucket = 'session';
      report.final = {
        status: 'blocked',
        message: `Manual help required: ${blocker}`
      };
      throw new Error(`Blocked by ${blocker}`);
    }

    const pineOpened = await openPine(page);
    if (!pineOpened) {
      report.failureBucket = 'editor';
      throw new Error('Could not open Pine Editor');
    }
    report.steps.push('opened_pine_editor');

    if (SCRIPT_NAME) {
      const openedByName = await openScriptByName(page, SCRIPT_NAME);
      report.steps.push(`open_script_by_name:${openedByName.ok ? 'ok' : openedByName.reason}`);
    }

    const editable = await ensureEditorEditable(page);
    if (editable.restored) report.steps.push('restored_historical_version');

    let workingCode = null;
    if (args.codeFile) {
      const abs = path.resolve(args.codeFile);
      workingCode = fs.readFileSync(abs, 'utf8');
      report.steps.push('loaded_code_file');
    } else {
      const read0 = await readEditorText(page);
      workingCode = read0.text || '';
      report.steps.push('loaded_code_from_editor');
    }

    const replaceApplied = applyReplaceDirectives(workingCode, args.replace || []);
    workingCode = replaceApplied.code;
    if (replaceApplied.changes.length) report.steps.push('applied_targeted_replacements');

    const markerApplied = injectRunMarker(workingCode, RUN_MARKER);
    workingCode = markerApplied.code;
    report.scriptIdentity = {
      declaredType: markerApplied.type,
      expectedName: markerApplied.name,
      runMarkerInjected: markerApplied.changed || Boolean(markerApplied.name?.includes(RUN_MARKER))
    };
    if (markerApplied.changed) report.steps.push('injected_run_marker');

    let lastFeedback = null;

    for (let i = 1; i <= MAX_ITERS; i++) {
      const iter = {
        iteration: i,
        observedIssue: null,
        codeChange: null,
        compileResult: null,
        nextAction: null,
        details: {}
      };

      const set = await setEditorText(page, workingCode);
      iter.details.editorSet = set;

      const readBack = await readEditorText(page);
      const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const expectedHead = norm(workingCode).slice(0, 80);
      const actualHead = norm(readBack.text).slice(0, 160);
      const editorMatched = expectedHead.length > 0 && (
        actualHead === expectedHead ||
        actualHead.includes(expectedHead.slice(0, Math.min(40, expectedHead.length)))
      );
      iter.details.editorReadBack = {
        ok: readBack.ok,
        source: readBack.source,
        matchedHead: editorMatched,
        expectedHead,
        actualHead
      };

      if (!editorMatched && i === 1) {
        const force = await setEditorText(page, workingCode);
        iter.details.editorSetForce = force;
      }

      const applyVia = await applyCompile(page);
      iter.details.applyVia = applyVia;

      const expectedScriptName = extractScriptName(workingCode);
      const applyOutcome = await waitForApplyOutcome(page, expectedScriptName, 12000);
      iter.details.applyOutcome = applyOutcome;

      const expectedRunMarker = RUN_MARKER;
      const feedback = await collectFeedback(page, expectedScriptName, expectedRunMarker);
      iter.details.expectedScriptName = expectedScriptName;
      iter.details.expectedRunMarker = expectedRunMarker;
      lastFeedback = feedback;
      iter.details.feedback = feedback;

      const firstErr = feedback.errors[0] || null;
      const firstWarn = feedback.warnings[0] || null;
      const strictEditorMatch = Boolean(args.codeFile) && !usingCDP;
      const editorMismatch = strictEditorMatch && !iter.details?.editorReadBack?.matchedHead;
      const scriptNameMismatch = feedback.hasScriptName === false;
      const runMarkerMismatch = feedback.hasRunMarker === false;
      const applyTimeout = applyOutcome?.outcome === 'timeout';

      if (feedback.ok && !editorMismatch && !scriptNameMismatch && !runMarkerMismatch && !applyTimeout) {
        iter.observedIssue = 'No compiler errors detected';
        iter.codeChange = i === 1 && replaceApplied.changes.length
          ? replaceApplied.changes.join('; ')
          : 'none';
        iter.compileResult = 'success';
        iter.nextAction = 'save and finish';
        report.iterations.push(summarizeIteration(iter));
        report.ok = true;
        break;
      }

      iter.observedIssue = editorMismatch
        ? 'Editor content did not match requested script (historical/read-only or UI state issue)'
        : (scriptNameMismatch
          ? 'Expected script name not visible on chart/editor after apply'
          : (runMarkerMismatch
            ? 'Run marker not detected after apply (identity gate failed)'
            : (applyOutcome?.outcome === 'timeout'
              ? 'Apply timeout: chart/tester state did not refresh in time'
              : (firstErr || firstWarn || 'Compile feedback indicates an issue'))));

      if (editorMismatch || scriptNameMismatch || runMarkerMismatch || applyTimeout) {
        iter.codeChange = 'none';
        iter.compileResult = 'failed';
        iter.nextAction = i < MAX_ITERS
          ? (applyTimeout
            ? 'retry: wait for apply refresh and re-read chart/tester state'
            : 'retry: reopen editable script state and rewrite code')
          : (applyTimeout
            ? 'manual intervention recommended (apply timeout / chart state not refreshed)'
            : 'manual intervention recommended (editor/script did not match expected state)');
        report.iterations.push(summarizeIteration(iter));

        if (i < MAX_ITERS) {
          await openPine(page);
          await ensureEditorEditable(page);
          continue;
        }
        report.failureBucket = applyTimeout ? 'apply' : 'editor';
        break;
      }

      const patch = patchCode(workingCode, feedback);
      if (patch.changed) {
        workingCode = patch.code;
        iter.codeChange = patch.summary;
        iter.compileResult = 'failed';
        iter.nextAction = i < MAX_ITERS ? 'retry with targeted auto-patch' : 'max iterations reached';
      } else {
        iter.codeChange = 'none';
        iter.compileResult = 'failed';
        iter.nextAction = 'manual intervention recommended (no safe patch found)';
        report.iterations.push(summarizeIteration(iter));
        report.failureBucket = 'compile';
        break;
      }

      report.iterations.push(summarizeIteration(iter));
    }

    if (!report.ok && !report.failureBucket) {
      report.failureBucket = lastFeedback?.errors?.length ? 'compile' : 'apply';
    }

    if (EXPORT_FIRST && report.ok && report.scriptIdentity?.declaredType === 'strategy') {
      const perfExport = await exportStrategyCsv(page, context, DOWNLOAD_DIR, 'Performance Summary');
      const tradesExport = await exportStrategyCsv(page, context, DOWNLOAD_DIR, 'List of Trades');
      report.exports = {
        performance: perfExport,
        trades: tradesExport
      };

      if (perfExport.ok) {
        report.metricsFromCsv = extractMetricsFromCsv(perfExport.path);
      }

      if (!perfExport.ok && !tradesExport.ok) {
        report.steps.push('export_first_failed_fallback_dom');
      } else {
        report.steps.push('export_first_completed');
      }
    }

    await saveLayout(page);
    report.steps.push('saved_layout');

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    report.steps.push('captured_screenshot');

    report.final = {
      status: report.ok ? 'success' : 'failed',
      issue: !report.ok ? (lastFeedback?.errors?.[0] || 'Unknown compile issue') : null,
      failureBucket: report.failureBucket,
      feedback: lastFeedback,
      metricsSource: report.metricsFromCsv?.ok ? 'csv' : 'dom'
    };

    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    const lines = [];
    lines.push(`tv_pine_apply: ${report.ok ? 'PASS' : 'FAIL'} (${report.iterations.length} iteration(s))`);
    for (const it of report.iterations) {
      lines.push(`iter ${it.iteration}: issue="${it.observed_issue}" | change="${it.code_change}" | compile=${it.compile_result} | next="${it.next_action}"`);
    }
    if (report.metricsFromCsv?.ok) {
      lines.push(`metrics(csv): totalPnL=${report.metricsFromCsv.totalPnL || 'n/a'} totalTrades=${report.metricsFromCsv.totalTrades || 'n/a'}`);
    }
    if (report.exports?.performance && !report.exports.performance.ok) {
      lines.push(`export(performance): failed reason=${report.exports.performance.reason}`);
    }
    lines.push(`report=${REPORT_PATH}`);
    lines.push(`screenshot=${SCREENSHOT_PATH}`);
    console.log(lines.join('\n'));
  } catch (err) {
    try {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    } catch {}

    if (!report.final) {
      report.final = {
        status: report.blockedManual ? 'blocked' : 'error',
        message: String(err.message || err),
        failureBucket: report.failureBucket || 'session'
      };
    }

    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    const prefix = report.blockedManual
      ? `tv_pine_apply: BLOCKED (manual help required: ${report.blockedReason})`
      : `tv_pine_apply: ERROR ${err.message}`;
    console.log([prefix, `report=${REPORT_PATH}`, `screenshot=${SCREENSHOT_PATH}`].join('\n'));
    process.exitCode = 1;
  } finally {
    if (usingCDP) {
      try { await browser?.close(); } catch {}
    } else {
      try { await context?.close(); } catch {}
    }
  }
})();
