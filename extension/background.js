'use strict';

importScripts('supabase.js');

// Handles OAuth from the background so the popup closing doesn't kill the flow.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'signInWithGoogle') {
    SupabaseAuth.signInWithGoogle()
      .then(session => sendResponse({ ok: true, session }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep message channel open for async response
  }
});

// ── Background sync polling ───────────────────────────────────────────────────

const API_URL      = 'http://localhost:8080';
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
