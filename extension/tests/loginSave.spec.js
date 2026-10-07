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

// ── Review hardening ─────────────────────────────────────────────────────────

test('a page script cannot click the overlays to fill or save credentials', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{ name: 'GitHub', email: 'me@example.com', secret: '', urls: 'localhost', password: 'hunter2!' }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  await expect(site.locator('#otpilot-login-fill .otpilot-login-choice')).toBeVisible();
  await site.evaluate(() => document.querySelector('.otpilot-login-choice').click());
  await site.waitForTimeout(500);
  await expect(site.locator('input[name="password"]')).toHaveValue('');

  await signIn(site, 'new@example.com', 'pw');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-confirm')).toBeVisible();
  await site.evaluate(() => document.querySelector('.otpilot-save-confirm').click());
  await site.waitForTimeout(500);
  expect((await logins(popup)).map(l => l.username)).toEqual(['me@example.com']);
});

test('the offer shows on a parent or subdomain of the signed-in host, not on a sibling', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  const signInVia = async (from, to) => {
    await site.goto(`http://${from}:8765/test/login-nav.html`);
    await site.evaluate(t => { document.querySelector('form').action = `http://${t}:8765/test/welcome.html`; }, to);
    await site.fill('input[name="email"]', 'me@example.com');
    await site.fill('input[name="password"]', 'pw');
    await site.click('button');
    await expect(site).toHaveURL(new RegExp(`${to}.*welcome`));
  };
  await signInVia('login.localhost', 'app.localhost');
  await site.waitForTimeout(1500);
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);

  await signInVia('login.localhost', 'localhost');
  await expect(site.locator('#otpilot-login-save')).toContainText('login.localhost');
});

test('a single-page sign-in slower than the first check still gets the offer', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-spa.html?delay=3500`);
  await site.fill('input[name="user"]', 'slow@example.com');
  await site.fill('input[name="pass"]', 'slow');
  await site.click('#go');
  await expect(site.locator('h1')).toHaveText('Dashboard', { timeout: 6000 });
  await expect(site.locator('#otpilot-login-save')).toContainText('slow@example.com');
});

test('Cancel is not a sign-in: no offer', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-spa.html`);
  await site.fill('input[name="user"]', 'me@example.com');
  await site.fill('input[name="pass"]', 'typed');
  await site.click('#cancel');
  await expect(site.locator('h1')).toHaveText('Welcome');
  await site.waitForTimeout(2500);
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);
});

test('an open offer only ever saves the sign-in it showed', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-spa.html`);
  await site.fill('input[name="user"]', 'first@example.com');
  await site.fill('input[name="pass"]', 'one');
  await site.click('#go');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('first@example.com');
  // Another sign-in on the same page replaces the pending capture.
  await site.evaluate(() => showForm());
  await site.fill('input[name="user"]', 'second@example.com');
  await site.fill('input[name="pass"]', 'two');
  await site.click('#go');
  await expect(site.locator('h1')).toHaveText('Dashboard');
  await offer.locator('.otpilot-save-confirm').click(); // still the first offer
  await site.waitForTimeout(500);
  expect(await logins(popup)).toEqual([]);
});

test('Update picks the login with the exact username when several differ only by case', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [
    { name: 'Upper', email: 'Alice@x.com', secret: '', urls: 'localhost', password: 'a1' },
    { name: 'Lower', email: 'alice@x.com', secret: '', urls: 'localhost', password: 'a2' },
  ]);
  const site = await context.newPage();
  await signIn(site, 'alice@x.com', 'changed');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update the password for Lower?');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup)).map(l => [l.title, l.password]).sort()).toEqual([['Lower', 'changed'], ['Upper', 'a1']]);
});

test('Free plan at 50 items: a 2FA-only login does not gain a password through Update', async ({ context, extensionId }) => {
  const full = Array.from({ length: 50 }, (_, i) => ({ name: `Site ${i}`, email: '', secret: '', urls: `site${i}.example`, password: 'x' }));
  const popup = await vaultWith(context, extensionId, [...full, { name: 'Local', email: 'me@example.com', secret: TEST_SECRET, urls: 'localhost' }], { userPlan: 'free' });
  const site = await context.newPage();
  await signIn(site, 'me@example.com', 'would-count');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update the password for Local?');
  await expect(offer.locator('.otpilot-save-limit')).toBeVisible();
  await expect(offer.locator('.otpilot-save-confirm')).toHaveCount(0);
  expect((await logins(popup)).find(l => l.title === 'Local').password).toBe('');
});

test('an index from before hasPassword is rebuilt on unlock, so a locked vault offers to fill again', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{ name: 'GitHub', email: 'me@example.com', secret: '', urls: 'localhost', password: 'hunter2!' }]);
  await popup.evaluate(async () => {
    const index = (await chrome.storage.local.get('vaultIndex')).vaultIndex.map(({ hasPassword, ...e }) => e);
    await chrome.storage.local.set({ vaultIndex: index });
    await VaultLock.lock();
    await VaultLock.unlock('test');
    await VaultLock.lock();
  });
  expect((await popup.evaluate(() => VaultAccounts.readIndex())).map(e => e.hasPassword)).toEqual([true]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  await expect(site.frameLocator('#otpilot-login-fill iframe').locator('#label')).toContainText('GitHub');
});
