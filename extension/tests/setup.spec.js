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

// ── qr-anchor.html: otpauth:// in <a> tag (fastest detection path) ────────────

test('detects otpauth anchor and shows suggestion overlay', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/qr-anchor.html');

  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay).toContainText('TestApp');
  await expect(overlay.locator('.otpilot-primary')).toContainText('Add account');
  await expect(overlay.locator('.otpilot-secondary')).toContainText('Not now');
});

test('no overlay when the account is already saved', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage, {
    accounts: [{ name: 'TestApp', secret: TEST_SECRET, urls: '', email: '' }],
  });
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/qr-anchor.html');

  await page.waitForTimeout(2000);
  await expect(page.locator('#otpilot-suggestion')).not.toBeVisible();
});

test('no overlay when no master password is set up', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupPage.evaluate(() => new Promise(r => chrome.storage.local.clear(r)));
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/qr-anchor.html');

  await page.waitForTimeout(2000);
  await expect(page.locator('#otpilot-suggestion')).not.toBeVisible();
});

test('dismiss overlay via Not now button', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/qr-anchor.html');

  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await overlay.locator('.otpilot-secondary').click();
  await expect(overlay).not.toBeVisible();
});

// ── qr-img-modal.html: <img> QR injected into modal via MutationObserver ─────

test('detects QR image inside dynamically injected modal', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/qr-img-modal.html');

  // Modal is not in the DOM at load time — click to inject it
  await page.getByRole('button', { name: 'Open 2FA setup' }).click();

  // MutationObserver triggers detection after modal is injected and image loads
  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible({ timeout: 15000 });
  await expect(overlay.locator('.otpilot-primary')).toContainText('Add account');
});

// ── qr-svg.html: inline <svg> QR (Sentry / qrcode.react pattern) ─────────────

test('detects inline SVG QR code', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/qr-svg.html');

  // SVG is static in the HTML — waitForSelector resolves immediately
  await page.waitForSelector('#qr-wrap svg', { timeout: 5000 });

  // Detection runs after SVG is in the DOM (MutationObserver fires)
  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible({ timeout: 15000 });
  await expect(overlay.locator('.otpilot-primary')).toContainText('Add account');
});

// ── 2fa-plaintext.html: base32 secret as a text node (Twitter "Can't scan") ──

test('detects base32 secret in a text node', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/2fa-plaintext.html');

  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay.locator('.otpilot-primary')).toContainText('Add account');
});

// ── 2fa-input-secret.html: base32 in <input> value (Sentry secret field) ─────

test('detects base32 secret inside an input value', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/2fa-input-secret.html');

  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay.locator('.otpilot-primary')).toContainText('Add account');
});

// ── enrollment.html: Sentry full flow — input secret + token confirmation ─────

test('shows code-reveal overlay after adding on enrollment page', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/enrollment.html');

  // Suggestion overlay appears from the readonly secret input
  const suggestion = page.locator('#otpilot-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 5000 });

  // Click "Add account"
  await suggestion.locator('.otpilot-primary').click();

  // Code-reveal overlay should appear with a 6-digit code
  const reveal = page.locator('#otpilot-code-reveal');
  await expect(reveal).toBeVisible({ timeout: 3000 });
  const codeText = await reveal.locator('.otpilot-reveal-code').innerText();
  await expect(codeText.replace(/\s/g, '')).toMatch(/^\d{6}$/);
});

test('does not auto-fill the token field on enrollment page', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedStorage(popupPage);
  await popupPage.close();

  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/enrollment.html');

  const suggestion = page.locator('#otpilot-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 5000 });
  await suggestion.locator('.otpilot-primary').click();

  // Wait enough time for auto-fill to have fired if it were going to
  await page.waitForTimeout(1500);

  // Token confirmation field must remain empty — enrollment guard blocked auto-fill
  const tokenInput = page.locator('input[name="authenticator_token"]');
  await expect(tokenInput).toHaveValue('');
});
