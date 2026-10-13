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
  const REHOME = 'vaultRehome'; // old id → new id of a move to a new id under way
  const REMAPPED = 'vaultRemapped'; // every finished move, old id → new id: links coming from elsewhere follow
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

    const touched = new Set(); // ids this pull wrote
    for (const r of remote) {
      touched.add(r.id);
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
        // Both sides changed: the newer edit wins — but shares made here
        // (their keys live only in the item, docs/sharing.md) are kept even
        // when the other side's version wins, or this device's copies of
        // the item could no longer be updated.
        const ours = await decryptOrNull(mine, key);
        if (!ours || (theirs.updatedAt || '') > (ours.updatedAt || '')) {
          const extra = (ours?.shares || []).filter(s => !(theirs.shares || []).some(t => t.id === s.id));
          if (extra.length) {
            await tx.put(r.id, await VaultCrypto.encryptItem({ ...theirs, shares: [...(theirs.shares || []), ...extra] }, key));
            state.synced[r.id] = { rev: r.revision, fp: null }; // pushes the merged item
          } else {
            await tx.put(r.id, r.record);
            state.synced[r.id] = { rev: r.revision, fp: fp(r.record) };
          }
          stats.pulled++;
        } else {
          // Ours wins — and keeps the shares the other side has that ours
          // doesn't (e.g. one the web dashboard stored while this device
          // pruned it as not created yet). One the server really dropped is
          // pruned again by VaultShares.syncOwner.
          const extra = (theirs.shares || []).filter(t => !(ours.shares || []).some(s => s.id === t.id));
          if (extra.length) await tx.put(r.id, await VaultCrypto.encryptItem({ ...ours, shares: [...(ours.shares || []), ...extra] }, key));
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
          // Both sides' shares stay (their keys live only in the item —
          // docs/sharing.md), whichever version's content wins.
          const shares = [...(theirs.shares || []), ...(ours?.shares || []).filter(s => !(theirs.shares || []).some(t => t.id === s.id))];
          // Related items linked on either side stay linked too.
          const links = [...new Set([...(theirs.links || []), ...(ours?.links || [])])].filter(id => id !== r.id && id !== twinId);
          const extra = { ...(shares.length ? { shares } : {}), ...(links.length ? { links } : {}) };
          touched.add(r.id);
          if (ours && (ours.updatedAt || '') > (theirs.updatedAt || '')) {
            const rec = await VaultCrypto.encryptItem({ ...ours, id: r.id, ...extra }, key);
            await tx.put(r.id, rec);
            state.synced[r.id] = { rev: r.revision, fp: null }; // pushes ours
          } else if (shares.length > (theirs.shares || []).length || links.length > (theirs.links || []).length) {
            await tx.put(r.id, await VaultCrypto.encryptItem({ ...theirs, ...extra }, key));
            state.synced[r.id] = { rev: r.revision, fp: null }; // pushes the merged shares / links
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

    // What came in linking an id this device moved to a new one (another
    // device's older version) links the new id — pushed like any edit.
    const remapped = (await chrome.storage.local.get(REMAPPED))[REMAPPED] || {};
    if (Object.keys(remapped).length) {
      const now = await tx.listRecords();
      for (const id of touched) {
        const item = now[id] && await decryptOrNull(now[id], key);
        if (!item?.links?.some(l => remapped[l])) continue;
        const last = l => { const seen = new Set(); while (remapped[l] && !seen.has(l)) { seen.add(l); l = remapped[l]; } return l; };
        const links = [...new Set(item.links.map(last))].filter(l => l !== id);
        await tx.put(id, await VaultCrypto.encryptItem({ ...item, links }, key));
        if (state.synced[id]) state.synced[id] = { ...state.synced[id], fp: null };
      }
    }

    // Items here that link a login this pull moved to the server's id link
    // the new id (re-encrypted: the change is pushed like any edit).
    const moved = stats.remapped;
    if (Object.keys(moved).length) {
      for (const [id, rec] of Object.entries(local)) {
        if (touched.has(id) || moved[id]) continue;
        const item = await decryptOrNull(rec, key);
        if (!item?.links?.some(l => moved[l])) continue;
        const links = [...new Set(item.links.map(l => moved[l] || l))].filter(l => l !== id);
        await tx.put(id, await VaultCrypto.encryptItem({ ...item, links }, key));
      }
    }
  }

  // ── Push ────────────────────────────────────────────────────────────────

  async function countsForLimit(rec, key) {
    const item = await decryptOrNull(rec, key);
    return item ? Vault.countsForLimit(item) : true;
  }

  async function push(state, key, stats) {
    const taken = [];
    const conflicted = [];
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
      taken.push(...(body.taken || []));
      conflicted.push(...(body.conflicts || []));
      await saveStateFor(state, key);
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
    // `conflicts`: ids of mine already on the server that this device never
    // pulled (its cursor moved past them): pull everything again next time,
    // where the newer edit wins. Left alone they'd retry here forever.
    if (conflicted.length) { state.cursor = 0; await saveStateFor(state, key); }
    // `taken`: ids another account (or a collection) holds — e.g. this
    // browser was signed in to another OTPilot account with the same vault.
    // They can never go up under those ids.
    if (taken.length) stats.rehomed = await rehome(taken, conflicted, key, stats);

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

  // What an item holds, to tell an exact copy: everything but its id and
  // dates — password history, links and shares included, so dropping a copy
  // never loses anything only it had.
  const content = item => {
    const { id, createdAt, updatedAt, ...rest } = item;
    return JSON.stringify(rest);
  };

  // Items whose id is taken on the server: one that's exactly an item already
  // synced here (the same account, migrated twice) is dropped — that one
  // stays; any other gets a new id (re-encrypted: the id is bound into the
  // record) and goes up on the next push. Items linking a moved one follow.
  async function rehome(ids, unsettled, key, stats) {
    let moved = 0;
    await VaultStore.transaction(async tx => {
      await checkKey(key);
      const recs = await tx.listRecords();
      const taken = new Set(ids);
      const items = {};
      for (const [id, rec] of Object.entries(recs)) items[id] = await decryptOrNull(rec, key);
      // Exact copies are looked for among every other item here (synced or
      // not): a move cut short last time left the old record beside its new
      // one, and that old record is dropped now instead of moved twice. Not
      // among items still in conflict with the server: the pull may yet
      // replace them.
      const skip = new Set(unsettled);
      const others = new Map();
      for (const [id, item] of Object.entries(items)) if (item && !taken.has(id) && !skip.has(id)) others.set(content(item), id);
      // Where each one goes first, so moved items linking each other follow
      // too. A move cut short last time already wrote its replacement (with
      // its links rewritten, so it no longer matches as a copy): the saved
      // mapping sends the old record there.
      const pending = (await chrome.storage.local.get(REHOME))[REHOME] || {};
      const to = {};
      const fresh = [];
      const late = [];
      for (const id of ids) {
        const item = items[id];
        if (!item) continue;
        if (pending[id] && items[pending[id]]) {
          to[id] = pending[id];
          // Edited here since its replacement was written: the edit goes on
          // in the replacement (links through the mapping) before it's dropped.
          if ((item.updatedAt || '') > (items[pending[id]].updatedAt || '')) late.push(id);
          continue;
        }
        const twin = others.get(content(item));
        if (twin) { to[id] = twin; continue; }
        to[id] = crypto.randomUUID();
        fresh.push(id);
      }
      moved = Object.keys(to).length;
      if (!moved) return;
      const relink = item => [...new Set((item.links || []).map(l => to[l] || l))];
      const puts = [];
      for (const id of [...fresh, ...late]) {
        const item = items[id];
        const links = relink(item).filter(l => l !== to[id]);
        // Shares the replacement got meanwhile (another device) stay: their keys live only in the item.
        const theirs = items[to[id]]?.shares || [];
        const shares = [...(item.shares || []), ...theirs.filter(t => !(item.shares || []).some(x => x.id === t.id))];
        puts.push([to[id], await VaultCrypto.encryptItem({ ...item, id: to[id], ...(item.links ? { links } : {}), ...(shares.length ? { shares } : {}) }, key)]);
      }
      const written = new Set(puts.map(([id]) => id));
      for (const [id, item] of Object.entries(items)) {
        if (taken.has(id) || written.has(id) || !item?.links?.some(l => to[l])) continue;
        const links = relink(item).filter(l => l !== id);
        // Not dated as an edit (a newer edit elsewhere must still win): a pulled
        // version linking the old id is translated on the way in instead.
        puts.push([id, await VaultCrypto.encryptItem({ ...item, links }, key)]);
      }
      // The mapping first (a retry finds the replacements by it), then the new
      // records and every link to them in one write, then the old records:
      // nothing ever links an id that's gone, and nothing is moved twice.
      await chrome.storage.local.set({ [REHOME]: { ...pending, ...to } });
      if (puts.length) await tx.putMany(puts);
      // Kept flat: an earlier move to an id moved now points at the newest.
      const done = (await chrome.storage.local.get(REMAPPED))[REMAPPED] || {};
      for (const [from, dest] of Object.entries(done)) if (to[dest]) done[from] = to[dest];
      await chrome.storage.local.set({ [REMAPPED]: { ...done, ...to } });
      await tx.dropMany(Object.keys(to));
      const left = { ...pending, ...to };
      for (const id of Object.keys(to)) delete left[id];
      await chrome.storage.local.set({ [REHOME]: left });
      Object.assign(stats.remapped, to);
    });
    return moved;
  }

  // Pull, then push. One sync at a time per browser (Web Lock).
  function sync(key) {
    return navigator.locks.request('otpilot-vault-sync', async () => {
      const stats = { pulled: 0, pushed: 0, deleted: 0, unreadable: 0, remapped: {} };
      const state = await loadState();
      await pull(state, key, stats);
      await push(state, key, stats);
      // Items that got a new id go up now, not on the next sync.
      if (stats.rehomed) await push(state, key, stats);
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
