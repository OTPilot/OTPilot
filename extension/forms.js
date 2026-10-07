'use strict';

// Sign-in forms (2.0): offers to fill a saved login's username and password,
// to save (or update) the one the user just signed in with, and a generated
// password for a new-password field (sign-up, change password).
// Loaded after content.js (same isolated world): uses its overlay helpers
// (makeOverlay, OVERLAY_HEADER, mountUnlockFrame, fillInputValue, showToast)
// and generator.js.
//
// Nothing is filled without a click: the overlay lists the logins whose saved
// URLs cover this host, and only the chosen one's password is requested from
// the background, which re-checks the host from the sender. Top frame only.
// Sign-up and change-password fields (autocomplete="new-password") are left
// alone.
(() => {
  if (window.top !== window) return;

  const OVERLAY_ID = 'otpilot-login-fill';
  // These overlays live in the page's DOM, where its scripts can call
  // .click() on them: anything that fills, saves or changes credentials only
  // acts on a real user event.
  const trusted = fn => e => { if (e.isTrusted) fn(e); };
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

    body.innerHTML = `<div style="color:var(--ink-3, #94a3b8);font-size:12px;margin-bottom:8px;">Sign in with</div>`;
    for (const login of logins) {
      const btn = document.createElement('button');
      btn.className = 'otpilot-login-choice';
      Object.assign(btn.style, {
        display: 'block', width: '100%', textAlign: 'left', margin: '0 0 6px', padding: '8px 10px',
        background: 'var(--bg, #0f172a)', border: '1px solid var(--border, #1e3a5f)', borderRadius: '8px', cursor: 'pointer',
        color: 'var(--ink-0, #f1f5f9)', font: 'inherit', fontSize: '13px',
      });
      btn.innerHTML = `<div style="font-weight:600;">${esc(login.name)}</div>`
        + (login.username ? `<div style="color:var(--ink-3, #94a3b8);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(login.username)}</div>` : '');
      btn.addEventListener('click', trusted(() => fill(login.id)));
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

  // ── Saving a sign-in ───────────────────────────────────────────────────
  // On submit (a form submit, a click on its button, or Enter in the password
  // field) the typed username + password go to the background, which keeps
  // them for this tab. The next page — or this one, if the form went away
  // without navigating — offers to save them. Not while a sign-in form is
  // still showing: that's usually a rejected password or another step.
  const SAVE_ID = 'otpilot-login-save';

  // The filled password field (a new password over the current one on a
  // change-password form) and its username field.
  function findSubmittedFields(root = document) {
    const filled = [...root.querySelectorAll('input[type="password"]')].filter(el => el.value && isVisible(el));
    if (!filled.length) return null;
    const password = filled.find(el => autocompleteOf(el).includes('new-password')) || filled[0];
    const scope = password.form || document;
    const before = [...scope.querySelectorAll('input')].filter(el =>
      ['text', 'email', 'tel'].includes(el.type) && el.value
      && !autocompleteOf(el).includes('one-time-code')
      && (el.compareDocumentPosition(filled[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
    const username = before.find(el => /\b(username|email)\b/.test(autocompleteOf(el))) || before[before.length - 1];
    return { username: username?.value || '', password: password.value };
  }

  // Only duplicate events of one submission (click + submit + Enter) are
  // collapsed: the same credentials submitted again later are a new attempt.
  let _lastCapture = { sig: '', at: 0 };
  let _capturedAt = 0; // while a capture may be pending, DOM changes re-check the offer
  function capture(root) {
    if (!chrome.runtime?.id) return;
    const fields = findSubmittedFields(root);
    if (!fields) return;
    const sig = `${fields.username}\u0000${fields.password}`;
    if (sig === _lastCapture.sig && Date.now() - _lastCapture.at < 1500) return;
    _lastCapture = { sig, at: Date.now() };
    _capturedAt = Date.now();
    chrome.runtime.sendMessage({ action: 'vaultCaptureLogin', ...fields }).catch(() => {});
    // A single-page app may never navigate: ask again once it settles.
    setTimeout(offerSave, 2000);
  }

  // A click counts as submitting a sign-in only on a submit button (a
  // <button> with no type is one, inside a form) or a control that reads
  // like one — never Cancel, Back, Show/Hide password, Forgot password.
  const NOT_SUBMIT = /\b(cancel|back|close|show|hide|reveal|forgot|reset|clear|cancelar|volver|cerrar|mostrar|ocultar|olvid\w*)\b/i;
  const LOOKS_SUBMIT = /\b(sign\s*in|log\s*in|login|sign\s*up|register|continue|next|submit|enter|go|verify|ingresar|iniciar|acceder|entrar|continuar|siguiente)\b/i;
  function isSubmitControl(btn) {
    const text = [btn.textContent, btn.value, btn.getAttribute('aria-label'), btn.title].filter(Boolean).join(' ');
    if (NOT_SUBMIT.test(text)) return false;
    if (btn.form && btn.type === 'submit') return true;
    return LOOKS_SUBMIT.test(text);
  }

  document.addEventListener('submit', e => capture(e.target instanceof HTMLFormElement ? e.target : document), true);
  document.addEventListener('click', e => {
    if (e.target.closest?.(`#${OVERLAY_ID}, #${SAVE_ID}, #otpilot-password-suggest`)) return; // our own buttons
    const btn = e.target.closest?.('button, input[type="submit"], [role="button"]');
    if (!btn || !isSubmitControl(btn)) return;
    const scope = btn.form || btn.closest('form') || document;
    if (scope.querySelector('input[type="password"]')) capture(scope);
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'password') capture(e.target.form || document);
  }, true);

  const passwordFormShowing = () => [...document.querySelectorAll('input[type="password"]')].some(isVisible);

  async function offerSave() {
    if (!chrome.runtime?.id || document.getElementById(SAVE_ID) || passwordFormShowing()) return;
    let offer;
    try { offer = await chrome.runtime.sendMessage({ action: 'vaultPendingLogin' }); } catch { offer = null; }
    if (!offer) { _capturedAt = 0; return; } // nothing pending: stop re-checking
    if (document.getElementById(SAVE_ID) || passwordFormShowing()) return;
    const el = makeOverlay(SAVE_ID);
    renderSave(el, offer);
    document.body.appendChild(el);
  }

  const resolve = (offer, choice) => chrome.runtime.sendMessage({ action: 'vaultResolvePendingLogin', id: offer.id, choice }).catch(() => ({ ok: false }));
  const closeSave = () => document.getElementById(SAVE_ID)?.remove();

  function saveButton(label, primary) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      flex: primary ? '1' : '0 0 auto', padding: '7px 10px', borderRadius: '7px', cursor: 'pointer',
      font: 'inherit', fontSize: '12px', fontWeight: '600',
      background: primary ? 'var(--accent-2, #38bdf8)' : 'transparent', color: primary ? 'var(--bg, #0f172a)' : 'var(--ink-3, #94a3b8)',
      border: primary ? '0' : '1px solid var(--border, #1e3a5f)',
    });
    return b;
  }

  function renderSave(el, offer) {
    el.innerHTML = `${OVERLAY_HEADER}<div class="otpilot-save-body" style="padding:10px 12px 12px;color:var(--ink-0, #f1f5f9);font-size:13px;"></div>`;
    el.querySelector('.otpilot-overlay-close').addEventListener('click', trusted(() => { resolve(offer, 'dismiss'); closeSave(); }));
    const body = el.querySelector('.otpilot-save-body');
    const title = offer.kind === 'update'
      ? `Update the password for <b>${esc(offer.name || offer.host)}</b>?`
      : `Save this login for <b>${esc(offer.host)}</b>?`;

    if (offer.kind === 'locked') {
      mountUnlockFrame(body, { name: offer.host, action: 'Unlock & save', intro: `Unlock OTPilot to save your ${offer.host} login.` },
        async () => {
          let next;
          try { next = await chrome.runtime.sendMessage({ action: 'vaultPendingLogin' }); } catch { next = null; }
          if (!next) { closeSave(); return; }
          renderSave(el, next);
        },
        () => { resolve(offer, 'dismiss'); closeSave(); });
      return;
    }

    body.innerHTML = `<div class="otpilot-save-title" style="margin-bottom:4px;">${title}</div>`
      + (offer.username ? `<div style="color:var(--ink-3, #94a3b8);font-size:12px;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(offer.username)}</div>` : '<div style="height:6px"></div>');
    if (offer.limit) {
      body.insertAdjacentHTML('beforeend', '<div class="otpilot-save-limit" style="color:var(--warning, #fbbf24);font-size:12px;">The Free plan holds 50 items. Upgrade to save more.</div>');
      return;
    }
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px' });
    const save = saveButton(offer.kind === 'update' ? 'Update' : 'Save', true);
    save.className = 'otpilot-save-confirm';
    save.addEventListener('click', trusted(async () => {
      save.disabled = true;
      const res = await resolve(offer, 'save');
      closeSave();
      showToast(res?.ok ? (offer.kind === 'update' ? 'Password updated in OTPilot' : 'Login saved to OTPilot') : 'OTPilot could not save this login', !!res?.ok);
    }));
    const later = saveButton('Not now');
    later.className = 'otpilot-save-later';
    later.addEventListener('click', trusted(() => { resolve(offer, 'dismiss'); closeSave(); }));
    row.append(save, later);
    if (offer.kind === 'new') {
      const never = saveButton('Never');
      never.className = 'otpilot-save-never';
      never.title = `Never offer to save logins on ${offer.host}`;
      never.addEventListener('click', trusted(() => { resolve(offer, 'never'); closeSave(); }));
      row.append(never);
    }
    body.appendChild(row);
  }

  // ── Suggesting a password ──────────────────────────────────────────────
  // Focusing a new-password field offers a generated one (the user's
  // generator settings, always a password, never a PIN). "Use" fills it and
  // the confirmation field next to it; saving happens on submit, as above.
  const GEN_ID = 'otpilot-password-suggest';
  let _genDismissed = false;

  const isNewPassword = el => el instanceof HTMLInputElement && el.type === 'password'
    && autocompleteOf(el).includes('new-password');

  async function suggestPassword(field) {
    if (_genDismissed || document.getElementById(GEN_ID) || !chrome.runtime?.id) return;
    let options = {};
    try { options = (await chrome.storage.local.get('generatorOptions')).generatorOptions || {}; } catch { /* defaults */ }
    if (document.getElementById(GEN_ID)) return;
    let value = Generator.generate({ ...options, mode: 'password' });

    const el = makeOverlay(GEN_ID);
    el.innerHTML = `${OVERLAY_HEADER}<div style="padding:10px 12px 12px;color:var(--ink-0, #f1f5f9);font-size:13px;">
      <div style="margin-bottom:6px;">Use a strong password?</div>
      <div class="otpilot-gen-value" style="font-family:ui-monospace,Menlo,monospace;font-size:13px;background:var(--bg, #0f172a);border:1px solid var(--border, #1e3a5f);border-radius:7px;padding:7px 9px;margin-bottom:8px;word-break:break-all;"></div>
      <div class="otpilot-gen-row" style="display:flex;gap:6px;"></div></div>`;
    const shown = el.querySelector('.otpilot-gen-value');
    shown.textContent = value;
    el.querySelector('.otpilot-overlay-close').addEventListener('click', () => { _genDismissed = true; el.remove(); });

    const use = saveButton('Use', true);
    use.className = 'otpilot-gen-use';
    use.addEventListener('click', trusted(() => {
      const scope = field.form || document;
      const targets = [...scope.querySelectorAll('input[type="password"]')].filter(f => isNewPassword(f) && isVisible(f));
      for (const f of targets.length ? targets : [field]) fillInputValue(f, value);
      el.remove();
    }));
    const again = saveButton('New');
    again.className = 'otpilot-gen-again';
    again.addEventListener('click', () => { value = Generator.generate({ ...options, mode: 'password' }); shown.textContent = value; });
    el.querySelector('.otpilot-gen-row').append(use, again);
    document.body.appendChild(el);
  }

  document.addEventListener('focusin', e => {
    if (isNewPassword(e.target) && isVisible(e.target) && !e.target.value) suggestPassword(e.target);
  }, true);

  // Sign-in forms often appear after load (SPAs, modals).
  let timer;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!chrome.runtime?.id) { observer.disconnect(); return; } // extension reloaded
      check();
      // A sign-in that takes a while to finish: offer once its form is gone.
      if (_capturedAt && Date.now() - _capturedAt < 3 * 60 * 1000) offerSave();
    }, 400);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  check();
  offerSave();
})();
