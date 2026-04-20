const crypto = require('crypto');
const { BitgetClient, getDefaultTradingConfig, assertPlacementAllowed } = require('../lib/bitgetClient');
const { parseArgs, pickDefined } = require('../lib/cli');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const send = Boolean(args.send);
  const cfg = assertPlacementAllowed({ send });
  const defaults = getDefaultTradingConfig();

  const orderType = args.orderType || 'limit';
  const stopSurplusTriggerPrice = args.stopSurplusTriggerPrice || args.presetStopSurplusPrice;
  const stopLossTriggerPrice = args.stopLossTriggerPrice || args.presetStopLossPrice;

  const payload = pickDefined({
    symbol: args.symbol || defaults.defaultSymbol,
    productType: args.productType || defaults.productType,
    marginMode: args.marginMode || defaults.defaultMarginMode,
    marginCoin: args.marginCoin || defaults.marginCoin,
    size: args.size,
    side: args.side,
    tradeSide: args.tradeSide,
    orderType,
    price: args.price,
    triggerPrice: args.triggerPrice,
    triggerType: args.triggerType || 'fill_price',
    planType: args.planType || 'normal_plan',
    clientOid: args.clientOid || `tvflow-trigger-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    reduceOnly: args.reduceOnly,
    callbackRatio: args.callbackRatio,
    stopSurplusTriggerPrice,
    stopSurplusExecutePrice: args.stopSurplusExecutePrice,
    stopSurplusTriggerType: stopSurplusTriggerPrice ? (args.stopSurplusTriggerType || 'fill_price') : undefined,
    stopLossTriggerPrice,
    stopLossExecutePrice: args.stopLossExecutePrice,
    stopLossTriggerType: stopLossTriggerPrice ? (args.stopLossTriggerType || 'fill_price') : undefined,
  });

  if (!payload.size) throw new Error('Missing --size');
  if (!payload.side) throw new Error('Missing --side (buy|sell)');
  if (!payload.tradeSide) throw new Error('Missing --tradeSide (open|close)');
  if (!payload.triggerPrice) throw new Error('Missing --triggerPrice');
  if (orderType === 'limit' && !payload.price) throw new Error('Limit trigger orders require --price');
  if (orderType === 'market') delete payload.price;

  console.log(JSON.stringify({
    mode: send ? 'send' : 'dry-run',
    env: cfg.env,
    papTrading: cfg.papTrading,
    endpoint: '/api/v2/mix/order/place-plan-order',
    payload,
  }, null, 2));

  if (!send) return;

  const client = new BitgetClient();
  const result = await client.post('/api/v2/mix/order/place-plan-order', payload);
  console.log(JSON.stringify({ ok: true, result }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
