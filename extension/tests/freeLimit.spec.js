import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';

// The Free plan's 50-item limit in the account editor (2FA-only logins don't
// count; over the limit, existing items stay editable).

const counted = n => Array.from({ length: n }, (_, i) => ({ name: `Site ${String(i).padStart(2, '0')}`, email: '', secret: '', urls: '', password: 'x' }));

async function editorWith(context, extensionId, accounts, plan = 'free') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], userPlan: plan });
  await page.reload();
  await waitForVault(page);
  await writeAccounts(page, accounts);
  await page.reload();
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row')).toHaveCount(accounts.length);
  return page;
}

const itemCount = page => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items.length);

async function addAccount(page, name, { password = '', secret = '' } = {}) {
  await page.click('#btn-add');
  await page.fill('.acc-body.open .acc-name, #acc-detail .acc-name', name);
  if (password) await page.fill('#acc-detail .acc-password', password);
  if (secret) await page.fill('#acc-detail .acc-secret', secret);
  await page.click('#btn-save-all');
}

test('at 50 counted items, adding a login with a password is refused and nothing changes', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(50));
  await addAccount(page, 'One too many', { password: 'p' });
  await expect(page.locator('#status-msg')).toContainText('Free plan holds 50 items');
  expect(await itemCount(page)).toBe(50);
  // The draft is still there to remove or keep after upgrading.
  await expect(page.locator('.acc-row')).toHaveCount(51);
});

test('2FA-only logins are not limited', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(50));
  await addAccount(page, 'Codes only', { secret: TEST_SECRET });
  await expect.poll(() => itemCount(page)).toBe(51);
});

test('a paid plan is not limited', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(50), 'personal');
  await addAccount(page, 'Fifty-one', { password: 'p' });
  await expect.poll(() => itemCount(page)).toBe(51);
});

test('over the limit, existing items stay editable but a 2FA-only login cannot gain a password', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, [...counted(52), { name: 'ZZ Codes', email: '', secret: TEST_SECRET, urls: '' }]);

  await page.locator('.acc-head', { hasText: 'Site 00' }).click();
  await page.fill('#acc-detail .acc-name', 'Site 00 renamed');
  await page.click('#btn-save-all');
  await expect.poll(() => page.evaluate(async () =>
    (await VaultStore.readAll(await VaultKeys.getKey())).items.some(i => i.title === 'Site 00 renamed'))).toBe(true);

  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'ZZ Codes' }).click();
  await page.fill('#acc-detail .acc-password', 'now-counted');
  await page.click('#btn-save-all');
  await expect(page.locator('#status-msg')).toContainText('Free plan holds 50 items');
  const pw = await page.evaluate(async () =>
    Vault.getValue((await VaultStore.readAll(await VaultKeys.getKey())).items.find(i => i.title === 'ZZ Codes'), 'password'));
  expect(pw).toBe('');
});

test('an account added while the limit check runs is not saved unchecked', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(49));
  await addAccount(page, 'Fiftieth', { password: 'p' });
  await expect.poll(() => itemCount(page)).toBe(50);

  // The check is slow; the user clicks Add again meanwhile.
  await page.click('#nav-settings');
  await page.evaluate(() => {
    const real = VaultAccounts.exceedsFreeLimit;
    VaultAccounts.exceedsFreeLimit = async (...args) => {
      const r = await real(...args);
      document.getElementById('btn-add').click();
      return r;
    };
  });
  await page.locator('.acc-head', { hasText: 'Site 00' }).click();
  await page.fill('#acc-detail .acc-name', 'Site 00 renamed');
  await page.click('#btn-save-all');
  await expect(page.locator('#status-msg')).toContainText('changed while saving');
  expect(await itemCount(page)).toBe(50);
});

test('a failed limit check saves nothing', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(2));
  await page.evaluate(() => { VaultAccounts.exceedsFreeLimit = async () => { throw new Error('storage hiccup'); }; });
  await addAccount(page, 'Third', { password: 'p' });
  await expect(page.locator('#status-msg')).toContainText('Could not check the Free plan limit');
  expect(await itemCount(page)).toBe(2);
});

test('a sync that deleted an account above the open one does not misplace the open edit on Save', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, [
    { name: 'Alpha', email: '', secret: TEST_SECRET, urls: '' },
    { name: 'Bravo', email: '', secret: 'GEZDGNBVGY3TQOJQ', urls: '' },
  ]);
  await page.locator('.acc-head', { hasText: 'Bravo' }).click();
  await page.fill('#acc-detail .acc-name', 'Bravo renamed');
  // Another device deleted Alpha; the sync lands while Bravo is open.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const alpha = (await VaultStore.readAll(key)).items.find(i => i.title === 'Alpha');
    await VaultStore.remove([alpha.id]);
    await reloadFromVault(key);
  });
  await page.click('#btn-save-all');
  await expect.poll(() => page.evaluate(async () =>
    (await VaultStore.readAll(await VaultKeys.getKey())).items.map(i => [i.title, i.totp?.secret]))).toEqual([['Bravo renamed', 'GEZDGNBVGY3TQOJQ']]);
});
