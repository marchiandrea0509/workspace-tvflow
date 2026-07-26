const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');

(async () => {
  const client = new BitgetClient();
  const cfg = getDefaultTradingConfig();
  const result = await client.get('/api/v2/account/all-account-balance');
  console.log(JSON.stringify({
    env: cfg.env,
    papTrading: cfg.papTrading,
    result,
  }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
