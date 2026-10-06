import { test, expect, seedUnlocked, seedLocked, TEST_PASSWORD, TEST_VAULT_KEY, LEGACY_AUTH_TEST } from './fixtures.js';

// Forgot master password → recovery key, device reset, and showing the
// recovery key from Settings (vaultLock.js / vaultKeys.js recover()).

async function popup(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  return page;
}

// A locked 2.0 vault whose key-check value exists (any setPassword writes it).
async function seedLockedWithCheck(page, local = {}) {
  await seedUnlocked(page, local);
  await page.evaluate(async pw => { await VaultKeys.setPassword(pw); await VaultKeys.lock(); }, TEST_PASSWORD);
}

async function recover(page, key, pw) {
  await page.click('#lock-forgot');
  await page.fill('#lock-recover-key', key);
  await page.fill('#lock-recover-new', pw);
  await page.fill('#lock-recover-confirm', pw);
  await page.click('#lock-recover-btn');
}

test('a forgotten master password is replaced using the recovery key; the vault is untouched', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedLockedWithCheck(page);
  await page.evaluate(async vk => {
    await VaultStore.save({ id: 'a', type: 'note', title: 'Wifi', fields: [] }, vk);
  }, TEST_VAULT_KEY);
  await page.reload();
  await expect(page.locator('#lock-login')).toBeVisible();

  await recover(page, TEST_VAULT_KEY, 'brand-new-pw');
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);

  const result = await page.evaluate(async vk => {
    await VaultLock.lock();
    const oldPw = await VaultLock.unlock('test');
    const newPw = await VaultLock.unlock('brand-new-pw');
    return { oldPw, newPw, titles: (await VaultStore.readAll(vk)).items.map(i => i.title) };
  }, TEST_VAULT_KEY);
  expect(result).toEqual({ oldPw: false, newPw: true, titles: ['Wifi'] });
});

test('a wrong recovery key is refused and changes nothing', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedLockedWithCheck(page);
  await page.reload();
  const before = await page.evaluate(() => chrome.storage.local.get(null));
  const other = await page.evaluate(() => VaultCrypto.b64e(VaultCrypto.generateKey()));
  await recover(page, other, 'brand-new-pw');
  await expect(page.locator('#lock-recover-err')).toHaveText("That recovery key doesn't match this device.");
  expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual(before);
  expect(await page.evaluate(() => VaultLock.state())).toBe('locked');
});

test("a key that can't be checked on this device is refused", async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  // Wrapped key with no check value and no vault items: nothing to verify against.
  await seedLocked(page);
  await page.reload();
  await recover(page, TEST_VAULT_KEY, 'brand-new-pw');
  await expect(page.locator('#lock-recover-err')).toContainText("nothing on this device to check the key against");
  expect(await page.evaluate(() => VaultLock.state())).toBe('locked');
});

test('a v1 user who forgot the password recovers with their sync recovery key', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  const syncKey = await page.evaluate(() => VaultCrypto.b64e(VaultCrypto.generateKey()));
  await page.evaluate(([auth, key]) => chrome.storage.local.set({ auth, syncKey: key, accounts: [] }), [LEGACY_AUTH_TEST, syncKey]);
  await page.reload();
  await recover(page, syncKey, 'brand-new-pw');
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);
  const local = await page.evaluate(() => chrome.storage.local.get(null));
  expect(local.auth).toBeUndefined();
  expect(JSON.stringify(local)).not.toContain(syncKey);
  expect(await page.evaluate(async () => { await VaultLock.lock(); return VaultLock.unlock('brand-new-pw'); })).toBe(true);
});

test('with neither password nor recovery key, the device can be reset after typing RESET', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedLocked(page, { accounts: [{ name: 'X', secret: 'JBSWY3DPEHPK3PXP', urls: '' }], theme: 'vault' });
  await page.reload();
  await page.click('#lock-forgot');
  await page.click('#lock-recover-nokey');
  await page.fill('#lock-reset-confirm', 'reset');
  await page.click('#lock-reset-btn');
  await expect(page.locator('#lock-reset-err')).toHaveText('Type RESET to confirm.');
  await page.fill('#lock-reset-confirm', 'RESET');
  await page.click('#lock-reset-btn');
  await expect(page.locator('#lock-setup')).toBeVisible();
  expect(await page.evaluate(() => chrome.storage.local.get(['vaultKeyWrapped', 'accounts']))).toEqual({});
});

test('Settings shows the recovery key only after the master password', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedUnlocked(page);
  await page.reload();
  await page.click('#nav-config');
  await page.click('#row-settings-password');
  await page.fill('#reveal-key-password', 'nope');
  await page.click('#reveal-key-btn');
  await expect(page.locator('#reveal-key-err')).toHaveText('Incorrect password.');
  await expect(page.locator('#reveal-key-value')).toBeHidden();
  await page.fill('#reveal-key-password', TEST_PASSWORD);
  await page.click('#reveal-key-btn');
  await expect(page.locator('#reveal-key-value')).toHaveText(TEST_VAULT_KEY);
});

test('the unlock button works again after the popup re-locks while open', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedLocked(page);
  await page.reload();
  await page.fill('#lock-password', TEST_PASSWORD);
  await page.click('#lock-login-btn');
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);
  await page.click('#btn-logout');
  await expect(page.locator('#lock-login-btn')).toBeEnabled();
  await expect(page.locator('#lock-login-btn')).toHaveText('Unlock');
});
