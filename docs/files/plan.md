# Secure files & SSH keys (2.2): design proposal

Save the small secret **files** developers keep losing track of: SSH keys, the
App Store Connect `.p8`, a `.p12` signing certificate, a Google service-account
JSON, `google-services.json`, a `.mobileprovision`, a kubeconfig, an `.env`.
Mockups: [`mockups.html`](mockups.html).

Status: phase 1 built (extension: `vault.js` file kind + `ssh` / `file` types, `sshKeys.js`, `fileKinds.js`, the popup's file fields; MCP: file references in `run`). Large attachments (phase 2) not started.

## As built (differences from the proposal below)

- An Apple `.p8` becomes an API credential titled "Apple API key <KEY ID>" (the same file format serves App Store Connect, APNs and Sign in with Apple).
- No "Used on" field on SSH keys: link the server or login in Related.
- Generated SSH keys have no passphrase (the vault encrypts them; `ssh-keygen -p` adds one). Imported keys keep theirs; the public key of a passphrase-protected OpenSSH key is still read.
- "Split into fields" turns an `.env` into a secure note with one hidden field per variable.
- Agents reference a file as `"<account>/@file"` or by its field label; there's no `{…}` interpolation inside a value (use the variable in the command: `ssh -i "$KEY"`).

## The idea in one line

A **file is a field kind** (`file`), not a new storage system. Any item can hold
one (an API credential with its `.p8`, a login with its `.p12`), plus two types
built around it: **SSH key** and **Secure file**. Because it's a field, sync,
sharing, collections, agents, backup and the CSV round-trip all work unchanged.

## Naming

| Concept | UI name | Why |
|---|---|---|
| Field kind | **File** (`kind: 'file'`) | Shown next to Text / Hidden / Email / Date / Multi-line in "+ Add field" |
| Standalone type | **Secure file** (`type: 'file'`) | Parallels "Secure note"; covers anything that isn't a key (JSON configs, profiles, `.env`) |
| Key type | **SSH key** (`type: 'ssh'`, already in `UPCOMING_TYPES`) | Has its own behaviour: public key, fingerprint, generate |
| Feature (store, llms.txt) | **Secure files & SSH keys** | |

No special type for the `.p8`: it is an **API credential** (Key ID, Issuer ID)
with a file field. Detection (below) fills it in.

## Storage

### Phase 1: inline, inside the encrypted item (no server change)

The bytes travel inside the item like any other field value:

```js
{ id: 'f_k2', label: 'Private key', kind: 'file', custom: true,
  value: 'data:application/octet-stream;name=AuthKey_2X9R4HXF34.p8;size=257;base64,LS0tLS1CRUdJTi…' }
```

- **The value is a self-describing `data:` URL string**, not an object. 2.1's
  editor rebuilds custom fields from the DOM (`readCustomFields` keeps only
  `id/label/value/kind/section`) and shows unknown kinds as a textarea of the
  string: metadata stored beside the value would be lost on the first save from
  an older device; inside the value it survives untouched. Text vs binary is
  decided on read (UTF-8 decodes and has no NULs → text).
- **Size cap: 64 KB of files per item.** The record limit is 128 KiB
  (`MAX_RECORD_BYTES`); bytes grow ≈1.78× (base64 in the item JSON, then the
  encrypted record in base64), so 64 KB → ~114 KiB plus the rest of the item.
  Typical sizes: `.p8` 0.3 KB, ed25519 key 0.4 KB, RSA-4096 3.3 KB, `.p12`
  3–6 KB, service-account JSON 2.4 KB, `.mobileprovision` 8–20 KB, `.jks`
  2–5 KB, `.ovpn` with certs ~10 KB. Over the cap: a clear refusal, never a
  silent truncation (mockup 8).
- **Local quota**: add the `unlimitedStorage` permission (no install warning);
  `chrome.storage.local` is otherwise 10 MB for the whole vault.
- Free plan: an SSH key / secure file is an item and counts toward the 50
  (`countsForLimit` unchanged). No separate file quota in phase 1.

### Phase 2 (later, only if asked for): large attachments

PDFs, ID scans, keystores over 64 KB: encrypted blobs in R2 (already used for
icons), each under its own file key stored in the item field
(`otpilot-file:v1;ref=<id>;key=<…>`), uploaded/downloaded with presigned URLs,
fetched on demand (not on every sync), per-plan quota, paid only. A share or
agent copy carries the file key; the server never sees it. Not needed for the
use case that started this.

## Where it shows

- **"+ Add" picker**: SSH key and Secure file leave "Soon"; below the types a
  drop zone, **"Drop a file or choose one"** (mockup 1). The popup already uses
  `<input type=file>` (imports), so choosing works; drag & drop onto the Vault
  view works too.
- **Detection on drop** (`fileKinds.js`, pure): decides the type and prefills
  (mockup 2). Starting set:

  | File | Becomes | Prefilled |
  |---|---|---|
  | `-----BEGIN OPENSSH PRIVATE KEY-----`, `id_*` | SSH key | public key, fingerprint, type, comment; asks passphrase if encrypted |
  | `AuthKey_<KEYID>.p8` | API credential "App Store Connect API key" | Key ID from the name; Issuer ID asked; site appstoreconnect.apple.com |
  | JSON with `"type": "service_account"` | API credential "Google service account" | project id, client email |
  | `.p12` / `.pfx` | Secure file | asks the certificate password (Password field) |
  | `.env` | Secure file, or "Split into fields" (an API credential with one hidden field per variable; comments and blank lines dropped) | |
  | anything else ≤ 64 KB | Secure file | name = file name |

- **Item editor**: a file field is a **file chip** (extension badge, name,
  size, short SHA-256) with Download · Copy (text files only) · Show (text,
  monospace, masked until clicked) · Replace · Remove (mockups 3, 5, 6).
- **SSH key editor** (mockup 3): Private key (file), Public key (plain, Copy),
  Fingerprint `SHA256:…` and key type (computed, read-only), Passphrase,
  Comment, "Used on" (hosts, e.g. github.com). Actions: Copy public key,
  Download as `id_ed25519` (with the `chmod 600` hint), **Generate**.
- **Generate SSH key** (mockup 4): Ed25519 (default, WebCrypto) or RSA 4096,
  comment, optional passphrase; writes the OpenSSH private key format. Then
  "Add to GitHub / GitLab" opens the provider's new-key page.
- **Any item gets "+ File"** among the custom field kinds (mockup 6): the Apple
  Developer login keeps its `.p8` and `.p12` in a "Files" section; Related
  items link a standalone SSH key to the server it opens.
- **Vault list** (mockup 7): type filter chips include SSH keys / Files; rows
  show `ed25519 · SHA256:9f…` or `AuthKey_….p8 · 257 B`; search matches file
  names.
- **Home**: unchanged (login-centric). A login's related SSH key / file shows
  in its Related list with Download.
- **Web dashboard**: nothing in phase 1 (no vault view there).

## Agents (MCP)

Files are where agents get most useful: shipping a build with the `.p8`,
pushing with a deploy key. `run` env references gain a file form:

```
otpilot.run(command: "fastlane pilot upload",
            env: { ASC_KEY_PATH: "App Store Connect/@file", ASC_KEY_ID: "App Store Connect/Key ID" })
otpilot.run(command: "git push deploy main",
            env: { GIT_SSH_COMMAND: "ssh -i {Deploy key/@file} -o IdentitiesOnly=yes" })
```

- `@file` (or `@<field label>` for a specific file field) writes the bytes to a
  fresh `0700` temp directory as `0600`, outside the cwd, passes the **path**,
  and deletes it when the process exits (also on timeout / kill).
- The agent still never receives the value: the path is useless after the run,
  and `redact.ts` scrubs the file's text (and its base64 body lines) from the
  output like any other secret.
- Grant scope: a file field is a share part (`f:<fieldId>`) already, so "Fields"
  scope covers it; the editor's AI agents section lists it (mockup 9).
- Later: an `ssh` tool / a local ssh-agent socket served by the MCP that signs
  without ever writing the key to disk.

## Security notes

- Content scripts never get file fields (same stripping as custom fields);
  `vaultIndex` never mentions them.
- Download = a `blob:` URL with `<a download>` from the popup (no `downloads`
  permission). The UI says the downloaded copy isn't protected and prefers
  Copy for text keys.
- Copying a key goes through the same clipboard path as passwords.
- Generated private keys are created and encrypted in the popup; never sent in
  clear.

## What changes, by area

| Area | Change |
|---|---|
| `vault.js` | `'file'` in `FIELD_KINDS` (masked by its own chip, not in `SECRET_KINDS`, which the generator offers); `ssh` + `file` in `TYPES`; `fileOf(value)` / `fileValue(meta, bytes)` for the `data:` URL; `FILE_BYTES_LIMIT` |
| `fileKinds.js` (new, pure) | detection + prefill; SSH parsing (public key, fingerprint, type, encrypted?) |
| `sshKeys.js` (new, pure) | Ed25519 / RSA generation, OpenSSH private-key encoding |
| `popup.js` | file chip in `fieldHTML` / custom fields, drop zone, detection sheet, SSH editor, generate modal |
| `importers.js` | file fields in the CSV `fields` JSON round-trip as their `data:` URL |
| `manifest.json` | `unlimitedStorage` |
| `mcp/` | `@file` references in `run` (temp file lifecycle), redaction of file contents, `list_accounts` shows file fields by label |
| `web/src/lib/vaultCrypto.ts` | nothing (fields are opaque); the fixtures gain an item with a file field |
| API | nothing in phase 1 |
| Outside the app | llms.txt (Key features + Versions), manifest description, store text |

## Decisions

| | |
|---|---|
| Size cap | 64 KB of files per item (all of an item's file fields together) |
| Free plan | SSH keys and secure files are items like any other: they count toward the 50, no extra file quota |
| `.env` | "Split into fields" is in phase 1 |
| SSH keys | Generation (Ed25519 + RSA 4096) is in phase 1, not only import |
