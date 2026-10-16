---
name: otpilot
description: Use the user's OTPilot accounts (passwords, 2FA codes, API keys, database credentials) without seeing them — sign in to a website to test it, or run a command that needs a secret. Use whenever a task needs a login, a password, a 2FA/OTP code, a token or a credential, instead of asking the user to paste one.
---

# Using credentials through OTPilot

OTPilot holds the user's passwords and 2FA codes. You can **use** the accounts the user allowed you, through the `otpilot` MCP tools; you never see the values. Never ask the user to paste a password, a 2FA code or a secret into the chat.

## Find what you can use

Call `list_accounts`. Each account says what it allows: its **2FA code** only, its **sign-in** (username, password, 2FA), or chosen fields; whether it **asks the user every time**; and whether it's limited to some commands.

Need an account that isn't listed? Call `request_access` with a short `query` (the service, e.g. `"staging AWS"`) and a `reason` the user will read. It waits up to 90 s for the user to answer in the OTPilot extension.

## Test or use a website

1. `browser_login` with the account's name (and `url` if you need a specific page of that site). OTPilot signs in itself: username, password and the 2FA code.
2. It returns a Playwright **storageState** file under `.otpilot/`. Continue signed in with it:

```ts
const context = await browser.newContext({ storageState: '.otpilot/staging.json' })
```

With the Playwright MCP or a test runner, pass the same file as the storage state. Keep `.otpilot/` out of git (add it to `.gitignore`).

If it returns `needs_user` (wrong password, a captcha, an unusual step), tell the user what happened; don't retry in a loop.

## Run a command that needs a secret

Call `run` with the secrets as environment variables written as references `"<account>/<field>"`:

```json
{ "command": "psql -h db.staging.acme.io -U app -c 'select count(*) from payments'",
  "env": { "PGPASSWORD": "Staging DB/password" } }
```

Fields: `username`, `password`, `totp` (a fresh 2FA code), `notes`, or a custom field by its label (`"Stripe/Secret key"`). The output comes back with every secret replaced by `[REDACTED]`.

Recipes:
- **API call**: `curl -s -H "Authorization: Bearer $TOKEN" https://api.example.com/me` with `{ "TOKEN": "Example API/API key" }`.
- **2FA in an e2e test**: run the test with `{ "E2E_USER": "App/username", "E2E_PASS": "App/password", "E2E_TOTP": "App/totp" }`; the test reads them from `process.env`. A `totp` value is valid for about 30 s: start the test right away.
- **CLI login**: pass the token or password through the env variable the tool documents (`PGPASSWORD`, `MYSQL_PWD`, `GH_TOKEN`, `AWS_*`…), never as an argument.
- **A key file** (SSH key, Apple `.p8`, service-account JSON): `"<account>/@file"` (or the file field's label) sets the variable to the **path** of a private temporary copy (0600) that's deleted when the command ends. Git over SSH: `GIT_SSH_COMMAND='ssh -i "$KEY" -o IdentitiesOnly=yes' git push deploy main` with `{ "KEY": "Deploy key/@file" }`. fastlane with an App Store Connect key: `{ "ASC_KEY_PATH": "Apple API key 2X9R4HXF34/@file", "ASC_KEY_ID": "Apple API key 2X9R4HXF34/Key ID", "ASC_ISSUER_ID": "Apple API key 2X9R4HXF34/Issuer ID" }`.

## Waiting for the user

When a tool answers **"Waiting for approval"**, tell the user plainly: *"I need access to X — approve it in the OTPilot extension (Agents)."* Then call the tool again, or `check_request` with the request id. If the user denies, don't ask again for the same thing.

## Never

- Never print, echo, encode, write to a file or send a secret anywhere: the user trusted you with access, not with the values. (OTPilot scrubs what it returns, but don't try to get around it.)
- Never chain other commands onto a command an account is limited to.
- Never commit `.otpilot/` session files.
