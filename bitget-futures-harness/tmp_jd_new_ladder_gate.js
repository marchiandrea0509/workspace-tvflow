const fs = require('fs');
const path = require('path');
const { runLiquidityGate, formatGateReport } = require('./lib/liquidityGate');
(async () => {
  const gate = await runLiquidityGate({
    symbol: 'JDUSDT',
    productType: 'USDT-FUTURES',
    side: 'buy',
    maxQty: '360.76',
    positionNotional: '9950.80',
    slPrice: '27.18',
    plannedRiskUsdt: '100.00',
    plannedLeverage: '10',
    basePlannedRiskUsdt: '100',
    sampleCount: '3',
    sampleIntervalMs: '1000'
  });
  const dir = path.join(__dirname, 'reports', 'liquidity_gate');
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, '20260713_jdusdt_new_ladder_10x_gate.json');
  const mdPath = path.join(dir, '20260713_jdusdt_new_ladder_10x_gate.md');
  fs.writeFileSync(jsonPath, JSON.stringify(gate, null, 2));
  fs.writeFileSync(mdPath, formatGateReport(gate));
  console.log(formatGateReport(gate));
  console.log(`\nJSON: ${jsonPath}`);
  console.log(`MD: ${mdPath}`);
})().catch((err) => { console.error(err.stack || err.message || String(err)); process.exit(1); });
