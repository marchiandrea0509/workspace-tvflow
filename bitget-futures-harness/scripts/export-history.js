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

async function tryGet(client, label, pathName, query) {
  try {
    const res = await client.get(pathName, query);
    return { label, ok: true, path: pathName, query, count: asList(res).length, data: res.data, raw: res };
  } catch (err) {
    return { label, ok: false, path: pathName, query, error: err.message || String(err) };
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getDefaultTradingConfig();
  const client = new BitgetClient();
  const productType = args.productType || cfg.productType;
  const symbol = args.symbol || undefined;
  const limit = args.limit || '100';
  const days = Number(args.days || 30);
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  const base = { productType, limit, startTime: String(startTime), endTime: String(endTime) };
  if (symbol) base.symbol = symbol;

  const queries = [
    ['orders-history', '/api/v2/mix/order/orders-history', base],
    ['fills', '/api/v2/mix/order/fills', base],
    ['fills-current', '/api/v2/mix/order/fills', { productType, limit, ...(symbol ? { symbol } : {}) }],
    ['orders-plan-history', '/api/v2/mix/order/orders-plan-history', { ...base, planType: args.planType || 'normal_plan' }],
  ];
  const results = [];
  for (const [label, p, q] of queries) results.push(await tryGet(client, label, p, q));

  const out = args.out;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), env: cfg.env, papTrading: cfg.papTrading, results }, null, 2));
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), env: cfg.env, papTrading: cfg.papTrading, summary: results.map(r => ({ label: r.label, ok: r.ok, count: r.count, error: r.error })) }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
