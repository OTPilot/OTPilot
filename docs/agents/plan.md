# OTPilot for AI agents (2.1): implementation plan

The user manages everything in the extension. An AI agent (Claude Code, Codex,
Cursor, any MCP client) never uses the extension: it only talks to the
**OTPilot MCP server** running on the user's computer, whose tools never return
a secret. Mockups: [`mockups.html`](mockups.html). Launch creatives:
[`launch-ad.html`](launch-ad.html).

## Decisions

| | |
|---|---|
| Where | This monorepo, a fourth sub-project `mcp/` (shares the vault crypto and its fixtures with `extension/` and `web/`; one PR can change API + extension + MCP) |
| Language | TypeScript on Node ≥ 20. Reuses `vaultCrypto.js` / `keys.js` as-is (same WebCrypto), Playwright is native, npx is free |
| Distribution | npm `@otpilot/mcp` (`npx -y @otpilot/mcp`), published from CI on a `mcp-v*` tag; listed in the MCP Registry; a Claude Code **plugin** bundling the MCP + a **skill**; snippets for Codex (`config.toml`, `AGENTS.md`) and Cursor (`mcp.json`, install link) |
| Guidance | The essentials live in the server's MCP `instructions` and tool descriptions (work in every client); the skill adds longer recipes |
| Plans | Free: 1 agent, 3 accounts (`web/src/lib/agents.ts`). Personal / Team: unlimited. Free users can create an account (needed: allowed accounts travel through the server, encrypted) |

## Security model

- **Agent identity.** On `connect` the MCP generates an ECDH P-256 keypair; the
  private key stays in the OS keychain (`@napi-rs/keyring`). The **verification
  code** shown in the terminal and in the extension is derived from the public
  key (first 40 bits of SHA-256, base32, `XXXX-XXXX`), so a server that swaps
  the key produces a different code. On approval the extension **pins** the
  agent's public key in an E2E-synced vault record, and only ever encrypts for
  a pinned key.
- **Grants are encrypted copies.** Allowing account A to agent G = the
  extension projects A to the allowed scope (`2fa` → TOTP secret only; `login`
  → username, password, TOTP, URLs; or chosen fields, reusing `project()` from
  `vaultShares.js`), encrypts it under a fresh key wrapped to G's pinned key
  (`wrapUserShare`, the existing ECIES), and uploads it. The server sees
  ciphertext only. One copy per (agent, item): two agents with different
  scopes never share a copy.
- **Keeping copies current.** Like `syncOwner` for shares: after a save / sync
  the owner's extension re-encrypts the agent copies of changed items.
- **Server-enforced, not cryptographic:** expiry ("1 hour"), "ask every time"
  (the copy is released for one use after an approval) and revocation stop an
  honest MCP from getting the copy again. An agent that already fetched a value
  keeps it: the UI says so on revoke ("change the passwords it had").
- **The MCP never caches** decrypted values beyond one tool call, and redacts
  every secret it used (plain, base64, URL-encoded, hex) from what it returns.
- **Honest limit** (on the web already): an agent that runs commands decides
  what they do. Mitigations: 2FA-only scope, per-account command allowlist,
  "ask every time".

## Stage 1 — API (`api/`)

Migration `0023_agents.sql`:

- `agents`: `id`, `user_id` (null while unclaimed), `name` (client, e.g.
  "Claude Code"), `machine`, `public_key`, `status` (`pending` / `active` /
  `revoked`), `token_hash` (the agent's bearer, hashed), `pair_secret_hash`,
  `created_at`, `approved_at`, `last_used_at`. A pending pairing expires after
  15 min.
- `agent_grants`: `agent_id`, `item_id`, `scope` (jsonb: kind + fields),
  `encrypted_item`, `wrapped_key`, `revision`, `expires_at`, `ask_every_time`,
  `commands` (optional allowlist), `created_at`. Unique `(agent_id, item_id)`.
- `agent_requests`: `id`, `agent_id`, `query` (free text the agent asked for,
  e.g. "github"), `tool`, `reason`, `status` (`pending` / `allowed` /
  `denied` / `expired`), `grant_item_id`, `created_at`, `decided_at`. Also used
  for one-use approvals of "ask every time" grants.
- `agent_uses`: `agent_id`, `item_id`, `action` (`browser_login` / `run` /
  `totp`), `detail` (command name or host, never a value), `created_at`;
  trimmed like `sync_logs`.

Routes:

| Who | Method / path | |
|---|---|---|
| public | `POST /agents/pair` | MCP registers `{ public_key, name, machine }` → `{ pairing_id, pair_secret, connect_url }` (rate-limited per IP) |
| user (web) | `POST /agents/pair/:id/claim` | The signed-in user claims a pairing (opened from `connect_url`) → it becomes a pending agent of theirs |
| user | `GET /agents` | Agents, grants (no ciphertext), pending requests, last activity |
| user | `POST /agents/:id/approve` / `DELETE /agents/:id` | Approve a claimed pairing (plan limit checked) / deny or revoke (deletes grants) |
| user | `PUT` / `DELETE /agents/:id/grants/:item_id` | Write / remove a grant's copy (`base_revision`; limit checked) |
| user | `POST /agents/requests/:id` | Decide a request: `allow` (with the grant) / `deny` / `allow_once` |
| user | `GET /agents/activity` | Recent `agent_uses` |
| MCP (pair secret) | `POST /agent/pair/:id/token` | Poll until approved → bearer token (once) |
| MCP (bearer) | `GET /agent/grants` | Its grants, ciphertext included (minus expired, minus "ask every time" ones not released) |
| MCP | `POST /agent/requests`, `GET /agent/requests/:id` | Ask for an account or a one-time use; poll the decision |
| MCP | `POST /agent/uses` | Report a use (activity log) |

- An `AgentAuth` extractor beside `AuthUser` (opaque token, SHA-256 in DB).
- `GET /notifications` gains `agents: { pairings, requests }`, so the badge and
  bell count them with no extra call.
- Deleting a vault item deletes its agent grants (like shares); deleting the
  account cascades.
- Tests as for shares (`db-tests`): plan limits, revoke, expiry, ask-every-time
  release, a pairing can't be claimed twice, an agent can't read another's
  grants.

## Stage 2 — Web (`web/`)

- `/agents/connect?p=<pairing>`: signed-in page that shows the agent (name,
  machine, **code**) and claims it ("Continue in the OTPilot extension to
  approve"). Approval itself stays in the extension, where the vault is.

## Stage 3 — Extension (`extension/`)

- `agents.js` (new, like `vaultShares.js`): list, approve (verify code → pin
  key → `POST approve`), write / remove grants (project + encrypt + upload),
  decide requests (matching the request's text against the vault locally to
  offer candidates), `syncAgentCopies(key)` after every save / sync (popup and
  background), revoke.
- Popup: rail item **Agents** (between Team and Settings, dot when pending),
  views per mockups 1–4 and 7; **AI agents** section in the item editor
  (mockup 5); free-plan limit card.
- Notices: agent pairings / requests in the bell (mockup 6) and the toolbar
  badge; while one is pending, `refreshNotices` polls every 15 s for 5 min
  instead of waiting for the 5-min alarm.
- Pinned agent keys: an E2E record re-wrapped with the vault (like
  `teamPrivWrapped` in `VaultStore`'s `EXTRA_RECORDS`), so another device of
  the same user trusts the same keys.
- Tests (Playwright): approve with code, grant scopes, request allow / deny,
  limit on Free, revoke, copies rewritten after an edit.

## Stage 4 — MCP server (`mcp/`)

```
mcp/
  package.json        @otpilot/mcp, bin: otpilot-mcp
  src/cli.ts          connect | status | revoke | (default) serve over stdio
  src/crypto.ts       loads ../extension/vaultCrypto.js + ECIES unwrap with the agent key
  src/api.ts          AgentAuth calls, pairing, polling
  src/keychain.ts     private key + token (@napi-rs/keyring)
  src/tools/*.ts      one file per tool
  src/redact.ts       scrubbing of used secrets from any returned text
  test/               fixtures shared with extension/web (vault-crypto.json)
```

- `vaultCrypto.js` / `keys.js` get a one-line CommonJS export at the end
  (`if (typeof module !== 'undefined') module.exports = …`), harmless in the
  extension, so the MCP imports the real code instead of a copy.
- `connect`: keypair → `POST /agents/pair` → prints the **code** and opens
  `connect_url` → polls → stores the token. Also prints the line to add it to
  Claude Code / Codex / Cursor.
- Tools (all return results, never values):
  - `list_accounts()` → names, sites, scopes, expiry.
  - `request_access(query, reason)` → `pending_approval` (with what to tell the
    user) / `allowed`.
  - `browser_login(account, url?)` → signs in with Playwright (system Chrome
    via `channel: 'chrome'`, else bundled Chromium) on the account's own site
    only (`loginCoversHost` from `vault.js`), fills username → password → TOTP,
    saves `storageState` to `.otpilot/<account>.json` (0600, expires) and
    returns its path. Login-form detection starts simple (autocomplete,
    `type=password`, OTP inputs) and reuses the extension's heuristics where it
    can.
  - `run(command, env)` → `env` values are references `account/field`
    (`password`, `username`, `totp` = a fresh code); checks the account's
    command allowlist; runs with a timeout; returns redacted stdout/stderr and
    the exit code.
  - `totp_env` is covered by `run` (`totp`), so there's no tool that returns a
    code.
- Server `instructions`: never ask the user to paste a password or code; ask
  OTPilot instead; on `pending_approval`, tell the user to approve in OTPilot
  and retry; use the `storageState` file with Playwright; reference secrets as
  `account/field`.
- Every use is reported (`POST /agent/uses`).

## Stage 5 — Distribution

- CI job: on tag `mcp-v*`, test + `npm publish --provenance`.
- MCP Registry entry (`server.json`).
- Claude Code plugin (`mcp/plugin/`): `.mcp.json` with the server + `skills/otpilot/SKILL.md`
  (recipes: e2e test with 2FA, psql / curl with secrets, what to do when an
  account isn't allowed).
- Docs page on the web (`/ai-agents#setup`) with the snippet per client.

## Stage 6 — Release 2.1.0

Order: API (migration + routes) → MCP to npm → extension 2.1.0 to the stores
→ web (already written: `/ai-agents`, pricing, comparisons, creatives). The
web goes live **last**: it describes the feature.

## Open questions

- `connect_url` opens the browser on otpilot.app: fine for a laptop, not for a
  remote / headless machine (CI). Fallback: `connect --code` prints a short
  code the user types in the extension's "+ Connect an agent".
- Windows / Linux keychains: `@napi-rs/keyring` covers both; Touch ID-style
  prompts only on macOS later.
