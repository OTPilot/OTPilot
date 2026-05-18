'use strict';

// Minimal Supabase Auth client for OTPilot extension.
// Google OAuth only — uses chrome.identity.launchWebAuthFlow.
// Session persisted in chrome.storage.local under 'cloudSession'.

const SupabaseAuth = (() => {
  const URL_BASE  = CONFIG.SUPABASE_URL;
  const ANON_KEY  = CONFIG.SUPABASE_ANON_KEY;
  const STORE_KEY = 'cloudSession';

  // ── Storage ────────────────────────────────────────────────────────────────

  let _memSession = null; // in-memory cache to avoid storage propagation races

  function loadSession() {
    if (_memSession) return Promise.resolve(_memSession);
    return new Promise(r =>
      chrome.storage.local.get([STORE_KEY], d => {
        _memSession = d[STORE_KEY] ?? null;
        r(_memSession);
      })
    );
  }
  function saveSession(s) {
    _memSession = s;
    return new Promise(r => chrome.storage.local.set({ [STORE_KEY]: s }, r));
  }
  function clearSession() {
    _memSession = null;
    return new Promise(r => chrome.storage.local.remove([STORE_KEY], r));
  }

  // Called by the popup right after receiving a session from the background,
  // so getAccessToken() doesn't race against the background's storage write.
  function cacheSession(s) {
    _memSession = s;
  }

  // ── Token refresh ──────────────────────────────────────────────────────────

  async function refreshToken(refreshToken) {
    const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const s = {
      access_token:  d.access_token,
      refresh_token: d.refresh_token,
      expires_at:    Date.now() + d.expires_in * 1000,
      user: { id: d.user.id, email: d.user.email },
    };
    await saveSession(s);
    return s;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async function getSession() {
    return loadSession();
  }

  async function getAccessToken() {
    const s = await loadSession();
    if (!s) return null;
    if (Date.now() > s.expires_at - 60000) {
      const refreshed = await refreshToken(s.refresh_token);
      return refreshed?.access_token ?? null;
    }
    return s.access_token;
  }

  async function signInWithGoogle() {
    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl = `${URL_BASE}/auth/v1/authorize`
      + `?provider=google`
      + `&redirect_to=${encodeURIComponent(redirectUrl)}`
      + `&apikey=${ANON_KEY}`
      + `&flow_type=implicit`;

    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async responseUrl => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message ?? 'Cancelled'));
          return;
        }
        try {
          const params       = new URLSearchParams(new URL(responseUrl).hash.slice(1));
          const access_token  = params.get('access_token');
          const refresh_token = params.get('refresh_token');
          const expires_in    = parseInt(params.get('expires_in') ?? '3600', 10);

          if (!access_token) { reject(new Error('No token in response')); return; }

          const userRes = await fetch(`${URL_BASE}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${access_token}`, apikey: ANON_KEY },
          });
          const user = await userRes.json();

          const session = {
            access_token, refresh_token,
            expires_at: Date.now() + expires_in * 1000,
            user: { id: user.id, email: user.email },
          };
          await saveSession(session);
          resolve(session);
        } catch (e) { reject(e); }
      });
    });
  }

  async function signOut() {
    const token = await getAccessToken();
    if (token) {
      await fetch(`${URL_BASE}/auth/v1/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
      }).catch(() => {});
    }
    await clearSession();
  }

  return { getSession, getAccessToken, signInWithGoogle, signOut, cacheSession };
})();
