'use strict';

importScripts('config.js', 'supabase.js');

// Latest email OTP detected by email-reader.js (expires after 10 min).
let _emailOtp = null;

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
    _emailOtp = { code: msg.code, expiresAt: Date.now() + 10 * 60 * 1000 };
    sendResponse({ ok: true });
    return true;
  }

  // Active request from content.js when an OTP field needs a code.
  if (msg.action === 'getEmailOtp') {
    if (_emailOtp && Date.now() < _emailOtp.expiresAt) {
      sendResponse({ code: _emailOtp.code });
      return true;
    }
    chrome.tabs.query({}, tabs => {
      const emailTab = tabs.find(t =>
        /^https:\/\/(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com|mail\.proton\.me|app\.fastmail\.com|mail\.zoho\.com)/.test(t.url ?? '')
      );
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
      chrome.tabs.sendMessage(emailTab.id, { action: 'scanEmailOtp' }, r => {
        if (!chrome.runtime.lastError && r?.code != null) { handleCode(r.code); return; }
        console.debug('[OTPilot] getEmailOtp: content script not responding, falling back to scripting.executeScript');
        // Fallback: inline scan via scripting API (no pre-injected script needed).
        chrome.scripting.executeScript({
          target: { tabId: emailTab.id },
          func: (provider) => {
            const CODE_RE = /\b(\d{4,8})\b/;
            const selectors = {
              gmail:    'tr[jsmodel]',
              outlook:  '[role="option"][data-convid]',
              yahoo:    '[data-item-id]',
              proton:   '[data-element-id]',
              fastmail: '[data-msg-id]',
              zoho:     '.maillist-item[data-id]',
            };
            const rows = Array.from(document.querySelectorAll(selectors[provider] || 'tr[jsmodel]')).slice(0, 5);
            for (const row of rows) {
              const m = (row.innerText || '').match(CODE_RE);
              if (m) return m[1];
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
});

// ── Background sync polling ───────────────────────────────────────────────────

const API_URL      = CONFIG.API_URL;
const ALARM_NAME   = 'otpilot-sync-poll';
const POLL_MINUTES = 5;

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
