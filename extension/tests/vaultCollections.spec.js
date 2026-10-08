import { test, expect, seedUnlocked, waitForVault, TEST_PASSWORD } from './fixtures.js';
import { installFakeCollections } from './fakeCollections.js';

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
  await installFakeCollections(page);
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

// ── Review hardening ─────────────────────────────────────────────────────────

test('a key unwrapped while the vault locks is not cached after the lock', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Shared');
    await chrome.storage.session.remove('collectionKeys');
    // The unwrap is slow; the vault locks meanwhile.
    const unwrap = TeamKeys.unwrapUserShare;
    TeamKeys.unwrapUserShare = async (...a) => { const k = await unwrap(...a); await VaultLock.lock(); return k; };
    let listed;
    try { listed = await VaultCollections.list(); } catch (e) { listed = e.message; }
    TeamKeys.unwrapUserShare = unwrap;
    return { cached: (await chrome.storage.session.get('collectionKeys')).collectionKeys?.[c.id] ?? null, key: listed?.[0]?.key ?? null };
  });
  expect(r).toEqual({ cached: null, key: null });
});

test('a pull overlapping a save never stores the older revision over the saved one', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Shared');
    const item = Vault.newItem('note', { title: 'Doc', notes: 'v1' });
    await VaultCollections.save(c, item);
    await VaultCollections.forget(c.id); // nothing local: the pull below brings v1
    const [again] = await VaultCollections.list();
    // A slow pull (fetches v1, pauses decrypting) and a save of v2 at the same time.
    const decrypt = VaultCrypto.decryptItem;
    VaultCrypto.decryptItem = async (...a) => { await new Promise(r => setTimeout(r, 300)); return decrypt(...a); };
    const pulling = VaultCollections.pull(again);
    await new Promise(r => setTimeout(r, 50));
    const saving = VaultCollections.save(again, { ...item, notes: 'v2' });
    await Promise.all([pulling, saving]);
    VaultCrypto.decryptItem = decrypt;
    const state = (await chrome.storage.local.get(`cs:${again.id}`))[`cs:${again.id}`];
    return { notes: (await VaultCollections.items(again))[0].notes, rev: state.revs[item.id], server: fake.items.get(item.id).revision };
  });
  expect(r.notes).toBe('v2');
  expect(r.rev).toBe(r.server);
});

test('a collection created here and removed before any item was saved leaves no cached key', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Empty');
    fake.collections.get(c.id).members.delete('user-me');
    await VaultCollections.list();
    return c.id in ((await chrome.storage.session.get('collectionKeys')).collectionKeys || {});
  });
  expect(r).toBe(false);
});

test('an editor saving against the revision it opened does not overwrite a teammate change pulled meanwhile', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const c = await VaultCollections.create('team-1', 'Shared');
    const item = Vault.newItem('note', { title: 'Runbook', notes: 'v1' });
    await VaultCollections.save(c, item);
    const [{ revision: opened }] = await VaultCollections.snapshot(c); // the editor opens v1
    // A teammate changes it, and another popup's refresh pulls that change.
    const theirs = await VaultCrypto.encryptItem({ ...item, notes: 'v2 (teammate)' }, c.key);
    fake.items.set(item.id, { ...fake.items.get(item.id), record: theirs, revision: ++fake.rev });
    await VaultCollections.pull(c);
    const saved = await VaultCollections.save(c, { ...item, notes: 'v1 edited (me)' }, opened);
    const server = await VaultCrypto.decryptItem(fake.items.get(item.id).record, c.key);
    const deleted = await VaultCollections.deleteItem(c, item.id, opened);
    return { saved, server: server.notes, deleted, stillThere: !fake.items.get(item.id).deleted };
  });
  expect(r).toEqual({ saved: { conflict: true }, server: 'v2 (teammate)', deleted: { conflict: true }, stillThere: true });
});

test('the team private key is stored encrypted under the vault key and follows a vault key change', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async password => {
    const c = await VaultCollections.create('team-1', 'Shared');
    const wrapped = fake.collections.get(c.id).members.get('user-me').wrapped_key;
    const jwk = await TeamKeys.exportPrivJwk();
    const raw = JSON.stringify(await chrome.storage.local.get(null));
    // Locked: the public key is still there; the private key can't be used.
    await VaultLock.lock();
    const pubLocked = await TeamKeys.getPublicKeyB64();
    const unwrapLocked = await TeamKeys.unwrapUserShare(wrapped).then(() => 'unwrapped', e => e.message);
    await VaultLock.unlock(password);
    // A recovery key restored: the vault key changes, the team key follows.
    await VaultKeys.adoptKey(VaultCrypto.b64e(VaultCrypto.generateKey()), password);
    const afterRekey = VaultCrypto.b64e(await TeamKeys.unwrapUserShare(wrapped)) === c.key;
    return { plaintext: raw.includes(jwk.d), pubLocked: !!pubLocked, unwrapLocked, afterRekey };
  }, TEST_PASSWORD);
  expect(r).toEqual({ plaintext: false, pubLocked: true, unwrapLocked: 'the vault is locked', afterRekey: true });
});

test('a plaintext team private key from before is encrypted on first use, same keypair', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const r = await page.evaluate(async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = VaultCrypto.b64e(await crypto.subtle.exportKey('raw', kp.publicKey));
    await chrome.storage.local.set({ teamPrivJwk: jwk });
    const share = await TeamKeys.wrapUserShare(new Uint8Array(32).fill(7), pub);
    const pubBefore = await TeamKeys.getPublicKeyB64();
    const unwrapped = await TeamKeys.unwrapUserShare(share);
    const stored = await chrome.storage.local.get(['teamPrivJwk', 'teamPrivWrapped']);
    return { samePub: pubBefore === pub, ok: unwrapped.every(b => b === 7), legacy: 'teamPrivJwk' in stored, wrapped: !!stored.teamPrivWrapped };
  });
  expect(r).toEqual({ samePub: true, ok: true, legacy: false, wrapped: true });
});
