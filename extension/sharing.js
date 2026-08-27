'use strict';

// Team shared codes: both the consumption side (list codes shared *with* this
// user and fetch their live TOTP via the 2-of-2 endpoint — send K1, server
// reconstructs K) and the owner side (share one of my own accounts, see/revoke
// what I'm already sharing).
const Sharing = (() => {
  const API_URL = CONFIG.API_URL;
  const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

  async function api(path, opts = {}) {
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

  // Returns the user's single team (or null).
  async function getMyTeam() {
    try {
      const res = await api('/teams');
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // Returns [{ id, account_name, owner_email, k1: Uint8Array }] for codes shared
  // with this user, unwrapping each user share locally with the private key.
  async function getSharedCodes(teamId) {
    const res = await api(`/teams/${teamId}/codes`);
    if (!res.ok) return [];
    const rows = await res.json();
    const out = [];
    for (const r of rows) {
      try {
        const k1 = await TeamKeys.unwrapUserShare(r.encrypted_user_share);
        out.push({ id: r.id, account_name: r.account_name, account_email: r.account_email, owner_email: r.owner_email, k1 });
      } catch { /* can't unwrap (e.g. key from another device) → skip */ }
    }
    return out;
  }

  // Sends K1 to the server, which reconstructs K = K1 XOR K2 and returns the code.
  // `reason` (copy/autofill/refresh) is audited server-side; omit it for passive
  // display / auto-refresh so the activity log isn't spammed.
  async function requestTotp(teamId, codeId, k1, reason) {
    const res = await api(`/teams/${teamId}/codes/${codeId}/totp`, {
      method: 'POST',
      body: JSON.stringify({ user_share: b64e(k1), reason: reason || undefined }),
    });
    if (!res.ok) return null;
    const { code } = await res.json();
    return code ?? null;
  }

  // Codes *I'm* sharing (owner side) — used to show a "shared" badge on an
  // account and to detect an existing share before offering to create another.
  // Returns [{ id, account_name, account_email, recipients }] where `recipients`
  // is just a live count (the API doesn't expose recipient identity here — the
  // dashboard's per-recipient revoke is a separate, more detailed flow).
  // Throws on a non-2xx response rather than returning [] — callers use an
  // empty array to mean "confirmed not shared" (e.g. to decide whether the
  // share picker offers to create a new share), so silently equating a
  // failed request with "nothing shared" would risk a duplicate share on
  // top of one the caller just couldn't see.
  async function getMyCodes(teamId) {
    const res = await api(`/teams/${teamId}/codes/mine`);
    if (!res.ok) throw new Error(`getMyCodes failed: ${res.status}`);
    return await res.json();
  }

  // Revokes an entire shared code (all recipients lose access at once) — the
  // same action as the web dashboard's "Revoke" button on "Codes I'm sharing".
  async function revokeCode(teamId, codeId) {
    const res = await api(`/teams/${teamId}/codes/${codeId}`, { method: 'DELETE' });
    return res.ok;
  }

  // Team members (for picking share recipients). Returns [{ user_id, email, public_key, role }].
  async function getMembers(teamId) {
    const res = await api(`/teams/${teamId}`);
    if (!res.ok) return [];
    const body = await res.json();
    return body.members ?? [];
  }

  // Shares an account's TOTP secret with team members (2-of-2). Generates K/K1/K2
  // locally; the server only ever receives K2 + K1-wrapped-to-each-recipient.
  async function shareCode(teamId, accountName, accountEmail, secret, recipients) {
    const k  = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(secret));

    const recips = [];
    for (const r of recipients) {
      if (!r.public_key) throw new Error(`${r.email || 'A teammate'} hasn't opened the extension yet`);
      const k1 = crypto.getRandomValues(new Uint8Array(32));
      const k2 = k.map((b, i) => b ^ k1[i]);
      recips.push({
        user_id: r.user_id,
        server_share: b64e(k2),
        encrypted_user_share: await TeamKeys.wrapUserShare(k1, r.public_key),
      });
    }

    const res = await api(`/teams/${teamId}/codes`, {
      method: 'POST',
      body: JSON.stringify({
        account_name: accountName,
        account_email: accountEmail || undefined,
        encrypted_secret: b64e(ct),
        iv: b64e(iv),
        recipients: recips,
      }),
    });
    return res.ok;
  }

  return { getMyTeam, getSharedCodes, requestTotp, getMembers, shareCode, getMyCodes, revokeCode };
})();
