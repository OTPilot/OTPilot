import { test, expect, FAKE_AUTH, SESSION_24H, TEST_SECRET } from './fixtures.js';

test('autofill test page has OTP input field', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('http://localhost:8080/test/autofill.html');

  const input = page.locator('input[name="otp_token"]');
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(input).toHaveAttribute('maxlength', '6');
});

test('content script fills OTP field when triggered via extension message', async ({ context, extensionId }) => {
  // Use the popup page as the extension context for sending messages
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  // Pre-seed: session unlocked + account matching localhost
  await popupPage.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [{ name: 'TestApp', secret, urls: 'localhost', email: '' }],
      activeIndex: 0,
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  // Navigate to the autofill page and wait for content script to run
  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8080/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  // Send the fill message from the extension (popup) context
  const tabId = await popupPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8080/test/autofill.html' });
    return tabs[0]?.id ?? null;
  });

  expect(tabId).not.toBeNull();

  await popupPage.evaluate(id => {
    return chrome.tabs.sendMessage(id, { action: 'fill', accountIndex: 0 });
  }, tabId);

  // OTP field should now contain a 6-digit code
  const input = autofillPage.locator('input[name="otp_token"]');
  await expect(input).toHaveValue(/^\d{6}$/, { timeout: 5000 });
});

test('filled code is highlighted (filled class added)', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [{ name: 'TestApp', secret, urls: 'localhost', email: '' }],
      activeIndex: 0,
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8080/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  const tabId = await popupPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8080/test/autofill.html' });
    return tabs[0]?.id ?? null;
  });

  await popupPage.evaluate(id => {
    return chrome.tabs.sendMessage(id, { action: 'fill', accountIndex: 0 });
  }, tabId);

  // autofill.html adds a .filled class when input has 6 chars
  const input = autofillPage.locator('input[name="otp_token"]');
  await expect(input).toHaveClass(/filled/, { timeout: 5000 });
});
