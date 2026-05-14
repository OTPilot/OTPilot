import { test, expect, FAKE_AUTH, SESSION_24H, TEST_SECRET } from './fixtures.js';

test('shows setup screen on first open (no master password)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // Clear any leftover storage so initLock() sees no auth
  await page.evaluate(() => new Promise(r => chrome.storage.local.clear(r)));
  await page.reload();

  await expect(page.locator('#lock-overlay')).not.toHaveClass(/hidden/);
  await expect(page.locator('#lock-setup')).toBeVisible();
  await expect(page.locator('#lock-setup-btn')).toContainText('Set password');
});

test('shows OTP code when unlocked with an account', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      obfuscated: false, // reveal code on load
      accounts: [{ name: 'TestApp', secret, urls: '', email: 'demo@example.com' }],
      activeIndex: 0,
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  await page.reload();

  // Lock overlay should be hidden (session valid)
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);

  // Account chip is visible in the bar
  const chip = page.locator('.acc-chip').first();
  await expect(chip).toBeVisible();

  // Click the chip to activate the account (syncActiveIndexToUrl resets to -1
  // when the active tab is popup.html, not an HTTP page — a click re-activates it)
  await chip.click();

  // OTP display shows a 6-digit code (format "XXX XXX")
  const display = page.locator('#otp-display');
  await expect(display).not.toHaveClass(/dim/);
  const text = await display.textContent();
  expect(text?.replace(/\s/g, '')).toMatch(/^\d{6}$/);

  // Copy button is enabled
  await expect(page.locator('#btn-copy')).not.toBeDisabled();
});

test('accounts view lists all accounts and has Add button', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [
        { name: 'GitHub', secret, urls: 'github.com', email: 'user@github.com' },
        { name: 'Google', secret, urls: 'accounts.google.com', email: 'user@google.com' },
      ],
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  await page.reload();

  // Navigate to Accounts panel
  await page.click('#nav-settings');
  await expect(page.locator('#settings-panel')).toBeVisible();

  // Two account rows
  await expect(page.locator('.acc-row')).toHaveCount(2);

  // Add account button and Save button
  await expect(page.locator('#btn-add')).toBeVisible();
  await expect(page.locator('#btn-save-all')).toBeVisible();
});

test('search filters accounts in accounts view', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [
        { name: 'GitHub', secret, urls: 'github.com', email: '' },
        { name: 'Google', secret, urls: 'google.com', email: '' },
        { name: 'Dropbox', secret, urls: 'dropbox.com', email: '' },
      ],
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  await page.reload();
  await page.click('#nav-settings');

  // Type in search to filter
  await page.fill('#acc-search', 'git');

  // applyVaultSearch hides non-matching rows via style.display='none';
  // count visible rows directly rather than DOM count
  // Accounts are sorted alphabetically; hidden via style.display='none'
  const { visibleCount, visibleName } = await page.locator('.acc-row').evaluateAll(els => {
    const visible = els.filter(el => el.style.display !== 'none');
    return {
      visibleCount: visible.length,
      visibleName: visible[0]?.querySelector('.acc-head-name')?.textContent ?? '',
    };
  });
  expect(visibleCount).toBe(1);
  expect(visibleName).toBe('GitHub');
});
