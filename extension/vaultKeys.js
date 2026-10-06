'use strict';

// Vault key (VK) lifecycle for 2.0 (needs vaultCrypto.js).
//
// Where VK lives:
//   no master password  → chrome.storage.local `vaultKey` (base64, like the
//                          syncKey today; protected only by the OS account)
//   master password set  → chrome.storage.local `vaultKeyWrapped` (wrapped with
//                          the password, see VaultCrypto.wrapVaultKey), and,
//                          while unlocked, chrome.storage.session
//                          `vaultKeyUnlocked` (memory only, cleared when the
//                          browser closes). Content scripts can't read
//                          storage.session by default, so VK never reaches a
//                          web page's process.
//
// VK is stored apart from `syncKey` on purpose: the extension treats the
// presence of `syncKey` as "sync is set up", so generating one for every user
// would change sync behavior. When a syncKey already exists, VK adopts it so
// the two stay the same key.
//
// The master password never derives VK, so forgetting it is recoverable with
// the recovery key (the syncKey).
const VaultKeys = (() => {
  const PLAIN = 'vaultKey';
  const WRAPPED = 'vaultKeyWrapped';
  const UNLOCKED = 'vaultKeyUnlocked';
  // A fixed value encrypted with VK, stored next to the wrapped key: lets a
  // recovery key be checked locally without the master password, even when
  // the vault has no items yet.
  const CHECK = 'vaultKeyCheck';
  const CHECK_TEXT = 'otpilot-vault-key-check';
  const CHECK_AAD = new TextEncoder().encode('otpilot:vk-check:v1');

  const local = chrome.storage.local;
  const session = chrome.storage.session;

  // 'none'     → no vault key on this device yet (init() creates it)
  // 'open'     → no master password; VK always available
  // 'locked'   → master password set, not unlocked in this browser session
  // 'unlocked' → master password set and unlocked
  async function status() {
    const d = await local.get([PLAIN, WRAPPED]);
    if (d[WRAPPED]) {
      const s = await session.get(UNLOCKED);
      return s[UNLOCKED] ? 'unlocked' : 'locked';
    }
    return d[PLAIN] ? 'open' : 'none';
  }

  // VK as base64, or null when locked or not created yet.
  async function getKey() {
    const d = await local.get([PLAIN, WRAPPED]);
    if (d[WRAPPED]) return (await session.get(UNLOCKED))[UNLOCKED] ?? null;
    return d[PLAIN] ?? null;
  }

  async function makeCheck(key) {
    const k = await crypto.subtle.importKey('raw', VaultCrypto.b64d(key), 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: CHECK_AAD }, k, new TextEncoder().encode(CHECK_TEXT));
    return { iv: VaultCrypto.b64e(iv), ct: VaultCrypto.b64e(ct) };
  }

  // true / false when the candidate can be checked, null when nothing on this
  // device can confirm it (no check value, no vault item, no plaintext key).
  async function matchesVaultKey(candidate) {
    const d = await local.get([CHECK, PLAIN]);
    if (d[PLAIN]) return d[PLAIN] === candidate;
    if (d[CHECK]) {
      try {
        const k = await crypto.subtle.importKey('raw', VaultCrypto.b64d(candidate), 'AES-GCM', false, ['decrypt']);
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: VaultCrypto.b64d(d[CHECK].iv), additionalData: CHECK_AAD }, k, VaultCrypto.b64d(d[CHECK].ct));
        return new TextDecoder().decode(pt) === CHECK_TEXT;
      } catch { return false; }
    }
    if (typeof VaultStore !== 'undefined') {
      // Any one item decrypting confirms the key; a damaged item mustn't block it.
      const records = Object.values(await VaultStore.listRecords());
      for (const rec of records) {
        try { await VaultCrypto.decryptItem(rec, candidate); return true; } catch { /* next */ }
      }
      if (records.length) return false;
    }
    return null;
  }

  // Every state change runs under one Web Lock, shared with VaultStore's
  // record writes. Web Locks are per origin, so this serializes the popup,
  // other extension pages and the background worker: two first-run init()
  // calls can't generate different keys, lock() can't interleave with
  // unlock() or removePassword(), and a re-key can't race a record write.
  const exclusive = fn => navigator.locks.request('otpilot-vault', fn);

  // VK as base64 if `password` unwraps it, null on a wrong password.
  async function unwrapWith(password) {
    const { [WRAPPED]: wrapped } = await local.get(WRAPPED);
    if (!wrapped) throw new Error('no master password set');
    let raw;
    try { raw = await VaultCrypto.unwrapVaultKey(wrapped, password); }
    catch (e) { if (e.message === 'wrong password') return null; throw e; }
    const key = VaultCrypto.b64e(raw);
    raw.fill(0);
    return key;
  }

  // Creates VK if this device has none: adopts the existing syncKey when there
  // is one, otherwise generates a new key. Returns the key (base64), or null if
  // a master password is set and the vault is locked.
  function init() {
    return exclusive(async () => {
      const d = await local.get([PLAIN, WRAPPED, 'syncKey']);
      if (d[WRAPPED] || d[PLAIN]) return getKey();
      const key = d.syncKey || VaultCrypto.b64e(VaultCrypto.generateKey());
      await local.set({ [PLAIN]: key });
      return key;
    });
  }

  // Returns true on success, false on a wrong password.
  function unlock(password) {
    return exclusive(async () => {
      const key = await unwrapWith(password);
      if (!key) return false;
      await session.set({ [UNLOCKED]: key });
      return true;
    });
  }

  function lock() {
    return exclusive(() => session.remove(UNLOCKED));
  }

  // Sets or changes the master password. Needs VK available (open, or
  // unlocked). Writes the wrapped key before dropping the plaintext copy, so a
  // failure in between never leaves the device without a usable key.
  //
  // Refused while a plaintext syncKey exists: it IS the vault key, so wrapping
  // only `vaultKey` would report "locked" while the same key stays readable in
  // `syncKey`. Sync has to read the key through VaultKeys first (2.0 wiring),
  // which moves syncKey under this lifecycle.
  function setPassword(newPassword) {
    return exclusive(async () => {
      const key = await getKey();
      if (!key) throw new Error('vault is locked');
      if ((await local.get('syncKey')).syncKey) throw new Error('sync key is still stored in plaintext');
      const wrapped = await VaultCrypto.wrapVaultKey(key, newPassword);
      await local.set({ [WRAPPED]: wrapped, [CHECK]: await makeCheck(key) });
      await session.set({ [UNLOCKED]: key });
      await local.remove(PLAIN);
    });
  }

  // "Forgot master password": proves the recovery key (= VK) against what this
  // device holds, then wraps it with a new password and unlocks. Nothing in the
  // vault changes. Throws 'wrong recovery key' or 'recovery key can't be checked'.
  function recover(candidate, newPassword) {
    return exclusive(async () => {
      if (!newPassword) throw new Error('password required');
      let raw;
      try { raw = VaultCrypto.b64d(candidate.trim()); } catch { throw new Error('wrong recovery key'); }
      if (raw.length !== 32) throw new Error('wrong recovery key');
      const key = VaultCrypto.b64e(raw);
      const match = await matchesVaultKey(key);
      if (match === null) throw new Error("recovery key can't be checked");
      if (!match) throw new Error('wrong recovery key');
      const wrapped = await VaultCrypto.wrapVaultKey(key, newPassword);
      await local.set({ [WRAPPED]: wrapped, [CHECK]: await makeCheck(key) });
      await session.set({ [UNLOCKED]: key });
      await local.remove(PLAIN);
    });
  }

  // Removes the master password; VK goes back to plaintext at rest. The
  // wrapped copy is only deleted after the plaintext one is written from a key
  // that was actually unwrapped.
  function removePassword(currentPassword) {
    return exclusive(async () => {
      const key = await unwrapWith(currentPassword);
      if (!key) return false;
      await local.set({ [PLAIN]: key });
      await local.remove([WRAPPED, CHECK]);
      await session.remove(UNLOCKED);
      return true;
    });
  }

  // Makes `newKey` the vault key — restoring a recovery key on a device that
  // already has its own, or converting a v1 syncKey. Items already in the
  // vault are re-wrapped to the new key in the same storage write that stores
  // the key. With a master password set, `password` is required: it proves
  // access to the current key and re-wraps the new one.
  function adoptKey(newKey, password) {
    return exclusive(async () => {
      if (VaultCrypto.b64d(newKey).length !== 32) throw new Error('key must be 32 bytes');
      const d = await local.get([PLAIN, WRAPPED]);
      let oldKey = d[PLAIN] ?? null;
      if (d[WRAPPED]) {
        if (!password) throw new Error('password required');
        oldKey = await unwrapWith(password);
        if (!oldKey) throw new Error('wrong password');
      }
      if (oldKey === newKey) return;

      const writes = oldKey && typeof VaultStore !== 'undefined'
        ? await VaultStore.prepareRekey(oldKey, newKey)
        : {};
      if (d[WRAPPED]) {
        writes[WRAPPED] = await VaultCrypto.wrapVaultKey(newKey, password);
        writes[CHECK] = await makeCheck(newKey);
      } else {
        writes[PLAIN] = newKey;
      }
      // Only refresh an unlocked session: if the vault was locked meanwhile
      // (lock() shares this lock), adopting must not reopen it.
      const wasUnlocked = !!(await session.get(UNLOCKED))[UNLOCKED];
      await local.set(writes);
      if (d[WRAPPED] && wasUnlocked) await session.set({ [UNLOCKED]: newKey });
    });
  }

  // Erases everything on this device (reset with neither password nor
  // recovery key). Under the shared lock so an in-flight key change or record
  // write finishes first instead of landing after the wipe.
  function wipe() {
    return exclusive(async () => {
      await local.clear();
      await session.clear();
    });
  }

  return { status, getKey, init, unlock, lock, setPassword, removePassword, adoptKey, recover, wipe };
})();
