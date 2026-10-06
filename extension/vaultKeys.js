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

  // Every state change runs under one Web Lock. Web Locks are per origin, so
  // this serializes the popup, other extension pages and the background
  // worker: two first-run init() calls can't generate different keys, and
  // lock() can't interleave with unlock() or removePassword().
  const exclusive = fn => navigator.locks.request('otpilot-vault-key', fn);

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
      await local.set({ [WRAPPED]: wrapped });
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
      await local.remove(WRAPPED);
      await session.remove(UNLOCKED);
      return true;
    });
  }

  return { status, getKey, init, unlock, lock, setPassword, removePassword };
})();
