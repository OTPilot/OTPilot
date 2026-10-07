'use strict';

// Team collections (2.0, "share everything"): items shared end-to-end with
// chosen team members (needs vaultCrypto.js, keys.js, cloudSync.js).
//
// Each collection has a collection key (CK, 32 random bytes) that the server
// never sees: every member's row carries CK wrapped to their ECDH public key
// (TeamKeys, the same ECIES as shared codes). Items are encrypted exactly
// like personal ones, with their item key wrapped under CK instead of the
// vault key; the collection's name is encrypted under CK too.
//
// Local storage, apart from personal items so personal sync never touches
// them: `cr:<cid>:<id>` the encrypted record, `cs:<cid>` the sync state
// { cursor, revs: { [id]: revision } }. Unwrapped CKs live only in
// chrome.storage.session (`collectionKeys`), cleared when the vault locks.
// Writes go straight to the server (base_revision / 409), so there's no
// offline editing of shared items.
const VaultCollections = (() => {
  const RECORD = cid => `cr:${cid}:`;
  const STATE = cid => `cs:${cid}`;
  const KEYS = 'collectionKeys';
  // The last GET /collections rows, as the server sent them (names and keys
  // still encrypted/wrapped), with the user they belong to: lets shared items
  // load without a connection — only for that same signed-in user.
  const LIST_CACHE = 'collectionsList';

  async function currentUserId() {
    try { return (await SupabaseAuth.getSession())?.user?.id ?? null; } catch { return null; }
  }
  const local = chrome.storage.local;
  const session = chrome.storage.session;

  async function api(path, opts) {
    const res = await CloudSync.api(path, opts);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function ok(path, opts) {
    const { status, body } = await api(path, opts);
    if (status !== 200) throw Object.assign(new Error(body?.error || `collections ${status}`), { status, body });
    return body;
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  async function cachedKeys() {
    return (await session.get(KEYS))[KEYS] || {};
  }

  // Caches a collection key for the session — under the vault lock, and only
  // while the vault is still unlocked: a lock that happened meanwhile
  // (VaultKeys.lock clears this cache in the same lock) must not be undone.
  // Throws when locked.
  function cacheKey(cid, key) {
    return navigator.locks.request('otpilot-vault', async () => {
      if (!(await session.get('vaultKeyUnlocked')).vaultKeyUnlocked) throw new Error('vault is locked');
      await session.set({ [KEYS]: { ...(await cachedKeys()), [cid]: key } });
    });
  }

  // The collection key (base64) for `c` (a row of GET /collections), unwrapped
  // with this user's team private key and cached for the session.
  async function keyFor(c) {
    const cached = await cachedKeys();
    if (cached[c.id]) return cached[c.id];
    const ck = VaultCrypto.b64e(await TeamKeys.unwrapUserShare(c.wrapped_key));
    await cacheKey(c.id, ck);
    return ck;
  }

  function forgetKeys() {
    return session.remove(KEYS);
  }

  // ── Collections ───────────────────────────────────────────────────────────

  // My collections: { id, teamId, name, role, members, key } — `name`/`key`
  // are null when this device can't unwrap the key (a team keypair from
  // another device that never synced here). Local data of collections no
  // longer listed (removed, deleted) is dropped.
  async function list() {
    let collections, offline = false;
    const userId = await currentUserId();
    try {
      ({ collections = [] } = await ok('/collections'));
      await local.set({ [LIST_CACHE]: { userId, collections } });
    } catch (e) {
      // No connection (or the API is down): the last known list, if it is
      // this user's. An answer from the server (e.g. 401/403) isn't
      // "offline" — rethrown.
      if (e.status) throw e;
      const cached = (await local.get(LIST_CACHE))[LIST_CACHE];
      if (!userId || cached?.userId !== userId || !Array.isArray(cached.collections)) throw e;
      collections = cached.collections;
      offline = true;
    }
    const out = [];
    for (const c of collections) {
      let key = null, name = null;
      try {
        key = await keyFor(c);
        name = await VaultCrypto.decryptName(c.encrypted_name, key, c.id);
      } catch { key = null; }
      out.push({ id: c.id, teamId: c.team_id, name, role: c.role, members: c.members, key, offline });
    }
    if (!offline) await forgetOthers(new Set(collections.map(c => c.id)));
    return out;
  }

  async function create(teamId, name) {
    const id = crypto.randomUUID();
    const raw = VaultCrypto.generateKey();
    const key = VaultCrypto.b64e(raw);
    await ok(`/teams/${teamId}/collections`, {
      method: 'POST',
      body: JSON.stringify({
        id,
        encrypted_name: await VaultCrypto.encryptName(name, key, id),
        wrapped_key: await TeamKeys.wrapUserShare(raw, await TeamKeys.getPublicKeyB64()),
      }),
    });
    await cacheKey(id, key);
    return { id, teamId, name, role: 'manage', members: 1, key };
  }

  async function rename(c, name) {
    await ok(`/collections/${c.id}`, { method: 'PATCH', body: JSON.stringify({ encrypted_name: await VaultCrypto.encryptName(name, c.key, c.id) }) });
  }

  async function remove(c) {
    await ok(`/collections/${c.id}`, { method: 'DELETE' });
    await forget(c.id);
  }

  async function members(c) {
    return (await ok(`/collections/${c.id}/members`)).members || [];
  }

  // Adds a team member (`user` from the team's member list: { user_id,
  // public_key }) with `role`, wrapping CK to their public key. A member with
  // no public key yet (never signed in to 2.0) can't be added.
  async function addMember(c, user, role) {
    if (!user.public_key) throw new Error('This teammate has to sign in to OTPilot once before they can be added');
    await ok(`/collections/${c.id}/members/${user.user_id}`, {
      method: 'PUT',
      body: JSON.stringify({ role, wrapped_key: await TeamKeys.wrapUserShare(VaultCrypto.b64d(c.key), user.public_key) }),
    });
  }

  async function setRole(c, userId, role) {
    await ok(`/collections/${c.id}/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) });
  }

  async function removeMember(c, userId) {
    await ok(`/collections/${c.id}/members/${userId}`, { method: 'DELETE' });
  }

  // ── Items ─────────────────────────────────────────────────────────────────
  // Everything that reads or writes a collection's local records or sync
  // state — pulls, saves, deletes, including their server requests — runs
  // one at a time per collection, so a pull can't store an older revision
  // over a save, or a write lose another's remembered revision.
  const serial = (cid, fn) => navigator.locks.request(`otpilot-collection:${cid}`, fn);

  async function loadState(cid) {
    const s = (await local.get(STATE(cid)))[STATE(cid)];
    return { cursor: s?.cursor ?? 0, revs: s?.revs ?? {} };
  }

  // Pulls what changed since the last pull (all pages) into local storage.
  // Records this device can't decrypt are skipped (counted in `unreadable`).
  function pull(c) {
    return serial(c.id, () => pullNow(c));
  }

  async function pullNow(c) {
    const state = await loadState(c.id);
    let pulled = 0, deleted = 0, unreadable = 0;
    for (let more = true; more;) {
      const body = await ok(`/collections/${c.id}/items?since=${state.cursor}`);
      const sets = {}, dels = [];
      for (const r of body.items || []) {
        if (r.deleted) {
          dels.push(RECORD(c.id) + r.id);
          delete state.revs[r.id];
          deleted++;
          continue;
        }
        try { await VaultCrypto.decryptItem(r.record, c.key); } catch { unreadable++; continue; }
        sets[RECORD(c.id) + r.id] = r.record;
        state.revs[r.id] = r.revision;
        pulled++;
      }
      state.cursor = body.revision ?? state.cursor;
      more = !!body.more;
      if (dels.length) await local.remove(dels);
      await local.set({ ...sets, [STATE(c.id)]: state });
    }
    return { pulled, deleted, unreadable };
  }

  // The collection's items, decrypted (unreadable records left out).
  async function items(c) {
    const all = await local.get(null);
    const prefix = RECORD(c.id);
    const out = [];
    for (const [k, rec] of Object.entries(all)) {
      if (!k.startsWith(prefix)) continue;
      try { out.push(await VaultCrypto.decryptItem(rec, c.key)); } catch { /* unreadable */ }
    }
    return out.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }

  // Saves one item to the collection (create, or update from the revision
  // this device last pulled). Returns { ok: true } or, when someone else
  // changed it meanwhile, { conflict: true } after pulling their version.
  function save(c, item) {
    return serial(c.id, () => saveNow(c, item));
  }

  async function saveNow(c, item) {
    const state = await loadState(c.id);
    const record = await VaultCrypto.encryptItem({ ...item, updatedAt: new Date().toISOString() }, c.key);
    const base = state.revs[item.id];
    const { status, body } = await api(`/collections/${c.id}/items/${item.id}`, {
      method: 'PUT',
      body: JSON.stringify({ record, ...(base !== undefined ? { base_revision: base } : {}) }),
    });
    if (status === 409) { await pullNow(c); return { conflict: true }; }
    if (status !== 200) throw Object.assign(new Error(body?.error || `collection item ${status}`), { status });
    state.revs[item.id] = body.revision;
    await local.set({ [RECORD(c.id) + item.id]: record, [STATE(c.id)]: state });
    return { ok: true };
  }

  function deleteItem(c, id) {
    return serial(c.id, () => deleteNow(c, id));
  }

  async function deleteNow(c, id) {
    const state = await loadState(c.id);
    const base = state.revs[id];
    if (base === undefined) return { ok: false };
    const { status } = await api(`/collections/${c.id}/items/${id}?base_revision=${base}`, { method: 'DELETE' });
    if (status === 409) { await pullNow(c); return { conflict: true }; }
    if (status !== 200 && status !== 404) throw Object.assign(new Error(`collection delete ${status}`), { status });
    delete state.revs[id];
    await local.remove(RECORD(c.id) + id);
    await local.set({ [STATE(c.id)]: state });
    return { ok: true };
  }

  // Moves a personal item into the collection: re-encrypted under CK (the
  // personal copy is removed by the caller once this succeeds).
  async function moveIn(c, item) {
    return save(c, { ...item, id: crypto.randomUUID() });
  }

  // ── Local cleanup ─────────────────────────────────────────────────────────

  function forget(cid) {
    return serial(cid, () => forgetNow(cid));
  }

  async function forgetNow(cid) {
    const all = await local.get(null);
    await local.remove(Object.keys(all).filter(k => k.startsWith(RECORD(cid)) || k === STATE(cid)));
    const keys = await cachedKeys();
    if (keys[cid]) { delete keys[cid]; await session.set({ [KEYS]: keys }); }
  }

  // Collections known locally — by stored records/state or by a cached key
  // (one created or listed but never pulled has only the key) — that the
  // server no longer lists for this user.
  async function forgetOthers(keep) {
    const all = await local.get(null);
    const stale = new Set(Object.keys(await cachedKeys()).filter(cid => !keep.has(cid)));
    for (const k of Object.keys(all)) {
      const m = /^c[rs]:([0-9a-f-]{36})/.exec(k);
      if (m && !keep.has(m[1])) stale.add(m[1]);
    }
    for (const cid of stale) await forget(cid);
  }

  return {
    list, create, rename, remove, members, addMember, setRole, removeMember,
    pull, items, save, deleteItem, moveIn, forget, forgetKeys,
  };
})();
