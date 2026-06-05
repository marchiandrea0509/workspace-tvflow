const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BitgetClient, getDefaultTradingConfig } = require('./bitgetClient');

const STATUS = {
  GREEN: 'GREEN',
  WARN: 'WARN',
  BLOCK: 'BLOCK',
};

function n(value, name) {
  const out = Number(value);
  if (!Number.isFinite(out)) throw new Error(`Invalid ${name}: ${value}`);
  return out;
}

function maybeN(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const out = Number(value);
  return Number.isFinite(out) ? out : undefined;
}

function sideToPositionSide({ side, holdSide, posSide }) {
  const explicit = String(holdSide || posSide || '').toLowerCase();
  if (explicit === 'long' || explicit === 'short') return explicit;
  const s = String(side || '').toLowerCase();
  if (s === 'buy') return 'long';
  if (s === 'sell') return 'short';
  throw new Error('Cannot infer long/short side for liquidity gate; provide --side buy|sell or --gateSide long|short');
}

function metricStatus(value, greenLimit, warnLimit, { lowerIsBetter = true, inclusiveWarnHigh = true } = {}) {
  if (!Number.isFinite(value)) return STATUS.BLOCK;
  if (lowerIsBetter) {
    if (value < greenLimit) return STATUS.GREEN;
    if (inclusiveWarnHigh ? value <= warnLimit : value < warnLimit) return STATUS.WARN;
    return STATUS.BLOCK;
  }
  if (value >= greenLimit) return STATUS.GREEN;
  if (value >= warnLimit) return STATUS.WARN;
  return STATUS.BLOCK;
}

function percentile(values, p) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

function asTickerRow(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data[0] || {};
  return data || {};
}

function candleRows(response) {
  return (response?.data || []).map((row) => ({
    ts: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    baseVolume: Number(row[5] || 0),
    quoteVolume: Number(row[6] || 0),
  })).filter((row) => Number.isFinite(row.ts));
}

function asContractRow(response, symbol) {
  const rows = response?.data || [];
  if (!Array.isArray(rows)) return {};
  return rows.find((row) => row?.symbol === symbol) || {};
}

function statusRank(status) {
  if (status === STATUS.GREEN) return 0;
  if (status === STATUS.WARN) return 1;
  return 2;
}

function worseStatus(a, b) {
  return statusRank(a) >= statusRank(b) ? a : b;
}

function computeRwaActiveSessionWarmup({ candles120, positionNotional }) {
  const rows = [...candles120].sort((a, b) => a.ts - b.ts);
  const minActiveQuoteVolume = Math.max(100, positionNotional * 0.01);
  const inactiveStreakNeeded = 5;
  const minActiveCandles = 10;
  const maxWarmupCandles = 60;

  let inactiveStreak = 0;
  let boundary = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const qv = Number(rows[i]?.quoteVolume || 0);
    if (qv < minActiveQuoteVolume) inactiveStreak += 1;
    else inactiveStreak = 0;
    if (inactiveStreak >= inactiveStreakNeeded) {
      boundary = i + inactiveStreak;
      break;
    }
  }

  const fallbackRecentOnly = boundary < 0;
  const window = fallbackRecentOnly ? rows.slice(-30) : rows.slice(boundary);
  const activeRows = window.filter((row) => Number(row.quoteVolume || 0) >= minActiveQuoteVolume);
  const activeVolumes = activeRows.map((row) => Number(row.quoteVolume || 0)).filter(Number.isFinite);
  const inactiveCount = Math.max(0, window.length - activeRows.length);
  const inactivePct = window.length ? (inactiveCount / window.length) * 100 : 100;
  const activeMedianQuoteVolume = percentile(activeVolumes, 50);
  const activeP25QuoteVolume = percentile(activeVolumes, 25);
  const activeAvgQuoteVolume = activeVolumes.length ? activeVolumes.reduce((a, b) => a + b, 0) / activeVolumes.length : 0;
  const ratioPct = activeMedianQuoteVolume > 0 ? (positionNotional / activeMedianQuoteVolume) * 100 : Number.POSITIVE_INFINITY;
  const sampleStatus = activeRows.length >= minActiveCandles ? STATUS.GREEN : STATUS.BLOCK;
  const activityStatus = sampleStatus === STATUS.GREEN ? metricStatus(inactivePct, 10, 25) : STATUS.BLOCK;
  let volumeStatus = sampleStatus === STATUS.GREEN ? metricStatus(ratioPct, 20, 35) : STATUS.BLOCK;
  // If Bitget RWA futures are continuously quoted and never show a clean
  // inactive-to-active boundary, allow a recent-liquidity override only as
  // YELLOW at best. That prevents stale p10 candles from hard-blocking while
  // still forcing explicit confirmation for live placement.
  if (fallbackRecentOnly && volumeStatus === STATUS.GREEN) volumeStatus = STATUS.WARN;

  const matureWindow = !fallbackRecentOnly && window.length > maxWarmupCandles;
  const reason = activeRows.length < minActiveCandles
    ? 'not enough active-session candles yet'
    : (fallbackRecentOnly
      ? 'no inactive-to-active boundary; recent RWA liquidity override is confirmation-gated'
      : (matureWindow
        ? 'mature active-session window; use RWA active-session profile instead of raw p10'
        : 'recent inactive-to-active transition detected'));

  return {
    applicable: activeRows.length >= minActiveCandles,
    reason,
    fallbackRecentOnly,
    matureWindow,
    minActiveQuoteVolume,
    inactiveStreakNeeded,
    minActiveCandles,
    maxWarmupCandles,
    windowCandles: window.length,
    activeCandles: activeRows.length,
    inactiveCandles: inactiveCount,
    inactivePct,
    activeMedianQuoteVolume,
    activeP25QuoteVolume,
    activeAvgQuoteVolume,
    ratioPct,
    activityStatus,
    volumeStatus,
    status: worseStatus(activityStatus, volumeStatus),
  };
}

function walkBook(levels, qty) {
  let remaining = qty;
  let consumedQty = 0;
  let quote = 0;
  let worstPrice = null;
  const consumedLevels = [];

  for (const [priceRaw, qtyRaw] of levels || []) {
    if (remaining <= 0) break;
    const price = Number(priceRaw);
    const levelQty = Number(qtyRaw);
    if (!Number.isFinite(price) || !Number.isFinite(levelQty) || levelQty <= 0) continue;
    const take = Math.min(remaining, levelQty);
    consumedQty += take;
    quote += take * price;
    remaining -= take;
    worstPrice = price;
    consumedLevels.push({ price, levelQty, take });
  }

  return {
    requestedQty: qty,
    consumedQty,
    remainingQty: remaining,
    avgPrice: consumedQty > 0 ? quote / consumedQty : null,
    worstPrice,
    consumedLevels,
    complete: remaining <= 1e-12,
  };
}

function simulateStopExit({ orderbook, positionSide, maxQty, slPrice, plannedRiskUsdt }) {
  const side = String(positionSide).toLowerCase();
  const levels = side === 'long' ? orderbook.bids : orderbook.asks;
  const walk = walkBook(levels, maxQty);
  let extraLossUsdt = Number.POSITIVE_INFINITY;
  if (walk.complete && Number.isFinite(walk.avgPrice)) {
    extraLossUsdt = side === 'long'
      ? Math.max(0, (slPrice - walk.avgPrice) * maxQty)
      : Math.max(0, (walk.avgPrice - slPrice) * maxQty);
  }
  const extraLossPct = plannedRiskUsdt > 0 ? (extraLossUsdt / plannedRiskUsdt) * 100 : Number.POSITIVE_INFINITY;
  return {
    ...walk,
    extraLossUsdt,
    extraLossPct,
  };
}

function depthToSlCorridor({ orderbook, positionSide, slPrice, currentBid, currentAsk }) {
  const side = String(positionSide).toLowerCase();
  const levels = side === 'long' ? orderbook.bids : orderbook.asks;
  const current = side === 'long' ? currentBid : currentAsk;
  let qty = 0;
  let notional = 0;
  for (const [priceRaw, qtyRaw] of levels || []) {
    const price = Number(priceRaw);
    const levelQty = Number(qtyRaw);
    if (!Number.isFinite(price) || !Number.isFinite(levelQty) || levelQty <= 0) continue;
    const inCorridor = side === 'long'
      ? price >= slPrice && price <= current
      : price <= slPrice && price >= current;
    if (inCorridor) {
      qty += levelQty;
      notional += levelQty * price;
    }
  }
  return { qty, notional };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneOrderbookWithDepthHaircut(orderbook, haircut = 0.5) {
  const scale = Number(haircut);
  const apply = (levels) => (levels || []).map(([price, qty]) => [price, String(Number(qty) * scale)]);
  return {
    bids: apply(orderbook?.bids),
    asks: apply(orderbook?.asks),
  };
}

function orderbookFromResponse(raw) {
  return raw?.data || { bids: [], asks: [] };
}

async function collectExecutionSnapshots({ client, symbol, productType, firstTickerRaw, firstOrderbookRaw, sampleCount, sampleIntervalMs }) {
  const count = Math.max(1, Math.min(10, Number(sampleCount || 3)));
  const interval = Math.max(0, Math.min(5000, Number(sampleIntervalMs ?? 1000)));
  const samples = [{
    ts: new Date().toISOString(),
    tickerRaw: firstTickerRaw,
    orderbookRaw: firstOrderbookRaw,
    ticker: asTickerRow(firstTickerRaw),
    orderbook: orderbookFromResponse(firstOrderbookRaw),
  }];
  for (let i = 1; i < count; i += 1) {
    if (interval > 0) await sleep(interval);
    try {
      const [tickerRaw, orderbookRaw] = await Promise.all([
        client.get('/api/v2/mix/market/ticker', { symbol, productType }),
        client.get('/api/v2/mix/market/orderbook', { symbol, productType, limit: '50' }),
      ]);
      samples.push({
        ts: new Date().toISOString(),
        tickerRaw,
        orderbookRaw,
        ticker: asTickerRow(tickerRaw),
        orderbook: orderbookFromResponse(orderbookRaw),
      });
    } catch (err) {
      samples.push({ ts: new Date().toISOString(), error: err.message || String(err) });
      break;
    }
  }
  return samples;
}

function spreadPctFromTicker(ticker) {
  const bid = Number(ticker?.bidPr);
  const ask = Number(ticker?.askPr);
  const mid = (bid + ask) / 2;
  return {
    bid,
    ask,
    mid,
    spreadPct: mid > 0 ? ((ask - bid) / mid) * 100 : Number.POSITIVE_INFINITY,
  };
}

function computeSpreadStability(samples) {
  const rows = samples.map((sample) => spreadPctFromTicker(sample.ticker)).filter((row) => Number.isFinite(row.spreadPct));
  const current = rows[0] || { bid: NaN, ask: NaN, mid: NaN, spreadPct: Number.POSITIVE_INFINITY };
  const spreads = rows.map((row) => row.spreadPct);
  const worstSpreadPct = spreads.length ? Math.max(...spreads) : Number.POSITIVE_INFINITY;
  const medianSpreadPct = percentile(spreads, 50);
  return {
    valuePct: worstSpreadPct,
    currentSpreadPct: current.spreadPct,
    medianSpreadPct,
    worstSpreadPct,
    bid: current.bid,
    ask: current.ask,
    mid: current.mid,
    sampleSize: rows.length,
    status: metricStatus(worstSpreadPct, 0.05, 0.15),
    decisionMetric: 'worst_observed_spread_pct',
  };
}

function quoteVolumes(rows) {
  return (rows || []).map((row) => Number(row.quoteVolume || 0)).filter(Number.isFinite);
}

function medianNonZero(values) {
  return percentile(values.filter((value) => Number.isFinite(value) && value > 0), 50);
}

function computeDeadCandles(candles60) {
  const vols = quoteVolumes(candles60);
  const medianNonZeroQuoteVolume = medianNonZero(vols);
  const deadThreshold = medianNonZeroQuoteVolume > 0 ? medianNonZeroQuoteVolume * 0.01 : 0;
  const deadCount = vols.filter((v) => v === 0 || (medianNonZeroQuoteVolume > 0 && v < deadThreshold)).length;
  const zeroCount = vols.filter((v) => v === 0).length;
  const pct = vols.length ? (deadCount / vols.length) * 100 : 100;
  const zeroPct = vols.length ? (zeroCount / vols.length) * 100 : 100;
  return {
    count: deadCount,
    pct,
    zeroCount,
    zeroPct,
    medianNonZeroQuoteVolume,
    deadThresholdQuoteVolume: deadThreshold,
    sampleSize: vols.length,
    status: metricStatus(pct, 10, 15),
    effectiveMode: 'median_nonzero_60m',
  };
}

function computeVolumeStress({ candles120, positionNotional, isRwa }) {
  const vols = quoteVolumes(candles120);
  const medianNonZeroQuoteVolume = medianNonZero(vols);
  const deadThreshold = medianNonZeroQuoteVolume > 0 ? medianNonZeroQuoteVolume * 0.01 : 0;
  const nonDead = vols.filter((v) => v > 0 && (medianNonZeroQuoteVolume <= 0 || v >= deadThreshold));
  const p10QuoteVolume = percentile(nonDead, 10);
  const ratioPct = p10QuoteVolume > 0 ? (positionNotional / p10QuoteVolume) * 100 : Number.POSITIVE_INFINITY;
  const greenPct = isRwa ? 25 : 10;
  const yellowPct = isRwa ? 50 : 20;
  return {
    p10QuoteVolume,
    p10NonDeadQuoteVolume: p10QuoteVolume,
    medianNonZeroQuoteVolume,
    deadThresholdQuoteVolume: deadThreshold,
    nonDeadSampleSize: nonDead.length,
    sampleSize: vols.length,
    positionNotional,
    ratioPct,
    greenThresholdPct: greenPct,
    yellowThresholdPct: yellowPct,
    status: metricStatus(ratioPct, greenPct, yellowPct),
    effectiveMode: isRwa ? 'rwa_p10_non_dead_120m' : 'standard_p10_non_dead_120m',
  };
}

function computeVolume24h({ quoteVolume, positionNotional }) {
  const ratioToNotional = positionNotional > 0 ? quoteVolume / positionNotional : 0;
  let status = STATUS.BLOCK;
  if (ratioToNotional >= 500) status = STATUS.GREEN;
  else if (ratioToNotional >= 250) status = STATUS.WARN;
  return {
    quoteVolume,
    requiredQuoteVolume: 500 * positionNotional,
    yellowRequiredQuoteVolume: 250 * positionNotional,
    ratioToNotional,
    status,
  };
}

function computeNearMarketDepth({ orderbook, positionSide, currentBid, currentAsk, positionNotional }) {
  const side = String(positionSide).toLowerCase();
  const levels = side === 'long' ? orderbook.bids : orderbook.asks;
  const ref = side === 'long' ? currentBid : currentAsk;
  function depthWithin(pct) {
    let qty = 0;
    let notional = 0;
    for (const [priceRaw, qtyRaw] of levels || []) {
      const price = Number(priceRaw);
      const levelQty = Number(qtyRaw);
      if (!Number.isFinite(price) || !Number.isFinite(levelQty) || levelQty <= 0 || !(ref > 0)) continue;
      const include = side === 'long'
        ? price <= ref && price >= ref * (1 - pct)
        : price >= ref && price <= ref * (1 + pct);
      if (include) {
        qty += levelQty;
        notional += levelQty * price;
      }
    }
    return { qty, notional, ratioToPosition: positionNotional > 0 ? notional / positionNotional : 0 };
  }
  const within025 = depthWithin(0.0025);
  const within050 = depthWithin(0.005);
  const status025 = within025.ratioToPosition >= 3 ? STATUS.GREEN : (within025.ratioToPosition >= 1.5 ? STATUS.WARN : STATUS.BLOCK);
  const status050 = within050.ratioToPosition >= 5 ? STATUS.GREEN : (within050.ratioToPosition >= 2.5 ? STATUS.WARN : STATUS.BLOCK);
  return {
    sideEvaluated: side === 'long' ? 'bids' : 'asks',
    referencePrice: ref,
    within025,
    within050,
    status025,
    status050,
    status: worseStatus(status025, status050),
  };
}

function computeStopExitSlippageSamples({ samples, positionSide, maxQty, slPrice, plannedRiskUsdt }) {
  const baseline = simulateStopExit({ orderbook: samples[0]?.orderbook || {}, positionSide, maxQty, slPrice, plannedRiskUsdt });
  const normalSims = samples.filter((s) => s.orderbook).map((sample) => simulateStopExit({
    orderbook: sample.orderbook,
    positionSide,
    maxQty,
    slPrice,
    plannedRiskUsdt,
  }));
  const stressedSims = samples.filter((s) => s.orderbook).map((sample) => simulateStopExit({
    orderbook: cloneOrderbookWithDepthHaircut(sample.orderbook, 0.5),
    positionSide,
    maxQty,
    slPrice,
    plannedRiskUsdt,
  }));
  const worstNormal = normalSims.reduce((worst, sim) => (
    !sim.complete || sim.extraLossPct > (worst?.extraLossPct ?? -1) ? sim : worst
  ), normalSims[0] || baseline);
  const worstStressed = stressedSims.reduce((worst, sim) => (
    !sim.complete || sim.extraLossPct > (worst?.extraLossPct ?? -1) ? sim : worst
  ), stressedSims[0] || baseline);
  return {
    simulatedExitAvg: worstStressed.avgPrice,
    worstPrice: worstStressed.worstPrice,
    consumedQty: worstStressed.consumedQty,
    remainingQty: worstStressed.remainingQty,
    complete: worstStressed.complete,
    extraLossUsdt: worstStressed.extraLossUsdt,
    extraLossPct: worstStressed.extraLossPct,
    baselineCurrentBook: baseline,
    worstObservedCurrentBook: worstNormal,
    stressedHalfDepth: worstStressed,
    sampleSize: normalSims.length,
    depthHaircutPct: 50,
    decisionMetric: 'stressed_half_visible_depth_extra_loss_pct',
    status: worstStressed.complete ? metricStatus(worstStressed.extraLossPct, 20, 35) : STATUS.BLOCK,
  };
}

function deriveOverallLiquidityResult({ metrics, isRwa }) {
  const primary = [metrics.simSlippage.status, metrics.nearMarketDepth.status, metrics.spread.status];
  const supporting = [metrics.volumeStress.status, metrics.deadCandles.status, metrics.volume24h.status];
  if (primary.includes(STATUS.BLOCK)) return 'RED';
  const primaryWarn = primary.includes(STATUS.WARN);
  const supportingRedCount = supporting.filter((s) => s === STATUS.BLOCK).length;
  const supportingWarn = supporting.includes(STATUS.WARN);
  if (!isRwa) {
    if (supportingRedCount > 0) return 'RED';
    return (primaryWarn || supportingWarn) ? 'YELLOW' : 'GREEN';
  }
  if (supportingRedCount >= 2) return 'RED';
  if (supportingRedCount === 1 && primaryWarn) return 'RED';
  if (supportingRedCount === 1) return 'YELLOW';
  return (primaryWarn || supportingWarn) ? 'YELLOW' : 'GREEN';
}

function recomputeStatusAtScale({ metrics, inputs, orderbook, scale }) {
  const maxQty = inputs.maxQty * scale;
  const positionNotional = inputs.positionNotional * scale;
  const plannedRiskUsdt = inputs.plannedRiskUsdt * scale;
  const sim = simulateStopExit({
    orderbook: cloneOrderbookWithDepthHaircut(orderbook, 0.5),
    positionSide: inputs.positionSide,
    maxQty,
    slPrice: inputs.slPrice,
    plannedRiskUsdt,
  });
  const simStatus = sim.complete ? metricStatus(sim.extraLossPct, 20, 35) : STATUS.BLOCK;
  const near = computeNearMarketDepth({
    orderbook,
    positionSide: inputs.positionSide,
    currentBid: metrics.spread.bid,
    currentAsk: metrics.spread.ask,
    positionNotional,
  });
  const volumeStressRatioPct = metrics.volumeStress.p10QuoteVolume > 0 ? (positionNotional / metrics.volumeStress.p10QuoteVolume) * 100 : Number.POSITIVE_INFINITY;
  const volumeStressStatus = metricStatus(volumeStressRatioPct, metrics.volumeStress.greenThresholdPct, metrics.volumeStress.yellowThresholdPct);
  const volume24hStatus = computeVolume24h({ quoteVolume: metrics.volume24h.quoteVolume, positionNotional }).status;
  const scaledMetrics = {
    spread: metrics.spread,
    simSlippage: { ...metrics.simSlippage, ...sim, extraLossPct: sim.extraLossPct, status: simStatus },
    nearMarketDepth: near,
    volumeStress: { ...metrics.volumeStress, positionNotional, ratioPct: volumeStressRatioPct, status: volumeStressStatus },
    deadCandles: metrics.deadCandles,
    volume24h: { ...metrics.volume24h, status: volume24hStatus },
  };
  return {
    maxQty,
    positionNotional,
    plannedRiskUsdt,
    estimatedExtraSlippageUsdt: sim.extraLossUsdt,
    estimatedTotalLossUsdt: plannedRiskUsdt + (Number.isFinite(sim.extraLossUsdt) ? sim.extraLossUsdt : Number.POSITIVE_INFINITY),
    sim,
    spreadStatus: metrics.spread.status,
    nearMarketDepthStatus: near.status,
    p10Status: volumeStressStatus,
    deadCandlesStatus: metrics.deadCandles.status,
    volume24hStatus,
    result: deriveOverallLiquidityResult({ metrics: scaledMetrics, isRwa: inputs.isRwa }),
  };
}

function findScaleForSlippageBudget({ metrics, inputs, orderbook, budgetFn }) {
  let lo = 0;
  let hi = 1;
  let best = null;
  for (let i = 0; i < 44; i += 1) {
    const mid = (lo + hi) / 2;
    const evalMid = recomputeStatusAtScale({ metrics, inputs, orderbook, scale: mid });
    const budget = budgetFn(evalMid);
    const pass = evalMid.sim.complete && Number.isFinite(evalMid.estimatedExtraSlippageUsdt) && evalMid.estimatedExtraSlippageUsdt <= budget;
    if (pass) {
      lo = mid;
      best = evalMid;
    } else {
      hi = mid;
    }
  }
  return best;
}

function computeDownsizedFallbackProposals({ metrics, inputs, orderbook, slippagePct = 0.05 }) {
  const originalBaseRisk = Number(inputs.basePlannedRiskUsdt || inputs.plannedRiskUsdt || 100);
  const proposalA = findScaleForSlippageBudget({
    metrics,
    inputs,
    orderbook,
    budgetFn: () => slippagePct * originalBaseRisk,
  });
  const proposalB = findScaleForSlippageBudget({
    metrics,
    inputs,
    orderbook,
    budgetFn: (evalMid) => slippagePct * evalMid.plannedRiskUsdt,
  });
  function formatProposal(label, proposal, budgetDescription) {
    if (!proposal || !(proposal.maxQty > 0)) {
      return { label, available: false, budgetDescription, verdict: 'NO_TRADE', reason: 'No positive size satisfies the stop-exit slippage budget.' };
    }
    const meaningful = proposal.plannedRiskUsdt >= Math.min(25, inputs.plannedRiskUsdt * 0.5);
    return {
      label,
      available: true,
      budgetDescription,
      revisedSize: proposal.maxQty,
      revisedNotional: proposal.positionNotional,
      revisedMargin: inputs.plannedLeverage ? proposal.positionNotional / inputs.plannedLeverage : null,
      plannedNoSlippageRisk: proposal.plannedRiskUsdt,
      estimatedExtraSlippage: proposal.estimatedExtraSlippageUsdt,
      estimatedTotalLoss: proposal.estimatedTotalLossUsdt,
      p10Status: proposal.p10Status,
      nearMarketDepthStatus: proposal.nearMarketDepthStatus,
      spreadStatus: proposal.spreadStatus,
      finalResult: proposal.result,
      meaningful,
      verdict: meaningful && proposal.result !== 'RED' ? 'PLACEABLE_ONLY_WITH_CONFIRMATION' : 'NO_TRADE',
      reason: meaningful ? '' : 'Downsized risk is too small to be meaningful.',
    };
  }
  return [
    formatProposal('A_fixed_extra_slippage_budget', proposalA, `${fmtNum(slippagePct * 100, 2)}% x original/base planned risk`),
    formatProposal('B_proportional_extra_slippage_budget', proposalB, `${fmtNum(slippagePct * 100, 2)}% x new planned no-slippage risk`),
  ];
}

async function runLiquidityGate(input, { client = undefined } = {}) {
  const cfg = getDefaultTradingConfig();
  const c = client || new BitgetClient();
  const symbol = input.symbol || cfg.defaultSymbol;
  const productType = input.productType || cfg.productType;
  const positionSide = sideToPositionSide(input);
  const maxQty = n(input.maxQty, 'maxQty');
  const slPrice = n(input.slPrice, 'slPrice');
  const entryPrice = maybeN(input.entryPrice);
  const positionNotional = maybeN(input.positionNotional) ?? (entryPrice ? maxQty * entryPrice : undefined);
  if (!Number.isFinite(positionNotional) || positionNotional <= 0) throw new Error('Liquidity gate requires --positionNotional or --entryPrice');
  const plannedRiskUsdt = maybeN(input.plannedRiskUsdt) ?? (entryPrice ? Math.abs(entryPrice - slPrice) * maxQty : undefined);
  if (!Number.isFinite(plannedRiskUsdt) || plannedRiskUsdt <= 0) throw new Error('Liquidity gate requires --plannedRiskUsdt or entry/SL risk derivation');

  const [tickerRaw, candles60Raw, candles120Raw, orderbookRaw, contractsRaw] = await Promise.all([
    c.get('/api/v2/mix/market/ticker', { symbol, productType }),
    c.get('/api/v2/mix/market/candles', { symbol, productType, granularity: '1m', limit: '60' }),
    c.get('/api/v2/mix/market/candles', { symbol, productType, granularity: '1m', limit: '120' }),
    c.get('/api/v2/mix/market/orderbook', { symbol, productType, limit: '50' }),
    c.get('/api/v2/mix/market/contracts', { productType }),
  ]);

  const contract = asContractRow(contractsRaw, symbol);
  const isRwa = String(contract.isRwa || '').toUpperCase() === 'YES';
  const candles60 = candleRows(candles60Raw);
  const candles120 = candleRows(candles120Raw);
  const ticker = asTickerRow(tickerRaw);
  const quoteVolume = Number(ticker.quoteVolume ?? ticker.usdtVolume ?? 0);

  const executionSamples = await collectExecutionSnapshots({
    client: c,
    symbol,
    productType,
    firstTickerRaw: tickerRaw,
    firstOrderbookRaw: orderbookRaw,
    sampleCount: input.sampleCount || input.orderbookSampleCount || input.liquiditySampleCount,
    sampleIntervalMs: input.sampleIntervalMs || input.orderbookSampleIntervalMs || input.liquiditySampleIntervalMs,
  });
  const currentSpread = spreadPctFromTicker(executionSamples[0]?.ticker || ticker);
  const bid = n(currentSpread.bid, 'ticker.bidPr');
  const ask = n(currentSpread.ask, 'ticker.askPr');
  const orderbook = executionSamples[0]?.orderbook || orderbookFromResponse(orderbookRaw);

  const spread = computeSpreadStability(executionSamples);
  const deadCandles = computeDeadCandles(candles60);
  const volumeStress = computeVolumeStress({ candles120, positionNotional, isRwa });
  const volume24h = computeVolume24h({ quoteVolume, positionNotional });
  const rwaActiveSessionWarmup = isRwa ? computeRwaActiveSessionWarmup({ candles120, positionNotional }) : { applicable: false, reason: 'symbol is not marked isRwa=YES' };
  const simSlippage = computeStopExitSlippageSamples({
    samples: executionSamples,
    positionSide,
    maxQty,
    slPrice,
    plannedRiskUsdt,
  });
  const nearMarketDepth = computeNearMarketDepth({
    orderbook,
    positionSide,
    currentBid: bid,
    currentAsk: ask,
    positionNotional,
  });
  const depth = depthToSlCorridor({ orderbook, positionSide, slPrice, currentBid: bid, currentAsk: ask });

  const metrics = {
    simSlippage,
    nearMarketDepth,
    spread,
    volumeStress,
    deadCandles,
    volume24h,
    depthToSl: {
      notional: depth.notional,
      qty: depth.qty,
      requiredNotional: 3 * positionNotional,
      low: depth.notional < 3 * positionNotional,
      status: 'INFO_ONLY',
      decisionRole: 'informational_only',
    },
    rwaActiveSessionWarmup,
  };

  const result = deriveOverallLiquidityResult({ metrics, isRwa });
  const inputs = {
    symbol,
    productType,
    positionSide,
    maxQty,
    slPrice,
    entryPrice,
    positionNotional,
    plannedRiskUsdt,
    plannedLeverage: maybeN(input.plannedLeverage),
    basePlannedRiskUsdt: maybeN(input.basePlannedRiskUsdt) || maybeN(input.baseRiskUsdt) || 100,
    isRwa,
  };
  const downsizedFallbackProposals = computeDownsizedFallbackProposals({
    metrics,
    inputs,
    orderbook,
    slippagePct: maybeN(input.slippagePct) || 0.05,
  });
  const reducedSizeProposal = downsizedFallbackProposals.find((p) => p.available && p.finalResult === 'GREEN') || downsizedFallbackProposals.find((p) => p.available) || { available: false, blockers: ['No downsized fallback satisfies the configured slippage budget.'] };

  return {
    generatedAt: new Date().toISOString(),
    env: cfg.env,
    papTrading: cfg.papTrading,
    inputs,
    result,
    decisionLogic: {
      primaryExecutionGates: ['simSlippage', 'nearMarketDepth', 'spread'],
      supportingLiquidityGates: ['volumeStress', 'deadCandles', 'volume24h'],
      rwaSupportingRule: 'one RED supporting gate alone => YELLOW; two RED supporting gates or RED support + YELLOW primary => RED',
      depthToSlCorridorRole: 'informational_only',
    },
    metrics,
    reducedSizeProposal,
    downsizedFallbackProposals,
    raw: input.includeRaw ? { ticker: tickerRaw, candles60: candles60Raw, candles120: candles120Raw, orderbook: orderbookRaw, executionSamples } : undefined,
  };
}

function fmtNum(value, digits = 4) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  return Number(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function light(status) {
  if (status === STATUS.GREEN || status === 'GREEN' || status === 'OK') return '🟢 GREEN';
  if (status === STATUS.WARN || status === 'YELLOW' || status === 'WARN') return '🟡 YELLOW';
  if (status === STATUS.BLOCK || status === 'RED' || status === 'BLOCK' || status === 'LOW') return '🔴 RED';
  if (status === 'INFO_ONLY') return '⚪ INFO';
  return '⚪ NOT RUN';
}

function row(lines, gate, observed, limit, status, risk, note) {
  lines.push(`${gate} | ${observed} | ${limit} | ${light(status)} | ${risk} | ${note}`);
}

function formatGateReport(gate) {
  const m = gate.metrics;
  const lines = [];
  lines.push(`LIQUIDITY GATE — ${gate.inputs.symbol}`);
  lines.push('A. Liquidity and executable orderability');
  lines.push('Gate | Observed | Limit / required | Status | Risk if failed | Note');
  row(lines,
    '1. Stop-exit simulated slippage',
    `baseline ${fmtNum(m.simSlippage.baselineCurrentBook?.extraLossUsdt, 2)} USDT (${fmtNum(m.simSlippage.baselineCurrentBook?.extraLossPct, 2)}% risk); worst ${fmtNum(m.simSlippage.worstObservedCurrentBook?.extraLossUsdt, 2)} USDT; 50%-depth ${fmtNum(m.simSlippage.extraLossUsdt, 2)} USDT (${fmtNum(m.simSlippage.extraLossPct, 2)}% risk)`,
    '<20% GREEN; <=35% YELLOW; >35% or unfilled RED',
    m.simSlippage.status,
    'A stop-market order may fill materially beyond planned SL, increasing real loss above the intended risk budget.',
    `decision uses 50%-visible-depth haircut; samples=${m.simSlippage.sampleSize}`);
  row(lines,
    '2. Near-market executable depth',
    `0.25% ${fmtNum(m.nearMarketDepth.within025?.notional, 2)} USDT (${fmtNum(m.nearMarketDepth.within025?.ratioToPosition, 2)}x); 0.50% ${fmtNum(m.nearMarketDepth.within050?.notional, 2)} USDT (${fmtNum(m.nearMarketDepth.within050?.ratioToPosition, 2)}x)`,
    '0.25%: >=3x GREEN / >=1.5x YELLOW; 0.50%: >=5x GREEN / >=2.5x YELLOW',
    m.nearMarketDepth.status,
    'The visible book may not contain enough bids/asks to absorb exit size without crossing several price levels.',
    `evaluated ${m.nearMarketDepth.sideEvaluated}`);
  row(lines,
    '3. Spread stability',
    `current ${fmtNum(m.spread.currentSpreadPct, 4)}%; median ${fmtNum(m.spread.medianSpreadPct, 4)}%; worst ${fmtNum(m.spread.worstSpreadPct, 4)}%`,
    '<0.05% GREEN; <=0.15% YELLOW; >0.15% RED',
    m.spread.status,
    'A wide or unstable spread creates immediate execution loss and often indicates fragile book depth.',
    `decision uses worst observed spread; samples=${m.spread.sampleSize}`);
  row(lines,
    '4. p10 / weak-minute volume stress',
    `${fmtNum(m.volumeStress.ratioPct, 2)}% of p10 non-dead 1m quote vol ${fmtNum(m.volumeStress.p10QuoteVolume, 2)} USDT`,
    gate.inputs.isRwa ? '<25% GREEN; <=50% YELLOW; >50% RED (RWA adapted)' : '<10% GREEN; <=20% YELLOW; >20% RED',
    m.volumeStress.status,
    'Position may be too large versus quiet-minute turnover, making execution unreliable when liquidity falls.',
    `${m.volumeStress.effectiveMode}; non-dead sample=${m.volumeStress.nonDeadSampleSize}/${m.volumeStress.sampleSize}`);
  row(lines,
    '5. Dead 1m candles',
    `${fmtNum(m.deadCandles.pct, 2)}% dead (${m.deadCandles.count}/${m.deadCandles.sampleSize}); zero ${fmtNum(m.deadCandles.zeroPct, 2)}% (${m.deadCandles.zeroCount}/${m.deadCandles.sampleSize})`,
    '<10% GREEN; <=15% YELLOW; >15% RED',
    m.deadCandles.status,
    'Frequent very-low-volume candles indicate intermittent trading and higher risk liquidity disappears when stop triggers.',
    `median non-zero quote vol ${fmtNum(m.deadCandles.medianNonZeroQuoteVolume, 2)} USDT`);
  row(lines,
    '6. 24h quote-volume ratio',
    `${fmtNum(m.volume24h.quoteVolume, 2)} USDT (${fmtNum(m.volume24h.ratioToNotional, 2)}x notional)`,
    '>=500x GREEN; >=250x YELLOW; <250x RED',
    m.volume24h.status,
    'Low daily turnover suggests weak participation; coarse supporting filter only.',
    'supporting liquidity gate');
  row(lines,
    '7. Visible depth-to-SL corridor',
    `${fmtNum(m.depthToSl.notional, 2)} USDT visible to SL`,
    'informational only; no hard pass/fail',
    m.depthToSl.status,
    'Visible orders between current price and SL can be cancelled before execution, so corridor depth may overstate real protection.',
    'not used for overall gate decision');
  lines.push('');
  lines.push(`B. Overall liquidity decision: ${gate.result}`);
  lines.push(`Primary gates: stop-exit=${light(m.simSlippage.status)}, near-market-depth=${light(m.nearMarketDepth.status)}, spread=${light(m.spread.status)}`);
  lines.push(`Supporting gates: p10=${light(m.volumeStress.status)}, dead-candles=${light(m.deadCandles.status)}, 24h-volume=${light(m.volume24h.status)}`);
  if (gate.inputs.isRwa) lines.push('RWA rule: one RED supporting metric alone becomes YELLOW/confirmation-gated; two RED supporting metrics or RED support + YELLOW/RED primary becomes RED.');
  lines.push('');
  lines.push('D. Downsized fallback proposals');
  for (const proposal of gate.downsizedFallbackProposals || []) {
    if (!proposal.available) {
      lines.push(`${proposal.label}: ${proposal.verdict} — ${proposal.reason}`);
    } else {
      lines.push(`${proposal.label}: size ${fmtNum(proposal.revisedSize, 6)}, notional ${fmtNum(proposal.revisedNotional, 2)}, planned risk ${fmtNum(proposal.plannedNoSlippageRisk, 2)}, extra slip ${fmtNum(proposal.estimatedExtraSlippage, 2)}, total loss ${fmtNum(proposal.estimatedTotalLoss, 2)}, p10 ${proposal.p10Status}, depth ${proposal.nearMarketDepthStatus}, spread ${proposal.spreadStatus}, verdict ${proposal.verdict}`);
    }
  }
  lines.push('─────────────────────────────');
  lines.push(`RESULT: ${gate.result}`);
  if (gate.result === 'GREEN') {
    lines.push('Live placement technically allowed only after the normal explicit order request/confirmation boundary.');
  } else if (gate.result === 'YELLOW') {
    lines.push('Explicit confirmation required before live placement.');
  } else {
    lines.push('Do not place unless Andrea explicitly gives a RED-liquidity override with risk acknowledgement.');
  }
  return lines.join('\n');
}

function deriveMonitorPrefix(clientOid) {
  const raw = String(clientOid || '');
  const stripped = raw.replace(/(?:^|[_-])(?:L|B|S)\d+$/i, '');
  return stripped || raw;
}

function spawnPostFillLiquidityMonitor(args, payload, gate) {
  if (!gate) return null;
  if (String(args.liquidityMonitor || '').toLowerCase() === 'false') return null;
  if (String(payload.tradeSide || '').toLowerCase() !== 'open') return null;

  const prefix = args.liquidityMonitorPrefix || args.gatePrefix || deriveMonitorPrefix(payload.clientOid);
  const outDir = path.resolve(process.cwd(), 'reports', 'liquidity_gate');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeSymbol = String(payload.symbol || 'symbol').replace(/[^A-Za-z0-9_-]/g, '_');
  const logPath = path.join(outDir, `${stamp}_${safeSymbol}_post_fill_monitor.log`);
  const errPath = path.join(outDir, `${stamp}_${safeSymbol}_post_fill_monitor.err.log`);
  const outFd = fs.openSync(logPath, 'a');
  const errFd = fs.openSync(errPath, 'a');
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'monitor-liquidity-gate.js');
  const childArgs = [
    scriptPath,
    '--send',
    '--symbol', payload.symbol,
    '--productType', payload.productType,
    '--marginCoin', payload.marginCoin,
    '--holdSide', gate.inputs.positionSide,
    '--slPrice', String(gate.inputs.slPrice),
    '--prefix', prefix,
    '--intervalMs', String(args.liquidityMonitorIntervalMs || 30000),
    '--timeoutMs', String(args.liquidityMonitorTimeoutMs || 6 * 60 * 60 * 1000),
  ];
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
  });
  child.unref();
  return { pid: child.pid, prefix, logPath, errPath, intervalMs: Number(args.liquidityMonitorIntervalMs || 30000) };
}

async function assertLiquidityGateForLiveOpenOrder(args, payload, cfg) {
  if (!args.send) return null;
  if (cfg.env !== 'live') return null;
  if (String(payload.tradeSide || '').toLowerCase() !== 'open') return null;

  const slPrice = args.gateStopLossPrice || payload.presetStopLossPrice || args.stopLossTriggerPrice || args.presetStopLossPrice;
  if (!slPrice) throw new Error('Live open order blocked: liquidity gate requires a stop-loss price. Provide preset SL or --gateStopLossPrice.');

  const looksLikeLadderLeg = /(?:^|[_-])(?:L|B|S)\d+$/i.test(String(payload.clientOid || ''));
  if (looksLikeLadderLeg && (!args.gateMaxQty || !args.gatePositionNotional || !(args.gatePlannedRisk || args.plannedRiskUsdt))) {
    throw new Error('Live ladder-looking order blocked: provide full-ladder --gateMaxQty, --gatePositionNotional, and --gatePlannedRisk so the liquidity gate evaluates worst-case stop size, not just this leg.');
  }

  const maxQty = args.gateMaxQty || payload.size;
  const entryPrice = args.gateEntryPrice || payload.price || args.triggerPrice || args.price;
  const positionNotional = args.gatePositionNotional || (entryPrice && maxQty ? String(Number(entryPrice) * Number(maxQty)) : undefined);
  const plannedRiskUsdt = args.gatePlannedRisk || args.plannedRiskUsdt || (entryPrice && slPrice && maxQty ? String(Math.abs(Number(entryPrice) - Number(slPrice)) * Number(maxQty)) : undefined);

  const gate = await runLiquidityGate({
    symbol: payload.symbol,
    productType: payload.productType,
    side: args.gateSide || payload.side,
    maxQty,
    positionNotional,
    entryPrice,
    slPrice,
    plannedRiskUsdt,
    sampleCount: args.sampleCount || args.orderbookSampleCount || args.liquiditySampleCount,
    sampleIntervalMs: args.sampleIntervalMs || args.orderbookSampleIntervalMs || args.liquiditySampleIntervalMs,
    slippagePct: args.slippagePct,
    basePlannedRiskUsdt: args.basePlannedRiskUsdt || args.baseRiskUsdt,
    plannedLeverage: args.plannedLeverage || args.leverage,
  });

  console.log(formatGateReport(gate));
  console.log(JSON.stringify({ liquidityGate: gate }, null, 2));

  if (gate.result === 'RED') {
    const override = String(args.liquidityGateOverride || '').toUpperCase();
    const overrideReason = String(args.liquidityGateOverrideReason || '').trim();
    if (override !== 'RED') {
      const failedPrimary = [];
      if (gate.metrics.simSlippage.status === STATUS.BLOCK) failedPrimary.push(`haircutted stop-exit slippage ${fmtNum(gate.metrics.simSlippage.extraLossPct, 2)}% of planned risk; estimated total loss ${fmtNum(gate.inputs.plannedRiskUsdt + gate.metrics.simSlippage.extraLossUsdt, 2)} USDT`);
      if (gate.metrics.nearMarketDepth.status === STATUS.BLOCK) failedPrimary.push('near-market executable depth RED');
      if (gate.metrics.spread.status === STATUS.BLOCK) failedPrimary.push(`spread stability RED: worst ${fmtNum(gate.metrics.spread.worstSpreadPct, 4)}%`);
      throw new Error(`Live open order blocked by RED liquidity gate (${failedPrimary.join('; ') || 'supporting liquidity gate RED'}). Re-run only after explicit user confirmation with --liquidityGateOverride RED and --liquidityGateOverrideReason "<reason/risk acknowledgement>".`);
    }
    if (overrideReason.length < 12) {
      throw new Error('Live RED liquidity gate override requires --liquidityGateOverrideReason with a specific reason/risk acknowledgement.');
    }
    gate.override = {
      level: 'RED',
      acceptedAt: new Date().toISOString(),
      reason: overrideReason,
    };
    console.warn(`WARNING: RED liquidity gate override accepted: ${overrideReason}`);
  }
  if (gate.result === 'YELLOW') {
    const override = String(args.liquidityGateOverride || '').toUpperCase();
    if (override !== 'YELLOW' && override !== 'TRUE' && override !== 'RED') {
      throw new Error('Live open order blocked by YELLOW liquidity gate. Re-run only after explicit user confirmation with --liquidityGateOverride YELLOW.');
    }
  }
  return gate;
}

module.exports = {
  STATUS,
  runLiquidityGate,
  formatGateReport,
  assertLiquidityGateForLiveOpenOrder,
  sideToPositionSide,
  spawnPostFillLiquidityMonitor,
};
