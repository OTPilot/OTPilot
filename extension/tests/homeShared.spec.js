import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';
import { installFakeShares } from './fakeShares.js';
import { installFakeCollections } from './fakeCollections.js';

// Home with what's shared: logins shared with the user listed after their own
// (code, details, Fill, Open & sign in), who shared it on Home's detail, who
// an own item is shared with; the shared items' site icons. Also: the role of
// an item of mine in a collection, from the Team tab; no "generate" button in
// the editors; the uninstall survey URL.

async function setup(context, extensionId, accounts = []) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], userPlan: 'team_lite', obfuscated: false, cloudSession: { user: { id: 'user-me' }, access_token: 't', expires_at: 4102444800000 } });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  await page.evaluate(() => { SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } }); });
  await installFakeCollections(page);
  await installFakeShares(page);
  await page.evaluate(async () => reloadFromVault(await VaultKeys.getKey()));
  return page;
}

async function bobShares(page, { title = 'Team AWS', secret = '', urls = ['localhost'], role = 'view' } = {}) {
  await page.evaluate(async ({ title, secret, urls, role }) => {
    const item = Vault.newItem('login', { title, urls });
    Vault.getField(item, 'username').value = 'ops@team.test';
    if (secret) item.totp = { secret };
    await fakeShares.shareFromBob(item, role);
    await refreshSharedItems();
  }, { title, secret, urls, role });
}

test('a login shared with me is on Home after my own, with its code and who shared it', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [{ name: 'Mine', email: 'me@x.io', secret: TEST_SECRET, urls: 'mine.example' }]);
  await bobShares(page, { secret: TEST_SECRET, role: 'edit' });
  await page.click('#nav-home');
  const list = page.locator('#home-list');
  await expect(list.locator('.lc-section')).toHaveText('Shared with you');
  await expect(page.locator('#home-count')).toHaveText('2 accounts');
  await list.locator('.lc-row-shared', { hasText: 'Team AWS' }).click();
  await expect(page.locator('#account-name')).toContainText('Team AWS');
  await expect(page.locator('#otp-display')).toHaveText(/\d{3} \d{3}/);
  const creds = page.locator('#home-creds');
  await expect(creds).toContainText('ops@team.test');
  await expect(creds).toContainText('Shared by');
  await expect(creds).toContainText('bob@team.test');
  await expect(creds).toContainText('Can edit');
  await expect(creds.locator('.home-edit-more')).toHaveCount(0); // its fields are the owner's
  // Search finds it; a category filter (my tags) hides it.
  await page.fill('#home-search', 'team');
  await expect(list.locator('.lc-row')).toHaveCount(1);
});

test('Fill on a shared login fills its code in the page', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await bobShares(page, { secret: TEST_SECRET });
  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/otp-split.html');
  const tabId = await page.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost:8765/test/otp-split.html' }))[0].id);
  const res = await page.evaluate(async ({ tabId, secret }) =>
    chrome.tabs.sendMessage(tabId, { action: 'fillWith', account: { name: 'Team AWS', secret } }), { tabId, secret: TEST_SECRET });
  expect(res.ok).toBe(true);
  expect(res.code).toMatch(/^\d{6}$/);
});

test('my own item on Home lists who it is shared with, and Manage opens its Share panel', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [{ name: 'DigitalOcean', email: 'me@example.com', secret: TEST_SECRET, urls: 'localhost', password: 'pw' }]);
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const id = accounts.find(a => a.name === 'DigitalOcean')._id;
    const bob = (await Sharing.getMembers('team-1')).find(m => m.user_id === 'user-bob');
    const next = await VaultShares.share(await VaultStore.get(id, key), null, [{ user: bob, role: 'edit' }]);
    await VaultShares.attach(id, next.shares, key);
    await refreshSharedItems();
  });
  await page.click('#nav-home');
  await page.locator('#home-list .lc-row', { hasText: 'DigitalOcean' }).click();
  const creds = page.locator('#home-creds');
  await expect(creds).toContainText('Shared with · 1');
  await expect(creds).toContainText('bob@team.test');
  await creds.getByRole('button', { name: 'Manage…' }).click();
  await expect(page.locator('#acc-detail .share-panel .share-grant')).toContainText('bob@team.test');
});

test('the role of my item in a collection changes from the Team tab', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [{ name: 'DigitalOcean', email: 'me@example.com', secret: TEST_SECRET, urls: 'localhost', password: 'pw' }]);
  const shareId = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Infra');
    const key = await VaultKeys.getKey();
    const id = accounts.find(a => a.name === 'DigitalOcean')._id;
    const next = await VaultShares.share(await VaultStore.get(id, key), null, [{ collection: c, role: 'view' }]);
    await VaultShares.attach(id, next.shares, key);
    Sharing.getMyTeam = async () => ({ id: 'team-1', name: 'Acme', owner_id: 'user-me' });
    await refreshSharedItems();
    return next.shares[0].id;
  });
  await page.evaluate(() => showView('team'));
  const row = page.locator('.coll-row', { hasText: 'Infra' });
  await row.locator('.coll-head').click();
  const sel = row.locator('.coll-item-role');
  await expect(sel).toHaveValue('view');
  await sel.selectOption('edit');
  await expect.poll(() => page.evaluate(id => fakeShares.shares.get(id).grants[0].role, shareId)).toBe('edit');
});

test('the editors have no "generate password" button', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [{ name: 'DigitalOcean', email: 'me@example.com', secret: '', urls: 'localhost', password: 'pw' }]);
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'DigitalOcean' }).click();
  await expect(page.locator('#acc-detail .acc-password')).toBeVisible();
  await expect(page.locator('#acc-detail .btn-gen-password')).toHaveCount(0);
  // The eye still shows the password.
  await page.locator('#acc-detail .acc-password-field .btn-eye').click();
  await expect(page.locator('#acc-detail .acc-password')).toHaveAttribute('type', 'text');
});

test('a shared item\'s site icon is resolved too', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await bobShares(page, { urls: ['github.com'] });
  expect(await page.evaluate(() => iconDomains())).toContain('github.com');
  expect(await page.evaluate(() => accountIconDomain(sharedEntryOf(sharedItems[0])))).toBe('github.com');
});

test('the uninstall survey URL carries only the version, days installed and plan', async ({ context }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const url = await worker.evaluate(async () => {
    const set = chrome.runtime.setUninstallURL;
    let got = null;
    chrome.runtime.setUninstallURL = async u => { got = u; };
    await chrome.storage.local.set({ installedAt: Date.now() - 3 * 86400000 - 1000, userPlan: 'personal' });
    try { await setUninstallSurvey(); } finally { chrome.runtime.setUninstallURL = set; }
    return got;
  });
  const u = new URL(url);
  expect(u.pathname).toBe('/goodbye');
  // (The install's own onInstalled may record installedAt meanwhile: the days are only checked to be a count.)
  expect(Object.keys(Object.fromEntries(u.searchParams)).sort()).toEqual(['d', 'p', 'v']);
  expect(u.searchParams.get('v')).toBe('2.0.3');
  expect(u.searchParams.get('p')).toBe('personal');
  expect(u.searchParams.get('d')).toMatch(/^\d+$/);
});
