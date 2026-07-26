const { BitgetClient, getDefaultTradingConfig, assertPlacementAllowed } = require('../lib/bitgetClient');
const { parseArgs } = require('../lib/cli');

function asList(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  return [];
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const send = Boolean(args.send);
  const cfg = assertPlacementAllowed({ send });
  const client = new BitgetClient();
  const symbol = args.symbol || cfg.defaultSymbol;
  const productType = args.productType || cfg.productType;
  const marginCoin = args.marginCoin || cfg.marginCoin;
  const prefix = args.prefix;
  const planType = args.planType || 'normal_plan';
  const includeRegular = args.includeRegular !== 'false';
  const includePlan = args.includePlan !== 'false';

  if (!prefix) throw new Error('Missing --prefix');

  const matches = [];

  if (includeRegular) {
    const regular = await client.get('/api/v2/mix/order/orders-pending', { symbol, productType });
    for (const order of asList(regular)) {
      const clientOid = String(order.clientOid || '');
      if (clientOid.startsWith(prefix)) {
        matches.push({ kind: 'regular', orderId: order.orderId, clientOid, raw: order });
      }
    }
  }

  if (includePlan) {
    const plan = await client.get('/api/v2/mix/order/orders-plan-pending', { symbol, productType, planType });
    for (const order of asList(plan)) {
      const clientOid = String(order.clientOid || '');
      if (clientOid.startsWith(prefix)) {
        matches.push({ kind: 'plan', orderId: order.orderId, clientOid, raw: order });
      }
    }
  }

  console.log(JSON.stringify({
    mode: send ? 'send' : 'dry-run',
    env: cfg.env,
    symbol,
    productType,
    prefix,
    matchCount: matches.length,
    matches,
  }, null, 2));

  if (!send) return;

  const results = [];
  for (const match of matches) {
    if (match.kind === 'regular') {
      const result = await client.post('/api/v2/mix/order/cancel-order', {
        symbol,
        productType,
        marginCoin,
        orderId: match.orderId,
      });
      results.push({ kind: match.kind, orderId: match.orderId, clientOid: match.clientOid, result });
      continue;
    }

    const result = await client.post('/api/v2/mix/order/cancel-plan-order', {
      symbol,
      productType,
      marginCoin,
      planType,
      orderId: match.orderId,
    });
    results.push({ kind: match.kind, orderId: match.orderId, clientOid: match.clientOid, result });
  }

  console.log(JSON.stringify({ ok: true, canceled: results }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
