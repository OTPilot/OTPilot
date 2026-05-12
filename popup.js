// Storage schema: { accounts: [{name, secret, urls}], activeIndex: 0,
//                   auth: {salt,iv,data}, sessionExpiry: number, sessionDuration: number }

let accounts = [];
let activeIndex = 0;
let currentCode = '';
let timerInterval = null;
let obfuscated = true;

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
    chrome.storage.local.get(['accounts', 'activeIndex', 'obfuscated'], d => {
      accounts = d.accounts || [];
      activeIndex = Math.min(d.activeIndex ?? 0, Math.max(accounts.length - 1, 0));
      obfuscated = d.obfuscated ?? true;
      applyObfuscateBtn();
      r();
    })
  );
}

function saveState() {
  return new Promise(r => chrome.storage.local.set({ accounts, activeIndex }, r));
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

const CHIP_COUNT = 3;
let overflowOpen = false;

function closeOverflow() {
  overflowOpen = false;
  document.getElementById('account-overflow-panel').style.display = 'none';
  document.getElementById('account-overflow-btn')?.classList.remove('active');
}

function renderAccountBar() {
  closeOverflow();
  const bar = document.getElementById('account-bar');
  bar.innerHTML = '';

  accounts.slice(0, CHIP_COUNT).forEach((acc, i) => {
    const chip = document.createElement('button');
    chip.className = 'acc-chip' + (i === activeIndex ? ' active' : '');

    const av = document.createElement('span');
    av.className = 'acc-av';
    av.style.background = accentColor(acc.name || '');
    av.textContent = nameInitials(acc.name);

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

  if (accounts.length > CHIP_COUNT) {
    const hasActiveInOverflow = activeIndex >= CHIP_COUNT;
    const btn = document.createElement('button');
    btn.id = 'account-overflow-btn';
    btn.className = 'acc-overflow-btn' + (hasActiveInOverflow ? ' has-active' : '');
    btn.textContent = '+' + (accounts.length - CHIP_COUNT);
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
    const name = acc.name || 'Unnamed';
    const email = acc.email || '';
    if (q && !name.toLowerCase().includes(q) && !email.toLowerCase().includes(q)) return;

    const item = document.createElement('button');
    item.className = 'acc-overflow-item' + (i === activeIndex ? ' active' : '');

    const av = document.createElement('span');
    av.className = 'acc-av acc-av-md';
    av.style.background = accentColor(name);
    av.textContent = nameInitials(name);

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

function renderAccountsList() {
  draft = accounts.map(a => ({ ...a })); // clone
  rebuildAccountsDOM();
}

function rebuildAccountsDOM() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = '';

  draft.forEach((acc, i) => {
    const card = document.createElement('div');
    card.className = 'acc-card';
    card.innerHTML = `
      <div class="acc-card-header">
        <div class="acc-card-title">
          <span class="acc-card-name">${esc(acc.name) || `Account ${i + 1}`}</span>
          ${acc.email ? `<span class="acc-card-email">${esc(acc.email)}</span>` : ''}
        </div>
        <button class="btn-del" data-i="${i}" title="Delete">✕</button>
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
    container.appendChild(card);

    card.querySelector('.btn-del').addEventListener('click', () => {
      draft.splice(i, 1);
      rebuildAccountsDOM();
    });
    card.querySelector('.btn-eye').addEventListener('click', e => {
      const btn = e.currentTarget;
      const inp = btn.previousElementSibling;
      const reveal = inp.type === 'password';
      inp.type = reveal ? 'text' : 'password';
      btn.innerHTML = reveal ? SVG_EYE_OFF : SVG_EYE;
    });
  });
}

function esc(s = '') {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

document.getElementById('btn-add').addEventListener('click', () => {
  draft.push({ name: '', secret: '', urls: '' });
  rebuildAccountsDOM();
  // scroll to the new card
  const container = document.getElementById('accounts-list');
  container.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.getElementById('btn-save-all').addEventListener('click', async () => {
  // read current DOM values into draft
  document.querySelectorAll('.acc-card').forEach((card, i) => {
    draft[i].name     = card.querySelector('.acc-name').value.trim();
    draft[i].email    = card.querySelector('.acc-email').value.trim();
    draft[i].secret   = card.querySelector('.acc-secret').value.trim();
    draft[i].urls     = card.querySelector('.acc-urls').value.trim();
    draft[i].autofill = card.querySelector('.acc-autofill').checked;
  });

  if (draft.some(a => !a.name)) { setStatus('Every account needs a name', false); return; }

  accounts = draft;
  activeIndex = Math.min(activeIndex, Math.max(accounts.length - 1, 0));
  await saveState();

  renderAccountBar();
  startTimer();
  showView('home');
  setStatus('Saved');
});

// ── View switching ────────────────────────────────────────────────────────────

function showView(view) {
  if (view !== 'home') closeOverflow();
  document.getElementById('home-view').style.display     = view === 'home'     ? '' : 'none';
  document.getElementById('settings-panel').style.display = view === 'accounts' ? '' : 'none';
  document.getElementById('config-panel').style.display  = view === 'settings' ? '' : 'none';
  document.getElementById('nav-home').classList.toggle('active',     view === 'home');
  document.getElementById('nav-settings').classList.toggle('active', view === 'accounts');
  document.getElementById('nav-config').classList.toggle('active',   view === 'settings');
  if (view === 'accounts') renderAccountsList();
}

document.getElementById('nav-home').addEventListener('click',    () => showView('home'));
document.getElementById('nav-settings').addEventListener('click', () => showView('accounts'));
document.getElementById('nav-config').addEventListener('click',   () => showView('settings'));

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
  const toAdd = selectedAccounts.filter(a => !existingSecrets.has(normSecret(a.secret)));
  accounts = [...accounts, ...toAdd];
  await saveState();
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

// ── Ko-fi link ────────────────────────────────────────────────────────────────

document.getElementById('kofi-link').addEventListener('click', e => {
  e.preventDefault();
  setStatus('Thanks for the support! ☕');
  chrome.tabs.create({ url: 'https://ko-fi.com/carpedev' });
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  const justAuthenticated = await initLock();
  await loadState();
  await syncActiveIndexToUrl();
  renderAccountBar();
  startTimer();
  if (justAuthenticated) tryAutoFillCurrentTab();
})();
