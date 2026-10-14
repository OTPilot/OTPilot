'use strict';

// Approval window for unlocking the web dashboard (see dashboardUnlock.html).
// The answer goes to the background, which hands the keys to the dashboard
// and closes this window.
(() => {
  const id = new URLSearchParams(location.search).get('id') || '';
  const pw = document.getElementById('pw');
  const err = document.getElementById('err');
  const allow = document.getElementById('allow');
  const ALLOW = 'Allow', UNLOCK = 'Unlock & allow';

  chrome.storage.local.get('theme', d => { if (d.theme) document.body.dataset.theme = d.theme; });

  const ask = msg => chrome.runtime.sendMessage({ ...msg, id });

  // Shows the request; null once it's gone (answered, replaced, expired).
  async function refresh() {
    const info = await ask({ action: 'dashboardUnlockInfo' }).catch(() => null);
    if (!info) { window.close(); return; }
    document.getElementById('site').textContent = info.site;
    document.getElementById('email').textContent = info.email || 'your account';
    const locked = info.state !== 'unlocked';
    const shown = !pw.hidden;
    pw.hidden = !locked;
    if (locked && !shown) pw.focus();
    if (!allow.disabled) allow.textContent = locked ? UNLOCK : ALLOW;
    document.body.dataset.ready = '1';
  }

  async function approve() {
    err.textContent = '';
    allow.disabled = true;
    try {
      if (!pw.hidden) {
        if (!pw.value) { err.textContent = 'Enter your master password'; return; }
        allow.textContent = 'Verifying…';
        const res = await chrome.runtime.sendMessage({ action: 'vaultUnlock', password: pw.value });
        if (!res?.ok) { err.textContent = 'Incorrect password'; pw.select(); return; }
        pw.value = '';
      }
      const res = await ask({ action: 'dashboardUnlockAnswer', allow: true });
      if (res?.error === 'locked') { pw.hidden = false; pw.focus(); return; }
      if (!res?.ok) err.textContent = 'This request is no longer open.';
      // Answered: the background closes this window.
    } catch {
      err.textContent = 'An error occurred';
    } finally {
      allow.disabled = false;
      allow.textContent = pw.hidden ? ALLOW : UNLOCK;
    }
  }

  allow.addEventListener('click', approve);
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') approve(); });
  document.getElementById('deny').addEventListener('click', () => {
    ask({ action: 'dashboardUnlockAnswer', allow: false }).catch(() => {}).finally(() => window.close());
  });

  refresh();
  setInterval(refresh, 20000);
})();
