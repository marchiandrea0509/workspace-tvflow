const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/cli');
const {
  validateBasicPlan,
  collectReadOnlyState,
  buildAuditRecord,
  writeAuditRecord,
} = require('../lib/executionService');

function readJson(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  return {
    absolute,
    value: JSON.parse(fs.readFileSync(absolute, 'utf8')),
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plan) throw new Error('Missing --plan <execution-plan.json>');
  if (args.send || args.live) throw new Error('Phase 1 execution-service-dry-run refuses --send/--live.');

  const { absolute: planPath, value: plan } = readJson(args.plan);
  const validation = validateBasicPlan(plan, { allowUnknownActions: Boolean(args.allowUnknownActions) });

  let readOnlyState = null;
  if (args.readLive) {
    readOnlyState = await collectReadOnlyState({
      symbol: validation.symbol,
      productType: validation.productType,
      marginCoin: validation.marginCoin,
      includePlans: args.includePlans !== 'false',
    });
  }

  const audit = buildAuditRecord({
    plan,
    validation,
    readOnlyState,
    requestSource: { planPath },
    notes: args.notes || '',
  });
  const auditPath = writeAuditRecord(audit, {
    outputDir: args.outputDir,
    outputPath: args.output,
  });

  console.log(JSON.stringify({
    ok: audit.result === 'accepted_dry_run',
    result: audit.result,
    auditId: audit.auditId,
    auditPath,
    summary: validation.summary,
    hardBlocks: validation.hardBlocks,
    warnings: validation.warnings,
    info: validation.info,
    readLive: Boolean(args.readLive),
    readOnlyErrors: readOnlyState?.errors || [],
  }, null, 2));
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
