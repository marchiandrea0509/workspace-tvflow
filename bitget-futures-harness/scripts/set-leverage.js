const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');
const { parseArgs } = require('../lib/cli');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getDefaultTradingConfig();
  const symbol = args.symbol || cfg.defaultSymbol;
  const leverage = args.leverage || cfg.defaultLeverage;

  const client = new BitgetClient();
  const result = await client.post('/api/v2/mix/account/set-leverage', {
    symbol,
    productType: args.productType || cfg.productType,
    marginCoin: args.marginCoin || cfg.marginCoin,
    leverage: String(leverage),
    holdSide: args.holdSide,
  });

  console.log(JSON.stringify({ symbol, leverage, result }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
