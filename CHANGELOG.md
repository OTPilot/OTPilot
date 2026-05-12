# Changelog


## v0.0.4
- **Fix: overlay re-appearing after dismiss** — Closing the "Save account?" overlay via X or "Not now" no longer causes it to reappear immediately. The dismissed secret is now remembered in memory for the duration of the page session.
- **QR detection in modals** — OTPilot now detects 2FA setup QR codes that appear inside dynamically-injected modal dialogs (e.g. ko-fi, and other SPAs that open a setup flow after page load). A MutationObserver watches for DOM changes and re-runs detection when new content is added.
- **Fallback QR image scan** — QR detection no longer relies on `alt`/`src` keywords (`qr`, `otp`, `mfa`, etc.). When the keyword-filtered pass finds nothing, OTPilot now scans all visible images ≥ 80 px as a fallback, catching QR codes served with generic filenames or alt text.
- **Image load awareness** — When a newly-injected image hasn't finished loading, OTPilot waits for its `load` event before scanning, preventing missed detections due to timing.
- **Auto-fill in modals** — Auto-fill now triggers when an OTP input is injected into a modal after page load, not only on initial page load.
- **Lock button icon** — Replaced the closed-padlock icon with a power button icon, which better conveys "end session" without the ambiguity of a locked/unlocked state.

## v0.0.3
- **Automatic 2FA setup detection** — OTPilot detects `otpauth://` URIs on 2FA setup pages and offers to save the account via a floating in-page overlay. Works with URI-based detection (anchor tags, DOM text) and QR code image decoding via the browser's native `BarcodeDetector` API. No manual secret entry required.
- **In-page overlays** — Account suggestion prompts and unlock prompts are now floating cards injected directly into the page, similar to password manager overlays.
- **Inline master password entry** — When locked on a configured auto-fill page, OTPilot shows a password field on the page. Enter your master password to unlock and fill in one step.
- **Session-aware suggestions** — If locked when a setup page is detected, the overlay combines unlock + add into a single "Unlock & Add" step.
- **Polished toast notifications** — Toast messages now slide in from the right with a colored left-border accent instead of a full colored background.
- **Accounts / Settings split** — Nav renamed to Accounts (account management) and Settings (backup & restore). Save navigates back to Home with confirmation.
- **Eye button** — Secret field toggle in account cards now uses SVG icons with eye/eye-off state.
- Popup UI polish and layout improvements
- Obfuscate toggle for OTP code display
- Ko-fi footer

## v0.0.2
- Fixed auto-fill on pages that load OTP fields dynamically
- Improved URL pattern matching to strip protocol and path correctly

## v0.0.1
- Initial release
- Auto-fill and auto-submit TOTP codes on configured URLs
- Multiple accounts with URL pattern matching (wildcard support)
- Master password lock with 24h / 30-day sessions
- Encrypted backup and restore (AES-GCM + PBKDF2)
