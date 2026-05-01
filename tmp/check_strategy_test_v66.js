const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/anmar/.openclaw/workspace/tradingview/node_modules/playwright');

(async () => {
  const profileDir = 'C:/Users/anmar/.openclaw/workspace/tradingview/profile';
  const outDir = 'C:/Users/anmar/.openclaw/workspace-tvflow/tmp';
  const url = 'https://www.tradingview.com/chart/0PgkxOVV/?symbol=BITGET%3AAAPLUSDT.P&interval=240';
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1800, height: 1100 },
    acceptDownloads: true,
    downloadsPath: path.join(outDir, 'downloads'),
    args: ['--enable-gpu','--use-angle=d3d11','--disable-dev-shm-usage']
  });
  for (const p of context.pages()) { try { await p.close({ runBeforeUnload: false }); } catch {} }
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(10000);
  const data = await page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    const visible = (el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const interesting = Array.from(document.querySelectorAll('*'))
      .filter(visible)
      .map(el => (el.innerText || el.textContent || '').trim())
      .filter(t => /v6\.6|6\.6|screener|hybrid|strategy/i.test(t))
      .slice(0, 120);
    return { title: document.title, url: location.href, bodyText: bodyText.slice(0, 30000), interesting };
  });
  const hasV66 = /\bv\s*6\.6\b|\bV\s*6\.6\b|\b6\.6\b/i.test(data.bodyText);
  const hasStrategyLayout = /Startegy test|Strategy test/i.test(data.bodyText);
  fs.writeFileSync(path.join(outDir, 'strategy_test_v66_check.json'), JSON.stringify({ hasV66, hasStrategyLayout, ...data }, null, 2));
  await page.screenshot({ path: path.join(outDir, 'strategy_test_v66_check.png'), fullPage: false });
  await context.close();
  console.log(JSON.stringify({ ok: hasV66 && hasStrategyLayout, hasV66, hasStrategyLayout, title: data.title, url: data.url, interesting: data.interesting.slice(0, 20) }, null, 2));
  process.exit(hasV66 && hasStrategyLayout ? 0 : 2);
})().catch(err => { console.error(err.stack || err.message || String(err)); process.exit(1); });
