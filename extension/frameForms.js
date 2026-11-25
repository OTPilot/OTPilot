'use strict';

// Sign-in forms inside a same-site iframe: App Store Connect's sign-in is
// Apple's widget, idmsa.apple.com framed by appstoreconnect.apple.com. The
// other content scripts run in the top frame only; this probe runs in every
// frame and, in a sub-frame whose every ancestor is the same site that
// shows a sign-in field, asks the background to load forms.js there (with
// content.js and generator.js, its helpers). The background checks the
// frame against its tab's page itself (formSender in background.js), and
// what forms.js then fills must be covered for both hosts.
(() => {
  if (window.top === window || globalThis.__otpilotFrameProbe) return;
  globalThis.__otpilotFrameProbe = true;
  if (!/^https?:$/.test(location.protocol)) return;
  // The browser's list (the extension's isolated world: the page can't change it).
  const ancestors = [...(location.ancestorOrigins || [])];
  if (!ancestors.length) return;
  // A first cut, without the background: every ancestor ends like this
  // frame's host (its last two labels). The background checks the real site.
  const tail = h => h.split('.').slice(-2).join('.');
  const hostOf = o => { try { return new URL(o).hostname; } catch { return ''; } };
  if (!ancestors.every(o => tail(hostOf(o)) === tail(location.hostname))) return;

  // A password, or a first step's username (Apple's "Email or Phone Number").
  const SIGN_IN = ['input[type="password"]', 'input[autocomplete~="username"]', 'input[type="email"]',
    ...['user', 'login', 'email', 'account'].flatMap(w => [`input[name*="${w}" i]`, `input[id*="${w}" i]`].map(x => `${x}:not([type="hidden"])`))].join(', ');
  let asked = false;
  const ask = () => {
    if (asked || !document.querySelector(SIGN_IN)) return false;
    asked = true;
    if (chrome.runtime?.id) chrome.runtime.sendMessage({ action: 'vaultFrameForms', ancestors }).catch(() => {});
    return true;
  };
  if (ask()) return;
  // No sign-in form here: a sign-in typed in this frame's previous page may
  // be over (Apple's widget moves on to its next step): its offer shows on
  // the page. The background only passes it on when one is pending.
  if (chrome.runtime?.id) chrome.runtime.sendMessage({ action: 'vaultOfferInTop' }).catch(() => {});
  // A widget that renders its form after load: watched for two minutes.
  let timer;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!chrome.runtime?.id || ask()) observer.disconnect();
    }, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 120_000);
})();
