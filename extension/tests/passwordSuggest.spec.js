import { test, expect, seedUnlocked, waitForVault } from './fixtures.js';

// A generated password offered on new-password fields (forms.js + generator.js).

const SITE = 'http://localhost:8765/test';

async function vaultWith(context, extensionId, local = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], ...local });
  await page.reload();
  await waitForVault(page);
  return page;
}

test('focusing a new-password field suggests one; Use fills it and its confirmation, and the sign-up can be saved', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/signup-confirm.html`);
  await site.fill('input[name="email"]', 'new@example.com');
  await site.focus('input[name="pw"]');

  const offer = site.locator('#otpilot-password-suggest');
  await expect(offer).toBeVisible();
  const first = await offer.locator('.otpilot-gen-value').textContent();
  expect(first).toHaveLength(16);
  await offer.locator('.otpilot-gen-again').click();
  const value = await offer.locator('.otpilot-gen-value').textContent();
  expect(value).not.toBe(first);

  await offer.locator('.otpilot-gen-use').click();
  await expect(offer).toHaveCount(0);
  await expect(site.locator('input[name="pw"]')).toHaveValue(value);
  await expect(site.locator('input[name="pw2"]')).toHaveValue(value);

  await site.click('button');
  const save = site.locator('#otpilot-login-save');
  await expect(save).toContainText('Save this login for localhost?');
  await save.locator('.otpilot-save-confirm').click();
  await expect.poll(() => popup.evaluate(async () =>
    (await VaultStore.readAll(await VaultKeys.getKey())).items.map(i => [Vault.getValue(i, 'username'), Vault.getValue(i, 'password')])))
    .toEqual([['new@example.com', value]]);
});

test('the suggestion follows the generator settings, but is always a password', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, { generatorOptions: { mode: 'pin', length: 24, symbols: false } });
  const site = await context.newPage();
  await site.goto(`${SITE}/signup-confirm.html`);
  await site.focus('input[name="pw"]');
  await expect(site.locator('#otpilot-password-suggest .otpilot-gen-value')).toHaveText(/^[A-Za-z0-9]{24}$/);
});

test('no suggestion on a sign-in password field', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  await site.focus('input[name="password"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
});
