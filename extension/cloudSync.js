'use strict';

// Cloud sync for OTPilot.
// Accounts are AES-GCM encrypted client-side before upload.
// The server only ever sees ciphertext — the sync key never leaves this device
// unless the user explicitly copies it to set up a new device.

const CloudSync = (() => {
  const API_URL  = CONFIG.API_URL;
  const KEY_STORE      = 'syncKey';
  const DEVICE_ID_KEY  = 'deviceId';

  // ── Device identity ────────────────────────────────────────────────────────

  async function getDeviceId() {
    return new Promise(r => chrome.storage.local.get(DEVICE_ID_KEY, d => {
      if (d[DEVICE_ID_KEY]) { r(d[DEVICE_ID_KEY]); return; }
      const id = crypto.randomUUID();
      chrome.storage.local.set({ [DEVICE_ID_KEY]: id }, () => r(id));
    }));
  }

  function parseDeviceInfo() {
    const ua = navigator.userAgent;
    let os = 'Unknown';
    if (/Windows/.test(ua))          os = 'Windows';
    else if (/Macintosh/.test(ua))   os = 'macOS';
    else if (/Linux/.test(ua))       os = 'Linux';
    else if (/Android/.test(ua))     os = 'Android';
    else if (/iPhone|iPad/.test(ua)) os = 'iOS';
    const edgeM   = ua.match(/Edg\/(\d+)/);
    const chromeM = ua.match(/Chrome\/(\d+)/);
    const browser = edgeM   ? `Edge ${edgeM[1]}`
                  : chromeM ? `Chrome ${chromeM[1]}`
                  : 'Unknown';
    return { name: `${browser} · ${os}`, os, browser };
  }

  async function getDevicePayload() {
    const device_id = await getDeviceId();
    const { name, os, browser } = parseDeviceInfo();
    return { device_id, name, os, browser };
  }

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

  // data: { accounts, tombstones }
  async function encrypt(data, keyB64) {
    const raw = await crypto.subtle.importKey('raw', dec(keyB64), 'AES-GCM', false, ['encrypt']);
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const ct  = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, raw,
      new TextEncoder().encode(JSON.stringify(data))
    );
    return JSON.stringify({ v: 1, iv: enc(iv), data: enc(ct) });
  }

  // Returns { accounts, tombstones }. Handles old blobs that encrypted an array directly.
  async function decrypt(blob, keyB64) {
    const { v, iv, data } = JSON.parse(blob);
    if (v !== 1) throw new Error('Unknown sync format version');
    const raw   = await crypto.subtle.importKey('raw', dec(keyB64), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: dec(iv) }, raw, dec(data)
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain));
    if (Array.isArray(parsed)) return { accounts: parsed, tombstones: {} };
    return { accounts: parsed.accounts ?? [], tombstones: parsed.tombstones ?? {} };
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
    const devicePayload = await getDevicePayload();
    const res = await apiFetch('/auth/sync-user', {
      method: 'POST',
      body: JSON.stringify(devicePayload),
    });
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

  // Pull + decrypt. Returns { accounts, tombstones } or null if server has no data.
  async function pull() {
    const keyB64 = await getSyncKey();
    if (!keyB64) throw new Error('No sync key');
    const res  = await apiFetch('/accounts');
    if (!res.ok) throw new Error(`pull ${res.status}`);
    const body = await res.json();
    if (!body) return null;
    return decrypt(body.encrypted_blob, keyB64);
  }

  // Fetch server state. Returns { accounts, tombstones, updatedAt, command } or null.
  async function getServerMeta() {
    const keyB64   = await getSyncKey();
    if (!keyB64) throw new Error('No sync key');
    const device_id = await getDeviceId();
    const res = await apiFetch(`/accounts?device_id=${encodeURIComponent(device_id)}`);
    if (!res.ok) throw new Error(`getServerMeta ${res.status}`);
    const body = await res.json();

    const command = body?.command ?? null;

    if (!body || !body.encrypted_blob) {
      return command ? { accounts: [], tombstones: {}, updatedAt: null, command } : null;
    }

    const { accounts, tombstones } = await decrypt(body.encrypted_blob, keyB64);
    return { accounts, tombstones, updatedAt: body.updated_at, command };
  }

  // Execute a pending command from the server ({ action, nonce }).
  // Calls ack first — only acts if ack succeeds (nonce verified server-side).
  async function executeCommand({ action, nonce }) {
    const device_id = await getDeviceId();
    const ackRes = await apiFetch(`/devices/${device_id}/ack`, {
      method: 'POST',
      body: JSON.stringify({ nonce }),
    });
    if (!ackRes.ok) return; // nonce mismatch or already acked — don't act
    if (action === 'erase') {
      await chrome.storage.local.clear();
    } else if (action === 'disconnect') {
      await deleteSyncKey();
    }
  }

  // Encrypt + push { accounts, tombstones } to server.
  async function push(accounts, tombstones, updatedAt) {
    const keyB64        = await getSyncKey();
    if (!keyB64) throw new Error('No sync key');
    const encrypted_blob = await encrypt({ accounts, tombstones }, keyB64);
    const devicePayload  = await getDevicePayload();
    const res = await apiFetch('/accounts', {
      method: 'PUT',
      body: JSON.stringify({
        encrypted_blob,
        updated_at: updatedAt,
        accounts_count: accounts.length,
        ...devicePayload,
      }),
    });
    if (!res.ok) throw new Error(`push ${res.status}`);
    return res.json();
  }

  // ── Merge ──────────────────────────────────────────────────────────────────

  // Merge two account sets with tombstone-aware deletion tracking and conflict detection.
  //
  // Conflict rule: if both sides modified the same account after lastSyncedAt,
  // the remote version is kept as "{name} (conflict)" tagged with _conflictOf/_conflictTs
  // so the next sync on the other device can detect it was already resolved.
  //
  // Returns { accounts, tombstones }.
  function mergeWithTombstones(local, localTombs, remote, remoteTombs, lastSyncedAt) {
    const result    = [];
    const localMap  = new Map(local.map(a => [a.name, a]));
    const remoteMap = new Map(remote.map(a => [a.name, a]));
    const allNames  = new Set([...localMap.keys(), ...remoteMap.keys()]);
    const mergeTs   = new Date().toISOString();

    for (const name of allNames) {
      const loc  = localMap.get(name);
      const rem  = remoteMap.get(name);
      const locTs  = loc?._updatedAt ?? '0';
      const remTs  = rem?._updatedAt ?? '0';
      const locDel = localTombs[name];
      const remDel = remoteTombs[name];

      if (loc && rem) {
        if (locTs === remTs) {
          result.push({ ...loc, _updatedAt: mergeTs });
        } else {
          const locNew = lastSyncedAt === null || locTs > lastSyncedAt;
          const remNew = lastSyncedAt === null || remTs > lastSyncedAt;
          // Check if remote already resolved our version into a (conflict) entry
          const alreadyResolved = [...remoteMap.values()].some(
            r => r._conflictOf === name && r._conflictTs === locTs
          );
          if (alreadyResolved) {
            // Server already merged our copy — accept server state, skip re-conflict
            result.push({ ...rem, _updatedAt: mergeTs });
          } else if (locNew && remNew) {
            // True concurrent conflict — keep both versions
            result.push({ ...loc, _updatedAt: mergeTs });
            result.push({ ...rem, name: `${name} (conflict)`, _updatedAt: mergeTs,
                          _conflictOf: name, _conflictTs: remTs });
          } else {
            // One side is newer — last write wins
            result.push(locTs > remTs
              ? { ...loc, _updatedAt: mergeTs }
              : { ...rem, _updatedAt: mergeTs });
          }
        }
      } else if (loc) {
        // Only local — skip if remote deleted AFTER local's last change
        if (!(remDel && remDel >= locTs)) result.push({ ...loc, _updatedAt: mergeTs });
      } else {
        // Only remote — skip if local deleted AFTER remote's last change
        if (!(locDel && locDel >= remTs)) result.push({ ...rem, _updatedAt: mergeTs });
      }
    }

    // Merge tombstones: keep newest deletion per name
    const mergedTombs = { ...localTombs };
    for (const [n, ts] of Object.entries(remoteTombs)) {
      if (!mergedTombs[n] || ts > mergedTombs[n]) mergedTombs[n] = ts;
    }
    // Remove tombstones for accounts that survived the merge
    const surviving = new Set(result.map(a => a.name));
    for (const n of Object.keys(mergedTombs)) {
      if (surviving.has(n)) delete mergedTombs[n];
    }

    result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return { accounts: result, tombstones: mergedTombs };
  }

  async function leaveDevice() {
    const device_id = await getDeviceId();
    const res = await apiFetch(`/devices/${encodeURIComponent(device_id)}/leave`, { method: 'POST' });
    if (!res.ok) throw new Error(`leaveDevice ${res.status}`);
  }

  return {
    getSyncKey, generateSyncKey, saveSyncKey, deleteSyncKey,
    serverHasData, syncUser, pull, push, mergeWithTombstones,
    getServerMeta, executeCommand, leaveDevice,
  };
})();
