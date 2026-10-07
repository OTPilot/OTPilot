import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';
import { installFakeCollections } from './fakeCollections.js';

// Team collections in the popup: managed from the Team tab, their items in
// the Vault view (saved straight to the collection), moving personal items in.

const TEAM = { id: 'team-1', name: 'Acme', owner_id: 'user-me' };

async function teamPopup(context, extensionId, accounts = []) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], userPlan: 'team_lite' });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) {
    await writeAccounts(page, accounts);
    await page.evaluate(async () => reloadFromVault(await VaultKeys.getKey()));
  }
  await installFakeCollections(page);
  // A teammate with a keypair of their own; the team API stubbed.
  await page.evaluate(async team => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const pub = VaultCrypto.b64e(await crypto.subtle.exportKey('raw', kp.publicKey));
    fake.emails['user-bob'] = 'bob@team.test';
    fake.emails['user-new'] = 'new@team.test';
    Sharing.getMyTeam = async () => team;
    Sharing.getMembers = async () => [
      { user_id: 'user-me', email: 'me@team.test', role: 'owner', public_key: await TeamKeys.getPublicKeyB64() },
      { user_id: 'user-bob', email: 'bob@team.test', role: 'member', public_key: pub },
      { user_id: 'user-new', email: 'new@team.test', role: 'member', public_key: null },
    ];
    SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } });
  }, TEAM);
  return page;
}

async function openTeam(page) {
  await page.evaluate(() => showView('team'));
  await expect(page.locator('#collection-create-row')).toBeVisible();
}

test('Team tab: create a collection, add a teammate with a role, a not-yet-signed-in one is refused', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId);
  await openTeam(page);
  await page.fill('#collection-new-name', 'Infra');
  await page.click('#collection-create');
  const row = page.locator('.coll-row', { hasText: 'Infra' });
  await expect(row).toBeVisible();
  await expect(row.locator('.coll-member')).toContainText(['me@team.test (you)']);

  await row.locator('.coll-add select.who').selectOption('user-new');
  await row.locator('.coll-add-btn').click();
  await expect(page.locator('#status-msg')).toContainText('sign in to OTPilot once');

  await row.locator('.coll-add select.who').selectOption('user-bob');
  await row.locator('.coll-new-role').selectOption('view');
  await row.locator('.coll-add-btn').click();
  await expect(page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-member', { hasText: 'bob@team.test' })).toBeVisible();
  const role = await page.evaluate(() => [...fake.collections.values()][0].members.get('user-bob').role);
  expect(role).toBe('view');
});

test('removing a teammate suggests changing the passwords they could see', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId);
  await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    const db = Vault.newItem('server', { title: 'Prod DB' });
    Vault.getField(db, 'password').value = 'pw';
    await VaultCollections.save(c, db);
    await VaultCollections.save(c, Vault.newItem('note', { title: 'Just a note' }));
    fake.collections.get(c.id).members.set('user-bob', { role: 'edit', wrapped_key: 'k' });
  });
  await openTeam(page);
  const row = page.locator('.coll-row', { hasText: 'Infra' });
  await row.locator('.coll-head').click();
  page.once('dialog', d => d.accept());
  await row.locator('.coll-member', { hasText: 'bob@team.test' }).locator('.coll-remove').click();
  await expect(page.locator('.rotate-advice')).toContainText('could see 1 secret here: Prod DB');
  expect(await page.evaluate(() => [...fake.collections.values()][0].members.has('user-bob'))).toBe(false);
});

test('Vault: shared items are listed with their collection and saved straight to it; viewers only read', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId, [{ name: 'Mine', email: '', secret: TEST_SECRET, urls: '' }]);
  const ids = await page.evaluate(async () => {
    const edit = await VaultCollections.create('team-1', 'Infra');
    const view = await VaultCollections.create('team-1', 'Finance');
    fake.collections.get(view.id).members.get('user-me').role = 'view';
    const a = Vault.newItem('login', { title: 'AWS root', urls: ['aws.amazon.com'] });
    Vault.getField(a, 'password').value = 'old';
    await VaultCollections.save(edit, a);
    await VaultCollections.save(view, Vault.newItem('note', { title: 'Bank PIN' }));
    await refreshSharedItems();
    return { a: a.id, edit: edit.id };
  });
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row')).toHaveCount(3);
  await expect(page.locator('.acc-row', { hasText: 'AWS root' }).locator('.shared-tag')).toHaveText('Shared · Infra');

  await page.locator('.acc-head', { hasText: 'AWS root' }).click();
  await expect(page.locator('#acc-detail .item-urls')).toHaveValue('aws.amazon.com');
  await page.fill('#acc-detail .item-field[data-id="password"]', 'rotated');
  await page.click('#acc-detail .btn-save-shared');
  await expect(page.locator('#status-msg')).toContainText('Saved to Infra');
  const saved = await page.evaluate(async ({ a, edit }) => {
    const c = (await VaultCollections.list()).find(x => x.id === edit);
    return Vault.getValue(await VaultCrypto.decryptItem(fake.items.get(a).record, c.key), 'password');
  }, ids);
  expect(saved).toBe('rotated');

  await page.locator('.acc-head', { hasText: 'Bank PIN' }).click();
  await expect(page.locator('#acc-detail .item-title')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#acc-detail .btn-save-shared')).toHaveCount(0);
  await expect(page.locator('#acc-detail .btn-del')).toHaveCount(0);
  await expect(page.locator('#acc-detail')).toContainText('View only');
});

test('the personal Save never writes shared items into the personal vault', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId, [{ name: 'Mine', email: '', secret: TEST_SECRET, urls: '' }]);
  await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    await VaultCollections.save(c, Vault.newItem('note', { title: 'Shared note' }));
    await refreshSharedItems();
  });
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Mine' }).click();
  await page.fill('#acc-detail .acc-email', 'me@x.com');
  await page.click('#btn-save-all');
  await expect(page.locator('#status-msg')).toContainText('Saved');
  const personal = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items.map(i => i.title));
  expect(personal).toEqual(['Mine']);
  expect(await page.evaluate(() => accounts.map(a => a.name))).toEqual(['Mine']);
});

test('moving a personal item into a collection takes it out of the personal vault', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId, [{ name: 'Mine', email: 'me@x.com', secret: TEST_SECRET, urls: 'example.com', password: 'pw' }]);
  await page.evaluate(async () => { await VaultCollections.create('team-1', 'Infra'); await refreshSharedItems(); });
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Mine' }).click();
  await expect(page.locator('#acc-detail .move-to-collection')).toBeVisible();
  page.once('dialog', d => d.accept());
  await page.click('#acc-detail .btn-move-collection');
  await expect(page.locator('#status-msg')).toContainText('Moved to Infra');
  await expect(page.locator('.acc-row', { hasText: 'Mine' }).locator('.shared-tag')).toHaveText('Shared · Infra');
  const r = await page.evaluate(async () => ({
    personal: (await VaultStore.readAll(await VaultKeys.getKey())).items.length,
    shared: (await sharedItemsFromLocal()).map(s => [s.item.title, Vault.getValue(s.item, 'password'), s.item.totp?.secret]),
  }));
  expect(r).toEqual({ personal: 0, shared: [['Mine', 'pw', TEST_SECRET]] });
});
