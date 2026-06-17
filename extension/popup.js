// Storage schema: { accounts: [{name, secret, urls}], activeIndex: 0,
//                   auth: {salt,iv,data}, sessionExpiry: number, sessionDuration: number }

let accounts = [];
let activeIndex = 0;
let currentCode = '';
let timerInterval = null;
let obfuscated = true;
let localChangedAt = null;  // ISO string: last time accounts were modified locally
let lastSyncedAt   = null;  // ISO string: last completed bidirectional sync
let tombstones     = {};    // { [accountName]: ISO } — deleted accounts
let iconCache      = {};    // { [domain]: { dataUrl: string|null, fetchedAt: number } }

// ── Plan helpers ─────────────────────────────────────────────────────────────

function canSync(plan) {
  return plan === 'personal' || plan === 'team_lite' || plan === 'team_pro';
}

// ── URL matching ─────────────────────────────────────────────────────────────

function matchesPattern(pattern, hostname) {
  const host = pattern.trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  if (!host) return false;
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    return hostname === base || hostname.endsWith('.' + base);
  }
  return hostname === host;
}

function findAccountIndexByHostname(hostname) {
  for (let i = 0; i < accounts.length; i++) {
    const patterns = (accounts[i].urls || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (patterns.some(p => matchesPattern(p, hostname))) return i;
  }
  return -1;
}

async function syncActiveIndexToUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith('http')) {
      const hostname = new URL(tab.url).hostname.toLowerCase();
      activeIndex = findAccountIndexByHostname(hostname);
    } else {
      activeIndex = -1;
    }
  } catch {
    activeIndex = -1;
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

function loadState() {
  return new Promise(r =>
    chrome.storage.local.get(['accounts', 'activeIndex', 'obfuscated', 'userPlan', 'localChangedAt', 'lastSyncedAt', 'tombstones', 'categoryFilter', 'iconCache'], d => {
      accounts       = d.accounts || [];
      activeIndex    = Math.min(d.activeIndex ?? 0, Math.max(accounts.length - 1, 0));
      obfuscated     = d.obfuscated ?? true;
      categoryFilter = d.categoryFilter ?? '';
      iconCache      = d.iconCache ?? {};
      localChangedAt = d.localChangedAt ?? null;
      lastSyncedAt   = d.lastSyncedAt   ?? null;
      tombstones     = d.tombstones     ?? {};
      applyObfuscateBtn();
      if (d.userPlan && canSync(d.userPlan)) {
        document.querySelector('.kofi-footer').style.display = 'none';
      }
      r();
    })
  );
}

function saveState() {
  return new Promise(r => chrome.storage.local.set({ accounts, activeIndex }, r));
}

function stampLocalChange() {
  localChangedAt = new Date().toISOString();
  return new Promise(r => chrome.storage.local.set({ localChangedAt }, r));
}

function writeLastSyncedAt(ts) {
  lastSyncedAt = ts;
  return new Promise(r => chrome.storage.local.set({ lastSyncedAt: ts }, r));
}

function formatRelativeTime(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const min  = Math.floor(diff / 60000);
  const hr   = Math.floor(min / 60);
  if (min <  1)  return 'just now';
  if (min < 60)  return `${min}m ago`;
  if (hr  < 24)  return `${hr}h ago`;
  return new Date(isoStr).toLocaleDateString();
}


// ── Status banner ─────────────────────────────────────────────────────────────

let statusTimer = null;
function setStatus(msg, ok = true) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = ok ? 'ok' : 'err';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, 2500);
}

// ── Account bar ──────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#f59e0b',
  '#10b981','#3b82f6','#ef4444','#14b8a6',
  '#f97316','#84cc16','#06b6d4','#a78bfa',
];

function accentColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function nameInitials(name) {
  return (name || '').split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
}

// ── Categories ────────────────────────────────────────────────────────────────
// A category is just a free-text label stored on each account (acc.category).
// It travels inside the encrypted sync blob automatically. Colors are derived
// deterministically from the label, so the same category looks identical on
// every device without needing to sync a separate registry.

const CATEGORY_COLORS = [
  '#38bdf8','#4ade80','#fbbf24','#a78bfa',
  '#fb7185','#34d399','#f97316','#22d3ee',
];

function categoryColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return CATEGORY_COLORS[Math.abs(h) % CATEGORY_COLORS.length];
}

let categoryFilter = ''; // '' = All

// Unique, sorted category labels present in a list of accounts (defaults to the
// saved set; the vault passes its in-progress `draft` so counts match the rows).
function getCategories(list = accounts) {
  return [...new Set(list.map(a => (a.category || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function categoryCount(name, list = accounts) {
  return list.filter(a => (a.category || '').trim() === name).length;
}

// Categories present in the in-progress vault draft (so a label created on one
// account is immediately offered on the others).
function draftCategories() {
  return getCategories(draft);
}

function catDot(name) {
  return `<span class="cat-dot" style="background:${categoryColor(name)}"></span>`;
}

// Builds a filter pill bar (All + one pill per category). Hidden when there are
// no categories. `onPick` re-renders the relevant view after updating the filter.
function renderCategoryBar(barEl, onPick, source = accounts) {
  if (!barEl) return;
  const cats = getCategories(source);
  if (cats.length === 0) { barEl.style.display = 'none'; barEl.innerHTML = ''; return; }

  // A previously-selected category that no longer exists falls back to All.
  if (categoryFilter && !cats.includes(categoryFilter)) categoryFilter = '';

  barEl.style.display = '';
  barEl.innerHTML = '';

  const mkPill = (label, value, dot, count) => {
    const pill = document.createElement('button');
    pill.className = 'cat-pill' + (categoryFilter === value ? ' active' : '');
    pill.innerHTML = `${dot}${esc(label)} <span class="count">${count}</span>`;
    pill.addEventListener('click', () => {
      categoryFilter = value;
      chrome.storage.local.set({ categoryFilter });
      onPick();
    });
    return pill;
  };

  barEl.appendChild(mkPill('All', '', `<span class="cat-dot" style="background:#64748b"></span>`, source.length));
  for (const c of cats) barEl.appendChild(mkPill(c, c, catDot(c), categoryCount(c, source)));
}

function accountMatchesFilter(acc) {
  return !categoryFilter || (acc.category || '').trim() === categoryFilter;
}

// ── Site icons ────────────────────────────────────────────────────────────────
// The avatar shows the site's favicon when one is cached locally (resolved by the
// background SW from the backend), falling back to the letter avatar.

// Mirror of normalizeIconDomain in background.js / api/src/routes/icons.rs.
function normalizeIconDomain(input) {
  if (!input) return null;
  let d = String(input).trim().toLowerCase()
    .replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split(':')[0].replace(/\.+$/, '');
  if (!d || d.length > 253 || !d.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(d)) return null;
  return d;
}

function accountIconDomain(acc) {
  return normalizeIconDomain(acc.domain) || normalizeIconDomain((acc.urls || '').split('\n')[0]);
}

function accountIconDataUrl(acc) {
  const d = accountIconDomain(acc);
  const e = d && iconCache[d];
  return e && e.dataUrl ? e.dataUrl : null;
}

function avatarHTML(acc, extraClass = '') {
  const cls = ('acc-av ' + extraClass).trim();
  const url = accountIconDataUrl(acc);
  if (url) return `<img class="${cls}" src="${url}" alt="">`;
  return `<span class="${cls}" style="background:${accentColor(acc.name || '')}">${esc(nameInitials(acc.name))}</span>`;
}

function avatarNode(acc, extraClass = '') {
  const tmp = document.createElement('template');
  tmp.innerHTML = avatarHTML(acc, extraClass);
  return tmp.content.firstChild;
}

// All distinct icon domains across saved accounts.
function iconDomains() {
  return [...new Set(accounts.map(accountIconDomain).filter(Boolean))];
}

// Ask the background SW to resolve+cache any missing icons, then re-render.
function requestIcons() {
  if (!chrome.runtime?.id) return;
  const domains = iconDomains();
  if (!domains.length) return;
  // prune: this is the full account set, so the SW can evict icons for deleted accounts.
  chrome.runtime.sendMessage({ action: 'resolveIcons', domains, prune: true }, resp => {
    if (chrome.runtime.lastError) return;
    const updated = resp?.updated || {};
    if (!Object.keys(updated).length) return;
    Object.assign(iconCache, updated);
    renderAccountBar();
    // Refresh vault rows too, but only when no row is being edited.
    if (document.getElementById('settings-panel')?.style.display !== 'none' && openAccIdx < 0) {
      rebuildAccountsDOM();
      applyVaultSearch();
    }
  });
}

const CHIP_COUNT = 3;
let overflowOpen = false;

function closeOverflow() {
  overflowOpen = false;
  document.getElementById('account-overflow-panel').style.display = 'none';
  document.getElementById('account-overflow-btn')?.classList.remove('active');
}

function renderAccountBar() {
  closeOverflow();
  renderCategoryBar(document.getElementById('home-cat-bar'), renderAccountBar);

  const bar = document.getElementById('account-bar');
  bar.innerHTML = '';

  // Preserve original indices (activeIndex / codes reference the full array)
  // while only showing accounts in the selected category.
  const entries = accounts
    .map((acc, i) => ({ acc, i }))
    .filter(e => accountMatchesFilter(e.acc));

  entries.slice(0, CHIP_COUNT).forEach(({ acc, i }) => {
    const chip = document.createElement('button');
    chip.className = 'acc-chip' + (i === activeIndex ? ' active' : '');
    chip.addEventListener('mouseenter', () => showChipTooltip(chip, acc.name, acc.email));
    chip.addEventListener('mouseleave', hideChipTooltip);

    if ((acc.category || '').trim()) {
      const dot = document.createElement('span');
      dot.className = 'cat-dot';
      dot.style.background = categoryColor(acc.category.trim());
      chip.appendChild(dot);
    }

    const av = avatarNode(acc);

    const lbl = document.createElement('span');
    lbl.className = 'acc-chip-name';
    lbl.textContent = (acc.name || 'Unnamed').split(/\s+/)[0];

    chip.append(av, lbl);
    chip.addEventListener('click', () => {
      activeIndex = i;
      saveState();
      renderAccountBar();
      startTimer();
    });
    bar.appendChild(chip);
  });

  if (entries.length > CHIP_COUNT) {
    const hasActiveInOverflow = entries.slice(CHIP_COUNT).some(e => e.i === activeIndex);
    const btn = document.createElement('button');
    btn.id = 'account-overflow-btn';
    btn.className = 'acc-overflow-btn' + (hasActiveInOverflow ? ' has-active' : '');
    const hidden = entries.length - CHIP_COUNT;
    btn.textContent = hidden + ' more';
    btn.title = `${hidden} more account${hidden === 1 ? '' : 's'}`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      overflowOpen = !overflowOpen;
      document.getElementById('account-overflow-panel').style.display = overflowOpen ? '' : 'none';
      btn.classList.toggle('active', overflowOpen);
      if (overflowOpen) {
        const search = document.getElementById('account-search');
        search.value = '';
        renderOverflowList('');
        search.focus();
      }
    });
    bar.appendChild(btn);
  }
}

function renderOverflowList(filter) {
  const list = document.getElementById('account-overflow-list');
  list.innerHTML = '';
  const q = filter.toLowerCase();
  accounts.forEach((acc, i) => {
    if (!accountMatchesFilter(acc)) return;
    const name = acc.name || 'Unnamed';
    const email = acc.email || '';
    if (q && !name.toLowerCase().includes(q) && !email.toLowerCase().includes(q)) return;

    const item = document.createElement('button');
    item.className = 'acc-overflow-item' + (i === activeIndex ? ' active' : '');

    const av = avatarNode(acc, 'acc-av-md');

    const text = document.createElement('span');
    text.className = 'acc-overflow-text';
    text.innerHTML = `<span class="acc-overflow-name">${esc(name)}</span>` +
      (email ? `<span class="acc-overflow-email">${esc(email)}</span>` : '');

    item.append(av, text);

    if (i === activeIndex) {
      const check = document.createElement('span');
      check.className = 'acc-overflow-check';
      check.textContent = '✓';
      item.appendChild(check);
    }

    item.addEventListener('click', () => {
      activeIndex = i;
      saveState();
      closeOverflow();
      renderAccountBar();
      startTimer();
    });
    list.appendChild(item);
  });
}

document.getElementById('account-search').addEventListener('input', e => {
  renderOverflowList(e.target.value);
});

document.addEventListener('click', e => {
  if (!overflowOpen) return;
  const bar   = document.getElementById('account-bar');
  const panel = document.getElementById('account-overflow-panel');
  if (!bar.contains(e.target) && !panel.contains(e.target)) closeOverflow();
});

// ── OTP display loop ──────────────────────────────────────────────────────────

async function refreshDisplay() {
  const display   = document.getElementById('otp-display');
  const nameLabel = document.getElementById('account-name');
  const countdown = document.getElementById('countdown');
  const bar       = document.getElementById('progress-bar');
  const btnCopy   = document.getElementById('btn-copy');
  const btnFill   = document.getElementById('btn-fill');

  const acc = accounts[activeIndex];

  if (!acc) {
    nameLabel.textContent = '';
    display.textContent = '••• •••';
    display.className = 'dim';
    countdown.textContent = accounts.length > 0
      ? 'No account for this page'
      : 'Add an account in Settings';
    bar.style.width = '0%';
    btnCopy.disabled = true;
    btnFill.disabled = true;
    currentCode = '';
    return;
  }

  nameLabel.textContent = acc.name || '';

  if (!acc.secret) {
    display.textContent = 'no secret';
    display.className = 'dim';
    countdown.textContent = 'Set a secret in Settings';
    bar.style.width = '0%';
    btnCopy.disabled = true;
    btnFill.disabled = true;
    currentCode = '';
    return;
  }

  try {
    const code = await generateTOTP(acc.secret);
    currentCode = code;
    display.textContent = obfuscated ? '••• •••' : code.slice(0, 3) + ' ' + code.slice(3);
    display.className = obfuscated ? 'dim' : '';

    const rem = totpRemaining();
    countdown.textContent = 'Refreshes in ' + rem + 's';
    bar.style.width = (rem / 30 * 100) + '%';
    bar.style.background = rem <= 5 ? '#f59e0b' : '#38bdf8';

    btnCopy.disabled = false;
    btnFill.disabled = false;
  } catch {
    display.textContent = 'Invalid secret';
    display.className = 'error';
    countdown.textContent = '';
    bar.style.width = '0%';
    btnCopy.disabled = true;
    btnFill.disabled = true;
    currentCode = '';
  }
}

function startTimer() {
  clearInterval(timerInterval);
  refreshDisplay();
  timerInterval = setInterval(refreshDisplay, 1000);
}

// ── Obfuscate toggle ─────────────────────────────────────────────────────────

const SVG_EYE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
</svg>`;

const SVG_EYE_OFF = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
  <line x1="1" y1="1" x2="23" y2="23"/>
</svg>`;

function applyObfuscateBtn() {
  const btn = document.getElementById('btn-obfuscate');
  btn.innerHTML = obfuscated ? SVG_EYE : SVG_EYE_OFF;
  btn.classList.toggle('revealed', !obfuscated);
  btn.title = obfuscated ? 'Show code' : 'Hide code';
}

document.getElementById('btn-obfuscate').addEventListener('click', () => {
  obfuscated = !obfuscated;
  chrome.storage.local.set({ obfuscated });
  applyObfuscateBtn();
  refreshDisplay();
});

// ── Copy / Fill ───────────────────────────────────────────────────────────────

document.getElementById('btn-copy').addEventListener('click', async () => {
  if (!currentCode) return;
  try {
    await navigator.clipboard.writeText(currentCode);
    setStatus('Copied!');
  } catch {
    setStatus('Clipboard unavailable', false);
  }
});

document.getElementById('btn-fill').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab?.id) return;
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { action: 'fill', accountIndex: activeIndex });
    if (result?.ok) setStatus('Filled: ' + result.code);
    else            setStatus(result?.msg || 'Fill failed', false);
  } catch {
    setStatus('No OTP field found on this page', false);
  }
});

// ── Settings – account list ───────────────────────────────────────────────────

// draft holds unsaved edits while settings panel is open
let draft = [];
let openAccIdx = -1;

function renderAccountsList() {
  draft = accounts.map(a => ({ ...a }));
  draft.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  openAccIdx = -1;
  document.getElementById('acc-search').value = '';
  renderVaultCatBar();
  rebuildAccountsDOM();
  applyVaultSearch();
}

// Flush the currently open accordion row's inputs into draft before any re-render.
function syncOpenAccToDraft() {
  if (openAccIdx < 0) return;
  const row = document.querySelector(`.acc-row[data-i="${openAccIdx}"]`);
  if (!row) return;
  const body = row.querySelector('.acc-body');
  if (!body) return;
  draft[openAccIdx].name     = body.querySelector('.acc-name').value.trim();
  draft[openAccIdx].email    = body.querySelector('.acc-email').value.trim();
  draft[openAccIdx].secret   = body.querySelector('.acc-secret').value.trim();
  draft[openAccIdx].urls     = body.querySelector('.acc-urls').value.trim();
  draft[openAccIdx].autofill = body.querySelector('.acc-autofill').checked;
  draft[openAccIdx].category = (body.querySelector('.cat-choose')?.dataset.value || '').trim();
}

function updateVaultCount() {
  const rows = document.querySelectorAll('.acc-row');
  const visible = [...rows].filter(r => r.style.display !== 'none').length;
  const total = draft.length;
  const el = document.getElementById('acc-count');
  if (el) el.textContent = visible === total
    ? `${total} account${total !== 1 ? 's' : ''}`
    : `${visible} of ${total}`;
}

function applyVaultSearch() {
  const q = (document.getElementById('acc-search')?.value || '').toLowerCase();
  document.querySelectorAll('.acc-row').forEach(row => {
    const i = parseInt(row.dataset.i, 10);
    const acc = draft[i];
    const textMatch = !q
      || (acc.name  || '').toLowerCase().includes(q)
      || (acc.email || '').toLowerCase().includes(q);
    const catMatch = !categoryFilter || (acc.category || '').trim() === categoryFilter;
    row.style.display = (textMatch && catMatch) ? '' : 'none';
  });
  updateVaultCount();
}

function renderVaultCatBar() {
  // Pass `draft` so the pill badge counts match the rows the vault actually
  // shows (which are filtered through the in-progress draft, not saved state).
  renderCategoryBar(document.getElementById('vault-cat-bar'), () => {
    renderVaultCatBar();
    applyVaultSearch();
  }, draft);
}

function rebuildAccountsDOM() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = '';

  draft.forEach((acc, i) => {
    const isOpen = i === openAccIdx;

    const row = document.createElement('div');
    row.className = 'acc-row';
    row.dataset.i = i;

    // ── Collapsed header ──
    const head = document.createElement('button');
    head.className = 'acc-head' + (isOpen ? ' open' : '');
    const cat = (acc.category || '').trim();
    head.innerHTML = `
      ${avatarHTML(acc, 'acc-av-md')}
      <span class="acc-head-text">
        <span class="acc-head-name">${esc(acc.name) || `Account ${i + 1}`}</span>
        ${cat || acc.email ? `<span class="acc-head-sub">
          ${cat ? `<span class="cat-tag">${catDot(cat)}${esc(cat)}</span>` : ''}
          ${acc.email ? `<span class="acc-head-email">${esc(acc.email)}</span>` : ''}
        </span>` : ''}
      </span>
      <span class="acc-chevron">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
      </span>`;

    // ── Expanded body ──
    const body = document.createElement('div');
    body.className = 'acc-body' + (isOpen ? ' open' : '');
    body.innerHTML = `
      <div class="acc-body-head">
        <button class="btn-del" title="Delete account">✕ Delete</button>
      </div>
      <div class="acc-field">
        <label>Name</label>
        <input class="acc-name" type="text" placeholder="e.g. My Project QA" value="${esc(acc.name)}">
      </div>
      <div class="acc-field">
        <label>Email (optional)</label>
        <input class="acc-email" type="email" placeholder="e.g. user@example.com" value="${esc(acc.email || '')}">
      </div>
      <div class="acc-field">
        <label>Category</label>
        <div class="cat-choose" data-value="${esc(cat)}">
          <button type="button" class="cat-choice${cat ? '' : ' sel'}" data-cat=""><span class="cat-dot" style="background:#64748b"></span>None</button>
          ${draftCategories().map(c => `<button type="button" class="cat-choice${cat === c ? ' sel' : ''}" data-cat="${esc(c)}">${catDot(c)}${esc(c)}</button>`).join('')}
          <button type="button" class="cat-choice new">+ New</button>
        </div>
      </div>
      <div class="acc-field">
        <label>Secret (base32 or hex)</label>
        <div class="field-row">
          <input class="acc-secret" type="password" placeholder="Secret" value="${esc(acc.secret)}" autocomplete="off">
          <button class="btn-eye" title="Show/hide">${SVG_EYE}</button>
        </div>
      </div>
      <div class="acc-field">
        <label>URLs (one per line, * wildcard ok)</label>
        <textarea class="acc-urls" placeholder="*.example.com&#10;staging.myapp.io">${esc(acc.urls || '')}</textarea>
      </div>
      <label class="toggle">
        <input type="checkbox" class="acc-autofill" ${acc.autofill !== false ? 'checked' : ''}>
        <span class="toggle-track"></span>
        <span class="toggle-label">Auto-fill on matching pages</span>
      </label>`;

    head.addEventListener('click', () => {
      syncOpenAccToDraft();
      openAccIdx = isOpen ? -1 : i;
      rebuildAccountsDOM();
      renderVaultCatBar();
      applyVaultSearch();
    });

    body.querySelector('.btn-del').addEventListener('click', () => {
      syncOpenAccToDraft();
      draft.splice(i, 1);
      openAccIdx = -1;
      rebuildAccountsDOM();
      renderVaultCatBar();
      applyVaultSearch();
    });

    body.querySelector('.btn-eye').addEventListener('click', e => {
      const btn = e.currentTarget;
      const inp = btn.previousElementSibling;
      const reveal = inp.type === 'password';
      inp.type = reveal ? 'text' : 'password';
      btn.innerHTML = reveal ? SVG_EYE_OFF : SVG_EYE;
    });

    // ── Category chooser ──
    const choose = body.querySelector('.cat-choose');
    choose.querySelectorAll('.cat-choice:not(.new)').forEach(btn => {
      btn.addEventListener('click', () => {
        choose.dataset.value = btn.dataset.cat;
        choose.querySelectorAll('.cat-choice').forEach(b => b.classList.remove('sel'));
        btn.classList.add('sel');
        choose.parentElement.querySelector('.cat-new-input')?.remove();
      });
    });
    choose.querySelector('.cat-choice.new').addEventListener('click', () => {
      const field = choose.parentElement;
      let inp = field.querySelector('.cat-new-input');
      if (inp) { inp.focus(); return; }
      inp = document.createElement('input');
      inp.className = 'cat-new-input';
      inp.placeholder = 'New category name';
      inp.maxLength = 24;
      inp.value = '';
      inp.addEventListener('input', () => {
        const v = inp.value.trim();
        choose.dataset.value = v;
        // A typed value supersedes any selected pill.
        choose.querySelectorAll('.cat-choice').forEach(b => b.classList.remove('sel'));
      });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      field.appendChild(inp);
      inp.focus();
    });

    row.appendChild(head);
    row.appendChild(body);
    container.appendChild(row);
  });

  updateVaultCount();
}

function esc(s = '') {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

document.getElementById('btn-add').addEventListener('click', () => {
  syncOpenAccToDraft();
  // Adding while a category filter is active pre-assigns that category, so the
  // new row matches the active filter and stays visible (instead of being
  // hidden by applyVaultSearch the moment it's created).
  draft.push({ name: '', email: '', secret: '', urls: '', autofill: true, category: categoryFilter });
  openAccIdx = draft.length - 1;
  rebuildAccountsDOM();
  renderVaultCatBar();
  applyVaultSearch();
  document.getElementById('accounts-list').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.getElementById('acc-search').addEventListener('input', applyVaultSearch);

document.getElementById('btn-cancel').addEventListener('click', () => {
  openAccIdx = -1;
  showView('home');
});

document.getElementById('btn-save-all').addEventListener('click', async () => {
  syncOpenAccToDraft();

  if (draft.some(a => !a.name)) { setStatus('Every account needs a name', false); return; }

  // Diff old accounts vs draft: stamp _updatedAt on new/changed, tombstone deleted
  const now      = new Date().toISOString();
  const oldMap   = new Map(accounts.map(a => [a.name, a]));
  const draftSet = new Set(draft.map(a => a.name));

  for (const acc of draft) {
    const old = oldMap.get(acc.name);
    const changed = !old ||
      old.secret !== acc.secret || old.urls !== acc.urls ||
      old.email !== acc.email || old.autofill !== acc.autofill ||
      (old.category || '') !== (acc.category || '');
    acc._updatedAt = changed ? now : (old._updatedAt ?? now);
  }

  const newTombs = { ...tombstones };
  for (const acc of accounts) {
    if (!draftSet.has(acc.name)) newTombs[acc.name] = now;
  }
  tombstones = newTombs;
  await new Promise(r => chrome.storage.local.set({ tombstones }, r));

  draft.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  accounts = draft;
  activeIndex = Math.min(activeIndex, Math.max(accounts.length - 1, 0));
  await saveState();
  await stampLocalChange();
  silentPullSync(); // start push before navigating so fetch is in-flight while popup is open

  openAccIdx = -1;
  renderAccountBar();
  requestIcons(); // pick up icons for any newly-added domains
  startTimer();
  showView('home');
  setStatus('Saved');
});

// ── View switching ────────────────────────────────────────────────────────────

function showView(view) {
  if (view !== 'home') closeOverflow();
  document.getElementById('home-view').style.display      = view === 'home'     ? '' : 'none';
  document.getElementById('settings-panel').style.display = view === 'accounts' ? '' : 'none';
  document.getElementById('config-panel').style.display   = view === 'settings' ? '' : 'none';
  document.getElementById('sync-panel').style.display     = view === 'sync'     ? '' : 'none';
  document.getElementById('nav-home').classList.toggle('active',     view === 'home');
  document.getElementById('nav-settings').classList.toggle('active', view === 'accounts');
  document.getElementById('nav-config').classList.toggle('active',   view === 'settings');
  document.getElementById('nav-sync').classList.toggle('active',     view === 'sync');
  if (view === 'accounts') renderAccountsList();
  if (view === 'sync') renderSyncPanel();
  if (view === 'settings') {
    chrome.storage.local.get('emailAutoFill', d => {
      document.getElementById('toggle-email-autofill').checked = d.emailAutoFill ?? true;
    });
  }
}

document.getElementById('toggle-email-autofill').addEventListener('change', e => {
  chrome.storage.local.set({ emailAutoFill: e.target.checked });
});

document.getElementById('nav-home').addEventListener('click',    () => showView('home'));
document.getElementById('nav-settings').addEventListener('click', () => showView('accounts'));
document.getElementById('nav-config').addEventListener('click',   () => showView('settings'));
document.getElementById('nav-sync').addEventListener('click',     () => showView('sync'));

document.getElementById('btn-quick-add').addEventListener('click', () => {
  showView('accounts');
  document.getElementById('btn-add').click();
});

// ── Crypto: Export / Import ───────────────────────────────────────────────────

function b64enc(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64dec(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;
}

async function deriveKey(password, salt) {
  const raw = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, hash: 'SHA-256', iterations: 200000 },
    raw,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

async function encryptData(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
  );
  return { iv: b64enc(iv), data: b64enc(data) };
}

async function decryptData(key, ivB64, dataB64) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64dec(ivB64) }, key, b64dec(dataB64)
  );
  return new TextDecoder().decode(plain);
}

async function runExport(password, exportAccounts) {
  if (!exportAccounts.length) throw new Error('No accounts to export');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await deriveKey(password, salt);
  const { iv, data } = await encryptData(key, JSON.stringify(exportAccounts));
  const blob = new Blob(
    [JSON.stringify({ v: 1, salt: b64enc(salt), iv, data })],
    { type: 'application/json' }
  );
  const a = document.createElement('a');
  a.download = 'otpilot-backup.json';
  a.href = URL.createObjectURL(blob);
  a.click();
  URL.revokeObjectURL(a.href);
}

async function decryptBackup(file, password) {
  const { v, salt, iv, data } = JSON.parse(await file.text());
  if (v !== 1) throw new Error('Unknown backup format');
  const key   = await deriveKey(password, b64dec(salt));
  const plain = await decryptData(key, iv, data);
  const imported = JSON.parse(plain);
  if (!Array.isArray(imported)) throw new Error('Invalid backup data');
  return imported;
}

const normSecret = s => (s || '').replace(/\s+/g, '').toUpperCase();

async function applyImport(selectedAccounts) {
  const existingSecrets = new Set(accounts.map(a => normSecret(a.secret)));
  const now   = new Date().toISOString();
  const toAdd = selectedAccounts
    .filter(a => !existingSecrets.has(normSecret(a.secret)))
    .map(a => ({ ...a, _updatedAt: now }));
  accounts = [...accounts, ...toAdd];
  await saveState();
  if (toAdd.length > 0) {
    await stampLocalChange();
    silentPullSync();
  }
  renderAccountBar();
  renderAccountsList();
  startTimer();
  return { added: toAdd.length, skipped: selectedAccounts.length - toAdd.length };
}

// ── Export picker ─────────────────────────────────────────────────────────────

function showExportPicker() {
  const list = document.getElementById('export-picker-list');
  list.innerHTML = '';
  accounts.forEach((acc, i) => {
    const label = document.createElement('label');
    label.className = 'export-acc-row';
    label.innerHTML = `<input type="checkbox" checked data-idx="${i}">
      <span class="export-acc-name">${acc.name}</span>
      ${acc.email ? `<span class="export-acc-email">${acc.email}</span>` : ''}`;
    list.appendChild(label);
  });
  document.getElementById('export-select-all').checked = true;
  document.getElementById('export-picker').style.display = '';
}

function hideExportPicker() {
  document.getElementById('export-picker').style.display = 'none';
}

document.getElementById('export-select-all').addEventListener('change', e => {
  document.querySelectorAll('#export-picker-list input[type=checkbox]')
    .forEach(cb => { cb.checked = e.target.checked; });
});

document.getElementById('export-picker-confirm').addEventListener('click', () => {
  const selected = [...document.querySelectorAll('#export-picker-list input:checked')]
    .map(cb => accounts[+cb.dataset.idx]);
  if (selected.length === 0) { setStatus('Select at least one account', false); return; }
  hideExportPicker();
  showCryptoForm('export', selected);
});

document.getElementById('export-picker-cancel').addEventListener('click', hideExportPicker);

// ── Import picker ─────────────────────────────────────────────────────────────

let pendingImportAccounts = null;

function showImportPicker(importedAccounts) {
  pendingImportAccounts = importedAccounts;
  const existingSecrets = new Set(accounts.map(a => normSecret(a.secret)));
  const list = document.getElementById('import-picker-list');
  list.innerHTML = '';
  importedAccounts.forEach((acc, i) => {
    const exists = existingSecrets.has(normSecret(acc.secret));
    const label = document.createElement('label');
    label.className = 'export-acc-row' + (exists ? ' disabled' : '');
    label.innerHTML = `<input type="checkbox" ${exists ? 'disabled' : 'checked'} data-idx="${i}">
      <span class="export-acc-name">${acc.name}</span>
      ${acc.email ? `<span class="export-acc-email">${acc.email}</span>` : ''}
      ${exists ? '<span class="export-acc-exists">already in vault</span>' : ''}`;
    list.appendChild(label);
  });
  const hasNew = importedAccounts.some(a => !existingSecrets.has(normSecret(a.secret)));
  document.getElementById('import-select-all').checked = hasNew;
  document.getElementById('import-picker').style.display = '';
}

function hideImportPicker() {
  document.getElementById('import-picker').style.display = 'none';
  pendingImportAccounts = null;
}

document.getElementById('import-select-all').addEventListener('change', e => {
  document.querySelectorAll('#import-picker-list input[type=checkbox]:not(:disabled)')
    .forEach(cb => { cb.checked = e.target.checked; });
});

document.getElementById('import-picker-confirm').addEventListener('click', async () => {
  const selected = [...document.querySelectorAll('#import-picker-list input:checked')]
    .map(cb => pendingImportAccounts[+cb.dataset.idx]);
  if (selected.length === 0) { setStatus('Select at least one account', false); return; }
  const { added, skipped } = await applyImport(selected);
  hideImportPicker();
  setStatus(added === 0
    ? `No new accounts (${skipped} already present)`
    : skipped > 0
      ? `Imported ${added} new account(s), ${skipped} already present`
      : `Imported ${added} account(s)`);
});

document.getElementById('import-picker-cancel').addEventListener('click', hideImportPicker);

// ── Crypto form (shared for export & import) ──────────────────────────────────

let cryptoMode          = null; // 'export' | 'import'
let pendingFile         = null;
let pendingExportAccounts = null;

function showCryptoForm(mode, selectedAccounts = null) {
  cryptoMode            = mode;
  pendingExportAccounts = selectedAccounts;
  const form  = document.getElementById('crypto-form');
  const label = document.getElementById('crypto-label');
  const input = document.getElementById('crypto-password');
  label.textContent = mode === 'export'
    ? 'Password to protect the backup'
    : 'Password used when exporting';
  input.value = '';
  form.style.display = '';
  input.focus();
}

function hideCryptoForm() {
  document.getElementById('crypto-form').style.display = 'none';
  document.getElementById('crypto-password').value = '';
  cryptoMode            = null;
  pendingFile           = null;
  pendingExportAccounts = null;
}

document.getElementById('btn-export').addEventListener('click', () => {
  showExportPicker();
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  pendingFile = file;
  e.target.value = ''; // reset so same file can be re-selected
  showCryptoForm('import');
});

document.getElementById('crypto-confirm').addEventListener('click', async () => {
  const password = document.getElementById('crypto-password').value;
  if (!password) { setStatus('Enter a password', false); return; }

  try {
    if (cryptoMode === 'export') {
      const exportCount = pendingExportAccounts?.length ?? accounts.length;
      await runExport(password, pendingExportAccounts);
      hideCryptoForm();
      setStatus(`Exported ${exportCount} account(s)`);
    } else {
      const imported = await decryptBackup(pendingFile, password);
      hideCryptoForm();
      showImportPicker(imported);
    }
  } catch {
    setStatus(cryptoMode === 'import' ? 'Wrong password or invalid file' : 'Export failed', false);
  }
});

document.getElementById('crypto-cancel').addEventListener('click', hideCryptoForm);

document.getElementById('crypto-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('crypto-confirm').click();
  if (e.key === 'Escape') hideCryptoForm();
});

// ── Lock / Session ────────────────────────────────────────────────────────────

const AUTH_SENTINEL = 'otpilot-auth-ok';
let lockSetupResolve = null;
let lockLoginResolve = null;

function loadAuthState() {
  return new Promise(r =>
    chrome.storage.local.get(['auth', 'sessionExpiry', 'sessionDuration'], r)
  );
}

function saveSessionExpiry(durationMs) {
  const expiry = Date.now() + durationMs;
  return new Promise(r =>
    chrome.storage.local.set({ sessionExpiry: expiry, sessionDuration: durationMs }, r)
  );
}

async function createAuth(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await deriveKey(password, salt);
  const { iv, data } = await encryptData(key, AUTH_SENTINEL);
  const auth = { salt: b64enc(salt), iv, data };
  return new Promise(r => chrome.storage.local.set({ auth }, r)).then(() => auth);
}

async function verifyMasterPassword(password, auth) {
  try {
    const key   = await deriveKey(password, b64dec(auth.salt));
    const plain = await decryptData(key, auth.iv, auth.data);
    return plain === AUTH_SENTINEL;
  } catch {
    return false;
  }
}

function setLockButtonState(btn, busy) {
  btn.disabled = busy;
  if (busy) {
    btn.dataset.origText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span> Verifying…';
  } else {
    btn.textContent = btn.dataset.origText || btn.textContent;
  }
}

function showLockOverlay(mode) {
  const overlay = document.getElementById('lock-overlay');
  const setup   = document.getElementById('lock-setup');
  const login   = document.getElementById('lock-login');
  overlay.classList.remove('hidden');
  if (mode === 'setup') {
    setup.style.display = '';
    login.style.display = 'none';
    document.getElementById('lock-new-password').value = '';
    document.getElementById('lock-confirm-password').value = '';
    document.getElementById('lock-setup-err').textContent = '';
    document.getElementById('lock-new-password').focus();
  } else {
    setup.style.display = 'none';
    login.style.display = '';
    document.getElementById('lock-password').value = '';
    document.getElementById('lock-login-err').textContent = '';
    document.getElementById('lock-password').classList.remove('err');
    chrome.storage.local.get('sessionDuration', d => {
      document.getElementById('lock-login-30d').checked = d.sessionDuration === 2592000000;
    });
    document.getElementById('lock-password').focus();
  }
}

function hideLockOverlay() {
  document.getElementById('lock-overlay').classList.add('hidden');
}

async function initLock() {
  const { auth, sessionExpiry } = await loadAuthState();
  if (!auth) {
    return new Promise(resolve => {
      lockSetupResolve = resolve;
      showLockOverlay('setup');
    }).then(() => true);
  }
  if (sessionExpiry && Date.now() < sessionExpiry) return false;
  return new Promise(resolve => {
    lockLoginResolve = resolve;
    showLockOverlay('login');
  }).then(() => true);
}

async function tryAutoFillCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, { action: 'fill', accountIndex: activeIndex });
  } catch { /* not on an OTP page, ignore */ }
}

// Setup screen
document.getElementById('lock-setup-btn').addEventListener('click', async () => {
  const pw1 = document.getElementById('lock-new-password').value;
  const pw2 = document.getElementById('lock-confirm-password').value;
  const err = document.getElementById('lock-setup-err');
  const btn = document.getElementById('lock-setup-btn');
  const is30 = document.getElementById('lock-setup-30d').checked;

  err.textContent = '';
  document.getElementById('lock-new-password').classList.remove('err');
  document.getElementById('lock-confirm-password').classList.remove('err');

  if (!pw1) {
    err.textContent = 'Enter a password.';
    document.getElementById('lock-new-password').classList.add('err');
    return;
  }
  if (pw1 !== pw2) {
    err.textContent = 'Passwords do not match.';
    document.getElementById('lock-confirm-password').classList.add('err');
    return;
  }

  setLockButtonState(btn, true);
  try {
    await createAuth(pw1);
    await saveSessionExpiry(is30 ? 2592000000 : 86400000);
    hideLockOverlay();
    const cb = lockSetupResolve;
    lockSetupResolve = null;
    cb?.();
  } catch {
    err.textContent = 'Failed to set password. Try again.';
    setLockButtonState(btn, false);
  }
});

['lock-new-password', 'lock-confirm-password'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('lock-setup-btn').click();
  });
});

// Login screen
document.getElementById('lock-login-btn').addEventListener('click', async () => {
  const pw  = document.getElementById('lock-password').value;
  const err = document.getElementById('lock-login-err');
  const btn = document.getElementById('lock-login-btn');
  const inp = document.getElementById('lock-password');
  const is30 = document.getElementById('lock-login-30d').checked;

  err.textContent = '';
  inp.classList.remove('err');

  if (!pw) {
    err.textContent = 'Enter your password.';
    inp.classList.add('err');
    return;
  }

  setLockButtonState(btn, true);
  try {
    const { auth } = await loadAuthState();
    const ok = await verifyMasterPassword(pw, auth);
    if (ok) {
      await saveSessionExpiry(is30 ? 2592000000 : 86400000);
      hideLockOverlay();
      const cb = lockLoginResolve;
      lockLoginResolve = null;
      cb?.();
    } else {
      err.textContent = 'Incorrect password.';
      inp.classList.add('err');
      inp.select();
      setLockButtonState(btn, false);
    }
  } catch {
    err.textContent = 'An error occurred. Try again.';
    setLockButtonState(btn, false);
  }
});

document.getElementById('lock-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('lock-login-btn').click();
});

// Logout button
document.getElementById('btn-logout').addEventListener('click', async () => {
  clearInterval(timerInterval);
  await new Promise(r => chrome.storage.local.set({ sessionExpiry: 0 }, r));
  await new Promise(r => chrome.storage.local.remove('userPlan', r));
  document.querySelector('.kofi-footer').style.display = '';
  await new Promise(resolve => {
    lockLoginResolve = async () => {
      await loadState();
      await syncActiveIndexToUrl();
      renderAccountBar();
      startTimer();
      showView('home');
      tryAutoFillCurrentTab();
      resolve();
    };
    showLockOverlay('login');
  });
});

// ── Chip tooltip ──────────────────────────────────────────────────────────────

const _chipTooltip = document.getElementById('acc-tooltip');
const _tipName     = document.getElementById('acc-tip-name');
const _tipEmail    = document.getElementById('acc-tip-email');

function showChipTooltip(chip, name, email) {
  const rect = chip.getBoundingClientRect();
  _tipName.textContent  = name || '';
  _tipEmail.textContent = email || '';
  _tipEmail.style.display = email ? 'block' : 'none';
  _chipTooltip.style.display = '';
  _chipTooltip.style.left = rect.left + 'px';
  _chipTooltip.style.top  = (rect.bottom + 4) + 'px';
}

function hideChipTooltip() {
  _chipTooltip.style.display = 'none';
}

// ── Cloud Sync UI ─────────────────────────────────────────────────────────────

let _currentSyncKey = '';
let _syncKeyRevealed = false;

function setSyncKeyDisplay(key) {
  _currentSyncKey = key;
  _syncKeyRevealed = false;
  document.getElementById('sync-key-display').textContent = '•'.repeat(key.length);
  const revBtn = document.getElementById('btn-reveal-synckey');
  if (revBtn) revBtn.textContent = 'Show key';
}

function syncShowView(id) {
  ['sv-signin', 'sv-newkey', 'sv-restore', 'sv-active', 'sv-free', 'sv-stop-confirm'].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.classList.toggle('hidden', v !== id);
  });
}

function syncSetStatus(state, text) {
  const dot  = document.getElementById('sync-dot');
  const span = document.getElementById('sync-status-text');
  if (!dot || !span) return;
  dot.className = `sync-dot ${state}`;
  span.textContent = text;
}

async function renderSyncPanel() {
  const session = await SupabaseAuth.getSession();
  if (!session) { syncShowView('sv-signin'); return; }

  let plan;
  try {
    const data = await CloudSync.syncUser();
    plan = data.plan;
    await new Promise(r => chrome.storage.local.set({ userPlan: plan }, r));
  } catch {
    const stored = await new Promise(r => chrome.storage.local.get('userPlan', r));
    plan = stored.userPlan;
  }
  if (plan && canSync(plan)) document.querySelector('.kofi-footer').style.display = 'none';

  const email = session.user.email ?? '';
  const labels = { free: 'Free', personal: 'Personal', team_lite: 'Team', team_pro: 'Team Pro' };

  if (!plan || !canSync(plan)) {
    document.getElementById('sync-avatar-free').textContent = (email[0] ?? '?').toUpperCase();
    document.getElementById('sync-email-free').textContent = email;
    document.getElementById('sync-plan-badge-free').textContent = labels[plan] ?? 'Free';
    syncShowView('sv-free');
    return;
  }

  const badgeEl = document.getElementById('sync-plan-badge');
  if (badgeEl) badgeEl.textContent = labels[plan] ?? plan ?? '';

  const avatar = document.getElementById('sync-avatar');
  if (avatar) avatar.textContent = (email[0] ?? '?').toUpperCase();
  const emailEl = document.getElementById('sync-email');
  if (emailEl) emailEl.textContent = email;

  const syncKey = await CloudSync.getSyncKey();

  if (!syncKey) {
    try {
      const hasData = await CloudSync.serverHasData();
      if (hasData) {
        syncShowView('sv-restore');
      } else {
        const newKey = await CloudSync.generateSyncKey();
        setSyncKeyDisplay(newKey);
        syncShowView('sv-newkey');
      }
    } catch {
      const newKey = await CloudSync.generateSyncKey();
      setSyncKeyDisplay(newKey);
      syncShowView('sv-newkey');
    }
    return;
  }

  syncShowView('sv-active');
  const readyText = lastSyncedAt
    ? `Last synced ${formatRelativeTime(lastSyncedAt)}`
    : 'Ready';
  syncSetStatus('idle', readyText);
}

let _syncInProgress = false;
async function doSync() {
  if (_syncInProgress) return;
  _syncInProgress = true;
  syncSetStatus('syncing', 'Syncing…');
  try {
    const serverMeta = await CloudSync.getServerMeta();

    const serverNewer = serverMeta !== null &&
      (lastSyncedAt === null || serverMeta.updatedAt > lastSyncedAt);
    const localNewer  = localChangedAt !== null &&
      (lastSyncedAt === null || localChangedAt > lastSyncedAt);

    if (serverNewer && !localNewer) {
      accounts   = serverMeta.accounts;
      tombstones = serverMeta.tombstones;
      await saveState();
      await new Promise(r => chrome.storage.local.set({ tombstones }, r));
      renderAccountBar();
      startTimer();
      await writeLastSyncedAt(serverMeta.updatedAt);
    } else if (!serverNewer && localNewer) {
      await CloudSync.push(accounts, tombstones, localChangedAt);
      await writeLastSyncedAt(localChangedAt);
    } else if (serverNewer && localNewer) {
      const { accounts: merged, tombstones: mergedTombs } = CloudSync.mergeWithTombstones(
        accounts, tombstones, serverMeta.accounts, serverMeta.tombstones, lastSyncedAt
      );
      accounts   = merged;
      tombstones = mergedTombs;
      const now = new Date().toISOString();
      await saveState();
      await new Promise(r => chrome.storage.local.set({ tombstones }, r));
      renderAccountBar();
      startTimer();
      await CloudSync.push(merged, mergedTombs, now);
      await writeLastSyncedAt(now);
    } else if (!serverMeta && localChangedAt) {
      await CloudSync.push(accounts, tombstones, localChangedAt);
      await writeLastSyncedAt(localChangedAt);
    }

    if (serverMeta?.command) {
      await CloudSync.executeCommand(serverMeta.command);
      await renderSyncPanel();
      return;
    }

    syncSetStatus('ok', `Synced · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    const msg = e.message ?? 'Sync failed';
    if (/401/.test(msg) || /not signed in/i.test(msg)) {
      // Token revoked, session expired, or dead session — clear and re-show sign-in.
      _syncInProgress = false;
      await SupabaseAuth.signOut();
      await renderSyncPanel();
      return;
    }
    syncSetStatus('error', msg);
  } finally {
    _syncInProgress = false;
  }
}

// Sign-in button
document.getElementById('btn-google-signin').addEventListener('click', async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const session = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'signInWithGoogle' }, response => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (response?.ok) resolve(response.session);
        else reject(new Error(response?.error ?? 'Sign in failed'));
      });
    });
    SupabaseAuth.cacheSession(session); // avoid storage propagation race before syncUser
    await CloudSync.syncUser();
    await renderSyncPanel();
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.4 13.1 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.6 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.5 2.8-2.1 5.2-4.5 6.8l7 5.4c4.1-3.8 6.4-9.4 6.4-16.2z"/><path fill="#FBBC05" d="M10.4 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7-5.4c-2 1.4-4.6 2.2-8.2 2.2-6.2 0-11.5-3.7-13.5-9.1l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg> Continue with Google';
    console.error('Sign in error:', err);
  }
});

// Recovery key: reveal/hide toggle
document.getElementById('btn-reveal-synckey').addEventListener('click', () => {
  _syncKeyRevealed = !_syncKeyRevealed;
  document.getElementById('sync-key-display').textContent = _syncKeyRevealed
    ? _currentSyncKey
    : '•'.repeat(_currentSyncKey.length);
  document.getElementById('btn-reveal-synckey').textContent = _syncKeyRevealed ? 'Hide key' : 'Show key';
});

// New key: copy
document.getElementById('btn-copy-synckey').addEventListener('click', async () => {
  await navigator.clipboard.writeText(_currentSyncKey).catch(() => {});
  document.getElementById('btn-copy-synckey').textContent = 'Copied!';
  setTimeout(() => {
    document.getElementById('btn-copy-synckey').textContent = 'Copy key';
  }, 1500);
});

// New key: confirm saved
document.getElementById('btn-confirm-newkey').addEventListener('click', async () => {
  syncShowView('sv-active');
  syncSetStatus('syncing', 'Uploading…');
  try {
    await CloudSync.syncUser();
    await stampLocalChange(); // force initial push so other devices can detect existing sync
    await doSync();
  } catch (e) {
    syncSetStatus('error', e.message);
  }
});

// Restore: submit key
document.getElementById('btn-restore-key').addEventListener('click', async () => {
  const input = document.getElementById('sync-restore-input');
  const errEl = document.getElementById('sync-restore-err');
  const keyB64 = input.value.trim();
  errEl.textContent = '';
  if (!keyB64) { errEl.textContent = 'Paste your recovery key.'; return; }
  try {
    await CloudSync.saveSyncKey(keyB64);
    const pullResult = await CloudSync.pull();
    if (pullResult) {
      const { accounts: remoteAccounts, tombstones: remoteTombs } = pullResult;

      // On reconnect the server is the source of truth.
      // Add any local-only accounts not present or deleted on the server,
      // but discard local tombstones — offline deletions must not override synced data.
      const remoteNames   = new Set(remoteAccounts.map(a => a.name));
      const remoteDeleted = new Set(Object.keys(remoteTombs));
      const localOnly     = accounts.filter(a => !remoteNames.has(a.name) && !remoteDeleted.has(a.name));
      const merged        = [...remoteAccounts, ...localOnly];
      const mergedTombs   = remoteTombs;

      accounts   = merged;
      tombstones = mergedTombs;
      await saveState();
      await new Promise(r => chrome.storage.local.set({ tombstones }, r));
      renderAccountBar();
      const now = new Date().toISOString();
      await CloudSync.push(merged, mergedTombs, now);
      await writeLastSyncedAt(now);
    }
    syncShowView('sv-active');
    syncSetStatus('ok', 'Restored');
  } catch {
    errEl.textContent = 'Invalid key or decryption failed.';
    await CloudSync.deleteSyncKey();
  }
});

// Restore: start fresh
document.getElementById('btn-overwrite-server').addEventListener('click', async () => {
  const newKey = await CloudSync.generateSyncKey();
  setSyncKeyDisplay(newKey);
  syncShowView('sv-newkey');
});

// Sync now
document.getElementById('btn-sync-now').addEventListener('click', doSync);

// Show recovery key
document.getElementById('btn-show-recovery').addEventListener('click', async () => {
  const key = await CloudSync.getSyncKey();
  if (!key) return;
  setSyncKeyDisplay(key);
  syncShowView('sv-newkey');
  document.getElementById('btn-confirm-newkey').textContent = 'Back to sync';
  document.getElementById('btn-confirm-newkey').onclick = () => {
    syncShowView('sv-active');
    document.getElementById('btn-confirm-newkey').textContent = 'I\'ve saved it — Enable sync';
    document.getElementById('btn-confirm-newkey').onclick = null;
  };
});

// Sign out — free plan view (no sync key, no confirmation needed)
let _stopSyncMode = 'free';
document.getElementById('btn-free-signout').addEventListener('click', async () => {
  try { await CloudSync.leaveDevice() } catch (e) { console.error('leaveDevice:', e) }
  await SupabaseAuth.signOut();
  await new Promise(r => chrome.storage.local.remove(['userPlan', 'localChangedAt', 'lastSyncedAt', 'tombstones'], r));
  localChangedAt = null;
  lastSyncedAt   = null;
  tombstones     = {};
  await renderSyncPanel();
});

// Stop syncing — active view (show confirmation)
document.getElementById('btn-cloud-signout').addEventListener('click', () => {
  _stopSyncMode = 'active';
  syncShowView('sv-stop-confirm');
});

// Stop sync: cancel
document.getElementById('btn-cancel-stop-sync').addEventListener('click', () => {
  syncShowView(_stopSyncMode === 'free' ? 'sv-free' : 'sv-active');
});

// Stop sync: confirm
document.getElementById('btn-confirm-stop-sync').addEventListener('click', async () => {
  try { await CloudSync.leaveDevice() } catch (e) { console.error('leaveDevice:', e) }
  await SupabaseAuth.signOut();
  if (_stopSyncMode === 'active') await CloudSync.deleteSyncKey();
  await new Promise(r => chrome.storage.local.remove(
    ['userPlan', 'localChangedAt', 'lastSyncedAt', 'tombstones'], r
  ));
  localChangedAt = null;
  lastSyncedAt   = null;
  tombstones     = {};
  document.querySelector('.kofi-footer').style.display = '';
  syncShowView('sv-signin');
  const btn = document.getElementById('btn-google-signin');
  btn.disabled = false;
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.4 13.1 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.6 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.5 2.8-2.1 5.2-4.5 6.8l7 5.4c4.1-3.8 6.4-9.4 6.4-16.2z"/><path fill="#FBBC05" d="M10.4 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7-5.4c-2 1.4-4.6 2.2-8.2 2.2-6.2 0-11.5-3.7-13.5-9.1l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg> Continue with Google';
});

// ── Ko-fi link ────────────────────────────────────────────────────────────────

document.getElementById('kofi-link').addEventListener('click', e => {
  e.preventDefault();
  setStatus('Thanks for the support! ☕');
  chrome.tabs.create({ url: 'https://ko-fi.com/carpedev' });
});

// ── Init ──────────────────────────────────────────────────────────────────────

// Full sync on popup open and on server-change notifications.
// Guards session + key so doSync is never called without credentials.
async function silentPullSync() {
  if (_syncInProgress) return;
  try {
    const session = await SupabaseAuth.getSession();
    if (!session) return;
    const syncKey = await CloudSync.getSyncKey();
    if (!syncKey) return;
    const { userPlan: plan } = await new Promise(r => chrome.storage.local.get('userPlan', r));
    if (!canSync(plan)) return;
    await doSync();
  } catch (e) {
    const msg = e?.message ?? '';
    if (/401/.test(msg) || /not signed in/i.test(msg)) {
      await SupabaseAuth.signOut();
      await renderSyncPanel();
    }
    // other errors (offline, etc.) — ignore silently
  }
}

(async () => {
  const justAuthenticated = await initLock();
  await loadState();
  await syncActiveIndexToUrl();
  renderAccountBar();
  requestIcons(); // resolve+cache site favicons, then re-render when ready
  startTimer();
  if (justAuthenticated) tryAutoFillCurrentTab();
  chrome.storage.local.remove('pendingServerSync');
  silentPullSync(); // fire-and-forget

  // If the user is logged in but has no local sync key, go to Sync automatically.
  // renderSyncPanel() will show the correct view (sv-restore, sv-newkey, or sv-free).
  (async () => {
    try {
      const session = await SupabaseAuth.getSession();
      if (!session) return;
      const syncKey = await CloudSync.getSyncKey();
      if (!syncKey) showView('sync');
    } catch {}
  })();

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'serverDataChanged') silentPullSync();
  });
})();
