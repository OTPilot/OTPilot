'use strict';

// Email OTP reader — runs on webmail providers only.
// Scans inbox subject lines for one-time codes and reports them to the background SW.
// Nothing is stored beyond a 10-minute in-memory window in the background SW.

(function () {

const HOST = location.hostname;

const PROVIDER =
  HOST === 'mail.google.com'                                     ? 'gmail'    :
  HOST === 'outlook.live.com' || HOST === 'outlook.office.com'  ? 'outlook'  :
  HOST === 'mail.yahoo.com'                                      ? 'yahoo'    :
  HOST === 'mail.proton.me'                                      ? 'proton'   :
  HOST === 'app.fastmail.com'                                    ? 'fastmail' :
  HOST === 'mail.zoho.com'                                       ? 'zoho'     :
  // Test-only override: ?otpilot_test_provider=gmail
  new URLSearchParams(location.search).get('otpilot_test_provider') || null;

if (!PROVIDER) return; // no-op on every other page

// No language-specific subject filter — OTP emails arrive in any language.
// We rely on the 4-8 digit code pattern and the context (content.js only
// requests a code when an OTP input is present on the active page).
const CODE_RE = /\b(\d{4,8})\b/;

function getRows() {
  switch (PROVIDER) {
    case 'gmail':
      return Array.from(document.querySelectorAll('tr[jsmodel]')).slice(0, 5);
    case 'outlook':
      return Array.from(document.querySelectorAll('[role="option"][data-convid]')).slice(0, 5);
    case 'yahoo':
      return Array.from(document.querySelectorAll('[data-item-id]')).slice(0, 5);
    case 'proton':
      return Array.from(document.querySelectorAll('[data-element-id]')).slice(0, 5);
    case 'fastmail':
      return Array.from(document.querySelectorAll('[data-msg-id]')).slice(0, 5);
    case 'zoho':
      return Array.from(document.querySelectorAll('.maillist-item[data-id]')).slice(0, 5);
    default:
      return [];
  }
}

function getInboxRoot() {
  switch (PROVIDER) {
    case 'gmail':    return document.querySelector('[role="main"]');
    case 'outlook':  return document.querySelector('[role="list"]');
    case 'yahoo':    return document.querySelector('[data-test-id="virtual-list"]') ||
                            document.querySelector('[role="list"]');
    case 'proton':   return document.querySelector('[data-testid="message-list"]') ||
                            document.querySelector('[role="list"]');
    case 'fastmail': return document.querySelector('.u-scrollToAnchor') ||
                            document.querySelector('[role="list"]');
    case 'zoho':     return document.querySelector('#maillist') ||
                            document.querySelector('[role="list"]');
    default:         return document.body;
  }
}

function scanInboxForOtp() {
  for (const row of getRows()) {
    const text = row.innerText || '';
    const m = text.match(CODE_RE);
    if (m) return m[1];
  }
  return null;
}

function showDetectedToast(code) {
  const existing = document.getElementById('otpilot-email-detected');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'otpilot-email-detected';
  Object.assign(el.style, {
    position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '10px 14px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderLeft: '3px solid #38bdf8',
    borderRadius: '8px',
    boxShadow: '0 4px 20px rgba(0,0,0,.4)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px', color: '#e2e8f0',
    transition: 'opacity .3s ease',
  });
  el.innerHTML = `<span style="color:#38bdf8;font-weight:700">OTPilot</span> detected code <strong>${code}</strong>`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 4000);
  setTimeout(() => el.remove(), 4300);
}

// ── On-demand scan (requested by background when content.js needs a code) ──

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!chrome.runtime?.id) return;
  if (msg.action === 'scanEmailOtp') {
    const rows = getRows();
    console.debug(`[OTPilot] email-reader (${PROVIDER}): scanning ${rows.length} inbox rows`);
    const code = scanInboxForOtp() ?? null;
    if (code) {
      console.debug(`[OTPilot] email-reader (${PROVIDER}): found code`, code);
      showDetectedToast(code);
    } else {
      console.debug(`[OTPilot] email-reader (${PROVIDER}): no code found in inbox`);
    }
    reply({ code });
    return true;
  }
});

// ── Passive watcher: push new codes to background as they arrive ──

let _lastSentCode = null;

function maybeSendCode() {
  if (!chrome.runtime?.id) { observer.disconnect(); return; }
  const code = scanInboxForOtp();
  if (code && code !== _lastSentCode) {
    console.debug(`[OTPilot] email-reader (${PROVIDER}): passive scan detected new code`, code);
    _lastSentCode = code;
    showDetectedToast(code);
    chrome.runtime.sendMessage({ action: 'emailOtpDetected', code }).catch(() => {});
  }
}

const inboxRoot = getInboxRoot() ?? document.body;

const observer = new MutationObserver(() => {
  if (!chrome.runtime?.id) { observer.disconnect(); return; }
  maybeSendCode();
});

observer.observe(inboxRoot, { childList: true, subtree: true });

maybeSendCode();

})();
