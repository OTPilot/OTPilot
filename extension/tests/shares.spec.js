import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';
import { installFakeShares } from './fakeShares.js';
import { installFakeCollections } from './fakeCollections.js';

// Sharing (docs/sharing.md, vaultShares.js): copies of my items under their
// own share keys, granted to teammates; copies shared with me.

async function setup(context, extensionId, accounts = []) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  // Signed in as user-me: what's shared belongs to an account.
  await seedUnlocked(page, { accounts: [], userPlan: 'team_lite', cloudSession: { user: { id: 'user-me' }, access_token: 't', expires_at: 4102444800 } });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  // The fake token can't be refreshed, so the session would be dropped:
  // the worker (autofill) and the popup see user-me directly.
  const [worker] = context.serviceWorkers();
  await worker.evaluate(() => { SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } }); });
  await page.evaluate(() => { SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } }); });
  await installFakeShares(page);
  // The popup's lists follow what was just written (a reload would drop the fake).
  await page.evaluate(async () => reloadFromVault(await VaultKeys.getKey()));
  return page;
}

const site = { name: 'DigitalOcean', email: 'me@example.com', secret: TEST_SECRET, urls: 'localhost', password: 'hunter2', notes: 'billing: ops' };

test('sharing the whole item: Bob opens a copy with everything but my tags and history; the share key stays in my item', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [{ ...site, category: 'Infra' }]);
  const r = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [item] = (await VaultStore.readAll(key)).items;
    const next = await VaultShares.share(item, null, [{ user: fakeShares.bob, role: 'edit' }]);
    await VaultShares.attach(item.id, next.shares, key);
    const stored = (await VaultStore.readAll(key)).items[0];
    const [s] = [...fakeShares.shares.values()];
    const bob = await fakeShares.openAsBob(s.id);
    return {
      stored: stored.shares.map(x => ({ whole: x.whole, hasKey: !!x.sk })),
      server: { whole: s.whole, role: s.grants[0].role, plaintext: JSON.stringify(s).includes('hunter2') },
      copy: { title: bob.item.title, user: Vault.getValue(bob.item, 'username'), pw: Vault.getValue(bob.item, 'password'), totp: !!bob.item.totp, notes: bob.item.notes, tags: bob.item.tags, shares: bob.item.shares },
    };
  });
  expect(r.stored).toEqual([{ whole: true, hasKey: true }]);
  expect(r.server).toEqual({ whole: true, role: 'edit', plaintext: false });
  expect(r.copy).toEqual({ title: 'DigitalOcean', user: 'me@example.com', pw: 'hunter2', totp: true, notes: 'billing: ops', tags: [], shares: undefined });
});

test('sharing chosen parts: the copy carries only those (and the name)', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [site]);
  const copy = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [item] = (await VaultStore.readAll(key)).items;
    await VaultShares.share(item, ['f:username', 'totp'], [{ user: fakeShares.bob, role: 'view' }]);
    const [s] = [...fakeShares.shares.values()];
    const { item: c } = await fakeShares.openAsBob(s.id);
    return { whole: s.whole, title: c.title, user: Vault.getValue(c, 'username'), pw: Vault.getValue(c, 'password'), totp: !!c.totp, notes: c.notes, urls: c.urls };
  });
  expect(copy).toEqual({ whole: false, title: 'DigitalOcean', user: 'me@example.com', pw: '', totp: true, notes: '', urls: [] });
});

test('an edit grant is refused for a partial copy', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [site]);
  const r = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [item] = (await VaultStore.readAll(key)).items;
    try { await VaultShares.share(item, ['f:username'], [{ user: fakeShares.bob, role: 'edit' }]); return 'accepted'; }
    catch (e) { return [e.status, fakeShares.shares.size]; }
  });
  expect(r).toEqual([400, 0]);
});

test('editing my item republishes its copies; an editor\'s newer copy comes back into my item', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [site]);
  const r = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    let [item] = (await VaultStore.readAll(key)).items;
    const next = await VaultShares.share(item, null, [{ user: fakeShares.bob, role: 'edit' }]);
    item = await VaultShares.attach(item.id, next.shares, key);
    const [s] = [...fakeShares.shares.values()];
    // I change the password: the copy follows.
    Vault.getField(item, 'password').value = 'changed-by-me';
    item.updatedAt = new Date(Date.now() + 1000).toISOString();
    await VaultStore.save(item, key);
    await VaultShares.syncOwner(key);
    const afterMine = Vault.getValue((await fakeShares.openAsBob(s.id)).item, 'password');
    // Bob edits the copy (a newer version).
    const { sk, item: copy } = await fakeShares.openAsBob(s.id);
    Vault.getField(copy, 'password').value = 'changed-by-bob';
    copy.updatedAt = new Date(Date.now() + 5000).toISOString();
    s.record = await VaultCrypto.encryptItem(copy, sk);
    s.revision = ++fakeShares.rev;
    const changed = await VaultShares.syncOwner(key);
    const mine = (await VaultStore.readAll(key)).items[0];
    return { afterMine, changed, pw: Vault.getValue(mine, 'password'), stillShared: mine.shares.length, tags: mine.tags };
  });
  expect(r).toMatchObject({ afterMine: 'changed-by-me', changed: 1, pw: 'changed-by-bob', stillShared: 1 });
});

test('removing the last grant forgets the share in my item', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [site]);
  const left = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    let [item] = (await VaultStore.readAll(key)).items;
    item = await VaultShares.attach(item.id, (await VaultShares.share(item, null, [{ user: fakeShares.bob, role: 'view' }])).shares, key);
    const [s] = [...fakeShares.shares.values()];
    const next = await VaultShares.unshare(item, s.id, { user_id: fakeShares.bob.user_id });
    await VaultShares.attach(item.id, next.shares, key);
    return { item: (await VaultStore.readAll(key)).items[0].shares, server: fakeShares.shares.size };
  });
  expect(left).toEqual({ item: undefined, server: 0 });
});

test('an item Bob shared with me shows in my vault; with edit I can save it, and it fills on its site', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(async () => {
    const item = Vault.newItem('login', { title: 'Team AWS', urls: ['localhost'] });
    Vault.getField(item, 'username').value = 'ops@team.test';
    Vault.getField(item, 'password').value = 'team-pass';
    window.bobShare = await fakeShares.shareFromBob(item, 'edit');
    await refreshSharedItems();
  });
  await page.click('#nav-settings');
  const row = page.locator('.acc-head', { hasText: 'Team AWS' });
  await expect(row).toContainText('Shared · bob@team.test');
  await row.click();
  await page.fill('#acc-detail .item-title', 'Team AWS (prod)');
  await page.click('#acc-detail .btn-save-shared');
  await expect(page.locator('#status-msg')).toContainText('Saved');
  const saved = await page.evaluate(async () => {
    const s = fakeShares.shares.get(bobShare.id);
    return (await VaultCrypto.decryptItem(s.record, bobShare.sk)).title;
  });
  expect(saved).toBe('Team AWS (prod)');

  // The background fills it on its site.
  const tab = await context.newPage();
  await tab.goto('http://localhost:8765/test/login.html');
  await expect(tab.locator('#otpilot-login-fill .otpilot-login-choice')).toContainText('Team AWS (prod)');
  await tab.locator('#otpilot-login-fill .otpilot-login-choice').click();
  await expect(tab.locator('input[name="password"]')).toHaveValue('team-pass');
});

test('the Share panel: teammates, what to share, Can edit only with everything; shared shows and can be removed', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [site]);
  await page.evaluate(() => refreshSharedItems());
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'DigitalOcean' }).click();
  await page.click('#acc-detail .btn-share-item');
  const panel = page.locator('#acc-detail .share-panel');
  await expect(panel.locator('.share-user')).toHaveCount(2); // Bob, and someone not set up (disabled)
  await expect(panel.locator('.share-user[value="user-new"]')).toBeDisabled();
  await panel.locator('.share-part[value="f:password"]').uncheck();
  await expect(panel.locator('.share-role option[value="edit"]')).toBeDisabled();
  await panel.locator('.share-part[value="f:password"]').check();
  await panel.locator('.share-user[value="user-bob"]').check();
  await panel.locator('.share-role').selectOption('edit');
  await panel.locator('.share-confirm').click();
  await expect(page.locator('#status-msg')).toContainText('Shared');
  await expect(panel.locator('.share-grant')).toContainText('bob@team.test · can edit · everything');
  await panel.locator('.share-remove').click();
  await expect(panel.locator('.share-grant')).toHaveCount(0);
  expect(await page.evaluate(() => fakeShares.shares.size)).toBe(0);
});

test('an item shared with one of my collections opens with the collection key; my member role caps the grant', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], userPlan: 'team_lite' });
  await page.reload();
  await waitForVault(page);
  await installFakeCollections(page);
  await installFakeShares(page);
  const r = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    const item = Vault.newItem('login', { title: 'Infra DB', urls: ['db.example'] });
    Vault.getField(item, 'password').value = 'pg';
    await fakeShares.shareFromBob(item, 'edit', c);
    fake.collections.get(c.id).members.get('user-me').role = 'view';
    const asViewer = (await VaultShares.refresh()).map(x => [x.item?.title, x.role]);
    fake.collections.get(c.id).members.get('user-me').role = 'edit';
    const asEditor = (await VaultShares.refresh()).map(x => [x.item?.title, Vault.getValue(x.item, 'password'), x.role]);
    return { asViewer, asEditor };
  });
  expect(r).toEqual({ asViewer: [['Infra DB', 'view']], asEditor: [['Infra DB', 'pg', 'edit']] });
});

test('signing out or locking takes away what was shared with the account', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const item = Vault.newItem('login', { title: 'Team AWS', urls: ['localhost'] });
    await fakeShares.shareFromBob(item, 'view');
    await VaultShares.refresh();
    const before = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('sr:')).length;
    await VaultLock.lock();
    const keysAfterLock = !!(await chrome.storage.session.get('shareKeys')).shareKeys;
    await SupabaseAuth.signOut();
    const after = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('sr:') || k === 'sharesWithMe').length;
    return { before, keysAfterLock, after };
  });
  expect(r).toEqual({ before: 1, keysAfterLock: false, after: 0 });
});

test('a direct share can be left from its editor', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(async () => {
    await fakeShares.shareFromBob(Vault.newItem('note', { title: 'Runbook', notes: 'x' }), 'view');
    await refreshSharedItems();
  });
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Runbook' }).click();
  page.once('dialog', d => d.accept());
  await page.click('#acc-detail .btn-leave-share');
  await expect(page.locator('.acc-head', { hasText: 'Runbook' })).toHaveCount(0);
  expect(await page.evaluate(() => [...fakeShares.shares.values()].length)).toBe(0);
});

test('a shared login\'s 2FA code fills on its site', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(async secret => {
    const item = Vault.newItem('login', { title: 'Team 2FA', urls: ['localhost'], totp: { secret, digits: 6, period: 30, algorithm: 'SHA1' } });
    await fakeShares.shareFromBob(item, 'view');
    await VaultShares.refresh();
    await chrome.storage.local.set({ cloudSession: { user: { id: 'user-me' }, access_token: 't', expires_at: 4102444800 } });
  }, TEST_SECRET);
  const tab = await context.newPage();
  await tab.goto('http://localhost:8765/test/autofill.html');
  await expect(tab.locator('input[name="otp_token"]')).toHaveValue(/^\d{6}$/);
});

test('the owner\'s sync never overwrites a save made while it fetched the shares', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [site]);
  const r = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    let [item] = (await VaultStore.readAll(key)).items;
    item = await VaultShares.attach(item.id, (await VaultShares.share(item, null, [{ user: fakeShares.bob, role: 'edit' }])).shares, key);
    const [s] = [...fakeShares.shares.values()];
    // Bob's newer copy waits on the server…
    const { sk, item: copy } = await fakeShares.openAsBob(s.id);
    Vault.getField(copy, 'password').value = 'by-bob';
    copy.updatedAt = new Date(Date.now() + 5000).toISOString();
    s.record = await VaultCrypto.encryptItem(copy, sk);
    s.revision = ++fakeShares.rev;
    // …and while my sync fetches it, I save the item here.
    const api = CloudSync.api;
    CloudSync.api = async (path, opts) => {
      if (path === '/shares/mine') {
        const mineNow = (await VaultStore.readAll(key)).items[0];
        Vault.getField(mineNow, 'password').value = 'saved-meanwhile';
        mineNow.updatedAt = new Date(Date.now() + 1000).toISOString();
        await VaultStore.save(mineNow, key);
      }
      return api(path, opts);
    };
    await VaultShares.syncOwner(key);
    CloudSync.api = api;
    const first = Vault.getValue((await VaultStore.readAll(key)).items[0], 'password');
    // The next pass applies Bob's (still newer) edit over what's stored now.
    await VaultShares.syncOwner(key);
    return { first, second: Vault.getValue((await VaultStore.readAll(key)).items[0], 'password') };
  });
  expect(r).toEqual({ first: 'saved-meanwhile', second: 'by-bob' });
});
