#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { BitgetClient, getDefaultTradingConfig } = require('../bitget-futures-harness/lib/bitgetClient');
const { parseArgs } = require('../bitget-futures-harness/lib/cli');
const { runLiquidityGate } = require('../bitget-futures-harness/lib/liquidityGate');

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const DEFAULT_STATE = path.resolve(__dirname, '..', 'reports', 'watchdogs', 'clusdt_breakdown_watchdog_state.json');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmt(v, d = 4) { return Number.isFinite(Number(v)) ? Number(v).toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : 'n/a'; }
function floorStep(v, step) { return Math.floor((Number(v) + 1e-12) / step) * step; }
function loadJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function saveJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
function rows(resp) { return Array.isArray(resp?.data) ? resp.data : []; }
function asTicker(resp) { return Array.isArray(resp?.data) ? (resp.data[0] || {}) : (resp?.data || {}); }
function orderList(resp) { const d = resp?.data; if (Array.isArray(d)) return d; if (Array.isArray(d?.entrustedList)) return d.entrustedList; return []; }
function candle(row) { return { ts: num(row[0]), open: num(row[1]), high: num(row[2]), low: num(row[3]), close: num(row[4]), baseVolume: num(row[5]), quoteVolume: num(row[6]) }; }
function trueRange(c, prev) { return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)); }
function avg(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }

function latestClosed4h(candles, nowMs, delayMs) {
  const sorted = candles.slice().sort((a, b) => a.ts - b.ts);
  return sorted.filter(c => c.ts + FOUR_HOURS_MS <= nowMs - delayMs).at(-1);
}

function indicators(allCandles, closed) {
  const sorted = allCandles.slice().sort((a, b) => a.ts - b.ts);
  const idx = sorted.findIndex(c => c.ts === closed.ts);
  if (idx < 20 || idx < 14) throw new Error('Not enough 4H candles for ATR/volume average');
  const trs = [];
  for (let i = idx - 13; i <= idx; i += 1) trs.push(trueRange(sorted[i], sorted[i - 1]));
  const atr14 = avg(trs);
  const vol20Rows = sorted.slice(idx - 20, idx);
  const volAvg20 = avg(vol20Rows.map(c => c.quoteVolume));
  return { atr14, volAvg20 };
}

function buildTicket({ entry, sl, tp1, tp2, riskBudget, qtyStep, leverageMax, marginMax, atr14 }) {
  const riskPerUnit = sl - entry;
  if (!(riskPerUnit > 0)) return { ok: false, reason: 'entry is not below SL for short ticket' };
  const qty1 = floorStep((riskBudget * 0.40) / riskPerUnit, qtyStep);
  const qty2 = floorStep((riskBudget * 0.60) / riskPerUnit, qtyStep);
  const qty = qty1 + qty2;
  const risk1 = qty1 * riskPerUnit;
  const risk2 = qty2 * riskPerUnit;
  const totalRisk = risk1 + risk2;
  const reward1 = Math.max(0, (entry - tp1) * qty1);
  const reward2 = Math.max(0, (entry - tp2) * qty2);
  const rr1 = risk1 > 0 ? reward1 / risk1 : 0;
  const rr2 = risk2 > 0 ? reward2 / risk2 : 0;
  const weightedRr = totalRisk > 0 ? (reward1 + reward2) / totalRisk : 0;
  const notional = entry * qty;
  let leverage = Math.max(1, Math.ceil(notional / marginMax));
  if (leverage > leverageMax) return { ok: false, reason: `required leverage ${leverage}x exceeds max ${leverageMax}x` };
  const margin = notional / leverage;
  const maintenance = 0.006;
  const estimatedLiquidation = entry * (1 + (1 / leverage) - maintenance);
  const liquidationVsSlGap = estimatedLiquidation - sl;
  const minLiqGap = Number.isFinite(Number(atr14)) && Number(atr14) > 0 ? 0.25 * Number(atr14) : 0;
  const liquidationPass = liquidationVsSlGap > minLiqGap;
  return { ok: true, entry, sl, tp1, tp2, qty1, qty2, qty, risk1, risk2, totalRisk, reward1, reward2, rr1, rr2, weightedRr, notional, margin, leverage, estimatedLiquidation, liquidationVsSlGap, minLiqGap, liquidationPass };
}

function passLine(name, ok, value = '') { return { name, ok: Boolean(ok), value }; }
function isShortOrder(o) {
  const side = String(o.side || '').toLowerCase();
  const tradeSide = String(o.tradeSide || '').toLowerCase();
  const posSide = String(o.posSide || o.holdSide || '').toLowerCase();
  return side === 'sell' || posSide === 'short' || (tradeSide === 'open' && side === 'sell');
}

async function evaluate({ mode, statePath, updateState }) {
  const cfg = getDefaultTradingConfig();
  const client = new BitgetClient();
  const symbol = 'CLUSDT';
  const productType = cfg.productType;
  const nowMs = Date.now();
  const state = loadJson(statePath, {});

  if (mode === 'validity' || mode === 'final') {
    const t = state.activeTicket;
    if (!t) {
      if (mode === 'final') return { status: 'FINAL_RECHECK_FAILED', message: 'CLUSDT.P FINAL RECHECK FAILED\n\nNo active watchdog ticket is waiting for approval. No order was placed.' };
      return { status: 'NO_REPLY', reason: 'no active ticket' };
    }
    if (nowMs > Number(t.expiresAtMs || 0)) {
      state.activeTicket = null;
      state.expiredTickets = [...(state.expiredTickets || []), { expiredAt: new Date(nowMs).toISOString(), ticket: t }].slice(-20);
      if (updateState) saveJson(statePath, state);
      if (mode === 'final') return { status: 'FINAL_RECHECK_FAILED', message: `CLUSDT.P FINAL RECHECK FAILED\n\nSignal from ${t.createdAt} is older than 60 minutes / expired. No order was placed; a new fully closed 4H candle signal is required.` };
      return { status: 'EXPIRED', message: `CLUSDT.P BREAKDOWN WATCHDOG SIGNAL EXPIRED\n\nNo approval received within 60 minutes. Signal from ${t.createdAt} is expired; a new fully closed 4H candle signal is required.` };
    }
  }

  const [tickerRaw, candlesRaw, regularRaw, planRaw, positionsRaw, contractsRaw] = await Promise.all([
    client.get('/api/v2/mix/market/ticker', { symbol, productType }),
    client.get('/api/v2/mix/market/candles', { symbol, productType, granularity: '4H', limit: '80' }),
    client.get('/api/v2/mix/order/orders-pending', { symbol, productType }),
    client.get('/api/v2/mix/order/orders-plan-pending', { symbol, productType, planType: 'normal_plan' }),
    client.get('/api/v2/mix/position/all-position', { productType, marginCoin: cfg.marginCoin }),
    client.get('/api/v2/mix/market/contracts', { productType }),
  ]);

  const ticker = asTicker(tickerRaw);
  const candles = rows(candlesRaw).map(candle).sort((a, b) => a.ts - b.ts);
  const closed = latestClosed4h(candles, nowMs, 5 * 60 * 1000);
  if (!closed) throw new Error('No fully closed 4H candle available');
  const { atr14, volAvg20 } = indicators(candles, closed);
  const currentPrice = num(ticker.lastPr || ticker.markPrice);
  const spreadBps = ((num(ticker.askPr) - num(ticker.bidPr)) / ((num(ticker.askPr) + num(ticker.bidPr)) / 2)) * 10000;
  const closeDistanceAtr = atr14 > 0 ? (94.30 - closed.close) / atr14 : 0;
  const volumeRatio = volAvg20 > 0 ? closed.quoteVolume / volAvg20 : 0;
  const closePosition = closed.high > closed.low ? (closed.close - closed.low) / (closed.high - closed.low) : 1;
  const overextensionAtr = atr14 > 0 ? Math.max(0, 94.30 - currentPrice) / atr14 : Infinity;
  const dataFresh = Math.abs(nowMs - num(ticker.ts || ticker.requestTime)) <= 2 * 60 * 1000;
  const closedTsValid = closed.ts % FOUR_HOURS_MS === 0;
  const openOrders = [...orderList(regularRaw), ...orderList(planRaw)];
  const activeShortOrders = openOrders.filter(isShortOrder);
  const positions = rows(positionsRaw).filter(p => p.symbol === symbol && Math.abs(num(p.total || p.available)) > 0);
  const contract = rows(contractsRaw).find(c => c.symbol === symbol) || {};
  const qtyStep = num(contract.sizeMultiplier || 0.01) || 0.01;

  const ticket = buildTicket({ entry: currentPrice, sl: 97.25, tp1: 90.10, tp2: 88.70, riskBudget: 100, qtyStep, leverageMax: 20, marginMax: 500, atr14 });
  const liquidityGate = ticket.ok ? await runLiquidityGate({
    symbol,
    productType,
    side: 'sell',
    maxQty: ticket.qty,
    entryPrice: ticket.entry,
    positionNotional: ticket.notional,
    slPrice: ticket.sl,
    plannedRiskUsdt: ticket.totalRisk,
  }) : null;

  const gates = [
    passLine('4H close below 94.30', closed.close < 94.30, fmt(closed.close, 3)),
    passLine('Close distance in ATR', closeDistanceAtr >= 0.15, fmt(closeDistanceAtr, 3)),
    passLine('4H volume >= 1.3x avg20', volumeRatio >= 1.3, `${fmt(volumeRatio, 2)}x`),
    passLine('Close in lower 40% of candle', closePosition <= 0.40, `${fmt(closePosition * 100, 1)}%`),
    passLine('Current price not overextended', overextensionAtr <= 0.80, `${fmt(overextensionAtr, 3)} ATR below trigger`),
    passLine('Spread/slippage normal', liquidityGate && liquidityGate.result !== 'RED', liquidityGate ? liquidityGate.result : 'no ticket'),
    passLine('No existing CLUSDT position', positions.length === 0, `${positions.length}`),
    passLine('No existing active CLUSDT short order', activeShortOrders.length === 0, `${activeShortOrders.length}`),
    passLine('Bitget data fresh', dataFresh && closedTsValid, `tickerAgeMs=${Math.round(nowMs - num(ticker.ts || 0))}, closed=${new Date(closed.ts).toISOString()}`),
    passLine('Risk <= 100', ticket.ok && ticket.totalRisk <= 100, ticket.ok ? fmt(ticket.totalRisk, 2) : ticket.reason),
    passLine('Margin <= 500', ticket.ok && ticket.margin <= 500, ticket.ok ? fmt(ticket.margin, 2) : ticket.reason),
    passLine('Leverage <= 20x', ticket.ok && ticket.leverage <= 20, ticket.ok ? `${ticket.leverage}x` : ticket.reason),
    passLine('Liquidation safely beyond SL', ticket.ok && ticket.liquidationPass, ticket.ok ? `liq ${fmt(ticket.estimatedLiquidation, 3)} > SL ${fmt(ticket.sl, 3)} by ${fmt(ticket.liquidationVsSlGap, 3)} (min ${fmt(ticket.minLiqGap, 3)})` : ticket.reason),
    passLine('Weighted R:R >= 1.50', ticket.ok && ticket.weightedRr >= 1.50, ticket.ok ? fmt(ticket.weightedRr, 2) : ticket.reason),
  ];

  const failed = gates.filter(g => !g.ok);

  if (mode === 'validity' || mode === 'final') {
    if (failed.length) {
      const t = state.activeTicket;
      state.activeTicket = null;
      state.invalidatedTickets = [...(state.invalidatedTickets || []), { invalidatedAt: new Date(nowMs).toISOString(), failed, ticket: t }].slice(-20);
      if (updateState) saveJson(statePath, state);
      if (mode === 'final') {
        return { status: 'FINAL_RECHECK_FAILED', failed, message: `CLUSDT.P FINAL RECHECK FAILED\n\n${failed.map(g => `- ${g.name}: ${g.value}`).join('\n')}\n\nNo order was placed.` };
      }
      return { status: 'INVALIDATED', failed, message: `CLUSDT.P BREAKDOWN WATCHDOG SIGNAL INVALIDATED\n\n${failed.map(g => `- ${g.name}: ${g.value}`).join('\n')}\n\nNo order will be placed; a new fully closed 4H candle signal is required.` };
    }
    if (mode === 'final') {
      return { status: 'FINAL_READY', gates, ticket, liquidityGate, message: `CLUSDT.P FINAL RECHECK PASSED — READY TO PLACE\n\nDirection: SHORT\nEntry type: MARKET\nEstimated entry: ${fmt(ticket.entry, 3)}\nSL: ${fmt(ticket.sl, 3)}\nTP1: ${fmt(ticket.tp1, 3)}\nTP2: ${fmt(ticket.tp2, 3)}\nQuantity part 1: ${fmt(ticket.qty1, 2)}\nQuantity part 2: ${fmt(ticket.qty2, 2)}\nTotal risk: ${fmt(ticket.totalRisk, 2)} USDT\nEstimated margin: ${fmt(ticket.margin, 2)} USDT\nLeverage: ${ticket.leverage}x isolated\nEstimated liquidation: ${fmt(ticket.estimatedLiquidation, 3)} (SL ${fmt(ticket.sl, 3)}; pass=${ticket.liquidationPass ? 'YES' : 'NO'})\nWeighted R:R: ${fmt(ticket.weightedRr, 2)}\nLiquidity gate: ${liquidityGate.result}` };
    }
    return { status: 'NO_REPLY', reason: 'active ticket still valid' };
  }

  if (state.activeTicket && nowMs <= Number(state.activeTicket.expiresAtMs || 0)) {
    return { status: 'NO_REPLY', reason: 'active signal already waiting approval' };
  }
  if (state.lastCheckedCandleStartMs === closed.ts) return { status: 'NO_REPLY', reason: 'this closed candle was already checked' };

  state.lastCheckedCandleStartMs = closed.ts;
  state.lastCheckedAt = new Date(nowMs).toISOString();
  state.lastStatus = failed.length ? 'NO_SIGNAL' : 'READY';
  state.lastFailedGates = failed;

  if (failed.length) {
    if (updateState) saveJson(statePath, state);
    return { status: 'NO_SIGNAL', closedCandleStart: new Date(closed.ts).toISOString(), failed, gates, ticket, liquidityGate };
  }

  const createdAt = new Date(nowMs).toISOString();
  const expiresAtMs = nowMs + 60 * 60 * 1000;
  state.activeTicket = { createdAt, expiresAtMs, closedCandleStartMs: closed.ts, ticket, atr14, volumeRatio, closeDistanceAtr, closePosition, currentPrice, liquidityGateResult: liquidityGate.result };
  state.lastTriggeredCandleStartMs = closed.ts;
  if (updateState) saveJson(statePath, state);

  const message = `CLUSDT.P BREAKDOWN WATCHDOG SIGNAL\n\nStatus: READY FOR REVIEW — NOT EXECUTED\n\nGate results:\n- 4H close below 94.30: PASS (${fmt(closed.close, 3)})\n- Close distance in ATR: PASS (${fmt(closeDistanceAtr, 3)} ATR)\n- ATR4H: ${fmt(atr14, 4)}\n- Volume vs 20-period average: PASS (${fmt(volumeRatio, 2)}x)\n- Candle close position: PASS (${fmt(closePosition * 100, 1)}% of range)\n- Current price: ${fmt(currentPrice, 3)}\n- Overextension check: PASS (${fmt(overextensionAtr, 3)} ATR below trigger)\n- Spread/slippage: ${liquidityGate.result} (spread ${fmt(spreadBps, 2)} bps)\n- Existing position: PASS (none)\n- Existing orders: PASS (no active CLUSDT short order)\n- Data freshness: PASS\n\nProposed ticket:\n- Direction: SHORT\n- Entry type: MARKET ONLY AFTER APPROVAL + FINAL RECHECK\n- Estimated entry: ${fmt(ticket.entry, 3)}\n- SL: ${fmt(ticket.sl, 3)}\n- TP1: ${fmt(ticket.tp1, 3)}\n- TP2: ${fmt(ticket.tp2, 3)}\n- Quantity part 1: ${fmt(ticket.qty1, 2)}\n- Quantity part 2: ${fmt(ticket.qty2, 2)}\n- Risk part 1: ${fmt(ticket.risk1, 2)} USDT\n- Risk part 2: ${fmt(ticket.risk2, 2)} USDT\n- Total risk: ${fmt(ticket.totalRisk, 2)} USDT\n- Estimated margin: ${fmt(ticket.margin, 2)} USDT\n- Leverage: ${ticket.leverage}x isolated\n- Estimated liquidation: ${fmt(ticket.estimatedLiquidation, 3)} (SL ${fmt(ticket.sl, 3)}; pass=${ticket.liquidationPass ? 'YES' : 'NO'})\n- R:R to TP1: ${fmt(ticket.rr1, 2)}\n- R:R to TP2: ${fmt(ticket.rr2, 2)}\n- Weighted R:R: ${fmt(ticket.weightedRr, 2)}\n\nWarnings:\n- Oil headline risk remains high.\n- Market order can slip during Iran/Hormuz/news events.\n- Final recheck is mandatory before execution.\n\nReply exactly:\nAPPROVE CL SHORT\n\nSignal expires: ${new Date(expiresAtMs).toISOString()}`;

  return { status: 'READY', message, gates, ticket, liquidityGate };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const statePath = path.resolve(args.state || DEFAULT_STATE);
  const mode = args.mode || 'main';
  const updateState = args.updateState !== 'false';
  const result = await evaluate({ mode, statePath, updateState });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'READY' || result.status === 'EXPIRED' || result.status === 'INVALIDATED' || result.status === 'FINAL_READY' || result.status === 'FINAL_RECHECK_FAILED') console.log(result.message);
  else console.log('NO_REPLY');
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
