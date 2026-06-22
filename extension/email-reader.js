'use strict';

// Email OTP reader — runs on webmail providers only.
// Scans the opened email body and inbox subject lines/snippets for one-time
// codes and reports them to the background SW.
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
  // Test-only override: ?otpilot_test_provider=gmail — gated to localhost so a
  // malicious page can't use it to activate the OTP watcher in production.
  ((HOST === 'localhost' || HOST === '127.0.0.1')
    ? new URLSearchParams(location.search).get('otpilot_test_provider')
    : null) || null;

if (!PROVIDER) return; // no-op on every other page

// No language-specific subject filter — OTP emails arrive in any language.
// We rely on the 4-8 digit code pattern and the context (content.js only
// requests a code when an OTP input is present on the active page).
//
// ⚠️ INVARIANT: the selectors + pickBestCode logic below are duplicated inside
// the scripting.executeScript fallback in background.js (used when the content
// script isn't pre-injected into a pre-existing tab). Keep both in sync.
const CODE_RE = /\b\d{4,8}\b/g;
const OTP_KEYWORDS = /(c[oó]digo|code|verificaci[oó]n|verification|passcode|one[- ]?time|2fa|otp|pin|security|seguridad|c[oó]d\.?|auth)/i;

// Picks the most likely OTP from a block of text.
// REQUIRES an OTP keyword within ~40 chars of the digits — if no candidate has
// one, returns null (never invents a code from a random number in the inbox).
// When expectedLength is given (the number of digits the login page asks for),
// only digit-runs of exactly that length are considered.
function pickBestCode(text, expectedLength) {
  if (!text) return null;
  const matches = [];
  for (const m of text.matchAll(CODE_RE)) matches.push({ code: m[0], idx: m.index });
  if (!matches.length) return null;

  let best = null, bestScore = -Infinity;
  for (let i = 0; i < matches.length; i++) {
    const { code, idx } = matches[i];
    // Length filter: the page tells us how many digits to expect.
    if (expectedLength && code.length !== expectedLength) continue;
    // Hard gate: a candidate is only valid with an OTP keyword nearby.
    const ctx = text.slice(Math.max(0, idx - 40), idx + code.length + 40);
    if (!OTP_KEYWORDS.test(ctx)) continue;

    let score = 100;
    // 6-digit codes are the most common OTP length (only matters when the
    // expected length is unknown).
    if (code.length === 6) score += 10;
    // A bare 4-digit year is rarely the code.
    if (code.length === 4 && /^(19|20)\d\d$/.test(code)) score -= 50;
    // Tie-break toward earlier matches.
    score -= i;
    if (score > bestScore) { bestScore = score; best = code; }
  }
  return best;
}

// Best-effort recency check for an inbox row: only reject when a machine-readable
// timestamp confidently parses to more than ~30 min ago. Anything unparseable is
// treated as recent (don't over-reject and miss a real code).
const MAX_AGE_MS = 30 * 60 * 1000;
function rowIsRecent(row) {
  const candidates = [];
  for (const t of row.querySelectorAll('time[datetime]')) candidates.push(t.getAttribute('datetime'));
  for (const el of row.querySelectorAll('[title], [aria-label]')) {
    candidates.push(el.getAttribute('title'), el.getAttribute('aria-label'));
  }
  let sawValidDate = false;
  for (const c of candidates) {
    if (!c) continue;
    const ms = Date.parse(c);
    if (Number.isNaN(ms)) continue;
    sawValidDate = true;
    if (Date.now() - ms <= MAX_AGE_MS) return true; // a recent timestamp wins
  }
  // If we only ever saw old valid dates, it's stale; otherwise assume recent.
  return !sawValidDate;
}

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

// Containers for the body of an *opened* email (reading pane). The OTP often
// lives in the body and is truncated from the inbox-row snippet, so we scan
// these with higher priority than the inbox rows.
// NOTE: real webmail DOMs change often; these selectors are best-effort and
// fall back gracefully (an empty list just means we scan inbox rows instead).
function getOpenEmailBodies() {
  let sel;
  switch (PROVIDER) {
    case 'gmail':    sel = '.a3s'; break;
    case 'outlook':  sel = '[role="document"], div[aria-label*="essage body"]'; break;
    case 'yahoo':    sel = '[data-test-id="message-view-body"], .msg-body'; break;
    // Proton renders the body inside a sandboxed iframe the content script can't
    // read (manifest has no all_frames); this only matches non-iframe markup.
    case 'proton':   sel = '.message-content'; break;
    case 'fastmail': sel = '.v-Message-body, [class*="MessageView"]'; break;
    case 'zoho':     sel = '.zmail-msg-content, .msgBodyDiv'; break;
    default:         return [];
  }
  return Array.from(document.querySelectorAll(sel)).slice(0, 5);
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

function scanForOtp(expectedLength) {
  // Opened email body first — the strongest signal and where codes most often
  // sit (and get truncated out of inbox snippets). The open body is the email
  // the user is looking at, so no recency check here.
  for (const body of getOpenEmailBodies()) {
    const code = pickBestCode(body.innerText || '', expectedLength);
    if (code) return code;
  }
  // Fall back to inbox-row subjects/snippets — skip clearly-old rows.
  for (const row of getRows()) {
    if (!rowIsRecent(row)) continue;
    const code = pickBestCode(row.innerText || '', expectedLength);
    if (code) return code;
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
    const bodies = getOpenEmailBodies(), rows = getRows();
    console.debug(`[OTPilot] email-reader (${PROVIDER}): scanning ${bodies.length} open bodies + ${rows.length} inbox rows (expectedLength=${msg.expectedLength ?? 'any'})`);
    const code = scanForOtp(msg.expectedLength) ?? null;
    if (code) {
      console.debug(`[OTPilot] email-reader (${PROVIDER}): found code`, code);
      showDetectedToast(code);
    } else {
      console.debug(`[OTPilot] email-reader (${PROVIDER}): no code found`);
    }
    reply({ code });
    return true;
  }
});

// ── Passive watcher: push new codes to background as they arrive ──

let _lastSentCode = null;

function maybeSendCode() {
  if (!chrome.runtime?.id) { observer.disconnect(); return; }
  const code = scanForOtp();
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
