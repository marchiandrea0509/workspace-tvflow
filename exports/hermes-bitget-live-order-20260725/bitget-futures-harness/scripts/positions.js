const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');

(async () => {
  const client = new BitgetClient();
  const cfg = getDefaultTradingConfig();
  const result = await client.get('/api/v2/mix/position/all-position', {
    productType: cfg.productType,
    marginCoin: cfg.marginCoin,
  });
  console.log(JSON.stringify({
    env: cfg.env,
    papTrading: cfg.papTrading,
    productType: cfg.productType,
    marginCoin: cfg.marginCoin,
    result,
  }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
