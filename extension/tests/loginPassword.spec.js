import { test, expect, seedUnlocked, waitForVault, readAccounts, writeAccounts, TEST_SECRET } from './fixtures.js';

// Logins carry a password (the vault item's password field), edited in the
// account editor and shown under the code on Home.

async function popupWith(context, extensionId, accounts) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts, obfuscated: false });
  await page.reload();
  await waitForVault(page);
  return page;
}

test('a password set in the editor is stored in the vault item and shown on Home', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, [{ name: 'GitHub', email: 'me@example.com', secret: TEST_SECRET, urls: '' }]);
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'GitHub' }).click();
  await page.fill('.acc-password', 'hunter2!');
  await page.click('#btn-save-all');

  await expect.poll(async () => (await readAccounts(page))[0]?.password).toBe('hunter2!');
  const item = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items[0]);
  expect(item.fields.find(f => f.id === 'password').value).toBe('hunter2!');

  await page.click('#nav-home');
  // Home preselects only the account matching the active tab: pick it.
  await page.locator('#home-list .lc-row', { hasText: 'GitHub' }).click();
  const creds = page.locator('#home-creds .home-cred');
  await expect(creds).toHaveCount(2);
  await expect(creds.nth(0)).toContainText('me@example.com');
  await expect(creds.nth(1).locator('.home-cred-value')).toHaveText('••••••••');
  await creds.nth(1).locator('.home-cred-btn').first().click(); // show
  await expect(creds.nth(1).locator('.home-cred-value')).toHaveText('hunter2!');
  await creds.nth(1).locator('.home-cred-btn', { hasText: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('hunter2!');
});

test('a password-only login (no 2FA) is fine on Home', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await writeAccounts(page, [{ name: 'Netflix', email: 'tv@example.com', secret: '', urls: '', password: 'p4ss' }]);
  await page.reload();
  await page.locator('#home-list .lc-row', { hasText: 'Netflix' }).click();
  // No code block or Copy / Fill: the details are what there is.
  await expect(page.locator('#otp-display')).toBeHidden();
  await expect(page.locator('#btn-fill')).toBeHidden();
  await expect(page.locator('#home-creds .home-cred')).toHaveCount(2);
});

test('the editor can generate a password', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, [{ name: 'GitHub', email: '', secret: TEST_SECRET, urls: '' }]);
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'GitHub' }).click();
  await page.click('.btn-gen-password');
  await expect(page.locator('.acc-password')).toHaveValue(/^.{16}$/);
  await expect(page.locator('.acc-password')).toHaveAttribute('type', 'text');
});

test('changing the password keeps the previous one in the item history', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await writeAccounts(page, [{ name: 'GitHub', email: '', secret: '', urls: '', password: 'old-one' }]);
  const [acc] = await readAccounts(page);
  await writeAccounts(page, [{ ...acc, password: 'new-one' }]);
  const item = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items[0]);
  expect(item.fields.find(f => f.id === 'password').value).toBe('new-one');
  expect(item.passwordHistory.map(h => h.value)).toEqual(['old-one']);
});

test('an account from a 1.x device (no password field) keeps the stored password', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await writeAccounts(page, [{ name: 'GitHub', email: '', secret: TEST_SECRET, urls: '', password: 'keep-me' }]);
  const [acc] = await readAccounts(page);
  const { password, ...fromV1 } = acc;
  await writeAccounts(page, [{ ...fromV1, urls: 'github.com' }]);
  expect((await readAccounts(page))[0]).toMatchObject({ urls: 'github.com', password: 'keep-me' });
});

test('passwords never go into the v1 sync blob', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  const blob = await page.evaluate(async () => {
    await CloudSync.generateSyncKey();
    let sent = null;
    CloudSync.api = undefined;
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return new Response('{}', { status: 200 }); };
    SupabaseAuth.getAccessToken = async () => 'token';
    await CloudSync.push([{ name: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', password: 'hunter2' }], {}, new Date().toISOString());
    window.fetch = realFetch;
    const key = await CloudSync.getSyncKey();
    const { iv, data } = JSON.parse(sent.encrypted_blob);
    const k = await crypto.subtle.importKey('raw', VaultCrypto.b64d(key), 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: VaultCrypto.b64d(iv) }, k, VaultCrypto.b64d(data));
    return JSON.parse(new TextDecoder().decode(pt));
  });
  expect(blob.accounts).toEqual([{ name: 'GitHub', secret: 'JBSWY3DPEHPK3PXP' }]);
});

test('after a v1 blob pull, accounts still show and keep their passwords', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await writeAccounts(page, [{ name: 'GitHub', email: 'me', secret: TEST_SECRET, urls: '', password: 'keep-me' }]);
  await page.reload();
  await expect.poll(() => page.evaluate(() => accounts.length)).toBe(1); // popup finished loading
  const result = await page.evaluate(async () => {
    // What a v1 pull does: replace the list with password-less entries, then save.
    accounts = accounts.map(({ password, ...a }) => a);
    await saveState();
    return accounts[0].password;
  });
  expect(result).toBe('keep-me');
});

test('Home rows change when username and password swap a "|" between them', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await writeAccounts(page, [{ name: 'X', email: 'a|b', secret: '', urls: '', password: 'c' }]);
  await page.reload();
  await page.locator('#home-list .lc-row', { hasText: 'X' }).click();
  await expect(page.locator('#home-creds .home-cred').first()).toContainText('a|b');
  await page.evaluate(async () => { accounts[0] = { ...accounts[0], email: 'a', password: 'b|c' }; refreshDisplay(); });
  await expect(page.locator('#home-creds .home-cred-value').first()).toHaveText('a');
});

test('the generate button shows the eye as "revealed"', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, [{ name: 'GitHub', email: '', secret: TEST_SECRET, urls: '' }]);
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'GitHub' }).click();
  const eyeBefore = await page.locator('.acc-password ~ .btn-eye').first().innerHTML();
  await page.click('.btn-gen-password');
  const eyeAfter = await page.locator('.acc-password ~ .btn-eye').first().innerHTML();
  expect(eyeAfter).not.toBe(eyeBefore);
});

test('pages never receive passwords', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await writeAccounts(page, [{ name: 'GitHub', email: 'me', secret: TEST_SECRET, urls: 'localhost', password: 'secret-pw' }]);
  const res = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'vaultAccounts' }));
  expect(res.accounts[0].name).toBe('GitHub');
  expect(JSON.stringify(res)).not.toContain('secret-pw');
});

test('a revealed password is masked again after locking and unlocking', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await writeAccounts(page, [{ name: 'GitHub', email: 'me', secret: '', urls: '', password: 'hunter2' }]);
  await page.reload();
  await page.locator('#home-list .lc-row', { hasText: 'GitHub' }).click();
  const pw = page.locator('#home-creds .home-cred').nth(1);
  await pw.locator('.home-cred-btn').first().click();
  await expect(pw.locator('.home-cred-value')).toHaveText('hunter2');
  await page.click('#btn-logout');
  await page.fill('#lock-password', 'test');
  await page.click('#lock-login-btn');
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);
  await expect(page.locator('#home-list .lc-row', { hasText: 'GitHub' })).toBeVisible();
  await page.locator('#home-list .lc-row', { hasText: 'GitHub' }).click();
  await expect(page.locator('#home-creds .home-cred').nth(1).locator('.home-cred-value')).toHaveText('•••••••');
});
