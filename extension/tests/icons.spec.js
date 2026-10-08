import { test, expect, seedUnlocked, TEST_SECRET } from './fixtures.js';

// 1×1 transparent PNG as a data URL — stands in for a cached favicon.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// Seeds an unlocked vault with one account that has a cached icon and one without.
async function seed(page) {
  await seedUnlocked(page);
  await page.evaluate(([secret, dataUrl]) => {
    return new Promise(r => chrome.storage.local.set({
      accounts: [
        { name: 'GitHub', secret, urls: 'github.com', domain: 'github.com', email: '' },
        { name: 'Acme',   secret, urls: 'acme.test',  domain: 'acme.test',  email: '' },
      ],
      iconCache: { 'github.com': { dataUrl, fetchedAt: Date.now() } },
    }, r));
  }, [TEST_SECRET, PNG_DATA_URL]);
}

test('home list rows render the cached favicon as <img>, fall back to a letter avatar', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await seed(page);
  await page.reload();

  // The account with a cached icon renders an <img> avatar with the data URL.
  const img = page.locator('#home-list img.acc-av');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', /^data:image\/png/);

  // The account without a cached icon keeps the letter avatar (a <span>).
  await expect(page.locator('#home-list span.acc-av')).toHaveCount(1);
});

test('vault rows render the cached favicon as <img>', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await seed(page);
  await page.reload();

  await page.click('#nav-settings');
  await expect(page.locator('#settings-panel')).toBeVisible();

  // Two rows: GitHub (icon → img) and Acme (no icon → span).
  await expect(page.locator('.acc-head img.acc-av')).toHaveCount(1);
  await expect(page.locator('.acc-head span.acc-av')).toHaveCount(1);
});

test('a cached "no icon" is asked again when the page sends a hint, and expires after a day', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent('serviceworker')];
  const r = await worker.evaluate(async dataUrl => {
    const now = Date.now();
    await chrome.storage.local.set({ iconCache: {
      'hinted.test': { dataUrl: null, fetchedAt: now },
      'old.test': { dataUrl: null, fetchedAt: now - 2 * 24 * 3600 * 1000 },
      'recent.test': { dataUrl: null, fetchedAt: now },
    } });
    const asked = [];
    const png = await (await fetch(dataUrl)).arrayBuffer();
    globalThis.fetch = async (url, opts) => {
      if (String(url).endsWith('/icons/resolve')) {
        const { domains } = JSON.parse(opts.body);
        asked.push(...domains);
        return new Response(JSON.stringify(Object.fromEntries(domains.map(d => [d, { status: 'ok', url: `https://cdn.test/${d}.png` }]))), { status: 200 });
      }
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    };
    await handleResolveIcons(['hinted.test', 'old.test', 'recent.test'], { 'hinted.test': 'https://hinted.test/icon.png' }, false);
    const { iconCache } = await chrome.storage.local.get('iconCache');
    return { asked: asked.sort(), got: Object.keys(iconCache).filter(d => iconCache[d].dataUrl).sort() };
  }, PNG_DATA_URL);
  expect(r).toEqual({ asked: ['hinted.test', 'old.test'], got: ['hinted.test', 'old.test'] });
});
