import { test, expect, FAKE_AUTH, SESSION_24H, TEST_SECRET } from './fixtures.js';

async function seedStorage(popupPage, overrides = {}) {
  await popupPage.evaluate(([auth, expiry, extra]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [],
      ...extra,
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), overrides]);
}

test('content script detects otpauth URI and shows suggestion overlay', async ({ context, extensionId }) => {
  // Seed auth + empty accounts (so the secret isn't already saved)
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/setup.html');

  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible({ timeout: 5000 });

  // Shows the issuer name and action buttons
  await expect(overlay).toContainText('TestApp');
  await expect(overlay.locator('.otpilot-primary')).toContainText('Add account');
  await expect(overlay.locator('.otpilot-secondary')).toContainText('Not now');
});

test('no overlay when the account is already saved', async ({ context, extensionId }) => {
  // Seed with the same secret already in accounts
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage, {
    accounts: [{ name: 'TestApp', secret: TEST_SECRET, urls: '', email: '' }],
  });
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/setup.html');

  // Detection runs but account already exists → no overlay
  await page.waitForTimeout(2000);
  await expect(page.locator('#otpilot-suggestion')).not.toBeVisible();
});

test('no overlay when no master password is set up', async ({ context, extensionId }) => {
  // Clear storage entirely (no auth → content script won't show overlay)
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupPage.evaluate(() => new Promise(r => chrome.storage.local.clear(r)));
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/setup.html');

  await page.waitForTimeout(2000);
  await expect(page.locator('#otpilot-suggestion')).not.toBeVisible();
});

test('dismiss overlay via Not now button', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/setup.html');

  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible({ timeout: 5000 });

  await overlay.locator('.otpilot-secondary').click();
  await expect(overlay).not.toBeVisible();
});
