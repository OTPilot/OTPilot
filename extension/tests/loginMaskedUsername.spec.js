import { test, expect, seedUnlocked, waitForVault, writeAccounts } from './fixtures.js';

// A password-type field that asks for the username (BBVA's "Usuario") next to
// the real password field: the username, never a new or a current password.

const SITE = 'http://localhost:8765/test';

async function vaultWith(context, extensionId, accounts) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  return page;
}

const logins = page => page.evaluate(async () =>
  (await VaultStore.readAll(await VaultKeys.getKey())).items
    .filter(i => i.type === 'login')
    .map(i => ({ title: i.title, username: Vault.getValue(i, 'username'), password: Vault.getValue(i, 'password'), fields: (i.fields || []).filter(f => f.custom).length })));

test('a masked username and the password both get a sign-in badge, and no password suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html`);
  await expect(site.locator('.otpilot-field-badge[data-kind="login"]')).toHaveCount(2);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
  for (const name of ['username', 'password']) {
    await site.locator(`input[name="${name}"]`).focus();
    await site.waitForTimeout(500);
    await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  }
});

test('a login without extra fields fills the masked username and the password', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ name: 'BBVA', email: 'user-77', secret: '', urls: 'localhost', password: 'clave-1' }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html`);
  await site.locator('#otpilot-login-fill .otpilot-login-choice').click();
  await expect(site.locator('#result')).toHaveText(/clave-1/, { timeout: 5000 });
  const sent = JSON.parse(await site.locator('#result').textContent());
  // The number and the type are left as they were (empty, DNI).
  expect(sent).toEqual({ documentType: '01', documentNumber: '', username: 'user-77', password: 'clave-1' });
});

test('the masked username is saved as the username, the other field as the password', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?spa=1`);
  await site.fill('input[name="username"]', 'user-99');
  await site.fill('input[name="password"]', 'clave-9');
  await site.click('x-button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('user-99');
  await expect(offer.locator('.otpilot-save-extras')).toHaveCount(0);
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(() => logins(popup)).toEqual([{ title: 'localhost', username: 'user-99', password: 'clave-9', fields: 0 }]);
});

// Never a masked username: a password field named after the account / login
// on a sign-up or change-password form is that account's password.
const EDGE = `${SITE}/login-extras-edge.html`;

for (const field of ['accountPassword', 'login']) {
  test(`sign-up: a password field "${field}" before the confirmation is a new password (the generator is offered)`, async ({ context, extensionId }) => {
    await vaultWith(context, extensionId, []);
    const site = await context.newPage();
    await site.goto(`${EDGE}?mode=signup-mask&field=${field}`);
    await site.fill('input[name="email"]', 'new@example.com');
    await site.focus(`input[name="${field}"]`);
    await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
    await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(2);
    await expect(site.locator('.otpilot-field-badge[data-kind="login"]')).toHaveCount(0);
  });

  const current = field === 'login' ? 'login' : 'loginPassword';
  test(`change password: the current password "${current}" is not the username; the new one gets the generator`, async ({ context, extensionId }) => {
    const popup = await vaultWith(context, extensionId, []);
    const site = await context.newPage();
    await site.goto(`${EDGE}?mode=change-mask&field=${field === 'login' ? 'login' : 'loginPassword'}`);
    await site.focus('input[name="newPassword"]');
    await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
    await site.locator('#otpilot-password-suggest .otpilot-overlay-close').click();
    await site.fill(`input[name="${current}"]`, 'old-pw-1');
    await site.fill('input[name="newPassword"]', 'new-pw-1');
    await site.fill('input[name="confirmPassword"]', 'new-pw-1');
    await site.click('button');
    const offer = site.locator('#otpilot-login-save');
    await expect(offer).toBeVisible();
    // No username: the current password was never taken for one.
    expect(await offer.innerText()).not.toContain('old-pw-1');
    await offer.locator('.otpilot-save-confirm').click();
    await expect.poll(() => logins(popup)).toEqual([{ title: 'localhost', username: '', password: 'new-pw-1', fields: 0 }]);
  });
}

// "pin" between non-letters (account_pin) or as a camelCase part (accountPin)
// is a PIN, never a username; inside a word (shipping) it says nothing.
for (const [field, isUsername] of [['account_pin', false], ['accountPin', false], ['shipping_user', true]]) {
  test(`a password field "${field}" before the password ${isUsername ? 'is' : 'is not'} the masked username`, async ({ context, extensionId }) => {
    const popup = await vaultWith(context, extensionId, []);
    const site = await context.newPage();
    await site.goto(`${EDGE}?mode=pin&field=${field}`);
    await site.fill(`input[name="${field}"]`, 'first-77');
    await site.fill('input[name="password"]', 'second-77');
    await site.click('button');
    await expect(site.locator('h1')).toHaveText('Done');
    const offer = site.locator('#otpilot-login-save');
    await expect(offer).toBeVisible();
    if (isUsername) await expect(offer).toContainText('first-77');
    else expect(await offer.innerText()).not.toContain('first-77');
    await offer.locator('.otpilot-save-confirm').click();
    await expect.poll(async () => (await logins(popup)).length).toBe(1);
    const [login] = await logins(popup);
    if (isUsername) expect(login).toEqual({ title: 'localhost', username: 'first-77', password: 'second-77', fields: 0 });
    else expect(login.username).toBe('');
  });
}
