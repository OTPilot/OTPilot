import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';

// The Vault view with every item type: secure notes, servers, API credentials
// next to logins, multiple tags, and the type filter.

async function vault(context, extensionId, { accounts = [], items = [], plan } = {}) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], ...(plan ? { userPlan: plan } : {}) });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  if (items.length) {
    await page.evaluate(async list => {
      const key = await VaultKeys.getKey();
      await VaultStore.save(list.map(([type, over, fields]) => {
        const item = Vault.newItem(type, over);
        for (const [id, value] of Object.entries(fields || {})) Vault.getField(item, id).value = value;
        return item;
      }), key);
    }, items);
  }
  await page.reload();
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row')).toHaveCount(accounts.length + items.length);
  return page;
}

const stored = page => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
  .map(i => ({ type: i.type, title: i.title, tags: i.tags, notes: i.notes, fields: Object.fromEntries((i.fields || []).map(f => [f.id, f.value])), updatedAt: i.updatedAt }))
  .sort((a, b) => a.title.localeCompare(b.title)));

test('Add offers every type, and the planned ones as Soon', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await page.click('#btn-add');
  await expect(page.locator('#add-type-menu [data-add-type]')).toHaveText(['Login', 'Secure note', 'Server', 'API credential']);
  await expect(page.locator('#add-type-menu .add-type.soon').first()).toBeDisabled();
  await expect(page.locator('#add-type-menu .add-type.soon')).toHaveCount(8);
  // A click elsewhere closes it.
  await page.click('#acc-detail');
  await expect(page.locator('#add-type-menu')).toBeHidden();
});

test('a secure note with a category and more tags is saved as a note item', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'GitHub', email: '', secret: TEST_SECRET, urls: '' }] });
  await page.click('#btn-add');
  await page.click('[data-add-type="note"]');
  await page.fill('#acc-detail .item-title', 'Wifi oficina');
  await page.fill('#acc-detail .item-notes', 'SSID: Office\nPass: hunter2');
  await page.locator('#acc-detail .cat-choice.new').click();
  await page.fill('#acc-detail .cat-new-input', 'Office');
  await page.fill('#acc-detail .acc-more-tags', 'network, office ,network');
  await page.click('#btn-save-all');

  await expect.poll(() => stored(page)).toEqual([
    expect.objectContaining({ type: 'login', title: 'GitHub' }),
    expect.objectContaining({ type: 'note', title: 'Wifi oficina', notes: 'SSID: Office\nPass: hunter2', tags: ['Office', 'network', 'office'] }),
  ]);
  // The list shows it with its type, and the type filter appears.
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row', { hasText: 'Wifi oficina' }).locator('.type-tag')).toHaveText('Secure note');
  await expect(page.locator('#vault-type-bar .type-pill')).toHaveText([/All\s*2/, /Logins\s*1/, /Secure notes\s*1/]);
  await page.locator('#vault-type-bar .type-pill', { hasText: 'Secure notes' }).click();
  await expect.poll(() => page.locator('.acc-row').evaluateAll(rows =>
    rows.filter(r => r.style.display !== 'none').map(r => r.querySelector('.acc-head-name').textContent))).toEqual(['Wifi oficina']);
  // Any tag filters, not only the first.
  await page.locator('#vault-type-bar .type-pill', { hasText: 'All' }).click();
  await page.locator('#vault-cat-bar .cat-pill', { hasText: 'network' }).click();
  await expect.poll(() => page.locator('.acc-row').evaluateAll(rows =>
    rows.filter(r => r.style.display !== 'none').length)).toBe(1);
});

test('a server: template fields, masked password with show, generate and copy', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await page.click('#btn-add');
  await page.click('[data-add-type="server"]');
  await page.fill('#acc-detail .item-title', 'Prod DB');
  await page.fill('#acc-detail .item-field[data-id="host"]', 'db.internal');
  await page.fill('#acc-detail .item-field[data-id="port"]', '5432');
  await page.fill('#acc-detail .item-field[data-id="username"]', 'admin');
  const pw = page.locator('#acc-detail .item-field[data-id="password"]');
  await expect(pw).toHaveAttribute('type', 'password');
  await pw.locator('xpath=..').locator('.btn-gen-password').click();
  await expect(pw).toHaveAttribute('type', 'text');
  const generated = await pw.inputValue();
  expect(generated).toHaveLength(16);
  await pw.locator('xpath=..').locator('.btn-copy-field').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(generated);
  await page.click('#btn-save-all');

  await expect.poll(async () => (await stored(page))[0]?.fields).toEqual({ host: 'db.internal', port: '5432', username: 'admin', password: generated });
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row', { hasText: 'Prod DB' }).locator('.acc-head-email')).toHaveText('db.internal · admin');
});

test('editing one item rewrites only that item; deleting one removes it', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { items: [
    ['api', { title: 'Stripe' }, { apiKey: 'sk_live_1', environment: 'prod' }],
    ['note', { title: 'Untouched', notes: 'keep me' }],
    ['note', { title: 'Old note', notes: 'bye' }],
  ] });
  const before = await stored(page);
  await page.locator('.acc-head', { hasText: 'Stripe' }).click();
  await page.fill('#acc-detail .item-field[data-id="apiKey"]', 'sk_live_2');
  await page.locator('.acc-head', { hasText: 'Old note' }).click();
  page.once('dialog', d => d.accept());
  await page.click('#acc-detail .btn-del');
  await page.click('#btn-save-all');

  await expect.poll(async () => (await stored(page)).map(i => i.title)).toEqual(['Stripe', 'Untouched']);
  const after = await stored(page);
  expect(after[0].fields.apiKey).toBe('sk_live_2');
  expect(after[1].updatedAt).toBe(before.find(i => i.title === 'Untouched').updatedAt);
  // The deletion is a tombstone, so sync carries it to other devices.
  expect(await page.evaluate(async () => Object.keys(await VaultStore.listTombstones()).length)).toBe(1);
});

test('Free plan: a secure note counts toward the 50 items', async ({ context, extensionId }) => {
  const full = Array.from({ length: 50 }, (_, i) => ({ name: `Site ${String(i).padStart(2, '0')}`, email: '', secret: '', urls: '', password: 'x' }));
  const page = await vault(context, extensionId, { accounts: full, plan: 'free' });
  await page.click('#btn-add');
  await page.click('[data-add-type="note"]');
  await page.fill('#acc-detail .item-title', 'One too many');
  await page.click('#btn-save-all');
  await expect(page.locator('#status-msg')).toContainText('Free plan holds 50 items');
  expect((await stored(page)).length).toBe(50);
});

test('logins get more tags too, and the category bar offers them', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'GitHub', email: '', secret: TEST_SECRET, urls: '', category: 'Work' }] });
  await page.locator('.acc-head', { hasText: 'GitHub' }).click();
  await expect(page.locator('#acc-detail .acc-more-tags')).toHaveValue('');
  await page.fill('#acc-detail .acc-more-tags', 'oss, critical');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await stored(page))[0].tags).toEqual(['Work', 'oss', 'critical']);
  await page.click('#nav-settings');
  await expect(page.locator('#vault-cat-bar .cat-pill')).toHaveText([/All/, /critical/, /oss/, /Work/]);
});

test('an item changed by a sync while the editor is open, but untouched here, keeps the synced version', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { items: [['note', { title: 'Shared', notes: 'v1' }], ['note', { title: 'Mine', notes: 'a' }]] });
  await page.locator('.acc-head', { hasText: 'Mine' }).click();
  await page.fill('#acc-detail .item-notes', 'b');
  // Another device edits "Shared"; the sync lands while the editor is open.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const shared = (await VaultStore.readAll(key)).items.find(i => i.title === 'Shared');
    await VaultStore.save({ ...shared, notes: 'v2 from elsewhere', updatedAt: new Date(Date.now() + 1000).toISOString() }, key);
    await reloadFromVault(key);
  });
  await page.click('#btn-save-all');
  await expect.poll(async () => (await stored(page)).map(i => [i.title, i.notes])).toEqual([['Mine', 'b'], ['Shared', 'v2 from elsewhere']]);
});
