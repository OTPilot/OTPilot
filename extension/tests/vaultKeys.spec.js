import { test, expect } from './fixtures.js';

// vaultKeys.js isn't wired into any page yet, so each test loads it (and the
// vaultCrypto.js it needs) into the script-free test page, with clean storage.
async function keysPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/vaultCrypto.js` });
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/vaultKeys.js` });
  return page;
}

test('init creates a vault key once and leaves it open without a master password', async ({ context, extensionId }) => {
  const page = await keysPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const before = await VaultKeys.status();
    const k1 = await VaultKeys.init();
    const k2 = await VaultKeys.init();
    return { before, after: await VaultKeys.status(), same: k1 === k2, len: VaultCrypto.b64d(k1).length, key: await VaultKeys.getKey() === k1 };
  });
  expect(result).toEqual({ before: 'none', after: 'open', same: true, len: 32, key: true });
});

test('init adopts an existing syncKey so the vault and sync use the same key', async ({ context, extensionId }) => {
  const page = await keysPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const syncKey = VaultCrypto.b64e(VaultCrypto.generateKey());
    await chrome.storage.local.set({ syncKey });
    return { adopted: (await VaultKeys.init()) === syncKey };
  });
  expect(result.adopted).toBe(true);
});

test('a master password wraps the key at rest; lock and unlock work', async ({ context, extensionId }) => {
  const page = await keysPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const key = await VaultKeys.init();
    await VaultKeys.setPassword('correct horse');
    const afterSet = await VaultKeys.status();
    const stored = await chrome.storage.local.get(null);
    await VaultKeys.lock();
    const locked = { status: await VaultKeys.status(), key: await VaultKeys.getKey() };
    const wrong = await VaultKeys.unlock('wrong horse');
    const right = await VaultKeys.unlock('correct horse');
    return {
      afterSet,
      plaintextGone: !('vaultKey' in stored),
      keyNotInLocal: !JSON.stringify(stored).includes(key),
      locked,
      wrong,
      right,
      unlocked: await VaultKeys.status(),
      sameKey: (await VaultKeys.getKey()) === key,
    };
  });
  expect(result).toEqual({
    afterSet: 'unlocked', plaintextGone: true, keyNotInLocal: true,
    locked: { status: 'locked', key: null },
    wrong: false, right: true, unlocked: 'unlocked', sameKey: true,
  });
});

test('setting a password while locked is refused', async ({ context, extensionId }) => {
  const page = await keysPage(context, extensionId);
  const error = await page.evaluate(async () => {
    await VaultKeys.init();
    await VaultKeys.setPassword('first');
    await VaultKeys.lock();
    try { await VaultKeys.setPassword('second'); return null; } catch (e) { return e.message; }
  });
  expect(error).toBe('vault is locked');
});

test('removing the master password needs the current one and restores the open key', async ({ context, extensionId }) => {
  const page = await keysPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const key = await VaultKeys.init();
    await VaultKeys.setPassword('correct horse');
    await VaultKeys.lock();
    const wrong = await VaultKeys.removePassword('nope');
    const stillLocked = await VaultKeys.status();
    const right = await VaultKeys.removePassword('correct horse');
    const stored = await chrome.storage.local.get(null);
    return {
      wrong, stillLocked, right,
      status: await VaultKeys.status(),
      sameKey: (await VaultKeys.getKey()) === key,
      wrappedGone: !('vaultKeyWrapped' in stored),
    };
  });
  expect(result).toEqual({ wrong: false, stillLocked: 'locked', right: true, status: 'open', sameKey: true, wrappedGone: true });
});

test('overlapping first-run init calls from two pages agree on one key', async ({ context, extensionId }) => {
  const p1 = await keysPage(context, extensionId);
  const p2 = await keysPage(context, extensionId);
  const run = p => p.evaluate(() => Promise.all(Array.from({ length: 5 }, () => VaultKeys.init())));
  const [a, b] = await Promise.all([run(p1), run(p2)]);
  const stored = await p1.evaluate(() => VaultKeys.getKey());
  expect(new Set([...a, ...b, stored]).size).toBe(1);
});

test('a lock overlapping removePassword never loses the key', async ({ context, extensionId }) => {
  const page = await keysPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const key = await VaultKeys.init();
    await VaultKeys.setPassword('correct horse');
    const [removed] = await Promise.all([VaultKeys.removePassword('correct horse'), VaultKeys.lock(), VaultKeys.lock()]);
    return { removed, status: await VaultKeys.status(), sameKey: (await VaultKeys.getKey()) === key };
  });
  expect(result).toEqual({ removed: true, status: 'open', sameKey: true });
});

test('setting a password is refused while the same key sits in a plaintext syncKey', async ({ context, extensionId }) => {
  const page = await keysPage(context, extensionId);
  const result = await page.evaluate(async () => {
    await chrome.storage.local.set({ syncKey: VaultCrypto.b64e(VaultCrypto.generateKey()) });
    await VaultKeys.init();
    let error = null;
    try { await VaultKeys.setPassword('correct horse'); } catch (e) { error = e.message; }
    return { error, status: await VaultKeys.status() };
  });
  expect(result).toEqual({ error: 'sync key is still stored in plaintext', status: 'open' });
});
