// Runs on every page; bails out immediately unless an account URL matches.

function isSessionLocked() {
  return new Promise(r =>
    chrome.storage.local.get(['auth', 'sessionExpiry'], d => {
      if (!d.auth) { r(false); return; }
      r(!d.sessionExpiry || Date.now() >= d.sessionExpiry);
    })
  );
}

function matchesPattern(pattern, hostname) {
  // Strip protocol and path, just match hostname portion
  const host = pattern.trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  if (!host) return false;
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    return hostname === base || hostname.endsWith('.' + base);
  }
  return hostname === host;
}

function findAccount(accounts, hostname) {
  for (const acc of accounts) {
    const patterns = (acc.urls || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (patterns.some(p => matchesPattern(p, hostname))) return acc;
  }
  return null;
}

function findAllMatchingAccounts(accounts, hostname) {
  return accounts.filter(acc => {
    const patterns = (acc.urls || '').split('\n').map(s => s.trim()).filter(Boolean);
    return patterns.some(p => matchesPattern(p, hostname));
  });
}

function getActiveAccount(overrideIndex) {
  return new Promise(r =>
    chrome.storage.local.get(['accounts', 'activeIndex'], d => {
      const accs = d.accounts || [];
      // 1. Try URL-based match first
      const byUrl = findAccount(accs, location.hostname.toLowerCase());
      if (byUrl) { r(byUrl); return; }
      // 2. Fall back to the account selected in the popup (or override from message)
      const idx = overrideIndex ?? d.activeIndex ?? 0;
      r(accs[idx] || null);
    })
  );
}

const OTP_SELECTORS = [
  'input[name="otp_token"]',
  'input[id="id_otp_token"]',
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"][maxlength="6"]',
  'input[type="text"][maxlength="6"]',
  'input[name*="otp"]',
  'input[id*="otp"]',
];

function findOTPInput() {
  for (const sel of OTP_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

function showToast(text, ok = true) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', top: '20px', right: '20px', zIndex: '2147483647',
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '10px 14px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderLeft: `3px solid ${ok ? '#22c55e' : '#ef4444'}`,
    borderRadius: '8px',
    boxShadow: '0 4px 20px rgba(0,0,0,.4)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px', color: '#e2e8f0',
    pointerEvents: 'none',
    maxWidth: '280px',
    transform: 'translateX(120%)',
    transition: 'transform .25s ease, opacity .3s ease',
  });

  const icon = document.createElement('span');
  icon.textContent = ok ? '✓' : '✕';
  Object.assign(icon.style, {
    color: ok ? '#22c55e' : '#ef4444',
    fontWeight: '700', fontSize: '14px', flexShrink: '0',
  });

  const msg = document.createElement('span');
  msg.textContent = text;

  el.appendChild(icon);
  el.appendChild(msg);
  document.body.appendChild(el);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.transform = 'translateX(0)';
  }));

  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(120%)'; }, 2500);
  setTimeout(() => el.remove(), 2800);
}

async function fillOTP(accountIndexHint) {
  const acc = await getActiveAccount(accountIndexHint);
  if (!acc)         return { ok: false, msg: 'No account configured for this URL' };
  if (!acc.secret)  return { ok: false, msg: `No secret set for "${acc.name}"` };

  const input = findOTPInput();
  if (!input) return { ok: false, msg: 'No OTP field found on this page' };

  let code;
  try { code = await generateTOTP(acc.secret); }
  catch (e) { return { ok: false, msg: 'Invalid secret: ' + e.message }; }

  input.focus();
  input.value = code;
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  return { ok: true, code, input };
}

async function fillAndSubmit(accountIndexHint, fromPopup = false) {
  const result = await fillOTP(accountIndexHint);
  if (result.ok) {
    showToast('OTP filled: ' + result.code);
    const form = result.input.closest('form');
    if (form) {
      setTimeout(() => {
        const submitBtn = form.querySelector('[type="submit"]');
        if (submitBtn) submitBtn.click();
        else form.submit();
      }, 600);
    }
  } else if (fromPopup) {
    showToast(result.msg, false);
  }
  return result;
}

async function fillOTPWithAccount(acc) {
  if (!acc.secret) return { ok: false, msg: `No secret set for "${acc.name}"` };
  const input = findOTPInput();
  if (!input) return { ok: false, msg: 'No OTP field found on this page' };
  let code;
  try { code = await generateTOTP(acc.secret); }
  catch (e) { return { ok: false, msg: 'Invalid secret: ' + e.message }; }
  input.focus();
  input.value = code;
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, code, input };
}

async function fillAndSubmitWithAccount(acc) {
  const result = await fillOTPWithAccount(acc);
  if (result.ok) {
    showToast('OTP filled: ' + result.code);
    const form = result.input.closest('form');
    if (form) {
      setTimeout(() => {
        const submitBtn = form.querySelector('[type="submit"]');
        if (submitBtn) submitBtn.click(); else form.submit();
      }, 600);
    }
  }
  return result;
}

// Message from popup "Fill Page" button
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'fill') {
    isSessionLocked().then(locked => {
      if (locked) { reply({ ok: false, msg: 'OTPilot is locked' }); return; }
      fillAndSubmit(msg.accountIndex, true).then(r => reply(r));
    });
    return true;
  }
});

function b64dec(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;
}

async function verifyInContent(password, auth) {
  try {
    const raw = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64dec(auth.salt), hash: 'SHA-256', iterations: 200000 },
      raw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64dec(auth.iv) }, key, b64dec(auth.data)
    );
    return new TextDecoder().decode(plain) === 'otpilot-auth-ok';
  } catch { return false; }
}

function showLockOverlay(accountName, onUnlock) {
  if (document.getElementById('otpilot-lock')) return;

  const el = document.createElement('div');
  el.id = 'otpilot-lock';
  Object.assign(el.style, {
    position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
    width: '260px', background: '#1e293b', border: '1px solid #1e3a5f',
    borderRadius: '10px', boxShadow: '0 4px 20px rgba(0,0,0,.5)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    overflow: 'hidden',
  });

  const safeName = accountName.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  el.innerHTML = `${OVERLAY_HEADER}
    <div style="padding:12px 14px;">
      <div style="color:#cbd5e1;font-size:12px;margin-bottom:10px;">
        Unlock to auto-fill <strong style="color:#f1f5f9;">${safeName}</strong>
      </div>
      ${PW_FIELD_HTML}
      <div style="display:flex;gap:8px;">
        <button class="otpilot-primary" style="flex:1;padding:7px;background:#0ea5e9;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">Unlock</button>
        <button class="otpilot-secondary" style="padding:7px 10px;background:transparent;border:1px solid #334155;border-radius:6px;color:#64748b;font-size:12px;cursor:pointer;">Not now</button>
      </div>
    </div>`;

  document.body.appendChild(el);

  const close      = () => el.remove();
  const primaryBtn = el.querySelector('.otpilot-primary');

  el.querySelector('.otpilot-overlay-close').onclick = close;
  el.querySelector('.otpilot-secondary').onclick     = close;

  const defaultOnUnlock = () => { close(); fillAndSubmit(undefined, false); };
  wirePwField(el, primaryBtn, 'Unlock', onUnlock || defaultOnUnlock);
}

// ── Detect 2FA setup pages ───────────────────────────────────────────────────

const QR_HINTS = ['qr', 'totp', 'otp', 'mfa', '2fa', 'seed', 'authenticator'];

async function decodeQrFromImg(detector, img) {
  let barcodes = [];
  try { barcodes = await detector.detect(img); } catch {}
  if (!barcodes.length) {
    try {
      const res  = await fetch(img.src);
      const blob = await res.blob();
      const bmp  = await createImageBitmap(blob);
      barcodes   = await detector.detect(bmp);
    } catch {}
  }
  return barcodes.map(b => b.rawValue).find(v => v.startsWith('otpauth://')) || null;
}

async function tryDecodeQrImages() {
  if (!('BarcodeDetector' in window)) return null;
  const detector = new BarcodeDetector({ formats: ['qr_code'] });

  // Pass 1: hint-filtered (fast path — covers images with qr/otp/mfa/etc in alt or src)
  const hintImgs = [...document.querySelectorAll('img')].filter(img => {
    const text = ((img.alt || '') + (img.src || '')).toLowerCase();
    return QR_HINTS.some(h => text.includes(h));
  });
  for (const img of hintImgs) {
    const uri = await decodeQrFromImg(detector, img);
    if (uri) return uri;
  }

  // Pass 2: fallback — any visible, reasonably-sized image not already scanned
  const fallbackImgs = [...document.querySelectorAll('img')].filter(img => {
    if (hintImgs.includes(img)) return false;
    if (img.naturalWidth < 80 || img.naturalHeight < 80) return false;
    if (img.offsetParent === null && !img.closest('dialog, [role="dialog"]')) return false;
    return true;
  });
  for (const img of fallbackImgs) {
    const uri = await decodeQrFromImg(detector, img);
    if (uri) return uri;
  }

  return null;
}

async function findOtpAuthUri() {
  // 1. Anchor tag with otpauth:// href
  const a = document.querySelector('a[href^="otpauth://totp/"]');
  if (a) return a.href;
  // 2. URI anywhere in the HTML
  const m = document.body.innerHTML.match(/otpauth:\/\/totp\/[^"'\s<>&#]+/);
  if (m) return decodeURIComponent(m[0]);
  // 3. QR code image (BarcodeDetector)
  return tryDecodeQrImages();
}

function parseOtpAuthUri(uri) {
  try {
    const url = new URL(uri);
    const params = new URLSearchParams(url.search);
    const secret = params.get('secret');
    if (!secret) return null;
    const label = decodeURIComponent(url.pathname.slice(1));
    const colonIdx = label.indexOf(':');
    const issuer = params.get('issuer') || (colonIdx !== -1 ? label.slice(0, colonIdx) : label);
    const email = colonIdx !== -1 ? label.slice(colonIdx + 1) : '';
    return { name: issuer || label, secret, email };
  } catch { return null; }
}

const OVERLAY_HEADER = `
  <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0f172a;border-bottom:1px solid #1e3a5f;">
    <svg width="16" height="16" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
      <path d="M64 18 L98 33 V66 Q98 92 64 110 Q30 92 30 66 V33 Z" fill="#1e3a5f"/>
      <path d="M64 18 L98 33 V66 Q98 92 64 110 Q30 92 30 66 V33 Z" fill="none" stroke="#38bdf8" stroke-width="4.5" stroke-linejoin="round"/>
      <circle cx="64" cy="68" r="20" fill="#0f172a" stroke="#38bdf8" stroke-width="4"/>
      <line x1="64" y1="68" x2="57" y2="54" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>
      <line x1="64" y1="68" x2="78" y2="72" stroke="#38bdf8" stroke-width="3" stroke-linecap="round"/>
      <circle cx="64" cy="68" r="3" fill="#38bdf8"/>
    </svg>
    <span style="color:#f1f5f9;font-size:13px;font-weight:700;flex:1;">OTPilot</span>
    <button class="otpilot-overlay-close" style="background:none;border:none;color:#475569;cursor:pointer;font-size:14px;padding:0;line-height:1;">✕</button>
  </div>`;

const PW_FIELD_HTML = `
  <div style="position:relative;margin-bottom:6px;">
    <input class="otpilot-pw" type="password" placeholder="Master password" autocomplete="current-password"
      style="width:100%;padding:8px 32px 8px 10px;background:#0f172a;border:1px solid #1e3a5f;
             border-radius:6px;color:#e2e8f0;font-size:12px;font-family:monospace;
             outline:none;box-sizing:border-box;">
    <button class="otpilot-pw-eye" tabindex="-1"
      style="position:absolute;right:7px;top:50%;transform:translateY(-50%);
             background:none;border:none;color:#475569;cursor:pointer;font-size:12px;padding:0;line-height:1;">👁</button>
  </div>
  <div class="otpilot-pw-err" style="color:#f87171;font-size:11px;min-height:14px;margin-bottom:6px;"></div>`;

function makeOverlay(id) {
  const el = document.createElement('div');
  el.id = id;
  Object.assign(el.style, {
    position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
    width: '260px', background: '#1e293b', border: '1px solid #1e3a5f',
    borderRadius: '10px', boxShadow: '0 4px 20px rgba(0,0,0,.5)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    overflow: 'hidden',
  });
  return el;
}

function wirePwField(el, primaryBtn, primaryLabel, onSuccess) {
  const pwInput = el.querySelector('.otpilot-pw');
  const errEl   = el.querySelector('.otpilot-pw-err');

  el.querySelector('.otpilot-pw-eye').onclick = () => {
    pwInput.type = pwInput.type === 'password' ? 'text' : 'password';
  };

  async function attempt() {
    const password = pwInput.value;
    if (!password) { errEl.textContent = 'Enter your password'; return; }
    errEl.textContent = '';
    primaryBtn.disabled = true;
    primaryBtn.textContent = 'Verifying…';

    try {
      const { auth, sessionDuration } = await new Promise(r =>
        chrome.storage.local.get(['auth', 'sessionDuration'], r)
      );
      if (await verifyInContent(password, auth)) {
        const dur = sessionDuration || 86400000;
        await new Promise(r => chrome.storage.local.set({ sessionExpiry: Date.now() + dur }, r));
        onSuccess();
      } else {
        errEl.textContent = 'Incorrect password';
        primaryBtn.disabled = false;
        primaryBtn.textContent = primaryLabel;
        pwInput.select();
      }
    } catch {
      errEl.textContent = 'An error occurred';
      primaryBtn.disabled = false;
      primaryBtn.textContent = primaryLabel;
    }
  }

  primaryBtn.onclick = attempt;
  pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  setTimeout(() => pwInput.focus(), 100);
}

function showSuggestionOverlay(name, secret, email = '', locked = false) {
  if (document.getElementById('otpilot-suggestion')) return;

  const el = makeOverlay('otpilot-suggestion');
  const safeName = name.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  el.innerHTML = `${OVERLAY_HEADER}
    <div style="padding:12px 14px;">
      <div style="color:#cbd5e1;font-size:12px;margin-bottom:10px;">
        Save <strong style="color:#f1f5f9;">${safeName}</strong> to OTPilot?
      </div>
      ${locked ? PW_FIELD_HTML : ''}
      <div style="display:flex;gap:8px;">
        <button class="otpilot-primary" style="flex:1;padding:7px;background:#0ea5e9;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">${locked ? 'Unlock & Add' : 'Add account'}</button>
        <button class="otpilot-secondary" style="padding:7px 10px;background:transparent;border:1px solid #334155;border-radius:6px;color:#64748b;font-size:12px;cursor:pointer;">Not now</button>
      </div>
    </div>`;

  document.body.appendChild(el);

  const close      = () => { _dismissedSecrets.add(secret); el.remove(); };
  const primaryBtn = el.querySelector('.otpilot-primary');

  el.querySelector('.otpilot-overlay-close').onclick = close;
  el.querySelector('.otpilot-secondary').onclick     = close;

  function addAccount() {
    chrome.storage.local.get('accounts', d => {
      const accs = d.accounts || [];
      accs.push({ name, secret, urls: location.hostname, autofill: true, email });
      chrome.storage.local.set({ accounts: accs, activeIndex: accs.length - 1 }, () => {
        close();
        showToast(`${name} added to OTPilot`);
      });
    });
  }

  if (locked) {
    wirePwField(el, primaryBtn, 'Unlock & Add', addAccount);
  } else {
    primaryBtn.onclick = addAccount;
  }
}

function showAccountPickerOverlay(matchingAccounts) {
  if (document.getElementById('otpilot-picker')) return;

  const el = makeOverlay('otpilot-picker');
  const close = () => el.remove();

  const rows = matchingAccounts.map(acc => {
    const safeName  = acc.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeEmail = (acc.email || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const emailHtml = safeEmail
      ? `<span style="display:block;color:#64748b;font-size:10px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeEmail}</span>`
      : '';
    return `
      <div class="otpilot-picker-row" style="display:flex;align-items:center;gap:8px;
           padding:8px 14px;border-bottom:1px solid #1e3a5f;">
        <div style="flex:1;min-width:0;">
          <span style="display:block;color:#e2e8f0;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeName}</span>
          ${emailHtml}
        </div>
        <button class="otpilot-fill-btn" style="padding:5px 10px;background:#0ea5e9;border:none;
                border-radius:5px;color:#fff;font-size:11px;font-weight:600;cursor:pointer;">Fill</button>
        <button class="otpilot-copy-btn" style="padding:5px 10px;background:transparent;border:1px solid #334155;
                border-radius:5px;color:#94a3b8;font-size:11px;cursor:pointer;">Copy</button>
      </div>`;
  }).join('');

  el.innerHTML = `${OVERLAY_HEADER}
    <div style="padding:8px 14px 4px;color:#94a3b8;font-size:11px;">Multiple accounts for this site</div>
    ${rows}`;

  document.body.appendChild(el);
  el.querySelector('.otpilot-overlay-close').onclick = close;

  el.querySelectorAll('.otpilot-picker-row').forEach((row, i) => {
    const acc = matchingAccounts[i];
    row.querySelector('.otpilot-fill-btn').onclick = async () => {
      close();
      const result = await fillAndSubmitWithAccount(acc);
      if (!result.ok) showToast(result.msg, false);
    };
    row.querySelector('.otpilot-copy-btn').onclick = async () => {
      try {
        const code = await generateTOTP(acc.secret);
        await navigator.clipboard.writeText(code);
        showToast(`Copied: ${code}`);
      } catch { showToast('Clipboard unavailable', false); }
    };
  });
}

const _dismissedSecrets = new Set();

let _detectionInFlight = false;
let _debounceTimer     = null;

async function runDetection() {
  if (_detectionInFlight) return false;
  _detectionInFlight = true;
  try {
    const uri    = await findOtpAuthUri();
    if (!uri) return false;
    const parsed = parseOtpAuthUri(uri);
    if (!parsed) return false;

    return await new Promise(resolve => {
      chrome.storage.local.get(['accounts', 'auth', 'sessionExpiry'], d => {
        if (!d.auth) { resolve(false); return; }
        if (_dismissedSecrets.has(parsed.secret)) { resolve(false); return; }
        const exists = (d.accounts || []).some(a => a.secret === parsed.secret);
        if (exists)  { resolve(false); return; }
        const locked = !d.sessionExpiry || Date.now() >= d.sessionExpiry;
        showSuggestionOverlay(parsed.name, parsed.secret, parsed.email || '', locked);
        resolve(true);
      });
    });
  } finally {
    _detectionInFlight = false;
  }
}

(async function startDetection() {
  let observer;
  const hardTimeoutId = setTimeout(() => { if (observer) observer.disconnect(); }, 30_000);

  function scheduleDetection() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => runDetection(), 300);
  }

  function onMutation(mutations) {
    scheduleDetection();
    // If a newly-added img hasn't loaded yet, re-scan once it does
    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (node.nodeType !== 1) continue;
        const imgs = node.tagName === 'IMG' ? [node] : [...node.querySelectorAll('img')];
        for (const img of imgs) {
          if (!img.complete || img.naturalWidth === 0) {
            img.addEventListener('load', scheduleDetection, { once: true });
          }
        }
      }
    }
  }

  observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true });

  await runDetection();
})();

// Auto-fill when an OTP input is present (page load or injected into a modal)
(async () => {
  const { accounts = [] } = await new Promise(r => chrome.storage.local.get('accounts', r));
  const hostname = location.hostname.toLowerCase();
  const matching = findAllMatchingAccounts(accounts, hostname).filter(a => a.autofill !== false);

  if (matching.length === 0) return;

  // ── Single account: existing auto-fill behavior ──────────────────────────
  if (matching.length === 1) {
    const acc = matching[0];
    let _fillDebounce = null;
    let _lastFilledInput = null;

    async function tryAutoFill() {
      const input = findOTPInput();
      if (!input || input === _lastFilledInput) return;
      _lastFilledInput = input;
      if (await isSessionLocked()) { showLockOverlay(acc.name); return; }
      fillAndSubmit(undefined, false);
    }

    function scheduleFill() {
      clearTimeout(_fillDebounce);
      _fillDebounce = setTimeout(tryAutoFill, 300);
    }

    await new Promise(r => setTimeout(r, 400));
    await tryAutoFill();

    const fillObserver = new MutationObserver(scheduleFill);
    fillObserver.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => fillObserver.disconnect(), 120_000);
    return;
  }

  // ── Multiple accounts: show picker when OTP input appears ────────────────
  let _pickerDebounce = null;
  let _pickerShown    = false;

  async function tryShowPicker() {
    if (_pickerShown) return;
    const input = findOTPInput();
    if (!input) return;
    _pickerShown = true;

    if (await isSessionLocked()) {
      showLockOverlay('OTPilot', () => {
        document.getElementById('otpilot-lock')?.remove();
        showAccountPickerOverlay(matching);
      });
      return;
    }
    showAccountPickerOverlay(matching);
  }

  function schedulePicker() {
    clearTimeout(_pickerDebounce);
    _pickerDebounce = setTimeout(tryShowPicker, 300);
  }

  await new Promise(r => setTimeout(r, 400));
  await tryShowPicker();

  const pickerObserver = new MutationObserver(schedulePicker);
  pickerObserver.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => pickerObserver.disconnect(), 120_000);
})();
