import { test, expect } from './fixtures.js';

// vaultCrypto.js isn't wired into any page yet, so each test loads it into a
// blank extension page (same origin, so the extension CSP allows it).
async function cryptoPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/vaultCrypto.js` });
  return page;
}

const ITEM = {
  id: 'c1f0e7a2-5b1d-4a8e-9f2c-0d7b3e6a1c44',
  type: 'login',
  title: 'GitHub',
  tags: ['trabajo'],
  urls: ['github.com'],
  fields: [
    { id: 'username', label: 'Usuario', kind: 'text', value: 'alberto@example.com' },
    { id: 'password', label: 'Contraseña', kind: 'password', value: 'k7#Vq-Tz9!pLw2' },
  ],
  totp: { secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' },
};

test('an item round-trips through encrypt/decrypt with the vault key', async ({ context, extensionId }) => {
  const page = await cryptoPage(context, extensionId);
  const result = await page.evaluate(async item => {
    const vk = VaultCrypto.b64e(VaultCrypto.generateKey()); // syncKey is stored as base64
    const record = await VaultCrypto.encryptItem(item, vk);
    return { record, back: await VaultCrypto.decryptItem(record, vk) };
  }, ITEM);

  expect(result.back).toEqual(ITEM);
  expect(result.record.id).toBe(ITEM.id);
  expect(result.record.v).toBe(2);
  // Nothing readable leaks into the stored record.
  expect(JSON.stringify(result.record)).not.toContain('k7#Vq');
  expect(JSON.stringify(result.record)).not.toContain('GitHub');
});

test('each encryption uses a fresh item key and IV', async ({ context, extensionId }) => {
  const page = await cryptoPage(context, extensionId);
  const [a, b] = await page.evaluate(async item => {
    const vk = VaultCrypto.generateKey();
    return [await VaultCrypto.encryptItem(item, vk), await VaultCrypto.encryptItem(item, vk)];
  }, ITEM);
  expect(a.data.ct).not.toBe(b.data.ct);
  expect(a.key.ct).not.toBe(b.key.ct);
  expect(a.data.iv).not.toBe(b.data.iv);
});

test('decrypting with the wrong key fails', async ({ context, extensionId }) => {
  const page = await cryptoPage(context, extensionId);
  const error = await page.evaluate(async item => {
    const record = await VaultCrypto.encryptItem(item, VaultCrypto.generateKey());
    try { await VaultCrypto.decryptItem(record, VaultCrypto.generateKey()); return null; }
    catch (e) { return e.name; }
  }, ITEM);
  expect(error).toBe('OperationError');
});

test('a record relabelled with another item id fails to decrypt', async ({ context, extensionId }) => {
  // Guards against a server swapping one item's ciphertext in under another id.
  const page = await cryptoPage(context, extensionId);
  const error = await page.evaluate(async item => {
    const vk = VaultCrypto.generateKey();
    const record = await VaultCrypto.encryptItem(item, vk);
    try { await VaultCrypto.decryptItem({ ...record, id: 'some-other-id' }, vk); return null; }
    catch (e) { return e.name; }
  }, ITEM);
  expect(error).toBe('OperationError');
});

test('moving an item to a collection re-wraps only its key', async ({ context, extensionId }) => {
  const page = await cryptoPage(context, extensionId);
  const result = await page.evaluate(async item => {
    const vk = VaultCrypto.generateKey();
    const ck = VaultCrypto.generateKey();
    const personal = await VaultCrypto.encryptItem(item, vk);
    const shared = await VaultCrypto.rewrapItemKey(personal, vk, ck);
    let oldKeyFails = false;
    try { await VaultCrypto.decryptItem(shared, vk); } catch { oldKeyFails = true; }
    return {
      sameContent: shared.data.ct === personal.data.ct,
      back: await VaultCrypto.decryptItem(shared, ck),
      oldKeyFails,
    };
  }, ITEM);
  expect(result.sameContent).toBe(true);
  expect(result.back).toEqual(ITEM);
  expect(result.oldKeyFails).toBe(true);
});

test('the vault key wraps under a master password and rejects a wrong one', async ({ context, extensionId }) => {
  const page = await cryptoPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const vk = VaultCrypto.generateKey();
    const wrapped = await VaultCrypto.wrapVaultKey(vk, 'correct horse battery staple');
    const back = await VaultCrypto.unwrapVaultKey(wrapped, 'correct horse battery staple');
    let wrong = null;
    try { await VaultCrypto.unwrapVaultKey(wrapped, 'Correct horse battery staple'); }
    catch (e) { wrong = e.message; }
    return {
      matches: VaultCrypto.b64e(back) === VaultCrypto.b64e(vk),
      iterations: wrapped.iterations,
      kdf: wrapped.kdf,
      wrong,
    };
  });
  expect(result.matches).toBe(true);
  expect(result.iterations).toBe(600000);
  expect(result.kdf).toBe('PBKDF2-SHA256');
  expect(result.wrong).toBe('wrong password');
});

test('malformed inputs are rejected up front', async ({ context, extensionId }) => {
  const page = await cryptoPage(context, extensionId);
  const errors = await page.evaluate(async item => {
    const vk = VaultCrypto.generateKey();
    const attempt = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };
    return {
      noId: await attempt(() => VaultCrypto.encryptItem({ title: 'x' }, vk)),
      shortKey: await attempt(() => VaultCrypto.encryptItem(item, new Uint8Array(16))),
      oldFormat: await attempt(() => VaultCrypto.decryptItem({ id: item.id, v: 1 }, vk)),
      noPassword: await attempt(() => VaultCrypto.wrapVaultKey(vk, '')),
      rewrapNoVersion: await attempt(async () => {
        const { v, ...unversioned } = await VaultCrypto.encryptItem(item, vk);
        return VaultCrypto.rewrapItemKey(unversioned, vk, VaultCrypto.generateKey());
      }),
    };
  }, ITEM);
  expect(errors.noId).toBe('item.id required');
  expect(errors.shortKey).toBe('key must be 32 bytes');
  expect(errors.oldFormat).toBe('unsupported item format: 1');
  expect(errors.noPassword).toBe('password required');
  expect(errors.rewrapNoVersion).toBe('unsupported item format: undefined');
});

test('a stored vault key with an out-of-range iteration count is rejected', async ({ context, extensionId }) => {
  const page = await cryptoPage(context, extensionId);
  const errors = await page.evaluate(async () => {
    const wrapped = await VaultCrypto.wrapVaultKey(VaultCrypto.generateKey(), 'pw');
    const attempt = async iterations => {
      try { await VaultCrypto.unwrapVaultKey({ ...wrapped, iterations }, 'pw'); return null; }
      catch (e) { return e.message; }
    };
    return [await attempt(1000), await attempt(1e9), await attempt('600000')];
  });
  expect(errors).toEqual(Array(3).fill('unsupported vault key format'));
});
