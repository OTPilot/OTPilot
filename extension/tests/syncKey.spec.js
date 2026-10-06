import { test, expect } from './fixtures.js';

// The sync key is the 2.0 vault key. Loads CloudSync and the vault modules into
// the script-free test page with clean storage (no network is used here).
async function syncPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  for (const f of ['config.js', 'vaultCrypto.js', 'vaultKeys.js', 'vaultStore.js', 'cloudSync.js']) {
    await page.addScriptTag({ url: `chrome-extension://${extensionId}/${f}` });
  }
  return page;
}

const note = (id, title) => ({ id, type: 'note', title, fields: [], notes: '' });

test('a v1 plaintext syncKey becomes the vault key and sync stays enabled', async ({ context, extensionId }) => {
  const page = await syncPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const legacy = VaultCrypto.b64e(VaultCrypto.generateKey());
    await chrome.storage.local.set({ syncKey: legacy });
    const key = await CloudSync.getSyncKey();
    const stored = await chrome.storage.local.get(null);
    return {
      same: key === legacy,
      vaultKey: stored.vaultKey === legacy,
      enabled: stored.syncEnabled,
      legacyGone: !('syncKey' in stored),
    };
  });
  expect(result).toEqual({ same: true, vaultKey: true, enabled: true, legacyGone: true });
});

test('enabling sync uses the existing vault key, so local items stay readable', async ({ context, extensionId }) => {
  const page = await syncPage(context, extensionId);
  const result = await page.evaluate(async it => {
    const before = await CloudSync.getSyncKey();
    const vk = await VaultKeys.init();
    await VaultStore.save(it, vk);
    const syncKey = await CloudSync.generateSyncKey();
    const { items } = await VaultStore.readAll(await CloudSync.getSyncKey());
    return { before, same: syncKey === vk, titles: items.map(i => i.title) };
  }, note('a', 'Wifi'));
  expect(result).toEqual({ before: null, same: true, titles: ['Wifi'] });
});

test('restoring a recovery key re-wraps existing local items to it', async ({ context, extensionId }) => {
  const page = await syncPage(context, extensionId);
  const result = await page.evaluate(async items => {
    const oldKey = await VaultKeys.init();
    await VaultStore.save(items, oldKey);
    const recovery = VaultCrypto.b64e(VaultCrypto.generateKey());
    await CloudSync.saveSyncKey(recovery);
    const withNew = await VaultStore.readAll(recovery);
    const withOld = await VaultStore.readAll(oldKey);
    return {
      key: (await CloudSync.getSyncKey()) === recovery,
      newTitles: withNew.items.map(i => i.title).sort(),
      oldFails: withOld.failed.length,
    };
  }, [note('a', 'Wifi'), note('b', 'Router')]);
  expect(result).toEqual({ key: true, newTitles: ['Router', 'Wifi'], oldFails: 2 });
});

test('an invalid recovery key is rejected and changes nothing', async ({ context, extensionId }) => {
  const page = await syncPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const vk = await VaultKeys.init();
    const attempt = async k => { try { await CloudSync.saveSyncKey(k); return null; } catch (e) { return e.message; } };
    const errors = [await attempt('c2hvcnQ='), await attempt('not base64!')];
    return { errors: errors.map(Boolean), unchanged: (await VaultKeys.getKey()) === vk, enabled: await CloudSync.isSyncEnabled() };
  });
  expect(result).toEqual({ errors: [true, true], unchanged: true, enabled: false });
});

test('stopping sync keeps the vault key and the local vault', async ({ context, extensionId }) => {
  const page = await syncPage(context, extensionId);
  const result = await page.evaluate(async it => {
    const key = await CloudSync.generateSyncKey();
    await VaultStore.save(it, key);
    await CloudSync.deleteSyncKey();
    return {
      syncKey: await CloudSync.getSyncKey(),
      enabled: await CloudSync.isSyncEnabled(),
      vaultKeySame: (await VaultKeys.getKey()) === key,
      titles: (await VaultStore.readAll(key)).items.map(i => i.title),
    };
  }, note('a', 'Wifi'));
  expect(result).toEqual({ syncKey: null, enabled: false, vaultKeySame: true, titles: ['Wifi'] });
});

test('with the legacy key converted, a master password can now protect the vault key', async ({ context, extensionId }) => {
  const page = await syncPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const legacy = VaultCrypto.b64e(VaultCrypto.generateKey());
    await chrome.storage.local.set({ syncKey: legacy });
    await CloudSync.isSyncEnabled(); // converts
    await VaultKeys.setPassword('correct horse');
    await VaultKeys.lock();
    const stored = await chrome.storage.local.get(null);
    return { keyAtRest: JSON.stringify(stored).includes(legacy), syncKeyWhileLocked: await CloudSync.getSyncKey() };
  });
  expect(result).toEqual({ keyAtRest: false, syncKeyWhileLocked: null });
});

test('adopting a key with a master password set needs the password and keeps it wrapped', async ({ context, extensionId }) => {
  const page = await syncPage(context, extensionId);
  const result = await page.evaluate(async it => {
    const oldKey = await VaultKeys.init();
    await VaultStore.save(it, oldKey);
    await VaultKeys.setPassword('correct horse');
    const recovery = VaultCrypto.b64e(VaultCrypto.generateKey());
    const attempt = async pw => { try { await VaultKeys.adoptKey(recovery, pw); return 'ok'; } catch (e) { return e.message; } };
    const noPw = await attempt(undefined);
    const wrongPw = await attempt('nope');
    const rightPw = await attempt('correct horse');
    await VaultKeys.lock();
    const unlocked = await VaultKeys.unlock('correct horse');
    return {
      noPw, wrongPw, rightPw, unlocked,
      key: (await VaultKeys.getKey()) === recovery,
      titles: (await VaultStore.readAll(recovery)).items.map(i => i.title),
      plaintextAtRest: JSON.stringify(await chrome.storage.local.get(null)).includes(recovery),
    };
  }, note('a', 'Wifi'));
  expect(result).toEqual({
    noPw: 'password required', wrongPw: 'wrong password', rightPw: 'ok', unlocked: true,
    key: true, titles: ['Wifi'], plaintextAtRest: false,
  });
});

test('a failure re-wrapping an item aborts the key change instead of stranding the item', async ({ context, extensionId }) => {
  const page = await syncPage(context, extensionId);
  const result = await page.evaluate(async items => {
    const oldKey = await VaultKeys.init();
    await VaultStore.save(items, oldKey);
    const real = VaultCrypto.rewrapItemKey;
    VaultCrypto.rewrapItemKey = async (rec, ...rest) => {
      if (rec.id === 'b') throw new Error('quota exceeded');
      return real(rec, ...rest);
    };
    let error = null;
    try { await VaultKeys.adoptKey(VaultCrypto.b64e(VaultCrypto.generateKey())); } catch (e) { error = e.message; }
    VaultCrypto.rewrapItemKey = real;
    return { error, keyUnchanged: (await VaultKeys.getKey()) === oldKey, readable: (await VaultStore.readAll(oldKey)).items.length };
  }, [note('a', 'Wifi'), note('b', 'Router')]);
  expect(result).toEqual({ error: 'quota exceeded', keyUnchanged: true, readable: 2 });
});

test('a removal racing a key change is not undone', async ({ context, extensionId }) => {
  const page = await syncPage(context, extensionId);
  const remaining = await page.evaluate(async () => {
    const oldKey = await VaultKeys.init();
    await VaultStore.save(Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, type: 'note', title: `n${i}`, fields: [] })), oldKey);
    const newKey = VaultCrypto.b64e(VaultCrypto.generateKey());
    // Fire the removal once the re-key has already read every record and is
    // re-wrapping them, and give it time to land if nothing holds it back.
    const real = VaultCrypto.rewrapItemKey;
    let removal = null;
    VaultCrypto.rewrapItemKey = async (...args) => {
      if (!removal) {
        removal = VaultStore.remove('n39');
        await new Promise(r => setTimeout(r, 100));
      }
      return real(...args);
    };
    await VaultKeys.adoptKey(newKey);
    await removal;
    VaultCrypto.rewrapItemKey = real;
    return Object.keys(await VaultStore.listRecords()).includes('n39');
  });
  expect(remaining).toBe(false);
});
