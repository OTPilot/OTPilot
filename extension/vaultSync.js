'use strict';

// 2.0 per-item sync with the API's /vault/items (needs vault.js, vaultCrypto.js,
// vaultStore.js, cloudSync.js).
//
// The server stores each item's encrypted record as-is. Since every device of
// the user shares the vault key, a pulled record is written locally unchanged,
// and a local record is uploaded unchanged — nothing is decrypted except to
// settle a conflict or compute counts_for_limit.
//
// State (chrome.storage.local `vaultSyncState`):
//   cursor  — highest server revision pulled
//   synced  — { [id]: { rev, fp } }: the server revision each item was last
//             synced at, and the fingerprint of the local record at that time.
// A record whose fingerprint differs from `synced[id].fp` changed locally. The
// fingerprint is the pair of IVs, which are fresh on every encryption, so any
// local save changes it.
const VaultSync = (() => {
  const STATE = 'vaultSyncState';
  const BATCH_MAX = 500;
  const BATCH_BYTES = 6 * 1024 * 1024; // under the API's 8 MiB body cap

  const fp = rec => (rec ? `${rec.data?.iv}.${rec.key?.iv}` : null);

  async function loadState() {
    const s = (await chrome.storage.local.get(STATE))[STATE];
    return { cursor: s?.cursor ?? 0, synced: s?.synced ?? {} };
  }

  function saveState(state) {
    return chrome.storage.local.set({ [STATE]: state });
  }

  async function api(path, opts) {
    const res = await CloudSync.api(path, opts);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function decryptOrNull(rec, key) {
    try { return await VaultCrypto.decryptItem(rec, key); } catch { return null; }
  }

  // ── Pull ────────────────────────────────────────────────────────────────

  async function pull(state, key, stats) {
    for (let more = true; more;) {
      const { status, body } = await api(`/vault/items?since=${state.cursor}`);
      if (status !== 200) throw new Error(`vault pull ${status}`);
      await applyPulled(body.items || [], state, key, stats);
      state.cursor = body.revision ?? state.cursor;
      more = !!body.more;
      await saveState(state); // a later failure doesn't re-pull this page
    }
  }

  async function applyPulled(remote, state, key, stats) {
    const local = await VaultStore.listRecords();
    const tombs = await VaultStore.listTombstones();
    const upserts = {};
    const deletes = [];

    for (const r of remote) {
      const known = state.synced[r.id];
      const mine = local[r.id];
      const changedHere = !!mine && (!known || fp(mine) !== known.fp);

      if (r.deleted) {
        if (changedHere) {
          // Edited here, deleted there: keep the edit and upload it again.
          state.synced[r.id] = { rev: r.revision, fp: null };
        } else {
          if (mine) deletes.push(r.id);
          delete state.synced[r.id];
          stats.deleted++;
        }
        continue;
      }

      if (mine && fp(mine) === fp(r.record)) {
        // Our own upload coming back: same record, just note its revision.
        state.synced[r.id] = { rev: r.revision, fp: fp(mine) };
        continue;
      }

      if (changedHere) {
        // Both sides changed: the newer edit wins.
        const [theirs, ours] = await Promise.all([decryptOrNull(r.record, key), decryptOrNull(mine, key)]);
        if (!ours || (theirs && (theirs.updatedAt || '') > (ours.updatedAt || ''))) {
          upserts[r.id] = r.record;
          state.synced[r.id] = { rev: r.revision, fp: fp(r.record) };
          stats.pulled++;
        } else {
          state.synced[r.id] = { rev: r.revision, fp: known?.fp ?? null }; // still pushes
        }
        continue;
      }

      // Unchanged here (or deleted here after the server changed it: the
      // server's newer content wins over a stale local deletion).
      if (!mine && tombs[r.id] && known && known.rev === r.revision) continue;
      upserts[r.id] = r.record;
      state.synced[r.id] = { rev: r.revision, fp: fp(r.record) };
      stats.pulled++;
    }

    await VaultStore.applyRemote({ upserts, deletes });
  }

  // ── Push ────────────────────────────────────────────────────────────────

  async function countsForLimit(rec, key) {
    const item = await decryptOrNull(rec, key);
    return item ? Vault.countsForLimit(item) : true;
  }

  async function push(state, key, stats) {
    const local = await VaultStore.listRecords();
    const creates = [];
    for (const [id, rec] of Object.entries(local)) {
      const known = state.synced[id];
      if (!known) { creates.push([id, rec]); continue; }
      if (known.fp === fp(rec)) continue;
      const { status, body } = await api(`/vault/items/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ record: rec, base_revision: known.rev, counts_for_limit: await countsForLimit(rec, key) }),
      });
      if (status === 200) {
        state.synced[id] = { rev: body.revision, fp: fp(rec) };
        stats.pushed++;
      } else if (status !== 409) {
        throw new Error(`vault push ${status}`);
      } // 409: the server moved on; the next pull brings it in and settles it
    }

    // New items in batches, bounded by count and size.
    let batch = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const items = [];
      for (const [id, rec] of batch) items.push({ id, record: rec, counts_for_limit: await countsForLimit(rec, key) });
      const { status, body } = await api('/vault/items/batch', { method: 'POST', body: JSON.stringify({ items }) });
      if (status !== 200) throw new Error(`vault batch ${status}`);
      const byId = Object.fromEntries(batch);
      for (const c of body.created || []) {
        state.synced[c.id] = { rev: c.revision, fp: fp(byId[c.id]) };
        stats.pushed++;
      }
      // `conflicts`: the id already exists on the server; the next pull brings
      // that version and the newer edit wins.
      batch = [];
      bytes = 0;
    };
    for (const entry of creates) {
      const size = JSON.stringify(entry[1]).length;
      if (batch.length >= BATCH_MAX || (batch.length && bytes + size > BATCH_BYTES)) await flush();
      batch.push(entry);
      bytes += size;
    }
    await flush();

    // Local deletions.
    const tombs = await VaultStore.listTombstones();
    const done = [];
    for (const id of Object.keys(tombs)) {
      const known = state.synced[id];
      if (!known) { done.push(id); continue; } // never reached the server
      const { status } = await api(`/vault/items/${id}?base_revision=${known.rev}`, { method: 'DELETE' });
      if (status === 200 || status === 404) {
        delete state.synced[id];
        done.push(id);
        stats.deleted++;
      } else if (status !== 409) {
        throw new Error(`vault delete ${status}`);
      }
    }
    if (done.length) await VaultStore.dropTombstones(done);
  }

  // Pull, then push. One sync at a time per browser (Web Lock).
  function sync(key) {
    return navigator.locks.request('otpilot-vault-sync', async () => {
      const stats = { pulled: 0, pushed: 0, deleted: 0 };
      const state = await loadState();
      await pull(state, key, stats);
      await push(state, key, stats);
      await saveState(state);
      return stats;
    });
  }

  // Forget sync progress (sync turned off, or a different key adopted): the
  // next sync starts from scratch and re-pairs items by id.
  function reset() {
    return chrome.storage.local.remove(STATE);
  }

  return { sync, reset };
})();
