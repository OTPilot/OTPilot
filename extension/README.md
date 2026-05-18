# OTPilot Extension

Chrome extension (Manifest V3). Detects 2FA setup pages, saves TOTP secrets in one click, auto-fills codes on login, and optionally syncs encrypted accounts to the cloud.

## Features

- Auto-detect 2FA setup pages (reads `otpauth://` URIs and QR codes via `BarcodeDetector`)
- Auto-fill and submit OTP codes on matching login pages
- Master password lock (sessions: 24h or 30 days)
- Encrypted backup export/import (AES-GCM 256-bit, PBKDF2 key derivation)
- Cloud sync (Personal plan) — end-to-end encrypted, server never sees plaintext secrets
- Google OAuth sign-in via Supabase

## Loading locally

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder

## Configuration

Environment-specific values (API URL, Supabase credentials) live in a `config.js` file that is **not committed** to the repo. Use the provided script to switch between environments:

```bash
make dev    # uses config-dev.js  (localhost API)
make prod   # uses config-prod.js (Railway API)
```

**First-time setup:** copy `config.example.js` to `config-dev.js` and `config-prod.js` and fill in the values.

| Key | Dev | Prod |
|---|---|---|
| `API_URL` | `http://localhost:8080` | Railway backend URL |
| `DASHBOARD_URL` | `http://localhost:5175` | `https://otpilot.app` |
| `SUPABASE_URL` | your Supabase project URL | same |
| `SUPABASE_ANON_KEY` | your anon key | same |

> The dashboard frontend is at **https://otpilot.app** (Vercel). The backend API has no custom domain — use the Railway-provided URL directly in `config-prod.js`.

`make zip` switches to prod, builds the zip, and switches back to dev automatically.

## Files

```
extension/
├── manifest.json        MV3 manifest
├── popup.html           Extension popup UI + styles
├── popup.js             Popup logic (accounts, lock, sync UI)
├── background.js        Service worker (handles OAuth flow)
├── content.js           Auto-fill + setup detection (runs on every page)
├── totp.js              TOTP algorithm (RFC 6238) via Web Crypto API
├── supabase.js          Supabase Auth client (Google OAuth, session management)
├── cloudSync.js         Cloud sync (AES-GCM encryption, API calls)
├── config.example.js    Config template (commit this)
├── config-dev.js        Dev config — gitignored
├── config-prod.js       Prod config — gitignored
├── config.js            Active config (copy of dev or prod) — gitignored
└── use-config.sh        Script to switch active config
```

## Cloud sync

Cloud sync requires a **Personal** plan ($15 one-time). On first sign-in:

1. Sign in with Google via the Sync tab
2. A recovery key is generated — save it in a password manager
3. Your accounts are encrypted with that key before leaving the device
4. On a new device: sign in → paste the recovery key to restore access

The recovery key is never stored on the server. If lost, synced data cannot be decrypted.

## E2E tests

```bash
# From repo root
npm install
npx playwright install chromium   # first time only
npm test
```

## Building for the store

```bash
make zip
# Output: releases/otpilot-<version>.zip
```
