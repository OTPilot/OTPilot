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
cargo test             # unit tests (no DB needed)
DATABASE_URL=postgres://postgres:postgres@localhost:5442/postgres cargo test --features db-tests
                       # + DB-backed integration tests (each test creates its own database);
                       # CI runs these against a Postgres service container
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
The api profile reads `api/.env` (`env_file: ./api/.env` in `docker-compose.yml`) — copy `api/.env.example` → `api/.env` and fill in values before using it.

---

## Architecture

### Auth flow
Supabase Auth handles all identity (Google OAuth + magic link). The API validates every request by fetching Supabase's JWKS at startup and verifying JWT signatures — no session storage in the API. The `AuthUser` extractor in `api/src/middleware/auth.rs` decodes the Bearer token and injects `{ id: Uuid, email }` into handlers.

### Data model
Migrations live in `api/migrations/` and run automatically at startup via `sqlx::migrate!`.

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `plan`, `stripe_customer_id`, `created_at`, `pending_deletion_at`, `personal_subscription_id` | One row per Supabase user |
| `accounts` | `user_id`, `encrypted_blob`, `updated_at` | AES-GCM ciphertext only |
| `teams` | `id`, `name`, `owner_id`, `stripe_subscription_id`, `seat_limit` | Team Lite; 1 team per owner |
| `team_members` | `team_id`, `user_id`, `role` | `role` = owner/member |
| `pending_invites` | `email`, `team_id`, `token`, `expires_at`, `accepted_at` | 48h expiry; auto-accepted in `sync-user` by email |
| `shared_codes` | `owner_id`, `team_id`, `account_name`, `encrypted_secret`, `sharing_key_iv` | `encrypted_secret` = AES-GCM(secret, K) |
| `share_access` | `shared_code_id`, `user_id`, `server_share`, `encrypted_user_share` | 2-of-2: `server_share`=K2, `encrypted_user_share`=K1 wrapped to recipient pubkey |
| `audit_logs` | `team_id`, `actor_id`, `action`, `metadata` | Team activity (invite/share/revoke/totp_access…) |
| `users` (team cols) | `has_personal_cloud`, `public_key` | `has_personal_cloud` survives team downgrade; `public_key` = ECDH P-256 for share wrapping |
| `devices` | `user_id`, `device_id`, `name`, `os`, `browser`, `pending_action` | Registered extension installs |
| `sync_logs` | `user_id`, `device_id`, `action`, `accounts_count`, `created_at` | Trimmed automatically by trigger (keep last 10 per device) |
| `vault_items` | `id` (client uuid), `owner_id`, `collection_id`, `encrypted_item`, `counts_for_limit`, `revision`, `deleted_at` | 2.0 vault, one row per encrypted item; `revision` from a global sequence for incremental pull; deletes are tombstones (empty `encrypted_item`) |
| `collections` | `id` (client uuid), `team_id`, `encrypted_name`, `created_by` | 2.0 team collections ("share everything", E2E); name encrypted under the collection key |
| `collection_members` | `collection_id`, `user_id`, `role`, `wrapped_key` | `role` = manage/edit/view; `wrapped_key` = collection key wrapped to the member's ECDH public key |
| `shares` | `id` (client uuid), `team_id`, `owner_id`, `item_id`, `whole`, `encrypted_item`, `revision` | 2.0 sharing (docs/sharing.md): a copy of one of the owner's items (whole, or chosen fields) under a share key the server never sees; deleted with the item, on team departure / dissolution |
| `share_grants` | `share_id`, `user_id` or `collection_id`, `role` (`view`/`edit`, edit only for `whole`), `wrapped_key` | Who can open a share: a teammate (share key wrapped to their public key) or a collection (share key under the collection key); a collection member's role caps the grant |
| `domain_icons` | `domain` (PK), `status`, `storage_key`, `fetched_at` | Shared favicon cache, one row per domain; `status='none'` is a negative cache. Bytes live in S3/R2 |

### Extension JS modules
- `totp.js` — TOTP code generation (loaded as content script alongside `content.js`)
- `content.js` — 2FA detection (QR + plain-text), auto-fill, overlay UI. Only accounts holding a 2FA code are matched for code auto-fill (`hasTotpCode`: `secret` unlocked, `hasTotp` from the locked index). A code found on a page is offered first to a saved login of a related host (same / parent / subdomain) without a code (`vaultAttachCandidates`, `vaultAddAccount` with `attachTo`), "Save as new" otherwise. Never reads accounts from storage: asks the background (`vaultAccounts` → decrypted list when unlocked, the `vaultIndex` when locked; `vaultAddAccount`, `vaultUpdateAccount`)
- `forms.js` — sign-in forms (2.0), loaded after `content.js` + `generator.js` (reuses their helpers), top frame only. **Fill:** offers the logins whose URLs cover the page and fills the picked one's username + password (skips `autocomplete="new-password"`). **In-field UI:** an OTPilot badge (`.otpilot-field-badge`, `data-kind` login/generate) sits inside the sign-in fields when the site has logins and inside new-password fields; focusing an empty sign-in field or clicking a badge opens a dropdown under the field (`#otpilot-login-dropdown`: the logins or the unlock frame; the corner offer `#otpilot-login-fill` stays too). Badges and dropdowns are `position:fixed`, repositioned on scroll/resize, isolated from the page's outside-click handlers; the dropdown closes on Escape, typing in its field or a click elsewhere. **Save:** a submitted sign-in (submit / button click / Enter) is captured per tab in the background's `chrome.storage.session` (`pendingLogin:<tabId>`, 3 min, same site only) and the next page — or the same page once its form is gone — offers Save / Update / Never (`loginNeverSave`); never while a password field is still showing (a rejected password). **Two-step sign-ins** (username page, then password page): a submitted username-only step (one filled field that looks like a username/email — not a search box) is kept per tab (`pendingUsername:<tabId>`, 5 min, related host) and fills in the username of the next password capture, so the offer can update the login with that username or save a new one. `planPendingLogin` (background): update the login with that username; signing in with a username, one of the site's logins saved without a username (it gets the username); with no username captured, one of the site's logins (the offer's `candidates`, picked in the page); otherwise new. Every update offer also has "Save as new" (`choice: 'new'`). The password never goes back to the page. After a save the page's `<link rel=icon>` is sent as an icon hint. **Suggest:** focusing an empty new-password field opens a generated password under it (user's generator options, forced to password mode) and fills the confirmation field too
- `background.js` — OAuth flow, background sync polling (every 5 min), image CORS proxy for QR scanning, site-icon resolution (`resolveIcons`) + local `iconCache`, cross-tab auto-submit failure tracking (`recordAutoSubmitFailure`)
- `popup.js` / `popup.html` — popup UI; manages accounts, TOTP display, session lock
- `cloudSync.js` — all sync logic; accounts encrypted AES-GCM client-side before upload
- `supabase.js` — Supabase Auth wrapper used by background and popup
- `links.js` — shared URL constants (dashboard, billing, etc.)
- `config.js` — active config (API_URL, SUPABASE_URL, etc.); swapped by `make dev/prod`
- `keys.js` — team ECDH P-256 keypair for wrapping shared-code and collection keys. The private key is stored encrypted under the vault key (`teamPrivWrapped`, an item record re-wrapped with the vault by `VaultStore`'s `EXTRA_RECORDS`; a v1 plaintext `teamPrivJwk` is encrypted on first unlocked use), so private-key operations need the vault unlocked; the public key stays in clear (`teamPubB64`) and is uploaded via `sync-user`
- `importers.js` — import from other password managers' CSV exports (Chrome/Edge/Brave, Firefox, Bitwarden, 1Password, LastPass, Dashlane, KeePass): one header-alias mapper; `plan()` pairs each entry with the vault (`exists` / `merge` = adds the password to a login for that site + username that has none, typically a 2FA-only login / `new`); Settings → From a password manager. Secure notes become note items (`exists` when the same title + text is saved). `Importers.toCsv()` exports the whole vault (Settings → Backup & Restore, behind the master password; columns `type,name,url,username,password,totp,notes,folder,fields`): every item type round-trips through the importer: every tag in `folder` (`a;b`), the type's fields and custom fields as a JSON list in `fields` (`{ id, label, value, kind, custom }`; "Label: value" lines from earlier exports still import). The **encrypted backup** (Settings → Backup & Restore, `runExport` / `decryptBackup` in `popup.js`) is v2: the vault's items exactly as stored (every type and field, password history included) under a PBKDF2 password; import marks each item new / newer — will update / already in vault (`planBackupItems`), writes under the item-limit lock (`applyBackupItems`, Free limit checked); v1 files (1.x account lists) still import
- `sharing.js` — team shared-codes (consume): list codes shared with you, unwrap K1, fetch live TOTP
- `vaultShares.js` — 2.0 sharing (docs/sharing.md). **Owner:** `share(item, parts|null, grants)` creates a copy of the item (whole, or chosen `parts`: `f:<fieldId>`, `totp`, `urls`, `notes`; the title always, never tags / history / shares) under a fresh share key SK, granted to teammates (SK wrapped to their public key) or collections (SK under the collection key); the SK + parts live in the item itself (`item.shares`, E2E, synced, re-keyed with the vault) — `attach()` stores them, `planOtherItems` never overwrites them. `syncOwner(key)` (after every sync, popup and background) pulls editors' newer whole copies into the item, drops shares the server deleted, and republishes changed copies. **Grantee:** `refresh()` lists `/shares/with-me`, opens SKs (session `shareKeys`, cleared on lock), stores copies as `sr:<shareId>`; they show in the Vault as `_kind: 'shared'` entries with `share` (Shared · <owner>), editable with an `edit` grant (`saveCopy`), and autofill from them (`sharedLogins` in background.js). The item editor's **Share…** panel (`renderSharePanel`) replaces the old "Move" into a collection
- `generator.js` — password/PIN generator (pure): `crypto.getRandomValues` with rejection sampling (no modulo bias), at least one char from every enabled set, look-alikes (0 O o 1 l I |) skipped by default, `strength()` = entropy bits of the settings. The popup's Generate view keeps its options in `chrome.storage.local.generatorOptions` and the last 10 copied values in `chrome.storage.session.generatorHistory` (memory only)
- `vaultCrypto.js` — 2.0 vault crypto (pure, no storage): per-item AES-GCM with item id as AAD, IK wrap/re-wrap under VK (syncKey) or a collection key, master-password wrap of VK (PBKDF2-SHA256 600k)
- `vaultStore.js` — 2.0 local encrypted item storage: one `chrome.storage.local` key per record (`vi:<id>`) and per tombstone (`vt:<id>`) so concurrent writers never clobber each other; `readAll` reports undecryptable records instead of failing
- `vaultKeys.js` — 2.0 vault key (VK) lifecycle: plaintext `vaultKey` without a master password, `vaultKeyWrapped` + `chrome.storage.session` `vaultKeyUnlocked` with one; stored apart from `syncKey` (whose presence means "sync is set up") but adopts it when present
- `vaultLock.js` — 2.0 master-password lock (mandatory): `state()` setup/locked/unlocked, `setup`, `unlock` (migrates a v1 `auth` sentinel on first unlock, converting a plaintext `syncKey` first), `changePassword`, inactivity auto-lock (`autoLockMinutes`: 15/60/240/480, 0 = only on browser close; deadline `vaultLockAt` in `chrome.storage.session`). Recovery: `recover(recoveryKey, newPassword)` (the recovery key is the vault key, checked locally against `vaultKeyCheck` — a fixed value encrypted with VK, written whenever the key is wrapped — or a vault item, or a v1 plaintext key; refused if nothing can confirm it), `resetDevice()` (wipes local + session), `revealRecoveryKey(password)`, and a one-time "save your recovery key" screen until `recoveryKeyAcknowledged`. Loaded by the popup and the background; content scripts ask the background (`vaultState` / `vaultUnlock` / `vaultTouch` messages) because they can't read `chrome.storage.session`
- `unlock.html` / `unlock.js` — in-page master-password prompt, framed by `content.js` (`mountUnlockFrame`). Extension origin, so the host page can't read what's typed; it unlocks through the background and only posts `{source:'otpilot-unlock', result}` to the page — only after the user unlocked in it. `content.js` accepts it only from the frame's window **and** the extension's origin (the page owns the `<iframe>` and can navigate it to its own content), then re-checks the real lock state before acting. Web-accessible with `use_dynamic_url`
- `theme.css` — the theme token blocks (one per theme), shared by every extension page (`popup.html`, `unlock.html`)
- `vaultMigration.js` — 2.0 one-time v1 `accounts` → encrypted vault items; runs on the first unlock (`VaultLock`) and before the first vault read (`VaultAccounts.load`). Writes an encrypted v1 backup first, runs under a Web Lock, writes `vaultMeta` last and only then removes the plaintext `accounts`, so a died run retries without duplicates. v1 `tombstones` (names only) stay while the v1 sync blob is in use
- `vaultSync.js` — 2.0 per-item sync with `/vault/items`: pull (paged from `vaultSyncState.cursor`, applied under the vault lock via `VaultStore.transaction`) then push (PUT with `base_revision`, new items in batches ≤500 / ≤6 MiB, DELETE for local tombstones; sync state saved after every server write). Records travel as-is (same vault key everywhere); local changes are detected by a fingerprint of the record's IVs. Conflicts: newer `updatedAt` wins; edited here + deleted there keeps the edit; a local deletion is kept unless the server copy changed after it; undecryptable remote records are skipped; a login migrated independently on two devices (same secret + title + username, different ids) is paired into one item under the server's id. `wipeServer()` deletes every server item ("Start fresh"). Sync progress is cleared by `CloudSync` itself when sync is turned off or a key adopted (works in the background worker too). Every write a sync makes (records, sync state) first checks under the vault lock that the key it started with is still the vault key, so a reply arriving after a reset, lock or re-key writes nothing. The background worker also runs it (`queueVaultSync`): after a page saves/changes a login, and on the poll alarm
- **v1 blob during the transition:** `doSync()` runs `VaultSync` first. The blob is only *merged* when it was written by a 1.x device (2.0 devices write `writer: 'v2'` inside the encrypted payload and their blobs are ignored); then the vault syncs again. `exportV1Blob()` writes the vault's v1 view (with `writer: 'v2'`, and v1 tombstones for accounts removed since the last export, tracked in `v1Export`) whenever it differs from the last export. Only logins with a 2FA secret are exported (`v1Exportable`); password-only logins also stay out of the merge with a 1.x blob, so a 1.x tombstone can't delete them by name
- `vaultAccounts.js` — bridge between the v1 account list the current UI uses and vault items. A v1 account also carries `notes` and `customFields` (the item's `fields` marked `custom: true`: `{ id, label, value, kind, section? }`, any field kind — kept as is unless the user switches it text ⇄ password —, after the type's template fields; `customFieldsOf` / `withCustomFields`), applied only when the caller sends them — a page or a 1.x device's account keeps them; they're stripped from the list content scripts get. `load`/`save` (only re-encrypts changed items, keeps item fields the v1 UI doesn't know, deletes only ids the caller loaded), `add`/`update` (used by the background for content scripts). `save`/`add`/`update` read, check and write under one `VaultStore.transaction`, verifying the passed key is still the vault key. Writes `vaultIndex`, a **plaintext** index of each login's name, URL patterns, autofill flag and `hasPassword` / `hasTotp` booleans (no secrets/usernames; an index missing either flag is rebuilt on unlock) so a page can show "Unlock to auto-fill <name>" only where an account matches while the vault is locked — a deliberate product trade-off: it reveals which sites have accounts to anyone who can read the browser profile


### Vault view (popup, 2.0)
The Vault view lists every item type. Its `draft` holds logins as v1 accounts (`VaultAccounts`) and every other item as an **entry** wrapping it (`{ _kind: 'item', _id, type, name, category, moreTags, email: summary, item }` — `entryOf` / `itemOfEntry` in `popup.js`); non-login items live in `otherItems` (`VaultAccounts.loadOthers`). Save splits the merged draft: logins through `VaultAccounts.save`, the rest through `planOtherItems()` (`put` = changed or new, `remove` = deleted here) straight to `VaultStore`, and the Free-limit check covers both (`exceedsFreeLimit(…, others)`). `mergeDraftWithCurrent()` works on both kinds, so an item a sync changed while the editor was open keeps the synced version unless edited here. "+ Add" opens a type picker: "2FA code" first (a login opened in a compact, 2FA-first form — `_compact` draft flag, never persisted: secret first with `otpauth://` paste parsing via `parseOtpauth`, the password behind "+ Add password"; saved it's a regular login), then `Vault.TYPES`, plus `UPCOMING_TYPES` disabled as "Soon"; non-login items get a template-driven editor (`renderItemDetail`: secret kinds masked with show/copy, password kinds can be generated). Tags: the category is the first tag and "More tags" the rest, for every type (`moreTags` on v1 accounts, kept as-is when a caller doesn't send it); the category bar and filters match **any** tag (`tagsOf`). A type filter (`#vault-type-bar`) appears once the vault holds more than one type. **Custom fields** (every editor, `customFieldsHTML` / `readCustomFields`) are compact label | value rows grouped in sections: the default "Custom fields" one first, then named ones (a field's `section`, so renaming a section renames it on its fields and a section with no filled field isn't saved); each section adds a row by kind (Text / Hidden / Email / Date / Multi-line chips; `.cf-add` is the Text one) and "+ New section" adds one. **Related items** (`relatedHTML` / `mountRelated`): an item links others by id (`links` — on a login's v1 account, applied by `applyAccount` only when sent, stripped for content scripts; on `entry.item` for other types; never in a share copy or the CSV); an item's "Related" list is what it links **plus what links it**, personal saved items only (a new login has no id until saved). "+ Link item" searches the vault, "+ New note linked here" creates a note that links back, ✕ unlinks both sides (both items stay); a merge joins both logins' links and repoints items that linked the other login.

### Home account details (popup)
Under the code, Home shows the selected login like the editor groups it (`renderHomeCreds`): **Sign-in** (username, password, website), each custom-field **section** (the default one as "More fields"), **Notes**, and **Related** (`homeRelated`: links + backlinks over `accounts` + `otherItems`). Rows are label | value with Show (secret kinds) and Copy. A related login is selected on Home; any other related item expands in place with its filled fields and notes ("Open in vault" → `showView('accounts', { openItemId })`). Without a 2FA code `#home-detail.no-code` hides the code block and Copy / Fill. Re-rendered only when what it shows changes (`_homeCredsKey`), never on the timer tick.

### Team collections in the popup (2.0)
Managed from the **Team** tab (`renderTeamCollections`); an open collection lists its **items** (`collectionItemsSection`): my items shared into it (with "Remove from collection", which removes that grant), teammates' items shared into it (with their owner) and items stored in the collection itself (the older model) — a manager can convert those (`convertCollectionItems` → `POST /collections/:cid/items/:id/convert`, one server transaction per item: the manager's new personal item — carrying its share key —, its whole copy, the collection's edit grant, and the source deleted, only if the source is still at the revision read; 409 is retried once with the teammate's version, 404 means already converted). Any member creates one; managers add teammates (only ones with a public key, i.e. who signed in to 2.0) with a role, change roles, remove (then a note lists the passwords/secrets the removed person could see, suggesting to change them), rename or delete; anyone can leave. Their items are pulled when the popup opens (`refreshSharedItems`, team plans only) and listed in the Vault view as `_kind: 'shared'` entries with a "Shared · <collection>" tag. A shared entry is edited in the item editor (logins there also get URLs + 2FA) and saved **straight to its collection** ("Save to <collection>", 409 → the teammate's version is shown); viewers get a read-only editor. The personal Save never touches shared entries (`isLoginEntry` / `isItemEntry` select what it writes). A saved personal login can be **merged** with another (`openMergePanel` → `mergeConflicts` / `mergeLogins` in `popup.js`): conflicting fields (name, username, password, 2FA secret, notes — "keep both" —, auto-fill) are picked per field, URLs / tags / custom fields joined, the discarded password goes to the history (`extraPasswordHistory`, applied by `applyAccount`); the other login leaves the draft and is deleted on Save. Sharing an item into a collection no longer moves it: see `vaultShares.js` (Share… in the item editor).

### Teams / shared codes (2-of-2)
Team Lite lets a member share an individual TOTP code. The secret is encrypted client-side with key `K`; per recipient the server stores `K2 = K XOR K1` (`share_access.server_share`) and an opaque `K1` wrapped to the recipient's ECDH public key (`encrypted_user_share`). To produce a live code the recipient sends `K1`; the server reconstructs `K`, decrypts, generates the TOTP (`totp-rs`, `new_unchecked` to allow <128-bit secrets), and discards `K`. **Trust model:** the split protects against an **at-rest DB compromise** (a dump has the ciphertext + `K2` + `K1`-wrapped-to-pubkey, but not the recipient's private key, which lives only in the E2E sync vault → `K1`/`K` unrecoverable from the DB alone). It does **not** protect against a malicious/compromised server at runtime — the server sees the plaintext secret on every `generate_totp` and distributes recipients' public keys with no out-of-band fingerprint, so the runtime server is a trusted party by design (unlike personal sync, which is fully E2E). Revoking a recipient deletes their `share_access` row (orphans their `K1`). Reads of a shared code are audited: explicit actions (`copy`/`autofill`/`refresh`) → `totp_access`; passive display/auto-refresh → `totp_view`, throttled to one entry per 10 min per (viewer, code). **Collections (2.0, "share everything")** are separate from this code-only mode: items in a collection are fully E2E (encrypted under a collection key the server never sees, wrapped per member to their ECDH public key), so members get the whole item. Leaving or being removed from the team deletes the user's collection memberships in the same transaction as the removal (`remove_member_atomic`) — they lose the shared items only, never their own vault; a collection left with no members is deleted, one left without a manager promotes its oldest member. **Share creation** needs the plaintext secret, which is E2E — so it happens where the vault is decrypted: the **extension** (has the synced vault) or the **web dashboard** after the user pastes their recovery key (`web/src/lib/teamCrypto.ts` mirrors the extension crypto). The 2-of-2 logic for TOTP secrets is distinct from the **email-OTP** plan and from personal sync, which stays fully E2E. New env: `STRIPE_TEAM_LITE_*_PRICE_ID`, `STRIPE_EXTRA_SEAT_PRICE_ID`, `APP_BASE_URL`.

### In-page UI theme
Overlays, toasts and banners injected by content scripts follow Settings → Appearance. `theme.css` stays the single definition of every theme: the background (`themeVars` message) parses the active block's custom properties and `themeUi(el)` in `content.js` sets them on each OTPilot root element (`data-otpilot-ui`), re-applying on a `theme` change. Inline colors in content scripts are written as `var(--token, <default theme value>)` — never a bare hex — so the default theme renders before the tokens arrive. SVG colors go in `style` (presentation attributes don't take `var()`).

### Free plan limit (2.0)
`Vault.FREE_ITEM_LIMIT` (50) counts every item except logins that hold only a 2FA secret (+ username) — `Vault.countsForLimit`. It is enforced where the **user** adds data: the popup editor's Save (`VaultAccounts.exceedsFreeLimit`, a dry run of `save()` checked before anything changes) and the page "Save login" offer (`background.js` `planPendingLogin`, `Vault.canSaveItem`); every user-initiated add takes the shared `otpilot-item-limit` Web Lock around its count + write, so two can't both take the last slot. Over the limit (e.g. after leaving a team) existing items stay editable; only growing the count is refused. Sync merges never check it — what another device saved is never dropped.

### Extension ↔ API sync
`cloudSync.js` owns all sync logic. Accounts are AES-GCM encrypted client-side using a locally-generated key; the API stores only the opaque blob. `POST /auth/sync-user` upserts the user row, registers the device, and returns plan + stats. The extension caches `userPlan` in `chrome.storage.local` to gate UI (e.g. hiding the Ko-fi footer for paid users).

Sync is gated by plan: `canSync(plan)` returns true for `personal`, `team_lite`, `team_pro` (not `free`).

**Sync key = vault key (2.0).** The recovery key is the vault key managed by `vaultKeys.js` (plaintext `vaultKey`, or `vaultKeyWrapped` under a master password). "Sync is set up" is the explicit `syncEnabled` flag — not the presence of a key, since the key also encrypts the local vault and stays when sync is turned off (`deleteSyncKey()` only clears the flag). A v1 plaintext `syncKey` is converted once by `CloudSync.convertLegacyKey()` (adopted as the vault key, flag set, legacy copy removed); `background.js` treats either `syncEnabled` or a not-yet-converted `syncKey` as enabled. Restoring a recovery key validates it against the server first (`CloudSync.pull(key)`), then `VaultKeys.adoptKey()` re-wraps local items to it in the same storage write that stores the key.

Deleted accounts are tracked client-side as tombstones `{ [accountName]: ISO }` so they survive sync without re-appearing.

### API routes
| Method | Path | Description |
|---|---|---|
| POST | `/auth/sync-user` | Upsert user row, register device, return plan + stats |
| DELETE | `/users/me` | Hard-delete account, in order: set `users.deletion_started_at` (from then on checkouts and team creation are refused, and a checkout completion that still arrives cancels its subscription instead of granting), cancel every subscription the user pays for now in Stripe (Personal + the team's they own; each recorded as cancelled once Stripe confirms, so a failure stops with a 503 naming what was already cancelled and a retry continues; no `STRIPE_SECRET_KEY` with a subscription to cancel is a failure, never a silent success), dissolve the team they own, leave the team they're in, then set `pending_deletion_at` (rollback guard) and delete the Supabase auth user and the DB row. Cascades (migration 0019) take invites they sent, codes they shared and shares to them; `teams.owner_id` has no ON DELETE on purpose (teams are dissolved explicitly first) |
| GET | `/users/me/deletion` | What deleting would do (subscriptions cancelled, owned team + member count, team left), for the dashboard's confirmation |
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
| GET | `/vault/items?since=N` | 2.0 vault: items (incl. tombstones) with `revision > N`, 1000 per page + `more` |
| PUT | `/vault/items/:id` | Create, or update with `base_revision`; `409` + current item when the server moved on |
| DELETE | `/vault/items/:id?base_revision=N` | Soft delete (tombstone, new revision) |
| POST | `/vault/items/batch` | Create up to 500 new items (migration, imports); existing ids come back in `conflicts`, never overwritten |
| POST | `/teams/:id/collections` | Create a collection (any team member; caller becomes `manage`, sends its own wrapped key) |
| GET | `/collections` | Collections I'm in: role, wrapped key, encrypted name, member count |
| PATCH/DELETE | `/collections/:cid` | Rename / delete with its items (`manage`) |
| GET | `/collections/:cid/members` | Members + roles (any member) |
| PUT/DELETE | `/collections/:cid/members/:uid` | Add (team member + wrapped key) or change role / remove (`manage`; anyone can leave). Always keeps a manager; the last member leaving deletes it |
| GET | `/collections/:cid/items?since=N` | Pull a collection's items (any member), same paging/revisions as `/vault/items` |
| POST | `/collections/:cid/items/:id/convert` | A manager turns an item stored in the collection into their own item shared back to it (whole, edit), atomically, if the source is still at `base_revision` (409 + current otherwise; 404 once converted) |
| PUT/DELETE | `/collections/:cid/items/:id` | Write / delete with `base_revision` (`edit`/`manage`). Personal `/vault/items` never lists or touches collection items, and vice versa |
| POST | `/shares` | Share one of my items: `{ id, item_id, whole, record, grants: [{ user_id \| collection_id, role, wrapped_key }] }` (teammates / my team's collections I can edit) |
| PUT/DELETE | `/shares/:id` | Rewrite the copy (owner, or an `edit` grantee of a whole share; `base_revision`, 409 + current) / delete it (owner) |
| PUT/DELETE | `/shares/:id/grants` | Add or change a grant (owner) / remove one (owner, or a grantee leaving their direct grant); the share goes with its last grant |
| GET | `/shares/mine`, `/shares/with-me` | My shares with their grants / every share I can open (direct or via a collection), whole list each time with revisions, my effective role and the wrapped key(s) |
| POST | `/icons/resolve` | Resolve favicons for a batch of domains; fetches + stores any missing in S3/R2, returns `{domain: {status, url?}}` (**public** — so free / not-signed-in users get icons; abuse bounded by SSRF guards, 50-domain cap, negative cache, and a global fetch semaphore) |
| POST/GET | `/teams` | Create (idempotent, team plan) / get the user's team |
| GET/PATCH/DELETE | `/teams/:id` | Detail (members + seats) / rename / delete (downgrades all) |
| POST | `/teams/:id/invite` | Invite by email (seat check + Resend email) |
| POST | `/teams/accept/:token` | Accept an invite (also auto-accepted in `sync-user`) |
| DELETE | `/teams/:id/leave`, `/teams/:id/members/:uid` | Leave / remove (downgrade) |
| GET | `/teams/:id/audit` | Team activity log (owner) |
| POST/GET | `/teams/:id/codes` | Share a code (2-of-2 payload) / list codes shared with me |
| GET | `/teams/:id/codes/mine` | List codes I share |
| DELETE | `/teams/:id/codes/:cid`, `…/access/:uid` | Revoke a code / one recipient's access |
| POST | `/teams/:id/codes/:cid/totp` | Live TOTP — client sends K1, server reconstructs K=K1⊕K2, decrypts, generates |
| POST | `/billing/checkout/team`, `/billing/extra-seat` | Team Lite subscription / add a seat |

### Domain favicons (`/icons`)
`api/src/routes/icons.rs` resolves a per-domain favicon, deduplicated into one shared object per domain. On a cache miss it fetches the icon **server-side** (hint URL validated same-domain → homepage `<link rel=icon>` → `/favicon.ico`, with SSRF guards rejecting private IPs); if the exact host has no icon it falls back to the **registrable parent domain** via the Public Suffix List (`psl` crate — e.g. `ap.www.namecheap.com` → `namecheap.com`), storing the result under the original host key. It re-encodes to a 64×64 PNG (the `image` crate) and uploads to a **public** S3/R2 bucket (`rust-s3`). The result is cached in `domain_icons` (`status='none'` is a negative cache, 30-day TTL). The feature is **optional**: if the `S3_*` env vars are unset, `IconStore::from_env()` returns `None` and `/icons/resolve` reports `none` for every domain. The endpoint is **public** (no auth) so icons work for free / not-signed-in users; the extension always calls it (Bearer attached only when present). The extension caches the downloaded PNG locally as a `data:` URL (`iconCache` in `chrome.storage.local`, **not** in the encrypted sync blob) and renders it via `avatarHTML()`/`avatarNode()` in `popup.js`, falling back to the letter avatar.

**Invariant:** `normalizeIconDomain()` is duplicated in three places — `api/src/routes/icons.rs` (`normalize_domain`), `extension/background.js`, and `extension/popup.js`. Keep them in sync (lowercase, strip `*.`/`www.`/path/port, require a dot).

**Invariant (passwords):** password fill uses `Vault.loginCoversHost()` (`vault.js`), deliberately **stricter** than `matchesPattern()`: the page must be the saved host or a subdomain of it (a leading `www.` on the saved host is ignored; `*.base` is a wildcard) — never a parent or sibling. The background (`vaultLoginsForPage` / `vaultFillLogin`) takes the host from `sender.url` of a tab's **top frame** (never from the message), lists logins without passwords, and releases one password only for the id the user clicked after re-checking that match. Nothing is filled without a click. Logins in team collections unlocked this session (`collectionKeys` in session storage, records `cr:<cid>:<id>`) are offered and filled the same way (`sharedLogins()`); a sign-in matching one never gets a personal "Save" offer. The plaintext `vaultIndex` carries a `hasPassword` boolean so a locked vault can offer "Unlock & fill" only where a login can fill.

**Invariant:** `matchesPattern()` (account URL ↔ page hostname matching) is duplicated in `extension/content.js` (drives auto-fill) and `extension/popup.js` (highlights the active account on popup open). Keep them in sync. A bare pattern matches its subdomains **in both directions** at a dot boundary (so `namecheap.com` ⇄ `ap.www.namecheap.com` match); `*.base` is an explicit wildcard. Auto-fill stays gated by `findOTPInput()`, so the looser match can't fire on pages without an OTP field.

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
`POST /billing/checkout` (body `{annual}`) creates a Stripe Checkout **subscription** for Personal ($3/mo or $30/yr, `STRIPE_PERSONAL_MONTHLY_PRICE_ID` / `STRIPE_PERSONAL_ANNUAL_PRICE_ID`; optional — checkout answers 503 until set). Both checkouts tag the session and subscription with `metadata.plan` (`personal` / `team_lite`) so the webhook can tell them apart. Stripe calls `POST /billing/webhook`; the webhook verifies the signature and sets `users.plan`. Plan values: `free`, `personal`, `team_lite`, `team_pro`.

`users.has_personal_cloud` means "entitled to Personal": it's what a team downgrade falls back to (`CASE WHEN has_personal_cloud THEN 'personal' ELSE 'free'`). A Personal subscription sets it plus `personal_subscription_id`; `customer.subscription.deleted` for that id clears both and moves `personal` → `free` (a team plan stays). Buying Personal while on a team keeps the team plan effective. 1.x one-time buyers keep the flag without an id (grandfathered); a one-time session still completing after the 2.0 deploy is handled by the `mode=payment` branch. Webhooks can arrive out of order: every `subscription.deleted` id is recorded in `stripe_ended_subscriptions`, and a checkout completion for one of them grants nothing. One Personal subscription per user: a second completion keeps the stored one and cancels the new subscription in Stripe. Both checkouts reuse the user's `stripe_customer_id` (so the billing portal shows every subscription); `sync-user` returns `personal_subscription` so team members can still manage their own.

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
`email-reader.js` scans the opened email body (`getOpenEmailBodies()`) first, then inbox rows (`getRows()`), and picks the code via `pickBestCode(text, expectedLength)`. `pickBestCode` **requires an OTP keyword within ~40 chars of the digits** — if no candidate has one it returns `null` (it never invents a code from a random inbox number). When `expectedLength` is given (the digit count the login page asks for, computed by `getExpectedOtpLength()` in `content.js` from split-input boxes / `maxlength` / `pattern`), only runs of that exact length are considered. Inbox rows are also filtered by `rowIsRecent()` (best-effort: only skipped when a machine-readable timestamp confidently parses to >30 min ago). The flow threads `expectedLength` from `content.js` (`getEmailOtp` message) → `background.js` (`getEmailOtp`, which also length-validates the 10-min `_emailOtp` cache) → `scanEmailOtp`. The **same `pickBestCode` + `rowIsRecent` + selectors are duplicated inside the `chrome.scripting.executeScript` fallback in `background.js`** (used when the content script wasn't pre-injected into a pre-existing tab). The injected `func` must stay self-contained (no outer-scope refs), take `expectedLength` as an arg, and stay in sync with `email-reader.js`. If you change a selector or the scoring/gate, update both places.

Note: Proton renders email bodies in a sandboxed iframe the content script can't read (manifest has no `all_frames`), so Proton body scanning is best-effort; it still works via the inbox subject/snippet.

### Auto-submit self-healing (`extension/content.js`, `extension/background.js`)
After filling the OTP field, `fillAndSubmit`/`fillAndSubmitWithAccount` normally auto-click the form's submit button ~600ms later. Sites running bot/automation detection across their auth flow (confirmed on Rippling, which runs Cloudflare) treat that synthetic click's `isTrusted: false` as suspicious and silently reject the request — the field shows the right code, but the POST fails as if the code were wrong, while the exact same value submitted via a real user click/Enter succeeds. There's no way to fake a trusted event from a content script (that would require `chrome.debugger`/CDP, a much bigger permission ask), so instead of a hardcoded site list this is detected automatically at runtime: `watchAutoSubmit()` (`content.js`) checks ~5s after the auto-click whether it looks like it worked (page navigated, or `findOTPInput()` no longer finds an OTP field anywhere on the page).

A single apparent failure isn't enough to flag the host — a slow-but-successful flow (delayed redirect, async validation) can look identical to a rejected click for one check — so it goes through `recordAutoSubmitFailure()` (`background.js`), which requires two strikes (necessarily from separate page loads, since `_lastAutoSubmitAt` throttles to one attempt per minute) before setting `noAutoSubmit:<hostname>` in `chrome.storage.local` and skipping future auto-clicks there. This increment-and-maybe-flag step is deliberately done in the background service worker rather than in content.js directly: content scripts run one instance per tab, so two tabs on the same hostname recording a failure around the same time would otherwise race a `chrome.storage` read-modify-write on the shared strike count and silently lose one. The background worker is a single shared JS context for every tab, and `withHostnameLock()` chains calls per hostname through a promise so they serialize instead of interleaving. Each host's flag/strike count lives under its own storage key (`noAutoSubmit:<hostname>` / `noAutoSubmitStrikes:<hostname>`, matched by literal format between the two files) rather than one shared object, so unrelated hosts can't clobber each other either. No maintainer action needed per affected site.

`watchAutoSubmit`'s "did it work" check deliberately re-scans for an OTP field from scratch rather than checking whether the *original* input element is still attached — a rejected submit often makes the site re-render the whole form (a fresh DOM node, same "enter your code" prompt), which would otherwise look identical to a successful dismissal. That same re-render also defeats `tryAutoFill`'s `input === _lastFilledInput` dedup (a new node never `===` the old one), which on its own would auto-fill-and-click on every mutation forever; `_lastAutoSubmitAt[hostname]` caps auto-fill(+submit) to once per minute per host regardless of node identity — the code is already sitting in whatever field is on screen either way, so a retry just means the user clicks/Enters it themselves instead of the extension silently hammering the form in the background.

Separately, the submit button lookup (`findSubmitButton()`) matches `[type="submit"]` **or** a bare `<button>` with no `type` attribute — a `<button>` inside a `<form>` defaults to `type="submit"` per the HTML spec when the attribute is omitted (common in React apps), but the CSS attribute selector `[type="submit"]` only matches an explicit attribute value, not that implicit default. Missing this meant falling back to `form.submit()`, which does **not** dispatch a `submit` event (React's `onSubmit` never runs) — effectively a no-op click on any JS-driven form.
