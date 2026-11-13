'use strict';

// Offers to save an API key a page shows once (a "copy your key now" dialog)
// or lists in a credentials table, as an API credential item. Detection rules: apiKeys.js. Loaded after
// content.js (same isolated world): uses its overlay helpers (makeOverlay,
// OVERLAY_HEADER, themeUi, mountUnlockFrame, showToast, requestSiteIcon,
// guessIssuerFromPage). Top frame only: a key in a cross-origin iframe isn't
// seen (accepted).
//
// The key stays in this script's memory. It's sent to the background once,
// on a real click on Save (vaultAddApiKey), and never stored (not even in
// session storage), copied, or written into the card: the card shows it
// masked. The background takes the host from the sender, re-checks the lock,
// the Free limit, duplicates and the login to link, and never sends the key
// back. Dismissals are remembered for the page by a fingerprint of the value.
// Before a click only the key's SHA-256 goes to the background, which answers
// whether this site's API credentials already hold it (then no card).
//
// The card lives in a closed shadow root: with the vault unlocked it names
// the site's logins (title, username), and a page that shows a fake key
// would get the card without any user action. Only this script holds the
// root; the page sees an empty host element. Tokens are set on the host
// (themeUi) and inherited inside; page rules can't reach the card.
// The page can still rewrite the host's custom properties and declare
// @font-face rules (they apply inside shadow roots), and a font can be made
// to measure the text it draws. So nothing the card draws before the user's
// click names a login (one login: "your saved <host> login"; several: a
// select showing "Don't link"), and the card's font is a generic family
// only (system-ui / monospace: a page's @font-face can't take those names),
// never var(--font-ui). Colors keep the theme tokens.
(() => {
  if (window.top !== window || typeof ApiKeys === 'undefined' || typeof makeOverlay !== 'function') return;

  const CARD_ID = 'otpilot-apikey-save';
  const OWN_UI = '[data-otpilot-ui]';
  // Every action needs a real user event (the host element is the page's to
  // dispatch events on).
  const trusted = fn => e => { if (e.isTrusted) fn(e); };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const host = location.hostname;
  const dismissed = new Set(); // fingerprints of values already offered / dismissed
  let stopped = false;          // "Never" here, or no vault: nothing more on this page
  let busy = false;             // an offer is being prepared or shown
  let cardHost = null;          // the card's host element while one is up

  // ── Reading the page ────────────────────────────────────────────────────
  const TOKEN = /^[A-Za-z0-9_\-.+/=]{16,1024}$/;
  const MAX_NODES = 5000; // text nodes looked at per scan (all roots together)

  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const ours = el => !!el?.closest?.(OWN_UI);
  const textOf = el => (el.innerText ?? el.textContent ?? '');

  // The dialog the key is in, or the nearest ancestor with little text.
  function containerOf(el) {
    const dialog = el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog');
    if (dialog) return dialog;
    let c = el;
    while (c.parentElement && c.parentElement !== document.documentElement && textOf(c.parentElement).length <= 2000) c = c.parentElement;
    return c;
  }

  const COPY_HOOKS = 'clipboard-copy, [data-clipboard-text], [data-clipboard-target]';
  const BUTTONS = 'button, [role="button"], a, input[type="button"]';
  function hasCopyControl(container) {
    for (const el of container.querySelectorAll(`${BUTTONS}, ${COPY_HOOKS}, [aria-label], [title]`)) {
      if (ours(el)) continue;
      if (el.matches(COPY_HOOKS)) return true;
      const label = [el.getAttribute('aria-label'), el.getAttribute('title'),
        el.matches(BUTTONS) ? (el.value || el.textContent) : ''].filter(Boolean).join(' ').trim();
      if (label && label.length <= 80 && ApiKeys.COPY_CONTROL.test(label)) return true;
    }
    return false;
  }

  function contextOf(container, cache) {
    if (cache.has(container)) return cache.get(container);
    const labels = [...container.querySelectorAll('[aria-label], [placeholder]')]
      .map(el => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`).join(' ');
    const text = `${textOf(container)} ${labels}`;
    const ctx = {
      keyWord: ApiKeys.KEY_WORDS.test(text),
      copyOnce: ApiKeys.COPY_ONCE.test(text),
      copyControl: hasCopyControl(container),
      path: location.pathname + location.search + location.hash,
    };
    cache.set(container, ctx);
    return ctx;
  }

  // Read-only fields, code / pre / kbd and short text standing alone: the
  // value and the element showing it. Nothing the user can edit.
  // `budget.left`: text nodes the scan may still look at.
  function* shownValues(root, budget) {
    const el = root.nodeType === 1 ? root : root.parentElement;
    if (!el || ours(el)) return;
    const fields = [...(el.matches('input, textarea') ? [el] : []), ...el.querySelectorAll('input, textarea')];
    for (const f of fields) {
      if (!(f.readOnly || f.disabled) || ours(f) || !visible(f)) continue;
      if (f instanceof HTMLInputElement && !['text', 'password', 'search', 'url', ''].includes(f.type)) continue;
      yield { value: f.value.trim(), el: f };
    }
    const blocks = [...(el.matches('code, pre, kbd') ? [el] : []), ...el.querySelectorAll('code, pre, kbd')];
    for (const b of blocks) {
      if (b.isContentEditable || ours(b) || !visible(b)) continue;
      yield { value: b.textContent.trim(), el: b };
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while (budget.left > 0 && (node = walker.nextNode())) {
      budget.left--;
      const value = node.textContent.trim();
      if (value.length < 16 || value.length > 1024) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, noscript, textarea, code, pre, kbd') || parent.isContentEditable) continue;
      // Standing alone: the whole text of its element, not a word in prose.
      if (parent.textContent.trim() !== value || ours(parent) || !visible(parent)) continue;
      yield { value, el: parent };
    }
  }

  // A table cell's column header and its row's cells by header (a list of
  // credentials: Name | Client id | Client secret/Api key), or null.
  const cellText = c => (c?.textContent || '').trim().replace(/\s+/g, ' ');
  function columnOf(el) {
    const cell = el.closest('td, th, [role="cell"], [role="gridcell"]');
    if (!cell || ours(cell)) return null;
    let cells, headers;
    if (cell.tagName === 'TD' || cell.tagName === 'TH') {
      const table = cell.closest('table');
      const row = cell.parentElement;
      if (!table || !row) return null;
      const headRow = table.tHead?.rows[0] || [...table.rows].find(r => r !== row && r.querySelector('th'));
      if (!headRow) return null;
      cells = [...row.cells];
      headers = [...headRow.cells].map(cellText);
    } else {
      const row = cell.closest('[role="row"]');
      const grid = cell.closest('[role="table"], [role="grid"]');
      const headRow = grid && [...grid.querySelectorAll('[role="row"]')].find(r => r.querySelector('[role="columnheader"]'));
      if (!row || !headRow) return null;
      cells = [...row.querySelectorAll('[role="cell"], [role="gridcell"], [role="rowheader"]')];
      headers = [...headRow.querySelectorAll('[role="columnheader"]')].map(cellText);
    }
    const index = cells.indexOf(cell);
    if (index < 0 || headers.length !== cells.length) return null;
    const by = re => { const i = headers.findIndex(h => re.test(h)); return i >= 0 && i !== index ? cellText(cells[i]) : ''; };
    const id = by(ApiKeys.ID_COLUMN);
    return {
      header: headers[index],
      keyId: /^[^\s]{6,128}$/.test(id) && !ApiKeys.isMasked(id) ? id : '',
      name: (n => n.length <= 60 ? n : '')(by(ApiKeys.NAME_COLUMN)),
    };
  }

  // An AWS access key ID's secret (or the reverse) in the same container.
  function awsPartner(container, wanted, budget) {
    for (const { value } of shownValues(container, budget)) if (wanted(value)) return value;
    return null;
  }

  // The first key on offer under `roots`, or null.
  // `requireCopyOnce`: the scan at load (a page that redirected to show the
  // key) — only with the copy-once wording.
  function findKey(roots, requireCopyOnce) {
    const cache = new Map();
    const budget = { left: MAX_NODES };
    for (const root of roots) {
      for (const { value, el } of shownValues(root, budget)) {
        if (!TOKEN.test(value) || dismissed.has(ApiKeys.fingerprint(value))) continue;
        // Cheap checks on the value before reading its surroundings.
        if (!ApiKeys.known(value) && !ApiKeys.generic(value) && !ApiKeys.isAwsKeyId(value) && !ApiKeys.isAwsSecret(value)) continue;
        const container = containerOf(el);
        const ctx = contextOf(container, cache);
        const column = columnOf(el);
        const keyColumn = !!column && ApiKeys.isKeyColumn(column.header);
        // A credentials table shows the key on every visit: no copy-once
        // wording there, even at load.
        if (requireCopyOnce && !ctx.copyOnce && !keyColumn) continue;
        let found = null;
        const awsId = ApiKeys.isAwsSecret(value) ? awsPartner(container, ApiKeys.isAwsKeyId, budget) : null;
        if (ApiKeys.isAwsKeyId(value)) {
          const secret = awsPartner(container, ApiKeys.isAwsSecret, budget);
          if (secret) found = { value: secret, keyId: value, environment: '' };
        } else if (awsId) {
          // An AWS secret only beside its access key ID; otherwise a 40-char
          // token is judged like any other key below.
          found = { value, keyId: awsId, environment: '' };
        } else {
          const d = ApiKeys.decide(value, { ...ctx, keyColumn });
          if (d?.tier === 3) found = { value, keyId: column.keyId, keyName: column.name, environment: d.environment, table: true };
          else if (d) found = { value, environment: d.environment };
        }
        if (!found) continue;
        if (found.keyId && !found.table && !ctx.copyOnce && !ctx.copyControl) continue;
        if (dismissed.has(ApiKeys.fingerprint(found.value))) continue;
        return { ...found, el, container };
      }
    }
    return null;
  }

  // A name the user gave the key, from the dialog: a Name / Key name field,
  // or a heading that isn't just "Save your key".
  function keyNameIn(container, key) {
    for (const inp of container.querySelectorAll('input:not([type]), input[type="text"]')) {
      if (ours(inp)) continue;
      const v = inp.value.trim();
      if (!v || v.length > 60 || v === key || ApiKeys.known(v) || ApiKeys.generic(v)) continue;
      const label = [inp.name, inp.id, inp.placeholder, inp.getAttribute('aria-label'), inp.labels?.[0]?.textContent].filter(Boolean).join(' ');
      if (/\b(name|label|note|description)\b|key[\s_-]?name/i.test(label)) return v;
    }
    for (const h of container.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      if (ours(h)) continue;
      const t = h.textContent.trim().replace(/\s+/g, ' ');
      if (t && t.length <= 60 && !/key|token|secret|save|copy|creat|new|generat|success|done|api|credential|access|warning|important/i.test(t)) return t;
    }
    return '';
  }

  // ── The card ────────────────────────────────────────────────────────────
  function button(label, primary) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      flex: primary ? '1' : '0 0 auto', padding: '7px 10px', borderRadius: '7px', cursor: 'pointer',
      font: 'inherit', fontSize: '12px', fontWeight: '600',
      background: primary ? 'var(--accent-2, #38bdf8)' : 'transparent', color: primary ? 'var(--bg, #0f172a)' : 'var(--ink-3, #94a3b8)',
      border: primary ? '0' : '1px solid var(--border, #1e3a5f)',
    });
    return b;
  }

  const fieldStyle = {
    width: '100%', boxSizing: 'border-box', margin: '0 0 8px', padding: '6px 8px', borderRadius: '7px', font: 'inherit', fontSize: '12px',
    background: 'var(--bg, #0f172a)', color: 'var(--ink-0, #f1f5f9)', border: '1px solid var(--border, #1e3a5f)',
  };

  // Inside the shadow root: no page style is inherited past the root (custom
  // properties still are, from the host's tokens).
  // Font: generic families only (see the top of the file).
  const CARD_CSS = `.otpilot-apikey-root { all: initial; display: block;
    font-family: system-ui, sans-serif !important;
    font-size: 13px; line-height: 1.4; color: var(--ink-0, #f1f5f9); }
    .otpilot-apikey-root * { font-family: inherit !important; }
    .otpilot-apikey-root .otpilot-apikey-masked { font-family: monospace !important; }`;

  // Focus traps of the page's modal (Radix FocusScope, react-focus-lock, MUI,
  // focus-trap) pull focus back when it moves to an element outside their
  // dialog — our card's Name field. They listen on document / window; this
  // window capture listener runs before theirs (except a window capture
  // listener added before this script) and hides only the focus moves into
  // the card and out of it: an event on the card's host (focus coming in,
  // or leaving the card), or a page element losing focus to the card. Focus
  // coming back to the page from the card is left alone.
  for (const type of ['focusin', 'focusout', 'focus', 'blur']) {
    window.addEventListener(type, e => {
      if (!cardHost) return;
      const out = type === 'focusout' || type === 'blur';
      if (e.target === cardHost || (out && e.relatedTarget === cardHost)) e.stopImmediatePropagation();
    }, true);
  }

  // SHA-256 of the key (hex), so the background can tell it's already saved
  // without the key leaving this script before a click; null without Web
  // Crypto (a plain-http page).
  async function keyHash(value) {
    try {
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }

  let askHash = null; // the hash of the key on offer
  async function askContext() {
    try { return await chrome.runtime.sendMessage({ action: 'vaultApiKeyContext', hash: askHash }); } catch { return null; }
  }

  // `roots`: what the scan that found the key looked at, scanned again once
  // the card is gone (a second key shown meanwhile).
  async function offer(found, roots) {
    if (busy || stopped || !chrome.runtime?.id) return;
    busy = true;
    askHash = await keyHash(found.value);
    const ctx = await askContext();
    // Saved already (a credentials page shows it on every visit): no card.
    if (ctx?.exists) { dismissed.add(ApiKeys.fingerprint(found.value)); idle(); return; }
    if (!ctx || ctx.never || (ctx.state !== 'locked' && ctx.state !== 'unlocked')) {
      // "Never" for this site, or no vault set up: nothing on this page.
      // No answer: this key isn't asked about again on every change.
      if (ctx) stopped = true; else dismissed.add(ApiKeys.fingerprint(found.value));
      idle();
      return;
    }
    if (!found.el.isConnected || document.getElementById(CARD_ID)) { idle(); return; }

    const site = guessIssuerFromPage();
    const keyName = found.keyName || keyNameIn(found.container, found.value);
    let cand = { ...found, name: keyName ? `${site} – ${keyName}` : site };
    delete cand.el; delete cand.container;
    const fp = ApiKeys.fingerprint(cand.value);

    // The host is the page's (themed, positioned, events stopped at it); the
    // card is in its closed shadow root, held only here.
    const el = makeOverlay(CARD_ID);
    // A page's modal may turn pointer events off on <body> (Radix) or catch
    // keys meant for the name field.
    el.style.pointerEvents = 'auto';
    for (const ev of ['keydown', 'keyup', 'keypress', 'focusin', 'focusout']) el.addEventListener(ev, e => e.stopPropagation());
    const shadow = el.attachShadow({ mode: 'closed' });
    let stopUnlock = () => {};
    const close = () => {
      stopUnlock();
      cand = null; // the key leaves this script's memory with the card
      el.remove();
      if (cardHost === el) cardHost = null;
      idle(roots);
    };
    const dismiss = () => { dismissed.add(fp); close(); };

    shadow.innerHTML = `<style>${CARD_CSS}</style><div class="otpilot-apikey-root">${OVERLAY_HEADER}<div class="otpilot-apikey-body" style="padding:10px 12px 12px;color:var(--ink-0, #f1f5f9);font-size:13px;"></div></div>`;
    shadow.querySelector('.otpilot-overlay-close').addEventListener('click', trusted(dismiss));
    const body = shadow.querySelector('.otpilot-apikey-body');
    cardHost = el;
    document.body.appendChild(el);

    function renderLocked() {
      body.textContent = '';
      stopUnlock = mountUnlockFrame(body, { name: host, action: 'Unlock & save', intro: `Unlock OTPilot to save your ${host} API key.` },
        async () => {
          const next = await askContext();
          if (!el.isConnected || !cand) return;
          if (next?.state === 'unlocked' && !next.never && !next.exists) render(next); else dismiss();
        },
        dismiss);
    }

    function renderExists() {
      body.innerHTML = '<div class="otpilot-apikey-exists" style="margin-bottom:10px;">Already saved in OTPilot</div>';
      const ok = button('Close', true);
      ok.className = 'otpilot-apikey-close';
      ok.addEventListener('click', trusted(dismiss));
      body.appendChild(ok);
    }

    // `note`: why the card was drawn again (the login to link changed).
    function render(c, note = '') {
      if (c.state === 'locked') { renderLocked(); return; }
      body.innerHTML = `<div class="otpilot-apikey-title" style="margin-bottom:8px;">Save this API key from <b>${esc(host)}</b>?</div>`;
      if (note) {
        const n = document.createElement('div');
        n.className = 'otpilot-apikey-note';
        n.textContent = note;
        Object.assign(n.style, { color: 'var(--warning, #f59e0b)', fontSize: '12px', margin: '0 0 8px' });
        body.appendChild(n);
      }

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'otpilot-apikey-name';
      name.maxLength = 120;
      name.placeholder = 'Name';
      name.setAttribute('aria-label', 'Name');
      name.autocomplete = 'off';
      name.value = cand.name;
      Object.assign(name.style, fieldStyle);
      body.appendChild(name);

      const masked = document.createElement('div');
      masked.className = 'otpilot-apikey-masked';
      masked.textContent = ApiKeys.mask(cand.value);
      Object.assign(masked.style, {
        fontSize: '12px',
        color: 'var(--ink-3, #94a3b8)', margin: '0 0 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      });
      body.appendChild(masked);

      // Linking to the site's login: one → ticked; several → "Don't link"
      // until the user picks; none → no line. No login's title or username
      // is drawn before the user acts (the line names the site, the select
      // shows "Don't link" until the user opens it and picks).
      const logins = Array.isArray(c.logins) ? c.logins : [];
      let linkTo = () => '';
      if (logins.length === 1) {
        const [login] = logins;
        const label = document.createElement('label');
        label.className = 'otpilot-apikey-link';
        Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--ink-2, #cbd5e1)', margin: '0 0 10px', cursor: 'pointer' });
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        box.style.margin = '0';
        // The site's name, which the page knows: never the login's.
        const text = document.createElement('span');
        text.className = 'otpilot-apikey-link-text';
        text.textContent = `Link to your saved ${host} login`;
        label.append(box, text);
        body.appendChild(label);
        linkTo = () => (box.checked ? login.id : '');
      } else if (logins.length > 1) {
        const select = document.createElement('select');
        select.className = 'otpilot-apikey-link otpilot-save-target';
        Object.assign(select.style, fieldStyle, { margin: '0 0 10px' });
        const none = document.createElement('option');
        none.value = '';
        none.textContent = "Don't link";
        select.appendChild(none);
        for (const l of logins) {
          const o = document.createElement('option');
          o.value = l.id;
          o.textContent = l.username ? `Link to: ${l.name || host} — ${l.username}` : `Link to: ${l.name || host}`;
          select.appendChild(o);
        }
        select.value = '';
        body.appendChild(select);
        linkTo = () => select.value;
      }

      const limitNote = document.createElement('div');
      limitNote.className = 'otpilot-save-limit';
      limitNote.textContent = 'The Free plan holds 50 items. Upgrade to save more.';
      Object.assign(limitNote.style, { color: 'var(--warning, #fbbf24)', fontSize: '12px', margin: '0 0 8px' });

      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });
      const save = button('Save', true);
      save.className = 'otpilot-apikey-save';
      const later = button('Not now');
      later.className = 'otpilot-apikey-later';
      const never = button('Never');
      never.className = 'otpilot-apikey-never';
      never.title = `Never offer to save API keys on ${host}`;
      row.append(save, later, never);
      body.appendChild(row);

      const showLimit = () => { save.disabled = true; body.insertBefore(limitNote, row); };
      if (c.limit) showLimit();

      save.addEventListener('click', trusted(async () => {
        if (!cand || save.disabled) return;
        save.disabled = true;
        const target = linkTo();
        let res;
        try {
          res = await chrome.runtime.sendMessage({
            action: 'vaultAddApiKey', key: cand.value, name: name.value.trim().slice(0, 120), environment: cand.environment || '',
            ...(cand.keyId ? { keyId: cand.keyId } : {}), ...(target ? { linkTo: target } : {}),
          });
        } catch { res = null; }
        if (!el.isConnected) return;
        if (res?.ok) {
          dismiss();
          // The toast is in the page's DOM: it never names the login.
          showToast(res.linked ? 'API key saved to OTPilot, linked to your login' : 'API key saved to OTPilot');
          requestSiteIcon(host); // the saved item's site (its URL)
        } else if (res?.exists) {
          dismissed.add(fp);
          renderExists();
        } else if (res?.limit) {
          showLimit();
        } else if (res?.link) {
          // The login picked was deleted or no longer covers this site:
          // the logins again, with the name the user typed.
          cand.name = name.value;
          const next = await askContext();
          if (!el.isConnected || !cand) return;
          if (next?.state === 'unlocked' && !next.never) render(next, 'That login changed. Pick again.');
          else if (next?.state === 'locked') renderLocked();
          else dismiss();
        } else {
          dismiss();
          showToast('OTPilot could not save this API key', false);
        }
      }));
      later.addEventListener('click', trusted(dismiss));
      never.addEventListener('click', trusted(() => {
        stopped = true;
        observer.disconnect();
        chrome.runtime.sendMessage({ action: 'apiKeyNeverSave' }).catch(() => {});
        dismiss();
      }));
    }

    render(ctx);
  }

  // ── Watching the page ───────────────────────────────────────────────────
  // While a card is up (or being prepared), changed roots wait here and are
  // scanned once it's gone. Past PENDING_MAX the whole body is (MAX_NODES
  // still bounds the scan).
  const PENDING_MAX = 1000;
  let pending = new Set();
  let timer = null;

  const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 300); };

  // The offer is over. `rescan`: the roots it came from (its card closed —
  // its key is dismissed by then, so only another key can come up).
  function idle(rescan) {
    busy = false;
    if (stopped) { pending.clear(); return; }
    for (const r of rescan || []) pending.add(r);
    if (pending.size) schedule();
  }

  function flush() {
    timer = null;
    // Extension reloaded: this script is orphaned.
    if (!chrome.runtime?.id) { observer.disconnect(); pending.clear(); return; }
    if (stopped) { pending.clear(); return; }
    if (busy) return; // kept: idle() schedules the scan
    const roots = [...pending].filter(n => n.isConnected && !ours(n));
    pending = new Set();
    if (!roots.length) return;
    // Nested roots are scanned once, through their outermost one.
    const outer = roots.filter(r => !roots.some(o => o !== r && o.contains(r)));
    const found = findKey(outer, false);
    if (found) offer(found, outer);
  }

  // A read-only field whose value a script sets later (`input.value = key`)
  // changes no attribute and fires no event, so the observer can't see it.
  // Fields added (or present at load) are polled for a while: every
  // FIELD_POLL_MS, for FIELD_WATCH_MS, at most FIELD_MAX fields.
  const FIELD_POLL_MS = 500, FIELD_WATCH_MS = 15000, FIELD_MAX = 50;
  const watched = new Map(); // field -> { value, until }
  let fieldTimer = null;
  function watchFields(root) {
    if (stopped || root.nodeType !== 1 || ours(root)) return;
    const fields = [...(root.matches('input, textarea') ? [root] : []), ...root.querySelectorAll('input, textarea')];
    const until = Date.now() + FIELD_WATCH_MS;
    for (const f of fields) {
      if (watched.size >= FIELD_MAX) break;
      if (!(f.readOnly || f.disabled) || ours(f)) continue;
      watched.set(f, { value: f.value, until });
    }
    if (watched.size && !fieldTimer) fieldTimer = setInterval(pollFields, FIELD_POLL_MS);
  }
  function pollFields() {
    if (!chrome.runtime?.id || stopped) { watched.clear(); }
    const now = Date.now();
    for (const [f, w] of watched) {
      if (!f.isConnected || now > w.until) { watched.delete(f); continue; }
      if (f.value !== w.value) {
        w.value = f.value;
        pending.add(f);
        if (!busy) schedule();
      }
    }
    if (!watched.size) { clearInterval(fieldTimer); fieldTimer = null; }
  }

  const observer = new MutationObserver(records => {
    if (!chrome.runtime?.id) { observer.disconnect(); clearTimeout(timer); pending.clear(); watched.clear(); return; }
    if (stopped) { observer.disconnect(); return; }
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          const e = n.nodeType === 1 ? n : n.parentElement;
          if (e && !ours(e)) { pending.add(e); if (n.nodeType === 1) watchFields(n); }
        }
      } else {
        const e = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (e && !ours(e)) pending.add(e);
      }
    }
    if (pending.size > PENDING_MAX) pending = new Set([document.body]);
    if (pending.size && !busy) schedule();
  });

  if (!document.body) return;
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });

  // A page that shows the key right away (GitHub after creating a token):
  // only with the copy-once wording (so the page isn't scanned again without
  // it once that card closes: only what changed meanwhile is).
  watchFields(document.body);
  const atLoad = findKey([document.body], true);
  if (atLoad) offer(atLoad, []);
})();
