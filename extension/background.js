'use strict';

importScripts('config.js', 'supabase.js');

// Latest email OTP detected by email-reader.js (expires after 10 min).
let _emailOtp = null;

// Recognised webmail origins. localhost/127.0.0.1 are included for the
// localhost-gated test override (?otpilot_test_provider) in email-reader.js.
const WEBMAIL_RE = /^https?:\/\/(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com|mail\.proton\.me|app\.fastmail\.com|mail\.zoho\.com|localhost|127\.0\.0\.1)(?::\d+)?\//;

// Handles OAuth from the background so the popup closing doesn't kill the flow.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'signInWithGoogle') {
    SupabaseAuth.signInWithGoogle()
      .then(session => sendResponse({ ok: true, session }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // Passive push from email-reader.js when a new OTP email arrives.
  if (msg.action === 'emailOtpDetected') {
    // Defense-in-depth: only accept pushes from a real webmail tab, so a
    // malicious page can't poison _emailOtp with an attacker-controlled code.
    if (!WEBMAIL_RE.test(_sender?.tab?.url ?? '')) {
      console.debug('[OTPilot] emailOtpDetected: rejecting push from non-webmail sender', _sender?.tab?.url);
      sendResponse({ ok: false });
      return true;
    }
    _emailOtp = { code: msg.code, expiresAt: Date.now() + 10 * 60 * 1000 };
    sendResponse({ ok: true });
    return true;
  }

  // Active request from content.js when an OTP field needs a code.
  if (msg.action === 'getEmailOtp') {
    // expectedLength = number of digits the login page asks for (or undefined).
    const expectedLength = msg.expectedLength;
    // Use the cache only if fresh AND its length matches what the page expects.
    if (_emailOtp && Date.now() < _emailOtp.expiresAt &&
        (!expectedLength || _emailOtp.code.length === expectedLength)) {
      sendResponse({ code: _emailOtp.code });
      return true;
    }
    chrome.tabs.query({}, tabs => {
      const emailTab = tabs.find(t => WEBMAIL_RE.test(t.url ?? ''));
      if (!emailTab) {
        console.debug('[OTPilot] getEmailOtp: no webmail tab found');
        sendResponse({ code: null }); return;
      }

      function handleCode(code) {
        if (code) _emailOtp = { code, expiresAt: Date.now() + 10 * 60 * 1000 };
        sendResponse({ code: code ?? null });
      }

      // Try messaging the pre-injected content script first.
      // If the tab was open before the extension loaded (MV3 doesn't re-inject into
      // existing tabs), sendMessage fails → fall back to scripting.executeScript.
      chrome.tabs.sendMessage(emailTab.id, { action: 'scanEmailOtp', expectedLength }, r => {
        if (!chrome.runtime.lastError && r?.code != null) { handleCode(r.code); return; }
        console.debug('[OTPilot] getEmailOtp: content script not responding, falling back to scripting.executeScript');
        // Fallback: inline scan via scripting API (no pre-injected script needed).
        chrome.scripting.executeScript({
          target: { tabId: emailTab.id },
          // ⚠️ INVARIANT: this duplicates the scan logic in email-reader.js
          // (getOpenEmailBodies + getRows + pickBestCode). Keep both in sync.
          // Must be fully self-contained — no references to outer scope.
          func: (provider, expectedLength) => {
            const CODE_RE = /\b\d{4,8}\b/g;
            const OTP_KEYWORDS = /(c[oó]digo|code|verificaci[oó]n|verification|passcode|one[- ]?time|2fa|otp|pin|security|seguridad|c[oó]d\.?|auth)/i;
            const bodySelectors = {
              gmail:    '.a3s',
              outlook:  '[role="document"], div[aria-label*="essage body"]',
              yahoo:    '[data-test-id="message-view-body"], .msg-body',
              proton:   '.message-content',
              fastmail: '.v-Message-body, [class*="MessageView"]',
              zoho:     '.zmail-msg-content, .msgBodyDiv',
            };
            const rowSelectors = {
              gmail:    'tr[jsmodel]',
              outlook:  '[role="option"][data-convid]',
              yahoo:    '[data-item-id]',
              proton:   '[data-element-id]',
              fastmail: '[data-msg-id]',
              zoho:     '.maillist-item[data-id]',
            };
            // Requires an OTP keyword near the digits; honours expectedLength.
            function pickBestCode(text) {
              if (!text) return null;
              const matches = [];
              for (const m of text.matchAll(CODE_RE)) matches.push({ code: m[0], idx: m.index });
              if (!matches.length) return null;
              let best = null, bestScore = -Infinity;
              for (let i = 0; i < matches.length; i++) {
                const { code, idx } = matches[i];
                if (expectedLength && code.length !== expectedLength) continue;
                const ctx = text.slice(Math.max(0, idx - 40), idx + code.length + 40);
                if (!OTP_KEYWORDS.test(ctx)) continue;
                let score = 100;
                if (code.length === 6) score += 10;
                if (code.length === 4 && /^(19|20)\d\d$/.test(code)) score -= 50;
                score -= i;
                if (score > bestScore) { bestScore = score; best = code; }
              }
              return best;
            }
            const MAX_AGE_MS = 30 * 60 * 1000;
            function rowIsRecent(row) {
              const cands = [];
              for (const t of row.querySelectorAll('time[datetime]')) cands.push(t.getAttribute('datetime'));
              for (const el of row.querySelectorAll('[title], [aria-label]')) {
                cands.push(el.getAttribute('title'), el.getAttribute('aria-label'));
              }
              let sawValid = false;
              for (const c of cands) {
                if (!c) continue;
                const ms = Date.parse(c);
                if (Number.isNaN(ms)) continue;
                sawValid = true;
                if (Date.now() - ms <= MAX_AGE_MS) return true;
              }
              return !sawValid;
            }
            const bodies = Array.from(document.querySelectorAll(bodySelectors[provider] || '.a3s')).slice(0, 5);
            for (const body of bodies) {
              const code = pickBestCode(body.innerText || '');
              if (code) return code;
            }
            const rows = Array.from(document.querySelectorAll(rowSelectors[provider] || 'tr[jsmodel]')).slice(0, 5);
            for (const row of rows) {
              if (!rowIsRecent(row)) continue;
              const code = pickBestCode(row.innerText || '');
              if (code) return code;
            }
            return null;
          },
          args: [
            /mail\.google\.com/.test(emailTab.url)     ? 'gmail'    :
            /outlook\.(live|office)\.com/.test(emailTab.url) ? 'outlook' :
            /mail\.yahoo\.com/.test(emailTab.url)      ? 'yahoo'    :
            /mail\.proton\.me/.test(emailTab.url)      ? 'proton'   :
            /app\.fastmail\.com/.test(emailTab.url)    ? 'fastmail' :
            'zoho',
            expectedLength ?? null,
          ],
        }, results => {
          if (chrome.runtime.lastError) { sendResponse({ code: null }); return; }
          handleCode(results?.[0]?.result ?? null);
        });
      });
    });
    return true;
  }

  // Single point for token refresh — prevents popup + background from refreshing
  // concurrently and triggering Supabase's refresh-token-reuse revocation.
  if (msg.action === 'getAccessToken') {
    SupabaseAuth.getAccessToken()
      .then(token => sendResponse({ token }))
      .catch(() => sendResponse({ token: null }));
    return true;
  }
  if (msg.action === 'fetchImageBuffer') {
    let parsed;
    try { parsed = new URL(msg.url); } catch { sendResponse({ ok: false, error: 'Invalid URL' }); return true; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      sendResponse({ ok: false, error: 'Invalid URL scheme' });
      return true;
    }
    fetch(msg.url)
      .then(r => r.arrayBuffer())
      .then(buf => sendResponse({ ok: true, data: Array.from(new Uint8Array(buf)) }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Resolve domain favicons: ask the backend (when signed in) or the public CDN
  // for each domain, download the PNG once, and cache it locally as a data URL.
  if (msg.action === 'resolveIcons') {
    handleResolveIcons(msg.domains || [], msg.hints || {}, msg.prune === true)
      .then(updated => sendResponse({ updated }))
      .catch(() => sendResponse({ updated: {} }));
    return true;
  }
});

// ── Background sync polling ───────────────────────────────────────────────────

const API_URL            = CONFIG.API_URL;
const S3_PUBLIC_BASE_URL = (CONFIG.S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const ALARM_NAME         = 'otpilot-sync-poll';
const POLL_MINUTES       = 5;

// ── Domain favicon resolution + local cache ───────────────────────────────────

const ICON_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Mirror of the backend's domain normalization (api/src/routes/icons.rs).
function normalizeIconDomain(input) {
  if (!input) return null;
  let d = String(input).trim().toLowerCase()
    .replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split(':')[0].replace(/\.+$/, '');
  if (!d || d.length > 253 || !d.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(d)) return null;
  return d;
}

// ArrayBuffer → data URL, without FileReader (unavailable in service workers).
function bytesToDataUrl(buf, contentType) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${contentType || 'image/png'};base64,${btoa(bin)}`;
}

// Per domain returns one of:
//   { url }     → download these bytes
//   { none:true}→ authoritative "no icon" (safe to negative-cache)
//   {}          → unknown/pending → retry next time (do NOT negative-cache)
// /icons/resolve is public, so we always call it (icons work for free /
// not-signed-in users too); the Bearer token is attached only when present.
// On network failure we fall back to a deterministic CDN guess (a 404 there is
// only "unknown", so it must not be cached as authoritative "none").
async function resolveIconUrls(domains, hints) {
  const out = {};
  let token = null;
  try { token = await SupabaseAuth.getAccessToken(); } catch { /* not signed in */ }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_URL}/icons/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ domains, hints }),
    });
    if (res.ok) {
      const data = await res.json();
      for (const d of domains) {
        const r = data[d];
        if (r && r.status === 'ok' && r.url) out[d] = { url: r.url };
        else if (r && r.status === 'none') out[d] = { none: true };
        else out[d] = {}; // pending / missing → retry later
      }
      return out;
    }
  } catch { /* offline / API down → CDN guess below */ }

  for (const d of domains) {
    out[d] = S3_PUBLIC_BASE_URL ? { url: `${S3_PUBLIC_BASE_URL}/icons/${d}.png` } : {};
  }
  return out;
}

// `prune` is set when `rawDomains` is the full current account set (popup), so
// stale iconCache entries for deleted accounts can be evicted. It must NOT be set
// for single-domain calls (e.g. enrollment) or they'd wipe the rest of the cache.
async function handleResolveIcons(rawDomains, hints, prune) {
  const domains = [...new Set(rawDomains.map(normalizeIconDomain).filter(Boolean))];
  if (!domains.length) return {};

  const { iconCache = {} } = await new Promise(r => chrome.storage.local.get('iconCache', r));
  let changed = false;

  // Evict cached icons for domains no longer present in the account set.
  if (prune) {
    const keep = new Set(domains);
    for (const d of Object.keys(iconCache)) {
      if (!keep.has(d)) { delete iconCache[d]; changed = true; }
    }
  }

  const now = Date.now();
  const need = domains.filter(d => {
    const e = iconCache[d];
    return !e || (now - e.fetchedAt) > ICON_TTL_MS;
  });

  // Remap hints onto normalized domains.
  const normHints = {};
  for (const [k, v] of Object.entries(hints || {})) {
    const nd = normalizeIconDomain(k);
    if (nd && v) normHints[nd] = v;
  }

  const updated = {};
  if (need.length) {
    const resolved = await resolveIconUrls(need, normHints);
    for (const d of need) {
      const info = resolved[d] || {};
      if (info.none) { iconCache[d] = updated[d] = { dataUrl: null, fetchedAt: now }; continue; }
      if (!info.url) continue; // unknown/pending → retry later, don't cache
      try {
        const r = await fetch(info.url);
        if (r.ok) {
          const buf = await r.arrayBuffer();
          const ct  = r.headers.get('content-type') || 'image/png';
          iconCache[d] = updated[d] = { dataUrl: bytesToDataUrl(buf, ct), fetchedAt: now };
        }
        // non-ok (e.g. 404 on a CDN guess) → leave uncached so it retries later
      } catch { /* transient — leave uncached to retry */ }
    }
    if (Object.keys(updated).length) changed = true;
  }

  if (changed) await new Promise(r => chrome.storage.local.set({ iconCache }, r));
  return updated;
}


chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get(ALARM_NAME, alarm => {
    if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
  });
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;

  const session = await SupabaseAuth.getSession();
  if (!session) return;

  const stored = await new Promise(r =>
    chrome.storage.local.get(['syncKey', 'lastSyncedAt'], r)
  );
  if (!stored.syncKey) return;

  try {
    const token = await SupabaseAuth.getAccessToken();
    if (!token) return;

    const res = await fetch(`${API_URL}/accounts`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return;
    const body = await res.json();
    if (!body) return;

    const serverUpdatedAt = body.updated_at;
    const lastSyncedAt    = stored.lastSyncedAt ?? null;
    if (lastSyncedAt !== null && serverUpdatedAt <= lastSyncedAt) return;

    chrome.runtime.sendMessage({ action: 'serverDataChanged' }).catch(() => {
      chrome.storage.local.set({ pendingServerSync: true });
    });
  } catch { /* offline */ }
});
