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
    // Filling focuses the fields: that mustn't reopen the dropdown.
    _filling = true;
    try {
      if (fields.username && res.username) fillInputValue(fields.username, res.username);
      fillInputValue(fields.password, res.password);
    } finally { _filling = false; }
    closeOverlay();
    closeDropdown();
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // `close`: what the ✕ (and dismissing the unlock) does — the corner
  // overlay stops offering on this page; a field's dropdown just closes.
  function render(el, { state, logins }, close = () => { _dismissed = true; closeOverlay(); }) {
    el.innerHTML = `${OVERLAY_HEADER}<div class="otpilot-login-body" style="padding:10px 12px 12px;"></div>`;
    el.querySelector('.otpilot-overlay-close').addEventListener('click', close);
    const body = el.querySelector('.otpilot-login-body');

    if (state === 'locked') {
      const name = logins.length === 1 ? logins[0].name : `${logins.length} logins`;
      mountUnlockFrame(body, { name, action: 'Unlock & fill', intro: `Unlock OTPilot to fill your ${name} login.` },
        async () => {
          const next = await loginsForPage();
          if (next.state !== 'unlocked' || !next.logins.length) { closeOverlay(); return; }
          if (next.logins.length === 1) { fill(next.logins[0].id); return; }
          render(el, next, close);
        },
        close);
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
    if (!fields) { _checkedFor = null; _pageLogins = null; closeOverlay(); syncBadges(); return; }
    if (fields.password === _checkedFor) { syncBadges(); return; }
    _checking = true;
    _checkedFor = fields.password;
    try {
      const res = await loginsForPage();
      _pageLogins = res.state === 'setup' ? null : res;
      syncBadges();
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

  // Two-step sign-ins ask for the username on one page and the password on
  // the next. A submitted username-only step is kept by the background for
  // this tab, so the password step's capture gets its username.
  const USERNAME_HINT = /user|e-?mail|login|identifier|account|usuario|correo/i;
  // A visible password field: the form is past (or on) its password step.
  // A hidden one is a later step of the same form, still to come.
  const hasVisiblePassword = root => [...root.querySelectorAll('input[type="password"]')].some(isVisible);

  function findUsernameStep(root = document) {
    if (hasVisiblePassword(root)) return null;
    const filled = [...root.querySelectorAll('input')].filter(el =>
      ['text', 'email', 'tel'].includes(el.type) && el.value.trim() && isVisible(el)
      && !autocompleteOf(el).includes('one-time-code'));
    if (filled.length !== 1) return null;
    const el = filled[0];
    const looksLikeUsername = /\b(username|email)\b/.test(autocompleteOf(el)) || el.type === 'email'
      || USERNAME_HINT.test(`${el.name} ${el.id}`);
    return looksLikeUsername ? el.value.trim() : null;
  }

  function captureUsername(root) {
    if (!chrome.runtime?.id) return;
    const username = findUsernameStep(root);
    if (username) chrome.runtime.sendMessage({ action: 'vaultCaptureUsername', username }).catch(() => {});
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

  document.addEventListener('submit', e => {
    const scope = e.target instanceof HTMLFormElement ? e.target : document;
    if (hasVisiblePassword(scope)) capture(scope); else captureUsername(scope);
  }, true);
  document.addEventListener('click', e => {
    if (e.target.closest?.(`#${OVERLAY_ID}, #${SAVE_ID}, #${DROP_ID}, #otpilot-password-suggest, .${BADGE_CLASS}`)) return; // our own UI
    const btn = e.target.closest?.('button, input[type="submit"], [role="button"]');
    if (!btn || !isSubmitControl(btn)) return;
    const scope = btn.form || btn.closest('form') || document;
    if (hasVisiblePassword(scope)) capture(scope); else captureUsername(scope);
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    if (e.target.type === 'password') capture(e.target.form || document);
    else if (['text', 'email', 'tel'].includes(e.target.type)) captureUsername(e.target.form || document);
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

  const resolve = (offer, choice, target) => chrome.runtime.sendMessage({ action: 'vaultResolvePendingLogin', id: offer.id, choice, target }).catch(() => ({ ok: false }));
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
    const first = (offer.candidates || [])[0];
    const title = offer.kind !== 'update' ? `Save this login for <b>${esc(offer.host)}</b>?`
      : (offer.candidates || []).length > 1 ? `Update a login for <b>${esc(offer.host)}</b>?`
      : first && !first.username && offer.username ? `Add this username and password to <b>${esc(offer.name || offer.host)}</b>?`
      : `Update the password for <b>${esc(offer.name || offer.host)}</b>?`;

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

    // An update can apply to several of the site's logins (no username was
    // captured): the user picks which.
    const candidates = offer.kind === 'update' ? (offer.candidates || []) : [];
    let picker = null;
    if (candidates.length > 1) {
      picker = document.createElement('select');
      picker.className = 'otpilot-save-target';
      Object.assign(picker.style, {
        width: '100%', margin: '0 0 10px', padding: '6px 8px', borderRadius: '7px', font: 'inherit', fontSize: '12px',
        background: 'var(--bg, #0f172a)', color: 'var(--ink-0, #f1f5f9)', border: '1px solid var(--border, #1e3a5f)',
      });
      for (const c of candidates) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.username ? `${c.name || offer.host} — ${c.username}` : (c.name || offer.host);
        picker.appendChild(o);
      }
      body.appendChild(picker);
    }
    const chosen = () => candidates.find(c => c.id === picker?.value) || candidates[0];
    const updateLimited = () => offer.kind === 'update' ? !!chosen()?.limit : !!offer.limit;

    const limitNote = document.createElement('div');
    limitNote.className = 'otpilot-save-limit';
    limitNote.textContent = 'The Free plan holds 50 items. Upgrade to save more.';
    Object.assign(limitNote.style, { color: 'var(--warning, #fbbf24)', fontSize: '12px', margin: '0 0 8px' });
    // Nothing this offer could do fits the Free plan: just say why.
    if (offer.limit && (offer.kind === 'new' || offer.newLimit) && !picker) {
      body.appendChild(limitNote);
      return;
    }

    const done = async (choice, target) => {
      const res = await resolve(offer, choice, target);
      closeSave();
      const updated = choice === 'save' && offer.kind === 'update';
      showToast(res?.ok ? (updated ? 'Login updated in OTPilot' : 'Login saved to OTPilot') : 'OTPilot could not save this login', !!res?.ok);
      // Its site icon, from this page's own <link rel=icon> (content.js), as
      // a 2FA account added from a page gets.
      if (res?.ok) requestSiteIcon(offer.host); // the saved login's host (its URL)
    };

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    const save = saveButton(offer.kind === 'update' ? 'Update' : 'Save', true);
    save.className = 'otpilot-save-confirm';
    save.addEventListener('click', trusted(() => { save.disabled = true; done('save', offer.kind === 'update' ? chosen()?.id : undefined); }));
    row.append(save);
    if (offer.kind === 'update') {
      const asNew = saveButton('Save as new');
      asNew.className = 'otpilot-save-new';
      asNew.disabled = !!offer.newLimit;
      if (offer.newLimit) asNew.title = 'The Free plan holds 50 items';
      asNew.addEventListener('click', trusted(() => { asNew.disabled = true; done('new'); }));
      row.append(asNew);
    }
    const later = saveButton('Not now');
    later.className = 'otpilot-save-later';
    later.addEventListener('click', trusted(() => { resolve(offer, 'dismiss'); closeSave(); }));
    row.append(later);
    if (offer.kind === 'new') {
      const never = saveButton('Never');
      never.className = 'otpilot-save-never';
      never.title = `Never offer to save logins on ${offer.host}`;
      never.addEventListener('click', trusted(() => { resolve(offer, 'never'); closeSave(); }));
      row.append(never);
    }
    const syncLimit = () => {
      save.disabled = updateLimited();
      if (updateLimited()) body.insertBefore(limitNote, row); else limitNote.remove();
    };
    picker?.addEventListener('change', syncLimit);
    body.appendChild(row);
    syncLimit();
  }

  // ── Suggesting a password ──────────────────────────────────────────────
  // Focusing a new-password field offers a generated one (the user's
  // generator settings, always a password, never a PIN). "Use" fills it and
  // the confirmation field next to it; saving happens on submit, as above.
  const GEN_ID = 'otpilot-password-suggest';
  let _genDismissed = false;

  const isNewPassword = el => el instanceof HTMLInputElement && el.type === 'password'
    && autocompleteOf(el).includes('new-password');

  // Shown under the field (its badge opens it again after a dismissal).
  async function suggestPassword(field, { force = false } = {}) {
    if ((_genDismissed && !force) || document.getElementById(GEN_ID) || !chrome.runtime?.id) return;
    let options = {};
    try { options = (await chrome.storage.local.get('generatorOptions')).generatorOptions || {}; } catch { /* defaults */ }
    if (document.getElementById(GEN_ID)) return;
    let value = Generator.generate({ ...options, mode: 'password' });

    closeDropdown();
    const el = makeAnchored(GEN_ID, field);
    el.innerHTML = `${OVERLAY_HEADER}<div style="padding:10px 12px 12px;color:var(--ink-0, #f1f5f9);font-size:13px;">
      <div style="margin-bottom:6px;">Use a strong password?</div>
      <div class="otpilot-gen-value" style="font-family:ui-monospace,Menlo,monospace;font-size:13px;background:var(--bg, #0f172a);border:1px solid var(--border, #1e3a5f);border-radius:7px;padding:7px 9px;margin-bottom:8px;word-break:break-all;"></div>
      <div class="otpilot-gen-row" style="display:flex;gap:6px;"></div></div>`;
    const shown = el.querySelector('.otpilot-gen-value');
    shown.textContent = value;
    el.querySelector('.otpilot-overlay-close').addEventListener('click', () => { _genDismissed = true; closeDropdown(); });

    const use = saveButton('Use', true);
    use.className = 'otpilot-gen-use';
    use.addEventListener('click', trusted(() => {
      const scope = field.form || document;
      const targets = [...scope.querySelectorAll('input[type="password"]')].filter(f => isNewPassword(f) && isVisible(f));
      _filling = true;
      try { for (const f of targets.length ? targets : [field]) fillInputValue(f, value); } finally { _filling = false; }
      closeDropdown();
    }));
    const again = saveButton('New');
    again.className = 'otpilot-gen-again';
    again.addEventListener('click', () => { value = Generator.generate({ ...options, mode: 'password' }); shown.textContent = value; });
    el.querySelector('.otpilot-gen-row').append(use, again);
    showAnchored(el, field);
  }

  // ── In-field badges and dropdowns ──────────────────────────────────────
  // Like the corner offer, but at the field: an OTPilot badge inside the
  // sign-in fields (when this site has logins) and inside new-password fields.
  // Focusing an empty sign-in field, or clicking a badge, opens a dropdown
  // under the field: the logins (or the unlock frame), or a generated
  // password. The corner offer stays as well.
  const DROP_ID = 'otpilot-login-dropdown';
  const BADGE_CLASS = 'otpilot-field-badge';
  const BADGE = 18;
  let _pageLogins = null;        // the last vaultLoginsForPage answer for this page's form
  let _filling = false;          // a fill is focusing fields
  const _badges = new Map();     // field -> badge
  let _anchor = null;            // { el, field } of the open dropdown

  const BADGE_SVG = `<svg width="${BADGE}" height="${BADGE}" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M64 14 L102 31 V66 Q102 95 64 114 Q26 95 26 66 V31 Z" style="fill:var(--accent-2, #38bdf8)"/>
    <circle cx="64" cy="66" r="20" style="fill:var(--bg, #0f172a)"/>
    <circle cx="64" cy="66" r="5" style="fill:var(--accent-2, #38bdf8)"/></svg>`;

  // Clicks on our UI must not reach the page's outside-click handlers (see
  // makeOverlay) nor take the focus away from the field.
  function isolate(el, keepFocus) {
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) {
      el.addEventListener(ev, e => {
        e.stopPropagation();
        if (keepFocus && (ev === 'mousedown' || ev === 'pointerdown')) e.preventDefault();
      });
    }
  }

  function makeAnchored(id, field) {
    const el = document.createElement('div');
    el.id = id;
    themeUi(el);
    Object.assign(el.style, {
      position: 'fixed', zIndex: '2147483647', width: '280px', background: 'var(--surface, #1e293b)',
      border: '1px solid var(--border, #1e3a5f)', borderRadius: '10px', boxShadow: '0 6px 24px rgba(0,0,0,.45)',
      fontFamily: 'var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)', overflow: 'hidden',
    });
    isolate(el, false);
    return el;
  }

  // Under the field, or above it when there's more room there; never taller
  // than that room (it scrolls instead), so every choice stays reachable.
  function placeUnder(el, field) {
    const r = field.getBoundingClientRect();
    const w = Math.min(Math.max(r.width, 240), 320, window.innerWidth - 16);
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const roomBelow = window.innerHeight - r.bottom - 6 - 8;
    const roomAbove = r.top - 6 - 8;
    // scrollHeight is the content's full height whatever the cap: no need to
    // lift it (that would reset the dropdown's own scroll position).
    const h = el.scrollHeight || 160;
    const above = h > roomBelow && roomAbove > roomBelow;
    const room = Math.max(80, above ? roomAbove : roomBelow);
    el.style.maxHeight = `${room}px`;
    // Always scrollable within that room: the content can grow later (the
    // unlock frame replaced by the login choices).
    el.style.overflowY = 'auto';
    el.style.top = `${above ? r.top - 6 - Math.min(h, room) : r.bottom + 6}px`;
  }

  function showAnchored(el, field) {
    closeDropdown();
    document.body.appendChild(el);
    _anchor = { el, field };
    placeUnder(el, field);
  }

  // Closing also cancels an open still waiting for the background's answer
  // (typed, Escape, clicked elsewhere meanwhile): its reply is then ignored.
  let _openSeq = 0;
  let _pendingField = null;
  function closeDropdown() {
    _openSeq++;
    _pendingField = null;
    _anchor?.el.remove();
    _anchor = null;
  }

  async function openLogins(field) {
    if (!chrome.runtime?.id) return;
    closeDropdown();
    const seq = _openSeq;
    _pendingField = field;
    const res = await loginsForPage();
    if (seq !== _openSeq) return; // closed or superseded meanwhile
    _pendingField = null;
    _pageLogins = res.state === 'setup' ? null : res;
    if (!_pageLogins?.logins.length || !field.isConnected) return;
    const el = makeAnchored(DROP_ID, field);
    render(el, res, closeDropdown);
    showAnchored(el, field);
  }

  function makeBadge(field, kind, open) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = BADGE_CLASS;
    b.dataset.kind = kind;
    b.title = 'OTPilot';
    b.setAttribute('aria-label', 'OTPilot');
    themeUi(b);
    b.innerHTML = BADGE_SVG;
    Object.assign(b.style, {
      position: 'fixed', zIndex: '2147483646', width: `${BADGE + 4}px`, height: `${BADGE + 4}px`, padding: '2px',
      margin: '0', border: '0', background: 'transparent', cursor: 'pointer', lineHeight: '0', opacity: '.9',
    });
    isolate(b, true);
    b.addEventListener('click', trusted(() => {
      if (_anchor?.field === field) { closeDropdown(); return; }
      open();
    }));
    return b;
  }

  // Inside the field's right edge, sized to fit it (hidden on a field too
  // small or scrolled away).
  function placeBadge(b, field) {
    const r = field.getBoundingClientRect();
    const size = Math.min(BADGE + 4, Math.floor(r.height - 2));
    const show = size >= 14 && r.width > size * 4 && isVisible(field);
    b.style.display = show ? '' : 'none';
    if (!show) return;
    Object.assign(b.style, {
      width: `${size}px`, height: `${size}px`, padding: `${Math.max(1, Math.round(size / 10))}px`,
      left: `${r.right - size - 4}px`, top: `${r.top + (r.height - size) / 2}px`,
    });
    const svg = b.firstElementChild;
    if (svg) { svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); }
  }

  // The fields that get a badge now: this form's sign-in fields when the
  // site has logins, and every visible new-password field.
  function badgeTargets() {
    const out = new Map();
    const login = _pageLogins?.logins.length ? findLoginFields() : null;
    for (const f of [login?.username, login?.password]) if (f) out.set(f, ['login', () => openLogins(f)]);
    for (const f of document.querySelectorAll('input[type="password"]')) {
      if (isNewPassword(f) && isVisible(f)) out.set(f, ['generate', () => suggestPassword(f, { force: true })]);
    }
    return out;
  }

  function syncBadges() {
    if (!chrome.runtime?.id) return;
    const targets = badgeTargets();
    for (const [field, b] of _badges) {
      if (!targets.has(field)) { b.remove(); _badges.delete(field); }
    }
    for (const [field, [kind, open]] of targets) {
      let b = _badges.get(field);
      if (b && b.dataset.kind !== kind) { b.remove(); b = null; }
      if (!b) { b = makeBadge(field, kind, open); _badges.set(field, b); document.body.appendChild(b); }
      placeBadge(b, field);
    }
    if (_anchor && !_anchor.field.isConnected) closeDropdown();
  }

  let _placing = false;
  const reposition = e => {
    // Scrolling inside the dropdown itself moves nothing.
    if (e?.target instanceof Node && _anchor?.el.contains(e.target)) return;
    if (_placing) return;
    _placing = true;
    requestAnimationFrame(() => {
      _placing = false;
      for (const [field, b] of _badges) placeBadge(b, field);
      if (_anchor) placeUnder(_anchor.el, _anchor.field);
    });
  };
  window.addEventListener('scroll', reposition, { capture: true, passive: true });
  window.addEventListener('resize', reposition, { passive: true });

  // A click elsewhere (not on the field, its badge or the dropdown) or Escape
  // closes the dropdown.
  document.addEventListener('pointerdown', e => {
    if (!_anchor && !_pendingField) return;
    const t = e.target;
    if (t === (_anchor?.field ?? _pendingField) || _anchor?.el.contains(t) || t.closest?.(`.${BADGE_CLASS}`)) return;
    closeDropdown();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDropdown(); }, true);
  // Typing in the field: the user isn't picking from the dropdown (it would
  // also cover the fields below).
  document.addEventListener('input', e => {
    if (e.isTrusted && (_anchor?.field === e.target || _pendingField === e.target)) closeDropdown();
  }, true);

  document.addEventListener('focusin', e => {
    const f = e.target;
    if (_filling || !(f instanceof HTMLInputElement) || !isVisible(f) || f.value) return;
    if (isNewPassword(f)) { suggestPassword(f); return; }
    // Not waiting for the page's first check: focusing the field before the
    // background answered still opens (openLogins asks, and shows only if the
    // site has logins). Once that check found none, focusing doesn't ask again.
    if (_anchor?.field === f || _pendingField === f) return;
    if (_pageLogins && !_pageLogins.logins.length) return;
    const login = findLoginFields();
    if (login && (f === login.username || f === login.password)) openLogins(f);
  }, true);

  // The vault's logins changed (saved or imported in the popup, synced, a
  // lock or unlock rewrites the index): forget the page's last answer and
  // check again, so a login added meanwhile is offered without a reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.vaultIndex || !chrome.runtime?.id) return;
      _pageLogins = null;
      _checkedFor = null;
      if (!_dismissed) check();
    });
  } catch { /* extension context gone */ }

  // ── Launched from OTPilot ("Open & sign in") ───────────────────────────
  // This tab was opened by the popup to sign in: fill the username step and
  // the sign-in form as they appear and submit them (not where auto-submit
  // is known to be rejected: there the click is left to the user). The
  // background releases the password once, so a rejected one never loops.
  let _launch = null; // null: not asked yet; false: no launch; true: on
  let _launchStep = ''; // the step already filled on this page
  const launchFill = step => chrome.runtime.sendMessage({ action: 'vaultLaunchFill', step }).catch(() => null);

  // The username field of a page asking only for it (no password yet) —
  // only with evidence it's a sign-in step, never a newsletter's email box:
  // autocomplete="username", or a form whose button reads like signing in.
  const SIGN_IN_BUTTON = /\b(sign\s*in|log\s*in|login|continue|next|iniciar|ingresar|acceder|entrar|continuar|siguiente)\b/i;
  const NOT_SIGN_IN = /\b(subscribe|newsletter|sign\s*up|register|join|suscrib\w*|registr\w*)\b/i;
  function findUsernameOnlyField() {
    if (hasVisiblePassword(document)) return null;
    const inputs = [...document.querySelectorAll('input')].filter(el =>
      ['text', 'email', 'tel'].includes(el.type) && isVisible(el)
      && !autocompleteOf(el).includes('one-time-code'));
    return inputs.find(el => {
      if (autocompleteOf(el).split(/\s+/).includes('username')) return true;
      if (!(el.type === 'email' || USERNAME_HINT.test(`${el.name} ${el.id}`))) return false;
      // The action that would submit this field: the form's submit button,
      // else the nearest visible button that reads like signing in. Other
      // buttons (a secondary "Sign up") don't count either way.
      const label = b => [b.textContent, b.value, b.getAttribute('aria-label')].filter(Boolean).join(' ');
      const signIn = b => b && isVisible(b) && SIGN_IN_BUTTON.test(label(b)) && !NOT_SIGN_IN.test(label(b));
      if (el.form) return signIn(findSubmitButton(el.form));
      const scope = el.closest('section, div') || document;
      return [...scope.querySelectorAll('button, input[type="submit"]')].some(signIn);
    }) || null;
  }

  // The launched login's username in that field: another one the site
  // remembered is replaced (the user asked to sign in as this login).
  function putUsername(field, username) {
    if (field.value.trim().toLowerCase() !== String(username).trim().toLowerCase()) fillInputValue(field, username);
  }

  async function submitAfterFill(field) {
    if (await isNoAutoSubmitHost(location.hostname.toLowerCase())) return;
    const form = field.form;
    setTimeout(() => {
      const btn = form ? findSubmitButton(form)
        : [...document.querySelectorAll('button, input[type="submit"]')].find(b => isVisible(b) && isSubmitControl(b));
      if (btn) btn.click();
      else if (form) form.requestSubmit?.();
    }, 300);
  }

  async function continueLaunch() {
    if (_launch === false || !chrome.runtime?.id) return;
    if (_launch === null) _launch = !!(await launchFill('probe'))?.ok;
    if (!_launch) return;
    const login = findLoginFields();
    if (login && _launchStep !== 'password') {
      _launchStep = 'password';
      const res = await launchFill('password');
      if (!res?.ok) { _launch = false; return; }
      _filling = true;
      try {
        if (login.username && res.username) putUsername(login.username, res.username);
        fillInputValue(login.password, res.password);
      } finally { _filling = false; }
      _launch = false; // the launch ends with the password
      submitAfterFill(login.password);
      return;
    }
    const userField = !login && _launchStep === '' && findUsernameOnlyField();
    if (userField) {
      _launchStep = 'username';
      const res = await launchFill('username');
      if (!res?.ok) return;
      _filling = true;
      try { putUsername(userField, res.username); } finally { _filling = false; }
      submitAfterFill(userField);
    }
  }

  // Sign-in forms often appear after load (SPAs, modals).
  let timer;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!chrome.runtime?.id) { observer.disconnect(); return; } // extension reloaded
      check();
      syncBadges();
      continueLaunch();
      // A sign-in that takes a while to finish: offer once its form is gone.
      if (_capturedAt && Date.now() - _capturedAt < 3 * 60 * 1000) offerSave();
    }, 400);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  check();
  offerSave();
  continueLaunch();
})();
