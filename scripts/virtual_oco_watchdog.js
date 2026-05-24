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
function ticketRiskChecks(ticket = {}, cfg = {}) {
  const maxRisk = num(cfg.maxPlannedRiskUsdt, 100);
  const maxMargin = num(cfg.maxMarginUsdt, 1500);
  const maxLeverage = num(cfg.maxLeverage, 20);
  const minRr = num(ticket.minRr ?? cfg.minRr, NaN);
  const checks = [];
  checks.push({ name: 'risk <= max', ok: !Number.isFinite(num(ticket.plannedRisk, NaN)) || num(ticket.plannedRisk) <= maxRisk + 1e-9, value: `${fmt(ticket.plannedRisk, 2)} <= ${fmt(maxRisk, 2)}` });
  checks.push({ name: 'margin <= max', ok: !Number.isFinite(num(ticket.margin, NaN)) || num(ticket.margin) <= maxMargin + 1e-9, value: `${fmt(ticket.margin, 2)} <= ${fmt(maxMargin, 2)}` });
  checks.push({ name: 'leverage <= max', ok: !Number.isFinite(num(ticket.leverage, NaN)) || num(ticket.leverage) <= maxLeverage + 1e-9, value: `${fmt(ticket.leverage, 2)} <= ${fmt(maxLeverage, 2)}` });
  checks.push({ name: 'RR >= minimum', ok: !Number.isFinite(minRr) || num(ticket.rr, -Infinity) >= minRr - 1e-9, value: `${fmt(ticket.rr, 2)} >= ${fmt(minRr, 2)}` });
  if (ticket.structuralValid === false) checks.push({ name: 'SL structural validity', ok: false, value: 'ticket.structuralValid=false' });
  if (ticket.tpOpenSpaceValid === false) checks.push({ name: 'TP open space', ok: false, value: 'ticket.tpOpenSpaceValid=false' });
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
  const confirmations = checkConfirmations(family, ctx);
  const ticketChecks = ticketRiskChecks(family.ticket || family, config);
  const chase = checkStaleness(family, ctx, { min: trigger, max: trigger });
  const rejection = family.rejectIfImmediateRangeRejection === false ? [] : checkGenericConditions(family.noImmediateRejectionConditions || [], ctx);
  const gates = [
    { name: 'breakout/breakdown trigger crossed', ok: crossed, value: reason },
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
function formatTicket(family, selected, config, ctx, blockedFamily) {
  const checkTime = selected ? new Date(ctx.checkClosed.ts).toISOString() : 'n/a';
  const status = selected?.triggered ? 'PASSED' : 'FAILED';
  const gateSummary = selected?.gates || [];
  return `VIRTUAL OCO ALERT — TRADE PROPOSAL READY

OCO group: ${config.ocoGroupId}
Symbol: ${config.symbol}
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

Action:
Review this ticket. If accepted, place it using the normal live-order tool. This watchdog did not place any live order.`;
}
function formatInvalidated(config, ctx, reason, failedGate) {
  return `VIRTUAL OCO INVALIDATED

OCO group: ${config.ocoGroupId}
Symbol: ${config.symbol}
Reason: ${reason}
Current price: ${fmt(ctx?.currentPrice)}
Failed gate: ${failedGate || reason}
Action:
Do not place the prepared ticket. Refresh the chart analysis if still interested.`;
}
function formatExpired(config) {
  return `VIRTUAL OCO EXPIRED

OCO group: ${config.ocoGroupId}
Symbol: ${config.symbol}
Expiry time: ${config.expiryUtc || config.watchdogExpiry}
No valid trigger occurred.
Action:
Refresh the analysis before considering a new ticket.`;
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
  const expiry = Date.parse(config.expiryUtc || config.watchdogExpiry || '');
  if (Number.isFinite(expiry) && ctx.nowMs >= expiry) {
    state.status = 'EXPIRED'; state.expiredAt = ctx.nowIso;
    const message = formatExpired(config);
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

  if (state.lastCheckedCandleStartMs === ctx.checkClosed.ts && args.force !== 'true') {
    return { status: 'NO_REPLY', reason: 'this closed check candle was already evaluated', statePath };
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
    return { status: 'NO_TRIGGER', message: 'NO_REPLY', statePath, results };
  }

  const selected = choice.selected;
  const blocked = families.filter(f => f !== selected.family).map(familyLabel).join(', ') || 'none';
  const message = formatTicket(selected.family, selected, config, ctx, blocked);
  state.status = 'ALERTED';
  state.alertedAt = ctx.nowIso;
  state.triggeredFamily = familyLabel(selected.family);
  state.blockedFamily = blocked;
  state.bothPassed = choice.alsoPassed.map(r => familyLabel(r.family));
  state.selectionReason = choice.reason || null;
  state.lastMessage = message;
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
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (['ALERTED', 'INVALIDATED', 'EXPIRED'].includes(result.status)) console.log(result.message);
  else console.log('NO_REPLY');
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
