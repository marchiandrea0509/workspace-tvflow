const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BitgetClient, getDefaultTradingConfig } = require('./bitgetClient');

const SERVICE_VERSION = 'execution_service_phase1_dry_run_v0';

const GATE_STATUS = Object.freeze({
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  RED: 'RED',
  HARD_BLOCK: 'HARD_BLOCK',
});

const OVERRIDE_POLICY = Object.freeze({
  GREEN: {
    overrideable: false,
    description: 'No override needed.',
  },
  YELLOW: {
    overrideable: true,
    requiresReason: true,
    description: 'Warning gate; can proceed only with explicit reason.',
  },
  RED: {
    overrideable: true,
    requiresReason: true,
    description: 'Normally blocked risk/liquidity gate; can proceed only with explicit user risk acceptance and reason.',
  },
  HARD_BLOCK: {
    overrideable: false,
    description: 'State-safety or ambiguity block; must be fixed, not overridden.',
  },
});

const LIVE_WRITE_ACTIONS = new Set([
  'place_order',
  'execute_signal',
  'cancel_order',
  'cancel_plan_order',
  'set_leverage',
  'set_margin_mode',
  'set_tpsl',
  'set_tp_trailing_split',
  'modify_order',
  'modify_plan_order',
  'close_position',
]);

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function sanitizeName(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'unknown';
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function listFromResponse(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  if (Array.isArray(data?.orderList)) return data.orderList;
  return [];
}

function addIssue(target, severity, code, message, details = undefined) {
  target.push({ severity, code, message, ...(details === undefined ? {} : { details }) });
}

function classifyAction(plan) {
  const action = String(plan.action || plan.type || '').trim();
  return {
    action,
    isKnownLiveWrite: LIVE_WRITE_ACTIONS.has(action),
    isUnknown: !action,
  };
}

function inferSymbol(plan) {
  return plan.symbol || plan.order?.symbol || plan.payload?.symbol || plan.signal?.symbol;
}

function inferProductType(plan, defaults) {
  return plan.productType || plan.order?.productType || plan.payload?.productType || plan.signal?.productType || defaults.productType;
}

function inferMarginCoin(plan, defaults) {
  return plan.marginCoin || plan.order?.marginCoin || plan.payload?.marginCoin || plan.signal?.marginCoin || defaults.marginCoin;
}

function validateBasicPlan(plan, { allowUnknownActions = false } = {}) {
  const hardBlocks = [];
  const warnings = [];
  const info = [];
  const { action, isKnownLiveWrite, isUnknown } = classifyAction(plan);
  const defaults = getDefaultTradingConfig();
  const symbol = inferSymbol(plan);

  if (isUnknown) {
    addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'missing_action', 'Execution plan must include action/type.');
  } else if (!isKnownLiveWrite && !allowUnknownActions) {
    addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'unknown_action', `Unknown execution action: ${action}`);
  }

  if (isKnownLiveWrite && action !== 'execute_signal' && !symbol) {
    addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'missing_symbol', 'Live-write plan must include symbol.');
  }

  if (plan.send === true || plan.mode === 'send' || plan.live === true) {
    addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'phase1_no_live_send', 'Phase 1 execution service is dry-run only and cannot send live writes.');
  }

  if (['place_order', 'execute_signal'].includes(action)) {
    const order = plan.order || plan.payload || plan.signal || plan;
    if (!order.size) addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'missing_size', 'Order plan missing size.');
    if (!order.side) addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'missing_side', 'Order plan missing side buy|sell.');
    if (!order.tradeSide) addIssue(warnings, GATE_STATUS.YELLOW, 'missing_trade_side', 'Order plan missing tradeSide open|close; future live wrapper should require it.');
    if ((order.orderType || 'market') === 'limit' && !order.price) {
      addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'missing_limit_price', 'Limit order plan missing price.');
    }
    if (String(order.tradeSide || '').toLowerCase() === 'open' && !order.presetStopLossPrice && !order.stopLoss && !order.sl) {
      addIssue(warnings, GATE_STATUS.YELLOW, 'missing_stop_loss', 'Risk-bearing open order has no explicit SL in the plan.');
    }
  }

  if (['cancel_order', 'cancel_plan_order', 'modify_order', 'modify_plan_order'].includes(action)) {
    const payload = plan.payload || plan;
    const hasOrderId = payload.orderId || payload.clientOid || payload.clientOrderId || Array.isArray(payload.orderIdList);
    if (!hasOrderId) addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'missing_order_identifier', `${action} requires orderId/clientOid/orderIdList.`);
  }

  if (['set_tp_trailing_split', 'set_tpsl', 'close_position'].includes(action)) {
    const expected = plan.expectedPosition || {};
    const holdSide = plan.holdSide || expected.holdSide || plan.posSide;
    if (!holdSide) addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'missing_expected_hold_side', `${action} must include expected holdSide/expectedPosition.holdSide.`);
    if (action === 'set_tp_trailing_split' && !asArray(plan.legs).length) {
      addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'missing_legs', 'set_tp_trailing_split requires legs[].');
    }
  }

  if (plan.riskGateStatus && !Object.prototype.hasOwnProperty.call(OVERRIDE_POLICY, plan.riskGateStatus)) {
    addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'unknown_risk_gate_status', `Unknown riskGateStatus: ${plan.riskGateStatus}`);
  }

  const riskGateStatus = plan.riskGateStatus || GATE_STATUS.GREEN;
  const override = plan.override || {};
  const overrideLevel = override.level || plan.overrideLevel;
  const overrideReason = override.reason || plan.overrideReason;
  const policy = OVERRIDE_POLICY[riskGateStatus] || OVERRIDE_POLICY.HARD_BLOCK;
  if (policy.overrideable && riskGateStatus !== GATE_STATUS.GREEN) {
    if (overrideLevel !== riskGateStatus || !overrideReason) {
      addIssue(warnings, riskGateStatus, 'override_required', `${riskGateStatus} gate requires explicit override level and reason before any future live send.`, { expectedOverrideLevel: riskGateStatus });
    } else {
      addIssue(info, riskGateStatus, 'override_declared', `${riskGateStatus} override declared for dry-run audit.`, { overrideReason });
    }
  }
  if (riskGateStatus === GATE_STATUS.HARD_BLOCK) {
    addIssue(hardBlocks, GATE_STATUS.HARD_BLOCK, 'risk_gate_hard_block', 'Plan declares HARD_BLOCK risk gate; this cannot be overridden.');
  }

  return {
    action,
    symbol,
    productType: inferProductType(plan, defaults),
    marginCoin: inferMarginCoin(plan, defaults),
    hardBlocks,
    warnings,
    info,
    summary: {
      hardBlockCount: hardBlocks.length,
      warningCount: warnings.length,
      infoCount: info.length,
      phase1DryRunOnly: true,
    },
  };
}

async function collectReadOnlyState({ client = undefined, symbol, productType, marginCoin, includePlans = true } = {}) {
  const defaults = getDefaultTradingConfig();
  const c = client || new BitgetClient();
  const resolvedProductType = productType || defaults.productType;
  const resolvedMarginCoin = marginCoin || defaults.marginCoin;
  const state = {
    positions: null,
    regularOrders: null,
    profitLossPlans: null,
    trackPlans: null,
    errors: [],
  };

  try {
    const positions = await c.get('/api/v2/mix/position/all-position', {
      productType: resolvedProductType,
      marginCoin: resolvedMarginCoin,
    });
    state.positions = listFromResponse(positions).filter((p) => !symbol || p.symbol === symbol);
  } catch (err) {
    state.errors.push({ scope: 'positions', message: err.message || String(err) });
  }

  if (symbol) {
    try {
      const regular = await c.get('/api/v2/mix/order/orders-pending', {
        symbol,
        productType: resolvedProductType,
      });
      state.regularOrders = listFromResponse(regular);
    } catch (err) {
      state.errors.push({ scope: 'regularOrders', message: err.message || String(err) });
    }

    if (includePlans) {
      try {
        const profitLoss = await c.get('/api/v2/mix/order/orders-plan-pending', {
          symbol,
          productType: resolvedProductType,
          planType: 'profit_loss',
        });
        state.profitLossPlans = listFromResponse(profitLoss);
      } catch (err) {
        state.errors.push({ scope: 'profitLossPlans', message: err.message || String(err) });
      }

      try {
        const track = await c.get('/api/v2/mix/order/orders-plan-pending', {
          symbol,
          productType: resolvedProductType,
          planType: 'track_plan',
        });
        state.trackPlans = listFromResponse(track);
      } catch (err) {
        state.errors.push({ scope: 'trackPlans', message: err.message || String(err) });
      }
    }
  }

  return state;
}

function buildAuditRecord({ plan, validation, readOnlyState = null, requestSource = null, notes = '' } = {}) {
  const now = new Date();
  const cfg = getDefaultTradingConfig();
  const auditId = `${utcStamp(now)}_${sanitizeName(validation?.symbol || inferSymbol(plan))}_${sanitizeName(validation?.action || plan?.action)}_${crypto.randomUUID().slice(0, 8)}`;
  return {
    schemaVersion: SERVICE_VERSION,
    auditId,
    createdAt: now.toISOString(),
    mode: 'dry-run',
    phase: 1,
    environment: {
      env: cfg.env,
      papTrading: cfg.papTrading,
      productType: cfg.productType,
      marginCoin: cfg.marginCoin,
    },
    requestSource,
    action: validation?.action || plan?.action || null,
    symbol: validation?.symbol || inferSymbol(plan) || null,
    productType: validation?.productType || null,
    marginCoin: validation?.marginCoin || null,
    overridePolicy: OVERRIDE_POLICY,
    validation,
    readOnlyState,
    plannedBitgetWrites: [],
    bitgetWriteResults: [],
    postcheck: null,
    result: validation?.hardBlocks?.length ? 'blocked_dry_run' : 'accepted_dry_run',
    notes,
    plan,
  };
}

function defaultAuditDir() {
  return path.resolve(__dirname, '..', '..', 'reports', 'live_execution', 'audit');
}

function writeAuditRecord(record, { outputDir = defaultAuditDir(), outputPath = undefined } = {}) {
  const outPath = outputPath
    ? path.resolve(outputPath)
    : path.join(path.resolve(outputDir), `${record.auditId}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return outPath;
}

module.exports = {
  SERVICE_VERSION,
  GATE_STATUS,
  OVERRIDE_POLICY,
  LIVE_WRITE_ACTIONS,
  classifyAction,
  validateBasicPlan,
  collectReadOnlyState,
  buildAuditRecord,
  writeAuditRecord,
  defaultAuditDir,
};
