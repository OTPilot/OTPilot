'use strict';

// Team key management — an ECDH P-256 keypair used to wrap/unwrap each recipient's
// shared-code user share (K1). The private key is generated locally and then
// carried inside the E2E-encrypted sync vault (see cloudSync.js), so it's the
// SAME across all of the user's devices (restored with the recovery key) and
// shares stay readable after switching device/profile. The server only ever sees
// the public key + the opaque encrypted blob — never the private key in clear.
// Web Crypto native (no external dependency).
const TeamKeys = (() => {
  const PRIV = 'teamPrivJwk';

  const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64d = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));

  async function getStoredJwk() {
    const d = await new Promise(r => chrome.storage.local.get(PRIV, r));
    return d[PRIV] ?? null;
  }

  // Generates the keypair on first use (if none stored). Returns the JWK.
  async function ensureJwk() {
    let jwk = await getStoredJwk();
    if (jwk) return jwk;
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    await new Promise(r => chrome.storage.local.set({ [PRIV]: jwk }, r));
    return jwk;
  }

  // Public key (raw point, base64) derived from the private JWK's x/y coords.
  async function getPublicKeyB64() {
    const jwk = await ensureJwk();
    const pub = await crypto.subtle.importKey(
      'jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      { name: 'ECDH', namedCurve: 'P-256' }, true, []
    );
    return b64e(await crypto.subtle.exportKey('raw', pub));
  }

  async function getPrivateKey() {
    const jwk = await ensureJwk();
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  }

  // For cloudSync: the private JWK to store in the synced vault (or null).
  async function exportPrivJwk() {
    return getStoredJwk();
  }

  // For cloudSync: adopt the keypair restored from the synced vault, so every
  // device of this user shares one keypair. Validates the JWK before storing.
  // Returns true if the stored key actually changed.
  async function adoptPrivJwk(jwk) {
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) return false;
    const current = await getStoredJwk();
    if (current && current.d === jwk.d) return false; // already the same key
    try {
      await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
    } catch { return false; }
    await new Promise(r => chrome.storage.local.set({ [PRIV]: jwk }, r));
    return true;
  }

  // Unwraps an encrypted_user_share blob (JSON { epk, iv, ct }, all base64) → K1
  // (Uint8Array, 32 bytes). epk = sender's ephemeral public key (ECIES).
  async function unwrapUserShare(blobStr) {
    const { epk, iv, ct } = JSON.parse(blobStr);
    const priv = await getPrivateKey();
    if (!priv) throw new Error('no team private key on this device');
    const peerPub = await crypto.subtle.importKey(
      'raw', b64d(epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPub }, priv,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(iv) }, aesKey, b64d(ct));
    return new Uint8Array(pt);
  }

  // Wraps K1 (Uint8Array) to a recipient's public key (raw point, base64) via
  // ECIES — inverse of unwrapUserShare; mirrors web/src/lib/teamCrypto.ts.
  async function wrapUserShare(k1, recipientPubB64) {
    const peerPub = await crypto.subtle.importKey(
      'raw', b64d(recipientPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPub }, eph.privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, k1);
    const epk = await crypto.subtle.exportKey('raw', eph.publicKey);
    return JSON.stringify({ epk: b64e(epk), iv: b64e(iv), ct: b64e(ct) });
  }

  return { getPublicKeyB64, getPrivateKey, exportPrivJwk, adoptPrivJwk, unwrapUserShare, wrapUserShare };
})();
