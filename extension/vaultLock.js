'use strict';

// Master-password lock for 2.0 (needs vaultCrypto.js, vaultKeys.js, cloudSync.js).
//
// The master password is mandatory and wraps the vault key. While unlocked the
// key lives only in chrome.storage.session, so the vault locks when the browser
// closes — always. On top of that the user picks an inactivity auto-lock
// (AUTO_LOCK_OPTIONS, minutes; 0 = only when the browser closes).
//
// Replaces the v1 lock (an `auth` sentinel that only gated the UI, plus a
// `sessionExpiry` of up to 30 days that survived restarts). A v1 user is
// migrated on their first unlock: the old password is checked against the
// sentinel, then becomes the password that wraps the vault key.
const VaultLock = (() => {
  const AUTO_LOCK = 'autoLockMinutes';   // chrome.storage.local
  const LOCK_AT = 'vaultLockAt';         // chrome.storage.session (ms epoch)
  const LEGACY = ['auth', 'sessionExpiry', 'sessionDuration'];
  const LEGACY_SENTINEL = 'otpilot-auth-ok';
  const AUTO_LOCK_OPTIONS = [15, 60, 240, 480, 0];
  // Set once the user confirmed they saved the recovery key (shown after
  // first setup and to users upgrading from v1).
  const KEY_SAVED = 'recoveryKeyAcknowledged';
  const DEFAULT_AUTO_LOCK = 0;

  const local = chrome.storage.local;
  const session = chrome.storage.session;

  // v1: PBKDF2-SHA256 (200k) → AES-GCM over a fixed sentinel, no AAD.
  async function verifyLegacy(password, auth) {
    try {
      const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: b64d(auth.salt), hash: 'SHA-256', iterations: 200000 },
        base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
      );
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(auth.iv) }, key, b64d(auth.data));
      return new TextDecoder().decode(pt) === LEGACY_SENTINEL;
    } catch {
      return false;
    }
  }

  async function getAutoLock() {
    const v = (await local.get(AUTO_LOCK))[AUTO_LOCK];
    return AUTO_LOCK_OPTIONS.includes(v) ? v : DEFAULT_AUTO_LOCK;
  }

  async function setAutoLock(minutes) {
    if (!AUTO_LOCK_OPTIONS.includes(minutes)) throw new Error('unsupported auto-lock');
    await local.set({ [AUTO_LOCK]: minutes });
    await touch();
  }

  // A fresh inactivity deadline from now. Only after proving the password.
  async function startDeadline() {
    const minutes = await getAutoLock();
    if (minutes > 0) await session.set({ [LOCK_AT]: Date.now() + minutes * 60000 });
    else await session.remove(LOCK_AT);
  }

  // Records activity: pushes the deadline out, unless it already passed — then
  // it locks instead, so activity can never revive an expired session.
  async function touch() {
    if ((await state()) !== 'unlocked') return;
    await startDeadline();
  }

  async function lock() {
    await VaultKeys.lock();
    await session.remove(LOCK_AT);
  }

  // 'setup'    → no master password yet (first run)
  // 'locked'   → needs the master password (incl. a v1 user not migrated yet)
  // 'unlocked' → vault key available; locks here if the inactivity deadline passed
  async function state() {
    const s = await VaultKeys.status();
    if (s === 'unlocked') {
      const lockAt = (await session.get(LOCK_AT))[LOCK_AT];
      if (lockAt && Date.now() >= lockAt) { await lock(); return 'locked'; }
      return 'unlocked';
    }
    if (s === 'locked') return 'locked';
    return (await local.get('auth')).auth ? 'locked' : 'setup';
  }

  // First run, and the one-time v1 migration. Converts a v1 plaintext syncKey
  // first: it is the vault key, and must not stay readable once it's wrapped.
  async function setup(password) {
    if (!password) throw new Error('password required');
    await CloudSync.isSyncEnabled();
    await VaultKeys.init();
    await VaultKeys.setPassword(password);
    await local.remove(LEGACY);
    await startDeadline();
  }

  // Returns true when unlocked, false on a wrong password.
  async function unlock(password) {
    const s = await VaultKeys.status();
    let ok;
    if (s === 'locked' || s === 'unlocked') {
      ok = await VaultKeys.unlock(password);
    } else {
      const { auth } = await local.get('auth');
      if (!auth) throw new Error('no master password set');
      ok = await verifyLegacy(password, auth);
      if (ok) await setup(password);
    }
    if (ok) await startDeadline();
    return ok;
  }

  // Returns false (and changes nothing) when `current` is wrong.
  async function changePassword(current, next) {
    if (!next) throw new Error('password required');
    if (!(await unlock(current))) return false;
    await VaultKeys.setPassword(next);
    await startDeadline();
    return true;
  }

  // "Forgot master password": the recovery key is the vault key itself. A v1
  // plaintext syncKey is converted first so it can be compared.
  async function recover(recoveryKey, newPassword) {
    await CloudSync.isSyncEnabled();
    await VaultKeys.recover(recoveryKey, newPassword);
    await local.remove(LEGACY);
    await startDeadline();
  }

  // Neither password nor recovery key: wipe this device and start over. Data on
  // the server stays encrypted with the lost key.
  function resetDevice() {
    return VaultKeys.wipe();
  }

  // The recovery key, after re-entering the master password; null if wrong.
  async function revealRecoveryKey(password) {
    if (!(await VaultKeys.unlock(password))) return null;
    return VaultKeys.getKey();
  }

  async function needsRecoveryKeyNotice() {
    return (await state()) === 'unlocked' && !(await local.get(KEY_SAVED))[KEY_SAVED];
  }

  function acknowledgeRecoveryKey() {
    return local.set({ [KEY_SAVED]: true });
  }

  // The vault key changed (a recovery key was restored): the saved one is stale.
  function forgetRecoveryKeyNotice() {
    return local.remove(KEY_SAVED);
  }

  return {
    AUTO_LOCK_OPTIONS, state, setup, unlock, lock, touch, changePassword, getAutoLock, setAutoLock,
    recover, resetDevice, revealRecoveryKey, needsRecoveryKeyNotice, acknowledgeRecoveryKey, forgetRecoveryKeyNotice,
  };
})();
