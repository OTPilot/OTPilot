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

// ── Team sharing (owner side) ────────────────────────────────────────────────
// Codes *I'm* sharing with the team, refreshed at popup open and after any
// share/revoke — drives the "shared" badge on Home/Accounts and the share
// picker's "already shared" state. Empty for free/non-team accounts.
let myTeamId      = null;
let mySharedCodes = [];

async function loadMySharedCodes() {
  try {
    const team = await Sharing.getMyTeam();
    if (!team?.id) { myTeamId = null; mySharedCodes = []; return; }
    myTeamId = team.id;
    mySharedCodes = await Sharing.getMyCodes(team.id);
  } catch {
    myTeamId = null; mySharedCodes = [];
  }
}

// Two accounts can share a name (e.g. two "PayPal" entries for different
// emails), so match on both — account_email is '' server-side when the
// account has none, matching how shareCode() sends it.
//
// Known limitation: shared_codes has no stable account identifier (accounts
// aren't individual server-side rows at all — the vault is one opaque
// encrypted blob per user, see CLAUDE.md's data model), so this is a
// best-effort match on the name/email *snapshotted at share time*. Renaming
// an account after sharing it will orphan this lookup (badge/Revoke
// disappear, re-opening the picker offers to create a new share instead of
// managing the old one) — the exact same limitation the web dashboard's
// "Codes I'm sharing" list already has, not something introduced here. A
// real fix needs a stable account id threaded through share/list/revoke,
// which is a schema change spanning the API and web dashboard too.
function findSharedCode(acc) {
  return mySharedCodes.find(c =>
    c.account_name === (acc.name || '') && (c.account_email || '') === (acc.email || ''));
}

// ── Appearance (themes) ──────────────────────────────────────────────────────
// Single source of truth for the theme picker in Settings → Appearance. Adding
// a theme is two steps: 1) a body[data-theme="id"] token block in popup.html's
// <style> (same custom-property names as the others), 2) one entry here.
const THEMES = [
  { id: 'original', name: 'Original', desc: 'The classic slate & sky-blue look.',       swatch: ['#0f172a', '#38bdf8'] },
  { id: 'vault',    name: 'Vault',    desc: 'Graphite & brass — precise and premium.', swatch: ['#1c1a17', '#c9a15a'] },
  { id: 'daylight', name: 'Daylight', desc: 'Calm paper-white, forest-green accent.',   swatch: ['#faf9f5', '#2f6f4f'] },
  { id: 'terminal', name: 'Terminal', desc: 'Monospace control panel, cyan accent.',    swatch: ['#0a0e14', '#33c2cf'] },
  { id: 'signal',   name: 'Signal',   desc: 'Bold navy, coral accent, rounded.',        swatch: ['#101b2d', '#ff6a55'] },
];
const DEFAULT_THEME = 'original';

function applyTheme(id) {
  document.body.dataset.theme = id;
  try { localStorage.setItem('otpilotTheme', id); } catch { /* private mode etc. */ }
  chrome.storage.local.set({ theme: id });
  const sub = document.getElementById('row-settings-theme-sub');
  if (sub) sub.textContent = THEMES.find(t => t.id === id)?.name ?? id;
}

function renderThemePicker(current) {
  const list = document.getElementById('theme-list');
  if (!list) return;
  list.innerHTML = '';
  THEMES.forEach(t => {
    const row = document.createElement('button');
    row.className = 'theme-row' + (t.id === current ? ' active' : '');
    row.innerHTML = `
      <span class="theme-swatch" style="background:${t.swatch[0]}"><span style="background:${t.swatch[1]}"></span></span>
      <span class="theme-text">
        <span class="theme-name">${t.name}</span>
        <span class="theme-desc">${t.desc}</span>
      </span>
      <span class="theme-check">${t.id === current
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        : ''}</span>`;
    row.addEventListener('click', () => {
      if (t.id === current) return;
      applyTheme(t.id);
      current = t.id;
      renderThemePicker(current);
    });
    list.appendChild(row);
  });
}

document.getElementById('row-settings-theme').addEventListener('click', () => showSettingsSubview('settings-theme-view'));
document.getElementById('back-settings-theme').addEventListener('click', () => showSettingsSubview('settings-list'));

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
  // A bare domain also matches its subdomains — and vice-versa. 2FA/login pages
  // frequently live on a deeper host than where the account was saved (e.g. the
  // account is saved as namecheap.com or www.namecheap.com but the OTP page is
  // ap.www.namecheap.com). Kept in sync with content.js matchesPattern().
  return hostname === host
    || hostname.endsWith('.' + host)
    || host.endsWith('.' + hostname);
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
  tabMatchIndex = activeIndex;
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

  // A previously-selected category that no longer exists falls back to All.
  // Must run even when `cats` is empty — otherwise a stale filter survives
  // the last account losing its category tag and hides everything.
  if (categoryFilter && !cats.includes(categoryFilter)) categoryFilter = '';

  if (cats.length === 0) { barEl.style.display = 'none'; barEl.innerHTML = ''; return; }

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

  barEl.appendChild(mkPill('All', '', `<span class="cat-dot" style="background:var(--ink-4)"></span>`, source.length));
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

// Best-effort: if the popup's active tab happens to be the site an account was
// just saved for (the common case — filling in the account while sitting on its
// 2FA page), grab its declared favicon so the backend doesn't have to blind-fetch
// the homepage. Some sites (e.g. Binance) return an anti-bot challenge page to a
// server-side fetch but obviously already rendered fine in the user's own tab.
async function activeTabIconHint() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith('http')) return {};
    const hostname = new URL(tab.url).hostname.toLowerCase();
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const link = document.querySelector('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"]');
        const href = link?.getAttribute('href');
        return href ? new URL(href, location.href).href : null;
      },
    });
    return result ? { [hostname]: result } : {};
  } catch {
    return {}; // no scripting access on this tab (chrome://, web store, etc.) — fine, best-effort
  }
}

// Ask the background SW to resolve+cache any missing icons, then re-render.
function requestIcons(hints = {}) {
  if (!chrome.runtime?.id) return;
  const domains = iconDomains();
  if (!domains.length) return;
  // prune: this is the full account set, so the SW can evict icons for deleted accounts.
  chrome.runtime.sendMessage({ action: 'resolveIcons', domains, hints, prune: true }, resp => {
    if (chrome.runtime.lastError) return;
    const updated = resp?.updated || {};
    if (!Object.keys(updated).length) return;
    Object.assign(iconCache, updated);
    renderAccountBar();
    refreshDisplay(); // the big icon above the code only knows the real favicon once this lands
    // Refresh vault rows too, but only when no row is being edited.
    if (document.getElementById('settings-panel')?.style.display !== 'none' && openAccIdx < 0) {
      rebuildAccountsDOM();
      applyVaultSearch();
    }
  });
}

// The account matching the active tab's URL, set once by syncActiveIndexToUrl()
// at popup open. Kept separate from activeIndex (which changes freely as the
// user browses the list) purely to keep showing the "this tab" dot/badge on
// the right row even after they've clicked over to look at something else.
let tabMatchIndex = -1;

function renderAccountBar() {
  renderCategoryBar(document.getElementById('home-cat-bar'), renderAccountBar);

  const list = document.getElementById('home-list');
  const countEl = document.getElementById('home-count');
  const q = (document.getElementById('home-search')?.value || '').trim().toLowerCase();

  const entries = accounts
    .map((acc, i) => ({ acc, i }))
    .filter(e => accountMatchesFilter(e.acc))
    .filter(e => !q || (e.acc.name || '').toLowerCase().includes(q) || (e.acc.email || '').toLowerCase().includes(q));

  countEl.textContent = q
    ? `${entries.length} result${entries.length === 1 ? '' : 's'}`
    : `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;

  list.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'lc-empty';
    empty.textContent = accounts.length ? `No account matches "${q}"` : 'No accounts yet — add one in Settings';
    list.appendChild(empty);
    return;
  }

  entries.forEach(({ acc, i }) => {
    const row = document.createElement('button');
    row.className = 'lc-row' + (i === activeIndex ? ' sel' : '');

    const av = avatarNode(acc);

    const cat = (acc.category || '').trim();
    const text = document.createElement('span');
    text.className = 'lc-row-text';
    text.innerHTML = `<span class="lc-row-name">${cat ? catDot(cat) : ''}${esc(acc.name || 'Unnamed')}${sharedBadgeHTML(findSharedCode(acc))}</span>` +
      (acc.email ? `<span class="lc-row-sub">${esc(acc.email)}</span>` : '');

    row.append(av, text);

    if (i === tabMatchIndex) {
      const dot = document.createElement('span');
      dot.className = 'lc-row-tab-dot';
      dot.title = 'Matches this tab';
      row.appendChild(dot);
    }

    row.addEventListener('click', () => {
      activeIndex = i;
      saveState();
      renderAccountBar();
      startTimer();
    });
    list.appendChild(row);
  });
}

document.getElementById('home-search').addEventListener('input', renderAccountBar);

// ── OTP display loop ──────────────────────────────────────────────────────────

// refreshDisplay() is called from several places that can overlap (the 1s
// timer tick, an account switch, icon resolution landing) — it awaits Web
// Crypto, so an older call can still be in flight when a newer one starts.
// Bumped at the top of each call; a call whose generation no longer matches
// by the time its await resolves belongs to a stale account/moment and must
// not overwrite the display or currentCode with outdated results.
let _displayGen = 0;

async function refreshDisplay() {
  const gen = ++_displayGen;
  const display   = document.getElementById('otp-display');
  const nameLabel = document.getElementById('account-name');
  const countdown = document.getElementById('countdown');
  const bar       = document.getElementById('progress-bar');
  const btnCopy   = document.getElementById('btn-copy');
  const btnFill   = document.getElementById('btn-fill');
  const btnEdit   = document.getElementById('btn-edit-account');
  const bigIcon   = document.getElementById('account-big-icon');

  const acc = accounts[activeIndex];
  // Shared codes (read-only, no secret of your own) live in a separate list
  // below and aren't editable here — only own accounts get the edit shortcut.
  btnEdit.disabled = !acc;

  if (!acc) {
    bigIcon.innerHTML = '';
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

  nameLabel.innerHTML = esc(acc.name || '') + sharedBadgeHTML(findSharedCode(acc));

  // Only the real site favicon, never the letter-avatar fallback — this is
  // decorative extra space, not a place to render initials twice.
  const bigIconUrl = accountIconDataUrl(acc);
  bigIcon.innerHTML = bigIconUrl ? `<img src="${bigIconUrl}" alt="">` : '';

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
    if (gen !== _displayGen) return; // a newer refresh has since started — don't stomp its result
    currentCode = code;
    display.textContent = obfuscated ? '••• •••' : code.slice(0, 3) + ' ' + code.slice(3);
    display.className = obfuscated ? 'dim' : '';

    const rem = totpRemaining();
    countdown.textContent = 'Refreshes in ' + rem + 's';
    bar.style.width = (rem / 30 * 100) + '%';
    bar.style.background = rem <= 5 ? 'var(--warning)' : 'var(--accent-2)';

    btnCopy.disabled = false;
    btnFill.disabled = false;
  } catch {
    if (gen !== _displayGen) return;
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

const SVG_EDIT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
  <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>
</svg>`;
document.getElementById('btn-edit-account').innerHTML = SVG_EDIT;

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
  _repaintSharedCodes?.(); // shared codes respect the same hide/show setting
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

document.getElementById('btn-edit-account').addEventListener('click', () => {
  if (!accounts[activeIndex]) return;
  editAccount(activeIndex);
});

// ── Settings – account list ───────────────────────────────────────────────────

// draft holds unsaved edits while settings panel is open
let draft = [];
let openAccIdx = -1;

// `openTargetIdx`, when given, is an index into `accounts` (not the
// alphabetically-sorted `draft`) to open in the detail panel right away —
// used by the "edit this account" shortcut on the Home view. draft entries
// are clones, so the origin index has to be tracked through the sort to
// translate it into draft's index space.
function renderAccountsList(openTargetIdx = -1) {
  const withOrigin = accounts.map((a, i) => ({ acc: { ...a }, origIdx: i }));
  withOrigin.sort((x, y) => (x.acc.name || '').localeCompare(y.acc.name || ''));
  draft = withOrigin.map(w => w.acc);
  openAccIdx = openTargetIdx >= 0 ? withOrigin.findIndex(w => w.origIdx === openTargetIdx) : -1;
  document.getElementById('acc-search').value = '';
  // A leftover category filter from a previous Accounts-view visit could hide
  // the very row we're jumping to — clear it so the shortcut always lands
  // somewhere visible.
  if (openAccIdx >= 0 && categoryFilter) {
    categoryFilter = '';
    chrome.storage.local.set({ categoryFilter });
  }
  renderVaultCatBar();
  rebuildAccountsDOM();
  applyVaultSearch();
  renderAccDetail();
  if (openAccIdx >= 0) {
    document.querySelector(`.acc-row[data-i="${openAccIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

// Jumps to the Accounts view with `accIdx` (an index into `accounts`) already
// open in the detail panel — the "edit" shortcut from the Home view.
function editAccount(accIdx) {
  showView('accounts', { openAccountIdx: accIdx });
}

// Flush the currently open detail form's inputs into draft before any re-render.
function syncOpenAccToDraft() {
  if (openAccIdx < 0) return;
  const body = document.querySelector('#acc-detail .acc-body');
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

// Renders the left-column list of rows only. The selected row's edit form
// lives in the separate #acc-detail panel (see renderAccDetail) instead of
// expanding inline, since the vault is now a persistent list+detail split
// rather than an accordion.
function rebuildAccountsDOM() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = '';

  draft.forEach((acc, i) => {
    const row = document.createElement('div');
    row.className = 'acc-row';
    row.dataset.i = i;

    const head = document.createElement('button');
    head.className = 'acc-head' + (i === openAccIdx ? ' open' : '');
    const cat = (acc.category || '').trim();
    head.innerHTML = `
      ${avatarHTML(acc, 'acc-av-md')}
      <span class="acc-head-text">
        <span class="acc-head-name">${esc(acc.name) || `Account ${i + 1}`}${sharedBadgeHTML(findSharedCode(acc))}</span>
        ${cat || acc.email ? `<span class="acc-head-sub">
          ${cat ? `<span class="cat-tag">${catDot(cat)}${esc(cat)}</span>` : ''}
          ${acc.email ? `<span class="acc-head-email">${esc(acc.email)}</span>` : ''}
        </span>` : ''}
      </span>`;

    head.addEventListener('click', () => {
      syncOpenAccToDraft();
      openAccIdx = i;
      rebuildAccountsDOM();
      renderVaultCatBar();
      applyVaultSearch();
      renderAccDetail();
    });

    row.appendChild(head);
    container.appendChild(row);
  });

  updateVaultCount();
}

// Renders the edit form for draft[openAccIdx] into the right-column detail
// panel. Same fields/behavior as the old inline accordion body, just mounted
// in one shared container instead of nested under each row.
function renderAccDetail() {
  const container = document.getElementById('acc-detail');
  const acc = draft[openAccIdx];

  if (!acc) {
    container.innerHTML = `<div class="dc-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16"/></svg>
      Select an account to edit, or add a new one
    </div>`;
    return;
  }

  const cat = (acc.category || '').trim();
  const body = document.createElement('div');
  body.className = 'acc-body open';
  body.innerHTML = `
    <div class="acc-body-head">
      <span class="acc-body-title">${esc(acc.name) || `Account ${openAccIdx + 1}`}${sharedBadgeHTML(findSharedCode(acc))}</span>
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
        <button type="button" class="cat-choice${cat ? '' : ' sel'}" data-cat=""><span class="cat-dot" style="background:var(--ink-4)"></span>None</button>
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
    </label>
    <div class="acc-share">
      <button type="button" class="btn-share-team">↗ Share with team</button>
      <div class="share-picker" style="display:none"></div>
    </div>`;

  body.querySelector('.btn-del').addEventListener('click', () => {
    syncOpenAccToDraft(); // pick up an in-progress name edit before naming it in the prompt
    const name = draft[openAccIdx].name || `Account ${openAccIdx + 1}`;
    if (!confirm(`Delete "${name}"? This can't be undone once you save.`)) return;
    draft.splice(openAccIdx, 1);
    openAccIdx = -1;
    rebuildAccountsDOM();
    renderVaultCatBar();
    applyVaultSearch();
    renderAccDetail();
  });

  body.querySelector('.btn-eye').addEventListener('click', e => {
    const btn = e.currentTarget;
    const inp = btn.previousElementSibling;
    const reveal = inp.type === 'password';
    inp.type = reveal ? 'text' : 'password';
    btn.innerHTML = reveal ? SVG_EYE_OFF : SVG_EYE;
  });

  // Live-update the list row's name/email as you type, without a full
  // syncOpenAccToDraft()+rebuild — that would steal focus from the input.
  const idx = openAccIdx;
  body.querySelector('.acc-name').addEventListener('input', e => {
    const head = document.querySelector(`.acc-row[data-i="${idx}"] .acc-head-name`);
    if (head) head.innerHTML = esc(e.target.value.trim() || `Account ${idx + 1}`) + sharedBadgeHTML(findSharedCode(draft[idx]));
  });

  // ── Share with team ──
  body.querySelector('.btn-share-team').addEventListener('click', () => {
    syncOpenAccToDraft();
    openSharePicker(body.querySelector('.share-picker'), draft[idx]);
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

  container.innerHTML = '';
  container.appendChild(body);
}

function esc(s = '') {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Small "shared with team" indicator — used on list rows and both detail
// headers. `code` is a getMyCodes() row (has a live recipient count) or null.
function sharedBadgeHTML(code) {
  if (!code) return '';
  const n = code.recipients ?? 0;
  return `<span class="shared-badge" title="Shared with ${n} teammate${n === 1 ? '' : 's'}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>${n}
  </span>`;
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
  renderAccDetail();
  document.getElementById('accounts-list').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.getElementById('acc-search').addEventListener('input', applyVaultSearch);

document.getElementById('btn-cancel').addEventListener('click', () => {
  openAccIdx = -1;
  showView('home');
});

document.getElementById('btn-save-all').addEventListener('click', async () => {
  syncOpenAccToDraft();
  // Reopen the same account in Accounts after saving. Captured by reference,
  // not index — draft.sort() below reorders the array (a rename or a new
  // account can land anywhere alphabetically), so openAccIdx's pre-sort
  // position would point at the wrong entry once draft becomes accounts.
  const savedAcc = openAccIdx >= 0 ? draft[openAccIdx] : null;

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
  const savedIdx = savedAcc ? accounts.indexOf(savedAcc) : -1;
  activeIndex = Math.min(activeIndex, Math.max(accounts.length - 1, 0));
  await saveState();
  await stampLocalChange();
  silentPullSync(); // start push before navigating so fetch is in-flight while popup is open

  renderAccountBar();
  activeTabIconHint().then(requestIcons); // pick up icons for any newly-added domains
  startTimer();
  showView('accounts', { openAccountIdx: savedIdx });
  setStatus('Saved');
});

// ── View switching ────────────────────────────────────────────────────────────

function showView(view, opts = {}) {
  document.getElementById('home-view').style.display      = view === 'home'     ? '' : 'none';
  document.getElementById('settings-panel').style.display = view === 'accounts' ? '' : 'none';
  document.getElementById('config-panel').style.display   = view === 'settings' ? '' : 'none';
  document.getElementById('sync-panel').style.display     = view === 'sync'     ? '' : 'none';
  document.getElementById('team-panel').style.display     = view === 'team'     ? '' : 'none';
  document.getElementById('nav-home').classList.toggle('active',     view === 'home');
  document.getElementById('nav-settings').classList.toggle('active', view === 'accounts');
  document.getElementById('nav-config').classList.toggle('active',   view === 'settings');
  document.getElementById('nav-sync').classList.toggle('active',     view === 'sync');
  document.getElementById('nav-team').classList.toggle('active',     view === 'team');
  if (view === 'accounts') renderAccountsList(opts.openAccountIdx ?? -1);
  if (view === 'sync') renderSyncPanel();
  if (view === 'team') renderTeamPanel();
  if (view === 'settings') {
    chrome.storage.local.get('emailAutoFill', d => {
      const on = d.emailAutoFill ?? true;
      document.getElementById('toggle-email-autofill').checked = on;
      document.getElementById('row-settings-autofill-sub').textContent = on ? 'On' : 'Off';
    });
    showSettingsSubview('settings-list');
  }
}

document.getElementById('toggle-email-autofill').addEventListener('change', e => {
  chrome.storage.local.set({ emailAutoFill: e.target.checked });
  document.getElementById('row-settings-autofill-sub').textContent = e.target.checked ? 'On' : 'Off';
});

// ── Settings drill-down navigation ──────────────────────────────────────────

function showSettingsSubview(id) {
  // The menu (#settings-list) stays visible alongside the content now — there's
  // no more "back". 'settings-list' as an id just means "no specific item was
  // requested", so it falls back to the first one instead of showing nothing.
  if (id === 'settings-list') id = 'settings-theme-view';
  const views = ['settings-theme-view', 'settings-backup-view', 'settings-google-import-view', 'settings-autofill-view', 'settings-password-view'];
  views.forEach(v => { document.getElementById(v).style.display = v === id ? '' : 'none'; });
  document.querySelectorAll('#settings-list .settings-row').forEach(row => {
    row.classList.toggle('sel', row.dataset.view === id);
  });
  // Each menu item is a static subview except Appearance, whose theme list is
  // populated on demand (from storage) whenever it becomes the visible one —
  // needed both on an explicit click and when Settings opens straight onto it.
  if (id === 'settings-theme-view') {
    chrome.storage.local.get('theme', d => renderThemePicker(d.theme || DEFAULT_THEME));
  }
  // import-picker lives outside the subviews above (shared by Backup and Google
  // Auth import) — close it on any navigation so a pending review can't linger
  // and later be confirmed from an unrelated settings screen.
  hideImportPicker();
}

document.getElementById('row-settings-backup').addEventListener('click', () => showSettingsSubview('settings-backup-view'));
document.getElementById('back-settings-backup').addEventListener('click', () => showSettingsSubview('settings-list'));
document.getElementById('back-settings-google-import').addEventListener('click', () => showSettingsSubview('settings-list'));
document.getElementById('row-settings-autofill').addEventListener('click', () => showSettingsSubview('settings-autofill-view'));
document.getElementById('back-settings-autofill').addEventListener('click', () => showSettingsSubview('settings-list'));

document.getElementById('row-settings-password').addEventListener('click', () => {
  ['change-pw-current', 'change-pw-new', 'change-pw-confirm'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('change-pw-err').textContent = '';
  showSettingsSubview('settings-password-view');
});
document.getElementById('back-settings-password').addEventListener('click', () => showSettingsSubview('settings-list'));

document.getElementById('change-pw-submit').addEventListener('click', async () => {
  const current = document.getElementById('change-pw-current').value;
  const next    = document.getElementById('change-pw-new').value;
  const confirm = document.getElementById('change-pw-confirm').value;
  const err     = document.getElementById('change-pw-err');
  const btn     = document.getElementById('change-pw-submit');

  err.textContent = '';
  if (!current || !next) { err.textContent = 'Fill in both password fields.'; return; }
  if (next !== confirm)  { err.textContent = 'New passwords do not match.'; return; }

  setLockButtonState(btn, true);
  try {
    const { auth, sessionDuration } = await loadAuthState();
    const ok = await verifyMasterPassword(current, auth);
    if (!ok) {
      err.textContent = 'Current password is incorrect.';
      setLockButtonState(btn, false);
      return;
    }
    await createAuth(next);
    // Renew the session from now, like setup/login do — otherwise a change
    // made near the old expiry could immediately re-lock the popup.
    await saveSessionExpiry(sessionDuration ?? 86400000);
    ['change-pw-current', 'change-pw-new', 'change-pw-confirm'].forEach(id => document.getElementById(id).value = '');
    showSettingsSubview('settings-list');
    setStatus('Master password updated');
  } catch {
    err.textContent = 'Failed to update password. Try again.';
  } finally {
    setLockButtonState(btn, false);
  }
});

['change-pw-current', 'change-pw-new', 'change-pw-confirm'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('change-pw-submit').click();
  });
});

document.getElementById('nav-home').addEventListener('click',    () => showView('home'));
document.getElementById('nav-settings').addEventListener('click', () => showView('accounts'));
document.getElementById('nav-config').addEventListener('click',   () => showView('settings'));
document.getElementById('nav-sync').addEventListener('click',     () => showView('sync'));
document.getElementById('nav-team').addEventListener('click',     () => showView('team'));

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
  requestIcons(); // pick up icons for any newly-imported domains
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

function showImportPicker(importedAccounts, notes = []) {
  pendingImportAccounts = importedAccounts;
  const notesEl = document.getElementById('import-picker-notes');
  notesEl.textContent = notes.join(' · ');
  notesEl.style.display = notes.length ? '' : 'none';
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
  document.getElementById('import-picker-notes').style.display = 'none';
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

// ── Google Authenticator import ─────────────────────────────────────────────

async function decodeQrFromImageFile(file) {
  const bitmap = await createImageBitmap(file);
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(bitmap);
      if (codes.length > 0) return codes[0].rawValue;
    } catch { /* fall through to jsQR */ }
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQR(data, width, height);
  return result ? result.data : null;
}

async function handleGoogleAuthFiles(fileList) {
  const statusEl = document.getElementById('google-import-status');
  statusEl.textContent = 'Decoding…';

  const payloads = [];
  const seenParts = new Set();
  let unrecognized = 0;

  for (const file of fileList) {
    let text = null;
    try { text = await decodeQrFromImageFile(file); } catch { /* unreadable image */ }
    const payload = text && text.startsWith('otpauth-migration://') ? parseMigrationUri(text) : null;
    if (!payload) { unrecognized++; continue; }
    const key = `${payload.batchId}:${payload.batchIndex}`;
    if (seenParts.has(key)) continue;
    seenParts.add(key);
    payloads.push(payload);
  }

  if (payloads.length === 0) {
    statusEl.textContent = 'No Google Authenticator QR code found in the selected image(s).';
    return;
  }

  const allOtp = payloads.flatMap(p => p.otpParameters);
  const totpOnly = allOtp.filter(o => o.type !== 1); // 1 = HOTP, not supported here
  const hotpSkipped = allOtp.length - totpOnly.length;

  // totp.js only ever generates SHA-1, 6-digit codes (like every other import
  // path in this app — see content.js's parseOtpAuthUri). Algorithm 0/1 =
  // UNSPECIFIED/SHA1, digits 0/1 = UNSPECIFIED/SIX; anything else (SHA256/
  // SHA512/MD5, or 8-digit) would silently produce codes the site rejects,
  // so skip those instead of importing a broken account.
  const supported = totpOnly.filter(o => (o.algorithm === 0 || o.algorithm === 1) && (o.digits === 0 || o.digits === 1));
  const unsupportedSkipped = totpOnly.length - supported.length;

  const mapped = supported.map(o => ({
    name: o.issuer || o.name,
    email: o.name,
    secret: base32Encode(o.secret),
    urls: '',
    autofill: true,
  }));

  const batchGroups = new Map(); // batchId -> { batchSize, indices: Set<batchIndex> }
  for (const p of payloads) {
    if (!batchGroups.has(p.batchId)) batchGroups.set(p.batchId, { batchSize: p.batchSize, indices: new Set() });
    batchGroups.get(p.batchId).indices.add(p.batchIndex);
  }

  const notes = [];
  if (unrecognized > 0) notes.push(`${unrecognized} image(s) not recognized`);
  if (hotpSkipped > 0) notes.push(`${hotpSkipped} HOTP account(s) skipped (not supported)`);
  if (unsupportedSkipped > 0) notes.push(`${unsupportedSkipped} account(s) skipped (unsupported algorithm or digit count)`);
  for (const { batchSize, indices } of batchGroups.values()) {
    if (batchSize > 1 && indices.size < batchSize) {
      notes.push(`You selected ${indices.size} of ${batchSize} QR codes from this export — add the rest to get all your accounts`);
    }
  }

  if (mapped.length === 0) {
    statusEl.textContent = notes.concat('No importable accounts found.').join(' · ');
    return;
  }

  showSettingsSubview('settings-list');
  showImportPicker(mapped, notes);
}

document.getElementById('row-settings-google-import').addEventListener('click', () => {
  document.getElementById('google-import-status').textContent = '';
  showSettingsSubview('settings-google-import-view');
});

document.getElementById('google-import-pick').addEventListener('click', () => {
  document.getElementById('google-import-file').click();
});

document.getElementById('google-import-file').addEventListener('change', e => {
  if (!e.target.files.length) return;
  const files = [...e.target.files]; // snapshot — e.target.files is live and would empty on the reset below
  e.target.value = '';
  handleGoogleAuthFiles(files);
});

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
      // Couldn't determine whether the server has data (offline/transient). Don't
      // silently mint a new key (that risks overwriting). Show restore — the user
      // can paste their key or explicitly "Start fresh".
      syncShowView('sv-restore');
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
      requestIcons(); // pick up icons for accounts pulled in from another device
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
      requestIcons(); // pick up icons for accounts merged in from another device
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
let _startFresh = false;
document.getElementById('btn-confirm-newkey').addEventListener('click', async () => {
  syncShowView('sv-active');
  syncSetStatus('syncing', 'Uploading…');
  try {
    await CloudSync.syncUser();
    if (_startFresh) {
      // Overwrite the server blob with the new key directly — do NOT read/merge
      // the existing blob (it was encrypted with a different key and can't be
      // decrypted, which would otherwise fail the whole sync).
      _startFresh = false;
      const now = new Date().toISOString();
      await CloudSync.push(accounts, tombstones, now);
      await writeLastSyncedAt(now);
      syncSetStatus('ok', 'Synced');
    } else {
      await stampLocalChange(); // force initial push so other devices can detect existing sync
      await doSync();
    }
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

// Restore: start fresh (replaces server data with a new key)
document.getElementById('btn-overwrite-server').addEventListener('click', async () => {
  _startFresh = true;
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
  // chrome.storage.local is the source of truth for the theme; the inline
  // <script> right after <body> already applied a localStorage-cached guess
  // so there's no flash — this just confirms it and keeps the cache in sync.
  chrome.storage.local.get('theme', d => applyTheme(d.theme || DEFAULT_THEME));

  const justAuthenticated = await initLock();
  await loadState();
  await syncActiveIndexToUrl();
  renderAccountBar();
  requestIcons(); // resolve+cache site favicons, then re-render when ready
  startTimer();
  if (justAuthenticated) tryAutoFillCurrentTab();
  chrome.storage.local.remove('pendingServerSync');
  // Keep the user row current (plan + team public key) on every open, so a
  // logged-in member can receive shares even before setting up personal sync.
  (async () => {
    try { if (await SupabaseAuth.getSession()) await CloudSync.syncUser(); } catch { /* ignore */ }
  })();
  silentPullSync(); // fire-and-forget
  renderSharedCodes(); // team "Shared with you" section (no-op if not in a team)
  loadMySharedCodes().then(refreshSharedBadges); // "shared with team" badges (owner side)

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

// ── Share an account with the team (from the vault) ─────────────────────────────

// Re-renders the list rows (Home + Accounts) so a share/revoke's effect on the
// "shared" badge shows up immediately. Deliberately does NOT touch #acc-detail:
// renderAccDetail() would tear down and rebuild it, orphaning the very
// .share-picker container a share/revoke handler may still be writing into
// mid-flow. The detail header's own badge catches up next time the row is
// (re)selected — renderAccDetail() always runs then anyway.
function refreshSharedBadges() {
  renderAccountBar();
  if (document.getElementById('settings-panel')?.style.display !== 'none') {
    rebuildAccountsDOM();
  }
}

// The visible-toggle entry point (bound to the "Share with team" button).
async function openSharePicker(container, acc) {
  if (!container) return;
  if (container.style.display !== 'none') { container.style.display = 'none'; return; }
  if (!acc?.secret) { setStatus('This account has no secret to share', false); return; }
  container.style.display = '';
  await renderSharePicker(container, acc);
}

// The actual render, reusable from the revoke handler without re-toggling
// visibility (openSharePicker's toggle is only for the button click).
async function renderSharePicker(container, acc) {
  container.innerHTML = '<div class="share-msg">Loading…</div>';

  const team = await Sharing.getMyTeam().catch(() => null);
  if (!team || !team.id) {
    container.innerHTML = `<div class="share-msg">You're not in a team. <a href="${CONFIG.DASHBOARD_URL}/dashboard/team" target="_blank">Manage team ↗</a></div>`;
    return;
  }

  // Fetch fresh rather than trusting the startup-cached mySharedCodes — the
  // user may have just shared/revoked this exact account from the web
  // dashboard in another tab. A failed fetch must NOT silently fall through
  // to the "not shared" picker — that could let an already-shared account
  // get shared a second time (the server doesn't dedupe shared_codes rows).
  myTeamId = team.id;
  let freshCodes;
  try {
    freshCodes = await Sharing.getMyCodes(team.id);
  } catch {
    container.innerHTML = `<div class="share-msg">Couldn't check sharing status. <a href="#" class="share-retry">Retry ↗</a></div>`;
    container.querySelector('.share-retry').addEventListener('click', e => { e.preventDefault(); renderSharePicker(container, acc); });
    return;
  }
  mySharedCodes = freshCodes;
  const existing = findSharedCode(acc);

  if (existing) {
    const n = existing.recipients ?? 0;
    container.innerHTML = `
      <div class="share-status">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        <span class="share-status-text">Already shared with <b>${n} teammate${n === 1 ? '' : 's'}</b>. Manage individual recipients on the <a href="${CONFIG.DASHBOARD_URL}/dashboard/team" target="_blank" style="color:var(--accent-2)">web dashboard ↗</a>.</span>
        <button type="button" class="btn-share-revoke">Revoke</button>
      </div>`;
    container.querySelector('.btn-share-revoke').addEventListener('click', async () => {
      const ok = await Sharing.revokeCode(team.id, existing.id).catch(() => false);
      if (!ok) { setStatus('Revoke failed', false); return; }
      setStatus(`Stopped sharing "${acc.name}"`);
      mySharedCodes = mySharedCodes.filter(c => c.id !== existing.id);
      refreshSharedBadges();
      renderSharePicker(container, acc); // re-render straight into the normal picker below
    });
    return;
  }

  let myId = null;
  try { myId = (await SupabaseAuth.getSession())?.user?.id ?? null; } catch { /* ignore */ }
  const members = (await Sharing.getMembers(team.id).catch(() => [])).filter(m => m.user_id !== myId);

  if (!members.length) {
    container.innerHTML = `<div class="share-msg">No teammates yet. <a href="${CONFIG.DASHBOARD_URL}/dashboard/team" target="_blank">Invite ↗</a></div>`;
    return;
  }

  container.innerHTML = `<div class="share-recip-list">${members.map(m => `
    <label class="share-recip">
      <input type="checkbox" value="${esc(m.user_id)}" ${m.public_key ? '' : 'disabled'}>
      ${esc(m.email || m.user_id)}${m.public_key ? '' : ' <span class="share-dim">(not set up)</span>'}
    </label>`).join('')}</div>` +
    `<button type="button" class="btn-share-confirm">Share</button>`;

  container.querySelector('.btn-share-confirm').addEventListener('click', async () => {
    const picked = [...container.querySelectorAll('input:checked')].map(cb => cb.value);
    const recipients = members.filter(m => picked.includes(m.user_id));
    if (!recipients.length) { setStatus('Pick at least one teammate', false); return; }
    try {
      const ok = await Sharing.shareCode(team.id, acc.name, acc.email, acc.secret, recipients);
      if (ok) {
        setStatus(`Shared "${acc.name}" ✓`);
        container.style.display = 'none';
        mySharedCodes = await Sharing.getMyCodes(team.id).catch(() => mySharedCodes);
        refreshSharedBadges();
      } else setStatus('Share failed', false);
    } catch (e) {
      setStatus(e?.message || 'Share failed', false);
    }
  });
}

// ── Team panel (nav tab) ────────────────────────────────────────────────────────

async function renderTeamPanel() {
  const nameEl = document.getElementById('team-panel-name');
  const membersEl = document.getElementById('team-members');
  const inviteRow = document.getElementById('team-invite-row');
  document.getElementById('team-web-link').href = CONFIG.DASHBOARD_URL + '/dashboard/team';
  nameEl.textContent = 'Loading…';
  membersEl.innerHTML = '';
  inviteRow.style.display = 'none';

  const team = await Sharing.getMyTeam().catch(() => null);
  if (!team || !team.id) { nameEl.textContent = 'No team'; return; }
  nameEl.textContent = team.name;

  let myId = null;
  try { myId = (await SupabaseAuth.getSession())?.user?.id ?? null; } catch { /* ignore */ }
  const isOwner = team.owner_id === myId;

  const members = await Sharing.getMembers(team.id).catch(() => []);
  membersEl.innerHTML = members.map(m => `
    <div class="acc-overflow-item" style="cursor:default">
      <span class="acc-av acc-av-md" style="background:${accentColor(m.email || m.user_id)}">${esc(nameInitials(m.email || '?'))}</span>
      <span class="acc-overflow-text">
        <span class="acc-overflow-name">${esc(m.email || m.user_id)}${m.user_id === myId ? ' (you)' : ''}</span>
        <span class="acc-overflow-email">${esc(m.role)}</span>
      </span>
    </div>`).join('');

  if (isOwner) {
    inviteRow.style.display = 'flex';
    const btn = document.getElementById('team-invite-btn');
    const input = document.getElementById('team-invite-email');
    btn.onclick = async () => {
      const email = input.value.trim();
      if (!email) return;
      btn.disabled = true;
      try {
        const res = await fetch(`${CONFIG.API_URL}/teams/${team.id}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await SupabaseAuth.getAccessToken()}` },
          body: JSON.stringify({ email }),
        });
        if (res.ok) { input.value = ''; setStatus(`Invited ${email}`); renderTeamPanel(); }
        else {
          const j = await res.json().catch(() => ({}));
          const msg = j.error === 'seat_limit_reached' ? 'Seat limit reached'
            : j.error === 'user_already_in_team' ? 'Already in a team'
            : 'Invite failed';
          setStatus(msg, false);
        }
      } catch { setStatus('Invite failed', false); }
      btn.disabled = false;
    };
  }
}

// ── Team shared codes ("Shared with you") ──────────────────────────────────────

const SVG_REFRESH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`;

let _sharedRefreshTimer = null;

async function renderSharedCodes() {
  if (typeof Sharing === 'undefined') return;
  const section = document.getElementById('shared-section');
  const list = document.getElementById('shared-list');
  if (!section || !list) return;

  let team, codes;
  try {
    team = await Sharing.getMyTeam();
    // Show the Team nav tab whenever the user belongs to a team.
    document.getElementById('nav-team').style.display = (team && team.id) ? '' : 'none';
    if (!team || !team.id) { section.style.display = 'none'; return; }
    // Team name in the sync panel.
    const nameEl = document.getElementById('sync-team-name');
    if (nameEl && team.name) {
      nameEl.innerHTML = `👥 ${esc(team.name)} · <a href="${CONFIG.DASHBOARD_URL}/dashboard/team" target="_blank" style="color:var(--accent-2);text-decoration:none">Manage ↗</a>`;
      nameEl.style.display = '';
    }
    codes = await Sharing.getSharedCodes(team.id);
  } catch { section.style.display = 'none'; return; }

  if (!codes.length) { section.style.display = 'none'; return; }

  // Notify on newly-shared codes (diff against the last known id set).
  try {
    const ids = codes.map(c => c.id).sort();
    const { knownSharedIds = [] } = await new Promise(r => chrome.storage.local.get('knownSharedIds', r));
    const fresh = ids.filter(id => !knownSharedIds.includes(id));
    if (fresh.length && knownSharedIds.length) {
      const c = codes.find(x => x.id === fresh[0]);
      setStatus(`📥 New shared code: ${c?.account_name ?? 'code'}`);
    }
    await new Promise(r => chrome.storage.local.set({ knownSharedIds: ids }, r));
  } catch { /* ignore */ }

  section.style.display = '';
  list.innerHTML = '';

  // Paints a row's code respecting the global obfuscate setting (data-code holds
  // the real value once fetched; Copy still works while hidden).
  const paint = (row) => {
    const code = row.dataset.code || '';
    const el = row.querySelector('.shared-code');
    el.textContent = !code ? '•••••' : (obfuscated ? '••• •••' : code.slice(0, 3) + ' ' + code.slice(3));
  };

  for (const c of codes) {
    const row = document.createElement('div');
    row.className = 'shared-row';
    const sub = [c.account_email, c.owner_email && '↗ ' + c.owner_email].filter(Boolean).join(' · ');
    row.innerHTML = `
      <span class="acc-av" style="background:${accentColor(c.account_name || '')}">${esc(nameInitials(c.account_name))}</span>
      <span class="shared-info">
        <span class="shared-name">${esc(c.account_name)}</span>
        <span class="shared-owner">${esc(sub || 'shared')}</span>
      </span>
      <span class="shared-code">•••••</span>
      <button class="shared-copy" title="Copy">Copy</button>
      <button class="shared-refresh" title="Refresh">${SVG_REFRESH}</button>`;

    // Passive display fetch — no reason → not audited.
    const fetchCode = async (reason) => {
      try {
        const code = await Sharing.requestTotp(team.id, c.id, c.k1, reason);
        row.dataset.code = code || '';
        paint(row);
        return code;
      } catch { return null; }
    };
    row.querySelector('.shared-refresh').addEventListener('click', () => fetchCode('refresh'));
    row.querySelector('.shared-copy').addEventListener('click', async () => {
      const code = await fetchCode('copy'); // audited
      if (!code) { setStatus('Could not fetch code', false); return; }
      try { await navigator.clipboard.writeText(code); setStatus('Copied!'); }
      catch { setStatus('Clipboard unavailable', false); }
    });
    list.appendChild(row);
    fetchCode(); // initial display, no audit
  }

  // Re-paint (not re-fetch) when the obfuscate toggle flips.
  _repaintSharedCodes = () => list.querySelectorAll('.shared-row').forEach(paint);

  // Auto-refresh every 30s on the TOTP boundary while the popup is open (no audit).
  clearInterval(_sharedRefreshTimer);
  _sharedRefreshTimer = setInterval(() => {
    if (Math.floor(Date.now() / 1000) % 30 === 0) renderSharedCodes();
  }, 1000);
}

let _repaintSharedCodes = null;
