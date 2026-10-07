import { test, expect, seedUnlocked, waitForVault } from './fixtures.js';

// Team collections in the extension (vaultCollections.js) against an
// in-memory stand-in for the API's /collections endpoints (same contract as
// api/src/routes/collections.rs: wrapped keys and names are opaque, items use
// revisions with base_revision / 409).

async function setup(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  await page.evaluate(() => {
    const S = window.fake = { rev: 0, collections: new Map(), items: new Map(), me: 'user-me' };
    const reply = (status, body) => ({ status, json: async () => body });
    CloudSync.api = async (path, opts = {}) => {
      const url = new URL(path, 'https://api.test');
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'teams' && parts[2] === 'collections' && method === 'POST') {
        S.collections.set(body.id, { id: body.id, team_id: parts[1], encrypted_name: body.encrypted_name, members: new Map([[S.me, { role: 'manage', wrapped_key: body.wrapped_key }]]) });
        return reply(200, { id: body.id });
      }
      if (parts[0] !== 'collections') return reply(404, {});
      if (parts.length === 1) {
        return reply(200, { collections: [...S.collections.values()].filter(c => c.members.has(S.me)).map(c => ({
          id: c.id, team_id: c.team_id, encrypted_name: c.encrypted_name, role: c.members.get(S.me).role,
          wrapped_key: c.members.get(S.me).wrapped_key, members: c.members.size,
        })) });
      }
      const c = S.collections.get(parts[1]);
      if (!c || !c.members.has(S.me)) return reply(404, {});
      if (parts.length === 2 && method === 'PATCH') { c.encrypted_name = body.encrypted_name; return reply(200, { ok: true }); }
      if (parts.length === 2 && method === 'DELETE') { S.collections.delete(c.id); return reply(200, { ok: true }); }
      if (parts[2] === 'members' && parts[3] && method === 'PUT') {
        c.members.set(parts[3], { role: body.role, wrapped_key: body.wrapped_key ?? c.members.get(parts[3])?.wrapped_key });
        return reply(200, { ok: true });
      }
      if (parts[2] === 'items' && !parts[3]) {
        const since = Number(url.searchParams.get('since') || 0);
        const list = [...S.items.values()].filter(i => i.cid === c.id && i.revision > since).sort((a, b) => a.revision - b.revision);
        return reply(200, { items: list.map(i => ({ id: i.id, record: i.deleted ? null : i.record, revision: i.revision, deleted: !!i.deleted })), revision: list.length ? list[list.length - 1].revision : since, more: false });
      }
      if (parts[2] === 'items' && parts[3]) {
        const cur = S.items.get(parts[3]);
        if (method === 'PUT') {
          if (cur && body.base_revision !== cur.revision) return reply(409, { item: { id: cur.id, revision: cur.revision } });
          S.items.set(parts[3], { id: parts[3], cid: c.id, record: body.record, revision: ++S.rev });
          return reply(200, { id: parts[3], revision: S.rev });
        }
        if (method === 'DELETE') {
          if (!cur) return reply(404, {});
          if (Number(url.searchParams.get('base_revision')) !== cur.revision) return reply(409, {});
          S.items.set(parts[3], { ...cur, record: null, deleted: true, revision: ++S.rev });
          return reply(200, { id: parts[3], revision: S.rev });
        }
      }
      return reply(400, {});
    };
  });
  return page;
}

test('creating a collection sends only ciphertext; listing decrypts the name and caches the key for the session', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const created = await VaultCollections.create('team-1', 'Infra secrets');
    const server = fake.collections.get(created.id);
    await chrome.storage.session.remove('collectionKeys'); // a new session: unwrap again
    const [listed] = await VaultCollections.list();
    const cached = (await chrome.storage.session.get('collectionKeys')).collectionKeys;
    await VaultLock.lock();
    const afterLock = (await chrome.storage.session.get('collectionKeys')).collectionKeys;
    return {
      serverName: server.encrypted_name, serverKey: server.members.get('user-me').wrapped_key,
      listed: { ...listed, key: !!listed.key }, keyMatches: listed.key === created.key, cached: !!cached?.[created.id], afterLock,
    };
  });
  expect(r.serverName).not.toContain('Infra');
  expect(JSON.parse(r.serverKey)).toHaveProperty('epk');
  expect(r.listed).toMatchObject({ name: 'Infra secrets', role: 'manage', members: 1, key: true, teamId: 'team-1' });
  expect(r.keyMatches).toBe(true);
  expect(r.cached).toBe(true);
  expect(r.afterLock).toBeUndefined();
});

test('items are encrypted under the collection key, pulled into their own storage, and never mixed with personal items', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Shared');
    const item = Vault.newItem('login', { title: 'AWS root' });
    Vault.getField(item, 'password').value = 'pw';
    const saved = await VaultCollections.save(c, item);
    const record = fake.items.get(item.id).record;
    const vk = await VaultKeys.getKey();
    const underVk = await VaultCrypto.decryptItem(record, vk).then(() => true, () => false);
    // Another device: nothing local yet, pulls it.
    await VaultCollections.forget(c.id);
    const [again] = await VaultCollections.list();
    const pull = await VaultCollections.pull(again);
    const items = await VaultCollections.items(again);
    const personal = (await VaultStore.readAll(vk)).items.length;
    return { saved, underVk, pull, titles: items.map(i => [i.title, Vault.getValue(i, 'password')]), personal };
  });
  expect(r.saved).toEqual({ ok: true });
  expect(r.underVk).toBe(false);
  expect(r.pull).toEqual({ pulled: 1, deleted: 0, unreadable: 0 });
  expect(r.titles).toEqual([['AWS root', 'pw']]);
  expect(r.personal).toBe(0);
});

test('a write based on a stale revision reports a conflict and brings in the newer version', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Shared');
    const item = Vault.newItem('note', { title: 'Runbook', notes: 'v1' });
    await VaultCollections.save(c, item);
    // A teammate updates it meanwhile.
    const theirs = await VaultCrypto.encryptItem({ ...item, notes: 'v2 (teammate)' }, c.key);
    fake.items.set(item.id, { ...fake.items.get(item.id), record: theirs, revision: ++fake.rev });
    const mine = await VaultCollections.save(c, { ...item, notes: 'v2 (me)' });
    const now = (await VaultCollections.items(c))[0].notes;
    // Saving again, from the pulled revision, works.
    const retry = await VaultCollections.save(c, { ...item, notes: 'v3 (me)' });
    const del = await VaultCollections.deleteItem(c, item.id);
    return { mine, now, retry, del, left: (await VaultCollections.items(c)).length, serverDeleted: fake.items.get(item.id).deleted };
  });
  expect(r.mine).toEqual({ conflict: true });
  expect(r.now).toBe('v2 (teammate)');
  expect(r.retry).toEqual({ ok: true });
  expect(r.del).toEqual({ ok: true });
  expect(r.left).toBe(0);
  expect(r.serverDeleted).toBe(true);
});

test('adding a teammate wraps the collection key to their public key only', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Shared');
    // The teammate's own keypair.
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const pub = VaultCrypto.b64e(await crypto.subtle.exportKey('raw', kp.publicKey));
    const theirJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    let refused = null;
    try { await VaultCollections.addMember(c, { user_id: 'user-nokey', public_key: null }, 'view'); } catch (e) { refused = e.message; }
    await VaultCollections.addMember(c, { user_id: 'user-bob', public_key: pub }, 'edit');
    const wrapped = fake.collections.get(c.id).members.get('user-bob').wrapped_key;
    const mineByMe = await TeamKeys.unwrapUserShare(wrapped).then(() => true, () => false);
    // As Bob: his private key unwraps it to the same collection key.
    const myJwk = await TeamKeys.exportPrivJwk();
    await TeamKeys.adoptPrivJwk(theirJwk);
    const bobsKey = VaultCrypto.b64e(await TeamKeys.unwrapUserShare(wrapped));
    await TeamKeys.adoptPrivJwk(myJwk);
    return { refused, role: fake.collections.get(c.id).members.get('user-bob').role, mineByMe, same: bobsKey === c.key };
  });
  expect(r.refused).toContain('sign in to OTPilot once');
  expect(r.role).toBe('edit');
  expect(r.mineByMe).toBe(false);
  expect(r.same).toBe(true);
});

test('a collection no longer listed (removed from it, or deleted) leaves nothing behind locally', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Shared');
    await VaultCollections.save(c, Vault.newItem('note', { title: 'x' }));
    const keysBefore = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('cr:') || k.startsWith('cs:')).length;
    fake.collections.get(c.id).members.delete('user-me'); // removed by a manager
    const listed = await VaultCollections.list();
    const keysAfter = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('cr:') || k.startsWith('cs:')).length;
    const cached = (await chrome.storage.session.get('collectionKeys')).collectionKeys || {};
    return { keysBefore, listed: listed.length, keysAfter, cached: c.id in cached };
  });
  expect(r).toEqual({ keysBefore: 2, listed: 0, keysAfter: 0, cached: false });
});
