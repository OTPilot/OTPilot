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

test('an account with a code and many details can always scroll back to its code', async ({ context, extensionId }) => {
  const page = await home(context, extensionId);
  await page.evaluate(async secret => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `Field ${i}`, value: `value ${i}`, kind: 'text' }));
    accounts[accounts.findIndex(a => a.name === 'Banco Galicia')] = { ...accounts.find(a => a.name === 'Banco Galicia'), secret, customFields: many };
    startTimer();
  }, 'JBSWY3DPEHPK3PXP');
  await expect(page.locator('#otp-display')).toBeVisible();
  const box = await page.locator('#home-detail').evaluate(el => {
    el.scrollTop = 0;
    const top = el.getBoundingClientRect().top;
    return { overflows: el.scrollHeight > el.clientHeight, codeTop: document.getElementById('otp-display').getBoundingClientRect().top - top };
  });
  expect(box.overflows).toBe(true);
  expect(box.codeTop).toBeGreaterThanOrEqual(0);
});

test('a related login is found by id, even after the list is re-sorted', async ({ context, extensionId }) => {
  const page = await home(context, extensionId);
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const { items } = await VaultStore.readAll(key);
    const bank = items.find(i => i.title === 'Banco Galicia');
    await VaultStore.save([{ ...bank, links: [items.find(i => i.title === 'Other').id] }], key);
  });
  await page.reload();
  await waitForVault(page);
  await page.locator('#home-list .lc-row', { hasText: 'Banco Galicia' }).click();
  await expect(page.locator('#home-creds .home-rel-head', { hasText: 'Other' })).toBeVisible();
  // The list order changes under the rendered details (e.g. a sync re-sorted it).
  await page.evaluate(() => {
    const bank = accounts.find(a => a.name === 'Banco Galicia');
    accounts.reverse();
    activeIndex = accounts.indexOf(bank);
    accounts.splice(activeIndex, 0, { name: 'Wrong', email: '', secret: '', urls: '', _id: 'wrong' });
    activeIndex++;
  });
  await page.locator('#home-creds .home-rel-head', { hasText: 'Other' }).click();
  await expect(page.locator('#account-name')).toHaveText('Other');
});

test('"Open in vault" shows the item even under another type filter', async ({ context, extensionId }) => {
  const page = await home(context, extensionId);
  await page.click('#nav-settings');
  await page.locator('#vault-type-bar .type-pill', { hasText: /Server/ }).click();
  await page.click('#nav-home');
  await page.locator('#home-list .lc-row', { hasText: 'Banco Galicia' }).click();
  const related = page.locator('#home-creds .home-sec', { hasText: 'Related' });
  await related.locator('.home-rel-head', { hasText: 'Security questions' }).click();
  await related.locator('.home-rel-edit').click();
  await expect(page.locator('#acc-detail .item-title')).toHaveValue('Security questions');
  await expect(page.locator('.acc-row:visible .acc-head', { hasText: 'Security questions' })).toHaveCount(1);
});
