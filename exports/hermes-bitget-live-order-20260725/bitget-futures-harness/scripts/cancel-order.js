const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');
const { parseArgs, pickDefined } = require('../lib/cli');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getDefaultTradingConfig();
  const payload = pickDefined({
    orderId: args.orderId,
    clientOid: args.clientOid,
    symbol: args.symbol || cfg.defaultSymbol,
    productType: args.productType || cfg.productType,
    marginCoin: args.marginCoin || cfg.marginCoin,
  });

  if (!payload.orderId && !payload.clientOid) {
    throw new Error('Provide --orderId or --clientOid');
  }

  const client = new BitgetClient();
  const result = await client.post('/api/v2/mix/order/cancel-order', payload);
  console.log(JSON.stringify({ payload, result }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
