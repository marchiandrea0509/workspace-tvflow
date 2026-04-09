const fs = require('fs');
const path = require('path');
const { BitgetClient, getDefaultTradingConfig, assertPlacementAllowed } = require('../lib/bitgetClient');
const { parseArgs, pickDefined } = require('../lib/cli');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const signalPath = args.signal;
  if (!signalPath) {
    throw new Error('Missing --signal <path-to-json>');
  }

  const absoluteSignalPath = path.resolve(process.cwd(), signalPath);
  const raw = fs.readFileSync(absoluteSignalPath, 'utf8');
  const signal = JSON.parse(raw);
  const send = Boolean(args.send);
  const cfg = assertPlacementAllowed({ send });
  const defaults = getDefaultTradingConfig();

  const orderPayload = pickDefined({
    symbol: signal.symbol || defaults.defaultSymbol,
    productType: signal.productType || defaults.productType,
    marginMode: signal.marginMode || defaults.defaultMarginMode,
    marginCoin: signal.marginCoin || defaults.marginCoin,
    size: signal.size,
    price: signal.price,
    side: signal.side,
    tradeSide: signal.tradeSide,
    orderType: signal.orderType || 'market',
    force: signal.force || 'gtc',
    reduceOnly: signal.reduceOnly,
    clientOid: signal.clientOid || `signal-${Date.now()}`,
    presetStopSurplusPrice: signal.presetStopSurplusPrice,
    presetStopLossPrice: signal.presetStopLossPrice,
  });

  if (!orderPayload.size) throw new Error('Signal missing size');
  if (!orderPayload.side) throw new Error('Signal missing side');
  if (orderPayload.orderType === 'limit' && !orderPayload.price) throw new Error('Limit signal missing price');

  const plan = {
    mode: send ? 'send' : 'dry-run',
    env: cfg.env,
    papTrading: cfg.papTrading,
    signalPath: absoluteSignalPath,
    signal,
    actions: {
      setMarginMode: Boolean(signal.marginMode),
      setLeverage: Boolean(signal.leverage),
      placeOrder: true,
    },
    orderPayload,
  };

  console.log(JSON.stringify(plan, null, 2));
  if (!send) return;

  const client = new BitgetClient();

  const outputs = {};

  if (signal.marginMode) {
    outputs.marginMode = await client.post('/api/v2/mix/account/set-margin-mode', {
      symbol: orderPayload.symbol,
      productType: orderPayload.productType,
      marginCoin: orderPayload.marginCoin,
      marginMode: signal.marginMode,
    });
  }

  if (signal.leverage) {
    outputs.leverage = await client.post('/api/v2/mix/account/set-leverage', {
      symbol: orderPayload.symbol,
      productType: orderPayload.productType,
      marginCoin: orderPayload.marginCoin,
      leverage: String(signal.leverage),
      holdSide: signal.holdSide,
    });
  }

  outputs.order = await client.post('/api/v2/mix/order/place-order', orderPayload);

  console.log(JSON.stringify({ ok: true, outputs }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
