import { test, expect, seedUnlocked, waitForVault, writeAccounts } from './fixtures.js';

// A bank PIN that is a read-only password field typed on an on-screen keypad
// (ABANCA): still a sign-in. A read-only "••••" shown as information is not.

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
    .map(i => ({ title: i.title, username: Vault.getValue(i, 'username'), password: Vault.getValue(i, 'password') })));

const abanca = { name: 'ABANCA', email: '12345678Z', secret: '', urls: 'localhost', password: '135246' };

test('the read-only PIN gets a sign-in badge, and the pick fills the NIF and the PIN, keeping it read-only', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [abanca]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-readonly-pin.html?hold=1`);
  await expect(site.locator('.otpilot-field-badge[data-kind="login"]')).toHaveCount(2);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);

  const overlay = site.locator('#otpilot-login-fill');
  await expect(overlay).toBeVisible();
  await overlay.locator('.otpilot-login-choice').click();
  // Autosubmit: the page's handler wrote what it was sent.
  await expect(site.locator('#result')).toHaveText(/pin/, { timeout: 5000 });
  expect(JSON.parse(await site.locator('#result').textContent())).toEqual({ card01: '12345678Z', pin: '135246', readonly: true });
  await expect(site.locator('#pin_number')).toHaveAttribute('readonly', '');
});

test('the read-only PIN form is submitted natively when the pick is a form submit (no password in the DOM before)', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [abanca]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-readonly-pin.html`);
  expect(await site.content()).not.toContain('135246');
  await site.locator('#otpilot-login-fill .otpilot-login-choice').click();
  await expect(site).toHaveURL(/welcome\.html\?card01=12345678Z&pin_number=135246/);
});

test('a PIN typed on the keypad and submitted with Access is offered for saving', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-readonly-pin.html`);
  await site.fill('#card01', '87654321X');
  for (const d of '246135') await site.locator('#keypad button', { hasText: d }).click();
  await expect(site.locator('#pin_number')).toHaveValue('246135');
  await site.getByRole('button', { name: 'Access' }).click();
  await expect(site).toHaveURL(/welcome\.html/);
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('87654321X');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(() => logins(popup)).toEqual([{ title: 'localhost', username: '87654321X', password: '246135' }]);
});

test('a read-only "••••" shown as information: no badge, no offer, nothing saved', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [abanca]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-readonly-display.html`);
  await site.waitForTimeout(1500);
  await expect(site.locator('.otpilot-field-badge')).toHaveCount(0);
  await expect(site.locator('#otpilot-login-fill')).toHaveCount(0);
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);
  await expect.poll(() => logins(popup)).toHaveLength(1);
});

test('a read-only "••••" already filled in a settings form with a Save button is no password: never captured, never holds back the offer', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-extras-edge.html?mode=settings`);
  await site.fill('input[name="user"]', 'set-user');
  await site.fill('input[name="password"]', 'set-pw');
  await site.click('button');
  // The account page: its read-only PIN and Save.
  await expect(site.locator('input[name="pin"]')).toHaveValue('••••');
  await site.locator('#settings button').click();
  expect(await site.evaluate(() => window.__settingsSaved)).toBe(1);

  // The sign-in is offered (the read-only field doesn't count as a password
  // form still showing), and Save on the settings form captured nothing.
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('set-user');
  const session = await popup.evaluate(() => chrome.storage.session.get(null));
  expect(JSON.stringify(session)).not.toContain('••••');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(() => logins(popup)).toEqual([{ title: 'localhost', username: 'set-user', password: 'set-pw' }]);
});
