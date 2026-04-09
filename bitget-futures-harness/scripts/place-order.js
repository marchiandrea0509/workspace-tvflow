const crypto = require('crypto');
const { BitgetClient, getDefaultTradingConfig, assertPlacementAllowed } = require('../lib/bitgetClient');
const { parseArgs, pickDefined } = require('../lib/cli');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const send = Boolean(args.send);
  const cfg = assertPlacementAllowed({ send });
  const defaults = getDefaultTradingConfig();

  const payload = pickDefined({
    symbol: args.symbol || defaults.defaultSymbol,
    productType: args.productType || defaults.productType,
    marginMode: args.marginMode || defaults.defaultMarginMode,
    marginCoin: args.marginCoin || defaults.marginCoin,
    size: args.size,
    price: args.price,
    side: args.side,
    tradeSide: args.tradeSide,
    orderType: args.orderType || 'market',
    force: args.force || 'gtc',
    reduceOnly: args.reduceOnly,
    clientOid: args.clientOid || `tvflow-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    presetStopSurplusPrice: args.presetStopSurplusPrice,
    presetStopLossPrice: args.presetStopLossPrice,
  });

  if (!payload.size) throw new Error('Missing --size');
  if (!payload.side) throw new Error('Missing --side (buy|sell)');
  if (payload.orderType === 'limit' && !payload.price) throw new Error('Limit orders require --price');

  console.log(JSON.stringify({
    mode: send ? 'send' : 'dry-run',
    env: cfg.env,
    papTrading: cfg.papTrading,
    payload,
  }, null, 2));

  if (!send) return;

  const client = new BitgetClient();
  const result = await client.post('/api/v2/mix/order/place-order', payload);
  console.log(JSON.stringify({ ok: true, result }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
