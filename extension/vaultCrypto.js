'use strict';

// Vault cryptography for 2.0 — pure functions, no storage, no UI.
//
// Key hierarchy:
//   VK  vault key       — the existing syncKey (32 random bytes; the recovery key).
//   CK  collection key  — 32 random bytes per team collection (wrapped to each
//                          member's ECDH public key elsewhere, see keys.js).
//   IK  item key        — 32 random bytes per item; encrypts the item's content.
//                          Stored wrapped with VK (personal item) or CK (shared).
//   MK  master key      — optional, derived from the master password with
//                          PBKDF2; only ever wraps VK at rest on this device.
//
// Moving an item between the personal vault and a collection only re-wraps its
// IK (rewrapItemKey); the encrypted content is untouched.
//
// Every ciphertext is AES-256-GCM with a fresh 12-byte IV and binds the item id
// as additional authenticated data, so the server can't swap one item's
// ciphertext (or wrapped key) for another's without decryption failing.
// Web Crypto native (no external dependency).
const VaultCrypto = (() => {
  const ITEM_FORMAT = 2;
  const KDF_ITERATIONS = 600000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
  // Accepted range for a stored blob: never weaker than the default, and capped
  // so a corrupted value can't make unlocking hang.
  const KDF_MAX_ITERATIONS = 5000000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64e = buf => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };
  const b64d = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));

  const itemAad = id => enc.encode(`otpilot:item:v${ITEM_FORMAT}:${id}`);
  const keyAad  = id => enc.encode(`otpilot:ik:v${ITEM_FORMAT}:${id}`);
  const vkAad   = enc.encode('otpilot:vk:v1');

  function generateKey() {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  // Accepts raw bytes or a base64 string (the syncKey is stored as base64).
  function toRaw(key) {
    const raw = typeof key === 'string' ? b64d(key) : key;
    if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error('key must be 32 bytes');
    return raw;
  }

  function importAes(raw, usages) {
    return crypto.subtle.importKey('raw', toRaw(raw), 'AES-GCM', false, usages);
  }

  async function seal(key, plaintext, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
    return { iv: b64e(iv), ct: b64e(ct) };
  }

  async function open(key, box, aad) {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64d(box.iv), additionalData: aad }, key, b64d(box.ct)
    );
    return new Uint8Array(pt);
  }

  // item: plain object with a string `id`. wrappingKey: VK or CK (raw/base64).
  // Returns the record stored locally and synced: { id, v, key, data }.
  // Also used on every edit: each call draws a fresh IK, so an old IK (e.g. one
  // a removed collection member saw) never decrypts newer content.
  async function encryptItem(item, wrappingKey) {
    if (!item || typeof item.id !== 'string' || !item.id) throw new Error('item.id required');
    const ik = generateKey();
    try {
      const data = await seal(await importAes(ik, ['encrypt']), enc.encode(JSON.stringify(item)), itemAad(item.id));
      const key = await seal(await importAes(wrappingKey, ['encrypt']), ik, keyAad(item.id));
      return { id: item.id, v: ITEM_FORMAT, key, data };
    } finally {
      ik.fill(0);
    }
  }

  function assertFormat(record) {
    if (record?.v !== ITEM_FORMAT) throw new Error(`unsupported item format: ${record?.v}`);
  }

  async function decryptItem(record, wrappingKey) {
    assertFormat(record);
    const ik = await open(await importAes(wrappingKey, ['decrypt']), record.key, keyAad(record.id));
    let pt;
    try {
      pt = await open(await importAes(ik, ['decrypt']), record.data, itemAad(record.id));
    } finally {
      ik.fill(0);
    }
    const item = JSON.parse(dec.decode(pt));
    if (item.id !== record.id) throw new Error('item id mismatch');
    return item;
  }

  // Moves an item between wrapping keys (personal VK ⇄ collection CK, or a CK
  // rotation) without touching the encrypted content.
  async function rewrapItemKey(record, fromKey, toKey) {
    assertFormat(record);
    const ik = await open(await importAes(fromKey, ['decrypt']), record.key, keyAad(record.id));
    try {
      const key = await seal(await importAes(toKey, ['encrypt']), ik, keyAad(record.id));
      return { ...record, key };
    } finally {
      ik.fill(0);
    }
  }

  async function deriveMasterKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, hash: 'SHA-256', iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  // Wraps VK under the master password for storage at rest on this device.
  async function wrapVaultKey(vaultKey, password) {
    if (!password) throw new Error('password required');
    const iterations = KDF_ITERATIONS;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const mk = await deriveMasterKey(password, salt, iterations);
    const box = await seal(mk, toRaw(vaultKey), vkAad);
    return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: b64e(salt), ...box };
  }

  // Returns VK as raw bytes. Throws 'wrong password' on a bad password or a
  // tampered blob — GCM can't tell the two apart, and neither should callers.
  async function unwrapVaultKey(wrapped, password) {
    if (wrapped?.v !== 1 || wrapped.kdf !== 'PBKDF2-SHA256') throw new Error('unsupported vault key format');
    const n = wrapped.iterations;
    if (!Number.isInteger(n) || n < KDF_ITERATIONS || n > KDF_MAX_ITERATIONS) {
      throw new Error('unsupported vault key format');
    }
    const mk = await deriveMasterKey(password, b64d(wrapped.salt), wrapped.iterations);
    try {
      return await open(mk, wrapped, vkAad);
    } catch {
      throw new Error('wrong password');
    }
  }

  return {
    ITEM_FORMAT, KDF_ITERATIONS,
    b64e, b64d, generateKey,
    encryptItem, decryptItem, rewrapItemKey,
    wrapVaultKey, unwrapVaultKey,
  };
})();
