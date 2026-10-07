'use strict';

// Bridge between the v1 account list the current UI works with and 2.0 vault
// items, until the item-native UI replaces it (needs vault.js, vaultCrypto.js,
// vaultKeys.js, vaultStore.js, vaultMigration.js).
//
// An "account" is the v1 shape { name, email, secret, urls, autofill, category,
// domain, _updatedAt } plus `_id` (the vault item id). Saving one only touches
// the fields the v1 UI knows: anything else on the item (a password, notes,
// extra fields, other tags) is kept.
//
// The locked-vault index (`vaultIndex`, plaintext in chrome.storage.local):
// name, URL patterns, the autofill flag and whether it has a password, for
// every login, so a page can show "Unlock to auto-fill <name>" only where the
// user has an account while the vault is locked. Secrets, passwords and
// usernames are never in it. Product decision: it
// reveals which sites the user has accounts on to anyone who can read the
// browser profile, in exchange for not prompting on every OTP page.
const VaultAccounts = (() => {
  const INDEX = 'vaultIndex';
  const local = chrome.storage.local;

  function toAccount(item) {
    const acc = {
      _id: item.id,
      name: item.title || '',
      email: Vault.getValue(item, 'username'),
      secret: item.totp?.secret || '',
      urls: (item.urls || []).join('\n'),
      autofill: item.autofill !== false,
      category: item.tags?.[0] || '',
      moreTags: (item.tags || []).slice(1),
      password: Vault.getValue(item, 'password'),
      _updatedAt: item.updatedAt,
    };
    if (item.iconDomain) acc.domain = item.iconDomain;
    return acc;
  }

  // Applies the v1 fields of `acc` onto `item` (a copy), keeping the rest.
  function applyAccount(item, acc, position) {
    const next = structuredClone(item);
    next.title = acc.name || '';
    const user = Vault.getField(next, 'username');
    if (user) user.value = acc.email || '';
    // Only when the caller knows about passwords: an account from the v1 blob
    // (a 1.x device) has no `password` and must not erase the stored one.
    const pw = Vault.getField(next, 'password');
    if (pw && acc.password !== undefined && acc.password !== pw.value) {
      if (pw.value) {
        next.passwordHistory = [{ value: pw.value, changedAt: new Date().toISOString() }, ...(item.passwordHistory || [])].slice(0, 5);
      }
      pw.value = acc.password;
    }
    next.totp = acc.secret
      ? { ...(item.totp || { digits: 6, period: 30, algorithm: 'SHA1' }), secret: acc.secret }
      : null;
    next.urls = String(acc.urls || '').split('\n').map(s => s.trim()).filter(Boolean);
    next.autofill = acc.autofill !== false;
    const category = String(acc.category || '').trim();
    // Tags after the first: the editor's "More tags", or kept as they were
    // for callers that don't know them (a 1.x device's account).
    const others = Array.isArray(acc.moreTags) ? acc.moreTags : (item.tags || []).slice(1);
    next.tags = normalizeTags([category, ...others]);
    if (acc.domain) next.iconDomain = acc.domain; else delete next.iconDomain;
    next.position = position;
    return next;
  }

  // Trimmed, non-empty, no duplicates; order kept (the first is the category).
  function normalizeTags(tags) {
    return [...new Set(tags.map(t => String(t || '').trim()).filter(Boolean))];
  }

  const comparable = item => JSON.stringify({ ...item, updatedAt: null });

  function indexEntry(item) {
    return {
      id: item.id, name: item.title || '', urls: (item.urls || []).join('\n'), autofill: item.autofill !== false,
      // Whether it can fill a sign-in form (never the password itself).
      hasPassword: !!Vault.getValue(item, 'password'),
    };
  }

  async function writeIndex(items) {
    const logins = items.filter(i => i.type === 'login').sort(byPosition);
    await local.set({ [INDEX]: logins.map(indexEntry) });
  }

  // Rebuilds the index from what's stored now, under the vault lock, so two
  // writers that each saved an item can't overwrite each other's entry with
  // the list they read before saving.
  function rebuildIndex(key) {
    return navigator.locks.request('otpilot-vault', async () =>
      writeIndex((await VaultStore.readAll(key)).items));
  }

  async function readIndex() {
    return (await local.get(INDEX))[INDEX] || [];
  }

  const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);

  // Logins in order, plus the ids of records that failed to decrypt — those
  // must never be overwritten as if they were missing.
  async function readLogins(key) {
    await VaultMigration.migrate();
    const { items, failed } = await VaultStore.readAll(key);
    return { items: items.filter(i => i.type === 'login').sort(byPosition), failed: new Set(failed) };
  }

  async function loginItems(key) {
    return (await readLogins(key)).items;
  }

  // The account list, in the user's order.
  async function load(key) {
    return (await loginItems(key)).map(toAccount);
  }

  // Every item that isn't a login (notes, servers, API credentials, and types
  // a newer version added), by title. Unreadable records are left out.
  async function loadOthers(key) {
    await VaultMigration.migrate();
    const { items } = await VaultStore.readAll(key);
    return items.filter(i => i.type !== 'login')
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }

  const identity = a => `${a.secret || ''}\u0000${a.name || ''}\u0000${a.email || ''}`;

  // Saves the whole v1 list. Only items that changed are re-encrypted, and only
  // ids in `knownIds` (what this caller loaded) are deleted when missing, so an
  // account added meanwhile elsewhere (a page's "Add to OTPilot") is kept.
  // Assigns `_id` to new accounts in place.
  async function save(accounts, key, knownIds = new Set()) {
    const { changed, removed, ids } = await planSave(accounts, key, knownIds);
    ids.forEach((id, i) => { if (id) accounts[i]._id = id; });
    if (changed.length) await VaultStore.save(changed, key);
    if (removed.length) await VaultStore.remove(removed);
    await rebuildIndex(key);
    return accounts;
  }

  // What save() would write: the items to store, the ids to delete, and the
  // item id of each account (null for an unreadable one, left alone).
  async function planSave(accounts, key, knownIds) {
    const { items, failed } = await readLogins(key);
    const existing = new Map(items.map(i => [i.id, i]));
    // Accounts from the v1 sync blob carry no _id, or another device's: pair
    // them with the local item they correspond to instead of replacing it
    // (and losing its password, notes, other fields). Two passes, so a loose
    // match can never take an item that another incoming account matches
    // exactly: first secret + name + email, then — for what's left — the
    // secret alone, only when exactly one local item and one incoming account
    // share it.
    const pairs = new Map(); // account index -> local item
    const free = new Map(items.map(i => [i.id, i]));
    accounts.forEach((acc, idx) => {
      if (acc._id && existing.has(acc._id)) { pairs.set(idx, existing.get(acc._id)); free.delete(acc._id); }
    });
    accounts.forEach((acc, idx) => {
      if (pairs.has(idx) || (acc._id && failed.has(acc._id))) return;
      const match = [...free.values()].find(i => identity(toAccount(i)) === identity(acc));
      if (match) { pairs.set(idx, match); free.delete(match.id); }
    });
    const bySecret = (list, secretOf) => list.reduce((m, x) => {
      const sec = secretOf(x);
      if (sec) m.set(sec, [...(m.get(sec) || []), x]);
      return m;
    }, new Map());
    const freeBySecret = bySecret([...free.values()], i => i.totp?.secret);
    const unpaired = accounts.map((acc, idx) => idx).filter(idx => !pairs.has(idx) && !(accounts[idx]._id && failed.has(accounts[idx]._id)));
    const unpairedBySecret = bySecret(unpaired, idx => accounts[idx].secret);
    for (const [sec, idxs] of unpairedBySecret) {
      const candidates = freeBySecret.get(sec) || [];
      if (idxs.length === 1 && candidates.length === 1) { pairs.set(idxs[0], candidates[0]); free.delete(candidates[0].id); }
    }

    const changed = [];
    const ids = accounts.map((acc, position) => {
      if (acc._id && failed.has(acc._id)) return null; // unreadable record: leave it alone
      const base = pairs.get(position) || Vault.newItem('login', acc._id ? { id: acc._id } : {});
      const next = applyAccount(base, acc, position);
      if (!existing.has(base.id) || comparable(next) !== comparable(existing.get(base.id))) {
        next.updatedAt = acc._updatedAt || new Date().toISOString();
        changed.push(next);
      }
      return base.id;
    });
    const kept = new Set(accounts.map((a, i) => ids[i] ?? a._id));
    const removed = [...knownIds].filter(id => existing.has(id) && !kept.has(id));
    return { changed, removed, ids };
  }

  // Whether saving `accounts` from the editor would add items that count
  // toward the Free plan past its limit. Over the limit (e.g. after leaving a
  // team) existing items stay editable; only growing the count is refused.
  // Sync merges don't ask: what other devices saved is never dropped.
  // `others`: the editor's non-login changes saved along ({ put, remove }).
  async function exceedsFreeLimit(accounts, key, knownIds, plan, others = { put: [], remove: [] }) {
    if (Vault.PAID_PLANS.includes(plan)) return false;
    const { changed, removed } = await planSave(accounts, key, knownIds);
    const all = (await VaultStore.readAll(key)).items;
    const after = new Map(all.map(i => [i.id, i]));
    [...removed, ...others.remove].forEach(id => after.delete(id));
    [...changed, ...others.put].forEach(i => after.set(i.id, i));
    const count = Vault.countedItems([...after.values()]);
    return count > Vault.FREE_ITEM_LIMIT && count > Vault.countedItems(all);
  }

  // One account from a page ("Add to OTPilot"). Skips a secret already saved.
  // Returns the account's position in the list.
  async function add(acc, key) {
    const items = await loginItems(key);
    const dup = items.findIndex(i => i.totp?.secret && i.totp.secret === acc.secret);
    if (dup !== -1) return dup;
    const position = items.length ? (items[items.length - 1].position ?? items.length - 1) + 1 : 0;
    const item = applyAccount(Vault.newItem('login'), acc, position);
    item.updatedAt = new Date().toISOString();
    await VaultStore.save(item, key);
    await rebuildIndex(key);
    return items.length;
  }

  // Updates one account if it still matches `expected` (the v1 fields the
  // caller saw). Returns false if it changed or disappeared meanwhile.
  async function update(id, expected, patch, key) {
    const items = await loginItems(key);
    const item = items.find(i => i.id === id);
    if (!item) return false;
    const current = toAccount(item);
    const same = ['name', 'secret', 'urls', 'email'].every(k => (current[k] ?? '') === (expected[k] ?? ''));
    if (!same) return false;
    const next = applyAccount(item, { ...current, ...patch }, item.position ?? 0);
    next.updatedAt = new Date().toISOString();
    await VaultStore.save(next, key);
    await rebuildIndex(key);
    return true;
  }

  return { load, loadOthers, save, exceedsFreeLimit, add, update, writeIndex, readIndex, toAccount, normalizeTags };
})();
