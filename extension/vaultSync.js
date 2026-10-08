'use strict';

// 2.0 per-item sync with the API's /vault/items (needs vault.js, vaultCrypto.js,
// vaultKeys.js, vaultStore.js, cloudSync.js).
//
// The server stores each item's encrypted record as-is. Every device of the
// user shares the vault key, so a pulled record is written locally unchanged
// and a local record is uploaded unchanged; records are only decrypted to
// check they're readable, settle a conflict, pair twins, or compute
// counts_for_limit.
//
// State (chrome.storage.local `vaultSyncState`, saved after every successful
// server write so an interrupted sync never forgets what reached the server):
//   cursor  — highest server revision pulled
//   synced  — { [id]: { rev, fp } }: the server revision each item was last
//             synced at, and the fingerprint of the local record then.
// A record whose fingerprint differs from `synced[id].fp` changed locally.
// The fingerprint is the pair of IVs, fresh on every encryption.
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

  // A sync runs with the key it started with. Every write it makes checks,
  // under the vault lock (which a device reset, a lock and a key change also
  // take), that this is still the vault key: a reply arriving after the
  // device was wiped or re-keyed must not write records or progress back.
  async function checkKey(key) {
    if ((await VaultKeys.getKey()) !== key) throw new Error('the vault was locked, reset or re-keyed during sync');
  }

  function saveStateFor(state, key) {
    return navigator.locks.request('otpilot-vault', async () => {
      await checkKey(key);
      await saveState(state);
    });
  }

  async function api(path, opts) {
    const res = await CloudSync.api(path, opts);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function decryptOrNull(rec, key) {
    try { return await VaultCrypto.decryptItem(rec, key); } catch { return null; }
  }

  // Logins migrated independently on two devices get different ids: pair
  // them by what the user sees as "the same account".
  const twinKey = item => (item?.type === 'login'
    ? `${item.totp?.secret || ''}\u0000${item.title || ''}\u0000${Vault.getValue(item, 'username')}`
    : null);

  // ── Pull ────────────────────────────────────────────────────────────────

  async function pull(state, key, stats) {
    for (let more = true; more;) {
      const { status, body } = await api(`/vault/items?since=${state.cursor}`);
      if (status !== 200) throw new Error(`vault pull ${status}`);
      await VaultStore.transaction(async tx => {
        await checkKey(key);
        await applyPulled(tx, body.items || [], state, key, stats);
        state.cursor = body.revision ?? state.cursor;
        await saveState(state); // a later failure doesn't re-pull this page
      });
      more = !!body.more;
    }
  }

  // Runs under the vault lock: nothing else writes records between the reads
  // and the writes below.
  async function applyPulled(tx, remote, state, key, stats) {
    const local = await tx.listRecords();
    const tombs = await tx.listTombstones();

    // Local items that never reached the server, indexed by twin key (lazily).
    let twins = null;
    const localTwins = async () => {
      if (twins) return twins;
      twins = new Map();
      for (const [id, rec] of Object.entries(local)) {
        if (state.synced[id]) continue;
        const k = twinKey(await decryptOrNull(rec, key));
        if (k && !twins.has(k)) twins.set(k, id);
      }
      return twins;
    };

    for (const r of remote) {
      const known = state.synced[r.id];
      const mine = local[r.id];

      if (r.deleted) {
        const changedHere = !!mine && (!known || fp(mine) !== known.fp);
        if (changedHere) {
          // Edited here, deleted there: keep the edit and upload it again.
          state.synced[r.id] = { rev: r.revision, fp: null };
        } else {
          if (mine) await tx.drop(r.id);
          else if (tombs[r.id]) await tx.dropTombstone(r.id);
          delete state.synced[r.id];
          stats.deleted++;
        }
        continue;
      }

      // Never store what this device can't read (e.g. left over from a
      // previous key): it would only show up as a failed record.
      const theirs = await decryptOrNull(r.record, key);
      if (!theirs) { stats.unreadable++; continue; }

      if (mine && fp(mine) === fp(r.record)) {
        // Our own upload coming back: just note its revision.
        state.synced[r.id] = { rev: r.revision, fp: fp(mine) };
        continue;
      }

      if (!mine && tombs[r.id]) {
        // Deleted here. Keep the deletion unless the server's copy changed
        // after the version we deleted (then the newer data wins).
        if (!known || r.revision <= known.rev) {
          state.synced[r.id] = { rev: r.revision, fp: null };
          continue;
        }
      }

      const changedHere = !!mine && (!known || fp(mine) !== known.fp);
      if (changedHere) {
        // Both sides changed: the newer edit wins.
        const ours = await decryptOrNull(mine, key);
        if (!ours || (theirs.updatedAt || '') > (ours.updatedAt || '')) {
          await tx.put(r.id, r.record);
          state.synced[r.id] = { rev: r.revision, fp: fp(r.record) };
          stats.pulled++;
        } else {
          state.synced[r.id] = { rev: r.revision, fp: known?.fp ?? null }; // still pushes
        }
        continue;
      }

      if (!mine) {
        // A twin migrated here under another id: keep one item, under the
        // server's id, with the newer content.
        const k = twinKey(theirs);
        const twinId = k && (await localTwins()).get(k);
        if (twinId) {
          twins.delete(k);
          stats.remapped[twinId] = r.id; // so open editors can follow the item
          const ours = await decryptOrNull(local[twinId], key);
          await tx.drop(twinId);
          if (ours && (ours.updatedAt || '') > (theirs.updatedAt || '')) {
            const rec = await VaultCrypto.encryptItem({ ...ours, id: r.id }, key);
            await tx.put(r.id, rec);
            state.synced[r.id] = { rev: r.revision, fp: null }; // pushes ours
          } else {
            await tx.put(r.id, r.record);
            state.synced[r.id] = { rev: r.revision, fp: fp(r.record) };
          }
          stats.pulled++;
          continue;
        }
      }

      await tx.put(r.id, r.record);
      state.synced[r.id] = { rev: r.revision, fp: fp(r.record) };
      stats.pulled++;
    }
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
        await saveStateFor(state, key);
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
      await saveStateFor(state, key);
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
        await saveStateFor(state, key);
      } else if (status !== 409) {
        throw new Error(`vault delete ${status}`);
      }
    }
    if (done.length) await VaultStore.dropTombstones(done);
  }

  // Pull, then push. One sync at a time per browser (Web Lock).
  function sync(key) {
    return navigator.locks.request('otpilot-vault-sync', async () => {
      const stats = { pulled: 0, pushed: 0, deleted: 0, unreadable: 0, remapped: {} };
      const state = await loadState();
      await pull(state, key, stats);
      await push(state, key, stats);
      await saveStateFor(state, key);
      return stats;
    });
  }

  // "Start fresh": delete every item on the server (they may be encrypted with
  // a lost key) and forget sync progress, so this device's vault is uploaded
  // as the new truth.
  function wipeServer() {
    return navigator.locks.request('otpilot-vault-sync', async () => {
      for (let since = 0, more = true; more;) {
        const { status, body } = await api(`/vault/items?since=${since}`);
        if (status !== 200) throw new Error(`vault list ${status}`);
        for (const r of body.items || []) {
          if (r.deleted) continue;
          const del = await api(`/vault/items/${r.id}?base_revision=${r.revision}`, { method: 'DELETE' });
          if (del.status !== 200 && del.status !== 404 && del.status !== 409) throw new Error(`vault delete ${del.status}`);
        }
        since = body.revision ?? since;
        more = !!body.more;
      }
      await reset();
    });
  }

  // Forget sync progress (sync turned off, a different key adopted): the next
  // sync starts over and re-pairs items by id. CloudSync clears the same key
  // directly in contexts that don't load this file (the background worker).
  function reset() {
    return chrome.storage.local.remove(STATE);
  }

  return { STATE, sync, wipeServer, reset };
})();
