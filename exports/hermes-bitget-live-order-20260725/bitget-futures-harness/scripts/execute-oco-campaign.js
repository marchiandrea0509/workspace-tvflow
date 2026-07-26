const fs = require('fs');
const path = require('path');
const { BitgetClient, assertPlacementAllowed } = require('../lib/bitgetClient');
const { parseArgs, pickDefined } = require('../lib/cli');

function asList(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  return [];
}

function getPrefix(config, branchKey) {
  return config.branches?.[branchKey]?.clientOidPrefix || `${config.campaignId}_${branchKey}_`;
}

function normalizeCampaign(raw) {
  const campaign = JSON.parse(JSON.stringify(raw));
  if (!campaign.symbol) throw new Error('Campaign config missing symbol');
  if (!campaign.productType) campaign.productType = 'USDT-FUTURES';
  if (!campaign.marginCoin) campaign.marginCoin = 'USDT';
  if (!campaign.marginMode) campaign.marginMode = 'isolated';
  if (!campaign.leverage) campaign.leverage = '3';
  if (!campaign.campaignId) campaign.campaignId = `oco_${campaign.symbol.toLowerCase()}_${Date.now()}`;
  for (const branchKey of ['A', 'B']) {
    const branch = campaign.branches?.[branchKey];
    if (!branch) throw new Error(`Campaign missing branch ${branchKey}`);
    if (!Array.isArray(branch.orders) || !branch.orders.length) throw new Error(`Branch ${branchKey} has no orders`);
    if (!branch.clientOidPrefix) branch.clientOidPrefix = `${campaign.campaignId}_${branchKey}_`;
  }
  return campaign;
}

function withClientOids(campaign, branchKey) {
  return campaign.branches[branchKey].orders.map((order, i) => ({
    ...order,
    clientOid: order.clientOid || `${getPrefix(campaign, branchKey)}${i + 1}`,
  }));
}

function buildPlan(campaign) {
  return {
    A: withClientOids(campaign, 'A'),
    B: withClientOids(campaign, 'B'),
  };
}

function branchMatches(orders, prefix) {
  return orders.filter((o) => String(o.clientOid || '').startsWith(prefix));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

async function listPending(client, campaign) {
  const regularRes = await client.get('/api/v2/mix/order/orders-pending', {
    symbol: campaign.symbol,
    productType: campaign.productType,
  });
  const planRes = await client.get('/api/v2/mix/order/orders-plan-pending', {
    symbol: campaign.symbol,
    productType: campaign.productType,
    planType: 'normal_plan',
  });

  return {
    regular: asList(regularRes),
    plan: asList(planRes),
  };
}

function summarizePending(campaign, pending) {
  const prefixes = {
    A: getPrefix(campaign, 'A'),
    B: getPrefix(campaign, 'B'),
  };
  return {
    A: {
      regularPending: branchMatches(pending.regular, prefixes.A).length,
      planPending: branchMatches(pending.plan, prefixes.A).length,
      configuredRegular: campaign.branches.A.orders.filter((o) => !o.triggerPrice).length,
      configuredPlan: campaign.branches.A.orders.filter((o) => o.triggerPrice).length,
    },
    B: {
      regularPending: branchMatches(pending.regular, prefixes.B).length,
      planPending: branchMatches(pending.plan, prefixes.B).length,
      configuredRegular: campaign.branches.B.orders.filter((o) => !o.triggerPrice).length,
      configuredPlan: campaign.branches.B.orders.filter((o) => o.triggerPrice).length,
    },
  };
}

async function inferActiveBranch(client, campaign) {
  const pending = await listPending(client, campaign);
  const byBranch = summarizePending(campaign, pending);

  const activatedA = (byBranch.A.regularPending + byBranch.A.planPending) < (byBranch.A.configuredRegular + byBranch.A.configuredPlan);
  const activatedB = (byBranch.B.regularPending + byBranch.B.planPending) < (byBranch.B.configuredRegular + byBranch.B.configuredPlan);

  let activeBranch = null;
  if (activatedA && !activatedB) activeBranch = 'A';
  if (activatedB && !activatedA) activeBranch = 'B';
  if (activatedA && activatedB) activeBranch = 'BOTH';

  return { activeBranch, byBranch, pending, checkedAt: nowIso() };
}

async function cancelBranch(client, campaign, branchKey) {
  const prefix = getPrefix(campaign, branchKey);
  const pending = await listPending(client, campaign);
  const targets = [
    ...branchMatches(pending.regular, prefix).map((o) => ({ ...o, __kind: 'regular' })),
    ...branchMatches(pending.plan, prefix).map((o) => ({ ...o, __kind: 'plan' })),
  ];

  const results = [];
  for (const order of targets) {
    if (order.__kind === 'regular') {
      const result = await client.post('/api/v2/mix/order/cancel-order', {
        symbol: campaign.symbol,
        productType: campaign.productType,
        marginCoin: campaign.marginCoin,
        orderId: order.orderId,
      });
      results.push({ kind: 'regular', orderId: order.orderId, clientOid: order.clientOid, result });
      continue;
    }

    const result = await client.post('/api/v2/mix/order/cancel-plan-order', {
      symbol: campaign.symbol,
      productType: campaign.productType,
      marginCoin: campaign.marginCoin,
      planType: 'normal_plan',
      orderId: order.orderId,
    });
    results.push({ kind: 'plan', orderId: order.orderId, clientOid: order.clientOid, result });
  }
  return results;
}

async function placeRegularOrder(client, campaign, order, send) {
  const payload = pickDefined({
    symbol: campaign.symbol,
    productType: campaign.productType,
    marginMode: campaign.marginMode,
    marginCoin: campaign.marginCoin,
    size: order.size,
    price: order.price,
    side: order.side,
    tradeSide: order.tradeSide,
    orderType: order.orderType || 'limit',
    force: order.force || 'gtc',
    reduceOnly: order.reduceOnly,
    clientOid: order.clientOid,
    presetStopSurplusPrice: order.presetStopSurplusPrice,
    presetStopLossPrice: order.presetStopLossPrice,
  });
  if (!send) return { dryRun: true, endpoint: '/api/v2/mix/order/place-order', payload };
  return client.post('/api/v2/mix/order/place-order', payload);
}

async function placeTriggerOrder(client, campaign, order, send) {
  const stopSurplusTriggerPrice = order.stopSurplusTriggerPrice || order.presetStopSurplusPrice;
  const stopLossTriggerPrice = order.stopLossTriggerPrice || order.presetStopLossPrice;
  const payload = pickDefined({
    symbol: campaign.symbol,
    productType: campaign.productType,
    marginMode: campaign.marginMode,
    marginCoin: campaign.marginCoin,
    size: order.size,
    side: order.side,
    tradeSide: order.tradeSide,
    orderType: order.orderType || 'limit',
    price: order.price,
    triggerPrice: order.triggerPrice,
    triggerType: order.triggerType || 'fill_price',
    planType: order.planType || 'normal_plan',
    clientOid: order.clientOid,
    reduceOnly: order.reduceOnly,
    stopSurplusTriggerPrice,
    stopSurplusExecutePrice: order.stopSurplusExecutePrice,
    stopSurplusTriggerType: stopSurplusTriggerPrice ? (order.stopSurplusTriggerType || 'fill_price') : undefined,
    stopLossTriggerPrice,
    stopLossExecutePrice: order.stopLossExecutePrice,
    stopLossTriggerType: stopLossTriggerPrice ? (order.stopLossTriggerType || 'fill_price') : undefined,
  });
  if (!send) return { dryRun: true, endpoint: '/api/v2/mix/order/place-plan-order', payload };
  return client.post('/api/v2/mix/order/place-plan-order', payload);
}

async function armCampaign(client, campaign, send) {
  const plan = buildPlan(campaign);
  const pending = await listPending(client, campaign);
  const existing = new Set([
    ...pending.regular.map((o) => String(o.clientOid || '')),
    ...pending.plan.map((o) => String(o.clientOid || '')),
  ].filter(Boolean));

  if (!send) {
    return {
      dryRun: true,
      plannedOrders: plan,
      existingClientOids: [...existing],
    };
  }

  await client.post('/api/v2/mix/account/set-margin-mode', {
    symbol: campaign.symbol,
    productType: campaign.productType,
    marginCoin: campaign.marginCoin,
    marginMode: campaign.marginMode,
  });

  await client.post('/api/v2/mix/account/set-leverage', {
    symbol: campaign.symbol,
    productType: campaign.productType,
    marginCoin: campaign.marginCoin,
    leverage: String(campaign.leverage),
  });

  const placed = { A: [], B: [] };
  const skipped = { A: [], B: [] };
  for (const branchKey of ['A', 'B']) {
    for (const order of plan[branchKey]) {
      if (existing.has(order.clientOid)) {
        skipped[branchKey].push({ order, reason: 'clientOid already pending' });
        continue;
      }
      const result = order.triggerPrice
        ? await placeTriggerOrder(client, campaign, order, true)
        : await placeRegularOrder(client, campaign, order, true);
      placed[branchKey].push({ order, result });
      existing.add(order.clientOid);
    }
  }
  return { placed, skipped };
}

async function enforceOnce(client, campaign, send) {
  const status = await inferActiveBranch(client, campaign);
  let canceled = [];
  if (send) {
    if (status.activeBranch === 'A') {
      canceled = await cancelBranch(client, campaign, 'B');
    } else if (status.activeBranch === 'B') {
      canceled = await cancelBranch(client, campaign, 'A');
    } else if (status.activeBranch === 'BOTH') {
      canceled = [
        ...(await cancelBranch(client, campaign, 'A')),
        ...(await cancelBranch(client, campaign, 'B')),
      ];
    }
  }
  return { status, canceled };
}

async function monitorCampaign(client, campaign, send, intervalSeconds, maxChecks = 0) {
  let checks = 0;
  while (true) {
    checks += 1;
    const result = await enforceOnce(client, campaign, send);
    console.log(JSON.stringify({
      ok: true,
      action: 'monitor-tick',
      tick: checks,
      checkedAt: result.status.checkedAt,
      intervalSeconds,
      status: result.status,
      canceled: result.canceled,
    }, null, 2));

    if (result.status.activeBranch === 'A' || result.status.activeBranch === 'B' || result.status.activeBranch === 'BOTH') {
      console.log(JSON.stringify({
        ok: true,
        action: 'monitor-stop',
        reason: `branch-${result.status.activeBranch}-activated`,
        tick: checks,
        finishedAt: nowIso(),
      }, null, 2));
      return;
    }

    if (maxChecks > 0 && checks >= maxChecks) {
      console.log(JSON.stringify({
        ok: true,
        action: 'monitor-stop',
        reason: 'max-checks-reached',
        tick: checks,
        finishedAt: nowIso(),
      }, null, 2));
      return;
    }

    await sleep(intervalSeconds * 1000);
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config;
  if (!configPath) throw new Error('Missing --config <campaign-json>');

  const send = Boolean(args.send);
  const wantsArm = Boolean(args.arm);
  const wantsPlan = Boolean(args.plan);
  const wantsEnforceOnce = Boolean(args['enforce-once']);
  const wantsMonitor = Boolean(args.monitor);

  const cfg = assertPlacementAllowed({ send });
  const rawConfig = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), configPath), 'utf8'));
  const campaign = normalizeCampaign(rawConfig);
  const client = new BitgetClient();

  if (wantsPlan || (!wantsArm && !wantsEnforceOnce && !wantsMonitor)) {
    console.log(JSON.stringify({
      mode: send ? 'send' : 'dry-run',
      env: cfg.env,
      campaign,
      plannedOrders: buildPlan(campaign),
      notes: [
        'Arming only happens with --arm --send.',
        'One-shot OCO enforcement happens with --enforce-once --send.',
        'Pure local monitor happens with --monitor --send --intervalSeconds 300.',
        'Monitor exits automatically once one branch activates and the opposite branch is canceled.',
      ],
    }, null, 2));
    if (!wantsArm && !wantsEnforceOnce && !wantsMonitor) return;
  }

  if (wantsArm) {
    const armed = await armCampaign(client, campaign, send);
    console.log(JSON.stringify({ ok: true, action: 'arm', campaignId: campaign.campaignId, ...armed }, null, 2));
  }

  if (wantsEnforceOnce) {
    const result = await enforceOnce(client, campaign, send);
    console.log(JSON.stringify({ ok: true, action: 'enforce-once', ...result }, null, 2));
  }

  if (wantsMonitor) {
    const intervalSeconds = Number(args.intervalSeconds || args.interval || 300);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error('intervalSeconds must be a positive number');
    }
    const maxChecks = Number(args.maxChecks || 0);
    await monitorCampaign(client, campaign, send, intervalSeconds, Number.isFinite(maxChecks) ? maxChecks : 0);
  }
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
