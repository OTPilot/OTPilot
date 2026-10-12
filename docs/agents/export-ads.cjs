// Exports the launch creatives in launch-ad.html to PNG at their exact size.
// Run from extension/ (it has Playwright): node ../docs/agents/export-ads.cjs
const path = require('path');
const { chromium } = require(path.join(process.cwd(), 'node_modules/playwright'));

(async () => {
  const dir = __dirname;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  await page.goto('file://' + path.join(dir, 'launch-ad.html'));
  await page.evaluate(() => document.fonts.ready);
  for (const [id, name] of [['ad-wide', 'launch-1200x630'], ['ad-square', 'launch-1080x1080'], ['ad-story', 'launch-1080x1920']]) {
    await page.locator('#' + id).screenshot({ path: path.join(dir, 'launch', name + '.png') });
  }
  await browser.close();
})();
