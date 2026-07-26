const fs = require('fs');
const path = require('path');
const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');
const { parseArgs } = require('../lib/cli');

function asList(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.orderList)) return data.orderList;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  if (Array.isArray(data?.fillList)) return data.fillList;
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

function endIdFrom(data, rows) {
  if (data && typeof data === 'object') {
    for (const k of ['endId', 'lastEndId', 'nextId']) {
      if (data[k]) return String(data[k]);
    }
  }
  const last = rows[rows.length - 1] || {};
  for (const k of ['orderId', 'tradeId', 'planOrderId', 'id']) {
    if (last[k]) return String(last[k]);
  }
  return '';
}

function rowKey(row, label) {
  if (!row || typeof row !== 'object') return JSON.stringify(row);
  return [label, row.orderId || row.tradeId || row.planOrderId || row.id || '', row.cTime || row.uTime || '', row.symbol || '', row.tradeSide || '', row.side || '', row.priceAvg || row.price || '', row.baseVolume || row.size || ''].join('|');
}

function parseSinceMs(args) {
  if (args.since) {
    const ms = Date.parse(args.since);
    if (!Number.isFinite(ms)) throw new Error(`Invalid --since date: ${args.since}`);
    return ms;
  }
  const sinceDays = Number(args.sinceDays || 3650);
  return Date.now() - sinceDays * 24 * 60 * 60 * 1000;
}

async function fetchPaged(client, label, pathName, baseQuery, { limit, maxPages }) {
  const rows = [];
  const seen = new Set();
  const pages = [];
  let idLessThan = undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const query = { ...baseQuery, limit: String(limit), ...(idLessThan ? { idLessThan } : {}) };
    const res = await client.get(pathName, query);
    const pageRows = asList(res);
    const cursor = endIdFrom(res?.data, pageRows);
    pages.push({ ok: true, count: pageRows.length, idLessThan: idLessThan || '', endId: cursor });
    for (const row of pageRows) {
      const key = rowKey(row, label);
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    }
    if (pageRows.length < limit || !cursor || cursor === idLessThan) break;
    idLessThan = cursor;
  }
  return { label, ok: true, path: pathName, query: baseQuery, count: rows.length, pages, data: rows };
}

async function fetchWindow(client, label, pathName, query, opts) {
  try {
    return await fetchPaged(client, label, pathName, query, opts);
  } catch (err) {
    return { label, ok: false, path: pathName, query, count: 0, error: err.message || String(err), data: [] };
  }
}

function mergeWindowResults(label, pathName, queryBase, windowResults) {
  const seen = new Set();
  const merged = [];
  for (const result of windowResults) {
    for (const row of result.data || []) {
      const key = rowKey(row, label);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(row);
      }
    }
  }
  merged.sort((a, b) => Number(b.cTime || b.uTime || 0) - Number(a.cTime || a.uTime || 0));
  return {
    label,
    ok: windowResults.every(r => r.ok),
    path: pathName,
    query: queryBase,
    count: merged.length,
    windows: windowResults.map(r => ({ ok: r.ok, count: r.count, startTime: r.query?.startTime, endTime: r.query?.endTime, error: r.error, pages: r.pages?.length || 0 })),
    data: merged,
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getDefaultTradingConfig();
  const client = new BitgetClient();
  const productType = args.productType || cfg.productType;
  const symbol = args.symbol || undefined;
  const limit = Number(args.limit || 100);
  const maxPages = Number(args.maxPages || 20);
  const chunkDays = Number(args.chunkDays || 90);
  const sinceMs = parseSinceMs(args);
  const untilMs = args.until ? Date.parse(args.until) : Date.now();
  if (!Number.isFinite(untilMs)) throw new Error(`Invalid --until date: ${args.until}`);

  const endpoints = [
    ['orders-history', '/api/v2/mix/order/orders-history', {}],
    ['fills', '/api/v2/mix/order/fills', {}],
    ['orders-plan-history', '/api/v2/mix/order/orders-plan-history', { planType: args.planType || 'normal_plan' }],
  ];

  const results = [];
  for (const [label, endpoint, extra] of endpoints) {
    const windowResults = [];
    for (let start = sinceMs; start < untilMs; start += chunkDays * 24 * 60 * 60 * 1000) {
      const end = Math.min(untilMs, start + chunkDays * 24 * 60 * 60 * 1000 - 1);
      const query = { productType, startTime: String(start), endTime: String(end), ...extra };
      if (symbol) query.symbol = symbol;
      windowResults.push(await fetchWindow(client, label, endpoint, query, { limit, maxPages }));
      // small delay to be gentle with Bitget API during all-history mirrors
      await new Promise(resolve => setTimeout(resolve, Number(args.delayMs || 120)));
    }
    results.push(mergeWindowResults(label, endpoint, { productType, ...(symbol ? { symbol } : {}), sinceTime: String(sinceMs), untilTime: String(untilMs), ...extra }, windowResults));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    env: cfg.env,
    papTrading: cfg.papTrading,
    mirror: true,
    productType,
    symbol: symbol || null,
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    chunkDays,
    limit,
    maxPages,
    results,
  };

  const out = args.out;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  }
  console.log(JSON.stringify({
    generatedAt: payload.generatedAt,
    env: payload.env,
    papTrading: payload.papTrading,
    since: payload.since,
    until: payload.until,
    summary: results.map(r => ({ label: r.label, ok: r.ok, count: r.count, failedWindows: (r.windows || []).filter(w => !w.ok).length })),
  }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
