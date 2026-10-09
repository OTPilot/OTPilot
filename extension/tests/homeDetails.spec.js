import { test, expect, seedUnlocked, waitForVault, writeAccounts } from './fixtures.js';

// Home shows the selected account's details like the editor groups them:
// Sign-in, each custom-field section, notes and related items (a related note
// or card opens in place).

async function home(context, extensionId) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], obfuscated: false });
  await page.reload();
  await waitForVault(page);
  await writeAccounts(page, [
    { name: 'Banco Galicia', email: 'alberto.p', secret: '', urls: 'onlinebanking.bancogalicia.com.ar', password: 'pw-1234',
      notes: 'Branch 089 — Palermo',
      customFields: [
        { label: 'CBU', value: '0070089020004021339812', kind: 'text', section: 'Bank details' },
        { label: 'Phone PIN', value: '4321', kind: 'password', section: 'Bank details' },
        { label: 'Customer no.', value: '77', kind: 'text' },
      ] },
    { name: 'Other', email: 'x', secret: '', urls: '', password: 'y' },
  ]);
  // A note and a server linked to the bank login.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const { items } = await VaultStore.readAll(key);
    const bank = items.find(i => i.title === 'Banco Galicia');
    const note = Vault.newItem('note', { title: 'Security questions', notes: 'First pet: Rex', links: [bank.id] });
    const server = Vault.newItem('server', { title: 'Token server', links: [bank.id] });
    Vault.getField(server, 'host').value = 'token.galicia.example';
    await VaultStore.save([note, server], key);
  });
  await page.reload();
  await waitForVault(page);
  await page.locator('#home-list .lc-row', { hasText: 'Banco Galicia' }).click();
  return page;
}

test('Home shows the account in sections: sign-in, field sections, notes, related', async ({ context, extensionId }) => {
  const page = await home(context, extensionId);
  const heads = page.locator('#home-creds .home-sec-head');
  await expect(heads).toHaveText([/Sign-in/i, /More fields/i, /Bank details/i, /Notes/i, /Related · 2/i]);
  // No 2FA code: no code block, no Copy / Fill.
  await expect(page.locator('#otp-display')).toBeHidden();
  await expect(page.locator('#btn-fill')).toBeHidden();

  const bank = page.locator('#home-creds .home-sec', { hasText: 'Bank details' });
  const pin = bank.locator('.home-cred', { hasText: 'Phone PIN' });
  await expect(pin.locator('.home-cred-value')).toHaveText('••••');
  await pin.locator('.home-cred-btn', { hasText: 'Show' }).click();
  await expect(pin.locator('.home-cred-value')).toHaveText('4321');
  await bank.locator('.home-cred', { hasText: 'CBU' }).locator('.home-cred-btn', { hasText: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('0070089020004021339812');

  // A related note opens in place with its text.
  const related = page.locator('#home-creds .home-sec', { hasText: 'Related' });
  await related.locator('.home-rel-head', { hasText: 'Security questions' }).click();
  await expect(related.locator('.home-rel-body')).toContainText('First pet: Rex');
  // "Open in vault" goes to the editor on that note.
  await related.locator('.home-rel-edit').click();
  await expect(page.locator('#acc-detail .item-title')).toHaveValue('Security questions');
});

test('a related login is selected on Home', async ({ context, extensionId }) => {
  const page = await home(context, extensionId);
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const { items } = await VaultStore.readAll(key);
    const other = items.find(i => i.title === 'Other');
    const bank = items.find(i => i.title === 'Banco Galicia');
    await VaultStore.save([{ ...other, links: [bank.id] }], key);
  });
  await page.reload();
  await waitForVault(page);
  await page.locator('#home-list .lc-row', { hasText: 'Banco Galicia' }).click();
  await page.locator('#home-creds .home-rel-head', { hasText: 'Other' }).click();
  await expect(page.locator('#account-name')).toHaveText('Other');
  await expect(page.locator('#home-creds .home-rel-head')).toContainText('Banco Galicia');
});
