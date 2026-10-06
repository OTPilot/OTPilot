import { test, expect } from './fixtures.js';

// vaultStore.js isn't wired into any page yet, so each test loads it (and the
// vaultCrypto.js it needs) into an extension page with a clean storage.
async function storePage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.evaluate(() => new Promise(r => chrome.storage.local.clear(r)));
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/vaultCrypto.js` });
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/vaultStore.js` });
  return page;
}

const item = (id, title) => ({ id, type: 'note', title, fields: [], notes: `secret notes for ${title}` });

test('saved items read back decrypted and are stored encrypted, one key per item', async ({ context, extensionId }) => {
  const page = await storePage(context, extensionId);
  const result = await page.evaluate(async items => {
    const vk = VaultCrypto.generateKey();
    await VaultStore.save(items, vk);
    const raw = await new Promise(r => chrome.storage.local.get(null, r));
    const { items: back, failed } = await VaultStore.readAll(vk);
    return {
      keys: Object.keys(raw).sort(),
      rawText: JSON.stringify(raw),
      titles: back.map(i => i.title).sort(),
      failed,
      one: await VaultStore.get('a', vk),
    };
  }, [item('a', 'Wifi oficina'), item('b', 'Router')]);

  expect(result.keys).toEqual(['vi:a', 'vi:b']);
  expect(result.rawText).not.toContain('secret notes');
  expect(result.titles).toEqual(['Router', 'Wifi oficina']);
  expect(result.failed).toEqual([]);
  expect(result.one.title).toBe('Wifi oficina');
});

test('removing an item leaves a tombstone, and saving it again clears it', async ({ context, extensionId }) => {
  const page = await storePage(context, extensionId);
  const result = await page.evaluate(async it => {
    const vk = VaultCrypto.generateKey();
    await VaultStore.save(it, vk);
    await VaultStore.remove('a', '2026-10-06T12:00:00.000Z');
    const afterRemove = {
      records: Object.keys(await VaultStore.listRecords()),
      tombs: await VaultStore.listTombstones(),
      missing: await VaultStore.get('a', vk),
    };
    await VaultStore.save(it, vk);
    return {
      afterRemove,
      afterResave: { records: Object.keys(await VaultStore.listRecords()), tombs: await VaultStore.listTombstones() },
    };
  }, item('a', 'Wifi oficina'));

  expect(result.afterRemove).toEqual({ records: [], tombs: { a: '2026-10-06T12:00:00.000Z' }, missing: null });
  expect(result.afterResave).toEqual({ records: ['a'], tombs: {} });
});

test('a record that fails to decrypt is reported without hiding the rest', async ({ context, extensionId }) => {
  const page = await storePage(context, extensionId);
  const result = await page.evaluate(async items => {
    const vk = VaultCrypto.generateKey();
    await VaultStore.save(items, vk);
    const rec = (await new Promise(r => chrome.storage.local.get('vi:b', r)))['vi:b'];
    await new Promise(r => chrome.storage.local.set({ 'vi:b': { ...rec, data: { ...rec.data, ct: rec.data.ct.slice(4) + 'AAAA' } } }, r));
    const { items: back, failed } = await VaultStore.readAll(vk);
    return { titles: back.map(i => i.title), failed };
  }, [item('a', 'Wifi oficina'), item('b', 'Router')]);

  expect(result).toEqual({ titles: ['Wifi oficina'], failed: ['b'] });
});

test('concurrent saves of different items from two pages both land', async ({ context, extensionId }) => {
  // The reason records are stored one key per item.
  const [p1, p2] = [await storePage(context, extensionId), await storePage(context, extensionId)];
  const vkB64 = await p1.evaluate(() => VaultCrypto.b64e(VaultCrypto.generateKey()));
  await Promise.all([
    p1.evaluate(([vk, it]) => VaultStore.save(it, vk), [vkB64, item('a', 'A')]),
    p2.evaluate(([vk, it]) => VaultStore.save(it, vk), [vkB64, item('b', 'B')]),
  ]);
  const titles = await p1.evaluate(async vk => (await VaultStore.readAll(vk)).items.map(i => i.title).sort(), vkB64);
  expect(titles).toEqual(['A', 'B']);
});

test('clear wipes vault records and tombstones but nothing else', async ({ context, extensionId }) => {
  const page = await storePage(context, extensionId);
  const keys = await page.evaluate(async items => {
    const vk = VaultCrypto.generateKey();
    await new Promise(r => chrome.storage.local.set({ theme: 'vault', accounts: [] }, r));
    await VaultStore.save(items, vk);
    await VaultStore.remove('b');
    await VaultStore.clear();
    return Object.keys(await new Promise(r => chrome.storage.local.get(null, r))).sort();
  }, [item('a', 'A'), item('b', 'B')]);
  expect(keys).toEqual(['accounts', 'theme']);
});

test("an item whose id is '__proto__' is stored and read back like any other", async ({ context, extensionId }) => {
  const page = await storePage(context, extensionId);
  const result = await page.evaluate(async it => {
    const vk = VaultCrypto.generateKey();
    await VaultStore.save(it, vk);
    const { items, failed } = await VaultStore.readAll(vk);
    await VaultStore.remove('__proto__', '2026-10-06T12:00:00.000Z');
    return { titles: items.map(i => i.title), failed, tombs: Object.keys(await VaultStore.listTombstones()) };
  }, item('__proto__', 'Odd id'));
  expect(result).toEqual({ titles: ['Odd id'], failed: [], tombs: ['__proto__'] });
});

test('a save Chrome rejects (over quota) throws and keeps the tombstone', async ({ context, extensionId }) => {
  const page = await storePage(context, extensionId);
  const result = await page.evaluate(async () => {
    const vk = VaultCrypto.generateKey();
    await VaultStore.remove('big', '2026-10-06T12:00:00.000Z');
    // ~11 MB of notes: past chrome.storage.local's 10 MB quota once encrypted.
    const huge = { id: 'big', type: 'note', title: 'Too big', fields: [], notes: 'x'.repeat(11 * 1024 * 1024) };
    let error = null;
    try { await VaultStore.save(huge, vk); } catch (e) { error = e.message; }
    return {
      threw: !!error,
      records: Object.keys(await VaultStore.listRecords()),
      tombs: Object.keys(await VaultStore.listTombstones()),
    };
  });
  expect(result).toEqual({ threw: true, records: [], tombs: ['big'] });
});
