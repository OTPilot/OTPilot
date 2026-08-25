// Applied synchronously from a localStorage mirror so the popup never flashes
// the default theme before switching to the user's pick — chrome.storage.local
// (read later in popup.js) stays the source of truth; this is just a same-page
// cache for instant first paint. See THEMES / applyTheme() in popup.js.
//
// This must be an external file, not an inline <script> — MV3 extension pages
// enforce a CSP that blocks inline script execution outright (no 'unsafe-inline'
// escape hatch), so an inline version of this silently never runs.
try {
  var _t = localStorage.getItem('otpilotTheme');
  if (_t) document.body.dataset.theme = _t;
} catch (e) {}
