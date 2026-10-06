import { test, expect, seedUnlocked, readAccounts, writeAccounts, waitForVault, TEST_SECRET } from './fixtures.js';

// 2.0: the popup and content scripts work with the v1 account list, but it is
// stored as encrypted vault items (vaultAccounts.js).

const ACCOUNT = { name: 'GitHub', email: 'me@example.com', secret: TEST_SECRET, urls: 'localhost', autofill: true, category: 'Work' };

async function openPopup(context, extensionId, accounts) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts });
  await page.reload(); // first read migrates the plaintext list
  await expect(page.locator('#lock-overlay')).toHaveClass(/hidden/);
  await waitForVault(page);
  return page;
}

test('after the first open no secret or username is left in plaintext', async ({ context, extensionId }) => {
  const page = await openPopup(context, extensionId, [ACCOUNT]);
  const raw = JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)));
  expect(raw).not.toContain(TEST_SECRET);
  expect(raw).not.toContain('me@example.com');
  expect((await readAccounts(page)).map(a => a.name)).toEqual(['GitHub']);
});

test('saving from the v1 list keeps item fields it does not know about', async ({ context, extensionId }) => {
  const page = await openPopup(context, extensionId, [ACCOUNT]);
  // A password added by a newer UI (or another device).
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const { items } = await VaultStore.readAll(key);
    Vault.getField(items[0], 'password').value = 'hunter2';
    items[0].notes = 'keep me';
    await VaultStore.save(items[0], key);
  });
  const [acc] = await readAccounts(page);
  await writeAccounts(page, [{ ...acc, name: 'GitHub (work)' }]);
  const item = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items[0]);
  expect(item.title).toBe('GitHub (work)');
  expect(item.fields.find(f => f.id === 'password').value).toBe('hunter2');
  expect(item.notes).toBe('keep me');
});

test('a save only deletes accounts the saver had loaded', async ({ context, extensionId }) => {
  const page = await openPopup(context, extensionId, [ACCOUNT]);
  const loaded = await readAccounts(page);
  // Meanwhile a page adds an account through the background.
  await page.evaluate(() => chrome.runtime.sendMessage({ action: 'vaultAddAccount', account: { name: 'Vercel', secret: 'GEZDGNBVGY3TQOJQ', urls: 'vercel.com' } }));
  // The popup saves its (older) list with the first account removed.
  await page.evaluate(async ids => {
    await VaultAccounts.save([], await VaultKeys.getKey(), new Set(ids));
  }, loaded.map(a => a._id));
  expect((await readAccounts(page)).map(a => a.name)).toEqual(['Vercel']);
});

test('with the vault locked, the page offers the unlock only where an account matches, by name', async ({ context, extensionId }) => {
  const page = await openPopup(context, extensionId, [ACCOUNT]);
  await page.evaluate(() => VaultLock.lock());

  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/autofill.html');
  await expect(site.locator('#otpilot-lock')).toBeVisible();
  await expect(site.frameLocator('#otpilot-lock iframe').locator('#label')).toContainText('GitHub');

  // Same OTP page on a host with no account: nothing is shown.
  const other = await context.newPage();
  await other.goto('http://127.0.0.1:8765/test/autofill.html');
  await other.waitForTimeout(1500);
  await expect(other.locator('#otpilot-lock')).toHaveCount(0);
});

test('accounts pulled from the v1 sync blob reuse the local item instead of replacing it', async ({ context, extensionId }) => {
  const page = await openPopup(context, extensionId, [ACCOUNT]);
  const [local] = await readAccounts(page);
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const { items } = await VaultStore.readAll(key);
    Vault.getField(items[0], 'password').value = 'hunter2';
    await VaultStore.save(items[0], key);
  });
  // Same account as another device sends it: no _id, or that device's own id.
  for (const pulled of [{ ...ACCOUNT }, { ...ACCOUNT, _id: crypto.randomUUID() }]) {
    await page.evaluate(async ([acc, ids]) => {
      await VaultAccounts.save([acc], await VaultKeys.getKey(), new Set(ids));
    }, [pulled, [local._id]]);
    const items = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items);
    expect(items.map(i => i.id)).toEqual([local._id]);
    expect(items[0].fields.find(f => f.id === 'password').value).toBe('hunter2');
  }
});

test('an item that fails to decrypt is never overwritten by a save', async ({ context, extensionId }) => {
  const page = await openPopup(context, extensionId, [ACCOUNT]);
  const [acc] = await readAccounts(page);
  const damaged = await page.evaluate(async id => {
    const rec = (await chrome.storage.local.get('vi:' + id))['vi:' + id];
    const bad = { ...rec, data: { ...rec.data, ct: 'AAAA' + rec.data.ct.slice(4) } };
    await chrome.storage.local.set({ ['vi:' + id]: bad });
    return bad;
  }, acc._id);
  await writeAccounts(page, [{ ...acc, name: 'renamed' }]);
  const after = await page.evaluate(id => chrome.storage.local.get('vi:' + id).then(d => d['vi:' + id]), acc._id);
  expect(after).toEqual(damaged);
});

test('two accounts added at once from pages both end up in the locked-vault index', async ({ context, extensionId }) => {
  const page = await openPopup(context, extensionId, []);
  await page.evaluate(() => Promise.all([
    chrome.runtime.sendMessage({ action: 'vaultAddAccount', account: { name: 'A', secret: 'GEZDGNBVGY3TQOJQ', urls: 'a.com' } }),
    chrome.runtime.sendMessage({ action: 'vaultAddAccount', account: { name: 'B', secret: 'MFRGGZDFMZTWQ2LK', urls: 'b.com' } }),
  ]));
  const names = await page.evaluate(async () => (await VaultAccounts.readIndex()).map(e => e.name).sort());
  expect(names).toEqual(['A', 'B']);
});

test('the encrypted v1 backup follows a recovery-key change', async ({ context, extensionId }) => {
  const page = await openPopup(context, extensionId, [ACCOUNT]);
  const readable = await page.evaluate(async pw => {
    const k = VaultCrypto.b64e(VaultCrypto.generateKey());
    await VaultKeys.adoptKey(k, pw);
    const backup = (await chrome.storage.local.get('accountsV1Backup')).accountsV1Backup;
    return (await VaultCrypto.decryptItem(backup, k)).accounts.length;
  }, 'test');
  expect(readable).toBe(1);
});

test('a sync that finishes after the vault locked does not record success', async ({ context, extensionId }) => {
  const page = await openPopup(context, extensionId, [ACCOUNT]);
  const result = await page.evaluate(async () => {
    await chrome.storage.local.set({ lastSyncedAt: '2026-01-01T00:00:00.000Z' });
    lastSyncedAt = '2026-01-01T00:00:00.000Z';
    localChangedAt = null;
    CloudSync.getServerMeta = async () => {
      await VaultLock.lock(); // locks while the request is pending
      return { accounts: [{ name: 'New', secret: 'GEZDGNBVGY3TQOJQ', urls: '' }], tombstones: {}, updatedAt: '2026-10-01T00:00:00.000Z' };
    };
    await doSync();
    return (await chrome.storage.local.get('lastSyncedAt')).lastSyncedAt;
  });
  expect(result).toBe('2026-01-01T00:00:00.000Z');
});
