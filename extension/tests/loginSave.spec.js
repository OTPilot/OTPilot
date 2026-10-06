import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_PASSWORD, TEST_SECRET } from './fixtures.js';

// Saving a submitted sign-in (forms.js capture + background
// vaultCaptureLogin / vaultPendingLogin / vaultResolvePendingLogin).

const SITE = 'http://localhost:8765/test';

async function vaultWith(context, extensionId, accounts, local = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], ...local });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  return page;
}

const logins = page => page.evaluate(async () =>
  (await VaultStore.readAll(await VaultKeys.getKey())).items
    .filter(i => i.type === 'login')
    .map(i => ({
      title: i.title, urls: i.urls,
      username: Vault.getValue(i, 'username'), password: Vault.getValue(i, 'password'),
      history: (i.passwordHistory || []).map(h => h.value),
    })));

async function signIn(site, email, password, page = 'login-nav.html') {
  await site.goto(`${SITE}/${page}`);
  await site.fill('input[name="email"]', email);
  await site.fill('input[name="password"]', password);
  await site.click('button');
}

test('a new sign-in is offered on the next page and saved as a login', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await signIn(site, 'new@example.com', 'n3w-pass!');
  await expect(site).toHaveURL(/welcome\.html/);

  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('Save this login for localhost?');
  await expect(offer).toContainText('new@example.com');
  // The page's DOM never gets the password.
  expect(await site.locator('body').innerHTML()).not.toContain('n3w-pass!');

  await offer.locator('.otpilot-save-confirm').click();
  await expect(offer).toHaveCount(0);
  await expect.poll(() => logins(popup)).toEqual([
    { title: 'localhost', urls: ['localhost'], username: 'new@example.com', password: 'n3w-pass!', history: [] },
  ]);
  // Next time, the same sign-in is already saved: no offer.
  await signIn(site, 'new@example.com', 'n3w-pass!');
  await expect(site).toHaveURL(/welcome\.html/);
  await site.waitForTimeout(1000);
  await expect(offer).toHaveCount(0);
});

test('a changed password updates the saved login, keeping the old one in its history', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [
    { name: 'GitHub', email: 'me@example.com', secret: TEST_SECRET, urls: 'localhost', password: 'old-pass' },
  ]);
  const site = await context.newPage();
  await signIn(site, 'me@example.com', 'brand-new');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update the password for GitHub?');
  await expect(offer.locator('.otpilot-save-never')).toHaveCount(0);
  await offer.locator('.otpilot-save-confirm').click();

  await expect.poll(async () => (await logins(popup))[0]).toEqual({
    title: 'GitHub', urls: ['localhost'], username: 'me@example.com', password: 'brand-new', history: ['old-pass'],
  });
});

test('a single-page app that signs in without navigating gets the offer once the form is gone', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-spa.html`);
  await site.fill('input[name="user"]', 'spa@example.com');
  await site.fill('input[name="pass"]', 'spa-pass');
  await site.click('#go');
  await expect(site.locator('h1')).toHaveText('Dashboard');
  await expect(site.locator('#otpilot-login-save')).toContainText('spa@example.com');
});

test('no offer while a sign-in form is still showing (a rejected password)', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-nav.html`);
  await site.evaluate(() => { document.querySelector('form').action = 'login-nav.html'; });
  await site.fill('input[name="email"]', 'me@example.com');
  await site.fill('input[name="password"]', 'typo');
  await site.click('button');
  await expect(site).toHaveURL(/login-nav\.html\?/);
  await site.waitForTimeout(2500);
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);
});

test('"Never" stops the offers for that site; "Not now" just closes this one', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await signIn(site, 'a@example.com', 'p1');
  const offer = site.locator('#otpilot-login-save');
  await offer.locator('.otpilot-save-later').click();
  await expect(offer).toHaveCount(0);
  await site.reload();
  await site.waitForTimeout(800);
  await expect(offer).toHaveCount(0); // the pending sign-in was dropped

  await signIn(site, 'a@example.com', 'p1');
  await offer.locator('.otpilot-save-never').click();
  expect(await popup.evaluate(async () => (await chrome.storage.local.get('loginNeverSave')).loginNeverSave)).toEqual(['localhost']);
  await signIn(site, 'b@example.com', 'p2');
  await expect(site).toHaveURL(/welcome\.html/);
  await site.waitForTimeout(1000);
  await expect(offer).toHaveCount(0);
  expect(await logins(popup)).toEqual([]);
});

test('locked: the offer unlocks in the extension frame, then saves', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  await popup.evaluate(() => VaultLock.lock());
  const site = await context.newPage();
  await signIn(site, 'late@example.com', 'l4te');
  const frame = site.frameLocator('#otpilot-login-save iframe');
  await frame.locator('#pw').fill(TEST_PASSWORD);
  await frame.locator('#unlock').click();
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Save this login for localhost?');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup)).map(l => l.password)).toEqual(['l4te']);
});

test('the offer does not follow the user to another site', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-nav.html`);
  await site.evaluate(() => { document.querySelector('form').action = 'http://127.0.0.1:8765/test/welcome.html'; });
  await site.fill('input[name="email"]', 'me@example.com');
  await site.fill('input[name="password"]', 'secret');
  await site.click('button');
  await expect(site).toHaveURL(/127\.0\.0\.1.*welcome\.html/);
  await site.waitForTimeout(1500);
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);
});

test('Free plan at 50 items: a new login is not saved, the offer says why', async ({ context, extensionId }) => {
  const full = Array.from({ length: 50 }, (_, i) => ({ name: `Site ${i}`, email: '', secret: '', urls: `site${i}.example`, password: 'x' }));
  const popup = await vaultWith(context, extensionId, full, { userPlan: 'free' });
  const site = await context.newPage();
  await signIn(site, 'one@example.com', 'too-many');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-limit')).toContainText('50 items');
  await expect(offer.locator('.otpilot-save-confirm')).toHaveCount(0);
  // Even asked directly, the background refuses.
  expect((await logins(popup)).length).toBe(50);
});
