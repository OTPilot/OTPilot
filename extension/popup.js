// Storage schema: { accounts: [{name, secret, urls}], activeIndex: 0 }
// The master-password lock lives in vaultLock.js (vault key wrapped at rest,
// unlocked only in chrome.storage.session).

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
// a theme is two steps: 1) a body[data-theme="id"] token block in theme.css
// (same custom-property names as the others), 2) one entry here.
const THEMES = [
  { id: 'original', name: 'Original', desc: 'The classic slate & sky-blue look.',       swatch: ['#0f172a', '#38bdf8'] },
  { id: 'vault',    name: 'Vault',    desc: 'Graphite & brass — precise and premium.', swatch: ['#1c1a17', '#c9a15a'] },
  { id: 'daylight', name: 'Daylight', desc: 'Calm paper-white, forest-green accent.',   swatch: ['#faf9f5', '#2f6f4f'] },
  { id: 'terminal', name: 'Terminal', desc: 'Monospace control panel, cyan accent.',    swatch: ['#0a0e14', '#33c2cf'] },
  { id: 'signal',   name: 'Signal',   desc: 'Bold navy, coral accent, rounded.',        swatch: ['#101b2d', '#ff6a55'] },
];
const DEFAULT_THEME = 'original';

// `persist`: only when the user picks a theme. Applying the stored one at
// startup must not write it back — a theme changed meanwhile (another popup,
// Settings elsewhere) would be overwritten by the value read earlier.
function applyTheme(id, { persist = false } = {}) {
  document.body.dataset.theme = id;
  try { localStorage.setItem('otpilotTheme', id); } catch { /* private mode etc. */ }
  if (persist) chrome.storage.local.set({ theme: id });
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
      applyTheme(t.id, { persist: true });
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

// Ids of the vault items this popup loaded: saveState only deletes those (an
// account added meanwhile from a page isn't in `accounts` and must survive).
let _loadedIds = new Set();

// Vault items that aren't logins (secure notes, servers, API credentials):
// listed and edited in the Vault view next to the logins in `accounts`.
let otherItems = [];

async function loadState() {
  // Accounts live encrypted in the vault (only read once unlocked).
  const key = await VaultKeys.getKey();
  const vaultAccounts = key ? await VaultAccounts.load(key) : [];
  _loadedIds = new Set(vaultAccounts.map(a => a._id));
  otherItems = key ? await VaultAccounts.loadOthers(key) : [];
  return new Promise(r =>
    chrome.storage.local.get(['activeIndex', 'obfuscated', 'userPlan', 'localChangedAt', 'lastSyncedAt', 'tombstones', 'categoryFilter', 'iconCache'], d => {
      accounts       = vaultAccounts;
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

// After "Reset OTPilot on this device" storage is empty and the vault is back
// at first run. A write still in flight from before (a sync finishing its
// request, another open page) must not put data back, so every account/sync
// write goes through this check.
async function deviceWasReset() {
  return (await VaultLock.state()) === 'setup';
}

async function saveState() {
  // Locked (or reset) means no vault key: nothing can be written, and a stale
  // in-memory list mustn't be. Throw, so a sync stops before it records
  // success (lastSyncedAt) for data that was never saved.
  if ((await VaultLock.state()) !== 'unlocked') throw new Error('vault is locked');
  const key = await VaultKeys.getKey();
  await VaultAccounts.save(accounts, key, _loadedIds);
  // Re-read what was stored: entries that came without a password (a 1.x
  // device's blob) keep the vault's, and the list must show it again.
  accounts = await VaultAccounts.load(key);
  _loadedIds = new Set(accounts.map(a => a._id));
  await chrome.storage.local.set({ activeIndex });
}

async function saveTombstones() {
  if (await deviceWasReset()) return;
  await chrome.storage.local.set({ tombstones });
}

async function stampLocalChange() {
  localChangedAt = new Date().toISOString();
  if (await deviceWasReset()) return;
  await chrome.storage.local.set({ localChangedAt });
}

async function writeLastSyncedAt(ts) {
  lastSyncedAt = ts;
  if (await deviceWasReset()) return;
  await chrome.storage.local.set({ lastSyncedAt: ts });
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
// Every tag of an account or vault entry: the category (first tag) plus the
// rest ("More tags").
function tagsOf(a) {
  return [(a.category || '').trim(), ...(a.moreTags || []).map(t => String(t).trim())].filter(Boolean);
}

function getCategories(list = accounts) {
  return [...new Set(list.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b));
}

function categoryCount(name, list = accounts) {
  return list.filter(a => tagsOf(a).includes(name)).length;
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
  return !categoryFilter || tagsOf(acc).includes(categoryFilter);
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
      chrome.storage.local.set({ activeIndex }); // only the selection changed
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

  // Drop the previous account's code and disable Copy/Fill immediately,
  // before any await below — otherwise a click during the brief window while
  // this generation's generateTOTP() is still pending would act on the
  // previous account's still-enabled button and still-cached currentCode.
  // Re-enabled further down only once (and if) this generation wins.
  btnCopy.disabled = true;
  btnFill.disabled = true;
  currentCode = '';

  if (!acc) {
    renderHomeCreds(null);
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
  renderHomeCreds(acc);

  // Only the real site favicon, never the letter-avatar fallback — this is
  // decorative extra space, not a place to render initials twice.
  const bigIconUrl = accountIconDataUrl(acc);
  bigIcon.innerHTML = bigIconUrl ? `<img src="${bigIconUrl}" alt="">` : '';

  if (!acc.secret) {
    display.textContent = 'No 2FA code';
    display.className = 'dim';
    countdown.textContent = acc.password ? '' : 'Add a password or 2FA secret in Accounts';
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

// Username and password under the code. Re-rendered only when the account or
// its values change, not on every timer tick (that would reset Show and eat clicks).
let _homeCredsKey = null;
function renderHomeCreds(acc) {
  const key = acc ? JSON.stringify([acc._id, acc.email || '', acc.password || '']) : '';
  if (key === _homeCredsKey) return;
  _homeCredsKey = key;
  const box = document.getElementById('home-creds');
  box.innerHTML = '';
  if (!acc || (!acc.email && !acc.password)) return;
  const row = (label, value, secret) => {
    const el = document.createElement('div');
    el.className = 'home-cred';
    el.innerHTML = `<div class="home-cred-text"><span class="home-cred-label">${label}</span><span class="home-cred-value"></span></div>`;
    const valueEl = el.querySelector('.home-cred-value');
    const show = shown => { valueEl.textContent = secret && !shown ? '•'.repeat(Math.min(value.length, 14)) : value; };
    show(false);
    if (secret) {
      const eye = document.createElement('button');
      eye.className = 'home-cred-btn';
      eye.title = 'Show/hide';
      eye.innerHTML = SVG_EYE;
      let shown = false;
      eye.addEventListener('click', () => { shown = !shown; show(shown); eye.innerHTML = shown ? SVG_EYE_OFF : SVG_EYE; });
      el.appendChild(eye);
    }
    const copy = document.createElement('button');
    copy.className = 'home-cred-btn';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(value); setStatus(`${label} copied`); }
      catch { setStatus('Could not copy — the browser blocked the clipboard', false); }
    });
    el.appendChild(copy);
    box.appendChild(el);
  };
  if (acc.email) row('Username', acc.email, false);
  if (acc.password) row('Password', acc.password, true);
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
// One-shot flag: the next empty-detail render (no account selected) should
// say "Saved" instead of the generic prompt. Consumed and cleared the first
// time renderAccDetail() reads it, so it never lingers past that one render.
let _justSavedMessage = false;

// `openTargetIdx`, when given, is an index into `accounts` (not the
// alphabetically-sorted `draft`) to open in the detail panel right away —
// used by the "edit this account" shortcut on the Home view. draft entries
// are clones, so the origin index has to be tracked through the sort to
// translate it into draft's index space.
// Bumped each time the editor starts over from the saved list (a new draft).
let _editSession = 0;

// ── Vault entries ──
// The editor's draft holds logins as v1 accounts (see VaultAccounts) and every
// other item as an entry wrapping it: { _kind: 'item', _id, type, name,
// category, moreTags, email (the row's summary line), item }. Save splits them.
const isItemEntry = e => e?._kind === 'item';
// Items of a team collection: { _kind: 'shared', cid, collection, …entry }.
// Listed with the rest but saved straight to their collection, never by Save.
const isSharedEntry = e => e?._kind === 'shared';
const isLoginEntry = e => !e?._kind; // a personal login (v1 account)
const entryType = e => (e?._kind ? e.type : 'login');
const typeLabel = type => Vault.TYPES[type]?.label || type;
// The fields that summarize an item on its row.
const ITEM_SUMMARY = { server: ['host', 'username'], api: ['environment', 'clientId'] };
let typeFilter = ''; // '' = every type

function itemSummary(item) {
  return (ITEM_SUMMARY[item.type] || []).map(id => Vault.getValue(item, id)).filter(Boolean).join(' · ');
}

function entryOf(item) {
  const tags = item.tags || [];
  return {
    _kind: 'item', _id: item.id, type: item.type, name: item.title || '',
    category: tags[0] || '', moreTags: tags.slice(1), email: itemSummary(item), item: structuredClone(item),
  };
}

function itemOfEntry(entry) {
  const item = structuredClone(entry.item);
  item.title = entry.name;
  item.tags = VaultAccounts.normalizeTags([entry.category, ...(entry.moreTags || [])]);
  return item;
}

const parseTags = text => VaultAccounts.normalizeTags(String(text || '').split(','));

// ── Team collections in the vault ──
let collections = [];  // VaultCollections.list()
let sharedItems = [];  // [{ collection, item, revision }]

// `_baseRev`: the revision this entry shows, which its save is based on.
function sharedEntryOf({ collection, item, revision }) {
  return { ...entryOf(item), _kind: 'shared', cid: collection.id, collectionName: collection.name || 'Shared', role: collection.role, _baseRev: revision };
}

// Pulls every collection this user is in and redraws (team plans only; a
// failure, e.g. offline, keeps what was shown).
async function refreshSharedItems() {
  const { userPlan } = await chrome.storage.local.get('userPlan');
  if (!['team_lite', 'team_pro'].includes(userPlan)) { collections = []; sharedItems = []; return; }
  let list;
  try { list = await VaultCollections.list(); } catch { return; }
  const out = [];
  for (const c of list) {
    if (!c.key) continue;
    try { await VaultCollections.pull(c); } catch { /* offline: local copy */ }
    for (const { item, revision } of await VaultCollections.snapshot(c)) out.push({ collection: c, item, revision });
  }
  collections = list;
  sharedItems = out;
  refreshAccountsUI();
}

function renderAccountsList(openTargetIdx = -1, { preserveSearch = false } = {}) {
  _editSession++;
  const withOrigin = [
    ...accounts.map((a, i) => ({ acc: { ...a }, origIdx: i })),
    ...otherItems.map(item => ({ acc: entryOf(item), origIdx: -1 })),
    ...sharedItems.map(s => ({ acc: sharedEntryOf(s), origIdx: -1 })),
  ];
  withOrigin.sort((x, y) => (x.acc.name || '').localeCompare(y.acc.name || ''));
  draft = withOrigin.map(w => w.acc);
  _draftBase = structuredClone(draft);
  openAccIdx = openTargetIdx >= 0 ? withOrigin.findIndex(w => w.origIdx === openTargetIdx) : -1;
  if (!preserveSearch) document.getElementById('acc-search').value = '';
  // A leftover category filter from a previous Accounts-view visit could hide
  // the very row we're jumping to — clear it so the shortcut always lands
  // somewhere visible.
  if (openAccIdx >= 0 && categoryFilter) {
    categoryFilter = '';
    chrome.storage.local.set({ categoryFilter });
  }
  renderVaultTypeBar();
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
  const entry = draft[openAccIdx];
  if (isSharedEntry(entry) && entry.role === 'view') return; // read-only: nothing to read back
  entry.category = (body.querySelector('.cat-choose')?.dataset.value || '').trim();
  entry.moreTags = parseTags(body.querySelector('.acc-more-tags')?.value).filter(t => t !== entry.category);
  if (entry._kind) {
    entry.name = body.querySelector('.item-title').value.trim();
    const urls = body.querySelector('.item-urls');
    if (urls) entry.item.urls = urls.value.split('\n').map(u => u.trim()).filter(Boolean);
    const secret = body.querySelector('.item-totp');
    if (secret?.dataset.dirty) entry.item.totp = secret.value.trim() ? { ...(entry.item.totp || { digits: 6, period: 30, algorithm: 'SHA1' }), secret: secret.value.trim() } : null;
    // Only fields the user changed: an input can't always hold a stored
    // value exactly (a date in another format, a newer version's kind).
    body.querySelectorAll('.item-field[data-dirty]').forEach(inp => {
      const field = Vault.getField(entry.item, inp.dataset.id);
      if (field) field.value = inp.value;
    });
    entry.item.notes = body.querySelector('.item-notes').value;
    entry.item = VaultAccounts.withCustomFields(entry.item, readCustomFields(body));
    entry.email = itemSummary(entry.item);
    return;
  }
  draft[openAccIdx].name     = body.querySelector('.acc-name').value.trim();
  draft[openAccIdx].email    = body.querySelector('.acc-email').value.trim();
  draft[openAccIdx].password = body.querySelector('.acc-password').value;
  draft[openAccIdx].secret   = body.querySelector('.acc-secret').value.trim();
  draft[openAccIdx].urls     = body.querySelector('.acc-urls').value.trim();
  draft[openAccIdx].autofill = body.querySelector('.acc-autofill').checked;
  draft[openAccIdx].notes    = body.querySelector('.acc-notes').value;
  draft[openAccIdx].customFields = readCustomFields(body);
}

function updateVaultCount() {
  const rows = document.querySelectorAll('.acc-row');
  const visible = [...rows].filter(r => r.style.display !== 'none').length;
  const total = draft.length;
  const noun = draft.some(e => e._kind) ? 'item' : 'account';
  const el = document.getElementById('acc-count');
  if (el) el.textContent = visible === total
    ? `${total} ${noun}${total !== 1 ? 's' : ''}`
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
    const catMatch = !categoryFilter || tagsOf(acc).includes(categoryFilter);
    const typeMatch = !typeFilter || entryType(acc) === typeFilter;
    row.style.display = (textMatch && catMatch && typeMatch) ? '' : 'none';
  });
  updateVaultCount();
}

// Type filter (All · Logins · Secure notes · …): shown once the vault holds
// more than one type.
function renderVaultTypeBar() {
  const bar = document.getElementById('vault-type-bar');
  const types = [...new Set(draft.map(entryType))];
  if (typeFilter && !types.includes(typeFilter)) typeFilter = '';
  if (types.length < 2) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = '';
  const order = Object.keys(Vault.TYPES);
  const options = [['', 'All', draft.length],
    ...types.sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .map(t => [t, `${typeLabel(t)}s`, draft.filter(e => entryType(e) === t).length])];
  for (const [value, label, count] of options) {
    const pill = document.createElement('button');
    pill.className = 'cat-pill type-pill' + (typeFilter === value ? ' active' : '');
    pill.dataset.type = value;
    pill.innerHTML = `${esc(label)} <span class="count">${count}</span>`;
    pill.addEventListener('click', () => { typeFilter = value; renderVaultTypeBar(); applyVaultSearch(); });
    bar.appendChild(pill);
  }
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
    const item = !!acc._kind;
    head.innerHTML = `
      ${avatarHTML(acc, 'acc-av-md')}
      <span class="acc-head-text">
        <span class="acc-head-name">${esc(acc.name) || (item ? esc(`Untitled ${typeLabel(acc.type).toLowerCase()}`) : `Account ${i + 1}`)}${item ? '' : sharedBadgeHTML(findSharedCode(acc))}</span>
        ${cat || acc.email || item ? `<span class="acc-head-sub">
          ${item ? `<span class="type-tag">${esc(typeLabel(acc.type))}</span>` : ''}
          ${isSharedEntry(acc) ? `<span class="type-tag shared-tag">Shared · ${esc(acc.collectionName)}</span>` : ''}
          ${cat ? `<span class="cat-tag">${catDot(cat)}${esc(cat)}</span>` : ''}
          ${acc.email ? `<span class="acc-head-email">${esc(acc.email)}</span>` : ''}
        </span>` : ''}
      </span>`;

    head.addEventListener('click', () => {
      syncOpenAccToDraft();
      openAccIdx = i;
      rebuildAccountsDOM();
      renderVaultTypeBar();
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
    const justSaved = _justSavedMessage;
    _justSavedMessage = false;
    container.innerHTML = `<div class="dc-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16"/></svg>
      ${justSaved ? '✓ Saved — select an account to edit, or add a new one' : 'Select an account to edit, or add a new one'}
    </div>`;
    return;
  }

  if (acc._kind) { renderItemDetail(container, acc); return; }

  // "2FA code" (from + Add) opens the same login editor in a compact form:
  // the 2FA secret first, the password behind "+ Add password". Saved, it's
  // a regular login (and, with only a 2FA code, doesn't count toward Free).
  const compact = !!acc._compact;
  // Shown once it has a password or the user asked for it (kept while editing).
  const hidePassword = compact && !acc.password && !acc._showPassword;
  const nameField = `
    <div class="acc-field">
      <label>Name</label>
      <input class="acc-name" type="text" placeholder="${compact ? 'e.g. GitHub' : 'e.g. My Project QA'}" value="${esc(acc.name)}">
    </div>`;
  const userField = `
    <div class="acc-field">
      <label>Username or email (optional)</label>
      <input class="acc-email" type="text" placeholder="e.g. user@example.com" value="${esc(acc.email || '')}">
    </div>`;
  const passwordField = `
    <div class="acc-field acc-password-field"${hidePassword ? ' style="display:none"' : ''}>
      <label>Password (optional)</label>
      <div class="field-row">
        <input class="acc-password" type="password" placeholder="Password" value="${esc(acc.password || '')}" autocomplete="new-password">
        <button class="btn-eye" title="Show/hide">${SVG_EYE}</button>
        <button class="btn-eye btn-gen-password" title="Generate a password">⟳</button>
      </div>
    </div>
    ${hidePassword ? '<button type="button" class="coll-link btn-add-password">+ Add password</button>' : ''}`;
  const secretField = `
    <div class="acc-field">
      <label>${compact ? '2FA secret or otpauth:// link' : '2FA secret (optional, base32 or hex)'}</label>
      <div class="field-row">
        <input class="acc-secret" type="password" placeholder="${compact ? 'Paste the setup key or otpauth:// link' : 'Secret'}" value="${esc(acc.secret)}" autocomplete="off">
        <button class="btn-eye" title="Show/hide">${SVG_EYE}</button>
      </div>
    </div>`;
  const urlsField = `
    <div class="acc-field">
      <label>${compact ? 'Site (optional, for auto-fill)' : 'URLs (one per line, * wildcard ok)'}</label>
      <textarea class="acc-urls" placeholder="*.example.com&#10;staging.myapp.io">
${esc(acc.urls || '')}</textarea>
    </div>`;
  const notesField = `
    <div class="acc-field">
      <label>Notes</label>
      <textarea class="acc-notes" placeholder="Anything else worth keeping: recovery codes, security answers…">
${esc(acc.notes || '')}</textarea>
    </div>`;
  const extras = notesField + customFieldsHTML(acc.customFields);
  const body = document.createElement('div');
  body.className = 'acc-body open';
  body.innerHTML = `
    <div class="acc-body-head">
      <span class="acc-body-title">${esc(acc.name) || (compact ? 'New 2FA code' : `Account ${openAccIdx + 1}`)}${sharedBadgeHTML(findSharedCode(acc))}</span>
      <span class="acc-head-actions">
        ${acc._id && _draftBase.some(b => b._id === acc._id) ? '<button class="btn-del btn-merge" title="Merge another login into this one">⇄ Merge</button>' : ''}
        <button class="btn-del" title="Delete account">✕ Delete</button>
      </span>
    </div>
    ${compact
      ? nameField + secretField + userField + urlsField + passwordField + tagFieldsHTML(acc) + extras
      : nameField + userField + passwordField + tagFieldsHTML(acc) + secretField + urlsField + extras}
    <label class="toggle">
      <input type="checkbox" class="acc-autofill" ${acc.autofill !== false ? 'checked' : ''}>
      <span class="toggle-track"></span>
      <span class="toggle-label">Auto-fill on matching pages</span>
    </label>
    <div class="acc-share">
      <button type="button" class="btn-share-team">↗ Share with team</button>
      <div class="share-picker" style="display:none"></div>
    </div>
    ${collectionControlsHTML(acc)}`;

  body.querySelector('.btn-add-password')?.addEventListener('click', e => {
    acc._showPassword = true;
    body.querySelector('.acc-password-field').style.display = '';
    e.currentTarget.remove();
    body.querySelector('.acc-password').focus();
  });
  // A pasted otpauth:// link fills in the secret, and the name and username
  // when they're still empty.
  body.querySelector('.acc-secret').addEventListener('input', e => {
    const parsed = parseOtpauth(e.target.value);
    if (!parsed) return;
    if (parsed.unsupported || parsed.invalid) {
      e.target.value = '';
      setStatus(parsed.invalid ? 'That otpauth:// link is malformed' : 'That code uses settings OTPilot can\'t generate (only 6-digit, 30-second codes)', false);
      return;
    }
    e.target.value = parsed.secret;
    const name = body.querySelector('.acc-name');
    const user = body.querySelector('.acc-email');
    if (!name.value.trim() && parsed.issuer) { name.value = parsed.issuer; name.dispatchEvent(new Event('input')); }
    if (!user.value.trim() && parsed.account) user.value = parsed.account;
  });

  body.querySelector('.btn-merge')?.addEventListener('click', () => openMergePanel(body, openAccIdx));

  body.querySelector('.btn-del:not(.btn-merge)').addEventListener('click', () => {
    syncOpenAccToDraft(); // pick up an in-progress name edit before naming it in the prompt
    const name = draft[openAccIdx].name || `Account ${openAccIdx + 1}`;
    if (!confirm(`Delete "${name}"? This can't be undone once you save.`)) return;
    draft.splice(openAccIdx, 1);
    openAccIdx = -1;
    rebuildAccountsDOM();
    renderVaultTypeBar();
    renderVaultCatBar();
    applyVaultSearch();
    renderAccDetail();
  });

  // Custom-field rows wire their own buttons (mountCustomFields).
  body.querySelectorAll('.btn-eye:not(.btn-gen-password)').forEach(b => !b.closest('.cf-row') && b.addEventListener('click', e => {
    const btn = e.currentTarget;
    const inp = btn.parentElement.querySelector('input');
    const reveal = inp.type === 'password';
    inp.type = reveal ? 'text' : 'password';
    btn.innerHTML = reveal ? SVG_EYE_OFF : SVG_EYE;
  }));

  // Fills a new password with the Generate view's settings, shown so the user sees what they got.
  body.querySelector('.btn-gen-password').addEventListener('click', async () => {
    const { generatorOptions } = await chrome.storage.local.get('generatorOptions');
    const inp = body.querySelector('.acc-password');
    inp.value = Generator.generate({ ...generatorOptions, mode: 'password' });
    inp.type = 'text';
    inp.parentElement.querySelector('.btn-eye:not(.btn-gen-password)').innerHTML = SVG_EYE_OFF;
  });

  // Live-update the list row's name/email as you type, without a full
  // syncOpenAccToDraft()+rebuild — that would steal focus from the input.
  const idx = openAccIdx;
  body.querySelector('.acc-name').addEventListener('input', e => {
    const head = document.querySelector(`.acc-row[data-i="${idx}"] .acc-head-name`);
    if (head) head.innerHTML = esc(e.target.value.trim() || `Account ${idx + 1}`) + sharedBadgeHTML(findSharedCode(draft[idx]));
  });

  mountCollectionControls(body, acc);

  // ── Share with team ──
  body.querySelector('.btn-share-team').addEventListener('click', () => {
    syncOpenAccToDraft();
    openSharePicker(body.querySelector('.share-picker'), draft[idx]);
  });

  mountCategoryChooser(body);
  mountCustomFields(body);

  container.innerHTML = '';
  container.appendChild(body);
}

// ── Merging two logins ──
// The fields where two logins disagree (both set, different); an empty side
// just takes the other's value. `secret` ones are shown masked.
const MERGE_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Username' },
  { key: 'password', label: 'Password', secret: true },
  { key: 'secret', label: '2FA secret', secret: true },
  { key: 'notes', label: 'Notes', both: true },
  { key: 'autofill', label: 'Auto-fill' },
];

// Empty: nothing at all for a password (spaces can be part of one), blank
// for the rest.
const mergeEmpty = (key, v) => (key === 'password' ? (v ?? '') === '' : String(v ?? '').trim() === '');

function mergeConflicts(a, b) {
  return MERGE_FIELDS.filter(f => {
    const x = a[f.key], y = b[f.key];
    if (f.key === 'autofill') return (x !== false) !== (y !== false);
    return !mergeEmpty(f.key, x) && !mergeEmpty(f.key, y) && String(x) !== String(y);
  });
}

// `b` merged into `a` (which keeps its id): `choice[key]` is 'a', 'b' or —
// for notes — 'both' where they disagree. URLs, tags and custom fields are
// joined. Every password left behind — either login's current one, ones a
// previous merge already set aside, the other login's history — goes to
// this one's history, except `stored` (`a`'s saved password, which Save
// moves to the history itself when it changes).
function mergeLogins(a, b, choice = {}, { stored } = {}) {
  const pick = key => {
    const x = a[key], y = b[key];
    if (key === 'autofill') return (choice[key] === 'b' ? y : x) !== false;
    if (mergeEmpty(key, x)) return y ?? '';
    if (mergeEmpty(key, y)) return x;
    if (String(x) === String(y)) return x;
    if (key === 'notes' && (choice.notes ?? 'both') === 'both') return `${x}\n\n${y}`;
    return choice[key] === 'b' ? y : x;
  };
  const lines = s => String(s || '').split('\n').map(u => u.trim()).filter(Boolean);
  const urls = [];
  for (const u of [...lines(a.urls), ...lines(b.urls)]) if (!urls.some(v => v.toLowerCase() === u.toLowerCase())) urls.push(u);
  const category = a.category || b.category || '';
  const tags = [...new Set([a.category, ...(a.moreTags || []), b.category, ...(b.moreTags || [])].map(t => String(t || '').trim()).filter(Boolean))];
  const custom = [...(a.customFields || [])];
  for (const f of b.customFields || []) {
    // The same field on both: one copy, hidden if either side hid it.
    const same = custom.find(c => c.label === f.label && c.value === f.value);
    if (!same) custom.push({ ...f, id: undefined });
    else if (Vault.SECRET_KINDS.includes(f.kind) && !Vault.SECRET_KINDS.includes(same.kind)) custom[custom.indexOf(same)] = { ...same, kind: f.kind };
  }
  const password = pick('password');
  const left = [...new Set([a.password, b.password, ...(a.extraPasswordHistory || []), ...(b.extraPasswordHistory || []), ...(b._history || [])])]
    .filter(p => p && p !== password && p !== stored && !(a._history || []).includes(p));
  return {
    ...a,
    name: pick('name'), email: pick('email'), password, secret: pick('secret'), notes: pick('notes'),
    autofill: pick('autofill'), urls: urls.join('\n'), category, moreTags: tags.filter(t => t !== category),
    customFields: custom, domain: a.domain || b.domain,
    extraPasswordHistory: left,
  };
}

// The merge panel inside a login's editor: pick the other login, settle the
// fields that disagree, then Merge (the other login leaves the list; nothing
// is written until Save, like every other edit).
function openMergePanel(body, idx) {
  const a = draft[idx];
  const others = draft.filter((e, i) => i !== idx && isLoginEntry(e) && e._id && _draftBase.some(b => b._id === e._id));
  if (!others.length) { setStatus('There is no other login to merge with', false); return; }
  const dom = accountIconDomain(a);
  others.sort((x, y) => (accountIconDomain(y) === dom) - (accountIconDomain(x) === dom) || (x.name || '').localeCompare(y.name || ''));
  body.querySelector('.merge-panel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'merge-panel';
  panel.innerHTML = `
    <div class="merge-title">Merge another login into this one</div>
    <select class="merge-target">${others.map(o => `<option value="${esc(o._id)}">${esc(o.name || 'Untitled')}${o.email ? ` — ${esc(o.email)}` : ''}</option>`).join('')}</select>
    <div class="merge-conflicts"></div>
    <div class="merge-actions">
      <button type="button" class="btn-crypto-ok merge-apply">Merge</button>
      <button type="button" class="btn-del merge-cancel">Cancel</button>
    </div>`;
  body.querySelector('.acc-body-head').after(panel);
  const target = () => others.find(o => o._id === panel.querySelector('.merge-target').value);
  const show = (f, v) => (f.key === 'autofill' ? (v !== false ? 'On' : 'Off') : String(v ?? ''));
  const cell = (f, v) => (f.secret
    ? `<span class="merge-secret" data-value="${esc(show(f, v))}">${'•'.repeat(10)}</span>`
    : `<span>${esc(show(f, v))}</span>`);
  // What the choices on screen were made for: Merge re-checks it, since the
  // editor can change while the panel is open.
  let shownFor = '';
  const conflictKey = list => JSON.stringify(list.map(f => [f.key, String(draft[idx][f.key] ?? ''), String(target()[f.key] ?? '')]));
  const renderConflicts = () => {
    syncOpenAccToDraft();
    const b = target();
    const list = mergeConflicts(draft[idx], b);
    shownFor = conflictKey(list);
    const box = panel.querySelector('.merge-conflicts');
    box.innerHTML = list.length
      ? '<div class="merge-hint">These differ — choose what stays. Everything else (URLs, tags, custom fields, empty fields) is combined.</div>' + list.map(f => `
        <div class="merge-row" data-key="${f.key}">
          <div class="merge-label">${esc(f.label)}${f.secret ? ` <button type="button" class="coll-link merge-reveal">Show</button>` : ''}</div>
          <label><input type="radio" name="m-${f.key}" value="a" ${f.both ? '' : 'checked'}> ${cell(f, draft[idx][f.key])} <em>this one</em></label>
          <label><input type="radio" name="m-${f.key}" value="b"> ${cell(f, b[f.key])} <em>${esc(b.name || 'other')}</em></label>
          ${f.both ? '<label><input type="radio" name="m-' + f.key + '" value="both" checked> <span>Keep both</span></label>' : ''}
        </div>`).join('')
      : '<div class="merge-hint">Nothing conflicts: the other login\'s details are added to this one.</div>';
    // Show / hide both values of a password or 2FA row, to tell them apart.
    box.querySelectorAll('.merge-reveal').forEach(btn => btn.addEventListener('click', () => {
      const shown = btn.textContent === 'Hide';
      btn.textContent = shown ? 'Show' : 'Hide';
      btn.closest('.merge-row').querySelectorAll('.merge-secret').forEach(s => { s.textContent = shown ? '•'.repeat(10) : s.dataset.value; });
    }));
  };
  panel.querySelector('.merge-target').addEventListener('change', renderConflicts);
  panel.querySelector('.merge-cancel').addEventListener('click', () => panel.remove());
  panel.querySelector('.merge-apply').addEventListener('click', () => {
    syncOpenAccToDraft();
    const b = target();
    if (conflictKey(mergeConflicts(draft[idx], b)) !== shownFor) {
      // Something changed in the editor since the choices were shown.
      renderConflicts();
      setStatus('The login changed — review the choices, then Merge', false);
      return;
    }
    const choice = Object.fromEntries([...panel.querySelectorAll('.merge-row')].map(r => [r.dataset.key, r.querySelector('input:checked')?.value || 'a']));
    const merged = mergeLogins(draft[idx], b, choice, { stored: _draftBase.find(x => x._id === draft[idx]._id)?.password });
    const bIdx = draft.indexOf(b);
    draft[idx] = merged;
    draft.splice(bIdx, 1);
    openAccIdx = draft.indexOf(merged);
    rebuildAccountsDOM();
    renderVaultTypeBar();
    renderVaultCatBar();
    applyVaultSearch();
    renderAccDetail();
    setStatus(`Merged "${b.name || 'login'}" into "${merged.name || 'login'}" — Save to keep it`);
  });
  renderConflicts();
}

// ── Custom fields (every editor) ──
// The user's own label + value rows on an item; "Hidden" ones are masked with
// show/copy. Read back with readCustomFields().
// The field's kind is kept as it is (hidden, multiline, a newer version's…)
// unless the user switches it with the 🔒 button (then text ⇄ password).
function customFieldRowHTML(f = {}) {
  const kind = f.kind || 'text';
  const hidden = Vault.SECRET_KINDS.includes(kind);
  const value = esc(f.value ?? '');
  // A new row gets its id now: reading the form twice (Save re-reads it)
  // must give the same fields.
  return `<div class="cf-row" data-id="${esc(f.id || `c-${crypto.randomUUID()}`)}" data-kind="${esc(kind)}">
    <input class="cf-label" type="text" placeholder="Label" value="${esc(f.label || '')}" maxlength="60">
    <div class="field-row">
      ${kind === 'multiline'
        ? `<textarea class="cf-value" placeholder="Value">
${value}</textarea>`
        : `<input class="cf-value" type="${hidden ? 'password' : 'text'}" placeholder="Value" value="${value}" autocomplete="off">`}
      ${hidden ? `<button type="button" class="btn-eye cf-eye" title="Show/hide">${SVG_EYE}</button>` : ''}
      <button type="button" class="btn-eye cf-copy" title="Copy">⧉</button>
      <button type="button" class="btn-eye cf-hide${hidden ? ' on' : ''}" title="${hidden ? 'Hidden — click to show it as plain text' : 'Plain text — click to hide it'}">${hidden ? '🔒' : '🔓'}</button>
      <button type="button" class="btn-eye cf-del" title="Remove">✕</button>
    </div>
  </div>`;
}

function customFieldsHTML(fields, readOnly = false) {
  return `<div class="acc-field cf-section">
    <label>Custom fields</label>
    <div class="cf-list">${(fields || []).map(customFieldRowHTML).join('')}</div>
    ${readOnly ? '' : '<button type="button" class="coll-link cf-add">+ Add field</button>'}
  </div>`;
}

function readCustomFields(body) {
  return [...body.querySelectorAll('.cf-row')].map(row => ({
    id: row.dataset.id,
    label: row.querySelector('.cf-label').value.trim(),
    value: row.querySelector('.cf-value').value,
    kind: row.dataset.kind || 'text',
  })).filter(f => f.label || f.value);
}

function mountCustomFields(body) {
  const list = body.querySelector('.cf-list');
  if (!list) return;
  const wire = row => {
    row.querySelector('.cf-eye')?.addEventListener('click', e => {
      const inp = row.querySelector('.cf-value');
      const reveal = inp.type === 'password';
      inp.type = reveal ? 'text' : 'password';
      e.currentTarget.innerHTML = reveal ? SVG_EYE_OFF : SVG_EYE;
    });
    row.querySelector('.cf-copy')?.addEventListener('click', async () => {
      if (await copyText(row.querySelector('.cf-value').value)) setStatus('Copied');
    });
    row.querySelector('.cf-hide')?.addEventListener('click', () => {
      const f = { id: row.dataset.id, label: row.querySelector('.cf-label').value, value: row.querySelector('.cf-value').value };
      f.kind = Vault.SECRET_KINDS.includes(row.dataset.kind) ? 'text' : 'password';
      const tmp = document.createElement('template');
      tmp.innerHTML = customFieldRowHTML(f);
      const next = tmp.content.firstElementChild;
      row.replaceWith(next);
      wire(next);
    });
    row.querySelector('.cf-del')?.addEventListener('click', () => row.remove());
  };
  list.querySelectorAll('.cf-row').forEach(wire);
  body.querySelector('.cf-add')?.addEventListener('click', () => {
    const tmp = document.createElement('template');
    tmp.innerHTML = customFieldRowHTML();
    const row = tmp.content.firstElementChild;
    list.appendChild(row);
    wire(row);
    row.querySelector('.cf-label').focus();
  });
}

// The category (first tag) chooser plus "More tags", shared by every editor.
function tagFieldsHTML(entry) {
  const cat = (entry.category || '').trim();
  return `
    <div class="acc-field">
      <label>Category</label>
      <div class="cat-choose" data-value="${esc(cat)}">
        <button type="button" class="cat-choice${cat ? '' : ' sel'}" data-cat=""><span class="cat-dot" style="background:var(--ink-4)"></span>None</button>
        ${draftCategories().map(c => `<button type="button" class="cat-choice${cat === c ? ' sel' : ''}" data-cat="${esc(c)}">${catDot(c)}${esc(c)}</button>`).join('')}
        <button type="button" class="cat-choice new">+ New</button>
      </div>
    </div>
    <div class="acc-field">
      <label>More tags (comma separated)</label>
      <input class="acc-more-tags" type="text" placeholder="e.g. client-x, infra" value="${esc((entry.moreTags || []).join(', '))}">
    </div>`;
}

function mountCategoryChooser(body) {
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
}

// Editor for a non-login item, built from its fields (the type's template,
// plus any field it carries that this version doesn't know — kept as text).
// Secret kinds are masked with show/copy; password kinds can be generated.
function renderItemDetail(container, entry) {
  const idx = openAccIdx;
  const item = entry.item;
  const fieldHTML = f => {
    const id = esc(f.id);
    const val = esc(String(f.value ?? ''));
    const secret = Vault.SECRET_KINDS.includes(f.kind);
    let input;
    const known = Vault.FIELD_KINDS.includes(f.kind);
    if (f.kind === 'multiline' || !known) input = `<textarea class="item-field" data-id="${id}">
${val}</textarea>`;
    else if (f.kind === 'date') input = `<input class="item-field" data-id="${id}" type="date" value="${val}">`;
    else input = `<input class="item-field" data-id="${id}" type="${secret ? 'password' : 'text'}" value="${val}" autocomplete="off">`;
    return `<div class="acc-field">
      <label>${esc(f.label || f.id)}</label>
      <div class="field-row">
        ${input}
        ${secret ? `<button class="btn-eye" title="Show/hide">${SVG_EYE}</button>` : ''}
        ${f.kind === 'password' ? '<button class="btn-eye btn-gen-password" title="Generate">⟳</button>' : ''}
        ${f.kind === 'multiline' ? '' : '<button class="btn-eye btn-copy-field" title="Copy">⧉</button>'}
      </div>
    </div>`;
  };
  const body = document.createElement('div');
  body.className = 'acc-body open item-body';
  body.dataset.type = entry.type;
  body.innerHTML = `
    <div class="acc-body-head">
      <span class="acc-body-title">${esc(entry.name) || esc(`Untitled ${typeLabel(entry.type).toLowerCase()}`)}</span>
      <span class="type-tag">${esc(typeLabel(entry.type))}</span>
      <button class="btn-del" title="Delete">✕ Delete</button>
    </div>
    <div class="acc-field">
      <label>Name</label>
      <input class="item-title" type="text" placeholder="${esc(typeLabel(entry.type))} name" value="${esc(entry.name)}">
    </div>
    ${(item.fields || []).filter(f => !f.custom).map(fieldHTML).join('')}
    ${Vault.TYPES[entry.type]?.urls ? `
    <div class="acc-field">
      <label>2FA secret (optional, base32 or hex)</label>
      <div class="field-row">
        <input class="item-totp" type="password" value="${esc(item.totp?.secret || '')}" autocomplete="off">
        <button class="btn-eye btn-eye-totp" title="Show/hide">${SVG_EYE}</button>
      </div>
    </div>
    <div class="acc-field">
      <label>URLs (one per line, * wildcard ok)</label>
      <textarea class="item-urls">
${esc((item.urls || []).join('\n'))}</textarea>
    </div>` : ''}
    <div class="acc-field">
      <label>Notes</label>
      <textarea class="item-notes" placeholder="${entry.type === 'note' ? 'Write your note' : 'Anything else worth keeping'}">
${esc(item.notes || '')}</textarea>
    </div>
    ${customFieldsHTML(VaultAccounts.customFieldsOf(item), isSharedEntry(entry) && entry.role === 'view')}
    ${tagFieldsHTML(entry)}
    ${collectionControlsHTML(entry)}`;

  body.querySelectorAll('.item-field').forEach(inp => inp.addEventListener('input', () => { inp.dataset.dirty = '1'; }));
  const shared = isSharedEntry(entry);
  if (shared) {
    body.querySelector('.acc-body-head .type-tag').textContent = `Shared · ${entry.collectionName}`;
    if (entry.role === 'view') {
      body.querySelectorAll('input, textarea').forEach(el => { el.readOnly = true; });
      body.querySelectorAll('.cat-choice').forEach(el => { el.disabled = true; });
      body.querySelectorAll('.btn-gen-password, .btn-del, .cf-del, .cf-hide, .cf-add').forEach(el => el.remove());
    }
  }
  body.querySelector('.item-totp')?.addEventListener('input', e => { e.target.dataset.dirty = '1'; });
  body.querySelector('.btn-eye-totp')?.addEventListener('click', e => {
    const inp = body.querySelector('.item-totp');
    const reveal = inp.type === 'password';
    inp.type = reveal ? 'text' : 'password';
    e.currentTarget.innerHTML = reveal ? SVG_EYE_OFF : SVG_EYE;
  });
  mountCollectionControls(body, entry);

  body.querySelector('.btn-del')?.addEventListener('click', async () => {
    syncOpenAccToDraft();
    if (shared) {
      if (!confirm(`Delete "${draft[idx].name}" from "${entry.collectionName}" for everyone in it?`)) return;
      await deleteSharedEntry(entry);
      return;
    }
    const name = draft[idx].name || `this ${typeLabel(entry.type).toLowerCase()}`;
    if (!confirm(`Delete "${name}"? This can't be undone once you save.`)) return;
    draft.splice(idx, 1);
    openAccIdx = -1;
    rebuildAccountsDOM();
    renderVaultTypeBar();
    renderVaultCatBar();
    applyVaultSearch();
    renderAccDetail();
  });
  body.querySelectorAll('.btn-eye:not(.btn-gen-password):not(.btn-copy-field):not(.btn-eye-totp)').forEach(b => !b.closest('.cf-row') && b.addEventListener('click', e => {
    const btn = e.currentTarget;
    const inp = btn.parentElement.querySelector('.item-field');
    const reveal = inp.type === 'password';
    inp.type = reveal ? 'text' : 'password';
    btn.innerHTML = reveal ? SVG_EYE_OFF : SVG_EYE;
  }));
  body.querySelectorAll('.btn-gen-password').forEach(b => b.addEventListener('click', async () => {
    const inp = b.parentElement.querySelector('.item-field');
    const { generatorOptions } = await chrome.storage.local.get('generatorOptions');
    inp.value = Generator.generate({ ...generatorOptions, mode: 'password' });
    inp.dataset.dirty = '1';
    inp.type = 'text';
  }));
  body.querySelectorAll('.btn-copy-field').forEach(b => b.addEventListener('click', async () => {
    const inp = b.parentElement.querySelector('.item-field');
    if (inp.value && await copyText(inp.value)) setStatus('Copied');
  }));
  body.querySelector('.item-title').addEventListener('input', e => {
    const head = document.querySelector(`.acc-row[data-i="${idx}"] .acc-head-name`);
    if (head) head.textContent = e.target.value.trim() || `Untitled ${typeLabel(entry.type).toLowerCase()}`;
  });
  mountCategoryChooser(body);
  mountCustomFields(body);
  container.innerHTML = '';
  container.appendChild(body);
}

// ── Collections in the editor ──
// A shared item: "Save to <collection>" (edit/manage). A saved personal item
// or login: "Move to collection…" (re-encrypted under the collection key,
// then removed from the personal vault).
function collectionControlsHTML(entry) {
  if (isSharedEntry(entry)) {
    return entry.role === 'view'
      ? `<div class="coll-meta">View only — ask a manager of "${esc(entry.collectionName)}" for edit access.</div>`
      : `<button type="button" class="btn-save-all btn-save-shared">Save to ${esc(entry.collectionName)}</button>`;
  }
  const targets = collections.filter(c => c.key && c.role !== 'view');
  if (!targets.length || !entry._id || !_draftBase.some(b => b._id === entry._id)) return '';
  return `<div class="acc-field move-to-collection">
    <label>Share in a team collection</label>
    <div class="field-row">
      <select class="move-target">${targets.map(c => `<option value="${esc(c.id)}">${esc(c.name || 'Collection')}</option>`).join('')}</select>
      <button type="button" class="btn-crypto-ok btn-move-collection">Move</button>
    </div>
  </div>`;
}

function mountCollectionControls(body, entry) {
  body.querySelector('.btn-save-shared')?.addEventListener('click', () => saveSharedEntry(entry));
  body.querySelector('.btn-move-collection')?.addEventListener('click', () =>
    moveToCollection(entry, body.querySelector('.move-target').value));
}

// Replaces the rows of the given ids (in the draft and its base) with fresh
// entries, keeping every other unsaved edit in the editor.
function patchEntries(ids, fresh) {
  const drop = new Set(ids);
  const keep = list => list.filter(e => !drop.has(e._id));
  draft = [...keep(draft), ...fresh];
  _draftBase = [...keep(_draftBase), ...fresh.map(e => structuredClone(e))];
  openAccIdx = -1;
  rebuildAccountsDOM();
  renderVaultTypeBar();
  renderVaultCatBar();
  applyVaultSearch();
  renderAccDetail();
}

async function saveSharedEntry(entry) {
  syncOpenAccToDraft();
  const c = collections.find(x => x.id === entry.cid);
  if (!c?.key) { setStatus('This collection is not available on this device', false); return; }
  if (!entry.name) { setStatus('It needs a name', false); return; }
  let res;
  try { res = await VaultCollections.save(c, itemOfEntry(entry), entry._baseRev); } catch { setStatus('Could not save — check your connection', false); return; }
  if (res.conflict) setStatus('Someone changed this meanwhile — showing their version', false);
  else setStatus(`Saved to ${c.name}`);
  sharedItems = await sharedItemsFromLocal();
  const fresh = sharedItems.filter(s => s.item.id === entry._id).map(sharedEntryOf);
  patchEntries([entry._id], fresh);
}

async function deleteSharedEntry(entry) {
  const c = collections.find(x => x.id === entry.cid);
  if (!c?.key) return;
  let res;
  try { res = await VaultCollections.deleteItem(c, entry._id, entry._baseRev); } catch { setStatus('Could not delete — check your connection', false); return; }
  if (res.conflict) setStatus('Someone changed this meanwhile — not deleted', false);
  sharedItems = await sharedItemsFromLocal();
  patchEntries([entry._id], sharedItems.filter(s => s.item.id === entry._id).map(sharedEntryOf));
}

async function sharedItemsFromLocal() {
  const out = [];
  for (const c of collections) {
    if (!c.key) continue;
    for (const { item, revision } of await VaultCollections.snapshot(c)) out.push({ collection: c, item, revision });
  }
  return out;
}

let _moving = false;
async function moveToCollection(entry, cid) {
  if (_moving) return; // a second click would put another copy in the collection
  _moving = true;
  const btn = document.querySelector('#acc-detail .btn-move-collection');
  if (btn) btn.disabled = true;
  try { await moveNow(entry, cid); } finally { _moving = false; if (btn?.isConnected) btn.disabled = false; }
}

async function moveNow(entry, cid) {
  syncOpenAccToDraft();
  if (JSON.stringify(draft) !== JSON.stringify(_draftBase)) { setStatus('Save or cancel your changes first', false); return; }
  const c = collections.find(x => x.id === cid);
  const key = await VaultKeys.getKey();
  if (!c?.key || !key) return;
  if (!confirm(`Move "${entry.name}" into "${c.name}"? Everyone in it will see it, and it leaves your personal vault.`)) return;
  // The exact record copied: the personal copy is only removed if it is
  // still this one once the collection has it (a page may update the login
  // meanwhile).
  const copied = (await VaultStore.listRecords())[entry._id];
  const item = copied && await VaultCrypto.decryptItem(copied, key).catch(() => null);
  if (!item) { setStatus('Could not read this item', false); return; }
  try {
    const res = await VaultCollections.moveIn(c, item);
    if (!res.ok) throw new Error('not saved');
  } catch { setStatus('Could not move it — check your connection', false); return; }
  const before = new Set(sharedItems.map(s => s.item.id));
  const removed = await VaultStore.transaction(async tx => {
    const now = (await tx.listRecords())[entry._id];
    if (!now || now.data?.iv !== copied.data?.iv) return false;
    await tx.remove(entry._id);
    return true;
  });
  if (!removed) {
    setStatus('It changed while moving: the collection has the earlier copy, your updated one stays in your vault', false);
  }
  // The locked-vault index must stop offering it now, sync or not (rebuilt
  // under the vault lock, so a page saving a login meanwhile isn't undone).
  await VaultAccounts.rebuildIndex(key);
  await stampLocalChange();
  silentPullSync(); // the removal reaches the user's other devices
  accounts = await VaultAccounts.load(key);
  _loadedIds = new Set(accounts.map(a => a._id));
  otherItems = await VaultAccounts.loadOthers(key);
  sharedItems = await sharedItemsFromLocal();
  const added = sharedItems.filter(s => !before.has(s.item.id)).map(sharedEntryOf);
  if (removed) patchEntries([entry._id], added);
  else {
    // Kept: show (and base later saves on) the updated version, not the copy.
    const kept = [...accounts, ...otherItems.map(entryOf)].find(e => e._id === entry._id);
    patchEntries([entry._id], [...(kept ? [{ ...structuredClone(kept) }] : []), ...added]);
  }
  renderAccountBar();
  if (removed) setStatus(`Moved to ${c.name}`);
}

// An otpauth://totp/ link (what a 2FA QR code holds): { secret, issuer,
// account }, { unsupported: true } for settings OTPilot can't generate,
// { invalid: true } for a malformed one, or null when it isn't one.
function parseOtpauth(text) {
  const v = String(text || '').trim();
  if (!/^otpauth:\/\//i.test(v)) return null;
  let url;
  try { url = new URL(v); } catch { return null; }
  const p = url.searchParams;
  const secret = (p.get('secret') || '').replace(/\s/g, '').toUpperCase();
  if (!secret) return null;
  if (url.host.toLowerCase() !== 'totp' || (p.get('digits') ?? '6') !== '6' || (p.get('period') ?? '30') !== '30'
    || (p.get('algorithm') ?? 'SHA1').toUpperCase() !== 'SHA1') return { unsupported: true };
  let label;
  try { label = decodeURIComponent(url.pathname.replace(/^\/+/, '')); } catch { return { invalid: true }; }
  const [labelIssuer, account] = label.includes(':') ? label.split(/:(.*)/s) : ['', label];
  // Links carry base32; one that also looks like hex would be read as hex
  // (totp.js decodeSecret), so it's stored as the hex of its bytes.
  return { secret: Importers.storableSecret(secret.replace(/=+$/, '')), issuer: (p.get('issuer') || labelIssuer || '').trim(), account: (account || '').trim() };
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

// "+ Add" opens the type picker: the item types, and the planned ones as
// "Soon". A Login starts the login editor; the others an item editor.
function addToDraft(type) {
  syncOpenAccToDraft();
  // Adding while a category filter is active pre-assigns that category, so the
  // new row matches the active filter and stays visible (instead of being
  // hidden by applyVaultSearch the moment it's created). Same for the type.
  if (type === 'login' || type === '2fa') {
    draft.push({
      name: '', email: '', secret: '', urls: '', autofill: true, category: categoryFilter, moreTags: [],
      ...(type === '2fa' ? { _compact: true } : {}),
    });
  } else {
    draft.push(entryOf(Vault.newItem(type, { tags: categoryFilter ? [categoryFilter] : [] })));
  }
  if (typeFilter && typeFilter !== (type === '2fa' ? 'login' : type)) typeFilter = '';
  openAccIdx = draft.length - 1;
  rebuildAccountsDOM();
  renderVaultTypeBar();
  renderVaultCatBar();
  applyVaultSearch();
  renderAccDetail();
  document.getElementById('accounts-list').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.querySelector(type === '2fa' ? '#acc-detail .acc-secret' : '#acc-detail .acc-name, #acc-detail .item-title')?.focus();
}

function closeAddMenu() {
  document.getElementById('add-type-menu').style.display = 'none';
  document.getElementById('quick-add-menu').style.display = 'none';
}

// The type picker: "2FA code" first (a login opened in its compact,
// 2FA-first form), then every item type, then the upcoming ones. `pick`
// receives the chosen type.
function fillAddMenu(menu, pick) {
  menu.innerHTML = '';
  const add = (type, label) => {
    const b = document.createElement('button');
    b.className = 'add-type';
    b.dataset.addType = type;
    b.textContent = label;
    b.addEventListener('click', () => { closeAddMenu(); pick(type); });
    menu.appendChild(b);
  };
  add('2fa', '2FA code');
  for (const [type, t] of Object.entries(Vault.TYPES)) add(type, t.label);
  for (const t of Vault.UPCOMING_TYPES) {
    const b = document.createElement('button');
    b.className = 'add-type soon';
    b.disabled = true;
    b.innerHTML = `${esc(t.label)} <span class="soon-tag">Soon</span>`;
    menu.appendChild(b);
  }
}

function toggleAddMenu(id, pick) {
  const menu = document.getElementById(id);
  const open = menu.style.display !== 'none';
  closeAddMenu();
  if (open) return;
  fillAddMenu(menu, pick);
  menu.style.display = '';
}

document.getElementById('btn-add').addEventListener('click', e => {
  e.stopPropagation();
  toggleAddMenu('add-type-menu', addToDraft);
});
document.addEventListener('click', e => {
  if (!e.target.closest?.('#add-type-menu, #quick-add-menu')) closeAddMenu();
});

document.getElementById('acc-search').addEventListener('input', applyVaultSearch);

document.getElementById('btn-cancel').addEventListener('click', () => {
  openAccIdx = -1;
  showView('home');
});

// One save at a time: a second click while one is in flight would read the
// open form into a draft the first save already merged and re-sorted.
let _savingAccounts = false;
document.getElementById('btn-save-all').addEventListener('click', async () => {
  if (_savingAccounts) return;
  _savingAccounts = true;
  // What this click saves is captured now, before waiting for the lock: if
  // the user leaves the editor or starts over meanwhile, the queued save
  // stops instead of saving a later editing session nobody clicked Save on.
  syncOpenAccToDraft();
  const intended = { session: _editSession, draft: JSON.stringify(draft) };
  // Counting toward the Free limit and writing share one lock with every
  // other user-initiated add (the page's Save login, CSV import), so two of
  // them can't both take the last free slot.
  try { await navigator.locks.request('otpilot-item-limit', () => saveAccounts(intended)); } finally { _savingAccounts = false; }
});

async function saveAccounts(intended) {
  if (_editSession !== intended.session || JSON.stringify(draft) !== intended.draft) {
    setStatus('The list changed while saving — save again', false);
    return;
  }

  if (draft.some(a => !a.name)) { setStatus('Every account needs a name', false); return; }
  // Shared items are saved to their collection, not by this button: never
  // drop their edits silently.
  const baseById = new Map(_draftBase.map(e => [e._id, JSON.stringify(e)]));
  const sharedDirty = draft.find(e => isSharedEntry(e) && baseById.get(e._id) !== JSON.stringify(e));
  if (sharedDirty) {
    setStatus(`"${sharedDirty.name}" is shared: use "Save to ${sharedDirty.collectionName}" first, or Cancel`, false);
    return;
  }

  // Free plan: up to 50 items (2FA-only logins don't count). Checked before
  // anything changes, so a refused save leaves the editor as it was. The
  // check is async: an edit made meanwhile (Add clicked again, typing in the
  // open form) stops the save instead of saving something unchecked or
  // dropping the typing. The draft is merged only after the check, so the
  // open row's index still matches it when the form is read again.
  const edited = JSON.stringify(draft);
  let overLimit;
  try {
    const key = await VaultKeys.getKey();
    const { userPlan = 'free' } = await chrome.storage.local.get('userPlan');
    const merged = mergeDraftWithCurrent();
    overLimit = !!key && await VaultAccounts.exceedsFreeLimit(
      merged.filter(isLoginEntry), key, _loadedIds, userPlan, planOtherItems(merged));
  } catch {
    setStatus('Could not check the Free plan limit — try again', false);
    return;
  }
  if (overLimit) {
    setStatus(`The Free plan holds ${Vault.FREE_ITEM_LIMIT} items (2FA-only logins don't count). Upgrade to add more.`, false);
    return;
  }
  syncOpenAccToDraft();
  if (JSON.stringify(draft) !== edited) {
    setStatus('The list changed while saving — save again', false);
    return;
  }
  draft = mergeDraftWithCurrent();

  // Non-login items are written as items; the rest of this works on logins.
  const others = planOtherItems(draft);
  if (others.put.length || others.remove.length) {
    const key = await VaultKeys.getKey();
    if (!key) { setStatus('OTPilot is locked', false); return; }
    if (others.put.length) await VaultStore.save(others.put, key);
    if (others.remove.length) await VaultStore.remove(others.remove);
    otherItems = await VaultAccounts.loadOthers(key);
  }
  draft = draft.filter(isLoginEntry);

  // Diff old accounts vs draft: stamp _updatedAt on new/changed, tombstone deleted
  const now      = new Date().toISOString();
  const oldMap   = new Map(accounts.map(a => [a.name, a]));
  const draftSet = new Set(draft.map(a => a.name));

  for (const acc of draft) {
    const old = oldMap.get(acc.name);
    const changed = !old ||
      old.secret !== acc.secret || old.urls !== acc.urls ||
      old.email !== acc.email || old.autofill !== acc.autofill ||
      (old.password || '') !== (acc.password || '') ||
      (old.category || '') !== (acc.category || '') ||
      JSON.stringify(old.moreTags || []) !== JSON.stringify(acc.moreTags || []) ||
      (old.notes || '') !== (acc.notes || '') ||
      JSON.stringify(old.customFields || []) !== JSON.stringify(acc.customFields || []) ||
      (acc.extraPasswordHistory || []).length > 0; // a merge set passwords aside
    acc._updatedAt = changed ? now : (old._updatedAt ?? now);
  }

  const newTombs = { ...tombstones };
  for (const acc of accounts) {
    if (!draftSet.has(acc.name)) newTombs[acc.name] = now;
  }
  tombstones = newTombs;
  await saveTombstones();

  draft.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  accounts = draft;
  activeIndex = Math.min(activeIndex, Math.max(accounts.length - 1, 0));
  await saveState();
  await stampLocalChange();
  silentPullSync(); // start push before navigating so fetch is in-flight while popup is open

  renderAccountBar();
  activeTabIconHint().then(requestIcons); // pick up icons for any newly-added domains
  startTimer();
  // Land on Accounts with nothing selected — reopening the just-saved
  // account read as "did this even do anything?" (same form, same fields).
  // The empty-state message confirms the save instead. Search stays as the
  // user left it rather than resetting, so saving mid-search doesn't lose it.
  _justSavedMessage = true;
  showView('accounts', { openAccountIdx: -1, preserveSearch: true });
  setStatus('Saved');
}

// ── View switching ────────────────────────────────────────────────────────────

// Redraws whatever shows the account list: Home always, and the Accounts view
// if it's open (keeping its search). Used after the list changes underneath
// the UI (first load, a sync).
// Never rebuilds an editor with unsaved changes or an open form: a sync
// finishing mid-edit would otherwise discard what the user typed. Saving
// merges the edits with whatever changed meanwhile (mergeDraftWithCurrent).
let _draftBase = [];
function accountsEditorBusy() {
  if (document.getElementById('settings-panel').style.display === 'none') return false;
  syncOpenAccToDraft();
  return openAccIdx >= 0 || JSON.stringify(draft) !== JSON.stringify(_draftBase);
}

function refreshAccountsUI() {
  renderAccountBar();
  if (document.getElementById('settings-panel').style.display === 'none') return;
  if (accountsEditorBusy()) {
    setStatus('Synced — other changes appear after you save or cancel');
    return;
  }
  renderAccountsList(-1, { preserveSearch: true });
}

// Three-way merge for Save, against the list the editor started from
// (_draftBase): accounts the user didn't touch take their current version
// (a sync may have changed or deleted them), edited and new ones are the
// user's, and accounts that arrived meanwhile are kept.
// Item ids a sync replaced while the popup was open (a login migrated on two
// devices kept under the server's id): the editor's copies follow them.
const _idRemaps = {};
const remapId = a => (a._id && _idRemaps[a._id] ? { ...a, _id: _idRemaps[a._id] } : a);

function mergeDraftWithCurrent() {
  const base = new Map(_draftBase.filter(a => a._id).map(remapId).map(a => [a._id, JSON.stringify(a)]));
  const currentList = [...accounts, ...otherItems.map(entryOf), ...sharedItems.map(sharedEntryOf)];
  const current = new Map(currentList.filter(a => a._id).map(a => [a._id, a]));
  const merged = [];
  for (const d0 of draft) {
    const d = remapId(d0);
    const untouched = d._id && base.get(d._id) === JSON.stringify(d);
    if (!untouched) merged.push(d);
    else if (current.has(d._id)) merged.push({ ...current.get(d._id) });
    // untouched here and gone from the vault: deleted elsewhere, stays deleted
  }
  for (const a of currentList) {
    if (a._id && !base.has(a._id)) merged.push({ ...a }); // arrived while editing
  }
  return merged;
}

// The non-login item writes for a merged draft: changed or new items (`put`)
// and the ids the user deleted (`remove`: in the vault, gone from the draft).
function planOtherItems(merged) {
  const current = new Map(otherItems.map(i => [i.id, i]));
  const same = (a, b) => JSON.stringify({ ...a, updatedAt: null }) === JSON.stringify({ ...b, updatedAt: null });
  const now = new Date().toISOString();
  const put = [];
  const kept = new Set();
  for (const entry of merged.filter(isItemEntry)) {
    kept.add(entry._id);
    const item = itemOfEntry(entry);
    const cur = current.get(entry._id);
    if (!cur || !same(item, cur)) put.push({ ...item, updatedAt: now });
  }
  return { put, remove: [...current.keys()].filter(id => !kept.has(id)) };
}

function showView(view, opts = {}) {
  if (view !== 'settings') { clearRevealedKey(); hideCsvExport(); }
  document.getElementById('home-view').style.display      = view === 'home'     ? '' : 'none';
  document.getElementById('settings-panel').style.display = view === 'accounts' ? '' : 'none';
  document.getElementById('config-panel').style.display   = view === 'settings' ? '' : 'none';
  document.getElementById('sync-panel').style.display     = view === 'sync'     ? '' : 'none';
  document.getElementById('team-panel').style.display     = view === 'team'     ? '' : 'none';
  document.getElementById('generate-panel').style.display = view === 'generate' ? '' : 'none';
  document.getElementById('nav-generate').classList.toggle('active', view === 'generate');
  document.getElementById('nav-home').classList.toggle('active',     view === 'home');
  document.getElementById('nav-settings').classList.toggle('active', view === 'accounts');
  document.getElementById('nav-config').classList.toggle('active',   view === 'settings');
  document.getElementById('nav-sync').classList.toggle('active',     view === 'sync');
  document.getElementById('nav-team').classList.toggle('active',     view === 'team');
  if (view === 'accounts') renderAccountsList(opts.openAccountIdx ?? -1, { preserveSearch: opts.preserveSearch });
  if (view === 'sync') renderSyncPanel();
  if (view === 'team') renderTeamPanel();
  if (view === 'generate') renderGenerator();
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
  if (id !== 'settings-password-view') clearRevealedKey();
  if (id !== 'settings-backup-view') hideCsvExport();
  const views = ['settings-theme-view', 'settings-backup-view', 'settings-google-import-view', 'settings-csv-import-view', 'settings-autofill-view', 'settings-password-view'];
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

document.getElementById('row-settings-password').addEventListener('click', async () => {
  ['change-pw-current', 'change-pw-new', 'change-pw-confirm', 'reveal-key-password'].forEach(id => document.getElementById(id).value = '');
  clearRevealedKey();
  document.getElementById('reveal-key-err').textContent = '';
  document.getElementById('change-pw-err').textContent = '';
  document.getElementById('autolock-select').value = String(await VaultLock.getAutoLock());
  showSettingsSubview('settings-password-view');
});
// The revealed recovery key is dropped from the page as soon as it's no
// longer on screen (leaving the view, locking); a reveal still pending then
// is ignored (the token no longer matches).
let _revealToken = 0;
function clearRevealedKey() {
  _revealToken++;
  const out = document.getElementById('reveal-key-value');
  out.textContent = '';
  out.style.display = 'none';
}

document.getElementById('reveal-key-btn').addEventListener('click', async () => {
  const pwEl = document.getElementById('reveal-key-password');
  const out = document.getElementById('reveal-key-value');
  const err = document.getElementById('reveal-key-err');
  err.textContent = '';
  clearRevealedKey();
  const token = _revealToken;
  const key = pwEl.value ? await VaultLock.revealRecoveryKey(pwEl.value) : null;
  pwEl.value = '';
  if (token !== _revealToken) return;
  if (!key) { err.textContent = 'Incorrect password.'; return; }
  out.textContent = key;
  out.style.display = '';
});
document.getElementById('autolock-select').addEventListener('change', async e => {
  await VaultLock.setAutoLock(Number(e.target.value));
  setStatus('Auto-lock updated');
});
document.getElementById('back-settings-password').addEventListener('click', () => {
  clearRevealedKey();
  showSettingsSubview('settings-list');
});

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
    const ok = await VaultLock.changePassword(current, next);
    if (!ok) {
      err.textContent = 'Current password is incorrect.';
      setLockButtonState(btn, false);
      return;
    }
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
document.getElementById('nav-generate').addEventListener('click', () => showView('generate'));

// ── Generate ─────────────────────────────────────────────────────────────────
// Options persist (chrome.storage.local, not secret). Copied passwords are kept
// for this browser session only (chrome.storage.session, memory-only), so one
// generated for a signup form that got closed can still be recovered.
let _genOptions = { ...Generator.DEFAULTS };
let _genValue = '';
const GEN_HISTORY_MAX = 10;

async function renderGenerator() {
  const { generatorOptions } = await chrome.storage.local.get('generatorOptions');
  _genOptions = Generator.normalize(generatorOptions);
  regenerate();
  renderGenHistory();
}

function syncGenControls() {
  document.querySelectorAll('[data-gen-mode]').forEach(b => b.classList.toggle('active', b.dataset.genMode === _genOptions.mode));
  document.getElementById('gen-length').textContent = _genOptions.length;
  document.querySelectorAll('[data-gen-opt]').forEach(i => { i.checked = !!_genOptions[i.dataset.genOpt]; });
  document.getElementById('gen-opts').style.display = _genOptions.mode === 'pin' ? 'none' : '';
  const { bits, label } = Generator.strength(_genOptions);
  document.getElementById('gen-strength').textContent = `${label} · ${_genOptions.length} characters · ~${bits} bits`;
  document.getElementById('gen-bar').style.width = `${Math.min(100, bits)}%`;
}

function regenerate() {
  _genValue = Generator.generate(_genOptions);
  document.getElementById('gen-output').textContent = _genValue;
  syncGenControls();
}

function setGenOptions(patch) {
  _genOptions = Generator.normalize({ ..._genOptions, ...patch });
  chrome.storage.local.set({ generatorOptions: _genOptions });
  regenerate();
}

async function renderGenHistory() {
  const { generatorHistory = [] } = await chrome.storage.session.get('generatorHistory');
  const list = document.getElementById('gen-history');
  list.innerHTML = '';
  document.getElementById('gen-history-title').style.display = generatorHistory.length ? '' : 'none';
  for (const value of generatorHistory) {
    const row = document.createElement('div');
    row.className = 'gen-history-row';
    const text = document.createElement('span');
    text.textContent = value;
    const copy = document.createElement('button');
    copy.className = 'gen-step';
    copy.title = 'Copy';
    copy.textContent = '⧉';
    copy.addEventListener('click', async () => {
      if (await copyText(value)) setStatus('Copied');
    });
    row.append(text, copy);
    list.appendChild(row);
  }
}

document.querySelectorAll('[data-gen-mode]').forEach(b =>
  b.addEventListener('click', () => setGenOptions({ mode: b.dataset.genMode, length: b.dataset.genMode === 'pin' ? 6 : 16 })));
document.querySelectorAll('[data-gen-opt]').forEach(i =>
  i.addEventListener('change', () => setGenOptions({ [i.dataset.genOpt]: i.checked })));
document.getElementById('gen-minus').addEventListener('click', () => setGenOptions({ length: _genOptions.length - 1 }));
document.getElementById('gen-plus').addEventListener('click', () => setGenOptions({ length: _genOptions.length + 1 }));
document.getElementById('gen-regenerate').addEventListener('click', regenerate);
// Copies or reports why it couldn't; returns whether the clipboard got it.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    setStatus('Could not copy — the browser blocked the clipboard', false);
    return false;
  }
}

document.getElementById('gen-copy').addEventListener('click', async () => {
  // Capture now: Regenerate or an option change while this runs replaces _genValue.
  const value = _genValue;
  if (!(await copyText(value))) return;
  const { generatorHistory = [] } = await chrome.storage.session.get('generatorHistory');
  const next = [value, ...generatorHistory.filter(v => v !== value)].slice(0, GEN_HISTORY_MAX);
  await chrome.storage.session.set({ generatorHistory: next });
  setStatus('Password copied');
  renderGenHistory();
});
document.getElementById('nav-team').addEventListener('click',     () => showView('team'));

// The header's "+": the same type picker, from any view; the chosen type
// opens its editor in the vault.
document.getElementById('btn-quick-add').addEventListener('click', e => {
  e.stopPropagation();
  toggleAddMenu('quick-add-menu', type => {
    // Already in the vault: keep its unsaved edits (showView rebuilds the list).
    if (document.getElementById('settings-panel').style.display === 'none') showView('accounts');
    addToDraft(type);
  });
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

// ── Import from another password manager (CSV) ──────────────────────────────
// Importers parses the file and plans each entry against the vault (new
// login / password added to an existing one / already there); the items are
// written straight to the vault, so notes and folders survive.

let _csvImport = null; // { entries, plans }

function csvImportStatus(text, ok = true) {
  const el = document.getElementById('csv-import-status');
  el.textContent = text;
  el.style.color = ok ? 'var(--ink-4)' : 'var(--danger)';
}

function hideCsvReview() {
  _csvImport = null;
  document.getElementById('csv-import-review').style.display = 'none';
  document.getElementById('csv-import-list').innerHTML = '';
}

let _csvReviewSeq = 0; // a newer file picked meanwhile makes an older review stale
async function showCsvReview(file) {
  const seq = ++_csvReviewSeq;
  hideCsvReview();
  let parsed;
  try { parsed = Importers.parse(await file.text()); } catch (e) {
    if (seq !== _csvReviewSeq) return;
    csvImportStatus(e.message === 'No password column found' ? 'This CSV has no password column.' : 'Could not read this file.', false);
    return;
  }
  const key = await VaultKeys.getKey();
  if (!key) { csvImportStatus('Unlock OTPilot first.', false); return; }
  const { items } = await VaultStore.readAll(key);
  if (seq !== _csvReviewSeq) return;
  hideCsvReview();
  const plans = Importers.plan(parsed.entries, items);
  const names = new Map(items.map(i => [i.id, i.title]));
  _csvImport = { entries: parsed.entries, plans };

  const skipped = [
    parsed.invalid ? `${parsed.invalid} row${parsed.invalid === 1 ? '' : 's'} without a password skipped` : '',
    parsed.otherTypes ? `${parsed.otherTypes} server/API item${parsed.otherTypes === 1 ? '' : 's'} not imported (not supported from CSV yet)` : '',
    parsed.unsupportedTotp ? `${parsed.unsupportedTotp} 2FA code${parsed.unsupportedTotp === 1 ? '' : 's'} with unsupported settings (HOTP, 8 digits, SHA256…) not imported` : '',
  ].filter(Boolean);
  const nLogins = parsed.entries.filter(e => e.type === 'login').length;
  const nNotes = parsed.entries.length - nLogins;
  const found = `${nLogins} login${nLogins === 1 ? '' : 's'}${nNotes ? ` and ${nNotes} secure note${nNotes === 1 ? '' : 's'}` : ''}`;
  csvImportStatus([`${parsed.source}: ${found} found`, ...skipped].join(' · '));
  if (!parsed.entries.length) return;

  const list = document.getElementById('csv-import-list');
  parsed.entries.forEach((entry, i) => {
    const p = plans[i];
    const exists = p.action === 'exists';
    const label = document.createElement('label');
    label.className = 'export-acc-row' + (exists ? ' disabled' : '');
    label.innerHTML = `<input type="checkbox" ${exists ? 'disabled' : 'checked'} data-idx="${i}">
      <span class="export-acc-name">${esc(entry.title)}</span>
      ${entry.type === 'note' ? '<span class="type-tag">Secure note</span>' : ''}
      ${entry.username ? `<span class="export-acc-email">${esc(entry.username)}</span>` : ''}
      ${exists ? '<span class="export-acc-exists">already in vault</span>' : ''}
      ${p.action === 'merge' ? `<span class="export-acc-exists">adds password to ${esc(names.get(p.target) || 'login')}</span>` : ''}`;
    list.appendChild(label);
  });
  document.getElementById('csv-import-all').checked = plans.some(p => p.action !== 'exists');
  document.getElementById('csv-import-review').style.display = '';
}

document.getElementById('row-settings-csv-import').addEventListener('click', () => {
  hideCsvReview();
  csvImportStatus('');
  showSettingsSubview('settings-csv-import-view');
});
document.getElementById('csv-import-pick').addEventListener('click', () => document.getElementById('csv-import-file').click());
document.getElementById('csv-import-file').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) showCsvReview(file);
});
document.getElementById('csv-import-all').addEventListener('change', e => {
  document.querySelectorAll('#csv-import-list input:not(:disabled)').forEach(cb => { cb.checked = e.target.checked; });
});
document.getElementById('csv-import-cancel').addEventListener('click', () => { hideCsvReview(); csvImportStatus(''); });

let _csvImporting = false;
document.getElementById('csv-import-confirm').addEventListener('click', async () => {
  if (!_csvImport || _csvImporting) return;
  const chosen = [...document.querySelectorAll('#csv-import-list input:checked')].map(cb => _csvImport.entries[+cb.dataset.idx]);
  if (!chosen.length) { setStatus('Select at least one login', false); return; }
  // One import at a time: a second click would read the same vault and add
  // the same rows again under new ids.
  _csvImporting = true;
  const btn = document.getElementById('csv-import-confirm');
  btn.disabled = true;
  try {
    // The Free-limit lock shared by every user-initiated add (editor Save,
    // the page's Save login), then the vault lock inside: same order everywhere.
    await navigator.locks.request('otpilot-item-limit', () => importCsvEntries(chosen));
  } catch (e) {
    csvImportStatus(`Import failed — nothing was changed${e?.message ? ` (${e.message})` : ''}.`, false);
  } finally {
    _csvImporting = false;
    btn.disabled = false;
  }
});

async function importCsvEntries(chosen) {
  const key = await VaultKeys.getKey();
  if (!key) { csvImportStatus('Unlock OTPilot first.', false); return; }
  const { userPlan = 'free' } = await chrome.storage.local.get('userPlan');
  // Read, plan, check the Free limit and write as one step under the vault
  // lock: a sync or another writer can't change a merge target (or delete
  // it) in between. Planned with only the chosen rows (an unchecked row
  // must not take a merge target).
  const result = await VaultStore.transaction(async tx => {
    const items = [];
    for (const rec of Object.values(await tx.listRecords())) {
      try { items.push(await VaultCrypto.decryptItem(rec, key)); } catch { /* unreadable: never a merge target */ }
    }
    const toSave = Importers.toItems(chosen, Importers.plan(chosen, items), items);
    if (!Vault.PAID_PLANS.includes(userPlan)) {
      const after = new Map(items.map(i => [i.id, i]));
      toSave.forEach(i => after.set(i.id, i));
      const count = Vault.countedItems([...after.values()]);
      const before = Vault.countedItems(items);
      if (count > Vault.FREE_ITEM_LIMIT && count > before) return { room: Math.max(Vault.FREE_ITEM_LIMIT - before, 0) };
    }
    const records = [];
    for (const item of toSave) records.push([item.id, await VaultCrypto.encryptItem(item, key)]);
    if (records.length) await tx.putMany(records); // one write: all or nothing
    return { items, toSave };
  });
  if (result.room !== undefined) {
    const { room } = result;
    csvImportStatus(`The Free plan holds ${Vault.FREE_ITEM_LIMIT} items: ${room ? `select at most ${room} more` : 'there is no room for more'}, or upgrade.`, false);
    return;
  }
  const { items, toSave } = result;
  if (toSave.length) {
    await reloadFromVault(key);
    await stampLocalChange();
    silentPullSync();
  }
  const created = toSave.filter(i => !items.some(x => x.id === i.id));
  const added = created.filter(i => i.type === 'login').length;
  const notes = created.length - added;
  const merged = toSave.length - created.length;
  hideCsvReview();
  csvImportStatus(`Imported ${added} login${added === 1 ? '' : 's'}${notes ? ` and ${notes} secure note${notes === 1 ? '' : 's'}` : ''}${merged ? `, added ${merged} to existing logins` : ''}.`);
}

// ── Export everything as CSV (not encrypted) ───────────────────────────────
// Asks for the master password again: the file holds every secret in plain
// text. Columns are the ones the CSV import reads (Importers.toCsv).

// Bumped whenever the form closes (Cancel, Escape, toggling it, leaving the
// view, locking): an export still checking the password or reading the
// vault then writes nothing.
let _csvExportSeq = 0;
let _csvExporting = false;

function hideCsvExport() {
  _csvExportSeq++;
  document.getElementById('csv-export-form').style.display = 'none';
  document.getElementById('csv-export-password').value = '';
}

document.getElementById('btn-export-csv').addEventListener('click', () => {
  const form = document.getElementById('csv-export-form');
  if (form.style.display !== 'none') { hideCsvExport(); return; }
  form.style.display = '';
  document.getElementById('csv-export-password').focus();
});
document.getElementById('csv-export-cancel').addEventListener('click', hideCsvExport);
document.getElementById('csv-export-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('csv-export-confirm').click();
  if (e.key === 'Escape') hideCsvExport();
});

document.getElementById('csv-export-confirm').addEventListener('click', async () => {
  if (_csvExporting) return; // one export at a time: never two plaintext copies
  const password = document.getElementById('csv-export-password').value;
  if (!password) { setStatus('Enter your master password', false); return; }
  const seq = _csvExportSeq;
  const btn = document.getElementById('csv-export-confirm');
  _csvExporting = true;
  btn.disabled = true;
  try { await exportCsv(password, seq); } finally { _csvExporting = false; btn.disabled = false; }
});

async function exportCsv(password, seq) {
  const key = await VaultLock.revealRecoveryKey(password).catch(() => null);
  if (seq !== _csvExportSeq) return; // closed meanwhile
  if (!key) { setStatus('Incorrect password', false); return; }
  const { items, failed } = await VaultStore.readAll(key);
  if (seq !== _csvExportSeq || (await VaultLock.state()) !== 'unlocked') return;
  if (!items.length) {
    setStatus(failed.length ? `Could not export: ${failed.length} unreadable item${failed.length === 1 ? '' : 's'}` : 'The vault is empty', false);
    return;
  }
  const a = document.createElement('a');
  a.download = `otpilot-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.href = URL.createObjectURL(new Blob([Importers.toCsv(items)], { type: 'text/csv' }));
  a.click();
  URL.revokeObjectURL(a.href);
  hideCsvExport();
  setStatus(`Exported ${items.length} item${items.length === 1 ? '' : 's'}${failed.length ? ` (${failed.length} unreadable left out)` : ''} — delete the file after use`);
}

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

// Everyone waiting for the vault to be unlocked: popup startup (initLock) and
// a re-lock while the popup is open (lockPopup). All are released together
// once an unlock fully completes (including the recovery-key screen).
const _unlockWaiters = [];
const waitForUnlock = () => new Promise(resolve => _unlockWaiters.push(resolve));

function setLockButtonState(btn, busy) {
  btn.disabled = busy;
  if (busy) {
    btn.dataset.origText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span> Verifying…';
  } else {
    btn.textContent = btn.dataset.origText || btn.textContent;
  }
}

const LOCK_SCREENS = ['setup', 'login', 'kit', 'recover', 'reset'];

function showLockOverlay(mode) {
  document.getElementById('lock-overlay').classList.remove('hidden');
  for (const m of LOCK_SCREENS) document.getElementById(`lock-${m}`).style.display = m === mode ? '' : 'none';
  // A screen can be shown again later in the same popup (it re-locks while
  // open), so reset its fields and any button left in the "Verifying…" state.
  document.querySelectorAll(`#lock-${mode} .lock-btn`).forEach(b => {
    if (b.dataset.origText) setLockButtonState(b, false);
  });
  document.querySelectorAll(`#lock-${mode} .lock-err`).forEach(e => { e.textContent = ''; });
  document.querySelectorAll(`#lock-${mode} input.lock-input`).forEach(i => { i.value = ''; i.classList.remove('err'); });
  document.querySelector(`#lock-${mode} input.lock-input`)?.focus();
}

function hideLockOverlay() {
  document.getElementById('lock-overlay').classList.add('hidden');
}

async function initLock() {
  const state = await VaultLock.state();
  if (state === 'setup') {
    showLockOverlay('setup');
    return waitForUnlock().then(() => true);
  }
  if (state === 'unlocked') {
    await VaultLock.touch(); // opening the popup counts as activity
    // The recovery-key screen was closed without confirming (popup closed, or
    // the vault was unlocked from a page): show it before anything else.
    if (await VaultLock.needsRecoveryKeyNotice()) {
      const unlocked = waitForUnlock();
      completeUnlock();
      return unlocked.then(() => true);
    }
    return false;
  }
  showLockOverlay('login');
  return waitForUnlock().then(() => true);
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
  const autoLock = Number(document.getElementById('lock-setup-autolock').value);

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
    await VaultLock.setup(pw1);
    await VaultLock.setAutoLock(autoLock);
    await completeUnlock();
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

  err.textContent = '';
  inp.classList.remove('err');

  if (!pw) {
    err.textContent = 'Enter your password.';
    inp.classList.add('err');
    return;
  }

  setLockButtonState(btn, true);
  try {
    const ok = await VaultLock.unlock(pw);
    if (ok) {
      await completeUnlock();
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

// After any successful setup/unlock/recovery: show the recovery key once if the
// user hasn't confirmed saving it (first setup, or upgraded from v1), then hand
// back to whoever was waiting on the lock screen.
const KEY_REPLACED_NOTE = 'Your recovery key is now the one you restored. Any Emergency Kit you saved before no longer works.';

async function completeUnlock() {
  if (await VaultLock.needsRecoveryKeyNotice()) {
    const note = (await VaultLock.wasRecoveryKeyReplaced()) ? KEY_REPLACED_NOTE : '';
    // Cancelled when the vault locks while the screen is up: the waiters stay
    // queued for the next unlock.
    if (!(await showRecoveryKit(note))) return;
  }
  // Never drop the lock screen unless the vault really is unlocked.
  if ((await VaultLock.state()) !== 'unlocked') { showLockOverlay('login'); return; }
  hideLockOverlay();
  for (const release of _unlockWaiters.splice(0)) release();
}

// Resolves true once the user confirms saving the key, false if cancelled or
// if the vault isn't unlocked (there is no key to show, and this screen must
// never stand in for the lock screen).
// Each request takes a token; a lock (cancelRecoveryKit) or a newer request
// bumps it, and every await is followed by a token check, so a stale request
// can't show the screen over the login or fill in a key after cancellation.
let _kitSettle = null;
let _kitToken = 0;
async function showRecoveryKit(note = '') {
  _kitSettle?.(false);
  _kitSettle = null;
  const token = ++_kitToken;
  if ((await VaultLock.state()) !== 'unlocked' || token !== _kitToken) return false;
  const key = await VaultKeys.getKey();
  if (!key || token !== _kitToken) return false;
  // No await from here until _kitSettle is set: nothing can cancel in between.
  showLockOverlay('kit');
  document.getElementById('lock-kit-note').textContent = note;
  document.getElementById('lock-kit-note').style.display = note ? '' : 'none';
  document.getElementById('lock-kit-key').textContent = key;
  document.getElementById('lock-kit-saved').checked = false;
  document.getElementById('lock-kit-done').disabled = true;
  return new Promise(resolve => { _kitSettle = resolve; });
}

function cancelRecoveryKit() {
  _kitToken++;
  document.getElementById('lock-kit-key').textContent = '';
  const settle = _kitSettle;
  _kitSettle = null;
  settle?.(false);
}

function downloadEmergencyKit(key) {
  const text = [
    'OTPilot Emergency Kit',
    `Created: ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Recovery key: ${key}`,
    '',
    'This key decrypts everything you keep in OTPilot.',
    '- Forgot your master password? Choose "Forgot your master password?" on the lock screen and paste this key.',
    '- New device? Sign in, open Sync and paste this key.',
    'Keep it offline and private. Anyone with it (and your account) can read your vault.',
    '',
  ].join('\n');
  const a = document.createElement('a');
  a.download = 'OTPilot-Emergency-Kit.txt';
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('lock-kit-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('lock-kit-key').textContent).catch(() => {});
  setStatus('Recovery key copied');
});
document.getElementById('lock-kit-download').addEventListener('click', () =>
  downloadEmergencyKit(document.getElementById('lock-kit-key').textContent));
document.getElementById('lock-kit-saved').addEventListener('change', e => {
  document.getElementById('lock-kit-done').disabled = !e.target.checked;
});
document.getElementById('lock-kit-done').addEventListener('click', async () => {
  await VaultLock.acknowledgeRecoveryKey();
  document.getElementById('lock-kit-key').textContent = '';
  const settle = _kitSettle;
  _kitSettle = null;
  settle?.(true);
});

// Forgot master password → recovery key
document.getElementById('lock-forgot').addEventListener('click', () => showLockOverlay('recover'));
document.getElementById('lock-recover-back').addEventListener('click', () => showLockOverlay('login'));
document.getElementById('lock-recover-nokey').addEventListener('click', () => showLockOverlay('reset'));
document.getElementById('lock-reset-back').addEventListener('click', () => showLockOverlay('recover'));

document.getElementById('lock-recover-btn').addEventListener('click', async () => {
  const key = document.getElementById('lock-recover-key').value.trim();
  const pw1 = document.getElementById('lock-recover-new').value;
  const pw2 = document.getElementById('lock-recover-confirm').value;
  const err = document.getElementById('lock-recover-err');
  const btn = document.getElementById('lock-recover-btn');
  err.textContent = '';
  if (!key) { err.textContent = 'Paste your recovery key.'; return; }
  if (!pw1) { err.textContent = 'Choose a new master password.'; return; }
  if (pw1 !== pw2) { err.textContent = 'Passwords do not match.'; return; }

  setLockButtonState(btn, true);
  try {
    await VaultLock.recover(key, pw1);
    await VaultLock.acknowledgeRecoveryKey(); // they just used it
    await completeUnlock();
  } catch (e) {
    err.textContent = e.message === 'wrong recovery key'
      ? "That recovery key doesn't match this device."
      : e.message === "recovery key can't be checked"
        ? "There's nothing on this device to check the key against. Reset this device, then restore from Sync."
        : 'Something went wrong. Try again.';
    setLockButtonState(btn, false);
  }
});

document.getElementById('lock-reset-btn').addEventListener('click', async () => {
  if (document.getElementById('lock-reset-confirm').value.trim() !== 'RESET') {
    document.getElementById('lock-reset-err').textContent = 'Type RESET to confirm.';
    return;
  }
  await VaultLock.resetDevice();
  location.reload();
});

// Shows the lock screen over an open popup, stopping the code timer until the
// master password is entered again. Used by the lock button and whenever the
// vault locks elsewhere (auto-lock alarm, another popup) while this one is open.
let _popupLocked = false;
async function lockPopup() {
  if (_popupLocked) return;
  _popupLocked = true;
  clearInterval(timerInterval);
  clearInterval(_sharedRefreshTimer);
  cancelRecoveryKit();
  // Passwords start masked again after unlocking.
  document.getElementById('home-creds').innerHTML = '';
  _homeCredsKey = null;
  clearRevealedKey();
  hideCsvExport();
  // userPlan stays: locking isn't signing out, and the item limit reads it
  // right after unlocking.
  showLockOverlay('login');
  await waitForUnlock();
  // Unlocked: a new lock from here on must be handled again, even while the
  // view below is still reloading (reading the vault takes a moment).
  _popupLocked = false;
  await loadState();
  if (_popupLocked) return;
  await syncActiveIndexToUrl();
  if (_popupLocked) return;
  renderAccountBar();
  startTimer();
  renderSharedCodes();
  showView('home');
  tryAutoFillCurrentTab();
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  await VaultLock.lock(); // storage.session change below shows the lock screen
  await lockPopup();
});

// The vault key leaving chrome.storage.session means the vault locked —
// from the auto-lock alarm, or another popup/window.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.vaultKeyUnlocked && !changes.vaultKeyUnlocked.newValue) lockPopup();
});

// The alarm runs once a minute; while the popup is open, check the deadline
// more often so it never shows codes past it.
setInterval(() => { if (!_popupLocked) VaultLock.state().catch(() => {}); }, 15000);

// Using the popup counts as activity for the auto-lock (throttled).
let _lastTouch = 0;
['click', 'keydown'].forEach(type => document.addEventListener(type, () => {
  if (_popupLocked || Date.now() - _lastTouch < 30000) return;
  _lastTouch = Date.now();
  VaultLock.touch().catch(() => {});
}, true));

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
// After a sync changed the vault: reload the list, rebuild the locked-vault
// index (pulled URLs/names/deletions), and redraw.
async function reloadFromVault(key) {
  accounts = await VaultAccounts.load(key);
  _loadedIds = new Set(accounts.map(a => a._id));
  otherItems = await VaultAccounts.loadOthers(key);
  activeIndex = Math.min(activeIndex, Math.max(accounts.length - 1, 0));
  await VaultAccounts.writeIndex((await VaultStore.readAll(key)).items);
  refreshAccountsUI();
  requestIcons();
  startTimer();
}

// The v1 view of the vault for 1.x devices: written when it no longer matches
// what this device last exported (or a 1.x device just changed it). Accounts
// that left the vault since the last export get v1 tombstones (keyed by name),
// or a 1.x device would push them back.
// Only logins with a 2FA secret exist for 1.x devices: a password-only login
// would show there as an empty 2FA entry, and deleting that entry would
// tombstone the real login by name. They're left out of the export and of
// the merge with a 1.x blob.
const v1Exportable = list => list.filter(a => a.secret);
const v1Fields = a => ({ name: a.name, email: a.email || '', secret: a.secret, urls: a.urls || '', autofill: a.autofill !== false, category: a.category || '', domain: a.domain || '' });
// SHA-256 of the v1 view: what's compared with the last export. Only the hash
// is stored (the view contains secrets); names are kept for the tombstones
// and are already in the plaintext vaultIndex.
async function v1Snapshot(list) {
  const bytes = new TextEncoder().encode(JSON.stringify(list.map(v1Fields)));
  return VaultCrypto.b64e(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
// Returns false when the server kept a newer blob instead (written meanwhile
// by another device): nothing is recorded, so the caller merges it and retries.
async function exportV1Blob(serverMeta, fromV1Device) {
  const { v1Export } = await chrome.storage.local.get('v1Export');
  const exported = v1Exportable(accounts);
  const snapshot = await v1Snapshot(exported);
  // The server keeps the blob with the newest timestamp: stamp the export
  // after the one it holds, so a clock behind another device's still wins.
  const serverMs = serverMeta?.updatedAt ? Date.parse(serverMeta.updatedAt) : NaN;
  const now = new Date(Math.max(Date.now(), Number.isNaN(serverMs) ? 0 : serverMs + 1)).toISOString();
  if (!fromV1Device && serverMeta && v1Export?.snapshot === snapshot) {
    // Up to date (possibly written by another 2.0 device): nothing to upload.
    if (lastSyncedAt === null || serverMeta.updatedAt > lastSyncedAt) await writeLastSyncedAt(serverMeta.updatedAt);
    return true;
  }
  const current = new Set(exported.map(a => a.name));
  for (const name of v1Export?.names || []) {
    if (!current.has(name)) tombstones[name] = now;
  }
  for (const name of current) delete tombstones[name];
  await saveTombstones();
  const res = await CloudSync.push(exported, tombstones, now, 'v2');
  if (res?.conflict) return false;
  await chrome.storage.local.set({ v1Export: { snapshot, names: [...current] } });
  await writeLastSyncedAt(now);
  return true;
}

// One pass of the v1 transition: merge a blob from a 1.x device, then export.
async function syncV1Blob(key) {
  const serverMeta = await CloudSync.getServerMeta();
  const fromV1Device = !!serverMeta && serverMeta.writer !== 'v2' &&
    (lastSyncedAt === null || serverMeta.updatedAt > lastSyncedAt);
  if (fromV1Device) {
    // Entries without a secret in the blob are password-only logins an
    // earlier 2.0 export sent; they're not 1.x accounts.
    const passwordOnly = accounts.filter(a => !a.secret);
    const { accounts: merged, tombstones: mergedTombs } = CloudSync.mergeWithTombstones(
      v1Exportable(accounts), tombstones, v1Exportable(serverMeta.accounts), serverMeta.tombstones, lastSyncedAt
    );
    accounts   = [...merged, ...passwordOnly];
    tombstones = mergedTombs;
    await saveState();
    await saveTombstones();
    Object.assign(_idRemaps, (await VaultSync.sync(key)).remapped); // so the 1.x edits reach other 2.0 devices too
    await reloadFromVault(key);
  }
  return { serverMeta, exported: await exportV1Blob(serverMeta, fromV1Device) };
}

async function doSync() {
  if (_syncInProgress) return;
  _syncInProgress = true;
  syncSetStatus('syncing', 'Syncing…');
  try {
    // 2.0: the vault syncs item by item (/vault/items); the v1 blob only keeps
    // 1.x devices in step during the transition. Blobs written by 2.0 devices
    // carry writer 'v2' and are ignored here (their items already arrived);
    // only a blob from a 1.x device is merged in.
    const key = await VaultKeys.getKey();
    if (!key) throw new Error('vault is locked');
    Object.assign(_idRemaps, (await VaultSync.sync(key)).remapped);
    await reloadFromVault(key);

    let { serverMeta, exported } = await syncV1Blob(key);
    // Refused: a blob written meanwhile by another device. Merge it and export
    // again, once; past that the next sync picks it up.
    if (!exported) ({ serverMeta } = await syncV1Blob(key));

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
      // Same for the per-item vault: its items may be encrypted with the lost
      // key, so they're deleted and this device's vault is uploaded instead.
      _startFresh = false;
      const now = new Date().toISOString();
      const exported = v1Exportable(accounts);
      await CloudSync.push(exported, tombstones, now, 'v2');
      await chrome.storage.local.set({ v1Export: { snapshot: await v1Snapshot(exported), names: exported.map(a => a.name) } });
      await writeLastSyncedAt(now);
      await VaultSync.wipeServer();
      await VaultSync.sync(await VaultKeys.getKey());
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
  const password = document.getElementById('sync-restore-password').value;
  errEl.textContent = '';
  if (!keyB64) { errEl.textContent = 'Paste your recovery key.'; return; }
  if (!password) { errEl.textContent = 'Enter your master password.'; return; }
  // Validate the key against the server's data before adopting it: adopting
  // re-wraps the local vault to this key, so a typo must never get that far.
  let pullResult;
  try {
    pullResult = await CloudSync.pull(keyB64);
  } catch {
    errEl.textContent = 'Invalid key or decryption failed.';
    return;
  }
  if (!pullResult) {
    // Nothing on the server to decrypt, so the key can't be checked.
    errEl.textContent = 'There is no synced data to check this key against. Use "Start fresh" instead.';
    return;
  }
  // The vault may have locked (lock button, auto-lock) while the server
  // request was pending: then stop here instead of adopting the key.
  if ((await VaultLock.state()) !== 'unlocked') {
    document.getElementById('sync-restore-password').value = '';
    return;
  }
  const previousKey = await VaultKeys.getKey();
  if (!previousKey) return; // locked meanwhile: the lock screen is up
  try {
    await CloudSync.saveSyncKey(keyB64, password);
  } catch (e) {
    errEl.textContent = e.message === 'wrong password' ? 'Incorrect master password.' : 'Could not save the key. Try again.';
    return;
  }
  document.getElementById('sync-restore-password').value = '';
  // The device key is now the restored one: record it right away, before any
  // network work that could fail, so the stale-Emergency-Kit warning can't be lost.
  const keyReplaced = keyB64 !== previousKey;
  if (keyReplaced) await VaultLock.recoveryKeyReplaced();
  try {
    const { accounts: remoteAccounts, tombstones: remoteTombs } = pullResult;

    // On reconnect the server is the source of truth.
    // Add any local-only accounts not present or deleted on the server,
    // but discard local tombstones — offline deletions must not override synced data.
    // Password-only logins aren't part of the v1 blob (v1Exportable): they're
    // kept as they are, whatever the blob's names or tombstones say.
    const passwordOnly  = accounts.filter(a => !a.secret);
    const remote        = v1Exportable(remoteAccounts);
    const remoteNames   = new Set(remote.map(a => a.name));
    const remoteDeleted = new Set(Object.keys(remoteTombs));
    const localOnly     = v1Exportable(accounts).filter(a => !remoteNames.has(a.name) && !remoteDeleted.has(a.name));
    const merged        = [...remote, ...localOnly];
    const mergedTombs   = remoteTombs;

    accounts   = [...merged, ...passwordOnly];
    tombstones = mergedTombs;
    await saveState();
    await saveTombstones();
    renderAccountBar();
    const now = new Date().toISOString();
    await CloudSync.push(merged, mergedTombs, now);
    await writeLastSyncedAt(now);
    syncShowView('sv-active');
    syncSetStatus('ok', 'Restored');
    // Show the new key now if the vault is still unlocked; otherwise the
    // recorded change shows it after the next unlock.
    if (keyReplaced && await showRecoveryKit(KEY_REPLACED_NOTE) && (await VaultLock.state()) === 'unlocked') hideLockOverlay();
  } catch {
    errEl.textContent = 'Could not finish syncing. Check your connection and try again.';
    await CloudSync.deleteSyncKey();
  }
});

// Restore: start fresh (replaces server data, encrypted with this device's vault key)
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
  await new Promise(r => chrome.storage.local.remove(['userPlan', 'localChangedAt', 'lastSyncedAt', 'tombstones', 'v1Export'], r));
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
    ['userPlan', 'localChangedAt', 'lastSyncedAt', 'tombstones', 'v1Export'], r
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
  // The user may have opened Accounts while the vault was still loading.
  refreshAccountsUI();
  refreshSharedItems(); // team collections: pulled in the background, list redrawn when they land
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
    if (msg.action === 'serverDataChanged') {
      // Logins the background's sync paired with their server twins: an open
      // editor's draft follows them (the old ids are already gone).
      if (msg.remapped) Object.assign(_idRemaps, msg.remapped);
      silentPullSync();
    }
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
    applyVaultSearch(); // fresh rows start visible: re-apply the search/category filter
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
  renderTeamCollections(team, members, myId);
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

// ── Team collections (manage) ──────────────────────────────────────────────────
// Listed in the Team tab: create, rename/delete (manage), members and roles
// (manage), leave. Their items show in the Vault view (see sharedEntries).

const ROLE_LABELS = { manage: 'Can manage', edit: 'Can edit', view: 'Can view' };
let _openCollectionId = null;

async function renderTeamCollections(team, members, myId) {
  const box = document.getElementById('team-collections');
  const createRow = document.getElementById('collection-create-row');
  createRow.style.display = 'flex';
  let list;
  try { list = await VaultCollections.list(); } catch { box.innerHTML = '<div class="coll-meta">Could not load collections.</div>'; return; }
  collections = list;
  const mine = list.filter(c => c.teamId === team.id);
  box.innerHTML = mine.length ? '' : '<div class="coll-meta">No collections yet.</div>';
  for (const c of mine) box.appendChild(collectionRow(c, team, members, myId));

  const input = document.getElementById('collection-new-name');
  const createBtn = document.getElementById('collection-create');
  createBtn.onclick = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    if (createBtn.disabled) return; // one at a time: a double click would make two
    createBtn.disabled = true;
    try {
      const c = await VaultCollections.create(team.id, name);
      input.value = '';
      _openCollectionId = c.id;
      setStatus(`Created "${name}"`);
      await renderTeamCollections(team, members, myId);
    } catch { setStatus('Could not create the collection', false); }
    finally { createBtn.disabled = false; }
  };
}

function collectionRow(c, team, members, myId) {
  const row = document.createElement('div');
  row.className = 'coll-row';
  row.dataset.cid = c.id;
  const name = c.name ?? 'Collection (key not on this device)';
  row.innerHTML = `
    <button class="coll-head">
      <span class="coll-name">${esc(name)}</span>
      <span class="coll-meta">${c.members} member${c.members === 1 ? '' : 's'} · ${esc(ROLE_LABELS[c.role] || c.role)}</span>
    </button>
    <div class="coll-body" style="display:none"></div>`;
  const body = row.querySelector('.coll-body');
  row.querySelector('.coll-head').addEventListener('click', async () => {
    const open = body.style.display === 'none';
    _openCollectionId = open ? c.id : null;
    body.style.display = open ? '' : 'none';
    if (open) await renderCollectionBody(body, c, team, members, myId);
  });
  if (_openCollectionId === c.id) {
    body.style.display = '';
    renderCollectionBody(body, c, team, members, myId);
  }
  return row;
}

async function renderCollectionBody(body, c, team, teamMembers, myId) {
  const manage = c.role === 'manage';
  body.innerHTML = '<div class="coll-meta">Loading…</div>';
  let inCollection = [];
  try { inCollection = await VaultCollections.members(c); } catch { /* shown empty */ }
  const rerender = () => renderTeamPanel();
  body.innerHTML = '';
  for (const m of inCollection) {
    const el = document.createElement('div');
    el.className = 'coll-member';
    el.dataset.uid = m.user_id;
    const you = m.user_id === myId;
    el.innerHTML = `<span class="who">${esc(m.email || m.user_id)}${you ? ' (you)' : ''}</span>`;
    if (manage && !you) {
      const sel = document.createElement('select');
      sel.className = 'coll-role';
      for (const r of ['view', 'edit', 'manage']) sel.add(new Option(ROLE_LABELS[r], r, false, r === m.role));
      sel.addEventListener('change', async () => {
        try { await VaultCollections.setRole(c, m.user_id, sel.value); setStatus('Role updated'); } catch { setStatus('Could not change the role', false); rerender(); }
      });
      const rm = document.createElement('button');
      rm.className = 'coll-link danger coll-remove';
      rm.textContent = 'Remove';
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove ${m.email || 'this teammate'} from "${c.name}"?`)) return;
        try {
          await VaultCollections.removeMember(c, m.user_id);
          el.remove();
          await showRotationAdvice(body, c, m.email);
        } catch { setStatus('Could not remove them', false); }
      });
      el.append(sel, rm);
    } else {
      el.insertAdjacentHTML('beforeend', `<span class="coll-meta">${esc(ROLE_LABELS[m.role] || m.role)}</span>`);
    }
    body.appendChild(el);
  }

  if (manage && c.key) {
    const candidates = teamMembers.filter(t => !inCollection.some(m => m.user_id === t.user_id));
    if (candidates.length) {
      const add = document.createElement('div');
      add.className = 'coll-add';
      const who = document.createElement('select');
      who.className = 'who';
      for (const t of candidates) who.add(new Option(`${t.email || t.user_id}${t.public_key ? '' : ' (not signed in yet)'}`, t.user_id));
      const role = document.createElement('select');
      role.className = 'coll-new-role';
      for (const r of ['view', 'edit', 'manage']) role.add(new Option(ROLE_LABELS[r], r, false, r === 'edit'));
      const btn = document.createElement('button');
      btn.className = 'btn-crypto-ok coll-add-btn';
      btn.textContent = 'Add';
      btn.addEventListener('click', async () => {
        const user = candidates.find(t => t.user_id === who.value);
        btn.disabled = true;
        try { await VaultCollections.addMember(c, user, role.value); setStatus(`Added ${user.email || 'teammate'}`); rerender(); }
        catch (e) { setStatus(e.message || 'Could not add them', false); btn.disabled = false; }
      });
      add.append(who, role, btn);
      body.appendChild(add);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'coll-actions';
  if (manage && c.key) {
    const rename = document.createElement('button');
    rename.className = 'coll-link coll-rename';
    rename.textContent = 'Rename';
    rename.addEventListener('click', async () => {
      const name = prompt('New name', c.name || '')?.trim();
      if (!name) return;
      try { await VaultCollections.rename(c, name); await refreshSharedItems(); rerender(); } catch { setStatus('Could not rename it', false); }
    });
    const del = document.createElement('button');
    del.className = 'coll-link danger coll-delete';
    del.textContent = 'Delete collection';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${c.name}" and everything in it, for everyone?`)) return;
      try { await VaultCollections.remove(c); _openCollectionId = null; await refreshSharedItems(); rerender(); } catch { setStatus('Could not delete it', false); }
    });
    actions.append(rename, del);
  }
  const leave = document.createElement('button');
  leave.className = 'coll-link danger coll-leave';
  leave.textContent = 'Leave';
  leave.addEventListener('click', async () => {
    if (!confirm(`Leave "${c.name}"? Its items disappear from your vault (yours are untouched).`)) return;
    try { await VaultCollections.removeMember(c, myId); await VaultCollections.forget(c.id); await refreshSharedItems(); rerender(); }
    catch { setStatus('Could not leave it', false); }
  });
  actions.append(leave);
  body.appendChild(actions);
}

// Someone removed from a collection may have copied what they saw: suggest
// changing the passwords they had access to.
async function showRotationAdvice(body, c, who) {
  const note = document.createElement('div');
  note.className = 'coll-note rotate-advice';
  let titles;
  try {
    await VaultCollections.pull(c); // what's in it now, not what this popup saw
    titles = (await VaultCollections.items(c)).filter(i => Vault.getValue(i, 'password') || Vault.getValue(i, 'clientSecret') || Vault.getValue(i, 'apiKey')).map(i => i.title);
  } catch { titles = null; }
  if (titles === null) {
    note.textContent = `${who || 'They'} could see everything in "${c.name}". Consider changing the passwords and keys kept there.`;
  } else if (!titles.length) {
    return;
  } else {
    note.textContent = `${who || 'They'} could see ${titles.length} secret${titles.length === 1 ? '' : 's'} here: ${titles.slice(0, 5).join(', ')}${titles.length > 5 ? '…' : ''}. Consider changing ${titles.length === 1 ? 'it' : 'them'}.`;
  }
  body.prepend(note);
}

// ── Team shared codes ("Shared with you") ──────────────────────────────────────

const SVG_REFRESH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`;

let _sharedRefreshTimer = null;

// Startup, the 30s auto-refresh and any later call can overlap. Only the
// newest call may touch the DOM, so a slower stale one can't hide or
// overwrite the section after a newer one already rendered it.
let _sharedRenderSeq = 0;

async function renderSharedCodes() {
  if (typeof Sharing === 'undefined') return;
  const section = document.getElementById('shared-section');
  const list = document.getElementById('shared-list');
  if (!section || !list) return;
  const seq = ++_sharedRenderSeq;
  const stale = () => seq !== _sharedRenderSeq;

  let team, codes;
  try {
    team = await Sharing.getMyTeam();
    if (stale()) return;
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
  } catch { if (!stale()) section.style.display = 'none'; return; }
  if (stale()) return;

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
  if (stale()) return;

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
