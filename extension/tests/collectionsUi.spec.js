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

test('offline, shared items still load from the local copy', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId);
  const n = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    await VaultCollections.save(c, Vault.newItem('note', { title: 'Runbook' }));
    await refreshSharedItems();
    sharedItems = [];
    CloudSync.api = async () => { throw new TypeError('Failed to fetch'); };
    await refreshSharedItems();
    return sharedItems.map(s => s.item.title);
  });
  expect(n).toEqual(['Runbook']);
});

test('saving a shared item keeps unsaved edits to other rows', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId, [{ name: 'Mine', email: '', secret: TEST_SECRET, urls: '' }, { name: 'Other', email: '', secret: TEST_SECRET, urls: '', password: 'pw' }]);
  await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    await VaultCollections.save(c, Vault.newItem('note', { title: 'Shared note' }));
    await refreshSharedItems();
  });
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Mine' }).click();
  await page.fill('#acc-detail .acc-email', 'kept@x.com');
  await page.locator('.acc-head', { hasText: 'Shared note' }).click();
  await page.fill('#acc-detail .item-notes', 'edited');
  await page.click('#acc-detail .btn-save-shared');
  await expect(page.locator('#status-msg')).toContainText('Saved to Infra');
  expect(await page.evaluate(() => draft.find(e => e.name === 'Mine').email)).toBe('kept@x.com');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
    .find(i => i.title === 'Mine'))) && page.evaluate(async () => Vault.getValue((await VaultStore.readAll(await VaultKeys.getKey())).items.find(i => i.title === 'Mine'), 'username'))).toBe('kept@x.com');

});

test('a teammate cannot inject markup through an unknown type with no title', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId);
  await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    const item = { ...Vault.newItem('note'), type: '<img class="pwned" src="x">', title: '' };
    await VaultCollections.save(c, item);
    await refreshSharedItems();
  });
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row')).toHaveCount(1);
  await page.locator('.acc-head').first().click();
  expect(await page.locator('img.pwned').count()).toBe(0);
});

test('removal advice includes secrets added since the popup opened; Create runs once; renames reach the vault', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId);
  await openTeam(page);
  await page.fill('#collection-new-name', 'Infra');
  await page.evaluate(() => { const b = document.getElementById('collection-create'); b.click(); b.click(); });
  await expect(page.locator('.coll-row', { hasText: 'Infra' })).toHaveCount(1);
  expect(await page.evaluate(() => fake.collections.size)).toBe(1);

  // A teammate adds a secret the popup hasn't pulled yet; then Bob is removed.
  await page.evaluate(async () => {
    const [c] = await VaultCollections.list();
    const k = Vault.newItem('api', { title: 'Stripe' });
    Vault.getField(k, 'apiKey').value = 'sk_live';
    fake.items.set(k.id, { id: k.id, cid: c.id, record: await VaultCrypto.encryptItem(k, c.key), revision: ++fake.rev });
    fake.collections.get(c.id).members.set('user-bob', { role: 'edit', wrapped_key: 'k' });
  });
  await openTeam(page);
  const row = page.locator('.coll-row', { hasText: 'Infra' });
  await expect(row.locator('.coll-body')).toBeVisible(); // still open since it was created
  page.once('dialog', d => d.accept());
  await row.locator('.coll-member', { hasText: 'bob@team.test' }).locator('.coll-remove').click();
  await expect(page.locator('.rotate-advice')).toContainText('Stripe');

  // Rename: the vault's shared tags follow.
  page.once('dialog', d => d.accept('Platform'));
  await row.locator('.coll-rename').click();
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row', { hasText: 'Stripe' }).locator('.shared-tag')).toHaveText('Shared · Platform');
});

test("offline, another user never gets the previous user's shared items", async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId);
  const titles = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    await VaultCollections.save(c, Vault.newItem('note', { title: 'Secret runbook' }));
    await refreshSharedItems(); // caches the list for user-me
    SupabaseAuth.getSession = async () => ({ user: { id: 'user-someone-else' } });
    sharedItems = [];
    CloudSync.api = async () => { throw new TypeError('Failed to fetch'); };
    await refreshSharedItems();
    return sharedItems.map(s => s.item.title);
  });
  expect(titles).toEqual([]);
});

test('the main Save refuses to drop unsaved edits to a shared item', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId, [{ name: 'Mine', email: '', secret: TEST_SECRET, urls: '' }]);
  await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    await VaultCollections.save(c, Vault.newItem('note', { title: 'Shared note', notes: 'v1' }));
    await refreshSharedItems();
  });
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Shared note' }).click();
  await page.fill('#acc-detail .item-notes', 'v2 not saved yet');
  await page.click('#btn-save-all');
  await expect(page.locator('#status-msg')).toContainText('use "Save to Infra" first');
  expect(await page.evaluate(() => draft.find(e => e.name === 'Shared note').item.notes)).toBe('v2 not saved yet');
});

test('reading a shared note that starts with a newline is not an edit; viewers never block Save', async ({ context, extensionId }) => {
  const page = await teamPopup(context, extensionId, [{ name: 'Mine', email: '', secret: TEST_SECRET, urls: '' }]);
  await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    await VaultCollections.save(c, Vault.newItem('note', { title: 'Readme', notes: '\nfirst line after a blank one' }));
    fake.collections.get(c.id).members.get('user-me').role = 'view';
    await refreshSharedItems();
  });
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Readme' }).click();
  await expect(page.locator('#acc-detail .item-notes')).toHaveValue('\nfirst line after a blank one');
  await page.locator('.acc-head', { hasText: 'Mine' }).click();
  await page.fill('#acc-detail .acc-email', 'me@x.com');
  await page.click('#btn-save-all');
  await expect(page.locator('#status-msg')).toHaveText('Saved');
});


test("a collection lists what's shared into it: mine (removable), teammates', and its own items", async ({ context, extensionId }) => {
  const { installFakeShares } = await import('./fakeShares.js');
  const page = await teamPopup(context, extensionId, [{ name: 'Mine to share', email: 'me', secret: TEST_SECRET, urls: 'a.example', password: 'pw' }]);
  await installFakeShares(page); // on top of the collections fake
  await page.evaluate(async team => {
    Sharing.getMyTeam = async () => team; // fakeShares replaced the team lookups
    const c = await VaultCollections.create('team-1', 'Infra');
    await VaultCollections.save(c, Vault.newItem('note', { title: 'Old runbook' })); // stored in the collection
    const key = await VaultKeys.getKey();
    const [mine] = (await VaultStore.readAll(key)).items;
    const next = await VaultShares.share(mine, null, [{ collection: c, role: 'view' }]);
    await VaultShares.attach(mine.id, next.shares, key);
    const theirs = Vault.newItem('login', { title: "Bob's DB" });
    await fakeShares.shareFromBob(theirs, 'view', c);
    await refreshSharedItems();
  }, TEAM);
  await openTeam(page);
  await page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-head').click();
  const items = page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-items');
  await expect(items.locator('.share-grant')).toHaveText([/Bob's DB · bob@team\.test/, /Mine to share · you/, /Old runbook · the collection/]);
  await items.locator('.coll-unshare').click();
  await expect(page.locator('#status-msg')).toContainText('no longer shared in "Infra"');
  await expect(items.locator('.share-grant', { hasText: 'Mine to share' })).toHaveCount(0);
  expect(await page.evaluate(() => [...fakeShares.shares.values()].filter(s => s.owner === 'user-me').length)).toBe(0);
});

test("a collection opened while shared items still load lists them once they arrive; a failed load says so and retries", async ({ context, extensionId }) => {
  const { installFakeShares } = await import('./fakeShares.js');
  const page = await teamPopup(context, extensionId, [{ name: 'Mine to share', email: 'me', secret: TEST_SECRET, urls: 'a.example', password: 'pw' }]);
  await installFakeShares(page);
  await page.evaluate(async team => {
    Sharing.getMyTeam = async () => team;
    const c = await VaultCollections.create('team-1', 'Infra');
    await fakeShares.shareFromBob(Vault.newItem('login', { title: "Bob's DB" }), 'view', c);
    const key = await VaultKeys.getKey();
    const [mine] = (await VaultStore.readAll(key)).items;
    await VaultShares.attach(mine.id, (await VaultShares.share(mine, null, [{ collection: c, role: 'view' }])).shares, key);
    // A slow refresh in flight when the collection is opened.
    const refresh = VaultShares.refresh;
    VaultShares.refresh = async () => { await new Promise(r => setTimeout(r, 1500)); return refresh(); };
    refreshSharedItems();
  }, TEAM);
  await openTeam(page);
  await page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-head').click();
  const items = page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-items');
  await expect(items.locator('.share-grant')).toHaveText([/Bob's DB · bob@team\.test/, /Mine to share · you/], { timeout: 8000 });

  // My items can't be loaded: it says so, and Retry works once they can.
  await page.evaluate(() => {
    window._mine = VaultShares.mine;
    VaultShares.mine = async () => { throw new Error('offline'); };
  });
  await page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-head').click(); // close
  await page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-head').click(); // reopen
  await expect(items.locator('.coll-items-error')).toContainText('could not be loaded');
  await page.evaluate(() => { VaultShares.mine = window._mine; });
  await expect(items.locator('.share-grant')).toHaveText([/Bob's DB · bob@team\.test/]); // mine missing meanwhile
  await items.locator('.coll-items-retry').click();
  // The retry really loaded them: my row is back, no error.
  const after = page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-items');
  await expect(after.locator('.share-grant')).toHaveText([/Bob's DB · bob@team\.test/, /Mine to share · you/]);
  await expect(after.locator('.coll-items-error')).toHaveCount(0);
});

test("a manager converts the collection's older items: one atomic request each, a teammate's edit meanwhile is kept, one already converted is skipped", async ({ context, extensionId }) => {
  const { installFakeShares } = await import('./fakeShares.js');
  const page = await teamPopup(context, extensionId);
  await installFakeShares(page);
  await page.evaluate(async team => {
    Sharing.getMyTeam = async () => team;
    const c = await VaultCollections.create('team-1', 'Infra');
    window.coll = c;
    const a = Vault.newItem('note', { title: 'Old runbook', notes: 'v1' });
    const b = Vault.newItem('note', { title: 'Old wifi', notes: 'w' });
    await VaultCollections.save(c, a);
    await VaultCollections.save(c, b);
    // While converting: a teammate edits the runbook (first request → 409),
    // and another manager already converted the wifi (→ 404).
    let first = true;
    fake.beforeConvert = async id => {
      if (id === a.id && first) {
        first = false;
        const cur = fake.items.get(id);
        fake.items.set(id, { ...cur, record: await VaultCrypto.encryptItem({ ...a, notes: 'v2 (teammate)' }, c.key), revision: ++fake.rev });
      }
      if (id === b.id) fake.items.set(id, { ...fake.items.get(id), deleted: true, record: null });
    };
    await refreshSharedItems();
  }, TEAM);
  await openTeam(page);
  await page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-head').click();
  page.on('dialog', d => d.accept());
  await page.locator('.coll-row', { hasText: 'Infra' }).locator('.coll-convert').click();
  await expect(page.locator('#status-msg')).toContainText('Converted 1 item');
  const r = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [conv] = fake.converted;
    const mine = await VaultCrypto.decryptItem(conv.item.record, key);
    const share = fakeShares.shares.get(conv.share.id);
    const sk = await VaultCrypto.decryptName(share.grants[0].wrapped_key, coll.key, share.id);
    const copy = await VaultCrypto.decryptItem(share.record, sk);
    return {
      requests: fake.converted.length, mineNotes: mine.notes, keyInItem: mine.shares[0].sk === sk,
      copyNotes: copy.notes, grant: share.grants[0].role, left: [...fake.items.values()].filter(i => !i.deleted).length,
    };
  });
  expect(r).toEqual({ requests: 1, mineNotes: 'v2 (teammate)', keyInItem: true, copyNotes: 'v2 (teammate)', grant: 'edit', left: 0 });
});
