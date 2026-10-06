'use strict';

// Sign-in forms (2.0): offers to fill a saved login's username and password.
// Loaded after content.js (same isolated world): uses its overlay helpers
// (makeOverlay, OVERLAY_HEADER, mountUnlockFrame, fillInputValue, showToast).
//
// Nothing is filled without a click: the overlay lists the logins whose saved
// URLs cover this host, and only the chosen one's password is requested from
// the background, which re-checks the host from the sender. Top frame only.
// Sign-up and change-password fields (autocomplete="new-password") are left
// alone.
(() => {
  if (window.top !== window) return;

  const OVERLAY_ID = 'otpilot-login-fill';
  let _dismissed = false;   // closed by the user: not again on this page
  let _checkedFor = null;   // the last password field asked about (one ask per field)
  let _checking = false;

  const isVisible = el => {
    if (!el.isConnected || el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };

  const autocompleteOf = el => (el.getAttribute('autocomplete') || '').toLowerCase();

  // The sign-in password field and its username field (or null).
  function findLoginFields() {
    const password = [...document.querySelectorAll('input[type="password"]')]
      .find(el => isVisible(el) && !autocompleteOf(el).includes('new-password'));
    if (!password) return null;
    const scope = password.form || document;
    const before = [...scope.querySelectorAll('input')].filter(el =>
      el !== password
      && ['text', 'email', 'tel'].includes(el.type)
      && isVisible(el)
      && !autocompleteOf(el).includes('one-time-code')
      && (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING));
    const username = before.find(el => /\b(username|email)\b/.test(autocompleteOf(el)))
      || before[before.length - 1] || null;
    return { username, password };
  }

  async function loginsForPage() {
    try {
      return (await chrome.runtime.sendMessage({ action: 'vaultLoginsForPage' })) || { state: 'locked', logins: [] };
    } catch { return { state: 'locked', logins: [] }; }
  }

  function closeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  async function fill(id) {
    const fields = findLoginFields();
    let res;
    try { res = await chrome.runtime.sendMessage({ action: 'vaultFillLogin', id }); } catch { res = null; }
    if (!fields || !res?.ok) { showToast('OTPilot could not fill this login', false); return; }
    if (fields.username && res.username) fillInputValue(fields.username, res.username);
    fillInputValue(fields.password, res.password);
    closeOverlay();
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render(el, { state, logins }) {
    el.innerHTML = `${OVERLAY_HEADER}<div class="otpilot-login-body" style="padding:10px 12px 12px;"></div>`;
    el.querySelector('.otpilot-overlay-close').addEventListener('click', () => { _dismissed = true; closeOverlay(); });
    const body = el.querySelector('.otpilot-login-body');

    if (state === 'locked') {
      const name = logins.length === 1 ? logins[0].name : `${logins.length} logins`;
      mountUnlockFrame(body, { name, action: 'Unlock & fill', intro: `Unlock OTPilot to fill your ${name} login.` },
        async () => {
          const next = await loginsForPage();
          if (next.state !== 'unlocked' || !next.logins.length) { closeOverlay(); return; }
          if (next.logins.length === 1) { fill(next.logins[0].id); return; }
          render(el, next);
        },
        () => { _dismissed = true; closeOverlay(); });
      return;
    }

    body.innerHTML = `<div style="color:#94a3b8;font-size:12px;margin-bottom:8px;">Sign in with</div>`;
    for (const login of logins) {
      const btn = document.createElement('button');
      btn.className = 'otpilot-login-choice';
      Object.assign(btn.style, {
        display: 'block', width: '100%', textAlign: 'left', margin: '0 0 6px', padding: '8px 10px',
        background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: '8px', cursor: 'pointer',
        color: '#f1f5f9', font: 'inherit', fontSize: '13px',
      });
      btn.innerHTML = `<div style="font-weight:600;">${esc(login.name)}</div>`
        + (login.username ? `<div style="color:#94a3b8;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(login.username)}</div>` : '');
      btn.addEventListener('click', () => fill(login.id));
      body.appendChild(btn);
    }
  }

  async function check() {
    if (_dismissed || _checking || !chrome.runtime?.id) return;
    const fields = findLoginFields();
    if (!fields) { _checkedFor = null; closeOverlay(); return; }
    if (fields.password === _checkedFor) return;
    _checking = true;
    _checkedFor = fields.password;
    try {
      const res = await loginsForPage();
      if (_dismissed || res.state === 'setup' || !res.logins.length) return;
      closeOverlay();
      const el = makeOverlay(OVERLAY_ID);
      render(el, res);
      document.body.appendChild(el);
    } finally {
      _checking = false;
    }
  }

  // Sign-in forms often appear after load (SPAs, modals).
  let timer;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!chrome.runtime?.id) { observer.disconnect(); return; } // extension reloaded
      check();
    }, 400);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  check();
})();
