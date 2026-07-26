const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');
const { parseArgs } = require('../lib/cli');

function asList(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  return [];
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getDefaultTradingConfig();
  const client = new BitgetClient();
  const symbol = args.symbol || cfg.defaultSymbol;
  const productType = args.productType || cfg.productType;
  const includePlan = args.includePlan !== 'false';
  const planType = args.planType || 'normal_plan';

  const regular = await client.get('/api/v2/mix/order/orders-pending', {
    symbol,
    productType,
  });

  let plan = { code: '00000', data: { entrustedList: [] } };
  if (includePlan) {
    plan = await client.get('/api/v2/mix/order/orders-plan-pending', {
      symbol,
      productType,
      planType,
    });
  }

  console.log(JSON.stringify({
    symbol,
    productType,
    planType,
    regularCount: asList(regular).length,
    planCount: asList(plan).length,
    regular: asList(regular),
    plan: asList(plan),
  }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
