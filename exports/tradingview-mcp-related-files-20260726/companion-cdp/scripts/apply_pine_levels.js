#!/usr/bin/env node
const { chromium } = require('playwright');

const PROFILE = '/home/andrea/openclaw/workspace/tradingview/profile';
const SYMBOL = process.argv[2] || 'PAXGUSDT.P';

const PINE = `//@version=5
indicator("PAXG Levels (Mario)", overlay=true)

// Buy levels (green dashed)
hline(5160, "Buy 5160", color=color.new(color.lime, 0), linestyle=hline.style_dashed, linewidth=2)
hline(5030, "Buy 5030", color=color.new(color.lime, 0), linestyle=hline.style_dashed, linewidth=2)
hline(4925, "Buy 4925", color=color.new(color.lime, 0), linestyle=hline.style_dashed, linewidth=2)

// Stop level (red dashed)
hline(4860, "SL 4860", color=color.new(color.red, 0), linestyle=hline.style_dashed, linewidth=2)
`;

async function clickFirst(page, selectors, timeout = 2500) {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click({ timeout });
      return s;
    } catch {}
  }
  return null;
}

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1600, height: 1000 },
    args: ['--disable-dev-shm-usage']
  });

  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(SYMBOL)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000
    });
    await page.waitForTimeout(8000);

    await clickFirst(page, [
      'button:has-text("Accept")',
      'button:has-text("Got it")',
      'button:has-text("No thanks")',
      'button[aria-label="Close"]'
    ], 1000);

    const pineBtn = await clickFirst(page, [
      'button:has-text("Pine Editor")',
      '[role="tab"]:has-text("Pine Editor")',
      'text=Pine Editor'
    ], 6000);

    if (!pineBtn) throw new Error('Could not open Pine Editor tab');
    await page.waitForTimeout(1200);

    // Focus Monaco input area
    const focused = await clickFirst(page, [
      '.monaco-editor',
      '.view-lines',
      'textarea.inputarea'
    ], 5000);
    if (!focused) throw new Error('Could not focus code editor');

    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(PINE, { delay: 1 });
    await page.waitForTimeout(500);

    const addBtn = await clickFirst(page, [
      'button:has-text("Add to chart")',
      'button:has-text("Update on chart")',
      '[data-name="apply-common-tooltip"]',
      'text=Add to chart'
    ], 8000);

    if (!addBtn) throw new Error('Could not click Add to chart');
    await page.waitForTimeout(1500);

    const saveBtn = await clickFirst(page, [
      'button:has-text("Save")',
      '[data-name="save-script"]',
      '[aria-label*="Save"]'
    ], 4000);

    // Layout save shortcut
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(1200);
    await clickFirst(page, [
      'button:has-text("Save")',
      'button:has-text("OK")'
    ], 1200);

    const shot = `/home/andrea/openclaw/workspace/tradingview/logs/pine_apply_${Date.now()}.png`;
    await page.screenshot({ path: shot, fullPage: false });

    console.log(`DONE symbol=${SYMBOL} addButton=${addBtn} saveButton=${saveBtn || 'n/a'} screenshot=${shot}`);
  } catch (e) {
    const shot = `/home/andrea/openclaw/workspace/tradingview/logs/pine_apply_fail_${Date.now()}.png`;
    try { await page.screenshot({ path: shot, fullPage: false }); } catch {}
    console.error(`FAIL ${e.message}`);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
