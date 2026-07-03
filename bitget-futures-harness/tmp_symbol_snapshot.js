#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const symbols = process.argv.slice(2);
function run(args){
  const r = spawnSync(process.execPath, args, { encoding:'utf8', cwd: process.cwd(), env: process.env });
  if (r.status !== 0) return { error: (r.stderr||r.stdout||'').slice(0,1000), status:r.status };
  try { return JSON.parse(r.stdout); } catch { return { parseError:r.stdout.slice(0,1000) }; }
}
for (const symbol of symbols) {
  const orders = run(['scripts/list-open-orders.js','--symbol',symbol,'--includePlan','true']);
  const regular = Array.isArray(orders.regular) ? orders.regular.map(o => ({symbol:o.symbol, orderId:o.orderId, clientOid:o.clientOid, status:o.status, side:o.side, size:o.size, filled:o.baseVolume, price:o.price, leverage:o.leverage, marginMode:o.marginMode, sl:o.presetStopLossPrice, tp:o.presetStopSurplusPrice, cTime:o.cTime})) : [];
  const plan = Array.isArray(orders.plan) ? orders.plan.map(o => ({symbol:o.symbol, orderId:o.orderId, clientOid:o.clientOid, planType:o.planType, status:o.status, side:o.side, size:o.size, price:o.price, triggerPrice:o.triggerPrice})) : [];
  console.log(JSON.stringify({ symbol, regularCount: orders.regularCount, planCount: orders.planCount, regular, plan, error: orders.error }, null, 2));
}
