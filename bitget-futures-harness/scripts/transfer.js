const crypto = require('crypto');
const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');
const { parseArgs, pickDefined } = require('../lib/cli');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getDefaultTradingConfig();
  const client = new BitgetClient();

  const payload = pickDefined({
    fromType: args.fromType || 'spot',
    toType: args.toType || 'usdt_futures',
    amount: args.amount,
    coin: args.coin || 'USDT',
    symbol: args.symbol,
    clientOid: args.clientOid || `transfer-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
  });

  if (!payload.amount) throw new Error('Missing --amount');

  const result = await client.post('/api/v2/spot/wallet/transfer', payload);
  console.log(JSON.stringify({ payload, result }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
