# OTPilot

**TOTP authenticator for Chrome and Edge** — auto-detects 2FA setup pages, saves secrets in one click, and auto-fills codes on login.

[**Add to Chrome →**](https://chromewebstore.google.com/detail/otpilot) · [**otpilot.app**](https://otpilot.app)

---

## Features

- **Auto-detect 2FA setup** — scans pages for `otpauth://` URIs and QR codes; offers to save in one click
- **Auto-fill** — fills TOTP codes on login pages automatically, or on demand
- **Vault** — manage all your accounts with name, email, secret, and URL patterns
- **Master password lock** — AES-GCM encrypted vault with 24h / 30-day sessions
- **Local encrypted backup** — export and import your vault with a password
- **Cloud sync** *(Personal plan)* — end-to-end encrypted sync across all your devices

## AI agents (new in 2.1)

Let Claude Code, Codex, Cursor or any MCP agent sign in and run commands with the accounts you allow — passwords and 2FA codes — **without the agent ever seeing them**. See [`mcp/`](mcp/README.md).

```bash
npx -y @otpilot/mcp connect
```

In Claude Code, the plugin adds the server and a skill:

```
/plugin install otpilot --marketplace OTPilot/OTPilot
```

**Coming soon**
- Firefox and Safari support
- Team sharing - share TOTP access with teammates without exposing secrets
- Audit logs


## Licenses

| Directory | License |
|-----------|---------|
| `extension/` | GPL v3 |
| `api/` | AGPL v3 |
| `web/` | MIT |
| `mcp/` | GPL v3 |

---

If OTPilot saves you time, consider [buying me a coffee ☕](https://ko-fi.com/carpedev) — it helps keep the project alive.
