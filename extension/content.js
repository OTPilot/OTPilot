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
  const host = pattern.trim().replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '').toLowerCase();
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
  'input[name*="token"]:not([name*="csrf"]):not([name*="reset"]):not([name*="access"]):not([name*="invite"]):not([name*="confirm"]):not([name*="auth"])',
  'input[id*="token"]:not([id*="csrf"]):not([id*="reset"]):not([id*="access"]):not([id*="invite"]):not([id*="confirm"]):not([id*="auth"])',
  'input[name*="code"]:not([name*="postal"]):not([name*="zip"]):not([name*="promo"]):not([name*="coupon"]):not([name*="discount"]):not([name*="referral"]):not([name*="verification"]):not([name*="activation"]):not([name*="invite"]):not([name*="recovery"])',
  'input[id*="code"]:not([id*="postal"]):not([id*="zip"]):not([id*="promo"]):not([id*="coupon"]):not([id*="discount"]):not([id*="referral"]):not([id*="verification"]):not([id*="activation"]):not([id*="invite"]):not([id*="recovery"])',
  'input[data-testid*="otp"]',
  'input[data-testid*="token"]:not([data-testid*="csrf"]):not([data-testid*="reset"]):not([data-testid*="access"]):not([data-testid*="invite"]):not([data-testid*="confirm"]):not([data-testid*="auth"])',
  // Twitter / X 2FA confirmation screen
  'input[data-testid="ocfEnterTextTextInput"]',
];

const CODE_PAGE_HINTS = [
  'confirmation code', 'verification code', 'enter the code',
  'enter your code', 'authentication code', 'enter code',
];

function findOTPInput() {
  for (const sel of OTP_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }

  // Context-aware fallback: on a code-entry page, pick the first visible
  // non-readonly text/number/tel input that is within or near the code prompt.
  const pageText = (document.body.innerText || '').toLowerCase();
  if (CODE_PAGE_HINTS.some(h => pageText.includes(h))) {
    // Mirror the same exclusions used in OTP_SELECTORS so the fallback doesn't
    // pick up inputs that were explicitly excluded from the primary selectors.
    const NON_OTP_FRAGMENTS = [
      'postal', 'zip', 'promo', 'coupon', 'discount', 'referral',
      'verification', 'activation', 'invite', 'recovery',
      'csrf', 'reset', 'access', 'confirm', 'auth',
    ];
    const inputs = [...document.querySelectorAll(
      'input[type="text"], input[type="number"], input[type="tel"], input:not([type])'
    )].filter(el => {
      if (!el.offsetParent || el.readOnly || el.disabled) return false;
      const haystack = `${el.name || ''} ${el.id || ''} ${el.dataset.testid || ''}`.toLowerCase();
      return !NON_OTP_FRAGMENTS.some(f => haystack.includes(f));
    });

    // Prefer inputs whose surrounding form/dialog contains code-page hints.
    // Intentionally limited to form/dialog — broader ancestors (main, section) span
    // entire pages and cause false positives when page content mentions these phrases.
    for (const inp of inputs) {
      const section = inp.closest('form, [role="dialog"]') || inp.parentElement;
      const sectionText = (section?.innerText || '').toLowerCase();
      if (CODE_PAGE_HINTS.some(h => sectionText.includes(h))) return inp;
    }
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

function fillInputValue(input, code) {
  // React (and other framework) inputs ignore direct .value = assignment because the
  // framework tracks the previous value internally. Using the native prototype setter
  // bypasses that check so the synthetic 'input' event is treated as a real user edit.
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  function setVal(el, val) {
    if (nativeSetter) nativeSetter.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Detect split OTP (e.g. Spotify, GitHub): multiple autocomplete="one-time-code"
  // inputs inside the same form/container — each box holds one digit.
  const container = input.closest('form, [role="group"], [role="dialog"]')
    ?? input.parentElement?.parentElement?.parentElement;
  const group = container
    ? [...container.querySelectorAll('input[autocomplete="one-time-code"]')]
        .filter(el => el.offsetParent !== null && !el.disabled && !el.readOnly)
    : [];

  if (group.length > 1) {
    group.forEach((el, i) => { el.focus(); setVal(el, code[i] ?? ''); });
    return;
  }

  input.focus();
  setVal(input, code);
}

function showEmailOtpBanner(code, input) {
  if (document.getElementById('otpilot-email-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'otpilot-email-banner';
  Object.assign(banner.style, {
    position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '2147483647', display: 'flex', alignItems: 'center', gap: '10px',
    padding: '10px 14px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderLeft: '3px solid #38bdf8',
    borderRadius: '8px',
    boxShadow: '0 4px 20px rgba(0,0,0,.4)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px', color: '#e2e8f0',
    maxWidth: '320px',
  });

  const label = document.createElement('span');
  label.textContent = `📧 Email code: ${code}`;

  const btn = document.createElement('button');
  btn.textContent = 'Fill';
  Object.assign(btn.style, {
    padding: '4px 10px', background: '#38bdf8', color: '#0f172a',
    border: 'none', borderRadius: '5px', fontSize: '12px',
    fontWeight: '700', cursor: 'pointer', flexShrink: '0',
  });
  btn.addEventListener('click', () => {
    fillInputValue(input, code);
    banner.remove();
  });

  const close = document.createElement('button');
  close.textContent = '✕';
  Object.assign(close.style, {
    background: 'none', border: 'none', color: '#64748b',
    fontSize: '13px', cursor: 'pointer', padding: '0 2px', flexShrink: '0',
  });
  close.addEventListener('click', () => banner.remove());

  banner.append(label, btn, close);
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 30000);
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

  fillInputValue(input, code);

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
  fillInputValue(input, code);
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

function showLockOverlay(accountName, onUnlock, onDismiss) {
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

  const close      = () => { el.remove(); onDismiss?.(); };
  const primaryBtn = el.querySelector('.otpilot-primary');

  el.querySelector('.otpilot-overlay-close').onclick = close;
  el.querySelector('.otpilot-secondary').onclick     = close;

  const defaultOnUnlock = () => { el.remove(); fillAndSubmit(undefined, false); };
  wirePwField(el, primaryBtn, 'Unlock', onUnlock || defaultOnUnlock);
}

// ── Detect 2FA setup pages ───────────────────────────────────────────────────

const QR_HINTS = ['qr', 'totp', 'otp', 'mfa', '2fa', 'seed', 'authenticator'];

// Tries BarcodeDetector (native, fast) then jsQR (pure-JS fallback for Linux CI
// where Playwright's Chromium may lack a working ZXing backend).
async function scanCanvas(canvas) {
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const barcodes = await detector.detect(canvas);
      const uri = barcodes.map(b => b.rawValue).find(v => v.startsWith('otpauth://'));
      if (uri) return uri;
    } catch {}
  }
  if (typeof jsQR === 'function') {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(data, width, height);
      if (result?.data?.startsWith('otpauth://')) return result.data;
    } catch {}
  }
  return null;
}

async function decodeQrFromImg(img) {
  // Draw onto a canvas first so both BarcodeDetector and jsQR can consume it.
  // Canvas fallback: load a fresh copy so we're not racing the original element's
  // render state (e.g. data: URLs in fixed-position modals may have complete=true
  // but naturalWidth=0 until the browser decodes them).
  const drawAndScan = async (src) => {
    const fresh = new Image();
    await new Promise((res, rej) => { fresh.onload = res; fresh.onerror = rej; fresh.src = src; });
    const canvas = document.createElement('canvas');
    canvas.width = fresh.naturalWidth;
    canvas.height = fresh.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(fresh, 0, 0);
    return scanCanvas(canvas);
  };

  // Direct element detection (BarcodeDetector only — jsQR needs a canvas)
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const barcodes = await detector.detect(img);
      const uri = barcodes.map(b => b.rawValue).find(v => v.startsWith('otpauth://'));
      if (uri) return uri;
    } catch {}
  }

  // Canvas redraw (works for both BarcodeDetector and jsQR)
  try {
    const uri = await drawAndScan(img.src);
    if (uri) return uri;
  } catch {}

  // Same-origin fetch → canvas
  if (!img.src.startsWith('data:')) {
    try {
      const res  = await fetch(img.src);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      try {
        const uri = await drawAndScan(url);
        if (uri) return uri;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {}
  }

  // CORS fallback: route the fetch through the background service worker
  if (img.src.startsWith('http') && chrome.runtime?.id) {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'fetchImageBuffer', url: img.src });
      if (resp?.ok) {
        const url = URL.createObjectURL(new Blob([new Uint8Array(resp.data)]));
        try {
          const uri = await drawAndScan(url);
          if (uri) return uri;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    } catch {}
  }

  return null;
}

async function tryDecodeQrImages() {
  const hasDetector = 'BarcodeDetector' in window;
  const hasJsQR = typeof jsQR === 'function';
  if (!hasDetector && !hasJsQR) return null;

  // Pass 1: hint-filtered (fast path — covers images with qr/otp/mfa/etc in alt or src)
  const hintImgs = [...document.querySelectorAll('img')].filter(img => {
    const text = ((img.alt || '') + (img.src || '')).toLowerCase();
    return QR_HINTS.some(h => text.includes(h));
  });
  for (const img of hintImgs) {
    const uri = await decodeQrFromImg(img);
    if (uri) return uri;
  }

  // Pass 2: fallback — any visible, reasonably-sized image not already scanned
  const fallbackImgs = [...document.querySelectorAll('img')].filter(img => {
    if (hintImgs.includes(img)) return false;
    // Allow naturalWidth=0 (not yet decoded) — decodeQrFromImg loads a fresh copy.
    // Only exclude images that are loaded AND genuinely small (decorative).
    if (img.naturalWidth > 0 && (img.naturalWidth < 80 || img.naturalHeight < 80)) return false;
    if (img.offsetParent === null && !img.closest('dialog, [role="dialog"]')) return false;
    return true;
  });
  for (const img of fallbackImgs) {
    const uri = await decodeQrFromImg(img);
    if (uri) return uri;
  }

  // Pass 3: canvas elements (some sites render QR to canvas instead of <img>)
  for (const canvas of document.querySelectorAll('canvas')) {
    if (canvas.width < 80 || canvas.height < 80) continue;
    if (canvas.offsetParent === null && !canvas.closest('dialog, [role="dialog"]')) continue;
    try {
      const uri = await scanCanvas(canvas);
      if (uri) return uri;
    } catch {}
  }

  // Pass 4: inline SVG elements (e.g. Sentry uses qrcode.react which renders SVG directly)
  for (const svg of document.querySelectorAll('svg')) {
    if (svg.offsetParent === null && !svg.closest('dialog, [role="dialog"]')) continue;
    const rect = svg.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) continue;
    try {
      const svgData = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const offscreen = new Image();
      try {
        await new Promise((res, rej) => { offscreen.onload = res; offscreen.onerror = rej; offscreen.src = url; });
      } finally {
        URL.revokeObjectURL(url);
      }
      // Render at an integer multiple of the viewBox so modules align exactly
      // to pixel boundaries — anti-aliased edges at fractional scale confuse decoders.
      const vbSize = Math.max(svg.viewBox?.baseVal?.width || 0, svg.viewBox?.baseVal?.height || 0);
      const scale = vbSize > 0 ? Math.max(1, Math.ceil(400 / vbSize)) : 1;
      const canvasSize = vbSize > 0 ? vbSize * scale : Math.max(Math.round(rect.width), 400);
      const canvas = document.createElement('canvas');
      canvas.width = canvasSize;
      canvas.height = canvasSize;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      // White background is required — SVG QR codes have no background rect, so
      // dark modules on a transparent canvas produce an all-dark result.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvasSize, canvasSize);
      ctx.drawImage(offscreen, 0, 0, canvasSize, canvasSize);
      const uri = await scanCanvas(canvas);
      if (uri) return uri;
    } catch {}
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

function guessIssuerFromPage() {
  const ogSite = document.querySelector('meta[property="og:site_name"]')?.content?.trim();
  if (ogSite) return ogSite;
  const appName = document.querySelector('meta[name="application-name"]')?.content?.trim();
  if (appName) return appName;
  const host = location.hostname.replace(/^(www\.|app\.)/, '');
  const name = host.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const TWOFACTOR_HINTS = [
  'two-factor', '2fa', 'totp', 'authenticator', 'qr code',
  "can't scan", 'cannot scan', 'secret key', 'verification app',
  'authentication app', 'link the app', 'link your app',
];

function findPlainTextSecret() {
  // Only scan pages whose URL suggests a 2FA/security setup flow.
  // Uses word-boundary matching (URL separators) so that 'otp' in '/otpilot/' does NOT match.
  // Also checks location.hash so hash-router SPAs (#/two-factor/setup) are covered.
  const path = (location.pathname + location.search + location.hash).toLowerCase();
  const PATH_RE = /(?:^|[/\-_.=?&#])(?:2fa|mfa|otp|totp|two[-_](?:factor|step)|multi[-_]?factor|enroll(?:ment)?|authenticator|security)(?=[/\-_.=?&#]|$)/;
  if (!PATH_RE.test(path)) return null;

  const bodyText = (document.body.innerText || '').toLowerCase();
  if (!TWOFACTOR_HINTS.some(h => bodyText.includes(h))) return null;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('code, pre, kbd, script, style')) continue;
    const raw = node.textContent.trim();
    if (!raw) continue;
    const compact = raw.replace(/\s/g, '').toUpperCase();
    if (
      compact.length >= 16 && compact.length <= 64 &&
      /^[A-Z2-7]+$/.test(compact) &&
      /[2-7]/.test(compact)
    ) {
      // Reject if the secret is buried inside a larger paragraph — real secret
      // displays are standalone, not embedded in prose.
      const parentText = (node.parentElement?.innerText || '').replace(/\s/g, '');
      if (parentText.length > compact.length * 4) continue;
      return { secret: compact, name: guessIssuerFromPage(), email: '' };
    }
  }

  // Some sites (e.g. Sentry) show the secret inside an <input> value rather than a text node.
  for (const el of document.querySelectorAll('input[type="text"], input[readonly], input:not([type]), textarea')) {
    if (!el.offsetParent || el.disabled) continue;
    const raw = (el.value || '').trim();
    if (!raw) continue;
    const compact = raw.replace(/\s/g, '').toUpperCase();
    if (
      compact.length >= 16 && compact.length <= 64 &&
      /^[A-Z2-7]+$/.test(compact) &&
      /[2-7]/.test(compact)
    ) {
      return { secret: compact, name: guessIssuerFromPage(), email: '' };
    }
  }

  return null;
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

function showCodeRevealOverlay(name, code) {
  if (document.getElementById('otpilot-code-reveal')) return;
  const el = makeOverlay('otpilot-code-reveal');
  const safeName = name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const formatted = code.slice(0, 3) + ' ' + code.slice(3);
  el.innerHTML = `${OVERLAY_HEADER}
    <div style="padding:12px 14px;">
      <div style="color:#94a3b8;font-size:11px;margin-bottom:6px;">${safeName} added — copy your code:</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="otpilot-reveal-code" style="flex:1;font-size:22px;font-weight:700;letter-spacing:3px;color:#f1f5f9;font-family:monospace;">${formatted}</span>
        <button class="otpilot-copy-code" style="padding:6px 12px;background:#0ea5e9;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">Copy</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector('.otpilot-overlay-close').onclick = close;
  el.querySelector('.otpilot-copy-code').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      const btn = el.querySelector('.otpilot-copy-code');
      btn.textContent = 'Copied!';
      setTimeout(close, 1200);
    } catch { close(); }
  };
  setTimeout(close, 15_000);
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

  async function addAccount() {
    const d = await new Promise(r => chrome.storage.local.get('accounts', r));
    const accs = d.accounts || [];
    accs.push({ name, secret, urls: location.hostname, autofill: true, email });
    await new Promise(r => chrome.storage.local.set({ accounts: accs, activeIndex: accs.length - 1 }, r));
    _dismissedSecrets.add(secret);
    el.remove();
    let code = '';
    try { code = await generateTOTP(secret); } catch {}
    if (code) {
      showCodeRevealOverlay(name, code);
    } else {
      showToast(`${name} added to OTPilot`);
    }
  }

  if (locked) {
    wirePwField(el, primaryBtn, 'Unlock & Add', addAccount);
  } else {
    primaryBtn.onclick = addAccount;
  }
}

function showAccountPickerOverlay(matchingAccounts, onClose) {
  if (document.getElementById('otpilot-picker')) return;

  const el = makeOverlay('otpilot-picker');
  const close = () => { el.remove(); onClose?.(); };

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
    const uri = await findOtpAuthUri();
    const parsed = uri ? parseOtpAuthUri(uri) : findPlainTextSecret();
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
    _debounceTimer = setTimeout(() => {
      if (!chrome.runtime?.id) { observer?.disconnect(); return; }
      runDetection();
    }, 300);
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

// Auto-fill when an OTP input is present (page load or injected into a modal).
// Accounts are read from storage on every check so that accounts added after
// page load (e.g. via the suggestion overlay) are picked up immediately.
(async () => {
  let _fillDebounce        = null;
  let _lastFilledInput     = null;
  let _pickerDismissed     = false;
  let _pickerDismissedFor  = null;
  let _lockDismissed       = false;
  let _lockDismissedFor    = null;

  function isEnrollmentPage() {
    // Suppress auto-fill on 2FA setup/enrollment pages. Requires PATH_RE to match
    // (same guard as findPlainTextSecret) so random pages with off-screen readonly
    // inputs containing base32-looking strings don't silently break auto-fill.
    const path = (location.pathname + location.search + location.hash).toLowerCase();
    const PATH_RE = /(?:^|[/\-_.=?&#])(?:2fa|mfa|otp|totp|two[-_](?:factor|step)|multi[-_]?factor|enroll(?:ment)?|authenticator|security)(?=[/\-_.=?&#]|$)/;
    if (!PATH_RE.test(path)) return false;
    return [...document.querySelectorAll(
      'input[type="text"], input[readonly], input:not([type]), textarea'
    )].some(el => {
      if (!el.offsetParent || el.disabled) return false;
      const v = (el.value || '').replace(/\s/g, '').toUpperCase();
      return v.length >= 16 && v.length <= 64 && /^[A-Z2-7]+$/.test(v) && /[2-7]/.test(v);
    });
  }

  async function tryAutoFill() {
    if (isEnrollmentPage()) return;

    const { accounts = [] } = await new Promise(r => chrome.storage.local.get('accounts', r));
    const hostname = location.hostname.toLowerCase();
    const matching = findAllMatchingAccounts(accounts, hostname).filter(a => a.autofill !== false);

    const input = findOTPInput();
    if (!input) {
      console.debug('[OTPilot] tryAutoFill: no OTP input found on page');
      return;
    }

    // Email OTP fallback: if no TOTP account matches, try reading from Gmail/Outlook.
    if (matching.length === 0) {
      console.debug('[OTPilot] tryAutoFill: no matching TOTP account — trying email OTP');
      if (!chrome.runtime?.id) return;
      const stored = await new Promise(r => chrome.storage.local.get('emailAutoFill', r));
      const emailAutoFill = stored.emailAutoFill ?? true;
      const resp = await new Promise(r =>
        chrome.runtime.sendMessage({ action: 'getEmailOtp' }, r)
      ).catch(() => null);
      const code = resp?.code ?? null;
      if (!code) {
        console.debug('[OTPilot] tryAutoFill: email OTP not found (no webmail tab open or no code in inbox)');
        return;
      }
      if (input === _lastFilledInput) return;
      if (emailAutoFill) {
        console.debug('[OTPilot] tryAutoFill: filling email OTP', code);
        _lastFilledInput = input;
        fillInputValue(input, code);
        showToast('📧 Email code filled: ' + code);
      } else {
        console.debug('[OTPilot] tryAutoFill: showing email OTP banner (auto-fill disabled)', code);
        showEmailOtpBanner(code, input);
      }
      return;
    }

    if (matching.length === 1) {
      if (input === _lastFilledInput) return;
      _lastFilledInput = input;
      const acc = matching[0];
      if (await isSessionLocked()) { showLockOverlay(acc.name); return; }
      fillAndSubmit(undefined, false);
    } else {
      if (document.getElementById('otpilot-picker')) return;
      // Same input the user already closed the picker for → don't re-open.
      // Different input (SPA navigated to new step) → reset and re-open.
      if (_pickerDismissed && input === _pickerDismissedFor) return;
      _pickerDismissed = false;

      const onClose = () => { _pickerDismissed = true; _pickerDismissedFor = input; };

      if (await isSessionLocked()) {
        if (_lockDismissed && input === _lockDismissedFor) return;
        const onLockDismiss = () => { _lockDismissed = true; _lockDismissedFor = input; };
        showLockOverlay('OTPilot', () => {
          document.getElementById('otpilot-lock')?.remove();
          _lockDismissed = false;
          showAccountPickerOverlay(matching, onClose);
        }, onLockDismiss);
        return;
      }
      showAccountPickerOverlay(matching, onClose);
    }
  }

  function scheduleFill() {
    clearTimeout(_fillDebounce);
    _fillDebounce = setTimeout(() => {
      if (!chrome.runtime?.id) { fillObserver.disconnect(); return; }
      tryAutoFill();
    }, 300);
  }

  await new Promise(r => setTimeout(r, 400));
  await tryAutoFill();

  const fillObserver = new MutationObserver(scheduleFill);
  fillObserver.observe(document.body, { childList: true, subtree: true });
  // Disconnect after 5 minutes to avoid indefinite storage polling on high-churn SPAs.
  setTimeout(() => fillObserver.disconnect(), 300_000);
})();
