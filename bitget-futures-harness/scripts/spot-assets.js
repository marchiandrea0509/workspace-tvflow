const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');
const { parseArgs } = require('../lib/cli');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const client = new BitgetClient();
  const cfg = getDefaultTradingConfig();
  const query = {};
  if (args.coin) query.coin = args.coin;
  const result = await client.get('/api/v2/spot/account/assets', query);
  console.log(JSON.stringify({
    env: cfg.env,
    papTrading: cfg.papTrading,
    query,
    result,
  }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
