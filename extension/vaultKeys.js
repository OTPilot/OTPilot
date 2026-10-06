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

  // Creates VK if this device has none: adopts the existing syncKey when there
  // is one, otherwise generates a new key. Returns the key (base64).
  async function init() {
    const d = await local.get([PLAIN, WRAPPED, 'syncKey']);
    if (d[WRAPPED] || d[PLAIN]) return getKey();
    const key = d.syncKey || VaultCrypto.b64e(VaultCrypto.generateKey());
    await local.set({ [PLAIN]: key });
    return key;
  }

  // Returns true on success, false on a wrong password.
  async function unlock(password) {
    const { [WRAPPED]: wrapped } = await local.get(WRAPPED);
    if (!wrapped) throw new Error('no master password set');
    let raw;
    try { raw = await VaultCrypto.unwrapVaultKey(wrapped, password); }
    catch (e) { if (e.message === 'wrong password') return false; throw e; }
    await session.set({ [UNLOCKED]: VaultCrypto.b64e(raw) });
    raw.fill(0);
    return true;
  }

  function lock() {
    return session.remove(UNLOCKED);
  }

  // Sets or changes the master password. Needs VK available (open, or
  // unlocked). Writes the wrapped key before dropping the plaintext copy, so a
  // failure in between never leaves the device without a usable key.
  async function setPassword(newPassword) {
    const key = await getKey();
    if (!key) throw new Error('vault is locked');
    const wrapped = await VaultCrypto.wrapVaultKey(key, newPassword);
    await local.set({ [WRAPPED]: wrapped });
    await session.set({ [UNLOCKED]: key });
    await local.remove(PLAIN);
  }

  // Removes the master password; VK goes back to plaintext at rest.
  async function removePassword(currentPassword) {
    if (!(await unlock(currentPassword))) return false;
    const key = await getKey();
    await local.set({ [PLAIN]: key });
    await local.remove(WRAPPED);
    await lock();
    return true;
  }

  return { status, getKey, init, unlock, lock, setPassword, removePassword };
})();
