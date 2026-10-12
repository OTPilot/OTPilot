// The MCP server: the only way an agent reaches OTPilot. No tool returns a
// password, a 2FA code or any other value: they use them and return results.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Api, ApiError } from './api.js'
import { browserLogin } from './browser.js'
import { fieldValue, findGrant, loadGrants, openItem, PendingApproval, waitForAnswer, type Grant } from './grants.js'
import { redact } from './redact.js'
import { resolveAllowed, runCommand } from './run.js'
import type { Credentials } from './store.js'

export const VERSION = '0.1.0'

export const INSTRUCTIONS = `OTPilot lets you use the user's accounts (passwords, 2FA codes, other fields) without ever seeing them.
- Never ask the user to paste a password, a 2FA code or a secret into the chat: use OTPilot instead.
- list_accounts shows the accounts the user allowed you. To use another one, call request_access; the user approves it in the OTPilot browser extension.
- To test or use a website, call browser_login: OTPilot signs in (password and 2FA included) and gives you a Playwright storageState file. Load it in your browser (e.g. browser.newContext({ storageState })) to continue signed in.
- To run a command that needs a secret, call run with env values written as "<account>/<field>" (fields: username, password, totp for a fresh 2FA code, notes, or a custom field's label). Secrets are removed from the output.
- When a tool answers "Waiting for approval", tell the user to open the OTPilot extension (Agents) and approve, then call the tool again (or check_request).
- Never try to print, encode or send a secret elsewhere: the user trusts you with access, not with the values.`

/** How long a tool waits for the user's answer before returning "waiting". */
const WAIT_MS = 90_000

type Ctx = { api: Api; creds: Credentials }

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true })

function describe(g: Grant): string {
  const scope = g.scope.kind === '2fa' ? '2FA code' : g.scope.kind === 'login' ? 'sign-in (username, password, 2FA)' : `fields: ${(g.scope.parts || []).join(', ')}`
  const bits = [scope]
  if (g.askEveryTime) bits.push('asks the user every time')
  if (g.expiresAt) bits.push(`until ${g.expiresAt}`)
  if (g.commands.length) bits.push(`only with ${g.commands.join(', ')}`)
  return `- "${g.title}"${g.urls.length ? ` (${g.urls.join(', ')})` : ''}: ${bits.join('; ')}`
}

async function report(ctx: Ctx, itemId: string, action: string, detail: string) {
  await ctx.api.post('/agent/uses', { item_id: itemId, action, detail: detail.slice(0, 200) }).catch(() => {})
}

async function guard<T>(fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof PendingApproval) return fail(`${e.message} (request ${e.requestId})`)
    if (e instanceof ApiError && e.status === 401) return fail('This agent is no longer connected to OTPilot (revoked?). Ask the user to run: npx -y @otpilot/mcp connect')
    return fail(e instanceof Error ? e.message : String(e))
  }
}

export function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'otpilot', version: VERSION }, { instructions: INSTRUCTIONS })

  server.registerTool('list_accounts', {
    title: 'List allowed accounts',
    description: 'The accounts the user allowed this agent to use, with what each allows. Names only, never values.',
    inputSchema: {},
  }, () => guard(async () => {
    const grants = await loadGrants(ctx.api, ctx.creds.privateJwk)
    if (!grants.length) return text('No accounts allowed yet. Call request_access to ask the user for one.')
    return text(`Accounts ${ctx.creds.name} may use:\n${grants.map(describe).join('\n')}`)
  }))

  server.registerTool('request_access', {
    title: 'Ask the user for an account',
    description: 'Ask the user to let this agent use an account it doesn\'t have yet (e.g. "github", "staging database"). The user picks it in the OTPilot extension. Waits up to 90 s for the answer.',
    inputSchema: {
      query: z.string().min(1).max(200).describe('What account you need, in a few words: the site or service name.'),
      reason: z.string().max(500).describe('Why you need it, shown to the user.'),
    },
  }, ({ query, reason }) => guard(async () => {
    const req = await ctx.api.post<{ id: string }>('/agent/requests', { query, reason, tool: 'request_access' })
    const answer = await waitForAnswer(ctx.api, req.id, WAIT_MS)
    if (answer === 'denied') return fail('The user denied this request.')
    if (answer === 'pending') throw new PendingApproval(req.id, `access to "${query}"`)
    const grants = await loadGrants(ctx.api, ctx.creds.privateJwk)
    return text(`Allowed. Accounts ${ctx.creds.name} may use now:\n${grants.map(describe).join('\n')}`)
  }))

  server.registerTool('check_request', {
    title: 'Check a pending approval',
    description: 'Whether the user answered a request that was still waiting (by its id).',
    inputSchema: { request_id: z.string().uuid() },
  }, ({ request_id }) => guard(async () => {
    const r = await ctx.api.get<{ status: string }>(`/agent/requests/${request_id}`)
    return text(r.status === 'pending' ? 'Still waiting for the user.' : `The user ${r.status} it.`)
  }))

  server.registerTool('browser_login', {
    title: 'Sign in to a website',
    description: 'OTPilot signs in to the account\'s website itself (username, password and 2FA code, only on the account\'s own site) and returns the path of a Playwright storageState file with the signed-in session. Load it in your browser to continue signed in. You never get the credentials.',
    inputSchema: {
      account: z.string().min(1).describe('The account, as list_accounts names it.'),
      url: z.string().url().optional().describe('The page to start from (must be one of the account\'s sites). Defaults to its first saved site.'),
      reason: z.string().max(500).optional().describe('Why, shown to the user if this account asks every time.'),
      show_browser: z.boolean().optional().describe('Open a visible browser window (default: headless).'),
    },
  }, ({ account, url, reason, show_browser }) => guard(async () => {
    const grant = findGrant(await loadGrants(ctx.api, ctx.creds.privateJwk), account)
    if (grant.scope.kind === '2fa') return fail(`"${grant.title}" only allows its 2FA code, not signing in. Use run with "${grant.title}/totp", or ask the user to allow its sign-in.`)
    const item = await openItem(ctx.api, ctx.creds.privateJwk, grant, 'browser_login', reason || '', WAIT_MS)
    const result = await browserLogin(item, { url, outDir: `${process.cwd()}/.otpilot`, headless: !show_browser })
    await report(ctx, grant.itemId, 'browser_login', new URL(result.url).hostname)
    const secrets = [item.fields.map(f => f.value || ''), item.totp?.secret || ''].flat().filter(Boolean)
    const body = result.status === 'signed_in'
      ? `Signed in to ${result.url} ("${result.title}").\nSession: ${result.storageState}\nLoad it with Playwright: browser.newContext({ storageState: '${result.storageState}' }). Keep the file out of git (.otpilot/).`
      : `Could not finish signing in at ${result.url}: ${result.note}`
    return result.status === 'signed_in' ? text(redact(body, secrets)) : fail(redact(body, secrets))
  }))

  server.registerTool('run', {
    title: 'Run a command with secrets',
    description: 'Runs a shell command with secrets from allowed accounts in its environment, for that process only. env values are references "<account>/<field>" (username, password, totp = a fresh 2FA code, notes, or a custom field\'s label). Returns the exit code and the output with every secret removed.',
    inputSchema: {
      command: z.string().min(1).max(4000).describe('The command, e.g. psql -h db.example.com -c "select 1"'),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).describe('Environment variables to set, as references: { "PGPASSWORD": "Staging DB/password" }'),
      cwd: z.string().optional(),
      timeout_seconds: z.number().int().min(1).max(600).optional(),
      reason: z.string().max(500).optional().describe('Why, shown to the user if an account asks every time.'),
    },
  }, ({ command, env, cwd, timeout_seconds, reason }) => guard(async () => {
    const grants = await loadGrants(ctx.api, ctx.creds.privateJwk)
    const values: Record<string, string> = {}
    const secrets: string[] = []
    const used = new Map<string, Grant>()
    let program: { path: string; rest: string } | undefined
    for (const [name, ref] of Object.entries(env)) {
      const cut = ref.lastIndexOf('/')
      if (cut <= 0) return fail(`env ${name}: write it as "<account>/<field>", e.g. "Staging DB/password".`)
      const grant = findGrant(grants, ref.slice(0, cut))
      const limit = resolveAllowed(command, grant.commands, cwd)
      if (limit && 'error' in limit) return fail(`${grant.title}: ${limit.error}`)
      if (limit) program = limit
      const item = await openItem(ctx.api, ctx.creds.privateJwk, grant, 'run', reason || '', WAIT_MS)
      values[name] = await fieldValue(item, ref.slice(cut + 1))
      secrets.push(values[name], ...item.fields.map(f => f.value || ''), item.totp?.secret || '')
      used.set(grant.itemId, grant)
    }
    const r = await runCommand(command, values, { cwd, timeoutSec: timeout_seconds, secrets: secrets.filter(Boolean), program })
    const programName = command.trim().split(/\s+/)[0] || 'command'
    for (const g of used.values()) await report(ctx, g.itemId, 'run', programName)
    const out = [`exit code: ${r.exitCode ?? 'none'}${r.timedOut ? ' (timed out)' : ''}`]
    if (r.stdout) out.push(`stdout:\n${r.stdout}`)
    if (r.stderr) out.push(`stderr:\n${r.stderr}`)
    return text(out.join('\n'))
  }))

  return server
}

export async function serve(ctx: Ctx) {
  const server = buildServer(ctx)
  await server.connect(new StdioServerTransport())
}
