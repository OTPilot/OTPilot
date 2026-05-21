# Changelog

## v1.1.0 (Unreleased — in development)

### Team sharing

- **Share TOTP codes with teammates** — account owners can share a TOTP code without exposing the underlying secret. The secret is encrypted with an independent sharing key; the backend generates the code on demand for authorized recipients. The raw secret is never transmitted.
- **Instant revocation** — the owner can revoke access at any time from the dashboard. Access is cut immediately on the next code request.
- **Email invitations** — invite teammates by email. If they already have an OTPilot account, the invite appears directly in their extension. If not, they receive an email with a link to install OTPilot; the pending invite is automatically linked to their account on signup.
- **Team dashboard** — manage team members, shared codes, and pending invitations from the web dashboard.
- **Team plan** — team sharing requires a Team subscription ($8–10/month or $70–80/year), which includes up to 5 seats. Additional seats at $2/user/month.

## v1.0.1 (Unreleased — in development)

### Extension

- **Plain-text TOTP secret detection** — OTPilot now detects raw base32 secrets displayed as text on 2FA setup pages (e.g. Twitter/X's "Can't scan the QR code?" flow). When no `otpauth://` URI or decodable QR is found, the content script scans text nodes for 16–64 character base32 strings in pages with 2FA context keywords and offers to save the account via the suggestion overlay.
- **QR detection CORS bypass** — QR image decoding now routes the image fetch through the background service worker when direct detection and same-origin fetch both fail, bypassing CORS restrictions on cross-origin QR images (e.g. Twitter, GitHub).
- **Canvas QR scanning** — Added a third pass to `tryDecodeQrImages` that scans `<canvas>` elements ≥ 80 px, covering sites that render the QR code to a canvas rather than an `<img>`.
- **Expanded OTP input selectors** — `findOTPInput` now matches `name*=token`, `name*=code` (excluding postal/zip/promo), `id*=token`, `id*=code`, `data-testid*=otp`, `data-testid*=token`, and Twitter's specific `data-testid="ocfEnterTextTextInput"`. Added a context-aware fallback: when the page heading contains code-entry text (e.g. "confirmation code"), the closest visible text/number/tel input in the relevant section is selected.
- **Dynamic auto-fill for SPAs** — The auto-fill observer now re-reads accounts from storage on every DOM mutation check instead of reading once at page load. This means accounts added mid-session via the suggestion overlay (e.g. saving Twitter while already on the settings page) trigger auto-fill immediately when the confirmation input appears, without a page reload. The 120-second observer timeout is also removed so auto-fill works throughout the full lifetime of the page.

## v1.0.0

### Smart sync

- **Merge-aware sync** — changes from two browsers that happened simultaneously are now merged instead of the slower one silently overwriting the faster one. If both devices edited the same account at the same time, both versions are preserved and one is marked `(conflict)` so you can decide later.
- **Deletion tracking** — deleting an account now propagates to all other devices correctly. Previously, the deleted account would reappear on the next sync from another browser.
- **Last-write-wins per account** — each account carries an `_updatedAt` timestamp. When two devices edited different accounts, both changes survive. When one edited an account sequentially after the other, the newest version wins cleanly.
- **Auto-sync on save** — any change (add, edit, delete) triggers a sync immediately after saving. Previously there was a 2-second delay that could cause changes to be lost if the popup was closed before the timer fired.
- **Background polling** — the extension polls the server every 5 minutes while the browser is open. If another device makes a change while the popup is closed, you see it as soon as you open it.
- **Full sync on popup open** — opening the popup now always runs a complete sync: pull if server is newer, push if local is newer, merge if both changed. Previously it could skip syncing when there were unsaved local changes.
- **Last synced time** — the sync panel now shows "Last synced 3m ago" instead of "Ready" when a prior sync exists.

### Device management

- **Device tracking** — each browser installation gets a stable device ID. Every sync records which device synced, the browser name, OS, and account count.
- **New device alert** — when a new browser syncs your vault for the first time, you receive an email notification.
- **Devices dashboard** — the web dashboard has a new Devices page listing all connected browsers, when they last synced, and their full sync history (up to 10 entries per device).
- **Disconnect** — send a disconnect command to any device from the dashboard. The next time that device syncs, it loses access to the sync key and stops syncing.
- **Remove** — like disconnect, but also wipes all local OTPilot data from that device (accounts, keys, settings) on next sync.
- **Self-disconnect on sign-out** — signing out of the extension now removes the device from the dashboard immediately, rather than leaving a stale "connected" entry until the server expires it.
- **Sync log auto-cleanup** — the database keeps only the last 10 sync log entries per device automatically via a PostgreSQL trigger.

### Account deletion

- **Delete account** — the Settings page now has a working "Delete account" flow. Clicking it expands a warning panel that lists exactly what is lost (all synced data, paid plan access), requires typing `DELETE` to confirm, then calls `DELETE /users/me` which removes all data from the database and deletes the Supabase auth user immediately.
- **No grace period** — deletion is permanent and instant. The warning explicitly states that lifetime plan access is lost with no refund.
- **Legal pages updated** — Privacy Policy and GDPR page now correctly state that data is deleted immediately upon account deletion, not "within 30 days".

### Other

- **Overflow counter** — the account bar overflow button now reads "2 more" instead of "+2", and shows a tooltip with the exact count.

- **Cloud sync** — accounts are encrypted end-to-end on the device and synced across all your browsers. A recovery key is generated on first use; the server never sees your secrets unencrypted.
- **Google sign-in** — sign in with Google directly from the extension popup to enable sync.
- **Personal plan** — one-time $15 upgrade via Stripe unlocks cloud sync. Plan status reflects immediately in the extension and dashboard after payment.
- **Web dashboard** — new `/dashboard` with plan overview, last sync time, and billing management.
- **Browser compatibility strip** — the landing page now detects your browser and shows the right install button. Firefox and Safari are shown as "coming soon" with a Chrome fallback.
- **CI/CD pipelines** — automated checks for the API (fmt, clippy, tests, Docker build) and web (type-check, build) on every pull request.

### E2E test suite

- **E2E test suite** — Playwright tests cover the popup UI (setup screen, OTP display, accounts view, search), content script setup detection (overlay appears/disappears correctly), and the autofill flow (OTP field filled and highlighted via extension message). Tests run automatically on every pull request via GitHub Actions (`xvfb-run` for headed Chrome on Linux).


## v0.0.5

- **Vault list redesign** — the Vault tab now renders accounts as a compact accordion list sorted alphabetically. Each row shows only the colored avatar, name, and email; clicking a row expands it to reveal the full edit form while collapsing any previously open row. A search bar at the top filters by name or email in real time, with a live account counter that updates as you type.
- **Scalable account switcher** — replaced the horizontal scrolling tab bar with a chip + overflow pattern. The first three accounts appear as compact chips (colored avatar circle + name); a `+N` button reveals the rest. The overflow panel includes a live search that filters all accounts by name or email, making navigation fast regardless of vault size.
- **Sticky footer** — the bottom nav and ko-fi footer are always anchored to the bottom of the popup; a minimum height prevents the popup from collapsing below the home view's natural size.
- **Selective export** — clicking Export now shows a picker with all vault accounts (all selected by default). Uncheck any you don't want included before entering the backup password.
- **Selective import with merge** — after decrypting a backup, a picker lists every account in the file. Accounts already in the vault are shown dimmed with an "already in vault" badge and cannot be selected; new accounts are pre-checked. Only the checked accounts are added, so existing vault entries are never overwritten or removed.

## v0.0.4
- **Email per account** — each account now stores an optional email address, editable in the account settings form. When a QR code is detected on a setup page with a label like `Acme:alice@acme.test`, the email is extracted and pre-filled automatically.
- **Email shown in multi-account picker** — the same-domain picker overlay now shows the email as secondary text under each account name, making it easy to tell apart accounts like `alice@acme.test` vs `bob@acme.test`.
- **Vault nav rename + account card identity** — the "Accounts" nav tab is now labelled "Vault". Account cards in the Vault view now show the account name and email (when set) as the card title instead of the generic "Account N" label.
- **Multi-account picker for same-domain pages** — When two or more accounts are configured for the same site (e.g. work and personal GitHub), OTPilot now shows a floating picker overlay listing all matching accounts instead of silently filling the first one. Each row has **Fill** (auto-fill the OTP into the page) and **Copy** (copy the code to clipboard) buttons. Single-account behavior is unchanged.
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
