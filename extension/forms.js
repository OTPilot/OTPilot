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

  // On screen: connected, enabled, with a size, not hidden.
  const isShown = el => {
    if (!el.isConnected || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  // On screen and editable (a read-only field is the page's display).
  const isVisible = el => isShown(el) && !el.readOnly;

  const autocompleteOf = el => (el.getAttribute('autocomplete') || '').toLowerCase();

  // A read-only password field that is the sign-in's password all the same:
  // a bank's PIN typed on its own on-screen keypad (ABANCA). Only in a form
  // that has a submit / sign-in button, never a new password; a read-only
  // "••••" display elsewhere is not one. Filled with the native setter
  // (fillInputValue), the attribute left as it is. Offered only while empty
  // (findLoginFields); a capture reads its value.
  // Only one empty now, or empty when this script first saw it (its value
  // came later: the keypad, our fill): one that already held a value then
  // is the page showing a stored secret (a settings form's "••••"), never
  // a password to capture, nor one that holds back a save offer.
  const _readonlySeen = new WeakSet();
  const _readonlyPrefilled = new WeakSet();
  const noteReadonly = el => {
    if (_readonlySeen.has(el)) return;
    _readonlySeen.add(el);
    if (el.value) _readonlyPrefilled.add(el);
  };
  const noteReadonlyPasswords = () => {
    for (const el of document.querySelectorAll('input[type="password"]')) if (el.readOnly) noteReadonly(el);
  };
  const isReadonlySignInPassword = el => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'password' || !el.readOnly) return false;
    noteReadonly(el);
    if (el.value && _readonlyPrefilled.has(el)) return false;
    return isShown(el) && !autocompleteOf(el).includes('new-password') && !!el.form
      && !!(findSubmitButton(el.form) || formButton(el.form, signsInToSubmit)) && !isNewPassword(el);
  };
  // A password field that a sign-in can use: editable, or read-only as above.
  const isPasswordShown = el => isVisible(el) || isReadonlySignInPassword(el);

  // A masked username: a password-type field that asks for the username
  // (BBVA's "Usuario"), followed by the real password field. Only by its
  // own hints: autocomplete="username" or a username-like name / label, and
  // nothing that reads like a password or PIN.
  // "pin" as a word between non-letters (account_pin, login-pin, PIN:, not
  // spinner / shipping), or a camelCase part (accountPin).
  const PASSWORD_WORD = /pass|pwd|clave|contrase|senha|passwort|mot\s*de\s*passe|(?:^|[^a-z])pin(?:[^a-z]|$)|secret/i;
  const PIN_CAMEL = /[a-z](?:Pin|PIN)(?![a-z])/;
  const readsLikeUsername = el => {
    const ac = autocompleteOf(el);
    if (ac.includes('new-password') || ac.includes('current-password')) return false;
    const hints = `${el.name} ${el.id} ${el.getAttribute('aria-label') || ''} ${el.labels?.[0]?.textContent || ''} ${el.placeholder || ''}`;
    return (ac.split(/\s+/).includes('username') || USERNAME_HINT.test(hints)) && !PASSWORD_WORD.test(hints) && !PIN_CAMEL.test(hints);
  };
  const isMaskedUsername = el => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'password' || !isVisible(el) || !readsLikeUsername(el)) return false;
    const passwords = root => [...root.querySelectorAll('input[type="password"]')].filter(isVisible);
    let scope = el.form;
    for (let node = el.parentElement, i = 0; !scope && node && i < 5; i++, node = node.parentElement) {
      if (passwords(node).length >= 2) scope = node;
    }
    if (!scope) return false;
    // Exactly one other password field (a sign-in's), after it, that isn't
    // one too — never on a sign-up / reset / change-password page, nor beside
    // a field that reads like a new password: there a password field named
    // "account" / "login" is the account's password.
    if (NEW_PW_PAGE.test(location.pathname) || CHANGE_PW_PAGE.test(location.pathname)) return false;
    const others = passwords(scope).filter(p => p !== el && !readsLikeUsername(p));
    if (others.length !== 1) return false;
    const [p] = others;
    const hints = `${p.name} ${p.id} ${p.placeholder} ${p.getAttribute('aria-label') || ''} ${p.labels?.[0]?.textContent || ''}`;
    if (autocompleteOf(p).includes('new-password') || NEW_PW_HINT.test(hints)) return false;
    return !!(el.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
  };

  // A field for a new password: autocomplete="new-password", or — on the
  // many pages that don't say so — a field named / labelled like one (new,
  // confirm, repeat…), a reset / change-password or sign-up page, or one of
  // two password fields side by side (password + confirmation; with a third,
  // the first is the current one). Never one marked current-password.
  // `password1`: Django's registration field (sign-in uses `password`).
  const NEW_PW_HINT = /new[-_ ]?(pass|pw|pwd)|\bnew\b|confirm|repeat|retype|\bagain\b|nuev|repet|nouveau|nouvelle|\bpassword1\b/i;
  const CURRENT_PW_HINT = /current|\bold\b|old[-_ ]?(pass|pw|pwd)|existing|actual|anterior|viej|ancien|aktuell/i;
  const CHANGE_PW_PAGE = /(change|update)[-_]?pass/i;
  const NEW_PW_PAGE = /(reset|change|new|set|create|update|forgot|recover)[-_]?pass|sign[-_]?up|register|registr|create[-_]?account/i;
  // The password fields that go with this one: its form's, else the ones in
  // the nearest container (up to a few levels) that holds more than one — two
  // sign-in panels elsewhere on the page aren't one group.
  const passwordGroup = el => {
    const visible = root => [...root.querySelectorAll('input[type="password"]')].filter(f => isVisible(f) && !isMaskedUsername(f));
    if (el.form) return visible(el.form);
    let node = el.parentElement;
    for (let i = 0; node && i < 5; i++, node = node.parentElement) {
      const group = visible(node);
      if (group.length < 2) continue;
      // A username / email field between two password fields means two
      // sign-ins side by side, not a password and its confirmation.
      const inputs = [...node.querySelectorAll('input')].filter(isVisible);
      const from = inputs.indexOf(group[0]);
      const to = inputs.indexOf(group[group.length - 1]);
      const split = inputs.slice(from, to).some(i => ['text', 'email', 'tel'].includes(i.type));
      return split ? [el] : group;
    }
    return [el];
  };
  const formRegisters = form => {
    let action = '';
    try { action = new URL(form.getAttribute('action') || '', location.href).pathname; } catch {}
    return NEW_PW_PAGE.test(`${action} ${form.id} ${form.getAttribute('name') || ''}`);
  };
  const isNewPassword = el => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'password') return false;
    if (isMaskedUsername(el)) return false;
    const ac = autocompleteOf(el);
    if (ac.includes('new-password')) return true;
    if (ac.includes('current-password')) return false;
    // Current, new, confirmation: the first of three is the current one,
    // whatever the page says.
    const group = passwordGroup(el);
    if (group.length > 2 && group[0] === el) return false;
    const label = el.labels?.[0]?.textContent || '';
    const hints = `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') || ''} ${label}`;
    // "Confirm current password" is the current one: that check comes first.
    if (CURRENT_PW_HINT.test(hints)) return false;
    if (NEW_PW_HINT.test(hints)) return true;
    // A change-password page with two unnamed fields: current, then new.
    if (CHANGE_PW_PAGE.test(location.pathname) && group.length === 2 && group[0] === el) return false;
    if (NEW_PW_PAGE.test(location.pathname)) return true;
    // A sign-up form on another page (a "Join" modal on the login page):
    // its action / id / name say so, and nothing in it signs in (a combined
    // "login-register" form stays a sign-in).
    if (el.form && formRegisters(el.form) && !formSignsIn(el.form)) return true;
    if (group.length >= 2) return true;
    // One field alone: new when what submits its form creates an account.
    return submitCreatesAccount(el);
  };
  // "Sign up" / "Register" / "Create account" — never Sign in, Continue,
  // Next or Submit alone, and not a bare "Join" (Join meeting, Join the
  // discussion): only "Join now / free / today".
  const CREATE_ACCOUNT = /\b(sign\s*up|registr\w*|join\s+(?:now|free|for\s+free|today)|create\s+(?:an?\s+|your\s+|new\s+)?account)\b/i;
  const createsAccount = b => !!b && CREATE_ACCOUNT.test(buttonLabel(b)) && !NOT_SUBMIT.test(buttonLabel(b));
  const CONTROLS = 'button, input[type="submit"], input[type="button"], [role="button"]';
  // The field's form (or panel) creates an account: its submit control says
  // so and no control next to it signs in. A combined sign-in / sign-up form
  // or panel is a sign-in, whatever comes first in the DOM.
  // A control in `root` signs in. One that creates an account ('Create
  // account and continue') doesn't, unless its label also says so.
  const formSignsIn = root => [...root.querySelectorAll(CONTROLS)].some(b => isVisible(b) && signsInToSubmit(b)
    && !(createsAccount(b) && !/\b(sign\s*in|log\s*in|login)\b/i.test(buttonLabel(b))));
  const submitCreatesAccount = el => {
    const hasSignIn = formSignsIn;
    if (el.form) {
      if (hasSignIn(el.form)) return false;
      return createsAccount(findSubmitButton(el.form) || formButton(el.form, createsAccount));
    }
    // Its username field (the nearest one before it) belongs to the panel.
    const before = [...document.querySelectorAll('input')].filter(i => !i.form && i !== el
      && ['text', 'email', 'tel'].includes(i.type) && isVisible(i)
      && (i.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    // The username belongs to the panel only when it sits close to the
    // password: a common ancestor within 4 levels. Never a search field.
    const prev = before[before.length - 1];
    let near = false;
    if (prev && !isSearchField(prev)) {
      let a = el.parentElement;
      for (let i = 0; a && i < 4 && !near; i++, a = a.parentElement) near = a.contains(prev);
    }
    const own = near ? [el, prev] : [el];
    // Bounded to the same 4 levels as `own`: a "Sign up" further away than
    // the field's own panel (a footer) isn't this field's submit control.
    const hit = buttonNear(el, createsAccount, own, 4);
    if (!hit) return false;
    let panel = el.parentElement;
    while (panel && !panel.contains(hit)) panel = panel.parentElement;
    return !(panel && hasSignIn(panel));
  };

  // The sign-in password field and its username field (or null).
  // A read-only one only while empty (see isReadonlySignInPassword). The
  // username: autocomplete username / email, else a masked username before
  // the password, else the last text field before it.
  function findLoginFields() {
    const password = [...document.querySelectorAll('input[type="password"]')]
      .find(el => (isVisible(el) || (!el.value && isReadonlySignInPassword(el))) && !isNewPassword(el) && !isMaskedUsername(el));
    if (!password) return null;
    const scope = password.form || document;
    const precedes = el => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING;
    const before = [...scope.querySelectorAll('input')].filter(el =>
      el !== password
      && ['text', 'email', 'tel'].includes(el.type)
      && isVisible(el)
      && !autocompleteOf(el).includes('one-time-code')
      && precedes(el));
    const masked = [...scope.querySelectorAll('input[type="password"]')].filter(el => el !== password && precedes(el) && isMaskedUsername(el));
    const username = before.find(el => /\b(username|email)\b/.test(autocompleteOf(el)))
      || masked[masked.length - 1] || before[before.length - 1] || null;
    return { username, password };
  }

  // What an offer fills: the sign-in form (username + password), or the
  // first page of a two-step sign-in, which asks for the username alone
  // (`password` null; see findUsernameOnlyField).
  function findFillFields() {
    const login = findLoginFields();
    if (login) return login;
    const step = findUsernameOnlyField();
    return step ? { username: step.field, password: null } : null;
  }

  async function loginsForPage() {
    try {
      return (await chrome.runtime.sendMessage({ action: 'vaultLoginsForPage' })) || { state: 'locked', logins: [] };
    } catch { return { state: 'locked', logins: [] }; }
  }

  function closeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  // Offered on their own (the corner offer, focusing a field): the logins
  // with Auto-fill on. The badge lists every login of the site.
  const autoOffered = res => ({ ...res, logins: res.logins.filter(l => l.autofill !== false) });
  // A login without a password (2FA only) fills a username: not offered
  // where the page asks for the password alone.
  const forFields = (res, fields = findFillFields()) => (fields && !fields.username
    ? { ...res, logins: res.logins.filter(l => l.hasPassword !== false) } : res);

  // `login`: { id, autoLogin } from vaultLoginsForPage. With "Sign in
  // automatically" on, the form (or the username step) is submitted after
  // the fill — the user's pick is the gesture; not where the site rejects
  // a synthetic click (isNoAutoSubmitHost).
  // The page's empty extra controls go along (descriptors only): the
  // background answers the values of the login's fields matching them.
  async function fill({ id, autoLogin }) {
    const fields = findFillFields();
    // A username step gets the username only: the password waits for its page.
    const usernameOnly = !!fields && !fields.password;
    const targets = fields ? extraFields(fields.password || fields.username, fields.username, { filled: false }) : [];
    let res;
    try {
      res = await chrome.runtime.sendMessage({ action: 'vaultFillLogin', id, usernameOnly, ...(targets.length ? { fields: targets.map(t => t.desc) } : {}) });
    } catch { res = null; }
    if (!fields || !res?.ok || ((usernameOnly || res.noPassword) && !res.username)) {
      showToast(usernameOnly && res?.ok ? 'This login has no username saved' : 'OTPilot could not fill this login', false);
      return;
    }
    // Filling focuses the fields: that mustn't reopen the dropdown.
    // Selects, then typed extra fields, then username and password.
    _filling = true;
    let done;
    try {
      done = await fillExtras(targets, res.extras);
      if (fields.username && res.username) { fillInputValue(fields.username, res.username); done.push(filledCheck(fields.username, 'the username')); }
      // No password saved: the field is emptied (never another account's
      // password beside this username) and focused for the user to type it
      // — OTPilot offers to add it to this login afterwards. Still filling:
      // that focus mustn't reopen the dropdown.
      if (fields.password && res.noPassword) {
        fillInputValue(fields.password, '');
        closeOverlay();
        closeDropdown();
        fields.password.focus();
        return;
      }
      if (fields.password) { fillInputValue(fields.password, res.password); done.push(filledCheck(fields.password, 'the password')); }
    } finally { _filling = false; }
    if (autoLogin !== false) {
      if (fields.password) submitAfterFill(fields.password, passwordButtonFor, done);
      else submitAfterFill(fields.username, signInButtonFor, done);
    }
    closeOverlay();
    closeDropdown();
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // `close`: what the ✕ (and dismissing the unlock) does — the corner
  // overlay stops offering on this page; a field's dropdown just closes.
  // `shown`: which of the page's logins this offer lists (autoOffered for an
  // offer that opened on its own) — the same once the vault is unlocked.
  function render(el, { state, logins }, close = () => { _dismissed = true; closeOverlay(); }, shown = res => res) {
    el.innerHTML = `${OVERLAY_HEADER}<div class="otpilot-login-body" style="padding:10px 12px 12px;"></div>`;
    el.querySelector('.otpilot-overlay-close').addEventListener('click', close);
    const body = el.querySelector('.otpilot-login-body');

    // Locked: a short note and an Unlock button first; the master password
    // is typed in the extension's frame it opens (the page can't read it).
    if (state === 'locked') {
      const name = logins.length === 1 ? logins[0].name : logins.length ? `${logins.length} logins` : '';
      const intro = name ? `Unlock OTPilot to fill your ${name} login.` : 'Unlock OTPilot to fill your credentials.';
      body.innerHTML = `<div class="otpilot-login-locked" style="color:var(--ink-0, #f1f5f9);font-size:13px;margin-bottom:10px;"></div>`;
      body.firstElementChild.textContent = intro;
      const unlock = saveButton('Unlock OTPilot', true);
      unlock.className = 'otpilot-login-unlock';
      unlock.style.width = '100%';
      unlock.addEventListener('click', trusted(() => {
        body.innerHTML = '';
        mountUnlockFrame(body, { name: name || location.hostname, action: 'Unlock & fill', intro },
          async () => {
            const next = shown(await loginsForPage());
            if (next.state !== 'unlocked') { close(); return; }
            if (next.logins.length === 1) { fill(next.logins[0]); return; }
            render(el, next, close, shown); // the logins to pick from, or "No saved login"
            if (_anchor?.el === el) placeUnder(el, _anchor.field);
          },
          close);
        if (_anchor?.el === el) placeUnder(el, _anchor.field);
      }));
      body.appendChild(unlock);
      return;
    }

    if (!logins.length) {
      body.innerHTML = `<div class="otpilot-login-none" style="color:var(--ink-3, #94a3b8);font-size:12px;"></div>`;
      body.firstElementChild.textContent = `No saved login for ${location.hostname}. OTPilot offers to save it after you sign in.`;
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
      const sub = [login.username, login.hasPassword === false ? 'no password saved' : ''].filter(Boolean).join(' · ');
      btn.innerHTML = `<div style="font-weight:600;">${esc(login.name)}</div>`
        + (sub ? `<div style="color:var(--ink-3, #94a3b8);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(sub)}</div>` : '');
      btn.addEventListener('click', trusted(() => fill(login)));
      body.appendChild(btn);
    }
  }

  async function check() {
    if (_dismissed || _checking || !chrome.runtime?.id) return;
    const fields = findFillFields();
    if (!fields) { _checkedFor = null; _pageLogins = null; closeOverlay(); syncBadges(); return; }
    const asked = fields.password || fields.username;
    if (asked === _checkedFor) { syncBadges(); return; }
    _checking = true;
    _checkedFor = asked;
    try {
      const res = await loginsForPage();
      _pageLogins = res.state === 'setup' ? null : res;
      syncBadges();
      const offered = forFields(autoOffered(res), fields);
      // The corner offer opens on its own only for a login with a password
      // (a 2FA-only login is in the field's dropdown, not on every page).
      if (_dismissed || res.state === 'setup' || !offered.logins.some(l => l.hasPassword !== false)) return;
      closeOverlay();
      const el = makeOverlay(OVERLAY_ID);
      render(el, offered, undefined, r => forFields(autoOffered(r)));
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
  // A masked username is the username, never the password. A sign-in (not
  // a new password) also sends its extra fields (`extras`, see extraFields).
  function findSubmittedFields(root = document) {
    const all = [...root.querySelectorAll('input[type="password"]')].filter(el => el.value && isPasswordShown(el));
    const filled = all.filter(el => !isMaskedUsername(el));
    if (!filled.length) return null;
    const password = filled.find(isNewPassword) || filled[0];
    const scope = password.form || document;
    const precedes = el => el.compareDocumentPosition(filled[0]) & Node.DOCUMENT_POSITION_FOLLOWING;
    const before = [...scope.querySelectorAll('input')].filter(el =>
      ['text', 'email', 'tel'].includes(el.type) && el.value
      && !autocompleteOf(el).includes('one-time-code')
      && precedes(el));
    const masked = all.filter(el => isMaskedUsername(el) && precedes(el));
    const usernameEl = before.find(el => /\b(username|email)\b/.test(autocompleteOf(el)))
      || masked[masked.length - 1] || before[before.length - 1];
    const fields = { username: usernameEl?.value || '', password: password.value };
    if (!isNewPassword(password)) {
      const extras = extraFields(password, usernameEl, { filled: true }).map(({ el, desc, label }) => ({
        label, value: controlValue(el), kind: desc.tag === 'select' ? 'text' : 'hidden', fill: desc,
      }));
      if (extras.length) fields.extras = extras;
    }
    return fields;
  }

  // ── Extra sign-in fields ──────────────────────────────────────────────────────
  // What a sign-in asks besides the username and password (a document type,
  // a customer number): saved with the login, filled with it. Each is
  // described to the background by `desc` ({ tag, type, name?, id?, ac?,
  // label? }) — never its value when filling: the background matches.
  const EXTRA_INPUT_TYPES = ['text', 'email', 'tel', 'number'];
  const NOT_EXTRA = /otp|code|token|2fa|mfa|captcha|csrf|xsrf|nonce/i;
  // Ids a framework made up (React's :r3:, mui-12, Math.random()'s base 36):
  // they change on every load, so they don't identify the control.
  const generatedId = id => /^:|:$|^(mui|react|radix|headlessui|ember|input|field|id)[-_:]?\d+$|[0-9a-f]{8,}|\d{4,}/i.test(id)
    || (/^[a-z0-9]{8,}$/i.test(id) && /\d.*\d/.test(id) && /[a-z]/i.test(id));

  // A native control a web component shows its own way (BBVA's Lit fields):
  // in the light DOM under the component, slotted, the component carrying
  // the same name. The control itself may be invisible (opacity 0): the
  // component is what's on screen. (`:defined`: the content script's world
  // has no customElements registry to ask.)
  const slottedHost = el => {
    const control = el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && EXTRA_INPUT_TYPES.includes(el.type));
    if (!control || !el.getAttribute('slot') || el.disabled || !el.name) return null;
    const host = el.parentElement;
    if (!host || !host.localName.includes('-') || !host.matches(':defined')) return null;
    return host.getAttribute('name') === el.name && isShown(host) ? host : null;
  };
  // The custom element a control is slotted into (or null).
  const slotParent = el => (el.getAttribute('slot') && el.parentElement?.localName.includes('-') ? el.parentElement : null);
  // Big enough to be seen (≥ 16×16) and on screen: filling a slotted
  // control asks this of its component — a 2×2 one is no visible field.
  const seenOnScreen = el => {
    const r = el.getBoundingClientRect();
    return r.width >= 16 && r.height >= 16
      && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
  };
  // Payment data is never an extra sign-in field (a login inside a checkout).
  const PAYMENT_WORD = /card|cvv|cvc|csc|iban|expir/i;
  const isPaymentControl = (el, label) => autocompleteOf(el).split(/\s+/).some(t => t.startsWith('cc-'))
    || PAYMENT_WORD.test(`${el.name || ''} ${el.id || ''} ${label}`);

  const cleanLabel = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/[\s:*]+$/, '').slice(0, 60).trim();
  const readableName = s => (s && !generatedId(s) && /[a-z]{2}/i.test(s)
    ? s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ') : '');
  function controlLabel(el, host) {
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    const chain = [host?.getAttribute('label'), host?.getAttribute('aria-label'), el.labels?.[0]?.textContent,
      el.getAttribute('aria-label'), labelledBy, el.getAttribute('placeholder'), readableName(el.name), readableName(el.id)];
    for (const s of chain) { const label = cleanLabel(s); if (label) return label; }
    return '';
  }

  // A select's chosen option (its text), an input's value.
  const normText = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const controlValue = el => (el instanceof HTMLSelectElement
    ? (el.selectedOptions[0]?.textContent || '').trim()
    : el.value.trim());
  // A select still on its default option (the one marked selected, else the first).
  const atDefault = sel => {
    const def = [...sel.options].find(o => o.defaultSelected) || sel.options[0];
    return !sel.selectedOptions[0] || sel.selectedOptions[0] === def;
  };

  function descOf(el, label) {
    const select = el instanceof HTMLSelectElement;
    const desc = { tag: select ? 'select' : 'input', type: select ? 'select-one' : el.type };
    if (el.name && el.name.length <= 100) desc.name = el.name;
    else if (!el.name && el.id && el.id.length <= 100 && !generatedId(el.id)) desc.id = el.id;
    const ac = autocompleteOf(el).trim();
    if (ac && ac !== 'on' && ac !== 'off' && ac.length <= 60) desc.ac = ac;
    if (label) desc.label = label;
    return desc;
  }

  // Where a sign-in's extra fields are: the password's form, else (no form)
  // the nearest container (up to 5 levels) holding the username field and
  // no search box.
  function extrasScope(anchor, username) {
    if (anchor.form) return anchor.form;
    if (!username) return null;
    for (let node = anchor.parentElement, i = 0; node && i < 5; i++, node = node.parentElement) {
      if (!node.contains(username)) continue;
      return [...node.querySelectorAll('input')].some(isSearchField) ? null : node;
    }
    return null;
  }

  // The extra controls around a sign-in's `anchor` (its password field, or a
  // username step's field): `filled` — the ones the user filled, to save (a
  // select only off its default) —, else the empty ones, to fill (≤ 20).
  // More than 8 filled is no sign-in (a checkout, a profile form): none is
  // saved. Never the username or a password, a hidden field, a checkbox, a
  // radio, a search box, a code / token / captcha, payment data or a
  // framework's own field; in a form, only that form's own controls. A
  // control slotted into a component is filled only while that component
  // is big enough to see and on screen.
  // → [{ el, desc, label }]
  function extraFields(anchor, username, { filled }) {
    const scope = extrasScope(anchor, username);
    if (!scope) return [];
    const out = [];
    for (const el of scope.querySelectorAll('input, select')) {
      if (el === anchor || el === username) continue;
      if (anchor.form && el.form !== anchor.form) continue;
      const select = el instanceof HTMLSelectElement;
      if (select ? el.multiple : !EXTRA_INPUT_TYPES.includes(el.type)) continue;
      if (el.readOnly || !(isVisible(el) || slottedHost(el))) continue;
      if (!filled && slotParent(el) && !seenOnScreen(slotParent(el))) continue;
      if (!select && (isSearchField(el) || autocompleteOf(el).includes('one-time-code'))) continue;
      const host = slottedHost(el);
      const label = controlLabel(el, host);
      if (!label || /^__/.test(el.name || '') || NOT_EXTRA.test(`${el.name} ${el.id} ${label} ${autocompleteOf(el)}`)
        || /security\s*code/i.test(label) || isPaymentControl(el, label)) continue;
      if (filled) {
        const value = controlValue(el);
        if (!value || value.length > 256 || /[\r\n]/.test(value) || (select && atDefault(el))) continue;
      } else if (select ? !atDefault(el) : el.value !== '') continue;
      out.push({ el, desc: descOf(el, label), label });
      if (filled ? out.length > 8 : out.length >= 20) break;
    }
    return filled && out.length > 8 ? [] : out;
  }

  // Picks the option reading `text` (its text, else its value). Never
  // fillInputValue on a select (an input's setter). → false: no such option.
  function fillSelect(el, text) {
    const opts = [...el.options];
    const opt = opts.find(o => normText(o.textContent) === normText(text)) || opts.find(o => o.value === text);
    if (!opt) return false;
    if (opt.selected) return true;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  const selectReads = (el, text) => {
    const opt = el.selectedOptions[0];
    return !!opt && (normText(opt.textContent) === normText(text) || opt.value === text);
  };

  // Two frames for a component to take a picked option before the next
  // field (at most 150 ms: a background tab draws no frames).
  const twoFrames = () => new Promise(res => {
    const t = setTimeout(res, 150);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); res(); }));
  });

  // Fills the background's `extras` ([{ index, value }] into `targets`):
  // selects first, then typed fields. → what was filled, for the pre-submit
  // check: [{ el, label, ok() }] (ok() false: not filled, or reverted).
  async function fillExtras(targets, extras) {
    const done = [];
    const list = (Array.isArray(extras) ? extras : [])
      .filter(x => Number.isInteger(x?.index) && targets[x.index] && typeof x.value === 'string' && x.value)
      .map(x => ({ ...targets[x.index], value: x.value }));
    const selects = list.filter(t => t.el instanceof HTMLSelectElement);
    for (const { el, label, value } of selects) {
      const filled = fillSelect(el, value);
      done.push({ el, label, ok: () => filled && el.isConnected && selectReads(el, value) });
    }
    if (selects.length) await twoFrames();
    for (const { el, label, value } of list.filter(t => !(t.el instanceof HTMLSelectElement))) {
      fillInputValue(el, value);
      done.push({ el, label, ok: () => el.isConnected && el.value !== '' });
    }
    return done;
  }
  // A filled username / password field, for the same check.
  const filledCheck = (el, label) => ({ el, label: controlLabel(el) || label, ok: () => el.isConnected && el.value !== '' });

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
  // (A read-only sign-in password or a masked username counts.)
  const hasVisiblePassword = root => [...root.querySelectorAll('input[type="password"]')].some(isPasswordShown);

  // The username step's value, and its extra fields: one filled field that
  // looks like a username; any other filled one must be an extra field.
  function findUsernameStep(root = document) {
    if (hasVisiblePassword(root)) return null;
    const filled = [...root.querySelectorAll('input')].filter(el =>
      ['text', 'email', 'tel'].includes(el.type) && el.value.trim() && isVisible(el)
      && !autocompleteOf(el).includes('one-time-code'));
    const looksLikeUsername = el => /\b(username|email)\b/.test(autocompleteOf(el)) || el.type === 'email'
      || USERNAME_HINT.test(`${el.name} ${el.id}`);
    if (filled.length === 1) {
      if (!looksLikeUsername(filled[0])) return null;
    } else if (filled.filter(looksLikeUsername).length !== 1) return null;
    const el = filled.length === 1 ? filled[0] : filled.find(looksLikeUsername);
    const extras = extraFields(el, el, { filled: true });
    if (filled.some(f => f !== el && !extras.some(x => x.el === f))) return null;
    return {
      username: el.value.trim(),
      extras: extras.map(({ el: x, desc, label }) => ({ label, value: controlValue(x), kind: desc.tag === 'select' ? 'text' : 'hidden', fill: desc })),
    };
  }

  function captureUsername(root) {
    if (!chrome.runtime?.id) return;
    const step = findUsernameStep(root);
    if (!step) return;
    chrome.runtime.sendMessage({ action: 'vaultCaptureUsername', username: step.username, ...(step.extras.length ? { extras: step.extras } : {}) }).catch(() => {});
  }

  // A click counts as submitting a sign-in only on a submit button (a
  // <button> with no type is one, inside a form) or a control that reads
  // like one — an <input type="button" value="Login"> too (xStation, many
  // Angular apps) — never Cancel, Back, Show/Hide password, Forgot password.
  const NOT_SUBMIT = /\b(cancel|back|close|show|hide|reveal|forgot|reset|clear|cancelar|volver|cerrar|mostrar|ocultar|olvid\w*)\b/i;
  const LOOKS_SUBMIT = /\b(sign\s*in|log\s*in|login|sign\s*up|register|continue|next|submit|enter|go|verify|ingresar|iniciar|acceder|entrar|continuar|siguiente|con[eé]ct(?:ate|ar|arse)|identif[ií]ca(?:te|rse)|connexion|se\s+connecter)\b/i;
  function isSubmitControl(btn) {
    const text = [btn.textContent, btn.value, btn.getAttribute('aria-label'), btn.title].filter(Boolean).join(' ');
    if (NOT_SUBMIT.test(text)) return false;
    if (btn.form && btn.type === 'submit') return true;
    // A web component's submit button (<bbva-button type=submit>) in a form.
    if (btn.localName.includes('-') && btn.getAttribute('type') === 'submit' && btn.closest('form')) return true;
    return LOOKS_SUBMIT.test(text);
  }

  document.addEventListener('submit', e => {
    const scope = e.target instanceof HTMLFormElement ? e.target : document;
    if (hasVisiblePassword(scope)) capture(scope); else captureUsername(scope);
  }, true);
  document.addEventListener('click', e => {
    if (e.target.closest?.(`#${OVERLAY_ID}, #${SAVE_ID}, #${DROP_ID}, #otpilot-password-suggest, .${BADGE_CLASS}`)) return; // our own UI
    const btn = e.target.closest?.('button, input[type="submit"], input[type="button"], [role="button"], [type="submit"]');
    if (!btn || !isSubmitControl(btn)) return;
    const scope = btn.form || btn.closest('form') || document;
    if (hasVisiblePassword(scope)) capture(scope); else captureUsername(scope);
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    if (e.target.type === 'password') capture(e.target.form || document);
    else if (['text', 'email', 'tel'].includes(e.target.type)) captureUsername(e.target.form || document);
  }, true);

  const passwordFormShowing = () => [...document.querySelectorAll('input[type="password"]')].some(isPasswordShown);

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
      : offer.extrasOnly ? `Update <b>${esc(offer.name || offer.host)}</b>?`
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
    // The extra fields it saves (labels only; the page's text, so textContent).
    const extraLabels = (Array.isArray(offer.extras) ? offer.extras : []).filter(l => typeof l === 'string' && l);
    if (extraLabels.length) {
      const also = document.createElement('div');
      also.className = 'otpilot-save-extras';
      Object.assign(also.style, { color: 'var(--ink-3, #94a3b8)', fontSize: '12px', margin: '-4px 0 10px' });
      also.textContent = `${offer.extrasOnly ? 'Saves' : 'Also saves'}: ${extraLabels.join(', ')}`;
      body.appendChild(also);
    }

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
  const BADGE = 22;
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

  // `explicit`: the badge was clicked — say so when the site has no login
  // (focusing a field opens only where there is one).
  async function openLogins(field, explicit = false) {
    if (!chrome.runtime?.id) return;
    closeDropdown();
    const seq = _openSeq;
    _pendingField = field;
    const res = await loginsForPage();
    if (seq !== _openSeq) return; // closed or superseded meanwhile
    _pendingField = null;
    _pageLogins = res.state === 'setup' ? null : res;
    if (!_pageLogins || !field.isConnected) return;
    const shown = forFields(explicit ? res : autoOffered(res));
    if (!shown.logins.length && !explicit) return;
    const el = makeAnchored(DROP_ID, field);
    render(el, shown, closeDropdown, explicit ? r => forFields(r) : r => forFields(autoOffered(r)));
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
      position: 'fixed', zIndex: '2147483647', width: `${BADGE + 4}px`, height: `${BADGE + 4}px`, padding: '2px',
      margin: '0', border: '0', background: 'transparent', cursor: 'pointer', lineHeight: '0', opacity: '.9',
    });
    isolate(b, true);
    b.addEventListener('click', trusted(() => {
      if (_anchor?.field === field) { closeDropdown(); return; }
      open();
    }));
    return b;
  }

  // Something drawn over the field at (x, y) that isn't the field, the page
  // around it or ours: another password manager's icon (LastPass, 1Password,
  // Bitwarden…), or the site's own (show password, clear).
  function coveredAt(field, x, y) {
    let stack;
    try { stack = document.elementsFromPoint(x, y); } catch { return null; }
    for (const el of stack) {
      if (el === field || el.closest?.(`.${BADGE_CLASS}, [data-otpilot-ui]`)) continue;
      if (el.contains(field)) return null; // down to the page under the field: nothing on top
      // An icon is small: a floating label or a wrapper drawn over the
      // whole field isn't one (it's skipped, and what's under it checked).
      const o = el.getBoundingClientRect();
      if (o.width > 64 || o.height > 64) continue;
      return el;
    }
    return null;
  }

  // Inside the field's right edge, sized to fit it (hidden on a field too
  // small or scrolled away). Where another icon sits there (a password
  // manager's, the site's eye), it moves left, beside it.
  function placeBadge(b, field) {
    const r = field.getBoundingClientRect();
    const size = Math.min(BADGE + 4, Math.floor(r.height - 6));
    const show = size >= 14 && r.width > size * 4 && isPasswordShown(field);
    b.style.display = show ? '' : 'none';
    if (!show) return;
    const top = r.top + (r.height - size) / 2;
    let left = r.right - size - 6;
    // Sampled across the badge's whole area (a small icon may sit under
    // its right part only).
    const coveredIn = l => {
      for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.25, 0.5, 0.75]) {
        const o = coveredAt(field, l + size * fx, top + size * fy);
        if (o) return o;
      }
      return null;
    };
    for (let i = 0; i < 3 && left > r.left + r.width / 2; i++) {
      const other = coveredIn(left);
      if (!other) break;
      left = Math.min(left, other.getBoundingClientRect().left) - size - 4;
    }
    Object.assign(b.style, {
      width: `${size}px`, height: `${size}px`, padding: `${Math.max(1, Math.round(size / 10))}px`,
      left: `${left}px`, top: `${top}px`,
    });
    const svg = b.firstElementChild;
    if (svg) { svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); }
  }

  // The fields that get a badge now: the sign-in fields (or a two-step
  // sign-in's username field) once the vault is set up — with no login for
  // the site, its dropdown says so —, and every visible new-password field.
  function badgeTargets() {
    const out = new Map();
    const login = _pageLogins ? findFillFields() : null;
    for (const f of [login?.username, login?.password]) if (f) out.set(f, ['login', () => openLogins(f, true)]);
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
    if (_pageLogins && !autoOffered(_pageLogins).logins.length) return;
    const login = findFillFields();
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
  const launchFill = (step, targets = []) => chrome.runtime.sendMessage({
    action: 'vaultLaunchFill', step, ...(targets.length ? { fields: targets.map(t => t.desc) } : {}),
  }).catch(() => null);

  // The username field of a page asking only for it (no password yet), and
  // the button that submits it — only with evidence it's a sign-in step,
  // never a newsletter's email box: autocomplete="username", or a submitting
  // action that reads like signing in. That same button is the one clicked.
  const SIGN_IN_BUTTON = /\b(sign\s*in|log\s*in|login|continue|next|iniciar|ingresar|acceder|entrar|continuar|siguiente|con[eé]ct(?:ate|ar|arse)|identif[ií]ca(?:te|rse)|connexion|se\s+connecter)\b/i;
  const SIGN_IN_SUBMIT = /\b(sign\s*in|log\s*in|login|continue|next|submit|verify|confirm|iniciar|ingresar|acceder|entrar|continuar|siguiente|enviar|verificar|con[eé]ct(?:ate|ar|arse)|identif[ií]ca(?:te|rse)|connexion|se\s+connecter)\b/i;
  const NOT_SIGN_IN = /\b(subscribe|newsletter|sign\s*up|register|join|suscrib\w*|registr\w*)\b/i;
  const buttonLabel = b => [b.textContent, b.value, b.getAttribute('aria-label')].filter(Boolean).join(' ');
  const readsSignIn = b => !!b && isVisible(b) && SIGN_IN_BUTTON.test(buttonLabel(b))
    && !NOT_SIGN_IN.test(buttonLabel(b)) && !NOT_SUBMIT.test(buttonLabel(b));

  // The nearest visible button `accepts` takes for a form-less `field`,
  // within its sign-in panel: the containers around it, widening while they
  // hold no other empty input than the sign-in's own (`own`) — a container
  // that also holds an empty search box or newsletter field is past the
  // panel, and so is a search box even with a query in it; an already-filled
  // field (an organization, a remembered tenant) belongs to the sign-in.
  // Buttons of a form never count.
  const FIELD_TYPES = ['text', 'email', 'tel', 'password', 'search', 'number', 'url'];
  // A search box is never part of a sign-in, filled or not.
  const isSearchField = el => el.type === 'search' || el.getAttribute('role') === 'searchbox'
    || /^(q|query|s|search)$|search/i.test(`${el.name || ''} ${el.id || ''}`.trim());
  function buttonNear(field, accepts, own = [field], maxLevels = Infinity) {
    const other = el => !el.form && !own.includes(el) && FIELD_TYPES.includes(el.type) && isVisible(el)
      && (!el.value || isSearchField(el));
    for (let scope = field.parentElement, level = 0; scope && scope !== document.documentElement && level < maxLevels; scope = scope.parentElement, level++) {
      if ([...scope.querySelectorAll('input')].some(other)) break;
      const hit = [...scope.querySelectorAll('button, input[type="submit"], input[type="button"]')]
        .find(b => !b.form && isVisible(b) && accepts(b));
      if (hit) return hit;
    }
    return null;
  }

  // The button that submits a username step: its form's submit button, else
  // (no form) the nearest one that reads like signing in — never a
  // "Sign up" that happens to come first.
  // A form with no submit button (its "Login" is an <input type="button">
  // or a <button type="button"> run by the page's script): the visible one
  // that reads like `accepts`. Never requestSubmit() there — such a form
  // usually has no action, so submitting it just reloads the page.
  const formButton = (form, accepts) => [...form.querySelectorAll('button, input[type="button"], [role="button"]')]
    .find(b => isVisible(b) && accepts(b));
  const signsInToSubmit = b => SIGN_IN_SUBMIT.test(buttonLabel(b)) && !NOT_SIGN_IN.test(buttonLabel(b)) && !NOT_SUBMIT.test(buttonLabel(b));

  const signInButtonFor = field => (field.form
    ? findSubmitButton(field.form) || formButton(field.form, readsSignIn)
    : buttonNear(field, readsSignIn));

  // The button that submits a sign-in form: its form's submit button, else
  // the nearest submit-looking control (Sign in, Continue, Submit, Verify…)
  // that isn't a sign-up.
  function passwordButtonFor(field) {
    if (field.form) return findSubmitButton(field.form) || formButton(field.form, signsInToSubmit);
    const login = findLoginFields();
    const own = [field, login?.username, login?.password].filter(Boolean);
    // Without a form the button has to say it signs in: never a "Go" or
    // "Search" that happens to be nearer.
    return buttonNear(field, signsInToSubmit, own);
  }

  function findUsernameOnlyField() {
    if (hasVisiblePassword(document)) return null;
    const inputs = [...document.querySelectorAll('input')].filter(el =>
      ['text', 'email', 'tel'].includes(el.type) && isVisible(el)
      && !autocompleteOf(el).includes('one-time-code'));
    for (const el of inputs) {
      const button = signInButtonFor(el);
      if (autocompleteOf(el).split(/\s+/).includes('username')) return { field: el, button };
      if ((el.type === 'email' || USERNAME_HINT.test(`${el.name} ${el.id}`)) && readsSignIn(button)) return { field: el, button };
    }
    return null;
  }

  // The launched login's username in that field: another one the site
  // remembered is replaced (the user asked to sign in as this login).
  function putUsername(field, username) {
    if (field.value.trim().toLowerCase() !== String(username).trim().toLowerCase()) fillInputValue(field, username);
  }

  // `findButton` runs when the click is due: the page may have replaced the
  // button while reacting to the fill.
  // `filled`: what this fill wrote ([{ el, label, ok() }]); re-read right
  // before the click — one not filled, or that the page reverted, means the
  // user checks it and signs in themselves.
  async function submitAfterFill(field, findButton, filled = []) {
    if (await isNoAutoSubmitHost(location.hostname.toLowerCase())) return;
    setTimeout(() => {
      if (!chrome.runtime?.id) return;
      const wrong = filled.find(f => !f.ok());
      if (wrong) { showToast(`Check ${wrong.label} before signing in`, false); return; }
      const button = field.isConnected ? findButton(field) : null;
      if (button?.localName.includes('-')) clickComponentSubmit(button, filled);
      else if (button) button.click();
      else if (field.form) field.form.requestSubmit?.();
    }, 300);
  }

  // A web component's submit button (<bbva-button type=submit>): one click
  // on it. A second sign-in must never follow, so the button in its (open)
  // shadow root — its submit button, else its first — is clicked once more
  // only when, a second later, nothing shows the first click did anything:
  // no submit event, no page leaving (pagehide / beforeunload), no request
  // the page completed (fetch / XHR resource entries, seen by a
  // PerformanceObserver: the page's resource-timing buffer may be full,
  // which drops new entries from getEntriesByType but not from observers;
  // without PerformanceObserver there is no retry), no change to the
  // page's light DOM outside our own UI, and the same form still there with
  // what was filled still in it. At most one retry per fill: a newer fill
  // drops a retry still waiting (`_componentClick`).
  // Never requestSubmit() here: such a form may have no action and use GET,
  // which would put the password in the URL.
  let _componentClick = null;
  const isOurNode = n => {
    const el = n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement;
    return !!el && (el.id?.startsWith('otpilot-') || !!el.closest('[data-otpilot-ui]'));
  };
  const pageMutation = records => records.some(r => (r.type === 'childList'
    ? [...r.addedNodes, ...r.removedNodes].some(n => !isOurNode(n))
    : !isOurNode(r.target)));
  function clickComponentSubmit(host, filled = []) {
    const form = host.closest('form');
    const attempt = { busy: false };
    _componentClick = attempt;
    const busy = () => { attempt.busy = true; };
    const isRequest = e => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest';
    let requests = null;
    try {
      requests = new PerformanceObserver(list => { if (list.getEntries().some(isRequest)) busy(); });
      requests.observe({ type: 'resource' });
    } catch { requests = null; }
    const watch = new MutationObserver(records => { if (pageMutation(records)) busy(); });
    form?.addEventListener('submit', busy, true);
    window.addEventListener('pagehide', busy, true);
    window.addEventListener('beforeunload', busy, true);
    const stop = () => {
      watch.disconnect();
      if (requests) {
        if (requests.takeRecords().some(isRequest)) busy();
        requests.disconnect();
      }
      form?.removeEventListener('submit', busy, true);
      window.removeEventListener('pagehide', busy, true);
      window.removeEventListener('beforeunload', busy, true);
    };
    watch.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    host.click();
    if (!form) { stop(); return; }
    setTimeout(() => {
      if (pageMutation(watch.takeRecords())) busy();
      stop();
      if (_componentClick !== attempt) return; // a newer fill took over
      _componentClick = null;
      if (attempt.busy || !requests || !chrome.runtime?.id) return;
      if (!form.isConnected || !host.isConnected || host.closest('form') !== form) return;
      if (filled.some(f => !f.ok() || (!form.contains(f.el) && f.el.form !== form))) return;
      const root = host.shadowRoot;
      const inner = root?.querySelector('button[type="submit"], button:not([type])') || root?.querySelector('button');
      if (inner) inner.click();
    }, 1000);
  }

  async function continueLaunch() {
    if (_launch === false || !chrome.runtime?.id) return;
    if (_launch === null) _launch = !!(await launchFill('probe'))?.ok;
    if (!_launch) return;
    const login = findLoginFields();
    if (login && _launchStep !== 'password') {
      _launchStep = 'password';
      const targets = extraFields(login.password, login.username, { filled: false });
      const res = await launchFill('password', targets);
      if (!res?.ok) { _launch = false; return; }
      _launch = false; // the launch ends with the password
      _filling = true;
      let done;
      try {
        done = await fillExtras(targets, res.extras);
        if (login.username && res.username) { putUsername(login.username, res.username); done.push(filledCheck(login.username, 'the username')); }
        fillInputValue(login.password, res.password);
        done.push(filledCheck(login.password, 'the password'));
      } finally { _filling = false; }
      submitAfterFill(login.password, passwordButtonFor, done);
      return;
    }
    const step = !login && _launchStep === '' && findUsernameOnlyField();
    if (step) {
      const { field: userField } = step;
      _launchStep = 'username';
      const targets = extraFields(userField, userField, { filled: false });
      const res = await launchFill('username', targets);
      if (!res?.ok) return;
      _filling = true;
      let done;
      try {
        done = await fillExtras(targets, res.extras);
        putUsername(userField, res.username);
        done.push(filledCheck(userField, 'the username'));
      } finally { _filling = false; }
      submitAfterFill(userField, signInButtonFor, done);
    }
  }

  // Sign-in forms often appear after load (SPAs, modals).
  let timer;
  const observer = new MutationObserver(records => {
    // A read-only password field's value when it first shows (see
    // isReadonlySignInPassword): right away, before the page can fill it.
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        if (n.matches('input[type="password"]')) { if (n.readOnly) noteReadonly(n); }
        else if (n.firstElementChild) for (const el of n.querySelectorAll('input[type="password"]')) if (el.readOnly) noteReadonly(el);
      }
    }
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
  noteReadonlyPasswords();
  check();
  offerSave();
  continueLaunch();
})();
