import { test, expect, seedUnlocked, waitForVault, readAccounts } from './fixtures.js';

// 2.0 per-item sync (vaultSync.js) against an in-memory stand-in for the API's
// /vault/items endpoints (same semantics as api/src/routes/vault.rs: global
// revisions, 409 on a stale base_revision, tombstones, batch never overwrites).
// "Another device" is simulated by writing records encrypted with the same
// vault key straight into that server.

async function setup(context, extensionId, accounts = []) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts });
  await page.reload();
  await waitForVault(page);
  await page.evaluate(() => {
    const S = window.fakeServer = { rev: 0, items: new Map(), calls: [], pageSize: 1000, counts: {} };
    S.remoteSave = async item => {
      const record = await VaultCrypto.encryptItem(item, await VaultKeys.getKey());
      S.items.set(item.id, { record, revision: ++S.rev, deleted: false });
    };
    S.remoteDelete = id => S.items.set(id, { record: null, revision: ++S.rev, deleted: true });
    S.read = async id => {
      const v = S.items.get(id);
      return v && !v.deleted ? VaultCrypto.decryptItem(v.record, await VaultKeys.getKey()) : null;
    };
    const reply = (status, body) => ({ status, json: async () => body });
    CloudSync.api = async (path, opts = {}) => {
      const url = new URL(path, 'https://api.test');
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      S.calls.push(`${method} ${url.pathname}`);
      if (method === 'GET' && url.pathname === '/vault/items') {
        const since = Number(url.searchParams.get('since') || 0);
        const all = [...S.items.entries()].filter(([, v]) => v.revision > since).sort((a, b) => a[1].revision - b[1].revision);
        const list = all.slice(0, S.pageSize);
        return reply(200, {
          items: list.map(([id, v]) => ({ id, record: v.deleted ? null : v.record, revision: v.revision, deleted: v.deleted })),
          revision: list.length ? list[list.length - 1][1].revision : since,
          more: all.length > list.length,
        });
      }
      if (method === 'POST' && url.pathname === '/vault/items/batch') {
        const created = [], conflicts = [];
        for (const it of body.items) {
          if (S.items.has(it.id)) { conflicts.push(it.id); continue; }
          S.items.set(it.id, { record: it.record, revision: ++S.rev, deleted: false });
          S.counts[it.id] = it.counts_for_limit;
          created.push({ id: it.id, revision: S.rev });
        }
        return reply(200, { created, conflicts });
      }
      const id = url.pathname.split('/').pop();
      const cur = S.items.get(id);
      if (method === 'PUT') {
        if (cur && body.base_revision !== cur.revision) return reply(409, { item: { id, revision: cur.revision } });
        S.items.set(id, { record: body.record, revision: ++S.rev, deleted: false });
        return reply(200, { id, revision: S.rev });
      }
      if (method === 'DELETE') {
        if (!cur) return reply(404, {});
        if (Number(url.searchParams.get('base_revision')) !== cur.revision) return reply(409, {});
        S.items.set(id, { record: null, revision: ++S.rev, deleted: true });
        return reply(200, { id, revision: S.rev });
      }
      return reply(400, {});
    };
  });
  return page;
}

const sync = page => page.evaluate(async () => VaultSync.sync(await VaultKeys.getKey()));
const localTitles = page => page.evaluate(async () =>
  (await VaultStore.readAll(await VaultKeys.getKey())).items.map(i => i.title).sort());

const ACC = (name, secret) => ({ name, email: '', secret, urls: '', autofill: true });

test('the first sync uploads every local item in a batch; the next one sends nothing', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [ACC('GitHub', 'JBSWY3DPEHPK3PXP'), ACC('AWS', 'GEZDGNBVGY3TQOJQ')]);
  const first = await sync(page);
  expect(first.pushed).toBe(2);
  const second = await sync(page);
  expect(second).toEqual({ pulled: 0, pushed: 0, deleted: 0 });
  const calls = await page.evaluate(() => fakeServer.calls);
  expect(calls.filter(c => c.startsWith('POST')).length).toBe(1);
  expect(calls.filter(c => c.startsWith('PUT')).length).toBe(0);
});

test('an item added on another device appears here', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(() => fakeServer.remoteSave(Vault.newItem('note', { title: 'Wifi oficina' })));
  const stats = await sync(page);
  expect(stats.pulled).toBe(1);
  expect(await localTitles(page)).toEqual(['Wifi oficina']);
});

test('a local edit is uploaded against the revision it was based on', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [ACC('GitHub', 'JBSWY3DPEHPK3PXP')]);
  await sync(page);
  const id = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [item] = (await VaultStore.readAll(key)).items;
    item.title = 'GitHub (work)';
    item.updatedAt = new Date().toISOString();
    await VaultStore.save(item, key);
    return item.id;
  });
  const stats = await sync(page);
  expect(stats.pushed).toBe(1);
  expect((await page.evaluate(i => fakeServer.read(i), id)).title).toBe('GitHub (work)');
});

test('deletions travel both ways', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [ACC('A', 'JBSWY3DPEHPK3PXP'), ACC('B', 'GEZDGNBVGY3TQOJQ')]);
  await sync(page);
  const [a, b] = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items.sort((x, y) => x.title.localeCompare(y.title)).map(i => i.id));
  // A deleted on another device, B deleted here.
  await page.evaluate(([ra, lb]) => { fakeServer.remoteDelete(ra); return VaultStore.remove(lb); }, [a, b]);
  await sync(page);
  expect(await localTitles(page)).toEqual([]);
  expect(await page.evaluate(id => fakeServer.items.get(id).deleted, b)).toBe(true);
  expect(Object.keys(await page.evaluate(() => VaultStore.listTombstones()))).toEqual([]);
});

test('when both sides edited the same item, the newer edit wins', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [ACC('GitHub', 'JBSWY3DPEHPK3PXP')]);
  await sync(page);
  const result = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [item] = (await VaultStore.readAll(key)).items;
    // Here: older edit. There: newer edit.
    await VaultStore.save({ ...item, title: 'local (older)', updatedAt: '2026-10-01T10:00:00.000Z' }, key);
    await fakeServer.remoteSave({ ...item, title: 'remote (newer)', updatedAt: '2026-10-01T11:00:00.000Z' });
    await VaultSync.sync(key);
    const afterFirst = (await VaultStore.readAll(key)).items[0].title;
    // Now the other way round: a newer local edit is pushed over the server.
    const [again] = (await VaultStore.readAll(key)).items;
    await fakeServer.remoteSave({ ...again, title: 'remote (older)', updatedAt: '2026-10-01T12:00:00.000Z' });
    await VaultStore.save({ ...again, title: 'local (newer)', updatedAt: '2026-10-01T13:00:00.000Z' }, key);
    await VaultSync.sync(key);
    return { afterFirst, local: (await VaultStore.readAll(key)).items[0].title, server: (await fakeServer.read(again.id)).title };
  });
  expect(result).toEqual({ afterFirst: 'remote (newer)', local: 'local (newer)', server: 'local (newer)' });
});

test('an item edited here but deleted elsewhere is kept and uploaded again', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [ACC('GitHub', 'JBSWY3DPEHPK3PXP')]);
  await sync(page);
  const result = await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [item] = (await VaultStore.readAll(key)).items;
    fakeServer.remoteDelete(item.id);
    await VaultStore.save({ ...item, title: 'still needed', updatedAt: new Date().toISOString() }, key);
    await VaultSync.sync(key);
    return { local: (await VaultStore.readAll(key)).items.map(i => i.title), server: (await fakeServer.read(item.id))?.title };
  });
  expect(result).toEqual({ local: ['still needed'], server: 'still needed' });
});

test('Sync now brings items from another device into the account list', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [ACC('GitHub', 'JBSWY3DPEHPK3PXP')]);
  await page.evaluate(async () => {
    const item = Vault.fromV1Account({ name: 'From laptop', secret: 'GEZDGNBVGY3TQOJQ', urls: '' }, 5);
    await fakeServer.remoteSave(item);
    // No v1 blob on the server in this test.
    CloudSync.getServerMeta = async () => null;
    CloudSync.push = async () => ({});
    await doSync();
  });
  expect((await readAccounts(page)).map(a => a.name)).toEqual(['GitHub', 'From laptop']);
});

test('a pull follows the server\'s pages until there are no more', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(async () => {
    fakeServer.pageSize = 2;
    for (const t of ['a', 'b', 'c', 'd', 'e']) await fakeServer.remoteSave(Vault.newItem('note', { title: t }));
  });
  const stats = await sync(page);
  expect(stats.pulled).toBe(5);
  expect(await localTitles(page)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect((await page.evaluate(() => fakeServer.calls)).filter(c => c.startsWith('GET')).length).toBe(3);
});

test('uploads tell the server which items count toward the Free limit', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, [ACC('2FA only', 'JBSWY3DPEHPK3PXP')]);
  await page.evaluate(async () => VaultStore.save(Vault.newItem('note', { title: 'note' }), await VaultKeys.getKey()));
  await sync(page);
  const counts = await page.evaluate(async () => {
    const { items } = await VaultStore.readAll(await VaultKeys.getKey());
    return Object.fromEntries(items.map(i => [i.title, fakeServer.counts[i.id]]));
  });
  expect(counts).toEqual({ '2FA only': false, note: true });
});
