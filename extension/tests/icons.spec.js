import { test, expect, FAKE_AUTH, SESSION_24H, TEST_SECRET } from './fixtures.js';

// 1×1 transparent PNG as a data URL — stands in for a cached favicon.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// Seeds an unlocked vault with one account that has a cached icon and one without.
async function seed(page) {
  await page.evaluate(([auth, expiry, secret, dataUrl]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [
        { name: 'GitHub', secret, urls: 'github.com', domain: 'github.com', email: '' },
        { name: 'Acme',   secret, urls: 'acme.test',  domain: 'acme.test',  email: '' },
      ],
      iconCache: { 'github.com': { dataUrl, fetchedAt: Date.now() } },
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET, PNG_DATA_URL]);
}

test('home chips render the cached favicon as <img>, fall back to a letter avatar', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await seed(page);
  await page.reload();

  // The account with a cached icon renders an <img> avatar with the data URL.
  const img = page.locator('.acc-chip img.acc-av');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', /^data:image\/png/);

  // The account without a cached icon keeps the letter avatar (a <span>).
  await expect(page.locator('.acc-chip span.acc-av')).toHaveCount(1);
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
