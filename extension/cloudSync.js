'use strict';

// Cloud sync for OTPilot.
// Accounts are AES-GCM encrypted client-side before upload.
// The server only ever sees ciphertext — the sync key never leaves this device
// unless the user explicitly copies it to set up a new device.

const CloudSync = (() => {
  // Change to Railway URL before releasing:
  const API_URL  = 'http://localhost:8080';
  const KEY_STORE = 'syncKey';

  // ── Encoding helpers ───────────────────────────────────────────────────────

  const enc = buf => btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer)));
  const dec = str => Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;

  // ── Sync key ───────────────────────────────────────────────────────────────

  function getSyncKey() {
    return new Promise(r =>
      chrome.storage.local.get([KEY_STORE], d => r(d[KEY_STORE] ?? null))
    );
  }

  async function generateSyncKey() {
    const raw    = crypto.getRandomValues(new Uint8Array(32));
    const keyB64 = enc(raw);
    await new Promise(r => chrome.storage.local.set({ [KEY_STORE]: keyB64 }, r));
    return keyB64;
  }

  function saveSyncKey(keyB64) {
    return new Promise(r => chrome.storage.local.set({ [KEY_STORE]: keyB64 }, r));
  }

  function deleteSyncKey() {
    return new Promise(r => chrome.storage.local.remove([KEY_STORE], r));
  }

  // ── Encrypt / decrypt ──────────────────────────────────────────────────────

  async function encrypt(accounts, keyB64) {
    const raw = await crypto.subtle.importKey('raw', dec(keyB64), 'AES-GCM', false, ['encrypt']);
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const ct  = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, raw,
      new TextEncoder().encode(JSON.stringify(accounts))
    );
    return JSON.stringify({ v: 1, iv: enc(iv), data: enc(ct) });
  }

  async function decrypt(blob, keyB64) {
    const { v, iv, data } = JSON.parse(blob);
    if (v !== 1) throw new Error('Unknown sync format version');
    const raw   = await crypto.subtle.importKey('raw', dec(keyB64), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: dec(iv) }, raw, dec(data)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // ── API helpers ────────────────────────────────────────────────────────────

  async function apiFetch(path, opts = {}) {
    const token = await SupabaseAuth.getAccessToken();
    if (!token) throw new Error('Not signed in');
    return fetch(`${API_URL}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(opts.headers ?? {}),
      },
    });
  }

  // ── Sync operations ────────────────────────────────────────────────────────

  // Creates the users row in the API DB on first sign-in.
  async function syncUser() {
    const res = await apiFetch('/auth/sync-user', { method: 'POST' });
    if (!res.ok) throw new Error(`sync-user ${res.status}`);
    const data = await res.json();
    await new Promise(r => chrome.storage.local.set({ userPlan: data.plan ?? 'free' }, r));
    return data;
  }

  // Returns true if the server has an encrypted blob for this user.
  async function serverHasData() {
    const res = await apiFetch('/accounts');
    if (!res.ok) return false;
    const body = await res.json();
    return body !== null;
  }

  // Pull + decrypt. Returns accounts array or null if server has no data.
  async function pull() {
    const keyB64 = await getSyncKey();
    if (!keyB64) throw new Error('No sync key');
    const res  = await apiFetch('/accounts');
    if (!res.ok) throw new Error(`pull ${res.status}`);
    const body = await res.json();
    if (!body) return null;
    return decrypt(body.encrypted_blob, keyB64);
  }

  // Encrypt + push. Returns { conflict: false } or { conflict: true, serverAccounts }.
  async function push(accounts, updatedAt) {
    const keyB64         = await getSyncKey();
    if (!keyB64) throw new Error('No sync key');
    const encrypted_blob = await encrypt(accounts, keyB64);
    const res = await apiFetch('/accounts', {
      method: 'PUT',
      body: JSON.stringify({ encrypted_blob, updated_at: updatedAt }),
    });
    if (!res.ok) throw new Error(`push ${res.status}`);
    const body = await res.json();
    if (body.conflict) {
      const serverAccounts = await decrypt(body.encrypted_blob, keyB64);
      return { conflict: true, serverAccounts };
    }
    return { conflict: false };
  }

  // Merge local + remote (union by name; local wins on collision).
  function mergeAccounts(local, remote) {
    const localNames = new Set(local.map(a => a.name));
    const remoteOnly = remote.filter(a => !localNames.has(a.name));
    return [...local, ...remoteOnly];
  }

  let _debounce = null;
  function schedulePush(accounts, updatedAt) {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => push(accounts, updatedAt).catch(console.error), 2000);
  }

  return {
    getSyncKey, generateSyncKey, saveSyncKey, deleteSyncKey,
    serverHasData, syncUser, pull, push, mergeAccounts, schedulePush,
  };
})();
