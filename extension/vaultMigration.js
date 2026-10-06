'use strict';

// One-time move from the v1 account list to the 2.0 encrypted vault
// (needs vault.js, vaultCrypto.js, vaultKeys.js, vaultStore.js).
//
// Runs on the first unlock in 2.0 (VaultLock) and lazily before the vault is
// first read (VaultAccounts.load). Afterwards the plaintext v1 `accounts` are
// gone; v1 `tombstones` stay (names only) while the v1 sync blob is still used.
//
// Safety:
// - a backup of the v1 data, encrypted with the vault key, is written first
// - runs under a Web Lock, so the popup and the background worker can't
//   migrate twice at once
// - `vaultMeta.migratedAt` is written last; a run that died before it clears
//   the half-written vault and starts over, so a retry never duplicates items
//   (the vault has no user-created items before the first migration finishes)
const VaultMigration = (() => {
  const META = 'vaultMeta';
  const BACKUP = 'accountsV1Backup';
  // v1 tombstones are keyed by account name; they're kept as-is so the v1
  // transition blob can still tell old clients what was deleted.
  const V1_TOMBSTONES = 'vaultV1Tombstones';

  const local = chrome.storage.local;

  async function isMigrated() {
    return !!(await local.get(META))[META]?.migratedAt;
  }

  // Returns { status: 'migrated', count } | { status: 'already' } |
  //         { status: 'locked' } (master password set and not unlocked).
  function migrate() {
    return navigator.locks.request('otpilot-vault-migration', async () => {
      if (await isMigrated()) {
        // A run that died after META but before removing the plaintext list.
        await local.remove('accounts');
        return { status: 'already' };
      }

      const key = await VaultKeys.init();
      if (!key) return { status: 'locked' };

      const { accounts = [], tombstones = {} } = await local.get(['accounts', 'tombstones']);
      const at = new Date().toISOString();
      await local.set({ [BACKUP]: await VaultCrypto.encryptItem({ id: BACKUP, accounts, tombstones, at }, key) });

      // Leftovers from a run that died before writing META.
      await VaultStore.clear();

      const items = accounts.map((acc, i) => Vault.fromV1Account(acc, i));
      if (items.length) await VaultStore.save(items, key);
      await VaultAccounts.writeIndex(items);
      await local.set({
        [V1_TOMBSTONES]: tombstones,
        [META]: { version: 2, migratedAt: at, count: items.length },
      });
      // Last: the plaintext list only goes once everything else is in place.
      await local.remove('accounts');
      return { status: 'migrated', count: items.length };
    });
  }

  return { isMigrated, migrate };
})();
