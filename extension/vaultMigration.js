'use strict';

// One-time move from the v1 account list to the 2.0 encrypted vault
// (needs vault.js, vaultCrypto.js, vaultKeys.js, vaultStore.js).
//
// Not called anywhere yet: while the popup still reads `accounts`, migrating
// would leave the vault stale. It runs once the UI reads the vault, and v1
// `accounts`/`tombstones` stay untouched until then.
//
// Safety:
// - a backup of the v1 data is written before anything else
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
      if (await isMigrated()) return { status: 'already' };

      const key = await VaultKeys.init();
      if (!key) return { status: 'locked' };

      const { accounts = [], tombstones = {} } = await local.get(['accounts', 'tombstones']);
      await local.set({ [BACKUP]: { accounts, tombstones, at: new Date().toISOString() } });

      // Leftovers from a run that died before writing META.
      await VaultStore.clear();

      const items = accounts.map(acc => Vault.fromV1Account(acc));
      if (items.length) await VaultStore.save(items, key);
      await local.set({
        [V1_TOMBSTONES]: tombstones,
        [META]: { version: 2, migratedAt: new Date().toISOString(), count: items.length },
      });
      return { status: 'migrated', count: items.length };
    });
  }

  return { isMigrated, migrate };
})();
