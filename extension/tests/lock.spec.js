import { test, expect, seedUnlocked, seedLocked, TEST_SECRET, TEST_PASSWORD, LEGACY_AUTH_TEST } from './fixtures.js';

// 2.0 master-password lock (vaultLock.js): mandatory password that wraps the
// vault key; unlocked only in chrome.storage.session; inactivity auto-lock.

// The one-time "save your recovery key" screen after setup / v1 upgrade.
async function finishRecoveryKit(page) {
  await expect(page.locator('#lock-kit')).toBeVisible();
  await expect(page.locator('#lock-kit-done')).toBeDisabled();
  await page.check('#lock-kit-saved');
  await page.click('#lock-kit-done');
}

async function popup(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  return page;
}

test('first run: setting the master password wraps the vault key and saves the auto-lock', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await page.reload();
  await expect(page.locator('#lock-setup')).toBeVisible();

  await page.fill('#lock-new-password', 'hunter22');
  await page.fill('#lock-confirm-password', 'hunter22');
  await page.selectOption('#lock-setup-autolock', '60');
  await page.click('#lock-setup-btn');
  await expect(page.locator('#lock-kit-key')).toHaveText(/^[A-Za-z0-9+/]{43}=$/);
  const shownKey = await page.locator('#lock-kit-key').textContent();
  await finishRecoveryKit(page);
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);
  expect(shownKey).toBe(await page.evaluate(() => VaultKeys.getKey()));
  expect(await page.evaluate(() => chrome.storage.local.get('recoveryKeyAcknowledged'))).toEqual({ recoveryKeyAcknowledged: true });

  const state = await page.evaluate(async () => ({
    lock: await VaultLock.state(),
    local: await chrome.storage.local.get(null),
    lockAt: (await chrome.storage.session.get('vaultLockAt')).vaultLockAt,
  }));
  expect(state.lock).toBe('unlocked');
  expect(state.local.vaultKeyWrapped?.kdf).toBe('PBKDF2-SHA256');
  expect(state.local.vaultKey).toBeUndefined();
  expect(state.local.autoLockMinutes).toBe(60);
  expect(state.lockAt).toBeGreaterThan(Date.now() + 55 * 60000);
});

test('the lock button locks the vault and the master password unlocks it', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedUnlocked(page);
  await page.reload();
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);

  await page.click('#btn-logout');
  await expect(page.locator('#lock-login')).toBeVisible();
  expect(await page.evaluate(() => chrome.storage.session.get('vaultKeyUnlocked'))).toEqual({});

  await page.fill('#lock-password', 'wrong');
  await page.click('#lock-login-btn');
  await expect(page.locator('#lock-login-err')).toHaveText('Incorrect password.');

  await page.fill('#lock-password', TEST_PASSWORD);
  await page.click('#lock-login-btn');
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);
  expect(await page.evaluate(() => VaultLock.state())).toBe('unlocked');
});

test('a v1 user is migrated on first unlock: same password, vault key wrapped, legacy lock gone', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  // A v1 user mid-session: their 30-day session must not carry over.
  await page.evaluate(auth => chrome.storage.local.set({
    auth, sessionExpiry: Date.now() + 86400000, sessionDuration: 2592000000, accounts: [],
  }), LEGACY_AUTH_TEST);
  await page.reload();
  await expect(page.locator('#lock-login')).toBeVisible();

  await page.fill('#lock-password', TEST_PASSWORD);
  await page.click('#lock-login-btn');
  // Upgraded users see their recovery key once.
  await finishRecoveryKit(page);
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);

  const local = await page.evaluate(() => chrome.storage.local.get(null));
  expect(local.vaultKeyWrapped).toBeTruthy();
  expect(local.auth).toBeUndefined();
  expect(local.sessionExpiry).toBeUndefined();
  expect(local.sessionDuration).toBeUndefined();
  // The same password now unlocks the vault key.
  const relock = await page.evaluate(async pw => { await VaultLock.lock(); return VaultLock.unlock(pw); }, TEST_PASSWORD);
  expect(relock).toBe(true);
});

test('a v1 user with sync: the plaintext syncKey ends up wrapped by the master password', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  const syncKey = await page.evaluate(() => VaultCrypto.b64e(VaultCrypto.generateKey()));
  await page.evaluate(([auth, key]) => chrome.storage.local.set({ auth, syncKey: key, accounts: [] }), [LEGACY_AUTH_TEST, syncKey]);
  await page.reload();
  await page.fill('#lock-password', TEST_PASSWORD);
  await page.click('#lock-login-btn');
  await finishRecoveryKit(page);
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);

  const result = await page.evaluate(async key => {
    const local = await chrome.storage.local.get(null);
    return {
      plaintextAnywhere: JSON.stringify(local).includes(key),
      syncEnabled: local.syncEnabled,
      syncKeyIsVaultKey: (await CloudSync.getSyncKey()) === key,
    };
  }, syncKey);
  expect(result).toEqual({ plaintextAnywhere: false, syncEnabled: true, syncKeyIsVaultKey: true });
});

test('a wrong password during the v1 migration changes nothing', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await page.evaluate(auth => chrome.storage.local.set({ auth, accounts: [] }), LEGACY_AUTH_TEST);
  await page.reload();
  await page.fill('#lock-password', 'not-it');
  await page.click('#lock-login-btn');
  await expect(page.locator('#lock-login-err')).toHaveText('Incorrect password.');
  const local = await page.evaluate(() => chrome.storage.local.get(null));
  expect(local.auth).toEqual(LEGACY_AUTH_TEST);
  expect(local.vaultKeyWrapped).toBeUndefined();
});

test('the vault locks once the inactivity deadline passes', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedUnlocked(page, { autoLockMinutes: 15 });
  await page.evaluate(() => chrome.storage.session.set({ vaultLockAt: Date.now() - 1000 }));
  await page.reload();
  await expect(page.locator('#lock-login')).toBeVisible();
  expect(await page.evaluate(() => chrome.storage.session.get('vaultKeyUnlocked'))).toEqual({});
});

test('the auto-lock setting is saved from Settings', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedUnlocked(page);
  await page.reload();
  await page.click('#nav-config');
  await page.click('#row-settings-password');
  await expect(page.locator('#autolock-select')).toHaveValue('0');
  await page.selectOption('#autolock-select', '240');
  await expect(page.locator('#status-msg')).toHaveText('Auto-lock updated');
  const result = await page.evaluate(async () => ({
    minutes: (await chrome.storage.local.get('autoLockMinutes')).autoLockMinutes,
    lockAt: (await chrome.storage.session.get('vaultLockAt')).vaultLockAt,
  }));
  expect(result.minutes).toBe(240);
  expect(result.lockAt).toBeGreaterThan(Date.now() + 235 * 60000);
});

test('on a page, a locked vault is unlocked from the overlay and the code is filled', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedLocked(page, { accounts: [{ name: 'TestApp', secret: TEST_SECRET, urls: 'localhost', email: '' }], activeIndex: 0 });

  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/autofill.html');
  await expect(site.locator('#otpilot-lock')).toBeVisible();
  const frame = site.frameLocator('#otpilot-lock iframe');

  await frame.locator('#pw').fill('wrong');
  await frame.locator('#unlock').click();
  await expect(frame.locator('#err')).toHaveText('Incorrect password');

  await frame.locator('#pw').fill(TEST_PASSWORD);
  await frame.locator('#unlock').click();
  await expect(site.locator('input[name="otp_token"]')).toHaveValue(/^\d{6}$/);
  await expect(site.locator('#otpilot-lock')).toHaveCount(0);
  expect(await page.evaluate(() => VaultLock.state())).toBe('unlocked');
});

test("the master password is never typed into the host page's DOM", async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedLocked(page, { accounts: [{ name: 'TestApp', secret: TEST_SECRET, urls: 'localhost', email: '' }], activeIndex: 0 });
  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/autofill.html');
  await expect(site.locator('#otpilot-lock')).toBeVisible();
  await site.frameLocator('#otpilot-lock iframe').locator('#pw').fill('typed-secret');

  // What the page's own scripts can see: no password field in its DOM, and no
  // way into the extension frame.
  const seen = await site.evaluate(() => ({
    inputs: [...document.querySelectorAll('#otpilot-lock input')].length,
    frameReadable: (() => { try { return !!document.querySelector('#otpilot-lock iframe').contentDocument; } catch { return false; } })(),
    text: document.body.innerHTML.includes('typed-secret'),
  }));
  expect(seen).toEqual({ inputs: 0, frameReadable: false, text: false });
});

test('a page faking the "unlocked" message does not get past a locked vault', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedLocked(page, { accounts: [{ name: 'TestApp', secret: TEST_SECRET, urls: 'localhost', email: '' }], activeIndex: 0 });
  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/autofill.html');
  await expect(site.locator('#otpilot-lock')).toBeVisible();
  await site.evaluate(() => window.postMessage({ source: 'otpilot-unlock', result: 'unlocked' }, '*'));
  await site.waitForTimeout(500);
  await expect(site.locator('#otpilot-lock')).toBeVisible();
  await expect(site.locator('input[name="otp_token"]')).toHaveValue('');
});

test('an open popup shows the lock screen as soon as the vault locks elsewhere', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedUnlocked(page);
  await page.reload();
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);
  // e.g. the auto-lock alarm in the background worker
  await page.evaluate(() => chrome.storage.session.remove('vaultKeyUnlocked'));
  await expect(page.locator('#lock-login')).toBeVisible();
});

test('activity after the deadline passed locks instead of reviving the session', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedUnlocked(page, { autoLockMinutes: 15 });
  await page.reload();
  // Opening the popup sets its own deadline (initLock → touch); wait for it so
  // it can't overwrite the expired one set below.
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.session.get('vaultLockAt')).vaultLockAt ?? 0)).toBeGreaterThan(0);
  await page.evaluate(() => chrome.storage.session.set({ vaultLockAt: Date.now() - 1000 }));
  // Changing the auto-lock is activity (touch); it must not renew an expired deadline.
  const state = await page.evaluate(async () => { await VaultLock.setAutoLock(60); return VaultLock.state(); });
  expect(state).toBe('locked');
  await expect(page.locator('#lock-login')).toBeVisible();
});

test('restoring a recovery key needs the master password and keeps the key wrapped', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedUnlocked(page);
  await page.reload();
  const recovery = await page.evaluate(() => VaultCrypto.b64e(VaultCrypto.generateKey()));
  // No network here: the server pull/push are stubbed; this exercises the
  // restore handler from "key validated" on.
  const restore = (key, pw) => page.evaluate(([k, p]) => {
    CloudSync.pull = async () => ({ accounts: [], tombstones: {} });
    CloudSync.push = async () => ({});
    document.getElementById('sync-restore-input').value = k;
    document.getElementById('sync-restore-password').value = p;
    document.getElementById('sync-restore-err').textContent = '';
    document.getElementById('btn-restore-key').click();
  }, [key, pw]);

  await restore(recovery, 'wrong');
  await expect(page.locator('#sync-restore-err')).toHaveText('Incorrect master password.');
  expect(await page.evaluate(k => VaultKeys.getKey().then(v => v === k), recovery)).toBe(false);

  await restore(recovery, TEST_PASSWORD);
  await expect.poll(() => page.evaluate(k => VaultKeys.getKey().then(v => v === k), recovery)).toBe(true);
  const local = await page.evaluate(() => chrome.storage.local.get(null));
  expect(local.syncEnabled).toBe(true);
  expect(JSON.stringify(local)).not.toContain(recovery);
});

test('a restore that finishes after the vault locked does not reopen it', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedUnlocked(page);
  await page.reload();
  const recovery = await page.evaluate(() => VaultCrypto.b64e(VaultCrypto.generateKey()));
  const state = await page.evaluate(async ([k, pw]) => {
    // The server answers only after the vault has locked.
    CloudSync.pull = async () => { await VaultLock.lock(); return { accounts: [], tombstones: {} }; };
    CloudSync.push = async () => ({});
    document.getElementById('sync-restore-input').value = k;
    document.getElementById('sync-restore-password').value = pw;
    document.getElementById('btn-restore-key').click();
    await new Promise(r => setTimeout(r, 1500));
    return { lock: await VaultLock.state(), session: await chrome.storage.session.get(null) };
  }, [recovery, TEST_PASSWORD]);
  expect(state.lock).toBe('locked');
  expect(state.session.vaultKeyUnlocked).toBeUndefined();
});

test('adopting a key while locked keeps the vault locked', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedLocked(page);
  const result = await page.evaluate(async pw => {
    const k = VaultCrypto.b64e(VaultCrypto.generateKey());
    await VaultKeys.adoptKey(k, pw);
    return { status: await VaultKeys.status(), unlocks: await VaultKeys.unlock(pw), adopted: (await VaultKeys.getKey()) === k };
  }, TEST_PASSWORD);
  expect(result).toEqual({ status: 'locked', unlocks: true, adopted: true });
});

test('locking and unlocking the popup keeps the plan (a paying user is not limited as Free)', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedUnlocked(page, { userPlan: 'personal' });
  await page.reload();
  await page.click('#btn-logout');
  await expect(page.locator('#lock-login')).toBeVisible();
  await page.fill('#lock-password', TEST_PASSWORD);
  await page.click('#lock-login-btn');
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);
  expect(await page.evaluate(() => chrome.storage.local.get('userPlan'))).toEqual({ userPlan: 'personal' });
});

test('an "unlocked" message from the frame itself, after the page navigated it, still needs a real unlock', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await seedLocked(page, { accounts: [{ name: 'TestApp', secret: TEST_SECRET, urls: 'localhost', email: '' }], activeIndex: 0 });
  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/autofill.html');
  await expect(site.locator('#otpilot-lock')).toBeVisible();
  // The page owns the <iframe> element, so it can navigate it to its own
  // content: the message then really comes from frame.contentWindow and only
  // the background lock check stops it.
  await site.evaluate(() => {
    document.querySelector('#otpilot-lock iframe').src =
      'data:text/html,<script>parent.postMessage({ source: "otpilot-unlock", result: "unlocked" }, "*")</script>';
  });
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-lock')).toBeVisible();
  await expect(site.locator('input[name="otp_token"]')).toHaveValue('');
});

test('a long account name stays on one line in the unlock frame', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  const longName = 'A Very Long Account Name That Would Otherwise Wrap Onto Several Lines';
  await seedLocked(page, { accounts: [{ name: longName, secret: TEST_SECRET, urls: 'localhost', email: '' }], activeIndex: 0 });
  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/autofill.html');
  const frame = site.frameLocator('#otpilot-lock iframe');
  await expect(frame.locator('#unlock')).toBeInViewport();
  const lines = await frame.locator('#label').evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBe(1);
});
