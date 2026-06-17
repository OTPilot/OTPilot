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

test('category filter bar narrows the home account chips', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [
        { name: 'GitHub',   secret, urls: '', email: '', category: 'Work' },
        { name: 'AWS',      secret, urls: '', email: '', category: 'Work' },
        { name: 'Gmail',    secret, urls: '', email: '', category: 'Personal' },
        { name: 'Coinbase', secret, urls: '', email: '', category: 'Finance' },
      ],
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  await page.reload();

  // Filter bar is visible: All + 3 categories
  const bar = page.locator('#home-cat-bar');
  await expect(bar).toBeVisible();
  await expect(bar.locator('.cat-pill')).toHaveCount(4);

  // "All" is active by default and the overflow button shows (4 > 3 chips)
  await expect(bar.locator('.cat-pill.active')).toContainText('All');

  // Pick "Work" → only the two Work accounts remain as chips, no overflow
  await bar.locator('.cat-pill', { hasText: 'Work' }).click();
  await expect(page.locator('.acc-chip')).toHaveCount(2);
  await expect(page.locator('#account-overflow-btn')).toHaveCount(0);
  await expect(page.locator('.acc-chip-name').first()).toHaveText('GitHub');

  // Each filtered chip carries its category color dot
  await expect(page.locator('.acc-chip .cat-dot')).toHaveCount(2);
});

test('assigning a new category in the editor persists and tags the account', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [{ name: 'GitHub', secret, urls: '', email: '' }],
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  await page.reload();
  await page.click('#nav-settings');

  // Expand the account row and open the "+ New" category input
  await page.locator('.acc-head').first().click();
  await expect(page.locator('.cat-choose')).toBeVisible();
  await page.locator('.cat-choice.new').click();
  await page.fill('.cat-new-input', 'Work');

  // Save, then verify the assignment landed in storage
  await page.click('#btn-save-all');
  const stored = await page.evaluate(() =>
    new Promise(r => chrome.storage.local.get('accounts', d => r(d.accounts)))
  );
  expect(stored[0].category).toBe('Work');

  // Re-open the vault — the row header now shows the category tag
  await page.click('#nav-settings');
  await expect(page.locator('.acc-head .cat-tag')).toContainText('Work');
});

test('adding an account while a category filter is active keeps it visible and pre-assigns the category', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      categoryFilter: 'Work',
      accounts: [
        { name: 'GitHub', secret, urls: '', email: '', category: 'Work' },
        { name: 'AWS',    secret, urls: '', email: '', category: 'Work' },
        { name: 'Gmail',  secret, urls: '', email: '', category: 'Personal' },
      ],
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  await page.reload();
  await page.click('#nav-settings');

  // Vault opens filtered to Work: 2 visible rows
  const visibleBefore = await page.locator('.acc-row').evaluateAll(els =>
    els.filter(el => el.style.display !== 'none').length);
  expect(visibleBefore).toBe(2);

  // Add an account while the Work filter is active
  await page.click('#btn-add');

  // The new row is visible (not hidden by the filter) → 3 visible rows
  const visibleAfter = await page.locator('.acc-row').evaluateAll(els =>
    els.filter(el => el.style.display !== 'none').length);
  expect(visibleAfter).toBe(3);

  // …and the new row's chooser is pre-assigned to the active category
  await expect(page.locator('.acc-body.open .cat-choose')).toHaveAttribute('data-value', 'Work');

  // The "Work" pill badge counts the draft (now 3), matching the visible rows
  await expect(
    page.locator('#vault-cat-bar .cat-pill', { hasText: 'Work' }).locator('.count')
  ).toHaveText('3');
});
