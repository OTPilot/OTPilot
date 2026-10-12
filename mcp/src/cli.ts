#!/usr/bin/env node
// otpilot-mcp: connect this computer's agent to OTPilot, and serve it over
// MCP (stdio). docs/agents/plan.md
//
//   otpilot-mcp connect [--name "Claude Code"]   pair, verify the code, approve in the extension
//   otpilot-mcp status                            who this agent is, its code, its accounts
//   otpilot-mcp disconnect                        forget this agent's credentials here
//   otpilot-mcp [serve]                           the MCP server (what the agent runs)
//
// --profile <name> (or OTPILOT_PROFILE) keeps several agents apart on one
// computer; connect defaults it from --name. --api <url> (or OTPILOT_API_URL).
import { spawn } from 'node:child_process'
import { hostname, platform } from 'node:os'
import { Api, ApiError, DEFAULT_API_URL } from './api.js'
import { agentCode } from './code.js'
import { generateKeyPair } from './ecies.js'
import { loadGrants } from './grants.js'
import { serve, VERSION } from './server.js'
import * as store from './store.js'

function args() {
  const argv = process.argv.slice(2)
  const flags: Record<string, string | boolean> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2)
      if (v !== undefined) flags[k] = v
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else rest.push(a)
  }
  return { cmd: rest[0] || 'serve', flags }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default'
const say = (s = '') => process.stderr.write(`${s}\n`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** The agent running this, when its environment tells (else "AI agent"). */
function guessName(): string {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'Claude Code'
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return 'Codex'
  if (process.env.CURSOR_TRACE_ID) return 'Cursor'
  return 'AI agent'
}

function openUrl(url: string) {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open'
  const a = platform() === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, a, { stdio: 'ignore', detached: true })
    child.on('error', () => { /* no opener here: the printed URL works */ })
    child.unref()
  } catch { /* printed anyway */ }
}

function setupLines(profile: string) {
  const args = profile === 'default' ? '' : ` --profile ${profile}`
  const argList = JSON.stringify(['-y', '@otpilot/mcp', ...(profile === 'default' ? [] : ['--profile', profile])])
  return [
    'Add it to your agent:',
    `  Claude Code   claude mcp add otpilot -- npx -y @otpilot/mcp${args}`,
    `  Codex         in ~/.codex/config.toml:  [mcp_servers.otpilot]  command = "npx"  args = ${argList}`,
    `  Cursor        in ~/.cursor/mcp.json:  { "mcpServers": { "otpilot": { "command": "npx", "args": ${argList} } } }`,
  ]
}

async function connect(flags: Record<string, string | boolean>) {
  const name = typeof flags.name === 'string' ? flags.name : guessName()
  // Without --name or --profile it's the default profile, which plain
  // status / serve use too; --name "Codex" keeps a second agent apart.
  const profile = typeof flags.profile === 'string' ? flags.profile
    : process.env.OTPILOT_PROFILE || (typeof flags.name === 'string' ? slug(flags.name) : 'default')
  const apiUrl = typeof flags.api === 'string' ? flags.api : process.env.OTPILOT_API_URL || DEFAULT_API_URL
  const keys = await generateKeyPair()
  const api = new Api(apiUrl)
  const pairing = await api.post<{ id: string; pair_secret: string; connect_url: string; expires_in: number }>('/agents/pair', {
    public_key: keys.publicKey, name, machine: hostname(),
  })
  const code = agentCode(keys.publicKey)
  say(`\nOTPilot — connecting "${name}" on ${hostname()}\n`)
  say(`  Verification code:  ${code}\n`)
  const open = flags.open !== 'false' && flags['no-open'] !== true
  say(`  1. Sign in at ${pairing.connect_url}`)
  if (open) say('     (opening it in your browser)')
  say('  2. Open the OTPilot extension → Agents, and approve it if it shows the same code.\n')
  if (open) openUrl(pairing.connect_url)
  say('Waiting for your approval…')
  const until = Date.now() + pairing.expires_in * 1000
  while (Date.now() < until) {
    await sleep(2500)
    let r
    try {
      r = await api.call<{ status: string; token?: string }>('POST', `/agent/pair/${pairing.id}/token`, { pair_secret: pairing.pair_secret })
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { say('\nThe request was denied or expired. Run connect again.'); process.exit(1) }
      continue // offline for a moment
    }
    if (r.body.token) {
      const where = await store.save(profile, { apiUrl, agentId: pairing.id, name, token: r.body.token, publicKey: keys.publicKey, privateJwk: keys.privateJwk })
      say(`\n✓ Connected as "${name}" (profile ${profile}). Credentials saved ${where === 'keychain' ? 'in your keychain' : `to ${where}`}.\n`)
      say('Now allow it some accounts in the extension (Agents → + Add account), or let it ask with request_access.\n')
      for (const l of setupLines(profile)) say(l)
      return
    }
  }
  say('\nTimed out waiting for approval. Run connect again.')
  process.exit(1)
}

async function status(profile: string) {
  const creds = await store.load(profile)
  if (!creds) { say(`No agent connected here (profile ${profile}). Run: npx -y @otpilot/mcp connect`); process.exit(1) }
  say(`"${creds.name}" (profile ${profile}) — verification code ${agentCode(creds.publicKey)}`)
  try {
    const grants = await loadGrants(new Api(creds.apiUrl, creds.token), creds.privateJwk)
    say(grants.length ? `Accounts it may use:\n${grants.map(g => `  - ${g.title}`).join('\n')}` : 'No accounts allowed yet.')
  } catch (e) {
    say(e instanceof ApiError && e.status === 401 ? 'Not connected anymore (revoked in OTPilot?). Run connect again.' : `Could not reach OTPilot: ${e instanceof Error ? e.message : e}`)
  }
}

async function main() {
  const { cmd, flags } = args()
  const profile = typeof flags.profile === 'string' ? flags.profile : process.env.OTPILOT_PROFILE || 'default'
  if (flags.version) { say(VERSION); return }
  if (cmd === 'connect') return connect(flags)
  if (cmd === 'status') return status(profile)
  if (cmd === 'disconnect') { await store.remove(profile); say(`Forgot this agent's credentials (profile ${profile}). Revoke it in the extension too.`); return }
  if (cmd !== 'serve') { say(`Unknown command "${cmd}". Commands: connect, status, disconnect, serve.`); process.exit(2) }
  const creds = await store.load(profile)
  if (!creds) {
    const again = profile === 'default' ? '' : ` --profile ${profile}`
    say(`OTPilot: no agent connected here (profile ${profile}). Run: npx -y @otpilot/mcp connect${again}`)
    process.exit(1)
  }
  await serve({ api: new Api(creds.apiUrl, creds.token), creds })
}

main().catch(e => { say(`otpilot-mcp: ${e instanceof Error ? e.message : e}`); process.exit(1) })
