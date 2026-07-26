const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BitgetClient, getDefaultTradingConfig, assertPlacementAllowed } = require('../lib/bitgetClient');
const { parseArgs, pickDefined } = require('../lib/cli');

function asList(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  if (Array.isArray(data?.orderList)) return data.orderList;
  return [];
}

function n(value, name) {
  const out = Number(value);
  if (!Number.isFinite(out)) throw new Error(`Invalid ${name}: ${value}`);
  return out;
}

function roundToPlace(value, place) {
  const factor = 10 ** place;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function floorToPlace(value, place) {
  const factor = 10 ** place;
  return Math.floor((Number(value) + Number.EPSILON) * factor) / factor;
}

function fmt(value, place) {
  return roundToPlace(value, place).toFixed(place).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function nearlyEqual(a, b, eps = 1e-9) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

function sideForHoldSide(holdSide) {
  const h = String(holdSide || '').toLowerCase();
  if (h === 'short') return 'sell';
  if (h === 'long') return 'buy';
  throw new Error('holdSide must be long|short');
}

function makeClientOid(prefix, leg, kind) {
  const cleanPrefix = String(prefix || 'tvflow_tp_split').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const label = String(leg.label || 'leg').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 12);
  return `${cleanPrefix}_${label}_${kind}_${crypto.randomUUID().slice(0, 8)}`;
}

async function getContract(client, productType, symbol) {
  const res = await client.request('GET', '/api/v2/mix/market/contracts', {
    query: { productType },
    auth: false,
  });
  const row = (res?.data || []).find((x) => String(x.symbol).toUpperCase() === String(symbol).toUpperCase());
  if (!row) throw new Error(`Contract not found for ${symbol} ${productType}`);
  return row;
}

async function getPosition(client, { productType, marginCoin, symbol, holdSide }) {
  const res = await client.get('/api/v2/mix/position/all-position', { productType, marginCoin });
  return (res?.data || []).find((p) => p.symbol === symbol && String(p.holdSide || '').toLowerCase() === String(holdSide || '').toLowerCase());
}

function normalizeLeg(leg, { volumePlace, pricePlace }) {
  const originalSizeRaw = leg.originalSize ?? leg.size ?? leg.qty;
  const originalTpRaw = leg.originalTp ?? leg.tp ?? leg.triggerPrice;
  const trailingTriggerRaw = leg.trailingTrigger ?? originalTpRaw;
  const callbackRatioRaw = leg.callbackRatio ?? leg.trailingDistancePct ?? leg.distancePct;
  if (originalSizeRaw === undefined) throw new Error(`Leg ${leg.label || '?'} missing originalSize`);
  if (originalTpRaw === undefined) throw new Error(`Leg ${leg.label || '?'} missing originalTp`);
  if (callbackRatioRaw === undefined) throw new Error(`Leg ${leg.label || '?'} missing callbackRatio/trailingDistancePct`);

  const originalSize = floorToPlace(n(originalSizeRaw, 'originalSize'), volumePlace);
  const originalTp = fmt(n(originalTpRaw, 'originalTp'), pricePlace);
  const trailingTrigger = fmt(n(trailingTriggerRaw, 'trailingTrigger'), pricePlace);

  let fixedSize;
  if (leg.fixedSize !== undefined) {
    fixedSize = roundToPlace(n(leg.fixedSize, 'fixedSize'), volumePlace);
  } else if (leg.fixedPct !== undefined) {
    fixedSize = roundToPlace(originalSize * n(leg.fixedPct, 'fixedPct') / 100, volumePlace);
  } else {
    throw new Error(`Leg ${leg.label || '?'} missing fixedSize or fixedPct`);
  }

  // Preserve the exchange-rounded original leg size exactly. This avoids creating
  // TP close quantities larger than the current leg after Bitget precision rules.
  let trailingSize = roundToPlace(originalSize - fixedSize, volumePlace);
  if (leg.trailingSize !== undefined) {
    const requestedTrailing = roundToPlace(n(leg.trailingSize, 'trailingSize'), volumePlace);
    if (!nearlyEqual(requestedTrailing, trailingSize)) {
      // Keep the leg fully covered while retaining the requested fixed quantity.
      // The difference is reported in the plan for review.
    }
  }

  if (fixedSize <= 0) throw new Error(`Leg ${leg.label || '?'} fixedSize rounds to zero`);
  if (trailingSize <= 0) throw new Error(`Leg ${leg.label || '?'} trailingSize rounds to zero`);
  if (roundToPlace(fixedSize + trailingSize, volumePlace) > originalSize) {
    trailingSize = floorToPlace(originalSize - fixedSize, volumePlace);
  }
  if (!nearlyEqual(roundToPlace(fixedSize + trailingSize, volumePlace), originalSize)) {
    throw new Error(`Leg ${leg.label || '?'} split does not preserve size: ${fixedSize}+${trailingSize} != ${originalSize}`);
  }

  return {
    ...leg,
    originalSize: fmt(originalSize, volumePlace),
    originalTp,
    fixedSize: fmt(fixedSize, volumePlace),
    trailingSize: fmt(trailingSize, volumePlace),
    trailingTrigger,
    callbackRatio: String(callbackRatioRaw),
    requestedFixedSize: leg.fixedSize !== undefined ? String(leg.fixedSize) : undefined,
    requestedTrailingSize: leg.trailingSize !== undefined ? String(leg.trailingSize) : undefined,
  };
}

function findMatchingProfitOrder(planOrders, leg) {
  const matches = planOrders.filter((o) => {
    return String(o.planType) === 'profit_plan'
      && nearlyEqual(o.size, leg.originalSize, 1e-8)
      && nearlyEqual(o.triggerPrice, leg.originalTp, 1e-8);
  });
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one profit_plan for ${leg.label || leg.originalTp} size=${leg.originalSize} TP=${leg.originalTp}, found ${matches.length}`);
  }
  return matches[0];
}

function buildFixedTpPayload({ cfg, symbol, productType, marginCoin, holdSide, triggerType, leg, clientOidPrefix }) {
  return pickDefined({
    symbol,
    productType,
    marginCoin,
    planType: 'profit_plan',
    triggerPrice: leg.originalTp,
    triggerType,
    executePrice: '0',
    holdSide,
    size: leg.fixedSize,
    clientOid: makeClientOid(clientOidPrefix, leg, 'fixed'),
  });
}

function buildTrailingTpPayload({ symbol, productType, marginMode, marginCoin, holdSide, triggerType, leg, clientOidPrefix }) {
  return pickDefined({
    symbol,
    productType,
    marginMode,
    marginCoin,
    size: leg.trailingSize,
    side: sideForHoldSide(holdSide),
    tradeSide: 'close',
    orderType: 'market',
    triggerPrice: leg.trailingTrigger,
    triggerType,
    planType: 'track_plan',
    callbackRatio: leg.callbackRatio,
    clientOid: makeClientOid(clientOidPrefix, leg, 'trail'),
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const send = Boolean(args.send);
  const cfg = assertPlacementAllowed({ send });
  const defaults = getDefaultTradingConfig();
  const client = new BitgetClient();

  const configPath = args.config;
  const config = configPath ? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), configPath), 'utf8')) : {};
  const symbol = args.symbol || config.symbol || defaults.defaultSymbol;
  const productType = args.productType || config.productType || defaults.productType;
  const marginCoin = args.marginCoin || config.marginCoin || defaults.marginCoin;
  const marginMode = args.marginMode || config.marginMode || defaults.defaultMarginMode;
  const holdSide = String(args.holdSide || config.holdSide || '').toLowerCase();
  const triggerType = args.triggerType || config.triggerType || 'fill_price';
  const clientOidPrefix = args.clientOidPrefix || config.clientOidPrefix || `tvflow_${symbol.toLowerCase()}_tp_split`;
  const allowExistingTrailing = Boolean(args.allowExistingTrailing || config.allowExistingTrailing);

  if (!symbol) throw new Error('Missing symbol');
  if (!['long', 'short'].includes(holdSide)) throw new Error('Missing --holdSide long|short (or config.holdSide)');
  if (!Array.isArray(config.legs) || !config.legs.length) throw new Error('Config must include non-empty legs[]');

  const contract = await getContract(client, productType, symbol);
  const volumePlace = Number(contract.volumePlace ?? 0);
  const pricePlace = Number(contract.pricePlace ?? 0);
  const legs = config.legs.map((leg) => normalizeLeg(leg, { volumePlace, pricePlace }));

  const position = await getPosition(client, { productType, marginCoin, symbol, holdSide });
  const positionSize = Number(position?.total || 0);
  const legTotal = legs.reduce((sum, leg) => sum + Number(leg.originalSize), 0);
  if (!position || positionSize <= 0) throw new Error(`No ${symbol} ${holdSide} position found`);
  if (legTotal > positionSize + (10 ** -volumePlace)) {
    throw new Error(`Configured leg total ${fmt(legTotal, volumePlace)} exceeds position total ${positionSize}`);
  }

  const profitLossRes = await client.get('/api/v2/mix/order/orders-plan-pending', {
    symbol,
    productType,
    planType: 'profit_loss',
  });
  const profitLossOrders = asList(profitLossRes);
  const trackRes = await client.get('/api/v2/mix/order/orders-plan-pending', {
    symbol,
    productType,
    planType: 'track_plan',
  });
  const trackOrders = asList(trackRes);
  if (trackOrders.length && !allowExistingTrailing) {
    throw new Error(`Found ${trackOrders.length} existing track_plan order(s) for ${symbol}; rerun with --allowExistingTrailing only if intentional`);
  }

  const matched = legs.map((leg) => ({ leg, currentProfitOrder: findMatchingProfitOrder(profitLossOrders, leg) }));
  const fixedTpPayloads = legs.map((leg) => buildFixedTpPayload({ cfg, symbol, productType, marginCoin, holdSide, triggerType, leg, clientOidPrefix }));
  const trailingTpPayloads = legs.map((leg) => buildTrailingTpPayload({ symbol, productType, marginMode, marginCoin, holdSide, triggerType, leg, clientOidPrefix }));
  const cancelPayloads = [{
    symbol,
    productType,
    marginCoin,
    // Bitget lists TP/SL orders via pending planType=profit_loss, but targeted
    // cancellation of TP rows requires the concrete order planType=profit_plan
    // plus orderIdList. Top-level orderId is ignored by this endpoint and can
    // accidentally behave like a broader symbol cancel for other plan types.
    planType: 'profit_plan',
    orderIdList: matched.map(({ currentProfitOrder }) => ({ orderId: currentProfitOrder.orderId })),
  }];

  const plan = {
    mode: send ? 'send' : 'dry-run',
    env: cfg.env,
    papTrading: cfg.papTrading,
    symbol,
    productType,
    marginCoin,
    marginMode,
    holdSide,
    triggerType,
    precision: { volumePlace, pricePlace, sizeMultiplier: contract.sizeMultiplier, minTradeNum: contract.minTradeNum },
    position: {
      total: position.total,
      available: position.available,
      openPriceAvg: position.openPriceAvg,
      markPrice: position.markPrice,
    },
    legs,
    matchedCurrentProfitOrders: matched.map(({ leg, currentProfitOrder }) => ({
      label: leg.label,
      orderId: currentProfitOrder.orderId,
      size: currentProfitOrder.size,
      triggerPrice: currentProfitOrder.triggerPrice,
      clientOid: currentProfitOrder.clientOid,
    })),
    actions: {
      cancelOriginalProfitPlans: cancelPayloads,
      placeFixedProfitPlans: fixedTpPayloads,
      placeTrailingTrackPlans: trailingTpPayloads,
      untouchedStopLossPlans: profitLossOrders.filter((o) => String(o.planType) === 'loss_plan').map((o) => ({ orderId: o.orderId, size: o.size, triggerPrice: o.triggerPrice })),
      existingTrackPlans: trackOrders.map((o) => ({ orderId: o.orderId, size: o.size, triggerPrice: o.triggerPrice, callbackRatio: o.callbackRatio })),
    },
  };

  console.log(JSON.stringify(plan, null, 2));
  if (!send) return;

  const outputs = { fixed: [], trailing: [], canceled: [] };
  try {
    // Place replacement TP protection first, then remove the superseded full-size
    // fixed TP plans with a targeted profit_plan/orderIdList cancel. This avoids
    // leaving the position with no TP if Bitget rejects a replacement payload. In
    // hedge close mode, these replacement plans are close orders, not fresh opens.
    for (const payload of fixedTpPayloads) {
      const result = await client.post('/api/v2/mix/order/place-tpsl-order', payload);
      outputs.fixed.push({ payload, result });
    }
    for (const payload of trailingTpPayloads) {
      const result = await client.post('/api/v2/mix/order/place-plan-order', payload);
      outputs.trailing.push({ payload, result });
    }
    for (const payload of cancelPayloads) {
      const result = await client.post('/api/v2/mix/order/cancel-plan-order', payload);
      outputs.canceled.push({ payload, result });
    }
  } catch (err) {
    err.outputs = outputs;
    throw err;
  }

  const postProfitLoss = await client.get('/api/v2/mix/order/orders-plan-pending', { symbol, productType, planType: 'profit_loss' });
  const postTrack = await client.get('/api/v2/mix/order/orders-plan-pending', { symbol, productType, planType: 'track_plan' });
  console.log(JSON.stringify({
    ok: true,
    outputs,
    postcheck: {
      profitLossCount: asList(postProfitLoss).length,
      trackPlanCount: asList(postTrack).length,
      profitLoss: asList(postProfitLoss),
      trackPlan: asList(postTrack),
    },
  }, null, 2));
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  if (err.outputs) console.error(JSON.stringify({ partialOutputs: err.outputs }, null, 2));
  process.exitCode = 1;
});
