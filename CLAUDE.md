# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo structure

Three independent sub-projects:

- `extension/` — Chrome MV3 extension (vanilla JS). No build step; load unpacked directly.
- `api/` — Rust/Axum HTTP backend. Connects to PostgreSQL; runs SQLx migrations on startup.
- `web/` — React 19 + Vite + Tailwind 4 frontend. Talks to the API and Supabase Auth.

---

## Commands

### Extension
```bash
cd extension
npm test                        # Playwright E2E (requires display; CI uses xvfb)
npx playwright test --headed    # run with browser visible

make dev                        # switch config.js → config-dev.js
make prod                       # switch config.js → config-prod.js
make zip                        # build release zip (runs prod first, then reverts to dev)
make zip_dev                    # build dev zip
bash use-config.sh dev          # alternative to make dev
```
Load into Chrome: `chrome://extensions` → Developer mode → Load unpacked → select `extension/`.

**Config setup:** Copy `config.example.js` to `config-dev.js` and `config-prod.js`, fill in values. `config.js` is the active file (gitignored); swap it with `make dev` / `make prod`.

### API
```bash
cd api
cargo run              # dev server (reads api/.env)
cargo build --release
cargo test             # no tests yet
```
Requires `api/.env` with `DATABASE_URL`, `SUPABASE_URL`, `PORT`, and Stripe vars (see `api/.env.example`).

### Web
```bash
cd web
npm run dev            # Vite dev server on :5173
npm run build          # tsc type-check + vite build
npm run lint           # ESLint
```
Requires `web/.env.local` with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`.

### Docker (local postgres only)
```bash
docker compose up                     # starts postgres on :5442
docker compose --profile api up       # also starts the API container
```
Copy `.env.example` → `.env` at the repo root and fill in values before using the api profile.

---

## Architecture

### Auth flow
Supabase Auth handles all identity (Google OAuth + magic link). The API validates every request by fetching Supabase's JWKS at startup and verifying JWT signatures — no session storage in the API. The `AuthUser` extractor in `api/src/middleware/auth.rs` decodes the Bearer token and injects `{ id: Uuid, email }` into handlers.

### Data model
Migrations live in `api/migrations/` and run automatically at startup via `sqlx::migrate!`.

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `plan`, `stripe_customer_id`, `created_at`, `pending_deletion_at` | One row per Supabase user |
| `accounts` | `user_id`, `encrypted_blob`, `updated_at` | AES-GCM ciphertext only |
| `teams` | — | Stub, Phase 3 |
| `devices` | `user_id`, `device_id`, `name`, `os`, `browser`, `pending_action` | Registered extension installs |
| `sync_logs` | `user_id`, `device_id`, `action`, `accounts_count`, `created_at` | Trimmed automatically by trigger (keep last 100 per user) |

### Extension JS modules
- `totp.js` — TOTP code generation (loaded as content script alongside `content.js`)
- `content.js` — 2FA detection (QR + plain-text), auto-fill, overlay UI
- `background.js` — OAuth flow, background sync polling (every 5 min), image CORS proxy for QR scanning
- `popup.js` / `popup.html` — popup UI; manages accounts, TOTP display, session lock
- `cloudSync.js` — all sync logic; accounts encrypted AES-GCM client-side before upload
- `supabase.js` — Supabase Auth wrapper used by background and popup
- `links.js` — shared URL constants (dashboard, billing, etc.)
- `config.js` — active config (API_URL, SUPABASE_URL, etc.); swapped by `make dev/prod`

### Extension ↔ API sync
`cloudSync.js` owns all sync logic. Accounts are AES-GCM encrypted client-side using a locally-generated key; the API stores only the opaque blob. `POST /auth/sync-user` upserts the user row, registers the device, and returns plan + stats. The extension caches `userPlan` in `chrome.storage.local` to gate UI (e.g. hiding the Ko-fi footer for paid users).

Sync is gated by plan: `canSync(plan)` returns true for `personal`, `team_lite`, `team_pro` (not `free`).

Deleted accounts are tracked client-side as tombstones `{ [accountName]: ISO }` so they survive sync without re-appearing.

### API routes
| Method | Path | Description |
|---|---|---|
| POST | `/auth/sync-user` | Upsert user row, register device, return plan + stats |
| DELETE | `/users/me` | Soft-delete account (sets `pending_deletion_at`) |
| GET | `/accounts` | Return encrypted blob + `updated_at` |
| POST | `/accounts` | Upload encrypted blob |
| POST | `/billing/checkout` | Create Stripe Checkout session |
| POST | `/billing/webhook` | Stripe webhook — sets `plan` on payment |
| GET | `/devices` | List registered devices |
| GET | `/devices/:id/logs` | Sync log for a device |
| POST | `/devices/:id/disconnect` | Mark device for disconnect |
| POST | `/devices/:id/erase` | Mark device for remote wipe |
| POST | `/devices/:id/ack` | Device acknowledges pending action |
| POST | `/devices/:id/leave` | Device unregisters itself |
| GET | `/teams` | Stub — Phase 3 |

### Web dashboard
| Route | Component | Notes |
|---|---|---|
| `/` | `Landing.tsx` | Marketing page |
| `/auth/login` | `Login.tsx` | Google OAuth + magic link |
| `/auth/callback` | `Callback.tsx` | Supabase redirect handler |
| `/dashboard` | `Overview.tsx` | Plan info, sync stats; calls `POST /auth/sync-user` |
| `/dashboard/billing` | `Billing.tsx` | Stripe upgrade |
| `/dashboard/devices` | `Devices.tsx` | Device management (disconnect / erase) |
| `/dashboard/team` | `Team.tsx` | Stub — Phase 3 |
| `/dashboard/settings` | `Settings.tsx` | Account settings, deletion |
| `/privacy` | `Privacy.tsx` | |
| `/tos` | `Tos.tsx` | |
| `/gdpr` | `Gdpr.tsx` | |
| `/refunds` | `Refunds.tsx` | |

`apiFetch()` in `web/src/lib/api.ts` appends the Supabase JWT automatically to every request.

### Billing
`POST /billing/checkout` creates a Stripe Checkout session. Stripe calls `POST /billing/webhook` on payment; the webhook verifies the signature and sets `users.plan`. Plan values: `free`, `personal`, `team_lite`, `team_pro`.

### Plan label mapping
`Overview.tsx` maps plan strings to display names via a `PLAN_LABELS` record. Add new plan tiers there when they're introduced in the backend.

---

## Extension invariants

### OTP input exclusion list (`extension/content.js`)
`OTP_SELECTORS` excludes non-OTP fields via CSS `:not()` chains. The same exclusion list must be kept in sync with `NON_OTP_FRAGMENTS` inside `findOTPInput()`'s context-aware fallback — that array mirrors the selector exclusions in plain JS so the fallback doesn't re-include inputs the selectors explicitly block.

Current excluded fragments: `postal`, `zip`, `promo`, `coupon`, `discount`, `referral`, `verification`, `activation`, `invite`, `recovery`, `csrf`, `reset`, `access`, `confirm`, `auth`.

If you add a `:not([name*="foo"])` to OTP_SELECTORS, add `'foo'` to `NON_OTP_FRAGMENTS` too.

### `findPlainTextSecret` URL gate (`extension/content.js`)
Plain-text TOTP secret scanning only runs when the page URL path matches `PATH_RE` — a regex that requires 2FA-related keywords to appear as full URL segments (delimited by `/`, `-`, `_`, etc.), not as substrings. This prevents false positives on pages that merely discuss 2FA (blog posts, PR diffs, repos whose name contains "otp"). If you add new URL keywords to the gate, use the same word-boundary pattern, not a plain `includes()`.

### Extension context invalidation (`extension/content.js`)
Content scripts outlive extension reloads on long-lived tabs (Gmail, SPAs). All debounced MutationObserver callbacks check `chrome.runtime?.id` before calling any Chrome API — if falsy, they disconnect their observer and return. Any new observer or recurring timer that calls `chrome.storage` or `chrome.runtime` must include this guard.
