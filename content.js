// Runs on every page; bails out immediately unless an account URL matches.

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
  el.textContent = text;
  Object.assign(el.style, {
    position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
    padding: '8px 14px', borderRadius: '6px',
    fontFamily: 'monospace', fontSize: '14px', fontWeight: '700',
    background: ok ? '#22c55e' : '#ef4444', color: '#fff',
    boxShadow: '0 2px 10px rgba(0,0,0,.4)', pointerEvents: 'none',
    transition: 'opacity .4s',
  });
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 2000);
  setTimeout(() => el.remove(), 2500);
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

// Message from popup "Fill Page" button
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'fill') {
    fillAndSubmit(msg.accountIndex, true).then(r => reply(r));
    return true;
  }
});

// Auto-fill on page load if a URL pattern matches this page
(async () => {
  await new Promise(r => setTimeout(r, 400));
  const acc = await getActiveAccount();
  if (!acc || !acc.secret) return;

  // Only auto-fill if the current URL matches AND the account has auto-fill enabled
  const patterns = (acc.urls || '').split('\n').map(s => s.trim()).filter(Boolean);
  const matched = patterns.some(p => matchesPattern(p, location.hostname.toLowerCase()));
  if (!matched) return;
  if (acc.autofill === false) return;

  const input = findOTPInput();
  if (input) fillAndSubmit(undefined, false);
})();
