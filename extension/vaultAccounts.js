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
// name, URL patterns and the autofill flag of every login, so a page can show
// "Unlock to auto-fill <name>" only where the user has an account while the
// vault is locked. Secrets and usernames are never in it. Product decision: it
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
    next.totp = acc.secret
      ? { ...(item.totp || { digits: 6, period: 30, algorithm: 'SHA1' }), secret: acc.secret }
      : null;
    next.urls = String(acc.urls || '').split('\n').map(s => s.trim()).filter(Boolean);
    next.autofill = acc.autofill !== false;
    const category = String(acc.category || '').trim();
    const others = (item.tags || []).slice(1);
    next.tags = category ? [category, ...others.filter(t => t !== category)] : others;
    if (acc.domain) next.iconDomain = acc.domain; else delete next.iconDomain;
    next.position = position;
    return next;
  }

  const comparable = item => JSON.stringify({ ...item, updatedAt: null });

  function indexEntry(item) {
    return { id: item.id, name: item.title || '', urls: (item.urls || []).join('\n'), autofill: item.autofill !== false };
  }

  async function writeIndex(items) {
    const logins = items.filter(i => i.type === 'login').sort(byPosition);
    await local.set({ [INDEX]: logins.map(indexEntry) });
  }

  async function readIndex() {
    return (await local.get(INDEX))[INDEX] || [];
  }

  const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);

  async function loginItems(key) {
    await VaultMigration.migrate();
    const { items } = await VaultStore.readAll(key);
    return items.filter(i => i.type === 'login').sort(byPosition);
  }

  // The account list, in the user's order.
  async function load(key) {
    return (await loginItems(key)).map(toAccount);
  }

  // Saves the whole v1 list. Only items that changed are re-encrypted, and only
  // ids in `knownIds` (what this caller loaded) are deleted when missing, so an
  // account added meanwhile elsewhere (a page's "Add to OTPilot") is kept.
  // Assigns `_id` to new accounts in place.
  async function save(accounts, key, knownIds = new Set()) {
    const existing = new Map((await loginItems(key)).map(i => [i.id, i]));
    const changed = [];
    accounts.forEach((acc, position) => {
      const base = (acc._id && existing.get(acc._id)) || Vault.newItem('login', acc._id ? { id: acc._id } : {});
      acc._id = base.id;
      const next = applyAccount(base, acc, position);
      if (!existing.has(base.id) || comparable(next) !== comparable(existing.get(base.id))) {
        next.updatedAt = acc._updatedAt || new Date().toISOString();
        changed.push(next);
      }
    });
    if (changed.length) await VaultStore.save(changed, key);
    const kept = new Set(accounts.map(a => a._id));
    const removed = [...knownIds].filter(id => existing.has(id) && !kept.has(id));
    if (removed.length) await VaultStore.remove(removed);
    await writeIndex((await VaultStore.readAll(key)).items);
    return accounts;
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
    await writeIndex([...items, item]);
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
    await writeIndex(items.map(i => (i.id === id ? next : i)));
    return true;
  }

  return { load, save, add, update, writeIndex, readIndex, toAccount };
})();
