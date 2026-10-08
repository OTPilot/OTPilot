'use strict';

// In-page unlock frame (see unlock.html). The password is sent straight to the
// background worker; the host page only ever learns the outcome, through a
// postMessage that content.js re-checks against the real lock state.
(() => {
  const params = new URLSearchParams(location.search);
  const name = params.get('name') || 'OTPilot';
  const action = params.get('action') || 'Unlock';

  const label = document.getElementById('label');
  label.append(params.get('intro') || 'Unlock to auto-fill ', Object.assign(document.createElement('strong'), { textContent: name }));
  label.title = label.textContent;
  const pw = document.getElementById('pw');
  const err = document.getElementById('err');
  const btn = document.getElementById('unlock');
  btn.textContent = action;

  // A third-party iframe gets partitioned localStorage, so read the theme from
  // chrome.storage (the source of truth) instead of the popup's localStorage mirror.
  chrome.storage.local.get('theme', d => { if (d.theme) document.body.dataset.theme = d.theme; });

  const tell = result => window.parent.postMessage({ source: 'otpilot-unlock', result }, '*');

  async function attempt() {
    if (!pw.value) { err.textContent = 'Enter your password'; return; }
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
      const res = await chrome.runtime.sendMessage({ action: 'vaultUnlock', password: pw.value });
      if (res?.ok) {
        pw.value = '';
        tell('unlocked');
        return;
      }
      err.textContent = 'Incorrect password';
      pw.select();
    } catch {
      err.textContent = 'An error occurred';
    }
    btn.disabled = false;
    btn.textContent = action;
  }

  btn.addEventListener('click', attempt);
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  document.getElementById('dismiss').addEventListener('click', () => tell('dismissed'));
  document.getElementById('eye').addEventListener('click', () => {
    pw.type = pw.type === 'password' ? 'text' : 'password';
  });
  pw.focus();
  // Wired up: a click or Enter from now on is handled (tests wait for this;
  // the button and field exist in the HTML before this script runs).
  document.body.dataset.ready = '1';
})();
