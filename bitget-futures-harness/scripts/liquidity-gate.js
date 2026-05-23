const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/cli');
const { runLiquidityGate, formatGateReport } = require('../lib/liquidityGate');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const symbol = args.symbol;
  const maxQty = args.maxQty || args.size;
  const slPrice = args.slPrice || args.stopLossPrice || args.presetStopLossPrice;
  const positionNotional = args.positionNotional;
  const entryPrice = args.entryPrice || args.price;
  const plannedRiskUsdt = args.plannedRiskUsdt || args.plannedRisk || args.risk;

  if (!symbol) throw new Error('Missing --symbol');
  if (!maxQty) throw new Error('Missing --maxQty');
  if (!slPrice) throw new Error('Missing --slPrice');

  const gate = await runLiquidityGate({
    symbol,
    productType: args.productType,
    side: args.side || args.gateSide,
    holdSide: args.holdSide,
    posSide: args.posSide,
    maxQty,
    positionNotional,
    entryPrice,
    slPrice,
    plannedRiskUsdt,
    includeRaw: Boolean(args.includeRaw),
  });

  console.log(formatGateReport(gate));

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(gate, null, 2));
  }

  if (args.json) {
    console.log(JSON.stringify(gate, null, 2));
  }

  if (args.requireGreen && gate.result !== 'GREEN') {
    process.exitCode = gate.result === 'YELLOW' ? 2 : 3;
  } else if (args.blockRed && gate.result === 'RED') {
    process.exitCode = 3;
  }
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
