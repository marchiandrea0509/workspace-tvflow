#!/usr/bin/env node
/**
 * Reusable Bitget Virtual OCO alert watchdog.
 *
 * Safety boundary: read-only market/account checks + Discord alert output only.
 * This script must never import/call live order placement tools or Bitget order POST endpoints.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BitgetClient, getDefaultTradingConfig } = require('../bitget-futures-harness/lib/bitgetClient');
const { parseArgs } = require('../bitget-futures-harness/lib/cli');

const TF_MS = {
  '1M': 60 * 1000,
  '3M': 3 * 60 * 1000,
  '5M': 5 * 60 * 1000,
  '15M': 15 * 60 * 1000,
  '30M': 30 * 60 * 1000,
  '1H': 60 * 60 * 1000,
  '2H': 2 * 60 * 60 * 1000,
  '4H': 4 * 60 * 60 * 1000,
  '6H': 6 * 60 * 60 * 1000,
  '12H': 12 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
};

const DEFAULT_OUT_DIR = path.resolve(__dirname, '..', 'reports', 'watchdogs', 'virtual_oco');

function num(v, fallback = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function fmt(v, d = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
function upper(v) { return String(v || '').trim().toUpperCase(); }
function safeName(v) { return String(v || 'virtual_oco').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120); }
function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function loadJsonFallback(p, fallback) { try { return loadJson(p); } catch { return fallback; } }
function saveJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
function rows(resp) { return Array.isArray(resp?.data) ? resp.data : []; }
function asTicker(resp) { return Array.isArray(resp?.data) ? (resp.data[0] || {}) : (resp?.data || {}); }
function candle(row) { return { ts: num(row[0]), open: num(row[1]), high: num(row[2]), low: num(row[3]), close: num(row[4]), baseVolume: num(row[5]), quoteVolume: num(row[6]) }; }
function getByPath(obj, keyPath) {
  return String(keyPath || '').split('.').reduce((acc, k) => (acc && Object.prototype.hasOwnProperty.call(acc, k) ? acc[k] : undefined), obj);
}
function cmp(a, op, b) {
  const av = num(a);
  const bv = num(b);
  switch (String(op || '').trim()) {
    case '>': return av > bv;
    case '>=': return av >= bv;
    case '<': return av < bv;
    case '<=': return av <= bv;
    case '==': return av === bv;
    case '!=': return av !== bv;
    default: throw new Error(`Unsupported comparison op: ${op}`);
  }
}
function tfMs(tf) {
  const key = upper(tf);
  if (!TF_MS[key]) throw new Error(`Unsupported timeframe: ${tf}`);
  return TF_MS[key];
}
function latestClosed(candles, timeframe, nowMs, delayMs) {
  const dur = tfMs(timeframe);
  const sorted = candles.slice().sort((a, b) => a.ts - b.ts);
  return sorted.filter(c => c.ts + dur <= nowMs - delayMs).at(-1);
}
function prevClosed(candles, closed) {
  const sorted = candles.slice().sort((a, b) => a.ts - b.ts);
  const idx = sorted.findIndex(c => c.ts === closed?.ts);
  return idx > 0 ? sorted[idx - 1] : null;
}
function trueRange(c, prev) { return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)); }
function avg(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function atr(candles, closed, period = 14) {
  const sorted = candles.slice().sort((a, b) => a.ts - b.ts);
  const idx = sorted.findIndex(c => c.ts === closed?.ts);
  if (idx < period) return NaN;
  const trs = [];
  for (let i = idx - period + 1; i <= idx; i += 1) trs.push(trueRange(sorted[i], sorted[i - 1]));
  return avg(trs);
}
function resolveRiskCapUsd(cfg = {}) {
  const riskCap = num(cfg.risk_cap_usd ?? cfg.riskCapUsd ?? cfg.maxPlannedRiskUsdt, NaN);
  return Number.isFinite(riskCap) ? riskCap : 100;
}
function familyPlannedRisk(family = {}) {
  const direct = num(family.ticket?.plannedRisk ?? family.plannedRisk, NaN);
  if (Number.isFinite(direct)) return direct;
  const legs = family.entries || family.ticket?.entries || [];
  const legRisks = legs.map(leg => num(leg.plannedRisk ?? leg.risk, NaN));
  if (legRisks.length && legRisks.every(Number.isFinite)) return legRisks.reduce((a, b) => a + b, 0);
  return NaN;
}
function ticketRiskChecks(ticket = {}, cfg = {}) {
  const source = ticket.ticket || ticket;
  const riskCapUsd = resolveRiskCapUsd(cfg);
  const maxMargin = num(cfg.maxMarginUsdt, 1500);
  const maxLeverage = num(cfg.maxLeverage, 20);
  const minRr = num(source.minRr ?? cfg.minRr, NaN);
  const checks = [];
  const plannedRisk = familyPlannedRisk(ticket);
  checks.push({ name: 'risk verification', ok: Number.isFinite(plannedRisk), value: Number.isFinite(plannedRisk) ? `planned risk ${fmt(plannedRisk, 2)}` : 'risk verification failed — refresh/resize required' });
  checks.push({ name: 'risk <= risk_cap_usd', ok: Number.isFinite(plannedRisk) && plannedRisk <= riskCapUsd + 1e-9, value: `${fmt(plannedRisk, 2)} <= ${fmt(riskCapUsd, 2)}` });
  checks.push({ name: 'margin <= max', ok: !Number.isFinite(num(source.margin, NaN)) || num(source.margin) <= maxMargin + 1e-9, value: `${fmt(source.margin, 2)} <= ${fmt(maxMargin, 2)}` });
  checks.push({ name: 'leverage <= max', ok: !Number.isFinite(num(source.leverage, NaN)) || num(source.leverage) <= maxLeverage + 1e-9, value: `${fmt(source.leverage, 2)} <= ${fmt(maxLeverage, 2)}` });
  checks.push({ name: 'RR >= minimum', ok: !Number.isFinite(minRr) || num(source.rr, -Infinity) >= minRr - 1e-9, value: `${fmt(source.rr, 2)} >= ${fmt(minRr, 2)}` });
  if (source.structuralValid === false) checks.push({ name: 'SL structural validity', ok: false, value: 'ticket.structuralValid=false' });
  if (source.tpOpenSpaceValid === false) checks.push({ name: 'TP open space', ok: false, value: 'ticket.tpOpenSpaceValid=false' });
  return checks;
}
function familyLetter(family = {}) { return upper(family.family || family.name || family.id || '?'); }
function familyLabel(family = {}) { return `${familyLetter(family)}${family.style ? ` ${family.style}` : ''}`.trim(); }
function inferDirection(family = {}) {
  const bias = upper(family.bias || family.direction || family.side);
  const style = upper(family.style);
  if (bias.includes('LONG') || style === 'DIP_LADDER' || style === 'BREAKOUT') return 'LONG';
  if (bias.includes('SHORT') || style === 'SELL_RALLY' || style === 'BREAKDOWN') return 'SHORT';
  return bias || 'AUTO';
}
function defaultEntryZone(family = {}) {
  const prices = [];
  for (const leg of (family.entries || family.ticket?.entries || [])) {
    const p = num(leg.entry ?? leg.price ?? leg.level, NaN);
    if (Number.isFinite(p)) prices.push(p);
  }
  if (family.entryZone) {
    const lo = num(family.entryZone.min ?? family.entryZone.low ?? family.entryZone.from, NaN);
    const hi = num(family.entryZone.max ?? family.entryZone.high ?? family.entryZone.to, NaN);
    if (Number.isFinite(lo) && Number.isFinite(hi)) return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
  }
  if (!prices.length) return null;
  return { min: Math.min(...prices), max: Math.max(...prices) };
}
function candleTouchedZone(c, zone) { return c && zone && c.low <= zone.max && c.high >= zone.min; }
function checkGenericConditions(conditions = [], ctx = {}) {
  const out = [];
  for (const cond of conditions || []) {
    const left = cond.left ?? cond.field;
    const value = left === 'literal' ? cond.value : getByPath(ctx, left);
    const ok = cond.mode === 'truthy' ? Boolean(value) : cmp(value, cond.op, cond.value);
    out.push({ name: cond.description || `${left} ${cond.op || ''} ${cond.value ?? ''}`.trim(), ok, value: `${fmt(value)} ${cond.op || ''} ${cond.value ?? ''}`.trim(), rawValue: value });
  }
  return out;
}
function checkInvalidation(config, ctx) {
  const invalidations = [];
  for (const cond of (config.globalInvalidation?.conditions || [])) {
    const checks = checkGenericConditions([cond], ctx);
    const c = checks[0];
    // Invalidation conditions are written as "if this is true, invalidate".
    invalidations.push({ ...c, invalidated: c.ok });
  }
  const invLevel = num(config.globalInvalidation?.priceCrosses, NaN);
  const invDirection = upper(config.globalInvalidation?.direction || config.globalInvalidation?.side);
  if (Number.isFinite(invLevel)) {
    const px = ctx.currentPrice;
    let invalidated = false;
    if (invDirection === 'ABOVE') invalidated = px >= invLevel;
    else if (invDirection === 'BELOW') invalidated = px <= invLevel;
    else throw new Error('globalInvalidation.priceCrosses requires direction ABOVE or BELOW');
    invalidations.push({ name: `price crosses invalidation ${invDirection} ${invLevel}`, invalidated, value: fmt(px) });
  }
  return invalidations;
}
function checkConfirmations(family, ctx) {
  return checkGenericConditions(family.confirmations || family.requiredConfirmations || [], ctx);
}
function checkPullbackFamily(family, ctx, config) {
  const direction = inferDirection(family);
  const zone = defaultEntryZone(family);
  const closed = ctx.checkClosed;
  const current = ctx.currentPrice;
  let reached = false;
  let reason = 'no entry zone/levels supplied';
  const rule = family.triggerRule || 'touch_entry_zone';
  if (zone) {
    if (rule === 'current_in_zone') reached = current >= zone.min && current <= zone.max;
    else reached = candleTouchedZone(closed, zone) || (current >= zone.min && current <= zone.max);
    reason = `${rule}: zone ${fmt(zone.min)}-${fmt(zone.max)}, candle H/L ${fmt(closed.high)}/${fmt(closed.low)}, current ${fmt(current)}`;
  }
  const confirmations = checkConfirmations(family, ctx);
  const ticketChecks = ticketRiskChecks(family.ticket || family, config);
  const stale = checkStaleness(family, ctx, zone);
  const gates = [
    { name: 'entry zone reached', ok: reached, value: reason },
    ...confirmations.map(c => ({ name: `confirmation: ${c.name}`, ok: c.ok, value: c.value })),
    ...ticketChecks,
    ...stale,
  ];
  return { family, kind: 'pullback', direction, triggered: gates.every(g => g.ok), gates, triggerReason: reason, zone };
}
function checkStaleness(family, ctx, zone) {
  const out = [];
  const maxDist = num(family.maxStalenessDistance ?? family.maxChaseDistance, NaN);
  if (!Number.isFinite(maxDist)) return out;
  const unit = upper(family.maxStalenessUnit || family.maxChaseUnit || 'PRICE');
  const atr4h = ctx.atr4h;
  const maxPriceDist = unit === 'ATR' ? maxDist * atr4h : maxDist;
  const current = ctx.currentPrice;
  let ref = num(family.stalenessReference ?? family.trigger ?? NaN, NaN);
  if (!Number.isFinite(ref) && zone) ref = inferDirection(family) === 'LONG' ? zone.min : zone.max;
  if (Number.isFinite(ref) && Number.isFinite(maxPriceDist)) {
    const dist = Math.abs(current - ref);
    out.push({ name: 'staleness/max chase', ok: dist <= maxPriceDist + 1e-9, value: `${fmt(dist)} <= ${fmt(maxPriceDist)} (${fmt(maxDist)} ${unit})` });
  }
  return out;
}
function checkBreakoutFamily(family, ctx, config) {
  const direction = inferDirection(family);
  const trigger = num(family.trigger ?? family.entryTrigger ?? family.ticket?.trigger, NaN);
  const closed = ctx.checkClosed;
  const prev = ctx.prevCheckClosed;
  const rule = family.confirmationRule || family.triggerRule || (direction === 'SHORT' ? 'closed_below_trigger' : 'closed_above_trigger');
  let crossed = false;
  let reason = `trigger=${fmt(trigger)}, close=${fmt(closed.close)}`;
  if (Number.isFinite(trigger)) {
    if (rule === 'wick_cross_above') crossed = closed.high >= trigger;
    else if (rule === 'wick_cross_below') crossed = closed.low <= trigger;
    else if (rule === 'crossed_above') crossed = prev ? prev.close < trigger && closed.close >= trigger : closed.close >= trigger;
    else if (rule === 'crossed_below') crossed = prev ? prev.close > trigger && closed.close <= trigger : closed.close <= trigger;
    else if (rule === 'closed_below_trigger') crossed = closed.close <= trigger;
    else crossed = closed.close >= trigger;
    reason = `${rule}: trigger ${fmt(trigger)}, prevClose ${fmt(prev?.close)}, close ${fmt(closed.close)}, high ${fmt(closed.high)}, low ${fmt(closed.low)}`;
  }

  // Scriptable breakout-candle quality gate:
  // 1) close must clear the trigger by a minimum ATR buffer;
  // 2) close must be in the correct part of the candle range to avoid weak/rejection candles.
  const minCloseBufferAtr = num(family.minCloseBufferAtr ?? config.breakoutMinCloseBufferAtr, 0.10);
  const minClosePositionLong = num(family.minClosePositionLong ?? config.breakoutMinClosePositionLong, 0.60);
  const maxClosePositionShort = num(family.maxClosePositionShort ?? config.breakoutMaxClosePositionShort, 0.40);
  const atr4h = ctx.atr4h;
  const closeBuffer = direction === 'SHORT' ? trigger - closed.close : closed.close - trigger;
  const requiredBuffer = minCloseBufferAtr * atr4h;
  const range = closed.high - closed.low;
  const closePosition = range > 0 ? (closed.close - closed.low) / range : NaN;
  const bufferOk = !Number.isFinite(minCloseBufferAtr) || minCloseBufferAtr <= 0
    ? true
    : Number.isFinite(closeBuffer) && Number.isFinite(requiredBuffer) && closeBuffer >= requiredBuffer - 1e-9;
  let closePositionOk = true;
  let closePositionValue = `closePosition ${fmt(closePosition, 3)} (disabled/auto)`;
  if (direction === 'SHORT') {
    closePositionOk = Number.isFinite(closePosition) && closePosition <= maxClosePositionShort + 1e-9;
    closePositionValue = `${fmt(closePosition, 3)} <= ${fmt(maxClosePositionShort, 3)} (short close in lower candle range)`;
  } else if (direction === 'LONG') {
    closePositionOk = Number.isFinite(closePosition) && closePosition >= minClosePositionLong - 1e-9;
    closePositionValue = `${fmt(closePosition, 3)} >= ${fmt(minClosePositionLong, 3)} (long close in upper candle range)`;
  }

  const confirmations = checkConfirmations(family, ctx);
  const ticketChecks = ticketRiskChecks(family.ticket || family, config);
  const chase = checkStaleness(family, ctx, { min: trigger, max: trigger });
  const rejection = family.rejectIfImmediateRangeRejection === false ? [] : checkGenericConditions(family.noImmediateRejectionConditions || [], ctx);
  const gates = [
    { name: 'breakout/breakdown trigger crossed', ok: crossed, value: reason },
    { name: 'breakout close buffer', ok: bufferOk, value: `${fmt(closeBuffer)} >= ${fmt(requiredBuffer)} (${fmt(minCloseBufferAtr, 2)} ATR4H)` },
    { name: 'breakout candle close position', ok: closePositionOk, value: closePositionValue },
    ...confirmations.map(c => ({ name: `confirmation: ${c.name}`, ok: c.ok, value: c.value })),
    ...chase.map(c => ({ ...c, name: 'max chase' })),
    ...rejection.map(c => ({ name: `no immediate rejection: ${c.name}`, ok: c.ok, value: c.value })),
    ...ticketChecks,
  ];
  return { family, kind: 'breakout', direction, triggered: gates.every(g => g.ok), gates, triggerReason: reason, trigger };
}
function chooseTriggered(results, config) {
  const passed = results.filter(r => r.triggered);
  if (!passed.length) return null;
  if (passed.length === 1) return { selected: passed[0], alsoPassed: [] };
  const preferred = upper(config.preferredFamily || config.preferredOption);
  const preferredHit = preferred ? passed.find(r => familyLetter(r.family) === preferred) : null;
  if (preferredHit) return { selected: preferredHit, alsoPassed: passed.filter(r => r !== preferredHit), reason: `preferred family ${preferred}` };
  const sorted = passed.slice().sort((a, b) => {
    const rrDiff = num(b.family.ticket?.rr ?? b.family.rr, 0) - num(a.family.ticket?.rr ?? a.family.rr, 0);
    if (Math.abs(rrDiff) > 1e-9) return rrDiff;
    return num(b.family.cleanerInvalidationScore, 0) - num(a.family.cleanerInvalidationScore, 0);
  });
  return { selected: sorted[0], alsoPassed: sorted.slice(1), reason: 'better current RR / cleaner invalidation score' };
}
function ticketField(family, key) { return family.ticket?.[key] ?? family[key] ?? null; }
function showField(v) { return v === null || v === undefined || v === '' ? 'n/a' : v; }
function formatTicket(family, selected, config, ctx, blockedFamily, extraLines = []) {
  const checkTime = selected ? new Date(ctx.checkClosed.ts).toISOString() : 'n/a';
  const status = selected?.triggered ? 'PASSED' : 'FAILED';
  const gateSummary = selected?.gates || [];
  return `VIRTUAL OCO ALERT — TRADE PROPOSAL READY

OCO group: ${config.ocoGroupId}
Symbol: ${config.symbol}
${metadataBlock(config, ctx, selected, blockedFamily)}

Triggered family: ${familyLabel(family)}
Blocked family: ${blockedFamily || 'none'}
Trigger reason: ${selected?.triggerReason || 'n/a'}
Check TF: ${ctx.checkTf}
Trigger candle close time: ${checkTime}
Current price: ${fmt(ctx.currentPrice)}
Staleness/chase check: ${(gateSummary.find(g => /staleness|max chase/i.test(g.name)) || { value: 'n/a' }).value}
Status: ${status}

Ticket:
- Bias: ${showField(ticketField(family, 'bias'))}
- Style: ${showField(ticketField(family, 'style'))}
- Order type proposal: ${showField(ticketField(family, 'orderTypeProposal'))}
- Entry / trigger: ${showField(ticketField(family, 'entry') ?? ticketField(family, 'trigger'))}
- SL: ${showField(ticketField(family, 'sl'))}
- TP: ${showField(ticketField(family, 'tp'))}
- Quantity: ${showField(ticketField(family, 'quantity'))}
- Notional: ${showField(ticketField(family, 'notional'))}
- Planned risk: ${showField(ticketField(family, 'plannedRisk'))}
- Margin: ${showField(ticketField(family, 'margin'))}
- Leverage: ${showField(ticketField(family, 'leverage'))}
- RR: ${showField(ticketField(family, 'rr'))}
- Invalidation: ${showField(ticketField(family, 'invalidation'))}
- Expiry: ${config.expiryUtc || config.watchdogExpiry}

Gate summary:
${gateSummary.map(g => `- ${g.name}: ${g.ok ? 'PASS' : 'FAIL'} (${g.value || ''})`).join('\n')}
- Final gate result: ${status}
${extraLines.length ? `\nMode/risk notes:\n${extraLines.map(line => `- ${line}`).join('\n')}` : ''}

Action:
Review this proposal. If accepted, handle the order through the normal live-order tool/workflow. This watchdog did not place or cancel any live order.`;
}
function formatInvalidated(config, ctx, reason, failedGate) {
  return `VIRTUAL OCO INVALIDATED

OCO group: ${config.ocoGroupId}
Symbol: ${config.symbol}
${metadataBlock(config, ctx)}

Reason: ${reason}
Current price: ${fmt(ctx?.currentPrice)}
Failed gate: ${failedGate || reason}
Action:
Do not place the prepared ticket. Refresh the chart analysis if still interested.`;
}
function formatExpired(config, ctx = {}) {
  return `VIRTUAL OCO EXPIRED

OCO group: ${config.ocoGroupId}
Symbol: ${config.symbol}
${metadataBlock(config, ctx)}

Expiry time: ${config.expiryUtc || config.watchdogExpiry}
No valid trigger occurred.
Action:
Refresh the analysis before considering a new ticket.`;
}
function firstFailedGate(result) {
  const gates = result?.gates || [];
  return gates.find(g => !g.ok) || gates[0] || null;
}
function formatCheckFeedback(config, ctx, results, note = '') {
  const lines = results.map(r => {
    const gate = firstFailedGate(r);
    const status = r.triggered ? 'READY' : 'waiting';
    return `- ${familyLabel(r.family)}: ${status}${gate ? ` — ${gate.name}: ${gate.value || (gate.ok ? 'PASS' : 'FAIL')}` : ''}`;
  });
  const checkClose = ctx?.checkClosed?.ts ? new Date(ctx.checkClosed.ts).toISOString() : 'n/a';
  return `VIRTUAL OCO CHECK — no trigger

OCO group: ${config.ocoGroupId}
Symbol: ${config.symbol}
Check TF: ${ctx?.checkTf || config.checkTf || config.mainTf || 'n/a'} candle ${checkClose}
Current price: ${fmt(ctx?.currentPrice)}
${note ? `Note: ${note}\n` : ''}${lines.join('\n')}

Status: still armed. No live order was placed.`;
}
function sendDiscord(message, config) {
  const dm = config.discord || {};
  const target = dm.target || dm.dmTarget || process.env.OPENCLAW_VOCO_DISCORD_TARGET;
  if (!target) throw new Error('Discord target missing. Set config.discord.target, e.g. "dm:1322306175865323552".');
  const args = ['message', 'send', '--channel', 'discord', '--target', target, '--message', message, '--json'];
  const res = spawnSync('openclaw', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`openclaw message send failed (${res.status}): ${res.stderr || res.stdout}`);
  return { status: res.status, stdout: res.stdout || '' };
}

function maybeCancelCronAfterTerminal(result, config, args = {}) {
  if (!['ALERTED', 'INVALIDATED', 'EXPIRED'].includes(result?.status)) return null;
  if (args.updateState === 'false') return null;
  const scheduler = config.scheduler || config.cron || {};
  const shouldCancel = scheduler.cancelCronAfterTerminal === true || scheduler.disableCronAfterTerminal === true;
  const cronId = scheduler.cronId || scheduler.jobId || scheduler.id;
  if (!shouldCancel) return null;
  if (!cronId) {
    return { attempted: false, ok: false, reason: 'scheduler.cancelCronAfterTerminal=true but scheduler.cronId is missing' };
  }
  const res = spawnSync('openclaw', ['cron', 'disable', String(cronId)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return {
    attempted: true,
    ok: res.status === 0,
    cronId: String(cronId),
    action: 'openclaw cron disable',
    status: res.status,
    error: res.error ? (res.error.message || String(res.error)) : undefined,
    stderr: res.stderr ? res.stderr.slice(0, 2000) : undefined,
  };
}
function listFromResponse(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  if (Array.isArray(data?.orderList)) return data.orderList;
  return [];
}
function normalizedSymbol(config) {
  return upper(String(config.symbol || '').replace('BITGET:', '').replace('.P', ''));
}
function textOfOrder(order = {}) {
  return [order.clientOid, order.clientOrderId, order.orderId, order.symbol, order.side, order.tradeSide, order.posSide, order.orderType, order.planType]
    .filter(v => v !== undefined && v !== null)
    .join(' ')
    .toLowerCase();
}
function pullbackEntryPrices(config = {}) {
  const families = [];
  if (config.pullbackFamily) families.push(config.pullbackFamily);
  if (Array.isArray(config.pullbackFamilies)) families.push(...config.pullbackFamilies);
  const prices = [];
  for (const family of families) {
    for (const leg of (family.entries || family.ticket?.entries || [])) {
      const p = num(leg.entry ?? leg.price ?? leg.level, NaN);
      if (Number.isFinite(p)) prices.push(p);
    }
    const zone = defaultEntryZone(family);
    if (zone) prices.push(zone.min, zone.max);
  }
  return prices;
}
function priceLooksLikePullback(order = {}, config = {}) {
  const orderPrice = num(order.price || order.triggerPrice || order.executePrice, NaN);
  if (!Number.isFinite(orderPrice)) return false;
  const prices = pullbackEntryPrices(config);
  const tolerance = num(config.liveState?.priceTolerance ?? 0.002, 0.002);
  return prices.some(p => Number.isFinite(p) && Math.abs(orderPrice - p) <= Math.max(tolerance, Math.abs(p) * tolerance));
}
function matchesAnyNeedle(text, needles = []) {
  return needles.some(n => n && text.includes(String(n).toLowerCase()));
}
function classifyLiveOrders(config = {}, regularOrders = [], planOrders = []) {
  const liveCfg = config.liveState || {};
  const ladderNeedles = liveCfg.ladderClientOidIncludes || liveCfg.ladderOrderTextIncludes || ['ladder', '_l1', '_l2', '_l3', '_a', '_b', 'opta', 'optb'];
  const c100Needles = liveCfg.c100ClientOidIncludes || liveCfg.c100OrderTextIncludes || ['c100'];
  const ladderOrders = [];
  const c100Orders = [];
  for (const order of [...regularOrders, ...planOrders]) {
    const text = textOfOrder(order);
    if (matchesAnyNeedle(text, c100Needles)) c100Orders.push(order);
    if (matchesAnyNeedle(text, ladderNeedles) || priceLooksLikePullback(order, config)) ladderOrders.push(order);
  }
  return { ladderOrders, c100Orders };
}
function positionSize(position = {}) {
  return Math.abs(num(position.total ?? position.available ?? position.size ?? position.holdVol ?? position.positionSize, 0));
}
async function collectLiveState(config = {}, ctx = {}) {
  const symbol = normalizedSymbol(config);
  const productType = config.productType || config.marketType || getDefaultTradingConfig().productType;
  const marginCoin = config.marginCoin || getDefaultTradingConfig().marginCoin;
  const liveState = {
    available: true,
    errors: [],
    ladder_status: 'unknown',
    c100_status: 'unknown',
    positions: [],
    regularOrders: [],
    planOrders: [],
    ladderOrders: [],
    c100Orders: [],
    positionSize: 0,
  };
  if (config.liveState?.enabled === false || config.liveState?.readExchange === false) {
    liveState.available = false;
    liveState.errors.push({ scope: 'liveState', message: 'live state read disabled in config' });
    return liveState;
  }
  let client;
  try {
    client = new BitgetClient();
  } catch (err) {
    liveState.available = false;
    liveState.errors.push({ scope: 'bitgetClient', message: err.message || String(err) });
    return liveState;
  }
  try {
    const positions = await client.get('/api/v2/mix/position/all-position', { productType, marginCoin });
    liveState.positions = listFromResponse(positions).filter(p => !symbol || p.symbol === symbol).filter(p => positionSize(p) > 0);
  } catch (err) {
    liveState.errors.push({ scope: 'positions', message: err.message || String(err) });
  }
  try {
    const regular = await client.get('/api/v2/mix/order/orders-pending', { symbol, productType });
    liveState.regularOrders = listFromResponse(regular);
  } catch (err) {
    liveState.errors.push({ scope: 'regularOrders', message: err.message || String(err) });
  }
  for (const planType of ['profit_loss', 'track_plan']) {
    try {
      const plans = await client.get('/api/v2/mix/order/orders-plan-pending', { symbol, productType, planType });
      liveState.planOrders.push(...listFromResponse(plans).map(p => ({ ...p, planType: p.planType || planType })));
    } catch (err) {
      liveState.errors.push({ scope: `planOrders:${planType}`, message: err.message || String(err) });
    }
  }
  const classified = classifyLiveOrders(config, liveState.regularOrders, liveState.planOrders);
  liveState.ladderOrders = classified.ladderOrders;
  liveState.c100Orders = classified.c100Orders;
  liveState.positionSize = liveState.positions.reduce((sum, p) => sum + positionSize(p), 0);
  const hasPosition = liveState.positionSize > 0;
  if (liveState.errors.length) liveState.ladder_status = 'ladder status unknown';
  else if (liveState.ladderOrders.length && hasPosition) liveState.ladder_status = 'ladder partially filled';
  else if (liveState.ladderOrders.length) liveState.ladder_status = 'ladder open/unfilled';
  else if (hasPosition && config.liveState?.positionImpliesFilledLadder !== false) liveState.ladder_status = 'ladder fully filled';
  else liveState.ladder_status = 'no live ladder found';
  const explicitC100 = config.c100Active === true || config.c100PlanActive === true || config.c100?.active === true;
  if (liveState.errors.length && !explicitC100 && !liveState.c100Orders.length) liveState.c100_status = 'C100 status unknown';
  else if (explicitC100 || liveState.c100Orders.length) liveState.c100_status = 'C100 plan/order active';
  else liveState.c100_status = 'no C100 plan/order active';
  return liveState;
}
function resolveExecutionMode(config = {}, liveState = {}) {
  const explicit = upper(config.execution_mode || config.executionMode || '');
  const allowed = new Set(['PURE_VOCO', 'HYBRID_VOCO', 'HYBRID_C100']);
  if (explicit) {
    return allowed.has(explicit)
      ? { execution_mode: explicit, execution_mode_source: 'user_specified', reason: 'execution_mode supplied in config' }
      : { execution_mode: 'UNKNOWN', execution_mode_source: 'unknown', reason: `unsupported execution_mode: ${explicit}` };
  }
  const ladder = liveState.ladder_status || 'ladder status unknown';
  const c100 = liveState.c100_status || 'C100 status unknown';
  if (/unknown/i.test(ladder) || /unknown/i.test(c100)) return { execution_mode: 'UNKNOWN', execution_mode_source: 'unknown', reason: `${ladder}; ${c100}` };
  if (/active/i.test(c100)) return { execution_mode: 'HYBRID_C100', execution_mode_source: 'inferred_c100_active', reason: c100 };
  if (/no live ladder/i.test(ladder)) return { execution_mode: 'PURE_VOCO', execution_mode_source: 'inferred_no_live_ladder', reason: ladder };
  return { execution_mode: 'HYBRID_VOCO', execution_mode_source: 'inferred_live_ladder', reason: ladder };
}
function riskModeForExecution(executionMode) {
  return executionMode === 'HYBRID_C100' ? 'combined total risk for HYBRID_C100' : 'alternative risk for PURE_VOCO/HYBRID_VOCO';
}
function metadataBlock(config = {}, ctx = {}, selected = null, blockedFamily = 'none') {
  const mode = ctx.executionModeInfo || {};
  const live = ctx.liveState || {};
  return `execution_mode: ${mode.execution_mode || 'UNKNOWN'}
execution_mode_source: ${mode.execution_mode_source || 'unknown'}
execution_mode_reason: ${mode.reason || 'n/a'}
risk_cap_usd: ${fmt(ctx.riskCapUsd ?? resolveRiskCapUsd(config), 2)}
ladder_status: ${live.ladder_status || 'unknown'}
c100_status: ${live.c100_status || 'unknown'}
triggered_family: ${selected ? familyLabel(selected.family) : 'none'}
blocked_or_coexisting_family: ${blockedFamily || 'none'}
risk_mode: ${riskModeForExecution(mode.execution_mode)}`;
}
function formatModeUnclear(config, ctx) {
  return `VIRTUAL OCO ALERT — MANUAL REVIEW REQUIRED

OCO group: ${config.ocoGroupId}
Symbol: ${config.symbol}
${metadataBlock(config, ctx)}

Execution mode unclear. VOCO requires clear mode inference: PURE_VOCO, HYBRID_VOCO, or HYBRID_C100. Manual review required.
Do not place the prepared ticket until mode and risk are verified.

Live-state errors:
${(ctx.liveState?.errors || []).map(e => `- ${e.scope}: ${e.message}`).join('\n') || '- none'}

Action:
Review this proposal. If accepted, handle the order through the normal live-order tool/workflow. This watchdog did not place or cancel any live order.`;
}
function formatManualReview(config, ctx, selected, blockedFamily, title, details = []) {
  return `VIRTUAL OCO ALERT — MANUAL REVIEW REQUIRED

OCO group: ${config.ocoGroupId}
Symbol: ${config.symbol}
${metadataBlock(config, ctx, selected, blockedFamily)}

${title}
${details.length ? `\n${details.map(d => `- ${d}`).join('\n')}` : ''}

Action:
Review this proposal. If accepted, handle the order through the normal live-order tool/workflow. This watchdog did not place or cancel any live order.`;
}
function isBreakoutResult(result) {
  const letter = familyLetter(result?.family);
  const style = upper(result?.family?.style);
  return result?.kind === 'breakout' || letter === 'C' || style === 'BREAKOUT' || style === 'BREAKDOWN';
}
function c100RiskSummary(config = {}, ctx = {}, selected = null) {
  const riskCapUsd = ctx.riskCapUsd ?? resolveRiskCapUsd(config);
  const c100 = config.c100 || {};
  const pullbacks = [];
  if (config.pullbackFamily) pullbacks.push(config.pullbackFamily);
  if (Array.isArray(config.pullbackFamilies)) pullbacks.push(...config.pullbackFamilies);
  const preparedLadderRisk = num(c100.plannedLadderRiskUsd ?? c100.ladderRiskUsd, NaN);
  const ladderRisk = Number.isFinite(preparedLadderRisk)
    ? preparedLadderRisk
    : pullbacks.map(familyPlannedRisk).reduce((sum, v) => Number.isFinite(sum) && Number.isFinite(v) ? sum + v : NaN, 0);
  const proposedCRisk = num(c100.proposedCRiskUsd ?? c100.cRiskUsd, Number.isFinite(familyPlannedRisk(selected?.family)) ? familyPlannedRisk(selected.family) : NaN);
  const live = ctx.liveState || {};
  const filledRisk = num(c100.currentFilledLadderRiskUsd ?? config.liveState?.currentFilledLadderRiskUsd, NaN);
  const remainingRisk = num(c100.remainingLadderRiskUsd ?? config.liveState?.remainingLadderRiskUsd, NaN);
  let totalRisk = NaN;
  if (/partially/i.test(live.ladder_status || '')) {
    totalRisk = Number.isFinite(filledRisk) && Number.isFinite(remainingRisk) && Number.isFinite(proposedCRisk)
      ? filledRisk + remainingRisk + proposedCRisk
      : NaN;
  } else {
    totalRisk = Number.isFinite(ladderRisk) && Number.isFinite(proposedCRisk) ? ladderRisk + proposedCRisk : NaN;
  }
  const blendedRr = num(c100.blendedRr ?? c100.combinedRr, NaN);
  const minBlendedRr = num(c100.minBlendedRr ?? config.minBlendedRr, NaN);
  const combinedMargin = num(c100.combinedMarginUsd ?? c100.marginUsd, NaN);
  const combinedLeverage = num(c100.maxLeverage ?? c100.leverage, NaN);
  const checks = [
    { name: 'risk cap', ok: Number.isFinite(totalRisk) && totalRisk <= riskCapUsd + 1e-9, value: `${fmt(totalRisk, 2)} <= ${fmt(riskCapUsd, 2)}` },
    { name: 'shared invalidation valid', ok: c100.sharedInvalidationValid !== false, value: String(c100.sharedInvalidationValid !== false) },
    { name: 'blended RR acceptable', ok: !Number.isFinite(minBlendedRr) || (Number.isFinite(blendedRr) && blendedRr >= minBlendedRr - 1e-9), value: Number.isFinite(minBlendedRr) ? `${fmt(blendedRr, 2)} >= ${fmt(minBlendedRr, 2)}` : 'not specified' },
    { name: 'margin pass', ok: !Number.isFinite(combinedMargin) || combinedMargin <= num(config.maxMarginUsdt, 1500) + 1e-9, value: Number.isFinite(combinedMargin) ? `${fmt(combinedMargin, 2)} <= ${fmt(num(config.maxMarginUsdt, 1500), 2)}` : 'not specified' },
    { name: 'leverage pass', ok: !Number.isFinite(combinedLeverage) || combinedLeverage <= num(config.maxLeverage, 20) + 1e-9, value: Number.isFinite(combinedLeverage) ? `${fmt(combinedLeverage, 2)} <= ${fmt(num(config.maxLeverage, 20), 2)}` : 'not specified' },
    { name: 'liquidation-distance sanity pass', ok: c100.liquidationPass !== false && c100.liquidationDistanceSane !== false, value: String(c100.liquidationPass !== false && c100.liquidationDistanceSane !== false) },
  ];
  return { riskCapUsd, ladderRisk, proposedCRisk, filledRisk, remainingRisk, totalRisk, checks, ok: checks.every(c => c.ok) };
}
function c100Lines(summary) {
  return [
    'C100 check:',
    `risk cap: ${fmt(summary.riskCapUsd, 2)}`,
    `planned ladder risk: ${fmt(summary.ladderRisk, 2)}`,
    `proposed C risk: ${fmt(summary.proposedCRisk, 2)}`,
    `total all-filled risk: ${fmt(summary.totalRisk, 2)}`,
    `combined risk <= risk cap: ${summary.checks.find(c => c.name === 'risk cap')?.ok ? 'YES' : 'NO'}`,
    `shared invalidation valid: ${summary.checks.find(c => c.name === 'shared invalidation valid')?.ok ? 'YES' : 'NO'}`,
    `blended RR acceptable: ${summary.checks.find(c => c.name === 'blended RR acceptable')?.ok ? 'YES' : 'NO'}`,
    `margin/leverage/liquidation pass: ${summary.checks.filter(c => ['margin pass', 'leverage pass', 'liquidation-distance sanity pass'].includes(c.name)).every(c => c.ok) ? 'YES' : 'NO'}`,
  ];
}
function modeDecision(config, ctx, selected, blockedFamily) {
  const mode = ctx.executionModeInfo?.execution_mode || 'UNKNOWN';
  const live = ctx.liveState || {};
  const ladderStatus = live.ladder_status || 'unknown';
  const selectedIsC = isBreakoutResult(selected);
  if (mode === 'UNKNOWN') {
    return { message: formatModeUnclear(config, ctx), status: 'ALERTED' };
  }
  if (mode === 'PURE_VOCO' && !/no live ladder/i.test(ladderStatus)) {
    return {
      message: formatManualReview(config, ctx, selected, blockedFamily, 'Live ladder detected although mode is PURE_VOCO. Mode should be HYBRID_VOCO unless this is a mistake. Manual review required.'),
      status: 'ALERTED',
    };
  }
  if (mode === 'HYBRID_VOCO' && selectedIsC) {
    if (/partially/i.test(ladderStatus)) {
      return {
        message: formatManualReview(config, ctx, selected, blockedFamily, 'HYBRID_VOCO: C triggered but ladder is partially filled. Manual review required.', [
          `filled ladder risk: ${fmt(config.liveState?.currentFilledLadderRiskUsd, 2)}`,
          `remaining live ladder risk: ${fmt(config.liveState?.remainingLadderRiskUsd, 2)}`,
          `proposed C risk: ${fmt(familyPlannedRisk(selected.family), 2)}`,
          'C may exceed intended risk unless resized or ladder exposure is handled.',
        ]),
        status: 'ALERTED',
      };
    }
    if (/fully/i.test(ladderStatus)) {
      return {
        message: formatManualReview(config, ctx, selected, blockedFamily, 'C trigger occurred, but ladder position is already active. Treat C as add-on/position-review only, not standalone VOCO entry.'),
        status: 'ALERTED',
      };
    }
    if (/open\/unfilled/i.test(ladderStatus)) {
      return { extraLines: ['HYBRID_VOCO: C triggered while ladder orders may still be live. A/B and C are alternatives. Cancel/block ladder before accepting C.', 'Action warning: ladder must be cancelled/blocked before accepting C, unless user deliberately converts plan to C100 after new analysis.'] };
    }
  }
  if (mode === 'HYBRID_C100' && selectedIsC) {
    const c100Active = /active/i.test(live.c100_status || '') || config.c100Approved === true || config.c100?.approved === true;
    const summary = c100RiskSummary(config, ctx, selected);
    if (!c100Active) {
      return { message: formatManualReview(config, ctx, selected, blockedFamily, 'C100 risk cannot be verified — refresh required.', ['HYBRID_C100 requires original analysis approval (`c100Approved: true`) or active C100 plan/order.']), status: 'ALERTED' };
    }
    if (!summary.ok) {
      return { message: formatManualReview(config, ctx, selected, blockedFamily, 'C100 risk check failed — refresh/resize required.', c100Lines(summary)), status: 'ALERTED' };
    }
    return { extraLines: ['HYBRID_C100: ladder may remain live because combined all-filled risk is being checked as one plan.', ...c100Lines(summary)] };
  }
  return { extraLines: [] };
}
async function fetchContext(config) {
  const cfg = getDefaultTradingConfig();
  const client = new BitgetClient();
  const symbol = upper(String(config.symbol || '').replace('BITGET:', '').replace('.P', ''));
  if (!symbol) throw new Error('config.symbol is required');
  const productType = config.productType || config.marketType || cfg.productType;
  const mainTf = upper(config.mainTf || config.mainTF || '4H');
  const checkTf = upper(config.checkTf || (config.requiresOneHourConfirmation ? '1H' : mainTf));
  const nowMs = Date.now();
  const delayMs = num(config.checkDelayMinutes, 2) * 60 * 1000;
  const wantedTfs = Array.from(new Set([mainTf, checkTf, '4H']));
  const tickerRaw = await client.get('/api/v2/mix/market/ticker', { symbol, productType });
  const candlesByTf = {};
  for (const tf of wantedTfs) {
    const raw = await client.get('/api/v2/mix/market/candles', { symbol, productType, granularity: tf, limit: String(config.candleLimit || 120) });
    candlesByTf[tf] = rows(raw).map(candle).sort((a, b) => a.ts - b.ts);
  }
  const ticker = asTicker(tickerRaw);
  const currentPrice = num(ticker.lastPr || ticker.markPrice || ticker.indexPrice);
  const mainClosed = latestClosed(candlesByTf[mainTf], mainTf, nowMs, delayMs);
  const checkClosed = latestClosed(candlesByTf[checkTf], checkTf, nowMs, delayMs);
  if (!mainClosed || !checkClosed) throw new Error('No fully closed candle available for configured timeframe/check delay');
  const ctx = {
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
    symbol,
    productType,
    mainTf,
    checkTf,
    currentPrice,
    ticker,
    mainClosed,
    checkClosed,
    prevMainClosed: prevClosed(candlesByTf[mainTf], mainClosed),
    prevCheckClosed: prevClosed(candlesByTf[checkTf], checkClosed),
    atr4h: atr(candlesByTf['4H'], latestClosed(candlesByTf['4H'], '4H', nowMs, delayMs), 14),
    candlesByTf,
  };
  return ctx;
}
async function evaluate(config, args = {}) {
  const groupId = config.ocoGroupId || config.groupId;
  if (!groupId) throw new Error('config.ocoGroupId is required');
  const statePath = path.resolve(args.state || config.statePath || path.join(DEFAULT_OUT_DIR, `${safeName(groupId)}.state.json`));
  const state = loadJsonFallback(statePath, { status: 'ARMED', ocoGroupId: groupId, createdAt: new Date().toISOString() });
  const mode = args.mode || 'main';
  const updateState = args.updateState !== 'false';

  if (mode === 'status') return { status: 'STATUS', statePath, state, enabled: config.enabled !== false };
  if (config.enabled === false) return { status: 'DISABLED', message: 'NO_REPLY', statePath, state };
  if (mode === 'rearm') {
    const next = { status: 'ARMED', ocoGroupId: groupId, rearmedAt: new Date().toISOString(), prior: state };
    if (updateState) saveJson(statePath, next);
    return { status: 'REARMED', statePath, state: next };
  }
  if (mode === 'disarm') {
    state.status = 'DISARMED'; state.disarmedAt = new Date().toISOString();
    if (updateState) saveJson(statePath, state);
    return { status: 'DISARMED', statePath, state };
  }
  if (!['ARMED', undefined, null].includes(state.status) && args.force !== 'true') {
    return { status: 'NO_REPLY', reason: `watchdog already ${state.status}`, statePath, state };
  }

  const ctx = await fetchContext(config);
  ctx.riskCapUsd = resolveRiskCapUsd(config);
  ctx.liveState = await collectLiveState(config, ctx);
  ctx.executionModeInfo = resolveExecutionMode(config, ctx.liveState);
  const expiry = Date.parse(config.expiryUtc || config.watchdogExpiry || '');
  if (Number.isFinite(expiry) && ctx.nowMs >= expiry) {
    state.status = 'EXPIRED'; state.expiredAt = ctx.nowIso;
    const message = formatExpired(config, ctx);
    state.lastMessage = message;
    if (updateState) saveJson(statePath, state);
    return { status: 'EXPIRED', message, statePath };
  }

  const invalidations = checkInvalidation(config, ctx).filter(x => x.invalidated);
  if (invalidations.length) {
    state.status = 'INVALIDATED'; state.invalidatedAt = ctx.nowIso; state.invalidations = invalidations;
    const reason = invalidations.map(x => `${x.name}: ${x.value}`).join('; ');
    const message = formatInvalidated(config, ctx, reason, invalidations[0]?.name);
    state.lastMessage = message;
    if (updateState) saveJson(statePath, state);
    return { status: 'INVALIDATED', message, invalidations, statePath };
  }

  if (ctx.executionModeInfo.execution_mode === 'UNKNOWN') {
    const message = formatModeUnclear(config, ctx);
    state.status = 'ALERTED';
    state.alertedAt = ctx.nowIso;
    state.triggeredFamily = 'none';
    state.blockedFamily = 'manual review required';
    state.lastMessage = message;
    state.executionModeInfo = ctx.executionModeInfo;
    state.liveState = ctx.liveState;
    if (updateState) saveJson(statePath, state);
    return { status: 'ALERTED', message, statePath, executionModeInfo: ctx.executionModeInfo, liveState: ctx.liveState };
  }

  const feedbackEveryCheck = config.feedbackOnEveryCheck === true || config.printFeedbackEveryCheck === true || args.feedback === 'true';
  if (state.lastCheckedCandleStartMs === ctx.checkClosed.ts && args.force !== 'true') {
    const priorResults = state.lastResults || [];
    const message = feedbackEveryCheck
      ? formatCheckFeedback(config, ctx, priorResults.map(r => ({ family: { family: r.family }, triggered: r.triggered, gates: r.gates || [] })), 'this closed check candle was already evaluated')
      : 'NO_REPLY';
    return { status: feedbackEveryCheck ? 'CHECKED_ALREADY' : 'NO_REPLY', message, reason: 'this closed check candle was already evaluated', statePath };
  }

  const families = [];
  if (config.pullbackFamily) families.push(config.pullbackFamily);
  if (Array.isArray(config.pullbackFamilies)) families.push(...config.pullbackFamilies);
  if (config.breakoutFamily) families.push(config.breakoutFamily);
  if (Array.isArray(config.breakoutFamilies)) families.push(...config.breakoutFamilies);
  if (!families.length) throw new Error('At least one pullbackFamily or breakoutFamily is required');

  const results = families.map(f => {
    const letter = familyLetter(f);
    const style = upper(f.style);
    const isBreakout = letter === 'C' || style === 'BREAKOUT' || style === 'BREAKDOWN';
    return isBreakout ? checkBreakoutFamily(f, ctx, config) : checkPullbackFamily(f, ctx, config);
  });
  const choice = chooseTriggered(results, config);

  state.lastCheckedAt = ctx.nowIso;
  state.lastCheckedCandleStartMs = ctx.checkClosed.ts;
  state.lastResults = results.map(r => ({ family: familyLabel(r.family), triggered: r.triggered, gates: r.gates }));

  if (!choice) {
    state.status = 'ARMED'; state.lastStatus = 'NO_TRIGGER';
    if (updateState) saveJson(statePath, state);
    const message = feedbackEveryCheck ? formatCheckFeedback(config, ctx, results) : 'NO_REPLY';
    return { status: feedbackEveryCheck ? 'CHECKED' : 'NO_TRIGGER', message, statePath, results };
  }

  const selected = choice.selected;
  const selectedIsC = isBreakoutResult(selected);
  const blocked = ctx.executionModeInfo.execution_mode === 'HYBRID_C100' && selectedIsC
    ? 'A/B ladder may coexist under HYBRID_C100 if checks pass'
    : (families.filter(f => f !== selected.family).map(familyLabel).join(', ') || 'none');
  const decision = modeDecision(config, ctx, selected, blocked);
  const message = decision.message || formatTicket(selected.family, selected, config, ctx, blocked, decision.extraLines || []);
  state.status = 'ALERTED';
  state.alertedAt = ctx.nowIso;
  state.triggeredFamily = familyLabel(selected.family);
  state.blockedFamily = blocked;
  state.bothPassed = choice.alsoPassed.map(r => familyLabel(r.family));
  state.selectionReason = choice.reason || null;
  state.lastMessage = message;
  state.executionModeInfo = ctx.executionModeInfo;
  state.liveState = ctx.liveState;
  if (updateState) saveJson(statePath, state);
  return { status: 'ALERTED', message, statePath, selected: familyLabel(selected.family), blocked, bothPassed: state.bothPassed, results };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) throw new Error('Usage: node scripts/virtual_oco_watchdog.js --config watchdog/virtual_oco/example.json [--send true] [--json]');
  const config = loadJson(path.resolve(args.config));
  const result = await evaluate(config, args);
  if (args.send === 'true' && ['ALERTED', 'INVALIDATED', 'EXPIRED'].includes(result.status)) {
    sendDiscord(result.message, config);
    result.sentDiscord = true;
  }
  const cronCancellation = maybeCancelCronAfterTerminal(result, config, args);
  if (cronCancellation) result.cronCancellation = cronCancellation;
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (['ALERTED', 'INVALIDATED', 'EXPIRED', 'CHECKED', 'CHECKED_ALREADY'].includes(result.status)) console.log(result.message);
  else console.log('NO_REPLY');
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
