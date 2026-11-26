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
// the background, which re-checks the host from the sender. Top frame, or a
// same-site sign-in frame the background loaded it into (frameForms.js:
// `__otpilotFrameForms`), whose save offers show on the top page.
// Sign-up and change-password fields (autocomplete="new-password") are left
// alone.
(() => {
  const IN_FRAME = window.top !== window;
  if (IN_FRAME && !globalThis.__otpilotFrameForms) return;
  if (globalThis.__otpilotFormsLoaded) return;
  globalThis.__otpilotFormsLoaded = true;

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
  // BBVA renders both its password-type fields read-only for a moment
  // (an anti-autofill trick, lifted ~1 s later): a read-only field still
  // empty when first seen counts here — otherwise "Usuario" is taken for a
  // read-only sign-in password in that window, and a pick or a launch then
  // puts the password into it. One holding a value at first sight is the
  // page's display, as for isReadonlySignInPassword.
  const isSignInShown = el => {
    if (isVisible(el)) return true;
    if (!el.readOnly || !isShown(el)) return false;
    noteReadonly(el);
    return !(el.value && _readonlyPrefilled.has(el));
  };
  const isMaskedUsername = el => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'password' || !isSignInShown(el) || !readsLikeUsername(el)) return false;
    const passwords = root => [...root.querySelectorAll('input[type="password"]')].filter(isSignInShown);
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
      if (fields.username && res.username) { fillInputValue(fields.username, res.username); done.push(filledCheck(fields.username, res.username, 'your username', { username: true })); }
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
      if (fields.password) { fillInputValue(fields.password, res.password); done.push(filledCheck(fields.password, res.password, 'your password')); }
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
    // (A masked security answer is no password.)
    const all = [...root.querySelectorAll('input[type="password"]')].filter(el => el.value && isPasswordShown(el) && !isAnswerControl(el));
    const filled = all.filter(el => !isMaskedUsername(el));
    if (!filled.length) return null;
    const password = filled.find(isNewPassword) || filled[0];
    const scope = password.form || document;
    const precedes = el => el.compareDocumentPosition(filled[0]) & Node.DOCUMENT_POSITION_FOLLOWING;
    const before = [...scope.querySelectorAll('input')].filter(el =>
      ['text', 'email', 'tel'].includes(el.type) && el.value
      && !autocompleteOf(el).includes('one-time-code')
      && !isQuestionOrAnswer(el)
      && precedes(el));
    const masked = all.filter(el => isMaskedUsername(el) && precedes(el));
    const usernameEl = before.find(el => /\b(username|email)\b/.test(autocompleteOf(el)))
      || masked[masked.length - 1] || before[before.length - 1];
    const fields = { username: usernameEl?.value || '', password: password.value };
    if (!isNewPassword(password)) {
      const extras = extraFields(password, usernameEl, { filled: true }).map(extraOf);
      if (extras.length) fields.extras = extras;
    }
    const questions = securityQuestions(password);
    if (questions.length) fields.questions = questions;
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
  // BBVA's components: "_" + Math.random() in base 36 (_iimft4p9kg,
  // _2poajcna2x, new on every load): a digit followed by a letter, so a
  // word with a trailing number (_username1, _password2) stays an id.
  // Kept equal to background.js generatedId.
  const generatedId = id => /^:|:$|^(mui|react|radix|headlessui|ember|input|field|id)[-_:]?\d+$|[0-9a-f]{8,}|\d{4,}/i.test(id)
    || (/^[a-z0-9]{8,}$/i.test(id) && /\d.*\d/.test(id) && /[a-z]/i.test(id))
    || (/^_[a-z0-9]{8,}$/i.test(id) && /\d[a-z]/i.test(id));

  // A native control a web component shows its own way (BBVA's Lit fields):
  // in the light DOM under the component, slotted, the component carrying
  // the same name. The control itself may be invisible (opacity 0): the
  // component is what's on screen. (`:defined`: the content script's world
  // has no customElements registry to ask.)
  const slottedHost = el => {
    const control = el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && EXTRA_INPUT_TYPES.includes(el.type));
    if (!control || el.disabled || !el.name) return null;
    const host = slotParent(el);
    if (!host || !host.matches(':defined')) return null;
    return host.getAttribute('name') === el.name && isShown(host) ? host : null;
  };
  // The custom element a control (with a `slot` attribute) belongs to, or
  // null: the one it's slotted into, or — a form-associated component moves
  // its native control out of its shadow root to just before itself (BBVA's
  // bbva-form-select-sph: `<select slot="_select" name=…>` then the
  // component) — the next sibling carrying the same name.
  const slotParent = el => {
    if (!el.getAttribute('slot')) return null;
    if (el.parentElement?.localName.includes('-')) return el.parentElement;
    const next = el.nextElementSibling;
    return next?.localName.includes('-') && el.name && next.getAttribute('name') === el.name ? next : null;
  };

  // A select component that keeps its list in an `items` attribute (JSON:
  // BBVA's [{ key, value, text, description, selected }]) and gives the
  // form only a placeholder select holding the chosen key ("0", "2"): the
  // key ↔ label map, read from the attribute (never a page property: this
  // is the isolated world). Used only when the select can't tell the
  // labels itself (≤ 1 option, or fewer options than the list) and holds
  // one of the keys. Key: `value` (what the component's select gets), else
  // `key` / `id`; label: `text`, else `label` / `name` / `description` —
  // each present on every item and unique. Default: the item marked
  // `selected` / `default`, else the first. → { entries: [{ key, label }],
  // def, host } or null.
  const ITEM_KEYS = ['value', 'key', 'id'];
  const ITEM_LABELS = ['text', 'label', 'name', 'description'];
  function itemsList(sel) {
    if (!(sel instanceof HTMLSelectElement)) return null;
    const host = slottedHost(sel);
    const raw = host?.getAttribute('items');
    if (!raw || raw.length > 20000) return null;
    const list = parsedItems(raw);
    if (!list) return null;
    const { entries, def } = list;
    if (sel.options.length > 1 && entries.length <= sel.options.length) return null;
    if (!entries.some(e => e.key === sel.value)) return null;
    return { entries, def, host };
  }
  // The attribute's list, parsed and checked once per attribute value (a
  // few recent ones: it's read on every capture, fill and check).
  const _itemsCache = new Map();
  function parsedItems(raw) {
    if (_itemsCache.has(raw)) return _itemsCache.get(raw);
    const list = parseItems(raw);
    if (_itemsCache.size >= 8) _itemsCache.delete(_itemsCache.keys().next().value);
    _itemsCache.set(raw, list);
    return list;
  }
  function parseItems(raw) {
    let items;
    try { items = JSON.parse(raw); } catch { return null; }
    if (!Array.isArray(items) || !items.length || items.length > 100
    || !items.every(i => i && typeof i === 'object' && !Array.isArray(i))) return null;
    const unique = vals => new Set(vals).size === vals.length;
    const keyOk = v => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) && String(v) !== '' && String(v).length <= 100;
    const keyField = ITEM_KEYS.find(k => items.every(i => keyOk(i[k])) && unique(items.map(i => String(i[k]))));
    const labelOk = v => typeof v === 'string' && !!v.trim() && v.length <= 256 && !/[\r\n]/.test(v);
    const labelField = ITEM_LABELS.find(k => items.every(i => labelOk(i[k])) && unique(items.map(i => normText(i[k]))));
    if (!keyField || !labelField) return null;
    const entries = items.map(i => Object.freeze({ key: String(i[keyField]), label: i[labelField].trim().replace(/\s+/g, ' ') }));
    const marked = items.findIndex(i => i.selected === true || i.default === true);
    return Object.freeze({ entries: Object.freeze(entries), def: entries[marked >= 0 ? marked : 0] });
  }
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

  // A select's chosen option (its text; an `items` component's: the label
  // of the key it holds), an input's value.
  const normText = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const controlValue = el => {
    if (!(el instanceof HTMLSelectElement)) return el.value.trim();
    const list = itemsList(el);
    if (list) return list.entries.find(e => e.key === el.value)?.label || '';
    return (el.selectedOptions[0]?.textContent || '').trim();
  };
  // A select still on its default option (the one marked selected, else the
  // first; an `items` component's: its default item's key).
  const atDefault = sel => {
    const list = itemsList(sel);
    if (list) return sel.value === list.def.key;
    const def = [...sel.options].find(o => o.defaultSelected) || sel.options[0];
    return !sel.selectedOptions[0] || sel.selectedOptions[0] === def;
  };

  function descOf(el, label) {
    const select = el instanceof HTMLSelectElement;
    const desc = { tag: select ? 'select' : 'input', type: select ? 'select-one' : el.type };
    if (el.name && el.name.length <= 100) desc.name = el.name;
    // A control slotted into a component gets its id from that component
    // (made up on each render): only its own name, or its label, identify it.
    else if (!el.name && el.id && el.id.length <= 100 && !generatedId(el.id) && !slotParent(el)) desc.id = el.id;
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
  // username step's field): `filled` — the ones the user filled, to save; a
  // select on its default option comes `atDefault` (the background only
  // takes it to put a saved field back to the default) —, else the empty
  // ones, to fill (≤ 20). More than 8 filled (defaults not counted) is no
  // sign-in (a checkout, a profile form): none is saved. Never the username or a password, a hidden field, a checkbox, a
  // radio, a search box, a code / token / captcha, payment data or a
  // framework's own field; in a form, only that form's own controls. A
  // control slotted into a component is filled only while that component
  // is big enough to see and on screen.
  // → [{ el, desc, label }]
  function extraFields(anchor, username, { filled }) {
    const scope = extrasScope(anchor, username);
    if (!scope) return [];
    const out = [];
    let changed = 0;
    for (const el of scope.querySelectorAll('input, select')) {
      if (el === anchor || el === username) continue;
      if (anchor.form && el.form !== anchor.form) continue;
      const select = el instanceof HTMLSelectElement;
      if (select ? el.multiple : !EXTRA_INPUT_TYPES.includes(el.type)) continue;
      if (el.readOnly || !(isVisible(el) || slottedHost(el))) continue;
      if (isQuestionOrAnswer(el)) continue;
      if (!filled && slotParent(el) && !seenOnScreen(slotParent(el))) continue;
      if (!select && (isSearchField(el) || autocompleteOf(el).includes('one-time-code'))) continue;
      const host = slottedHost(el);
      const label = controlLabel(el, host);
      // (A made-up id is random letters: "_x2fa…" says nothing.)
      const ownId = generatedId(el.id) ? '' : el.id;
      if (!label || /^__/.test(el.name || '') || NOT_EXTRA.test(`${el.name} ${ownId} ${label} ${autocompleteOf(el)}`)
        || /security\s*code/i.test(label) || isPaymentControl(el, label)) continue;
      if (filled) {
        const value = controlValue(el);
        if (!value || value.length > 256 || /[\r\n]/.test(value)) continue;
      } else if (select ? !atDefault(el) : el.value !== '') continue;
      const entry = { el, desc: descOf(el, label), label };
      if (filled && select && atDefault(el)) entry.atDefault = true;
      else changed++;
      out.push(entry);
      if ((filled && changed > 8) || out.length >= 20) break;
    }
    return filled && changed > 8 ? [] : out;
  }
  // A captured extra, as the background takes it.
  const extraOf = ({ el, desc, label, atDefault: def }) => ({
    label, value: controlValue(el), kind: desc.tag === 'select' ? 'text' : 'hidden', fill: desc, ...(def ? { atDefault: true } : {}),
  });

  // ── Security questions ───────────────────────────────────────────────────────────
  // A form that sets a password often sets security questions too (a picked
  // question, then its answer): saved with the login as `format: 'question'`
  // fields (the question as the label, the answer hidden). Never filled from
  // here, and never an extra field nor a password.
  const QUESTION_HINT = /question|pregunta|frage|domanda|pergunta/i;
  const ANSWER_HINT = /answer|respuesta|antwort|r[eé]ponse|risposta|resposta/i;
  const ANSWER_IS_PASSWORD = /pass|pwd|clave|contrase|senha|passwort/i;
  // A select's placeholder option: "Select a question", "-- Choose --".
  const QUESTION_PLACEHOLDER = /^\W*$|^\W*(select|choose|pick|please|seleccion|elij?[ae]|escoj?[ae]|wählen|choisi)/i;
  const MAX_QUESTIONS = 5;
  const ownText = el => `${el.name || ''} ${generatedId(el.id) ? '' : el.id} ${el.getAttribute('aria-label') || ''} ${el.labels?.[0]?.textContent || ''} ${el.getAttribute('placeholder') || ''}`;
  // ("Answer to the security question" is an answer; a select never is.)
  const isQuestionControl = el => QUESTION_HINT.test(ownText(el)) && (el instanceof HTMLSelectElement || !ANSWER_HINT.test(ownText(el)));
  const isAnswerControl = el => el instanceof HTMLInputElement && ['text', 'password'].includes(el.type)
    && ANSWER_HINT.test(ownText(el)) && !ANSWER_IS_PASSWORD.test(`${el.name || ''} ${el.id || ''} ${autocompleteOf(el)}`);
  // "What was your first pet's name?" written as an answer field's label
  // (a fixed question) — not "Answer #1" / "Security answer".
  const fixedQuestion = el => {
    const label = String(el.labels?.[0]?.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return /\?$/.test(label) && !/^(security\s*|secret\s*)?answer\b/i.test(label) && label.length <= 200 ? label : '';
  };
  const answerValue = el => el.value.trim();
  const usable = s => !!s && s.length <= 256 && !/[\r\n]/.test(s);

  // Where they are: the password's form, else the nearest container (up to
  // 6 levels) holding the password and a question control.
  function questionsScope(password) {
    if (password.form) return password.form;
    for (let node = password.parentElement, i = 0; node && i < 6; i++, node = node.parentElement) {
      if ([...node.querySelectorAll('input, select')].some(isQuestionControl)) return node;
    }
    return null;
  }

  // → [{ question, answer }] (≤ 5): a question control (a select's picked
  // option, or a typed question) followed by its answer (the next text or
  // password field before another question), or an answer field labelled by
  // its fixed question.
  function securityQuestions(password) {
    const scope = questionsScope(password);
    if (!scope) return [];
    const controls = [...scope.querySelectorAll('input, select')].filter(el =>
      (el instanceof HTMLSelectElement ? !el.multiple : ['text', 'password'].includes(el.type)) && isShown(el)
      && (!password.form || el.form === password.form));
    const out = [], used = new Set();
    for (let i = 0; i < controls.length && out.length < MAX_QUESTIONS; i++) {
      const el = controls[i];
      if (el === password || used.has(el) || !isQuestionControl(el)) continue;
      const question = el instanceof HTMLSelectElement
        ? (el.value === '' || !el.selectedOptions[0] ? '' : el.selectedOptions[0].textContent.replace(/\s+/g, ' ').trim())
        : el.value.replace(/\s+/g, ' ').trim();
      if (!question || QUESTION_PLACEHOLDER.test(question) || question.length > 200) continue;
      const answer = controls.slice(i + 1).find(c => !(c instanceof HTMLSelectElement));
      if (!answer || answer === password || isQuestionControl(answer) || answer.type === 'password' && !isAnswerControl(answer)) continue;
      if (!usable(answerValue(answer))) continue;
      used.add(el); used.add(answer);
      out.push({ question, answer: answerValue(answer) });
    }
    for (const el of controls) {
      if (out.length >= MAX_QUESTIONS) break;
      if (used.has(el) || !isAnswerControl(el)) continue;
      const question = fixedQuestion(el);
      if (question && usable(answerValue(el))) out.push({ question, answer: answerValue(el) });
    }
    return out;
  }
  // A control the security questions own: never an extra sign-in field.
  const isQuestionOrAnswer = el => isQuestionControl(el) || isAnswerControl(el);

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
  // An `items` component (itemsList): the saved label (else a key) is
  // picked the way the user picks it — a click on its open shadow root's
  // combobox, then on the option reading that label —, so the component
  // shows it and puts the key into its select itself. (Setting the native
  // select is not enough: BBVA's ignores it and keeps showing the default.)
  // The options may render a moment after the click: waited for up to
  // 500 ms; none reading the label, the list is closed again only when the
  // combobox says it's open (aria-expanded) — a second click on one that
  // didn't open would open it. DOM events only, from this world. → the key
  // the select must then hold (the pre-submit check), or null: no such label.
  async function pickInComponent(el, { entries, host }, text) {
    const entry = entries.find(e => normText(e.label) === normText(text)) || entries.find(e => e.key === text);
    if (!entry) return null;
    if (el.value === entry.key) return entry.key;
    const root = host.shadowRoot; // null when closed: nothing to click
    const trigger = root?.querySelector('[role="combobox"], [aria-haspopup="listbox"]');
    if (!trigger) return entry.key;
    trigger.click();
    const find = () => [...root.querySelectorAll('[role="option"]')].find(o => normText(o.textContent) === normText(entry.label));
    let option = find();
    for (const end = Date.now() + 500; !option && Date.now() < end;) {
      await new Promise(res => setTimeout(res, 25));
      option = find();
    }
    if (option) option.click();
    else if (trigger.getAttribute('aria-expanded') === 'true') trigger.click(); // the check catches it
    await twoFrames();
    return entry.key;
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
      const items = itemsList(el);
      if (items) {
        const key = await pickInComponent(el, items, value);
        done.push({ el, label, ok: () => key !== null && el.isConnected && el.value === key });
        continue;
      }
      const filled = fillSelect(el, value);
      done.push({ el, label, ok: () => filled && el.isConnected && selectReads(el, value) });
    }
    if (selects.length) await twoFrames();
    for (const { el, label, value } of list.filter(t => !(t.el instanceof HTMLSelectElement))) {
      fillInputValue(el, value);
      done.push({ el, label, ok: () => el.isConnected && reads(el, value) });
    }
    return done;
  }
  // The control still holds exactly what OTPilot put there: a component
  // that puts a stale value back fails it, not only one that empties it.
  // (A number field compares trimmed.)
  const reads = (el, value) => (el.type === 'number' ? el.value.trim() === String(value).trim() : el.value === value);
  // A filled username / password field, for the same check: `value` is what
  // was filled. A username compares trimmed (an email field drops the
  // spaces), and `loose` in any case too (the site's own spelling of the
  // same one may stay, putUsername). The toast names the field, never its
  // value.
  const filledCheck = (el, value, label, { username = false, loose = false } = {}) => ({
    el, label: controlLabel(el) || label,
    ok: () => {
      if (!el.isConnected) return false;
      if (!username) return el.value === value;
      const norm = v => (loose ? String(v).trim().toLowerCase() : String(v).trim());
      return norm(el.value) === norm(value);
    },
  });

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
      extras: extras.map(extraOf),
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
  // In a frame, the background asks this before offering the frame's sign-in
  // on its page (frameStillAsking): the same rule, read-only keypad PINs
  // included (one that held a value at first sight is a display).
  if (IN_FRAME) globalThis.__otpilotPasswordAsking = passwordFormShowing;

  async function offerSave() {
    if (!chrome.runtime?.id || document.getElementById(SAVE_ID) || passwordFormShowing()) return;
    // A frame's sign-in is offered on its page (a frame is too small for it),
    // once the frame's form is gone (not a rejected password).
    // Once per capture (the page asks the background what's pending).
    if (IN_FRAME) {
      _capturedAt = 0;
      chrome.runtime.sendMessage({ action: 'vaultOfferInTop' }).catch(() => {});
      return;
    }
    let offer;
    try { offer = await chrome.runtime.sendMessage({ action: 'vaultPendingLogin' }); } catch { offer = null; }
    if (!offer) { _capturedAt = 0; return; } // nothing pending: stop re-checking
    if (offer.waiting) return; // its frame still asks for the password: checked again on the next change
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
      : offer.addsSite ? `Use <b>${esc(offer.name || offer.host)}</b> to sign in here too?`
      : offer.extrasOnly ? `Update <b>${esc(offer.name || offer.host)}</b>?`
      : (offer.candidates || []).length > 1 ? `Update a login for <b>${esc(offer.host)}</b>?`
      : first && !first.username && offer.username ? `Add this username and password to <b>${esc(offer.name || offer.host)}</b>?`
      : `Update the password for <b>${esc(offer.name || offer.host)}</b>?`;

    if (offer.kind === 'locked') {
      mountUnlockFrame(body, { name: offer.host, action: 'Unlock & save', intro: `Unlock OTPilot to save your ${offer.host} login.` },
        async () => {
          let next;
          try { next = await chrome.runtime.sendMessage({ action: 'vaultPendingLogin' }); } catch { next = null; }
          if (!next || next.waiting) { closeSave(); return; }
          renderSave(el, next);
        },
        () => { resolve(offer, 'dismiss'); closeSave(); });
      return;
    }

    body.innerHTML = `<div class="otpilot-save-title" style="margin-bottom:4px;">${title}</div>`
      + (offer.username ? `<div style="color:var(--ink-3, #94a3b8);font-size:12px;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(offer.username)}</div>` : '<div style="height:6px"></div>');
    // The extra fields it saves (labels only; the page's text, so textContent).
    const extraLabels = (Array.isArray(offer.extras) ? offer.extras : []).filter(l => typeof l === 'string' && l);
    const questions = Number.isInteger(offer.questions) && offer.questions > 0 ? offer.questions : 0;
    if (questions) extraLabels.push(questions === 1 ? '1 security question' : `${questions} security questions`);
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
    body.appendChild(row);
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
  // Fills the button (the shield used to sit in a padded 22px box and read
  // much smaller than another manager's icon, LastPass's 22px square).
  const BADGE = 28;
  let _pageLogins = null;        // the last vaultLoginsForPage answer for this page's form
  let _filling = false;          // a fill is focusing fields
  const _badges = new Map();     // field -> badge
  let _anchor = null;            // { el, field } of the open dropdown

  const BADGE_SVG = `<svg width="${BADGE}" height="${BADGE}" viewBox="22 8 84 112" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
      position: 'fixed', zIndex: '2147483647', width: `${BADGE}px`, height: `${BADGE}px`, padding: '0',
      margin: '0', border: '0', background: 'transparent', cursor: 'pointer', lineHeight: '0', opacity: '.9',
      display: 'none', // hidden until placeBadge computes final position
    });
    isolate(b, true);
    b.addEventListener('click', trusted(() => {
      if (_anchor?.field === field) { closeDropdown(); return; }
      open();
    }));
    return b;
  }

  // A control small enough to be an icon or a short trailing button
  // (show password, clear) — not a floating label drawn over the whole field.
  function iconBox(o, r) {
    if (o.width < 8 || o.height < 8) return false;
    if (o.width > 120 || o.width > r.width * 0.55) return false;
    if (o.height > Math.max(96, r.height + 28)) return false;
    return Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top) >= 8;
  }

  // Something drawn over the field at (x, y) that isn't the field, the page
  // around it or ours: another password manager's icon (LastPass, 1Password,
  // Bitwarden…), or the site's own (show password, clear). Hit-testing
  // misses a control with pointer-events: none — see occupiedSpans.
  function coveredAt(field, x, y) {
    let stack;
    try { stack = document.elementsFromPoint(x, y); } catch { return null; }
    const r = field.getBoundingClientRect();
    for (const el of stack) {
      if (el === field || el.closest?.(`.${BADGE_CLASS}, [data-otpilot-ui]`)) continue;
      if (el.contains(field)) return null; // down to the page under the field: nothing on top
      if (!iconBox(el.getBoundingClientRect(), r)) continue;
      return el;
    }
    return null;
  }

  // Controls drawn in the field's wrapper (and an open shadow root): the
  // site's eye is often a sibling, not something hit-testing can see.
  function trailingCandidates(field) {
    const r = field.getBoundingClientRect();
    const out = [];
    const seen = new Set();
    const add = el => {
      if (!el || el.nodeType !== 1 || el === field || seen.has(el)) return;
      if (el.contains(field) || field.contains(el)) return;
      if (el.closest?.(`.${BADGE_CLASS}, [data-otpilot-ui]`)) return;
      seen.add(el);
      out.push(el);
    };
    const scan = (root, iconsOnly) => {
      const sel = iconsOnly
        ? 'button, [role="button"], a, svg, img, i, span, iframe'
        : 'button, [role="button"], a, svg, img, i, span, iframe, div';
      for (const el of root.querySelectorAll?.(sel) || []) add(el);
    };
    let node = field.parentElement;
    for (let i = 0; node && node !== document.body && i < 5; i++, node = node.parentElement) {
      const box = node.getBoundingClientRect();
      const tight = box.width <= r.width + 100 && box.height <= r.height + 80;
      if (tight) {
        scan(node, false);
        if (node.shadowRoot) scan(node.shadowRoot, false);
      } else {
        // Direct children only, and only those that sit on this field: a
        // query of a wide sibling is the rest of the page.
        for (const c of node.children) {
          if (c.contains(field)) continue;
          const o = c.getBoundingClientRect();
          if (o.bottom < r.top - 2 || o.top > r.bottom + 2 || o.right < r.left || o.left > r.right + 8) continue;
          add(c);
          if (o.width < 420 && o.height < 220) scan(c, true);
        }
        if (node.shadowRoot) scan(node.shadowRoot, true);
        break;
      }
    }
    const rootNode = field.getRootNode();
    if (rootNode instanceof ShadowRoot) scan(rootNode, false);
    return out;
  }

  // A ::before/::after that reads as an icon pinned to its host's right.
  function pseudoIcons(el) {
    if (!el?.getBoundingClientRect) return [];
    const host = el.getBoundingClientRect();
    const out = [];
    for (const pseudo of ['::before', '::after']) {
      const s = getComputedStyle(el, pseudo);
      if (!s || s.content === 'none' || s.content === 'normal' || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
      const w = parseFloat(s.width);
      const h = parseFloat(s.height);
      if (!(w >= 8 && w <= 80 && h >= 8 && h <= 96)) continue;
      if (s.position !== 'absolute' && s.position !== 'fixed') continue;
      const right = s.right.endsWith('%') ? parseFloat(s.right) / 100 * host.width : parseFloat(s.right);
      const leftProp = s.left.endsWith('%') ? parseFloat(s.left) / 100 * host.width : parseFloat(s.left);
      const left = Number.isFinite(right) ? host.right - right - w : (Number.isFinite(leftProp) ? host.left + leftProp : NaN);
      if (!Number.isFinite(left)) continue;
      out.push({ left, right: left + w, top: host.top, bottom: host.bottom, width: w, height: h });
    }
    return out;
  }

  // The whole control, not the dot or SVG inside it: a child box would
  // leave the badge on top of the rest of the icon.
  function iconHost(el, field, r) {
    let best = el;
    for (let node = el.parentElement, i = 0; node && node !== document.body && i < 4; i++, node = node.parentElement) {
      if (node.contains(field)) break;
      const o = node.getBoundingClientRect();
      if (!iconBox(o, r) || !node.contains(best)) break;
      best = node;
    }
    return best;
  }

  function shownIcon(el) {
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  }

  // Another extension's icon painted in a closed shadow (LastPass: a 0×0
  // [data-lastpass-icon-root], the 22px square drawn inside). Hit-testing
  // retargets to that host, whose own box is empty — the sample points are
  // the icon. Also any icon-sized element the walks missed.
  function probeForeignIcons(field, r) {
    const spans = [];
    const points = new Map();
    const ys = [r.top + r.height * 0.3, r.top + r.height * 0.5, r.top + r.height * 0.7];
    for (let x = r.right - 4; x > Math.max(r.left + 8, r.right - 88); x -= 6) {
      for (const y of ys) {
        let stack;
        try { stack = document.elementsFromPoint(x, y); } catch { continue; }
        for (const el of stack) {
          if (el === field || el.closest?.(`.${BADGE_CLASS}, [data-otpilot-ui]`)) continue;
          if (el.contains(field)) break;
          const o = el.getBoundingClientRect();
          if (iconBox(o, r)) { spans.push([o.left, o.right]); break; }
          // Painted icon whose host box isn't the icon.
          if (o.width < 12 && o.height < 12) {
            const pts = points.get(el) || [];
            pts.push(x);
            points.set(el, pts);
            break;
          }
        }
      }
    }
    for (const xs of points.values()) {
      const pad = 12;
      spans.push([Math.min(...xs) - pad, Math.max(...xs) + pad]);
    }
    return spans;
  }

  // Icons drawn on the field's right, as [left, right] intervals: the site's
  // eye (even pointer-events: none), another manager's icon on <body> or in
  // a closed shadow, a pseudo-element, a right-aligned background. Not the
  // whole padding.
  function occupiedSpans(field, r) {
    const hosts = new Set();
    const spans = [];
    const addEl = el => {
      if (!el || hosts.has(el) || el.closest?.(`.${BADGE_CLASS}, [data-otpilot-ui]`)) return;
      const host = iconHost(el, field, r);
      if (hosts.has(host) || !shownIcon(host)) return;
      const o = host.getBoundingClientRect();
      if (!iconBox(o, r) || o.left >= r.right + 2 || o.right <= r.left + r.width * 0.35) return;
      hosts.add(host);
      spans.push([o.left, o.right]);
    };
    for (const el of trailingCandidates(field)) addEl(el);
    // A manager's icon appended to <body> (LastPass…), including one that
    // doesn't take hits. Only roots that aren't the page around the field.
    for (const root of document.body?.children || []) {
      if (root.contains(field)) continue;
      addEl(root); // the icon itself, not only something wrapped inside it
      const walk = (node, depth) => {
        if (depth > 4) return;
        for (const el of node.children || []) {
          if (el.contains?.(field) || el.closest?.(`.${BADGE_CLASS}, [data-otpilot-ui]`)) continue;
          const o = el.getBoundingClientRect();
          if (o.bottom < r.top - 2 || o.top > r.bottom + 2 || o.right < r.left || o.left > r.right + 8) continue;
          if (iconBox(o, r)) addEl(el);
          else if (o.width < 420 && o.height < 220) walk(el, depth + 1);
        }
      };
      walk(root, 0);
    }
    for (const span of probeForeignIcons(field, r)) spans.push(span);
    for (const o of [...pseudoIcons(field), ...pseudoIcons(field.parentElement)]) {
      if (iconBox(o, r) && o.left < r.right - 2 && o.right > r.left) spans.push([o.left, o.right]);
    }
    const reserveBg = el => {
      if (!el) return;
      const s = getComputedStyle(el);
      if (!/url\(/i.test(s.backgroundImage)) return;
      const posX = s.backgroundPositionX || '';
      if (!/\bright\b|100%/.test(`${posX} ${s.backgroundPosition}`)) return;
      const host = el.getBoundingClientRect();
      if (host.right < r.right - 8 || host.left > r.right) return;
      const border = parseFloat(s.borderRightWidth) || 0;
      const inset = /calc\(100%\s*-\s*([\d.]+)px\)/.exec(posX) || /right\s+([\d.]+)px/.exec(s.backgroundPosition);
      const right = host.right - border - (inset ? parseFloat(inset[1]) : 0);
      const px = /([\d.]+)px/.exec(s.backgroundSize);
      if (px) {
        const w = parseFloat(px[1]);
        if (w >= 8 && w <= 48) spans.push([right - w, right]);
        return;
      }
      // background-size: auto — the image's own size. Capping the padding at
      // 28px left a 28px image, 12px from the edge, under the badge. The
      // padding is what the site kept clear for it.
      const padR = parseFloat(s.paddingRight) || 0;
      if (padR >= 24) spans.push([host.right - border - padR, host.right - border]);
      else spans.push([right - 28, right]);
    };
    reserveBg(field);
    reserveBg(field.parentElement);
    // Padding that reserves an eye we couldn't see: one icon at the edge,
    // not the whole padding (that shoved the badge onto the icon beside it).
    const edgeTaken = spans.some(([L, R]) => R > r.right - 16 && L < r.right);
    if (!edgeTaken) {
      const st = getComputedStyle(field);
      const padR = parseFloat(st.paddingRight) || 0;
      const padL = parseFloat(st.paddingLeft) || 0;
      const border = parseFloat(st.borderRightWidth) || 0;
      if (padR >= padL + 16 && padR >= 24) spans.push([r.right - border - Math.min(padR, 28), r.right - border]);
    }
    return { els: [...hosts], spans };
  }

  // Discovery (the walks, the hit-test) is not redone on every scroll frame:
  // scroll only remeasures what was found. Offsets are from the field's right
  // edge, so an icon that scrolls with the field stays put relative to it.
  const _obstacles = new WeakMap();
  function rememberObstacles(field, r, found) {
    _obstacles.set(field, {
      els: found.els,
      rel: found.spans.map(([L, R]) => [r.right - L, r.right - R]),
    });
  }
  function measureObstacles(field, r) {
    const cached = _obstacles.get(field);
    if (!cached) return null;
    const spans = cached.rel.map(([dL, dR]) => [r.right - dL, r.right - dR]);
    for (const el of cached.els) {
      if (!el.isConnected) continue;
      const o = el.getBoundingClientRect();
      if (o.width >= 8 && o.right > r.left && o.left < r.right + 2) spans.push([o.left, o.right]);
    }
    return spans;
  }

  // Rightmost place inside the field where a `size`-wide badge overlaps no
  // span. The gap between a manager's icon and the eye is used when it fits;
  // otherwise the badge sits left of the whole row.
  function badgeLeftIn(r, size, spans) {
    const gap = 2;
    const maxRight = r.right - 6;
    const minLeft = r.left + 4;
    const blocks = [];
    for (const [L, R] of [...spans].sort((a, b) => a[0] - b[0])) {
      const span = [L - gap, R + gap];
      const last = blocks[blocks.length - 1];
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else blocks.push(span);
    }
    const rights = [maxRight, ...blocks.map(([L]) => L)].filter(x => x - size >= minLeft && x <= maxRight + 0.5);
    let best = null;
    for (const right of rights) {
      const left = right - size;
      if (blocks.some(([L, R]) => left < R && right > L)) continue;
      if (best == null || left > best) best = left;
    }
    return best;
  }

  // Inside the field, sized to fit it (hidden on a field too small or
  // scrolled away). In the rightmost gap that clears the site's eye, a clear
  // button and another manager's icon — never on top of them.
  // Starts hidden, computes final position, then shows in one frame — no jump.
  function placeBadge(b, field) {
    const r = field.getBoundingClientRect();
    const size = Math.min(BADGE, Math.floor(r.height - 6));
    const show = size >= 12 && r.width > size * 4 && isPasswordShown(field);
    if (!show) { b.style.display = 'none'; return; }
    let spans = measureObstacles(field, r);
    if (!spans) {
      const found = occupiedSpans(field, r);
      spans = found.spans;
      rememberObstacles(field, r, found);
    }
    const left = badgeLeftIn(r, size, spans);
    if (left == null) { b.style.display = 'none'; return; }
    const top = r.top + (r.height - size) / 2;
    b.style.display = '';
    Object.assign(b.style, {
      width: `${size}px`, height: `${size}px`, padding: '0',
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
      if (!targets.has(field)) { b.remove(); _badges.delete(field); _obstacles.delete(field); }
    }
    for (const [field, [kind, open]] of targets) {
      let b = _badges.get(field);
      if (b && b.dataset.kind !== kind) { b.remove(); b = null; }
      if (!b) { b = makeBadge(field, kind, open); _badges.set(field, b); document.body.appendChild(b); }
      _obstacles.delete(field); // late icons (LastPass, site eye) need fresh discovery
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
  // before the click — one not holding exactly what was filled (emptied, or
  // a stale value the page put back) means the user checks it and signs in
  // themselves.
  async function submitAfterFill(field, findButton, filled = []) {
    if (await isNoAutoSubmitHost(location.hostname.toLowerCase())) return;
    setTimeout(() => {
      if (!chrome.runtime?.id) return;
      const wrong = filled.find(f => !f.ok());
      if (wrong) { showToast(`Check ${wrong.label} before signing in`, false); return; }
      const button = field.isConnected ? findButton(field) : null;
      if (button?.localName.includes('-')) componentSubmitTarget(button).click();
      else if (button) button.click();
      else if (field.form) field.form.requestSubmit?.();
    }, 300);
  }

  // A web component's submit button (<bbva-button type=submit>): clicked
  // exactly once, never a second time (a slow sign-in would run twice).
  // What the user clicks: the button in its open shadow root — its submit
  // button, else its only untyped button, else its only button —, otherwise
  // the component itself. Never requestSubmit() here: such a form may have
  // no action and use GET, which would put the password in the URL.
  function componentSubmitTarget(host) {
    const root = host.shadowRoot; // null when closed
    if (!root) return host;
    const submit = root.querySelector('button[type="submit"]');
    if (submit) return submit;
    const untyped = root.querySelectorAll('button:not([type])');
    if (untyped.length === 1) return untyped[0];
    const all = root.querySelectorAll('button');
    return all.length === 1 ? all[0] : host;
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
        if (login.username && res.username) { putUsername(login.username, res.username); done.push(filledCheck(login.username, res.username, 'your username', { username: true, loose: true })); }
        fillInputValue(login.password, res.password);
        done.push(filledCheck(login.password, res.password, 'your password'));
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
        done.push(filledCheck(userField, res.username, 'your username', { username: true, loose: true }));
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
  // A sign-in typed in a same-site frame of this page, now over.
  // `otpilotFrameCapture`: one was just typed there; this page's changes (the
  // frame removed) ask for the offer from now on, as after its own capture.
  if (!IN_FRAME) chrome.runtime.onMessage.addListener(msg => {
    if (msg?.action === 'otpilotOfferSave') offerSave();
    if (msg?.action === 'otpilotFrameCapture') _capturedAt = Date.now();
  });
  noteReadonlyPasswords();
  check();
  offerSave();
  continueLaunch();
  // LastPass draws its icon after load, inside a closed shadow: the light-DOM
  // root arriving retriggers the observer, and these cover a paint that lands
  // a moment later (no further mutation outside the shadow).
  for (const ms of [800, 2000]) setTimeout(() => { if (chrome.runtime?.id) syncBadges(); }, ms);
})();
