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
  const sampleStatus = activeRows.length >= minActiveCandles && window.length <= maxWarmupCandles ? STATUS.GREEN : STATUS.BLOCK;
  const activityStatus = sampleStatus === STATUS.GREEN ? metricStatus(inactivePct, 10, 25) : STATUS.BLOCK;
  let volumeStatus = sampleStatus === STATUS.GREEN ? metricStatus(ratioPct, 20, 35) : STATUS.BLOCK;
  // If Bitget RWA futures are continuously quoted and never show a clean
  // inactive-to-active boundary, allow a recent-liquidity override only as
  // YELLOW at best. That prevents stale p10 candles from hard-blocking while
  // still forcing explicit confirmation for live placement.
  if (fallbackRecentOnly && volumeStatus === STATUS.GREEN) volumeStatus = STATUS.WARN;

  return {
    applicable: activeRows.length >= minActiveCandles && window.length <= maxWarmupCandles,
    reason: activeRows.length < minActiveCandles
      ? 'not enough active-session candles yet'
      : (window.length > maxWarmupCandles
        ? 'warmup window already mature; use normal p10'
        : (fallbackRecentOnly ? 'no inactive-to-active boundary; recent RWA liquidity override is confirmation-gated' : 'recent inactive-to-active transition detected')),
    fallbackRecentOnly,
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

function computeReducedSizeProposal({ metrics, inputs, simulation, depth }) {
  const limits = [];
  const blockers = [];
  const maxQty = inputs.maxQty;
  const positionNotional = inputs.positionNotional;

  if (metrics.spread.status === STATUS.BLOCK) blockers.push('spread is not size-fixable');
  if (metrics.deadCandles.status === STATUS.BLOCK) blockers.push('dead-candle/liquidity continuity is not size-fixable');

  if (metrics.volume24h.status === STATUS.BLOCK || metrics.volume24h.status === STATUS.WARN) {
    const maxNotional = metrics.volume24h.quoteVolume / 500;
    if (Number.isFinite(maxNotional) && maxNotional > 0) limits.push({ reason: '24h volume >= 500x notional', scale: maxNotional / positionNotional });
    else blockers.push('24h volume is zero/unavailable');
  }

  if (metrics.volumeStress.status === STATUS.BLOCK || metrics.volumeStress.status === STATUS.WARN) {
    if (metrics.volumeStress.effectiveMode === 'rwa_active_session_warmup') {
      const w = metrics.rwaActiveSessionWarmup || {};
      if (w.fallbackRecentOnly && w.status === STATUS.WARN) {
        blockers.push('RWA recent-liquidity override is confirmation-gated, not size-fixable to GREEN');
      } else {
        const maxNotional = Number(w.activeMedianQuoteVolume || 0) * 0.20;
        if (Number.isFinite(maxNotional) && maxNotional > 0) limits.push({ reason: 'position notional < 20% of active-session median 1m quote volume', scale: maxNotional / positionNotional });
        else blockers.push('active-session median 1m quote volume is zero/unavailable');
      }
    } else {
      const maxNotional = metrics.volumeStress.p10QuoteVolume * 0.10;
      if (Number.isFinite(maxNotional) && maxNotional > 0) limits.push({ reason: 'position notional < 10% of p10 1m quote volume', scale: maxNotional / positionNotional });
      else blockers.push('p10 1m quote volume is zero/unavailable');
    }
  }

  if ((metrics.simSlippage.status === STATUS.BLOCK || metrics.simSlippage.status === STATUS.WARN) && simulation.consumedLevels?.length) {
    const targetExtraLoss = inputs.plannedRiskUsdt * 0.20;
    let lo = 0;
    let hi = maxQty;
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2;
      const sim = simulateStopExit({
        orderbook: metrics._orderbook,
        positionSide: inputs.positionSide,
        maxQty: mid,
        slPrice: inputs.slPrice,
        plannedRiskUsdt: inputs.plannedRiskUsdt,
      });
      if (sim.complete && sim.extraLossUsdt < targetExtraLoss) lo = mid;
      else hi = mid;
    }
    limits.push({ reason: 'simulated stop slippage < 20% planned risk', scale: lo / maxQty });
  }

  if (metrics.depthToSl.low) {
    const maxNotional = depth.notional / 3;
    if (Number.isFinite(maxNotional) && maxNotional > 0) limits.push({ reason: 'depth-to-SL corridor >= 3x notional', scale: maxNotional / positionNotional });
    else blockers.push('depth-to-SL corridor has no visible book depth');
  }

  if (blockers.length) {
    return { available: false, blockers, limits };
  }

  const scale = Math.min(1, ...limits.map((x) => x.scale).filter(Number.isFinite));
  if (!(scale > 0) || !Number.isFinite(scale)) return { available: false, blockers: ['no positive compliant size found'], limits };
  return {
    available: scale < 1,
    scale,
    maxQty: maxQty * scale,
    maxPositionNotional: positionNotional * scale,
    limits,
  };
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

  const ticker = asTickerRow(tickerRaw);
  const bid = n(ticker.bidPr, 'ticker.bidPr');
  const ask = n(ticker.askPr, 'ticker.askPr');
  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : Number.POSITIVE_INFINITY;
  const quoteVolume = Number(ticker.quoteVolume ?? ticker.usdtVolume ?? 0);

  const candles60 = candleRows(candles60Raw);
  const vols60 = candles60.map((row) => row.quoteVolume || row.baseVolume || 0).filter(Number.isFinite);
  const avgVolume60 = vols60.length ? vols60.reduce((a, b) => a + b, 0) / vols60.length : 0;
  const deadCount = vols60.filter((v) => v === 0 || v < avgVolume60 * 0.01).length;
  const deadPct = vols60.length ? (deadCount / vols60.length) * 100 : 100;

  const candles120 = candleRows(candles120Raw);
  const p10QuoteVolume = percentile(candles120.map((row) => row.quoteVolume), 10);
  const p10BaseVolume = percentile(candles120.map((row) => row.baseVolume), 10);
  const volumeStressPct = p10QuoteVolume > 0 ? (positionNotional / p10QuoteVolume) * 100 : Number.POSITIVE_INFINITY;
  const normalDeadStatus = metricStatus(deadPct, 10, 15);
  const normalVolumeStressStatus = metricStatus(volumeStressPct, 10, 20);
  const rwaActiveSessionWarmup = isRwa ? computeRwaActiveSessionWarmup({ candles120, positionNotional }) : { applicable: false, reason: 'symbol is not marked isRwa=YES' };
  const useRwaWarmup = isRwa
    && rwaActiveSessionWarmup.applicable
    && (normalDeadStatus === STATUS.BLOCK || normalVolumeStressStatus === STATUS.BLOCK || normalVolumeStressStatus === STATUS.WARN);
  const effectiveDeadStatus = useRwaWarmup && rwaActiveSessionWarmup.activityStatus !== STATUS.BLOCK
    ? rwaActiveSessionWarmup.activityStatus
    : normalDeadStatus;
  const effectiveVolumeStressStatus = useRwaWarmup && rwaActiveSessionWarmup.volumeStatus !== STATUS.BLOCK
    ? rwaActiveSessionWarmup.volumeStatus
    : normalVolumeStressStatus;

  const orderbook = orderbookRaw.data || { bids: [], asks: [] };
  const simulation = simulateStopExit({ orderbook, positionSide, maxQty, slPrice, plannedRiskUsdt });
  const depth = depthToSlCorridor({ orderbook, positionSide, slPrice, currentBid: bid, currentAsk: ask });
  const depthLow = depth.notional < 3 * positionNotional;

  const metrics = {
    spread: {
      valuePct: spreadPct,
      bid,
      ask,
      mid,
      status: metricStatus(spreadPct, 0.05, 0.15),
    },
    volume24h: {
      quoteVolume,
      requiredQuoteVolume: 500 * positionNotional,
      ratioToNotional: positionNotional > 0 ? quoteVolume / positionNotional : 0,
      status: quoteVolume >= 500 * positionNotional ? STATUS.GREEN : STATUS.BLOCK,
    },
    deadCandles: {
      count: deadCount,
      pct: deadPct,
      avgVolume60,
      sampleSize: vols60.length,
      normalStatus: normalDeadStatus,
      status: effectiveDeadStatus,
      effectiveMode: effectiveDeadStatus !== normalDeadStatus ? 'rwa_active_session_warmup' : 'normal_60m',
    },
    volumeStress: {
      p10QuoteVolume,
      p10BaseVolume,
      positionNotional,
      ratioPct: volumeStressPct,
      normalStatus: normalVolumeStressStatus,
      status: effectiveVolumeStressStatus,
      effectiveMode: effectiveVolumeStressStatus !== normalVolumeStressStatus ? 'rwa_active_session_warmup' : 'normal_p10_120m',
    },
    rwaActiveSessionWarmup,
    simSlippage: {
      simulatedExitAvg: simulation.avgPrice,
      worstPrice: simulation.worstPrice,
      consumedQty: simulation.consumedQty,
      remainingQty: simulation.remainingQty,
      complete: simulation.complete,
      extraLossUsdt: simulation.extraLossUsdt,
      extraLossPct: simulation.extraLossPct,
      status: simulation.complete ? metricStatus(simulation.extraLossPct, 20, 35) : STATUS.BLOCK,
    },
    depthToSl: {
      notional: depth.notional,
      qty: depth.qty,
      requiredNotional: 3 * positionNotional,
      low: depthLow,
      status: depthLow ? 'LOW' : 'OK',
    },
    _orderbook: orderbook,
  };

  if (depthLow && metrics.simSlippage.status === STATUS.WARN) {
    metrics.simSlippage.status = STATUS.BLOCK;
    metrics.simSlippage.escalatedByDepthToSl = true;
    metrics.depthToSl.status = 'ESCALATED';
  } else if (depthLow) {
    metrics.depthToSl.status = 'LOW';
  }

  const metricStatuses = [
    metrics.spread.status,
    metrics.volume24h.status,
    metrics.deadCandles.status,
    metrics.volumeStress.status,
    metrics.simSlippage.status,
  ];
  const result = metricStatuses.includes(STATUS.BLOCK) ? 'RED' : (metricStatuses.includes(STATUS.WARN) ? 'YELLOW' : 'GREEN');
  const inputs = { symbol, productType, positionSide, maxQty, slPrice, entryPrice, positionNotional, plannedRiskUsdt, isRwa };
  const reducedSizeProposal = computeReducedSizeProposal({ metrics, inputs, simulation, depth });
  delete metrics._orderbook;

  return {
    generatedAt: new Date().toISOString(),
    env: cfg.env,
    papTrading: cfg.papTrading,
    inputs,
    result,
    metrics,
    reducedSizeProposal,
    raw: input.includeRaw ? { ticker: tickerRaw, candles60: candles60Raw, candles120: candles120Raw, orderbook: orderbookRaw } : undefined,
  };
}

function fmtNum(value, digits = 4) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  return Number(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function formatGateReport(gate) {
  const m = gate.metrics;
  const lines = [];
  lines.push(`LIQUIDITY GATE — ${gate.inputs.symbol}`);
  lines.push('─────────────────────────────');
  lines.push(`Spread ${fmtNum(m.spread.valuePct, 4)}% ${m.spread.status}`);
  lines.push(`24h volume ${fmtNum(m.volume24h.quoteVolume, 2)} / req ${fmtNum(m.volume24h.requiredQuoteVolume, 2)} ${m.volume24h.status}`);
  lines.push(`Dead candles ${fmtNum(m.deadCandles.pct, 2)}% (${m.deadCandles.count}/${m.deadCandles.sampleSize}) ${m.deadCandles.status}`);
  lines.push(`Vol stress ${fmtNum(m.volumeStress.ratioPct, 2)}% of p10 1m quote vol ${m.volumeStress.status}`);
  if (m.rwaActiveSessionWarmup?.applicable && (m.deadCandles.effectiveMode === 'rwa_active_session_warmup' || m.volumeStress.effectiveMode === 'rwa_active_session_warmup')) {
    const w = m.rwaActiveSessionWarmup;
    lines.push(`RWA warmup ${w.activeCandles}/${w.windowCandles} active candles, median 1m ${fmtNum(w.activeMedianQuoteVolume, 2)} USDT, ratio ${fmtNum(w.ratioPct, 2)}% ${w.status}`);
  }
  lines.push(`Sim slippage ${fmtNum(m.simSlippage.extraLossUsdt, 2)} USDT / ${fmtNum(m.simSlippage.extraLossPct, 2)}% ${m.simSlippage.status}`);
  lines.push(`Depth to SL ${fmtNum(m.depthToSl.notional, 2)} / req ${fmtNum(m.depthToSl.requiredNotional, 2)} ${m.depthToSl.status}`);
  lines.push('─────────────────────────────');
  lines.push(`RESULT: ${gate.result}`);
  if (gate.result === 'GREEN') {
    lines.push('Proceed automatically.');
  } else if (gate.result === 'YELLOW') {
    lines.push('Explicit confirmation required before live placement.');
    if (gate.reducedSizeProposal?.available) {
      lines.push(`Suggested GREEN size: maxQty ${fmtNum(gate.reducedSizeProposal.maxQty, 6)}, notional ${fmtNum(gate.reducedSizeProposal.maxPositionNotional, 2)} USDT.`);
    }
  } else {
    lines.push('Do not place.');
    if (gate.reducedSizeProposal?.available) {
      lines.push(`Compliant GREEN size proposal: maxQty ${fmtNum(gate.reducedSizeProposal.maxQty, 6)}, notional ${fmtNum(gate.reducedSizeProposal.maxPositionNotional, 2)} USDT.`);
    } else if (gate.reducedSizeProposal?.blockers?.length) {
      lines.push(`No size-only compliant version: ${gate.reducedSizeProposal.blockers.join('; ')}.`);
    }
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
  });

  console.log(formatGateReport(gate));
  console.log(JSON.stringify({ liquidityGate: gate }, null, 2));

  if (gate.result === 'RED') {
    const override = String(args.liquidityGateOverride || '').toUpperCase();
    const overrideReason = String(args.liquidityGateOverrideReason || '').trim();
    if (override !== 'RED') {
      throw new Error('Live open order blocked by RED liquidity gate. Re-run only after explicit user confirmation with --liquidityGateOverride RED and --liquidityGateOverrideReason "<reason>".');
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
