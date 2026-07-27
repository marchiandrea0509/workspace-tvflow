#!/usr/bin/env node
const { chromium } = require('playwright');

const PROFILE = '/home/andrea/openclaw/workspace/tradingview/profile';
const SYMBOL = process.argv[2] || 'PAXGUSDT.P';

const LEVELS = [
  { price: '5160', color: 'green' },
  { price: '5030', color: 'green' },
  { price: '4925', color: 'green' },
  { price: '4860', color: 'red' },
];

async function maybeClick(page, selectors, timeout = 2000) {
  for (const s of selectors) {
    const el = page.locator(s).first();
    try {
      if (await el.isVisible({ timeout })) {
        await el.click({ timeout });
        return true;
      }
    } catch {}
  }
  return false;
}

async function fillFirstVisible(page, selectors, value) {
  for (const s of selectors) {
    const el = page.locator(s).first();
    try {
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click();
        await el.press('Control+A');
        await el.fill(String(value));
        return true;
      }
    } catch {}
  }
  return false;
}

async function pickColor(page, color) {
  // Open color picker from style tab if available
  await maybeClick(page, [
    'button:has-text("Color")',
    '[aria-label*="Color"]',
    'div[data-name="color-select"]',
    'button[class*="color"]'
  ], 1200);

  const swatches = color === 'green'
    ? ['[style*="0, 200, 83"]', '[style*="#00C853"]', 'button[title*="Green"]', 'div[title*="Green"]']
    : ['[style*="255, 23, 68"]', '[style*="#FF1744"]', 'button[title*="Red"]', 'div[title*="Red"]'];

  await maybeClick(page, swatches, 1200);
}

async function setDashed(page) {
  await maybeClick(page, [
    'button:has-text("Line")',
    '[aria-label*="Line style"]',
    'button[title*="Line style"]',
    'div[data-name="line-style-select"]'
  ], 1200);

  await maybeClick(page, [
    'button[title*="Dashed"]',
    'div[title*="Dashed"]',
    'button:has-text("Dashed")'
  ], 1200);
}

async function addHorizontalLine(page, level) {
  // focus chart area
  await page.mouse.click(500, 300);
  await page.keyboard.press('Alt+H');
  await page.waitForTimeout(300);

  // Open object settings of selected drawing
  await page.keyboard.press('Control+E');
  await page.waitForTimeout(700);

  // Coordinates tab
  await maybeClick(page, [
    'button:has-text("Coordinates")',
    '[role="tab"]:has-text("Coordinates")',
    'text=Coordinates'
  ], 2000);

  // price input
  const okPrice = await fillFirstVisible(page, [
    'input[aria-label*="Price"]',
    'input[placeholder*="Price"]',
    'label:has-text("Price") + div input',
    'input[type="text"]'
  ], level.price);

  // Style tab
  await maybeClick(page, [
    'button:has-text("Style")',
    '[role="tab"]:has-text("Style")',
    'text=Style'
  ], 1200);

  await setDashed(page);
  await pickColor(page, level.color);

  // confirm
  await maybeClick(page, [
    'button:has-text("OK")',
    'button:has-text("Apply")',
    'button:has-text("Save")',
    'button[data-name="submit-button"]'
  ], 1500);

  // close with Enter fallback
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);

  return okPrice;
}

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1600, height: 1000 },
    args: ['--disable-dev-shm-usage']
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(SYMBOL)}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(5000);

  // try to dismiss popups
  await maybeClick(page, [
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    'button[aria-label="Close"]',
    'button:has-text("No thanks")'
  ], 1000);

  let okCount = 0;
  for (const lvl of LEVELS) {
    const ok = await addHorizontalLine(page, lvl);
    if (ok) okCount += 1;
  }

  // Save chart/layout
  await page.keyboard.press('Control+S');
  await page.waitForTimeout(1200);
  await maybeClick(page, [
    'button:has-text("Save")',
    'button:has-text("OK")'
  ], 1200);

  await page.screenshot({ path: `/home/andrea/openclaw/workspace/tradingview/logs/set_levels_${Date.now()}.png`, fullPage: false });

  console.log(`DONE symbol=${SYMBOL} levels_set=${okCount}/${LEVELS.length}`);

  await context.close();
})();
