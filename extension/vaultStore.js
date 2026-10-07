'use strict';

// Local encrypted storage for 2.0 vault items (needs vaultCrypto.js).
//
// Each encrypted record lives under its own chrome.storage.local key
// (`vi:<id>`), and each deletion leaves a tombstone under `vt:<id>` holding the
// ISO time it was deleted, so sync can tell other devices. One key per item
// (instead of one shared object) means the popup and the background worker
// can write different items at the same time without a read-modify-write on a
// shared map silently dropping one of the writes.
//
// This module never sees the vault key on its own: callers pass the key that
// wraps the item (the vault key for personal items).
const VaultStore = (() => {
  const RECORD = 'vi:';
  const TOMB = 'vt:';

  // Promise form of the API: it rejects when Chrome refuses a write (e.g. the
  // storage quota on a large import), so a failed save never looks successful.
  const get = keys => chrome.storage.local.get(keys);
  // Shared with VaultKeys: record writes and vault key changes never interleave,
  // so a re-key can't overwrite a save or undo a removal made while it ran.
  const exclusive = fn => navigator.locks.request('otpilot-vault', fn);
  const set = obj => chrome.storage.local.set(obj);
  const del = keys => chrome.storage.local.remove(keys);

  async function byPrefix(prefix) {
    const all = await get(null);
    const out = Object.create(null); // ids are data: '__proto__' must stay a key
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    }
    return out;
  }

  // { [id]: encrypted record }
  function listRecords() {
    return byPrefix(RECORD);
  }

  // { [id]: ISO deletion time }
  function listTombstones() {
    return byPrefix(TOMB);
  }

  async function get1(id, wrappingKey) {
    const rec = (await get(RECORD + id))[RECORD + id];
    return rec ? VaultCrypto.decryptItem(rec, wrappingKey) : null;
  }

  // Decrypts every record. A record that fails to decrypt (corrupted, or
  // wrapped by a key this caller doesn't hold) is reported in `failed` rather
  // than failing the whole read, so one bad record can't hide the vault.
  async function readAll(wrappingKey) {
    const records = await listRecords();
    const items = [];
    const failed = [];
    for (const [id, rec] of Object.entries(records)) {
      try { items.push(await VaultCrypto.decryptItem(rec, wrappingKey)); }
      catch { failed.push(id); }
    }
    return { items, failed };
  }

  // Encrypts and stores items in a single storage write (one item, an import,
  // or the v1 migration). Saving an id clears its tombstone — only after the
  // write succeeded; a rejected write throws and leaves tombstones in place.
  function save(items, wrappingKey) {
    return exclusive(async () => {
      const list = Array.isArray(items) ? items : [items];
      const writes = {};
      for (const item of list) {
        writes[RECORD + item.id] = await VaultCrypto.encryptItem(item, wrappingKey);
      }
      await set(writes);
      await del(list.map(i => TOMB + i.id));
      return list.length;
    });
  }

  function remove(ids, deletedAt = new Date().toISOString()) {
    return exclusive(async () => {
      const list = Array.isArray(ids) ? ids : [ids];
      await del(list.map(id => RECORD + id));
      await set(Object.fromEntries(list.map(id => [TOMB + id, deletedAt])));
    });
  }

  // Remote wipe / sign-out erase: drops every record and tombstone.
  function clear() {
    return exclusive(async () => {
      const all = await get(null);
      await del(Object.keys(all).filter(k => k.startsWith(RECORD) || k.startsWith(TOMB)));
    });
  }

  // For a vault key change: every record re-wrapped from oldKey to newKey,
  // returned as storage writes for the caller to commit together with the new
  // key in ONE chrome.storage write — otherwise a crash in between would leave
  // records and key out of step and the vault unreadable. Content is untouched
  // (only each item key is re-wrapped). A record that can't be unwrapped with
  // oldKey is already unreadable and is left as it is; any other failure
  // throws, so the key change is abandoned rather than stranding records.
  // Callers must hold the 'otpilot-vault' lock (VaultKeys.adoptKey does).
  // Other records encrypted the same way that also follow the key.
  const EXTRA_RECORDS = ['accountsV1Backup'];

  async function prepareRekey(oldKey, newKey) {
    const writes = {};
    const extras = await get(EXTRA_RECORDS);
    for (const k of EXTRA_RECORDS) {
      if (!extras[k]) continue;
      try { writes[k] = await VaultCrypto.rewrapItemKey(extras[k], oldKey, newKey); }
      catch (e) { if (e.message !== 'item key unreadable') throw e; }
    }
    for (const [id, rec] of Object.entries(await listRecords())) {
      try { writes[RECORD + id] = await VaultCrypto.rewrapItemKey(rec, oldKey, newKey); }
      catch (e) {
        if (e.message !== 'item key unreadable') throw e; // unreadable before, unreadable after
      }
    }
    return writes;
  }

  // Runs `fn(tx)` under the vault lock, so nothing else saves or removes
  // records between what `fn` reads and what it writes (sync uses this to
  // read, decide and apply remote changes as one step). `tx` writes raw
  // records (already encrypted) and removes without leaving a tombstone.
  function transaction(fn) {
    return exclusive(() => fn({
      listRecords,
      listTombstones,
      put: (id, rec) => set({ [RECORD + id]: rec }).then(() => del(TOMB + id)),
      // Several records in one storage write: all are stored, or none.
      putMany: entries => set(Object.fromEntries(entries.map(([id, rec]) => [RECORD + id, rec])))
        .then(() => del(entries.map(([id]) => TOMB + id))),
      drop: id => del([RECORD + id, TOMB + id]),
      dropTombstone: id => del(TOMB + id),
    }));
  }

  function dropTombstones(ids) {
    return exclusive(() => del(ids.map(id => TOMB + id)));
  }

  return { listRecords, listTombstones, get: get1, readAll, save, remove, clear, prepareRekey, transaction, dropTombstones };
})();
