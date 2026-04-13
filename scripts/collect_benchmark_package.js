#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BENCHMARK_SYMBOLS = [
  'AIOUSDT.P','ARIAUSDT.P','B3USDT.P','COTIUSDT.P','DEXEUSDT.P','GMXUSDT.P','ILVUSDT.P','INXUSDT.P','LDOUSDT.P','NEOUSDT.P','PROMUSDT.P','RECALLUSDT.P','SKRUSDT.P','SKYAIUSDT.P','STORJUSDT.P','TAGUSDT.P','VELVETUSDT.P','XAUUSDT.P'
];

const VERSION_MAP = {
  V6: 'OC Hybrid Edge Screener v6',
  V6PD: 'OC Hybrid Edge Screener v6PD',
  V8: 'OC Hybrid Edge Screener v8',
  V8b: 'OC Hybrid Edge Screener v8b',
};

const SCREENER_COLUMNS_PREFERRED = [
  'Symbol',
  'Description',
  '02 Best Setup Code',
  '03 Best Score',
  '04 Final Long Score',
  '05 Final Short Score',
  '10 Conviction State',
  '11 Trend Dir',
  '12 Macro Dir 1D',
  '16 ADX',
  '17 Rel Volume',
  '18 Dist Fast EMA ATR',
  '27 Verdict State',
  '29 Signed Conviction',
  '48 Winner Dir',
  '49 Winner Family Code',
  '50 Winner Margin',
  '51 Winner Base Score',
  '52 Winner Penalty',
  '53 Winner Tactical',
  '54 Winner Macro',
  '55 Winner Structure',
  '56 Winner ADX Fit',
  '57 Winner Lifecycle',
  '58 Winner Context Boost',
  '59 Winner Family Edge',
];

function fmtBerlinParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function benchmarkRunId(date = new Date()) {
  const p = fmtBerlinParts(date);
  return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}`;
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

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

async function fetchJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  if (json.code && json.code !== '00000') {
    throw new Error(`Bitget error ${json.code} for ${url}: ${json.msg || 'unknown'}`);
  }
  return json;
}

function toApiSymbol(tvSymbol) {
  return String(tvSymbol).replace(/\.P$/i, '');
}

async function exportRawCombined({ runId, outDir }) {
  const exportTimestampUtc = new Date().toISOString();
  const berlin = fmtBerlinParts(new Date());
  const exportTimestampBerlin = `${berlin.year}-${berlin.month}-${berlin.day} ${berlin.hour}:${berlin.minute}:${berlin.second}`;
  const rawRows = [];
  const missingSymbols = [];
  const failedExports = [];
  const timeframe = '4H';
  const limit = 200;

  for (const tvSymbol of BENCHMARK_SYMBOLS) {
    const apiSymbol = toApiSymbol(tvSymbol);
    try {
      const contract = await fetchJson(`https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol=${encodeURIComponent(apiSymbol)}`);
      if (!Array.isArray(contract.data) || !contract.data.length) {
        missingSymbols.push(tvSymbol);
        continue;
      }
      const candles = await fetchJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${encodeURIComponent(apiSymbol)}&productType=USDT-FUTURES&granularity=${encodeURIComponent(timeframe)}&limit=${limit}`);
      if (!Array.isArray(candles.data) || !candles.data.length) {
        failedExports.push({ symbol: tvSymbol, stage: 'candles', reason: 'No candle data returned' });
        continue;
      }
      for (const row of candles.data) {
        rawRows.push({
          benchmark_run_id: runId,
          export_timestamp_utc: exportTimestampUtc,
          export_timestamp_berlin: exportTimestampBerlin,
          timeframe,
          lookback_bars: limit,
          tv_symbol: tvSymbol,
          api_symbol: apiSymbol,
          open_time_ms: row[0],
          open_time_utc: new Date(Number(row[0])).toISOString(),
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          base_volume: row[5],
          quote_volume: row[6],
        });
      }
    } catch (err) {
      failedExports.push({ symbol: tvSymbol, stage: 'raw_export', reason: err.message || String(err) });
    }
  }

  const rawPath = path.join(outDir, `BENCH_${runId}_raw_combined.csv`);
  writeCsv(rawPath, [
    'benchmark_run_id','export_timestamp_utc','export_timestamp_berlin','timeframe','lookback_bars','tv_symbol','api_symbol','open_time_ms','open_time_utc','open','high','low','close','base_volume','quote_volume'
  ], rawRows);

  return {
    rawPath,
    rawRowCount: rawRows.length,
    exportTimestampUtc,
    exportTimestampBerlin,
    timeframe,
    lookbackBars: limit,
    missingSymbols,
    failedExports,
  };
}

function runNode(args, cwd) {
  const result = spawnSync('node', args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `node exited ${result.status}`).trim());
  }
  const text = (result.stdout || '').trim();
  const start = text.lastIndexOf('{');
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start));
    } catch {}
  }
  try {
    return JSON.parse(text);
  } catch {
    return { rawOutput: text };
  }
}

function extractScreenerRows(csvPath) {
  const { headers, rows } = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const bySymbol = new Map(rows.map((r) => [String(r.Symbol || '').trim().toUpperCase(), r]));
  const selectedHeaders = SCREENER_COLUMNS_PREFERRED.filter((h) => headers.includes(h));
  const outRows = [];
  const missingSymbols = [];
  for (const tvSymbol of BENCHMARK_SYMBOLS) {
    const row = bySymbol.get(tvSymbol.toUpperCase());
    if (!row) {
      missingSymbols.push(tvSymbol);
      continue;
    }
    const out = { benchmark_symbol: tvSymbol };
    for (const h of selectedHeaders) out[h] = row[h] ?? '';
    outRows.push(out);
  }
  return { selectedHeaders: ['benchmark_symbol', ...selectedHeaders], outRows, missingSymbols };
}

function exportScreenerVersion({ runId, versionKey, indicatorName, outDir, tradingviewRoot }) {
  const outJson = path.join(outDir, `BENCH_${runId}_${versionKey}.json`);
  const result = runNode([
    path.join(tradingviewRoot, 'scripts', 'pine_screener_export.js'),
    '--watchlist', 'BITGET_TRADFI',
    '--indicator', indicatorName,
    '--timeframe', '4H',
    '--out', outJson,
  ], tradingviewRoot);

  const payload = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  const sourceCsv = payload.csvPath || outJson.replace(/\.json$/i, '.csv');
  const { selectedHeaders, outRows, missingSymbols } = extractScreenerRows(sourceCsv);
  const outCsv = path.join(outDir, `BENCH_${runId}_${versionKey}.csv`);
  writeCsv(outCsv, selectedHeaders, outRows);

  return {
    version: versionKey,
    indicatorName,
    outCsv,
    sourceJson: outJson,
    sourceCsv,
    generatedAt: payload.generatedAt || null,
    rowCountFiltered: outRows.length,
    missingSymbols,
    top5Symbols: (payload.top5 || []).map((x) => x.symbol),
  };
}

(async () => {
  const workspaceTvflow = path.resolve(__dirname, '..');
  const tradingviewRoot = path.resolve(workspaceTvflow, '..', 'workspace', 'tradingview');
  const runId = benchmarkRunId(new Date());
  const outDir = path.join(workspaceTvflow, 'benchmarks', `BENCH_${runId}`);
  fs.mkdirSync(outDir, { recursive: true });

  const summary = {
    benchmarkRunId: runId,
    benchmarkSymbols: BENCHMARK_SYMBOLS,
    watchlist: 'BITGET_TRADFI',
    timeframe: '4H',
    requestedVersions: Object.keys(VERSION_MAP),
    startedAtUtc: new Date().toISOString(),
    raw: null,
    screenerExports: [],
    missingSymbols: { raw: [], screener: {} },
    failedExports: [],
  };

  const raw = await exportRawCombined({ runId, outDir });
  summary.raw = raw;
  summary.missingSymbols.raw = raw.missingSymbols;
  summary.failedExports.push(...raw.failedExports);

  for (const [versionKey, indicatorName] of Object.entries(VERSION_MAP)) {
    try {
      const screener = exportScreenerVersion({ runId, versionKey, indicatorName, outDir, tradingviewRoot });
      summary.screenerExports.push(screener);
      summary.missingSymbols.screener[versionKey] = screener.missingSymbols;
    } catch (err) {
      summary.failedExports.push({ version: versionKey, stage: 'screener_export', reason: err.message || String(err) });
    }
  }

  summary.finishedAtUtc = new Date().toISOString();
  const summaryPath = path.join(outDir, `BENCH_${runId}_summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({ outDir, summaryPath, summary }, null, 2));
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
