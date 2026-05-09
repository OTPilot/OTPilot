// Storage schema: { accounts: [{name, secret, urls}], activeIndex: 0 }

let accounts = [];
let activeIndex = 0;
let currentCode = '';
let timerInterval = null;
let obfuscated = true;

// ── Storage ──────────────────────────────────────────────────────────────────

function loadState() {
  return new Promise(r =>
    chrome.storage.local.get(['accounts', 'activeIndex'], d => {
      accounts = d.accounts || [];
      activeIndex = Math.min(d.activeIndex ?? 0, Math.max(accounts.length - 1, 0));
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

// ── Tabs ─────────────────────────────────────────────────────────────────────

function renderTabs() {
  const bar = document.getElementById('tabs-bar');
  bar.innerHTML = '';
  accounts.forEach((acc, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (i === activeIndex ? ' active' : '');
    btn.textContent = acc.name || 'Unnamed';
    btn.addEventListener('click', () => {
      activeIndex = i;
      saveState();
      renderTabs();
      startTimer();
    });
    bar.appendChild(btn);
  });
}

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
    countdown.textContent = 'Add an account in Settings';
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

document.getElementById('btn-obfuscate').addEventListener('click', () => {
  obfuscated = !obfuscated;
  const btn = document.getElementById('btn-obfuscate');
  btn.classList.toggle('revealed', !obfuscated);
  btn.title = obfuscated ? 'Show code' : 'Hide code';
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
        <span class="acc-card-title">Account ${i + 1}</span>
        <button class="btn-del" data-i="${i}" title="Delete">✕</button>
      </div>
      <div class="acc-field">
        <label>Name</label>
        <input class="acc-name" type="text" placeholder="e.g. My Project QA" value="${esc(acc.name)}">
      </div>
      <div class="acc-field">
        <label>Secret (base32 or hex)</label>
        <div class="field-row">
          <input class="acc-secret" type="password" placeholder="Secret" value="${esc(acc.secret)}" autocomplete="off">
          <button class="btn-eye" title="Show/hide">👁</button>
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
      const inp = e.target.previousElementSibling;
      inp.type = inp.type === 'password' ? 'text' : 'password';
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
    draft[i].secret   = card.querySelector('.acc-secret').value.trim();
    draft[i].urls     = card.querySelector('.acc-urls').value.trim();
    draft[i].autofill = card.querySelector('.acc-autofill').checked;
  });

  if (draft.some(a => !a.name)) { setStatus('Every account needs a name', false); return; }

  accounts = draft;
  activeIndex = Math.min(activeIndex, Math.max(accounts.length - 1, 0));
  await saveState();

  renderTabs();
  renderAccountsList();
  startTimer();
  setStatus('Saved');
});

// Re-render draft when settings panel opens
document.getElementById('settings-panel').addEventListener('toggle', e => {
  if (e.target.open) renderAccountsList();
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

async function runExport(password) {
  if (!accounts.length) throw new Error('No accounts to export');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await deriveKey(password, salt);
  const { iv, data } = await encryptData(key, JSON.stringify(accounts));
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

async function runImport(file, password) {
  const { v, salt, iv, data } = JSON.parse(await file.text());
  if (v !== 1) throw new Error('Unknown backup format');
  const key      = await deriveKey(password, b64dec(salt));
  const plain    = await decryptData(key, iv, data);
  const imported = JSON.parse(plain);
  if (!Array.isArray(imported)) throw new Error('Invalid backup data');

  accounts    = imported;
  activeIndex = 0;
  await saveState();
  renderTabs();
  renderAccountsList();
  startTimer();
}

// ── Crypto form (shared for export & import) ──────────────────────────────────

let cryptoMode  = null; // 'export' | 'import'
let pendingFile = null;

function showCryptoForm(mode) {
  cryptoMode = mode;
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
  cryptoMode  = null;
  pendingFile = null;
}

document.getElementById('btn-export').addEventListener('click', () => {
  showCryptoForm('export');
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
      await runExport(password);
      hideCryptoForm();
      setStatus('Backup exported');
    } else {
      await runImport(pendingFile, password);
      hideCryptoForm();
      setStatus(`Imported ${accounts.length} account(s)`);
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

// ── Ko-fi link ────────────────────────────────────────────────────────────────

document.getElementById('kofi-link').addEventListener('click', e => {
  e.preventDefault();
  setStatus('Thanks for the support! ☕');
  chrome.tabs.create({ url: 'https://ko-fi.com/carpedev' });
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  await loadState();
  renderTabs();
  startTimer();
})();
