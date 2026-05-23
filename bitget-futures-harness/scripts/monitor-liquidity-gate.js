const { BitgetClient, getDefaultTradingConfig, assertPlacementAllowed } = require('../lib/bitgetClient');
const { parseArgs } = require('../lib/cli');
const { runLiquidityGate, formatGateReport } = require('../lib/liquidityGate');

function asList(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positionQty(position) {
  return Math.abs(Number(position?.total || position?.available || 0));
}

async function cancelRemaining({ client, symbol, productType, marginCoin, planType, prefix }) {
  const canceled = [];
  const regular = await client.get('/api/v2/mix/order/orders-pending', { symbol, productType });
  for (const order of asList(regular)) {
    const clientOid = String(order.clientOid || '');
    if (prefix && !clientOid.startsWith(prefix)) continue;
    const result = await client.post('/api/v2/mix/order/cancel-order', {
      symbol,
      productType,
      marginCoin,
      orderId: order.orderId,
    });
    canceled.push({ kind: 'regular', orderId: order.orderId, clientOid, result });
  }

  const plan = await client.get('/api/v2/mix/order/orders-plan-pending', { symbol, productType, planType });
  for (const order of asList(plan)) {
    const clientOid = String(order.clientOid || '');
    if (prefix && !clientOid.startsWith(prefix)) continue;
    const result = await client.post('/api/v2/mix/order/cancel-plan-order', {
      symbol,
      productType,
      marginCoin,
      planType,
      orderId: order.orderId,
    });
    canceled.push({ kind: 'plan', orderId: order.orderId, clientOid, result });
  }
  return canceled;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const send = Boolean(args.send);
  const cfg = assertPlacementAllowed({ send });
  const client = new BitgetClient();
  const defaults = getDefaultTradingConfig();
  const symbol = args.symbol || defaults.defaultSymbol;
  const productType = args.productType || defaults.productType;
  const marginCoin = args.marginCoin || defaults.marginCoin;
  const planType = args.planType || 'normal_plan';
  const holdSide = String(args.holdSide || args.posSide || '').toLowerCase();
  const slPrice = Number(args.slPrice || args.stopLossPrice || args.presetStopLossPrice);
  const prefix = args.prefix || '';
  const intervalMs = Number(args.intervalMs || 30000);
  const timeoutMs = Number(args.timeoutMs || 6 * 60 * 60 * 1000);

  if (!symbol) throw new Error('Missing --symbol');
  if (!holdSide || !['long', 'short'].includes(holdSide)) throw new Error('Missing --holdSide long|short');
  if (!Number.isFinite(slPrice)) throw new Error('Missing --slPrice');

  console.log(JSON.stringify({
    mode: send ? 'send-cancel-on-red' : 'dry-run-monitor',
    env: cfg.env,
    symbol,
    productType,
    holdSide,
    slPrice,
    prefix,
    intervalMs,
    timeoutMs,
  }, null, 2));

  const start = Date.now();
  let lastQty = 0;
  while (Date.now() - start < timeoutMs) {
    const positions = await client.get('/api/v2/mix/position/all-position', { productType, marginCoin });
    const pos = (positions?.data || []).find((p) => p.symbol === symbol && String(p.holdSide || '').toLowerCase() === holdSide);
    const qty = positionQty(pos);

    if (qty > lastQty + 1e-12) {
      const openPriceAvg = Number(pos.openPriceAvg || 0);
      const positionNotional = qty * openPriceAvg;
      const plannedRiskUsdt = Math.abs(openPriceAvg - slPrice) * qty;
      const gate = await runLiquidityGate({
        symbol,
        productType,
        holdSide,
        maxQty: qty,
        positionNotional,
        entryPrice: openPriceAvg,
        slPrice,
        plannedRiskUsdt,
      });
      console.log(formatGateReport(gate));
      console.log(JSON.stringify({ postFillLiquidityGate: gate }, null, 2));

      if (gate.result === 'RED') {
        const canceled = send
          ? await cancelRemaining({ client, symbol, productType, marginCoin, planType, prefix })
          : [];
        console.log(JSON.stringify({
          ok: false,
          action: send ? 'canceled_remaining_unfilled_orders' : 'dry_run_would_cancel_remaining_unfilled_orders',
          symbol,
          holdSide,
          qty,
          prefix,
          canceled,
        }, null, 2));
        process.exit(send ? 4 : 3);
      }
      lastQty = qty;
    }

    await sleep(intervalMs);
  }

  console.log(JSON.stringify({ ok: true, action: 'monitor_timeout_no_red_gate', symbol, holdSide, lastQty }, null, 2));
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
