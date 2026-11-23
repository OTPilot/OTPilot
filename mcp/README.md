# OTPilot for AI agents (`@otpilot/mcp`)

[![skills.sh](https://skills.sh/b/OTPilot/OTPilot)](https://skills.sh/OTPilot/OTPilot)

Let **Claude Code, Codex, Cursor** or any MCP agent sign in to websites and run commands with your passwords and 2FA codes — **without the agent ever seeing them**. You choose which accounts each agent may use, in the [OTPilot](https://otpilot.app) browser extension.

```bash
npx -y @otpilot/mcp@latest connect
```

1. It shows a **verification code** and opens a page to sign in to OTPilot (a free account works).
2. In the extension, **Agents** shows the agent: approve it if the code matches.
3. Allow it some accounts (Agents → **+ Add account**), or let it ask for them as it works.

**Claude Code plugin** (the MCP server plus a skill that teaches Claude to use it):

```
/plugin install otpilot --marketplace OTPilot/OTPilot
```

(Before Claude Code 2.1.275: `/plugin marketplace add OTPilot/OTPilot`, then `/plugin install otpilot@otpilot`.)

then connect it once: `npx -y @otpilot/mcp@latest connect --name "Claude Code"`.

Or add the server to your agent yourself (`connect` prints these for you):

| Agent | |
|---|---|
| Claude Code | `claude mcp add otpilot -- npx -y @otpilot/mcp@latest` |
| Codex | `~/.codex/config.toml`: `[mcp_servers.otpilot]` `command = "npx"` `args = ["-y", "@otpilot/mcp@latest"]` |
| Cursor | `~/.cursor/mcp.json`: `{ "mcpServers": { "otpilot": { "command": "npx", "args": ["-y", "@otpilot/mcp@latest"] } } }` |
| [Pi](https://pi.dev) | `pi mcp add otpilot -- npx -y @otpilot/mcp@latest` |

**Skill for any agent:** [`plugin/skills/otpilot/SKILL.md`](https://github.com/OTPilot/OTPilot/blob/main/mcp/plugin/skills/otpilot/SKILL.md) teaches an agent when and how to use these tools (and how to set them up). Install it with `npx skills add OTPilot/OTPilot` (it asks which agents), or copy it to your agent's skills folder. This repository is its only official source.

For Codex and other agents that read `AGENTS.md`, add a line so they reach for it: *"For passwords, 2FA codes, API keys or any login, use the `otpilot` MCP tools (list_accounts, browser_login, run); never ask me to paste a secret."*

Each agent is its own identity, approved on its own: connect Claude Code and Codex separately (`connect --name Codex`), and add `--profile <name>` as `connect` shows.

### On a server or VPS

Run it where the agent runs — your laptop, a VPS, a container. On a server without a browser, skip the opener and open the printed link on any device signed in to OTPilot, then approve it in the extension if the codes match:

```bash
npx -y @otpilot/mcp@latest connect --name VPS --no-open
npx -y @otpilot/mcp@latest --profile vps                 # what the agent runs
npx playwright install --with-deps chromium       # only for browser_login without Chrome
```

With no keychain (a bare Linux box) the credentials go to `~/.config/otpilot/mcp-<profile>.json` (0600): the accounts you allow are opened on that machine, so connect only machines you trust — whoever has root there can use them.

### Updating

Set up as above (`npx -y @otpilot/mcp@latest`), there's nothing to install: **restart your agent** (quit and reopen it, or start a new session) and npx fetches the newest version when the server starts. Your connection stays: no need to run `connect` again or approve the agent again.

- Which version runs: `npx -y @otpilot/mcp@latest --version` (the releases are in the [changelog](https://github.com/OTPilot/OTPilot/blob/main/CHANGELOG.md)).
- Still the old one after a restart? npx reused its cache: `rm -rf ~/.npm/_npx`, then restart the agent.
- Pinned a version (`@otpilot/mcp@0.2.0`) or installed it globally (`npm i -g`)? Switch to `@otpilot/mcp@latest` in your agent's configuration, or run `npm i -g @otpilot/mcp@latest`.
- Claude Code plugin: `/plugin update otpilot` also updates the skill. The skill installed with `npx skills add OTPilot/OTPilot`: run it again.

## Tools

| Tool | What the agent gets |
|---|---|
| `list_accounts` | The accounts it may use, by name and site |
| `request_access(query, reason)` | Asks you for another account; you pick it in the extension |
| `browser_login(account, url?)` | OTPilot signs in (username, password, 2FA — only on the account's own site) and returns a Playwright `storageState` file with the session |
| `run(command, env)` | Runs the command with secrets in its environment (`{ "PGPASSWORD": "Staging DB/password" }`, `…/totp` for a fresh 2FA code); output comes back with every secret removed |
| `check_request(request_id)` | Whether you answered a request that was still waiting |

No tool returns a password, a 2FA code or any other value.

## Plans

- **Free:** one connected agent, any number of accounts, and **10 uses a month** (UTC; they renew on the 1st, unused ones don't carry over). A use is one `browser_login` or one `run` call, however many accounts it uses. `list_accounts`, `request_access` and `check_request` never count; `list_accounts` says how many uses are left. When they run out, the tools answer with the date they renew and a link to upgrade, and the agent should tell you. A `run` with a wrong field name (a custom field's label that doesn't exist) still counts as a use, because the name can only be checked once the account is open: use the field names the user gave you.
- **Personal, Team, and the 30-day Personal trial:** unlimited agents and uses.

The limit is a meter, counted where OTPilot's server hands an account's encrypted copy to the MCP (`POST /agent/grants/open`, once per tool call; a retry of the same call isn't counted twice). It's not a security boundary: this MCP is open source, and a modified one could keep the copies it opened. What protects your accounts is what you allow each agent (above), not the count.

The MCP sends its version on every call (`x-otpilot-mcp`). An older MCP (0.2.0 and before) on the Free plan is told to update: restart the agent so `npx -y @otpilot/mcp@latest` fetches the current one. (Releases: the API goes out first, then this package.)

## Security

- **The agent's own key.** `connect` creates an ECDH P-256 keypair; the private key stays in your OS keychain. Each account you allow is a copy, holding only what you chose (just the 2FA code, the sign-in, or chosen fields), encrypted for that key in the extension. OTPilot's servers only see ciphertext.
- **Two approvals.** Connecting an agent gives it nothing; each account is allowed per agent. The verification code is derived from the agent's public key on every side, so a swapped key shows a different code.
- **Limits you set:** for a while or until revoked, "ask me every time", and "only with these commands": `run` then accepts only that program, called by name and resolved on the server's PATH (never from the working or temp directory), as a single command with no chaining or redirection — a guard against mistakes and simple tricks, not against an agent that can plant its own binary on your PATH. One call can wait for at most 10 "ask me every time" approvals: a command using more is refused before anything is asked. One call can also use at most 20 accounts in all (the server's limit): a command using more is refused the same way.
- **Only over HTTPS** (plain HTTP just for local hosts), and every secret is scrubbed from what comes back — before the output is cut, so none is left half-removed. A timeout kills the command and everything it started.
- **Only on the right site.** `browser_login` fills only on pages the account's saved sites cover.
- **Activity and revoke** in the extension's Agents view.
- **The honest limit:** an agent that runs commands decides what they do and could try to reveal a secret on purpose. OTPilot scrubs secrets from what it returns; for sensitive accounts allow only the 2FA code, limit the commands, or turn on "ask me every time".

## Commands

```
otpilot-mcp connect [--name "Claude Code"] [--profile p] [--no-open]
otpilot-mcp status [--profile p]       # name, verification code, allowed accounts
otpilot-mcp disconnect [--profile p]   # forget the credentials here (revoke it in the extension too)
otpilot-mcp [serve] [--profile p]      # the MCP server (stdio) — what your agent runs
```

`browser_login` uses your installed Google Chrome (or Edge); without one, run `npx playwright install chromium`. Sessions are saved to `.otpilot/` in the working directory: keep it out of git.

License: GPL-3.0. Source: [github.com/OTPilot/OTPilot](https://github.com/OTPilot/OTPilot/tree/main/mcp).
