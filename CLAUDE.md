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
| `sync_logs` | `user_id`, `device_id`, `action`, `accounts_count`, `created_at` | Trimmed automatically by trigger (keep last 10 per device) |
| `domain_icons` | `domain` (PK), `status`, `storage_key`, `fetched_at` | Shared favicon cache, one row per domain; `status='none'` is a negative cache. Bytes live in S3/R2 |

### Extension JS modules
- `totp.js` — TOTP code generation (loaded as content script alongside `content.js`)
- `content.js` — 2FA detection (QR + plain-text), auto-fill, overlay UI
- `background.js` — OAuth flow, background sync polling (every 5 min), image CORS proxy for QR scanning, site-icon resolution (`resolveIcons`) + local `iconCache`
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
| DELETE | `/users/me` | Hard-delete account (sets `pending_deletion_at` as a rollback guard, then deletes the Supabase auth user and the DB row in the same request) |
| GET | `/accounts` | Return encrypted blob + `updated_at` |
| PUT | `/accounts` | Upload encrypted blob |
| POST | `/billing/checkout` | Create Stripe Checkout session |
| POST | `/billing/webhook` | Stripe webhook — sets `plan` on payment |
| GET | `/devices` | List registered devices |
| GET | `/devices/:id/logs` | Sync log for a device |
| POST | `/devices/:id/disconnect` | Mark device for disconnect |
| POST | `/devices/:id/erase` | Mark device for remote wipe |
| POST | `/devices/:id/ack` | Device acknowledges pending action |
| POST | `/devices/:id/leave` | Device unregisters itself |
| POST | `/icons/resolve` | Resolve favicons for a batch of domains; fetches + stores any missing in S3/R2, returns `{domain: {status, url?}}` (**public** — so free / not-signed-in users get icons; abuse bounded by SSRF guards, 50-domain cap, negative cache, and a global fetch semaphore) |
| GET | `/teams` | Stub — Phase 3 |

### Domain favicons (`/icons`)
`api/src/routes/icons.rs` resolves a per-domain favicon, deduplicated into one shared object per domain. On a cache miss it fetches the icon **server-side** (hint URL validated same-domain → homepage `<link rel=icon>` → `/favicon.ico`, with SSRF guards rejecting private IPs); if the exact host has no icon it falls back to the **registrable parent domain** via the Public Suffix List (`psl` crate — e.g. `ap.www.namecheap.com` → `namecheap.com`), storing the result under the original host key. It re-encodes to a 64×64 PNG (the `image` crate) and uploads to a **public** S3/R2 bucket (`rust-s3`). The result is cached in `domain_icons` (`status='none'` is a negative cache, 30-day TTL). The feature is **optional**: if the `S3_*` env vars are unset, `IconStore::from_env()` returns `None` and `/icons/resolve` reports `none` for every domain. The endpoint is **public** (no auth) so icons work for free / not-signed-in users; the extension always calls it (Bearer attached only when present). The extension caches the downloaded PNG locally as a `data:` URL (`iconCache` in `chrome.storage.local`, **not** in the encrypted sync blob) and renders it via `avatarHTML()`/`avatarNode()` in `popup.js`, falling back to the letter avatar.

**Invariant:** `normalizeIconDomain()` is duplicated in three places — `api/src/routes/icons.rs` (`normalize_domain`), `extension/background.js`, and `extension/popup.js`. Keep them in sync (lowercase, strip `*.`/`www.`/path/port, require a dot).

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

### Email OTP scan logic (`extension/email-reader.js`)
`email-reader.js` scans the opened email body (`getOpenEmailBodies()`) first, then inbox rows (`getRows()`), and picks the code via `pickBestCode()` — which scores every 4-8 digit run by proximity to OTP keywords so distractor numbers (years, order refs) are skipped. The **same selectors + `pickBestCode` logic are duplicated inside the `chrome.scripting.executeScript` fallback in `background.js`** (used when the content script wasn't pre-injected into a pre-existing tab). The injected `func` must stay self-contained (no outer-scope refs) and in sync with `email-reader.js`. If you change a body/row selector or the scoring, update both places.

Note: Proton renders email bodies in a sandboxed iframe the content script can't read (manifest has no `all_frames`), so Proton body scanning is best-effort; it still works via the inbox subject/snippet.
