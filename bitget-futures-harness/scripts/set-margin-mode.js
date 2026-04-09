const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');
const { parseArgs } = require('../lib/cli');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getDefaultTradingConfig();
  const symbol = args.symbol || cfg.defaultSymbol;
  const marginMode = args.marginMode || cfg.defaultMarginMode;

  const client = new BitgetClient();
  const result = await client.post('/api/v2/mix/account/set-margin-mode', {
    symbol,
    productType: args.productType || cfg.productType,
    marginCoin: args.marginCoin || cfg.marginCoin,
    marginMode,
  });

  console.log(JSON.stringify({ symbol, marginMode, result }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
