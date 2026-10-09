'use strict';

// 2.0 sharing (docs/sharing.md): an item stays in its owner's vault; a
// share is a copy of it — the whole item or chosen parts — encrypted under
// its own share key (SK), opened by grants to teammates (SK wrapped to their
// public key, keys.js) or to collections (SK encrypted under the collection
// key). Needs vault.js, vaultCrypto.js, vaultStore.js, vaultKeys.js,
// cloudSync.js; keys.js and vaultCollections.js for granting and opening.
//
// Owner side: each share's SK and chosen parts live in the shared item
// itself (`item.shares = [{ id, sk, whole, parts }]`), so they follow the
// item to the owner's other devices (E2E, like the rest of the item) and
// across vault key changes. Grants (who) live on the server. Whenever the
// item changes, publish() rewrites its copies; pullEdits() brings back what
// editors changed in a whole copy.
//
// Grantee side: refresh() lists the shares I can open, opens their keys
// (cached for the session in `shareKeys`, cleared on lock with the rest of
// chrome.storage.session) and stores each copy locally (`sr:<shareId>`,
// still encrypted) for the popup and the background's autofill.
const VaultShares = (() => {
  const local = chrome.storage.local;
  const session = chrome.storage.session;
  const COPY = id => `sr:${id}`;
  const KEYS = 'shareKeys';      // session: { [shareId]: SK } for shares I can open
  const MINE = 'sharesPublished'; // local: { [shareId]: { rev, fp } } what this device last published / saw
  const LIST = 'sharesWithMe';   // local: { userId, shares: [{ id, owner, role, whole, revision, via }] }

  async function api(path, opts) {
    const res = await CloudSync.api(path, opts);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function ok(path, opts) {
    const { status, body } = await api(path, opts);
    if (status !== 200) throw Object.assign(new Error(body?.error || `shares ${status}`), { status, body });
    return body;
  }

  // ── What a copy carries ────────────────────────────────────────────────
  // Parts: 'f:<fieldId>' for each field (the type's and custom ones),
  // 'totp', 'urls', 'notes'. The title always goes; tags, the password
  // history and the item's own shares never do.

  // The parts this item has, for the "what to share" checklist.
  function parts(item) {
    const out = [];
    for (const f of item.fields || []) {
      if (String(f.value ?? '') !== '') out.push({ key: `f:${f.id}`, label: f.label || f.id, secret: Vault.SECRET_KINDS.includes(f.kind) });
    }
    if (item.totp?.secret) out.push({ key: 'totp', label: '2FA code', secret: true });
    if ((item.urls || []).length) out.push({ key: 'urls', label: 'Websites' });
    if (String(item.notes ?? '').trim()) out.push({ key: 'notes', label: 'Notes' });
    return out;
  }

  // The copy of `item` that share `s` carries (its id is the share's).
  function project(item, s) {
    const has = key => s.whole || (s.parts || []).includes(key);
    return {
      id: s.id,
      type: item.type,
      title: item.title || '',
      tags: [],
      favorite: false,
      urls: has('urls') ? [...(item.urls || [])] : [],
      autofill: item.autofill !== false,
      fields: (item.fields || []).filter(f => has(`f:${f.id}`)).map(f => ({ ...f })),
      totp: has('totp') && item.totp ? { ...item.totp } : null,
      notes: has('notes') ? item.notes || '' : '',
      passwordHistory: [],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async function fingerprint(copy) {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...copy, updatedAt: null }));
    return VaultCrypto.b64e(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  }

  const samePartsAs = (s, whole, chosen) => s.whole === whole
    && (whole || JSON.stringify([...(s.parts || [])].sort()) === JSON.stringify([...chosen].sort()));

  async function readMine() {
    return (await local.get(MINE))[MINE] || {};
  }

  async function noteMine(id, rev, fp) {
    const all = await readMine();
    all[id] = { rev, fp };
    await local.set({ [MINE]: all });
  }

  async function forgetMine(ids) {
    const all = await readMine();
    for (const id of ids) delete all[id];
    await local.set({ [MINE]: all });
  }

  // ── Owner: sharing ─────────────────────────────────────────────────────

  // Key material for one grantee: a teammate { user: { user_id, public_key } }
  // or a collection { collection: { id, key } }.
  async function grantBody(s, g) {
    if (g.user) {
      if (!g.user.public_key) throw new Error('This teammate has to sign in to OTPilot once before you can share with them');
      return { user_id: g.user.user_id, role: g.role, wrapped_key: await TeamKeys.wrapUserShare(VaultCrypto.b64d(s.sk), g.user.public_key) };
    }
    return { collection_id: g.collection.id, role: g.role, wrapped_key: await VaultCrypto.encryptName(s.sk, g.collection.key, s.id) };
  }

  // Shares `item` (as saved — it has to be on the server already: the
  // owner's sync uploads it) with `grants` [{ user | collection, role }].
  // `chosen`: the parts to include, or null for the whole item. A share of
  // the same parts is reused (one more grant on it). Returns the item with
  // its `shares` updated; the caller stores it (attach()).
  async function share(item, chosen, grants) {
    if (!grants.length) throw new Error('Pick at least one teammate or collection');
    const whole = !chosen;
    const existing = (item.shares || []).find(s => samePartsAs(s, whole, chosen || []));
    if (existing) {
      for (const g of grants) await ok(`/shares/${existing.id}/grants`, { method: 'PUT', body: JSON.stringify(await grantBody(existing, g)) });
      return item;
    }
    const s = { id: crypto.randomUUID(), sk: VaultCrypto.b64e(VaultCrypto.generateKey()), whole, parts: whole ? null : [...chosen] };
    const copy = project(item, s);
    const body = await ok('/shares', {
      method: 'POST',
      body: JSON.stringify({
        id: s.id, item_id: item.id, whole, record: await VaultCrypto.encryptItem(copy, s.sk),
        grants: await Promise.all(grants.map(g => grantBody(s, g))),
      }),
    });
    await noteMine(s.id, body.revision, await fingerprint(copy));
    return { ...item, shares: [...(item.shares || []), s] };
  }

  // Stores `shares` on the saved item (under the vault lock, with the key
  // it's stored with): only that property changes.
  async function attach(itemId, shares, key) {
    return VaultStore.transaction(async tx => {
      const rec = (await tx.listRecords())[itemId];
      if (!rec) throw new Error('item not found');
      const item = await VaultCrypto.decryptItem(rec, key);
      const next = { ...item, shares, updatedAt: item.updatedAt };
      if (!next.shares?.length) delete next.shares;
      await tx.put(itemId, await VaultCrypto.encryptItem(next, key));
      return next;
    });
  }

  // Removes one grant; the share goes with its last grant (server side).
  async function unshare(item, shareId, target) {
    const q = target.user_id ? `user_id=${encodeURIComponent(target.user_id)}` : `collection_id=${encodeURIComponent(target.collection_id)}`;
    const body = await ok(`/shares/${shareId}/grants?${q}`, { method: 'DELETE' });
    if (!body.share_deleted) return item;
    await forgetMine([shareId]);
    return { ...item, shares: (item.shares || []).filter(s => s.id !== shareId) };
  }

  // My shares with their grants ({ id, item_id, whole, revision, record,
  // grants: [{ user_id | collection_id, role }] }).
  async function mine() {
    return (await ok('/shares/mine')).shares || [];
  }

  // ── Owner: keeping copies current ──────────────────────────────────────

  // Brings back what editors changed in whole copies, and forgets shares
  // the server no longer has (their last grant went). Returns the items to
  // store ({ id → item }); nothing is written here.
  async function pullEdits(items, server) {
    const byShare = new Map();
    for (const item of items) for (const s of item.shares || []) byShare.set(s.id, { item, s });
    const onServer = new Map(server.map(x => [x.id, x]));
    const published = await readMine();
    const changed = new Map();
    for (const [id, { item, s }] of byShare) {
      const cur = changed.get(item.id) || item;
      const there = onServer.get(id);
      if (!there) {
        changed.set(item.id, { ...cur, shares: (cur.shares || []).filter(x => x.id !== id) });
        continue;
      }
      if (published[id]?.rev === there.revision || !s.whole || !there.record) continue;
      let copy;
      try { copy = await VaultCrypto.decryptItem(there.record, s.sk); } catch { continue; }
      if ((copy.updatedAt || '') <= (cur.updatedAt || '')) continue;
      // An editor's newer version: their fields, keeping what copies never
      // carry (tags, history, shares).
      changed.set(item.id, {
        ...cur, title: copy.title, fields: copy.fields, totp: copy.totp, urls: copy.urls,
        notes: copy.notes, autofill: copy.autofill, updatedAt: copy.updatedAt,
      });
      await noteMine(id, there.revision, await fingerprint(copy));
    }
    return changed;
  }

  // Rewrites the copies whose content changed since this device last
  // published them. A copy that moved on meanwhile (409) is left for the
  // next pullEdits + publish.
  async function publish(items, server) {
    const revs = new Map(server.map(x => [x.id, x.revision]));
    const published = await readMine();
    let written = 0;
    for (const item of items) {
      for (const s of item.shares || []) {
        if (!revs.has(s.id)) continue;
        const copy = project(item, s);
        const fp = await fingerprint(copy);
        if (published[s.id]?.fp === fp && published[s.id]?.rev === revs.get(s.id)) continue;
        const { status, body } = await api(`/shares/${s.id}`, {
          method: 'PUT',
          body: JSON.stringify({ record: await VaultCrypto.encryptItem(copy, s.sk), base_revision: revs.get(s.id) }),
        });
        if (status === 200) { await noteMine(s.id, body.revision, fp); written++; }
        else if (status !== 409) throw new Error(`share publish ${status}`);
      }
    }
    return written;
  }

  // The owner's whole pass: editors' changes in, then fresh copies out.
  // Writes changed items under the vault lock (only when the key is still
  // the vault key). Returns how many items changed locally.
  async function syncOwner(key) {
    const { items } = await VaultStore.readAll(key);
    const shared = items.filter(i => (i.shares || []).length);
    if (!shared.length) return 0;
    const server = await mine();
    const changed = await pullEdits(shared, server);
    if (changed.size) {
      await VaultStore.transaction(async tx => {
        if ((await VaultKeys.getKey()) !== key) throw new Error('the vault key changed');
        for (const item of changed.values()) {
          const next = { ...item };
          if (!next.shares?.length) delete next.shares;
          await tx.put(next.id, await VaultCrypto.encryptItem(next, key));
        }
      });
    }
    const current = shared.map(i => changed.get(i.id) || i);
    await publish(current, server);
    return changed.size;
  }

  // ── Grantee ────────────────────────────────────────────────────────────

  async function cachedKeys() {
    return (await session.get(KEYS))[KEYS] || {};
  }

  // Caches SKs for the session — only while the vault is unlocked (a lock
  // clears chrome.storage.session; it mustn't be undone).
  function cacheKeys(add) {
    return navigator.locks.request('otpilot-vault', async () => {
      if (!(await VaultKeys.getKey())) throw new Error('vault is locked');
      await session.set({ [KEYS]: { ...(await cachedKeys()), ...add } });
    });
  }

  // SK for a with-me row: cached, or opened from one of its grants (my
  // private key, or a collection's key I hold).
  async function openKey(row, cached, collectionKeys) {
    if (cached[row.id]) return cached[row.id];
    for (const via of row.via || []) {
      try {
        if (via.user_id) return VaultCrypto.b64e(await TeamKeys.unwrapUserShare(via.wrapped_key));
        const ck = collectionKeys[via.collection_id];
        if (ck) return await VaultCrypto.decryptName(via.wrapped_key, ck, row.id);
      } catch { /* try the next grant */ }
    }
    return null;
  }

  async function currentUserId() {
    try { return (await SupabaseAuth.getSession())?.user?.id ?? null; } catch { return null; }
  }

  // Refreshes the shares I can open: stores each copy whose revision moved,
  // drops the ones no longer listed. Returns the list with each copy
  // decrypted ({ id, owner, role, whole, revision, via, item | null }).
  // Offline: the last list, for the same user.
  async function refresh() {
    const userId = await currentUserId();
    let rows;
    try {
      rows = (await ok('/shares/with-me')).shares || [];
    } catch (e) {
      if (e.status) throw e;
      const cachedList = (await local.get(LIST))[LIST];
      if (!userId || cachedList?.userId !== userId) throw e;
      return readable(cachedList.shares);
    }
    const collectionKeys = (await session.get('collectionKeys')).collectionKeys || {};
    const keys = await cachedKeys();
    const opened = {};
    const sets = {};
    for (const row of rows) {
      const sk = await openKey(row, keys, collectionKeys);
      if (!sk) continue;
      if (!keys[row.id]) opened[row.id] = sk;
      if (row.record) sets[COPY(row.id)] = row.record;
    }
    if (Object.keys(opened).length) await cacheKeys(opened).catch(() => {});
    const keep = new Set(rows.map(r => r.id));
    const stale = Object.keys(await local.get(null)).filter(k => k.startsWith('sr:') && !keep.has(k.slice(3)));
    if (stale.length) await local.remove(stale);
    const list = rows.map(({ record, ...meta }) => meta);
    await local.set({ ...sets, [LIST]: { userId, shares: list } });
    return readable(list);
  }

  // The stored copies of `list`, decrypted with this session's keys.
  async function readable(list) {
    const keys = await cachedKeys();
    const recs = await local.get(list.map(r => COPY(r.id)));
    const out = [];
    for (const row of list) {
      let item = null;
      const rec = recs[COPY(row.id)];
      if (rec && keys[row.id]) {
        try { item = await VaultCrypto.decryptItem(rec, keys[row.id]); } catch { item = null; }
      }
      out.push({ ...row, item });
    }
    return out;
  }

  // An editor saves a whole copy (from the revision it was read at).
  // { ok } or { conflict } (the owner's or another editor's newer copy).
  async function saveCopy(row, item) {
    const keys = await cachedKeys();
    const sk = keys[row.id];
    if (!sk) throw new Error('This share is not open on this device');
    const record = await VaultCrypto.encryptItem({ ...item, id: row.id, updatedAt: new Date().toISOString() }, sk);
    const { status, body } = await api(`/shares/${row.id}`, { method: 'PUT', body: JSON.stringify({ record, base_revision: row.revision }) });
    if (status === 409) return { conflict: true };
    if (status !== 200) throw Object.assign(new Error(body?.error || `share save ${status}`), { status });
    await local.set({ [COPY(row.id)]: record });
    const cachedList = (await local.get(LIST))[LIST];
    if (cachedList) {
      cachedList.shares = cachedList.shares.map(r => (r.id === row.id ? { ...r, revision: body.revision } : r));
      await local.set({ [LIST]: cachedList });
    }
    return { ok: true, revision: body.revision };
  }

  // Leaves a share given to me directly.
  async function leave(row) {
    const me = await currentUserId();
    await ok(`/shares/${row.id}/grants?user_id=${encodeURIComponent(me)}`, { method: 'DELETE' });
    await local.remove(COPY(row.id));
  }

  return {
    parts, project, share, attach, unshare, mine, pullEdits, publish, syncOwner,
    refresh, readable, saveCopy, leave,
  };
})();
