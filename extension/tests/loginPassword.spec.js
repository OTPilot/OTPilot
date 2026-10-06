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
  await expect(page.locator('#otp-display')).toHaveText('No 2FA code');
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
