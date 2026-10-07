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

  // The collection key (base64) for `c` (a row of GET /collections), unwrapped
  // with this user's team private key and cached for the session.
  async function keyFor(c) {
    const cached = await cachedKeys();
    if (cached[c.id]) return cached[c.id];
    const ck = VaultCrypto.b64e(await TeamKeys.unwrapUserShare(c.wrapped_key));
    await session.set({ [KEYS]: { ...(await cachedKeys()), [c.id]: ck } });
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
    const { collections = [] } = await ok('/collections');
    const out = [];
    for (const c of collections) {
      let key = null, name = null;
      try {
        key = await keyFor(c);
        name = await VaultCrypto.decryptName(c.encrypted_name, key, c.id);
      } catch { key = null; }
      out.push({ id: c.id, teamId: c.team_id, name, role: c.role, members: c.members, key });
    }
    await forgetOthers(new Set(collections.map(c => c.id)));
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
    await session.set({ [KEYS]: { ...(await cachedKeys()), [id]: key } });
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

  async function loadState(cid) {
    const s = (await local.get(STATE(cid)))[STATE(cid)];
    return { cursor: s?.cursor ?? 0, revs: s?.revs ?? {} };
  }

  // Pulls what changed since the last pull (all pages) into local storage.
  // Records this device can't decrypt are skipped (counted in `unreadable`).
  async function pull(c) {
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
  async function save(c, item) {
    const state = await loadState(c.id);
    const record = await VaultCrypto.encryptItem({ ...item, updatedAt: new Date().toISOString() }, c.key);
    const base = state.revs[item.id];
    const { status, body } = await api(`/collections/${c.id}/items/${item.id}`, {
      method: 'PUT',
      body: JSON.stringify({ record, ...(base !== undefined ? { base_revision: base } : {}) }),
    });
    if (status === 409) { await pull(c); return { conflict: true }; }
    if (status !== 200) throw Object.assign(new Error(body?.error || `collection item ${status}`), { status });
    const fresh = await loadState(c.id);
    fresh.revs[item.id] = body.revision;
    await local.set({ [RECORD(c.id) + item.id]: record, [STATE(c.id)]: fresh });
    return { ok: true };
  }

  async function deleteItem(c, id) {
    const state = await loadState(c.id);
    const base = state.revs[id];
    if (base === undefined) return { ok: false };
    const { status } = await api(`/collections/${c.id}/items/${id}?base_revision=${base}`, { method: 'DELETE' });
    if (status === 409) { await pull(c); return { conflict: true }; }
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

  async function forget(cid) {
    const all = await local.get(null);
    await local.remove(Object.keys(all).filter(k => k.startsWith(RECORD(cid)) || k === STATE(cid)));
    const keys = await cachedKeys();
    if (keys[cid]) { delete keys[cid]; await session.set({ [KEYS]: keys }); }
  }

  async function forgetOthers(keep) {
    const all = await local.get(null);
    const stale = new Set();
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
