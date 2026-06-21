const fs = require('fs');
const path = require('path');
const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');
const { parseArgs } = require('../lib/cli');
const { runLiquidityGate } = require('../lib/liquidityGate');

function asList(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  return [];
}

function num(value, fallback = NaN) {
  if (value === undefined || value === null || value === '') return fallback;
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
}

function fmt(value, digits = 2) {
  if (value === undefined || value === null || value === '') return 'n/a';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function pct(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `${fmt(n, digits)}%`;
}

function isoFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function hoursBetween(ms, nowMs) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (nowMs - n) / 3600000;
}

function sideFrom(item) {
  const explicit = String(item?.holdSide || item?.posSide || '').toLowerCase();
  if (explicit === 'long' || explicit === 'short') return explicit;
  const side = String(item?.side || '').toLowerCase();
  if (side === 'buy') return 'long';
  if (side === 'sell') return 'short';
  return 'unknown';
}

function statusLight(status) {
  if (status === 'GREEN' || status === 'KEEP_UNCHANGED') return '🟢';
  if (status === 'YELLOW' || status === 'KEEP_BUT_MONITOR' || status === 'TP_REFRESH') return '🟡';
  if (status === 'RED' || status === 'FULL_REFRESH' || status === 'CANCEL_UNFILLED' || status === 'EXIT_OR_INVALID' || status === 'REDUCE_RISK') return '🔴';
  return '⚪';
}

function candleRows(response) {
  return (response?.data || []).map((row) => ({
    ts: num(row[0]),
    open: num(row[1]),
    high: num(row[2]),
    low: num(row[3]),
    close: num(row[4]),
    baseVolume: num(row[5], 0),
    quoteVolume: num(row[6], 0),
  })).filter((row) => Number.isFinite(row.ts)).sort((a, b) => a.ts - b.ts);
}

function tickerRow(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data[0] || {};
  return data || {};
}

function atr(candles, period = 14) {
  const rows = candles.slice(-Math.max(period + 1, 2));
  if (rows.length < 2) return NaN;
  const trs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const c = rows[i];
    const prev = rows[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  if (!trs.length) return NaN;
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function trend(candles, lookback = 12) {
  const rows = candles.slice(-lookback);
  if (rows.length < 3) return { label: 'UNKNOWN', changePct: NaN };
  const first = rows[0].close;
  const last = rows[rows.length - 1].close;
  const changePct = first ? ((last - first) / first) * 100 : NaN;
  const label = changePct > 1 ? 'UP' : changePct < -1 ? 'DOWN' : 'SIDEWAYS';
  return { label, changePct };
}

function nearestSr(candles, current) {
  const rows = candles.slice(-40, -1);
  let support = null;
  let resistance = null;
  for (const c of rows) {
    for (const v of [c.low, c.close, c.open]) {
      if (v < current && (support === null || v > support)) support = v;
    }
    for (const v of [c.high, c.close, c.open]) {
      if (v > current && (resistance === null || v < resistance)) resistance = v;
    }
  }
  return { support, resistance };
}

function recentExtreme(candles, side, lookback = 20) {
  const rows = candles.slice(-lookback, -1);
  if (!rows.length) return NaN;
  if (side === 'long') return Math.min(...rows.map((r) => r.low));
  if (side === 'short') return Math.max(...rows.map((r) => r.high));
  return NaN;
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadExecutionSummaries(rootDir) {
  const byOrderId = new Map();
  const byClientOid = new Map();
  const summaries = [];
  const roots = [
    path.resolve(rootDir, '..', 'reports', 'live_execution'),
    path.resolve(rootDir, 'reports', 'live_execution'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else if (ent.isFile() && ent.name === 'summary.json') {
          const json = readJsonIfExists(full);
          if (!json) continue;
          json.__summaryPath = full;
          summaries.push(json);
          for (const order of json.orders || []) {
            if (order.orderId) byOrderId.set(String(order.orderId), { summary: json, order });
            if (order.clientOid) byClientOid.set(String(order.clientOid), { summary: json, order });
          }
        }
      }
    }
  }
  return { summaries, byOrderId, byClientOid };
}

function findOriginal(order, summaryIndex) {
  return summaryIndex.byOrderId.get(String(order.orderId)) || summaryIndex.byClientOid.get(String(order.clientOid)) || null;
}

async function fetchPlanType(client, productType, planType) {
  try {
    const response = await client.get('/api/v2/mix/order/orders-plan-pending', { productType, planType });
    return asList(response).map((row) => ({ ...row, requestedPlanType: planType }));
  } catch (err) {
    return { error: err.message || String(err), rows: [] };
  }
}

async function fetchMarketState(client, productType, symbol) {
  const [tickerRaw, c1hRaw, c4hRaw, c1dRaw] = await Promise.all([
    client.get('/api/v2/mix/market/ticker', { symbol, productType }),
    client.get('/api/v2/mix/market/candles', { symbol, productType, granularity: '1H', limit: '80' }),
    client.get('/api/v2/mix/market/candles', { symbol, productType, granularity: '4H', limit: '80' }),
    client.get('/api/v2/mix/market/candles', { symbol, productType, granularity: '1D', limit: '60' }),
  ]);
  const ticker = tickerRow(tickerRaw);
  const last = num(ticker.lastPr ?? ticker.markPrice ?? ticker.indexPrice);
  const bid = num(ticker.bidPr);
  const ask = num(ticker.askPr);
  const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : last;
  const c1h = candleRows(c1hRaw);
  const c4h = candleRows(c4hRaw);
  const c1d = candleRows(c1dRaw);
  const current = Number.isFinite(last) ? last : mid;
  return {
    ticker,
    current,
    bid,
    ask,
    atr4h: atr(c4h),
    atr1h: atr(c1h),
    trend1h: trend(c1h),
    trend4h: trend(c4h),
    trend1d: trend(c1d),
    sr1h: nearestSr(c1h, current),
    sr4h: nearestSr(c4h, current),
    c1h,
    c4h,
    c1d,
  };
}

function groupBySymbol(rows) {
  const m = new Map();
  for (const row of rows) {
    const symbol = row.symbol;
    if (!symbol) continue;
    if (!m.has(symbol)) m.set(symbol, []);
    m.get(symbol).push(row);
  }
  return m;
}

function classifyOrder(order, market, nowMs, opts, context = {}) {
  const side = sideFrom(order);
  const entry = num(order.price);
  const qty = num(order.size);
  const filled = num(order.baseVolume, 0);
  const remaining = Math.max(0, qty - filled);
  const sl = num(order.presetStopLossPrice);
  const tp = num(order.presetStopSurplusPrice);
  const atr4h = market.atr4h;
  const current = market.current;
  const ageHours = hoursBetween(order.cTime, nowMs);
  const risk = side === 'long' ? Math.max(0, entry - sl) * remaining : Math.max(0, sl - entry) * remaining;
  const reward = side === 'long' ? Math.max(0, tp - entry) * remaining : Math.max(0, entry - tp) * remaining;
  const rr = risk > 0 ? reward / risk : NaN;
  const distanceToEntry = side === 'long' ? current - entry : entry - current;
  const distanceToEntryAtr = Number.isFinite(atr4h) && atr4h > 0 ? distanceToEntry / atr4h : NaN;
  const tpDistanceAtr = Number.isFinite(atr4h) && atr4h > 0 ? Math.abs(tp - current) / atr4h : NaN;
  const invalidatedByPrice = side === 'long' ? current <= sl : current >= sl;
  const tpInvalidRelativeToEntry = side === 'long' ? tp <= entry : tp >= entry;
  const currentBeyondTp = side === 'long' ? current >= tp : current <= tp;
  const pullbackOrderStillBelowCurrent = side === 'long' ? entry < current : entry > current;
  const shallow = Number.isFinite(distanceToEntryAtr) && distanceToEntryAtr < opts.minRestingEntryAtr;
  const stale = Number.isFinite(ageHours) && ageHours > opts.maxTicketAgeHours;
  const rrWeak = Number.isFinite(rr) && rr < opts.minRemainingRr;
  const tpTooFar = Number.isFinite(tpDistanceAtr) && tpDistanceAtr > opts.maxTpAtr;
  const against4h = (side === 'long' && market.trend4h.label === 'DOWN') || (side === 'short' && market.trend4h.label === 'UP');
  const veryDeepFromCurrent = Number.isFinite(distanceToEntryAtr) && distanceToEntryAtr > opts.deepPullbackMonitorAtr;

  const reasons = [];
  let status = 'KEEP_UNCHANGED';
  if (invalidatedByPrice) {
    status = 'CANCEL_UNFILLED';
    reasons.push('Current price is beyond/through the preset SL/INV area for this unfilled order.');
  } else if (tpInvalidRelativeToEntry) {
    status = 'FULL_REFRESH';
    reasons.push('Preset TP is not on the profitable side of the order entry.');
  } else if (currentBeyondTp && !pullbackOrderStillBelowCurrent) {
    status = 'FULL_REFRESH';
    reasons.push('Current price is already beyond the preset TP and the order is not a deeper pullback/resting order.');
  } else if (stale && context.hasOpenSameSidePosition) {
    status = 'KEEP_BUT_MONITOR';
    reasons.push(`Ticket age is ${fmt(ageHours / 24, 1)}d, beyond the ${fmt(opts.maxTicketAgeHours / 24, 1)}d horizon, but this is a remaining leg of a partially filled static campaign; treat as monitor / optional risk-reduction, not automatic full refresh.`);
  } else if (stale) {
    status = 'FULL_REFRESH';
    reasons.push(`Ticket age is ${fmt(ageHours / 24, 1)}d, beyond the ${fmt(opts.maxTicketAgeHours / 24, 1)}d diagnostic horizon.`);
  } else if (shallow) {
    status = 'CANCEL_UNFILLED';
    reasons.push(`Resting entry gate failed: distance to entry is ${fmt(distanceToEntryAtr, 2)} ATR4H, below ${opts.minRestingEntryAtr} ATR4H.`);
  } else if (rrWeak) {
    status = 'TP_REFRESH';
    reasons.push(`Remaining order RR is weak at ${fmt(rr, 2)}R.`);
  } else if (tpTooFar) {
    status = 'KEEP_BUT_MONITOR';
    reasons.push(`TP is ${fmt(tpDistanceAtr, 2)} ATR4H from current price; keep only if the original structural TP map still explains this target.`);
  } else if (veryDeepFromCurrent) {
    status = 'KEEP_BUT_MONITOR';
    reasons.push(`Entry is ${fmt(distanceToEntryAtr, 2)} ATR4H below/away from current price, beyond the ${fmt(opts.deepPullbackMonitorAtr, 2)} ATR monitor threshold; treat as a lower-fill-probability deep contingency, not an active chase/refresh signal.`);
  } else if (against4h) {
    status = 'KEEP_BUT_MONITOR';
    reasons.push(`4H trend is currently ${market.trend4h.label}, against this ${side} order.`);
  } else {
    reasons.push('Entry/SL/TP/risk checks are mechanically still coherent.');
    if (currentBeyondTp && pullbackOrderStillBelowCurrent) {
      reasons.push('Current price is above TP, but this is an unfilled deeper pullback order with TP still above entry; that is not stale by itself.');
    }
  }

  return {
    kind: 'open_order',
    symbol: order.symbol,
    orderId: order.orderId,
    clientOid: order.clientOid,
    side,
    status,
    action: status === 'KEEP_UNCHANGED' ? 'Do nothing.' : status === 'KEEP_BUT_MONITOR' ? 'Do not modify automatically; monitor for 4H recovery/confirmation.' : status === 'TP_REFRESH' ? 'Refresh TP map before changing anything.' : status === 'CANCEL_UNFILLED' ? 'Recommend canceling this unfilled order only after explicit confirmation.' : 'Recommend full ticket refresh before further action.',
    qty,
    remaining,
    entry,
    sl,
    tp,
    ageHours,
    createdAt: isoFromMs(order.cTime),
    riskUsdt: risk,
    rewardUsdt: reward,
    rr,
    distanceToEntryAtr,
    tpDistanceAtr,
    reasons,
  };
}

function getSlTpPlansForPosition(position, plans) {
  const symbol = position.symbol;
  const side = sideFrom(position);
  const relevant = plans.filter((p) => p.symbol === symbol && sideFrom(p) === side);
  const lossPlans = relevant.filter((p) => String(p.planType || '').includes('loss') || p.stopLossTriggerPrice);
  const profitPlans = relevant.filter((p) => String(p.planType || '').includes('profit') || p.stopSurplusTriggerPrice);
  return { lossPlans, profitPlans };
}

function classifyPosition(position, market, plans, nowMs, opts) {
  const side = sideFrom(position);
  const qty = num(position.total);
  const available = num(position.available);
  const avgEntry = num(position.openPriceAvg);
  const mark = num(position.markPrice, market.current);
  const unrealized = num(position.unrealizedPL, 0);
  const { lossPlans, profitPlans } = getSlTpPlansForPosition(position, plans);
  const slValues = lossPlans.map((p) => num(p.stopLossTriggerPrice ?? p.triggerPrice)).filter(Number.isFinite);
  const tpValues = profitPlans.map((p) => num(p.stopSurplusTriggerPrice ?? p.triggerPrice)).filter(Number.isFinite);
  const sl = slValues.length ? (side === 'long' ? Math.max(...slValues) : Math.min(...slValues)) : NaN;
  const nearestTp = tpValues.length ? (side === 'long' ? Math.min(...tpValues.filter((v) => v >= mark).concat(tpValues)) : Math.max(...tpValues.filter((v) => v <= mark).concat(tpValues))) : NaN;
  const openRisk = Number.isFinite(sl) ? (side === 'long' ? Math.max(0, mark - sl) * qty : Math.max(0, sl - mark) * qty) : NaN;
  const originalRisk = Number.isFinite(sl) ? (side === 'long' ? Math.max(0, avgEntry - sl) * qty : Math.max(0, sl - avgEntry) * qty) : NaN;
  const unrealizedR = originalRisk > 0 ? unrealized / originalRisk : NaN;
  const tpReward = Number.isFinite(nearestTp) ? (side === 'long' ? Math.max(0, nearestTp - mark) * qty : Math.max(0, mark - nearestTp) * qty) : NaN;
  const remainingRr = openRisk > 0 ? tpReward / openRisk : NaN;
  const atr4h = market.atr4h;
  const distanceToSlAtr = Number.isFinite(atr4h) && atr4h > 0 && Number.isFinite(sl) ? Math.abs(mark - sl) / atr4h : NaN;
  const tpDistanceAtr = Number.isFinite(atr4h) && atr4h > 0 && Number.isFinite(nearestTp) ? Math.abs(nearestTp - mark) / atr4h : NaN;
  const structuralInv = recentExtreme(market.c4h, side);
  const canReduceByR = Number.isFinite(unrealizedR) && unrealizedR >= opts.riskReductionR;
  const nearSl = Number.isFinite(distanceToSlAtr) && distanceToSlAtr <= opts.nearSlAtr;
  const noSl = !Number.isFinite(sl);
  const noTp = !Number.isFinite(nearestTp);
  const rrWeak = Number.isFinite(remainingRr) && remainingRr < opts.minRemainingRr;
  const tpTooFar = Number.isFinite(tpDistanceAtr) && tpDistanceAtr > opts.maxTpAtr;
  const invalidatedByMark = Number.isFinite(sl) && (side === 'long' ? mark <= sl : mark >= sl);

  const reasons = [];
  let status = 'KEEP_UNCHANGED';
  let proposedSl = null;
  if (invalidatedByMark) {
    status = 'EXIT_OR_INVALID';
    reasons.push('Mark/current price is beyond the detected SL/INV area.');
  } else if (noSl || noTp) {
    status = 'FULL_REFRESH';
    reasons.push(`Missing detected ${noSl ? 'SL' : ''}${noSl && noTp ? ' and ' : ''}${noTp ? 'TP' : ''} profit/loss plan(s).`);
  } else if (openRisk > opts.maxRiskUsdt * 1.1) {
    status = 'REDUCE_RISK';
    reasons.push(`Open risk to SL is ${fmt(openRisk, 2)} USDT, above ${fmt(opts.maxRiskUsdt, 2)} USDT target.`);
  } else if (nearSl) {
    status = 'EXIT_OR_INVALID';
    reasons.push(`Price is only ${fmt(distanceToSlAtr, 2)} ATR4H from SL; thesis is under stress.`);
  } else if (canReduceByR && Number.isFinite(structuralInv)) {
    status = 'REDUCE_RISK';
    proposedSl = side === 'long' ? structuralInv - (0.25 * atr4h) : structuralInv + (0.25 * atr4h);
    reasons.push(`Position is ${fmt(unrealizedR, 2)}R in profit and has a recent 4H structural reference; risk reduction can be considered.`);
  } else if (rrWeak) {
    status = 'TP_REFRESH';
    reasons.push(`Current remaining RR to nearest TP is weak at ${fmt(remainingRr, 2)}R.`);
  } else if (tpTooFar) {
    status = 'KEEP_BUT_MONITOR';
    reasons.push(`Nearest TP is ${fmt(tpDistanceAtr, 2)} ATR4H away; TP is still structurally possible but needs monitoring/reclaim confirmation before calling it high-quality.`);
  } else {
    status = 'KEEP_UNCHANGED';
    reasons.push('Position risk, SL/TP presence, and remaining RR are mechanically coherent.');
  }

  return {
    kind: 'position',
    symbol: position.symbol,
    side,
    status,
    action: status === 'KEEP_UNCHANGED' ? 'Do nothing.' : status === 'KEEP_BUT_MONITOR' ? 'Keep current static plan; monitor reclaim/weakness triggers and consider optional risk reduction only by explicit confirmation.' : status === 'REDUCE_RISK' ? 'Recommend risk-reduction plan only after explicit confirmation.' : status === 'TP_REFRESH' ? 'Refresh TP map before changing anything.' : status === 'EXIT_OR_INVALID' ? 'Manual review urgently; exit/SL action requires explicit confirmation unless exchange SL has already handled it.' : 'Run a full fresh ticket refresh.',
    qty,
    available,
    avgEntry,
    mark,
    leverage: num(position.leverage),
    marginMode: position.marginMode,
    unrealizedUsdt: unrealized,
    unrealizedR,
    sl,
    tpValues,
    nearestTp,
    lossPlanCount: lossPlans.length,
    profitPlanCount: profitPlans.length,
    openRiskUsdt: openRisk,
    originalRiskUsdt: originalRisk,
    tpRewardUsdt: tpReward,
    remainingRr,
    distanceToSlAtr,
    tpDistanceAtr,
    structuralInv,
    proposedSl,
    reasons,
    createdAt: isoFromMs(position.cTime),
    ageHours: hoursBetween(position.cTime, nowMs),
  };
}

function worstStatus(items, liquidityResult) {
  const rank = {
    KEEP_UNCHANGED: 0,
    KEEP_BUT_MONITOR: 1,
    TP_REFRESH: 2,
    REDUCE_RISK: 3,
    CANCEL_UNFILLED: 4,
    FULL_REFRESH: 5,
    EXIT_OR_INVALID: 6,
  };
  let worst = 'KEEP_UNCHANGED';
  for (const item of items) {
    if ((rank[item.status] ?? 0) > (rank[worst] ?? 0)) worst = item.status;
  }
  if (worst === 'KEEP_UNCHANGED' && liquidityResult === 'YELLOW') worst = 'KEEP_BUT_MONITOR';
  if (worst === 'KEEP_UNCHANGED' && liquidityResult === 'RED') worst = 'KEEP_BUT_MONITOR';
  return worst;
}

function aggregateExposure(items) {
  const rows = items.filter((x) => Number.isFinite(x.remaining) || Number.isFinite(x.qty));
  const totalQty = rows.reduce((acc, x) => acc + (Number.isFinite(x.remaining) ? x.remaining : x.qty || 0), 0);
  const notional = rows.reduce((acc, x) => {
    const qty = Number.isFinite(x.remaining) ? x.remaining : x.qty || 0;
    const price = Number.isFinite(x.entry) ? x.entry : (Number.isFinite(x.mark) ? x.mark : x.avgEntry);
    return acc + qty * (Number.isFinite(price) ? price : 0);
  }, 0);
  const risk = rows.reduce((acc, x) => acc + (x.riskUsdt || x.openRiskUsdt || 0), 0);
  return { totalQty, notional, risk };
}

async function runDiagnostic(args) {
  const cfg = getDefaultTradingConfig();
  const client = new BitgetClient();
  const productType = args.productType || cfg.productType;
  const nowMs = Date.now();
  const opts = {
    maxRiskUsdt: num(args.maxRiskUsdt, 100),
    minRestingEntryAtr: num(args.minRestingEntryAtr, 0.25),
    maxTicketAgeHours: num(args.maxTicketAgeHours, 24 * 5),
    minRemainingRr: num(args.minRemainingRr, 1.25),
    maxTpAtr: num(args.maxTpAtr, 3.5),
    deepPullbackMonitorAtr: num(args.deepPullbackMonitorAtr, 4.0),
    nearSlAtr: num(args.nearSlAtr, 0.35),
    riskReductionR: num(args.riskReductionR, 1),
    runLiquidity: args.liquidity !== 'false',
    liquiditySampleCount: num(args.liquiditySampleCount ?? args.sampleCount, 1),
  };

  const [regularRaw, positionsRaw, normalPlan, profitLossPlan, trackPlan] = await Promise.all([
    client.get('/api/v2/mix/order/orders-pending', { productType }),
    client.get('/api/v2/mix/position/all-position', { productType, marginCoin: cfg.marginCoin }),
    fetchPlanType(client, productType, 'normal_plan'),
    fetchPlanType(client, productType, 'profit_loss'),
    fetchPlanType(client, productType, 'track_plan'),
  ]);

  const regularOrders = asList(regularRaw).filter((o) => String(o.status || '').toLowerCase() === 'live');
  const positions = asList(positionsRaw).filter((p) => Math.abs(num(p.total, 0)) > 0);
  const plans = [normalPlan, profitLossPlan, trackPlan].flatMap((x) => Array.isArray(x) ? x : x.rows || []);
  const symbolsFilter = args.symbols ? new Set(String(args.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) : null;
  const symbols = [...new Set([...regularOrders.map((o) => o.symbol), ...positions.map((p) => p.symbol)])]
    .filter(Boolean)
    .filter((s) => !symbolsFilter || symbolsFilter.has(String(s).toUpperCase()))
    .sort();

  const summaryIndex = loadExecutionSummaries(process.cwd());
  const regularBySymbol = groupBySymbol(regularOrders.filter((o) => symbols.includes(o.symbol)));
  const positionsBySymbol = groupBySymbol(positions.filter((p) => symbols.includes(p.symbol)));
  const symbolReports = [];

  for (const symbol of symbols) {
    const market = await fetchMarketState(client, productType, symbol);
    const symbolPositions = positionsBySymbol.get(symbol) || [];
    const orderRows = (regularBySymbol.get(symbol) || []).map((order) => {
      const orderSide = sideFrom(order);
      const hasOpenSameSidePosition = symbolPositions.some((position) => sideFrom(position) === orderSide);
      const diag = classifyOrder(order, market, nowMs, opts, { hasOpenSameSidePosition });
      const original = findOriginal(order, summaryIndex);
      if (original) {
        diag.originalSummaryPath = path.relative(process.cwd(), original.summary.__summaryPath);
        diag.originalLeg = original.order.leg;
      }
      return diag;
    });
    const positionRows = symbolPositions.map((position) => classifyPosition(position, market, plans, nowMs, opts));
    const items = [...positionRows, ...orderRows];
    const exposure = aggregateExposure(items);

    let liquidity = null;
    if (opts.runLiquidity && exposure.totalQty > 0 && items.length) {
      const side = items.find((x) => x.side && x.side !== 'unknown')?.side;
      const slCandidates = items.map((x) => x.sl).filter(Number.isFinite);
      const slPrice = side === 'long' ? Math.min(...slCandidates) : Math.max(...slCandidates);
      const entryPrice = exposure.totalQty > 0 ? exposure.notional / exposure.totalQty : NaN;
      if ((side === 'long' || side === 'short') && Number.isFinite(slPrice) && Number.isFinite(entryPrice) && exposure.risk > 0) {
        try {
          liquidity = await runLiquidityGate({
            symbol,
            productType,
            holdSide: side,
            maxQty: exposure.totalQty,
            slPrice,
            entryPrice,
            positionNotional: exposure.notional,
            plannedRiskUsdt: exposure.risk,
            sampleCount: opts.liquiditySampleCount,
          }, { client });
        } catch (err) {
          liquidity = { result: 'ERROR', error: err.message || String(err) };
        }
      }
    }

    const finalStatus = worstStatus(items, liquidity?.result);
    symbolReports.push({
      symbol,
      current: market.current,
      atr4h: market.atr4h,
      market: {
        trend1d: market.trend1d,
        trend4h: market.trend4h,
        trend1h: market.trend1h,
        sr4h: market.sr4h,
        sr1h: market.sr1h,
      },
      exposure,
      liquidity: liquidity ? {
        result: liquidity.result,
        reducedSizeProposal: liquidity.reducedSizeProposal,
        error: liquidity.error,
        metrics: liquidity.metrics ? {
          simSlippageStatus: liquidity.metrics.simSlippage?.status,
          nearMarketDepthStatus: liquidity.metrics.nearMarketDepth?.status,
          spreadStatus: liquidity.metrics.spread?.status,
          volumeStressStatus: liquidity.metrics.volumeStress?.status,
          deadCandlesStatus: liquidity.metrics.deadCandles?.status,
          volume24hStatus: liquidity.metrics.volume24h?.status,
        } : undefined,
      } : null,
      finalStatus,
      items,
    });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    env: cfg.env,
    papTrading: cfg.papTrading,
    productType,
    marginCoin: cfg.marginCoin,
    policy: {
      mode: 'READ_ONLY_DIAGNOSTIC_RECOMMENDATIONS_ONLY',
      noAutomaticExchangeChanges: true,
      userConfirmationRequiredForAnyCancelModifyExit: true,
    },
    options: opts,
    counts: {
      symbols: symbolReports.length,
      openRegularOrders: regularOrders.length,
      openPositions: positions.length,
      pendingPlans: plans.length,
    },
    symbols: symbolReports,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Open Position / Order Diagnostic');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: **${report.policy.mode}** — no orders are placed/canceled/modified.`);
  lines.push(`Environment: ${report.env}${report.papTrading ? ' paper' : ''} / ${report.productType}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Symbol | Verdict | Current | ATR4H | Exposure qty | Risk USDT | Liquidity | Best action |');
  lines.push('|---|---|---:|---:|---:|---:|---|---|');
  for (const s of report.symbols) {
    const firstAction = s.items.find((x) => x.status === s.finalStatus)?.action || s.items[0]?.action || 'No action.';
    lines.push(`| ${s.symbol} | ${statusLight(s.finalStatus)} ${s.finalStatus} | ${fmt(s.current, 4)} | ${fmt(s.atr4h, 4)} | ${fmt(s.exposure.totalQty, 4)} | ${fmt(s.exposure.risk, 2)} | ${s.liquidity?.result || 'not run'} | ${firstAction} |`);
  }
  lines.push('');

  for (const s of report.symbols) {
    lines.push(`## ${s.symbol}`);
    lines.push('');
    lines.push(`Final diagnostic verdict: **${statusLight(s.finalStatus)} ${s.finalStatus}**`);
    lines.push(`Current: ${fmt(s.current, 4)} | ATR4H: ${fmt(s.atr4h, 4)} | 1D/4H/1H: ${s.market.trend1d.label} (${pct(s.market.trend1d.changePct)}) / ${s.market.trend4h.label} (${pct(s.market.trend4h.changePct)}) / ${s.market.trend1h.label} (${pct(s.market.trend1h.changePct)})`);
    lines.push(`Nearest 4H SR: support ${fmt(s.market.sr4h.support, 4)} / resistance ${fmt(s.market.sr4h.resistance, 4)}`);
    if (s.liquidity) {
      lines.push(`Orderability/liquidity: **${s.liquidity.result}**${s.liquidity.error ? ` (${s.liquidity.error})` : ''}`);
      if (s.liquidity.metrics) {
        lines.push(`- Gates: stop-exit ${s.liquidity.metrics.simSlippageStatus}, near-depth ${s.liquidity.metrics.nearMarketDepthStatus}, spread ${s.liquidity.metrics.spreadStatus}, p10/volume ${s.liquidity.metrics.volumeStressStatus}, dead candles ${s.liquidity.metrics.deadCandlesStatus}, 24h ${s.liquidity.metrics.volume24hStatus}`);
      }
    }
    lines.push('');
    lines.push('| Kind | ID | Side | Qty | Entry/Mark | SL | TP | Risk | R/R or R | Verdict |');
    lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---|');
    for (const item of s.items) {
      if (item.kind === 'open_order') {
        lines.push(`| order | ${item.originalLeg || item.clientOid || item.orderId} | ${item.side} | ${fmt(item.remaining, 4)} | ${fmt(item.entry, 4)} | ${fmt(item.sl, 4)} | ${fmt(item.tp, 4)} | ${fmt(item.riskUsdt, 2)} | ${fmt(item.rr, 2)} | ${statusLight(item.status)} ${item.status} |`);
      } else {
        lines.push(`| position | ${item.symbol} | ${item.side} | ${fmt(item.qty, 4)} | ${fmt(item.mark, 4)} avg ${fmt(item.avgEntry, 4)} | ${fmt(item.sl, 4)} | ${fmt(item.nearestTp, 4)} | ${fmt(item.openRiskUsdt, 2)} | ${fmt(item.unrealizedR, 2)}R | ${statusLight(item.status)} ${item.status} |`);
      }
    }
    lines.push('');
    for (const item of s.items) {
      const label = item.kind === 'open_order' ? (item.originalLeg || item.clientOid || item.orderId) : `${item.symbol} position`;
      lines.push(`### ${label}`);
      lines.push(`Action: **${item.action}**`);
      if (item.kind === 'open_order') {
        lines.push(`Age: ${item.createdAt || 'n/a'} (${item.ageHours == null ? 'n/a' : `${fmt(item.ageHours / 24, 1)}d`}) | entry distance: ${fmt(item.distanceToEntryAtr, 2)} ATR4H | TP distance: ${fmt(item.tpDistanceAtr, 2)} ATR4H`);
        if (item.originalSummaryPath) lines.push(`Original summary: ${item.originalSummaryPath}`);
      } else {
        lines.push(`Unrealized: ${fmt(item.unrealizedUsdt, 2)} USDT / ${fmt(item.unrealizedR, 2)}R | remaining RR: ${fmt(item.remainingRr, 2)} | SL distance: ${fmt(item.distanceToSlAtr, 2)} ATR4H`);
        lines.push(`Plans: TP ${item.profitPlanCount}, SL ${item.lossPlanCount}${item.proposedSl ? ` | proposed structural SL candidate: ${fmt(item.proposedSl, 4)}` : ''}`);
      }
      for (const reason of item.reasons) lines.push(`- ${reason}`);
      lines.push('');
    }
  }

  lines.push('## Safety note');
  lines.push('Any cancel, TP/SL edit, partial close, or exit remains a separate live-execution request and requires explicit user confirmation.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const report = await runDiagnostic(args);
  const markdown = renderMarkdown(report);
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  }
  if (args.markdownOut) {
    fs.mkdirSync(path.dirname(path.resolve(args.markdownOut)), { recursive: true });
    fs.writeFileSync(args.markdownOut, markdown);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(markdown);
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
