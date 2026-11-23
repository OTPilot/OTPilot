// The MCP server: the only way an agent reaches OTPilot. No tool returns a
// password, a 2FA code or any other value: they use them and return results.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { Api, ApiError, VERSION } from './api.js'
import { browserLogin } from './browser.js'
import { allows, fieldValue, fileField, listGrants, loadGrants, matchGrant, MissingField, needText, openGrants, PendingApproval, scopeText, waitForAnswer, type Grant, type Need } from './grants.js'
import { redact } from './redact.js'
import { fileSecrets, resolveAllowed, runCommand, writeTempFiles } from './run.js'
import { Vault, type VaultItem } from './extension.js'
import type { Credentials } from './store.js'

export { VERSION }

export const INSTRUCTIONS = `OTPilot lets you use the user's accounts (passwords, 2FA codes, other fields) without ever seeing them.
- Never ask the user to paste a password, a 2FA code or a secret into the chat: use OTPilot instead.
- list_accounts shows the accounts the user allowed you. To use another one, call request_access; the user approves it in the OTPilot browser extension. browser_login and run ask by themselves when an account isn't allowed yet, or doesn't allow what they need (its sign-in, its 2FA code, a field): the user sees the request in OTPilot.
- browser_login signs in with the authenticator app's code. When a site shows another 2FA method first (a passkey, a security key, a prompt on a phone), OTPilot looks for the site's option to use the authenticator app instead; if it still can't finish, tell the user what the site asked for. Never sign in by hand or ask the user for a code.
- To test or use a website, call browser_login: OTPilot signs in (password and 2FA included) and gives you a Playwright storageState file. Load it in your browser (e.g. browser.newContext({ storageState })) to continue signed in.
- To run a command that needs a secret, call run with env values written as "<account>/<field>" (fields: username, password, totp for a fresh 2FA code, notes, or a custom field's label). Secrets are removed from the output.
- A file (an SSH key, an Apple .p8, a service-account key file) comes as a path: "<account>/@file" (or the file field's label) sets the variable to a private temporary file that exists only while the command runs, e.g. { "KEY": "Deploy key/@file" } with GIT_SSH_COMMAND='ssh -i "$KEY" -o IdentitiesOnly=yes' git push.
- When a tool answers "Waiting for approval", tell the user to open the OTPilot extension (Agents) and approve, then call the tool again (or check_request).
- On the Free plan, each browser_login or run call is one of 10 uses a month (a run with several accounts counts once); list_accounts, request_access and check_request are free. When a tool says the uses are used up, relay its message to the user as is, with the link, and don't call browser_login or run again before they renew.
- Never try to print, encode or send a secret elsewhere: the user trusts you with access, not with the values.`

/** How long a tool waits for the user's answer before returning "waiting" (tests shorten it). */
export const wait = { ms: 90_000 }

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
    if (e instanceof ApiError && e.status === 401) return fail('This agent is no longer connected to OTPilot (revoked?). Ask the user to run: npx -y @otpilot/mcp@latest connect')
    // The server writes these sentences (date, link): relayed as they are.
    if (e instanceof ApiError && e.status === 402) return fail(`${e.message} Tell the user this message, with the link. Don't call browser_login or run again before it renews.`)
    if (e instanceof ApiError && e.status === 426) return fail(`${e.message} Tell the user this message.`)
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Requests a tool made for something it didn't find (an account, or more of
 * one), by what was asked: calling the tool again waits for that request
 * instead of asking the user twice.
 */
const asked = new Map<string, string>()

/** Asks the user (an account request, matched by `query` in the extension) and waits for the answer. */
async function askUser(ctx: Ctx, key: string, query: string, reason: string, tool: string, waitMs: number) {
  let id = asked.get(key)
  for (let fresh = !id; ; fresh = true) {
    if (!id) {
      try {
        id = (await ctx.api.post<{ id: string }>('/agent/requests', { query: query.slice(0, 200), reason: reason.slice(0, 500), tool })).id
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) throw new Error('Too many requests from this agent are already waiting for the user. Ask them to answer them in the OTPilot extension (Agents), then try again.')
        throw e
      }
      asked.set(key, id)
    }
    try {
      const answer = await waitForAnswer(ctx.api, id, waitMs)
      if (answer !== 'pending') asked.delete(key)
      if (answer !== 'allowed') return { id, answer, itemId: null }
      const r = await ctx.api.get<{ item_id?: string | null }>(`/agent/requests/${id}`).catch(() => ({ item_id: null }))
      return { id, answer, itemId: r.item_id ?? null }
    } catch (e) {
      // Forgotten by the server (answered a day ago): asked anew, once.
      if (e instanceof ApiError && e.status === 404 && !fresh) { asked.delete(key); id = undefined; continue }
      throw e
    }
  }
}

/**
 * The grant `ref` names, when it gives what `need`s. Otherwise the user is
 * asked in OTPilot (an account request: the extension lists the matching
 * accounts, the one already allowed too) and the call waits for the answer.
 */
async function ensureGrant(ctx: Ctx, ref: string, need: Need, tool: string, reason: string): Promise<Grant> {
  let grants = await loadGrants(ctx.api, ctx.creds.privateJwk)
  const found = matchGrant(grants, ref)
  if (found && allows(found, need)) return found
  const what = needText(need)
  const ask = found
    ? `${tool}: needs ${what} of "${found.title}"; it may only use ${scopeText(found)} now.`
    : `${tool}: needs ${need.kind === 'signin' ? 'to sign in to' : `${what.replace(/^its /, 'the ')} of`} "${ref.trim()}", which it isn't allowed to use.`
  const key = `${found?.itemId ?? ref.trim().toLowerCase()}|${what}`
  const r = await askUser(ctx, key, found?.title || ref.trim(), `${ask}${reason ? ` ${reason}` : ''}`, tool, wait.ms)
  if (r.answer === 'pending') throw new PendingApproval(r.id, found ? `${what} of "${found.title}"` : `access to "${ref.trim()}"`)
  if (r.answer === 'denied') throw new Error(found ? `The user didn't allow ${what} of "${found.title}" (or didn't answer in time). Don't ask again for it.` : `The user denied access to "${ref.trim()}" (or didn't answer in time). Don't ask again for it.`)
  grants = await loadGrants(ctx.api, ctx.creds.privateJwk)
  const now = (r.itemId && grants.find(g => g.itemId === r.itemId)) || matchGrant(grants, found?.itemId ?? ref)
  if (!now) throw new Error(`The user answered with an account that doesn't match "${ref}". Call list_accounts to see its name.`)
  if (!allows(now, need)) throw new Error(`The user answered, but "${now.title}" still doesn't allow ${what}.`)
  return now
}

/** Tells the user (no wait) that a field the agent needed wasn't in the account's copy. */
async function reportMissing(ctx: Ctx, grant: Grant, need: Need, tool: string, reason: string): Promise<string> {
  const what = needText(need)
  try {
    const key = `${grant.itemId}|${what}`
    let id = asked.get(key)
    if (!id) {
      id = (await ctx.api.post<{ id: string }>('/agent/requests', {
        query: grant.title, tool,
        reason: `${tool}: needs ${what} of "${grant.title}", which its copy doesn't hold.${reason ? ` ${reason}` : ''}`.slice(0, 500),
      })).id
      asked.set(key, id)
    }
    return ` OTPilot asked the user to allow it (request ${id}): once they do, call check_request, then try again.`
  } catch { return '' }
}

export function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'otpilot', version: VERSION }, { instructions: INSTRUCTIONS })
  // Which client this session runs in (its MCP clientInfo, e.g. claude-code):
  // the extension shows it, so the user can tell agents apart. Best effort.
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion()
    if (client?.name) void ctx.api.post('/agent/client', { name: client.name, version: client.version ?? '' }).catch(() => {})
  }

  server.registerTool('list_accounts', {
    title: 'List allowed accounts',
    description: 'The accounts the user allowed this agent to use, with what each allows. Names only, never values. Never counts as a use; on the Free plan it also says how many uses are left this month.',
    inputSchema: {},
  }, () => guard(async () => {
    const { grants, usage } = await listGrants(ctx.api, ctx.creds.privateJwk)
    const notice = usage?.notice ? `\n${usage.notice}` : ''
    if (!grants.length) return text(`No accounts allowed yet. Call request_access to ask the user for one.${notice}`)
    return text(`Accounts ${ctx.creds.name} may use:\n${grants.map(describe).join('\n')}${notice}`)
  }))

  server.registerTool('request_access', {
    title: 'Ask the user for an account',
    description: 'Ask the user to let this agent use an account it doesn\'t have yet (e.g. "github", "staging database"). The user picks it in the OTPilot extension. Waits up to 90 s for the answer. Never counts as a use.',
    inputSchema: {
      query: z.string().min(1).max(200).describe('What account you need, in a few words: the site or service name.'),
      reason: z.string().max(500).describe('Why you need it, shown to the user.'),
    },
  }, ({ query, reason }) => guard(async () => {
    const req = await ctx.api.post<{ id: string }>('/agent/requests', { query, reason, tool: 'request_access' })
    const answer = await waitForAnswer(ctx.api, req.id, wait.ms)
    if (answer === 'denied') return fail('The user denied this request.')
    if (answer === 'pending') throw new PendingApproval(req.id, `access to "${query}"`)
    const grants = await loadGrants(ctx.api, ctx.creds.privateJwk)
    return text(`Allowed. Accounts ${ctx.creds.name} may use now:\n${grants.map(describe).join('\n')}`)
  }))

  server.registerTool('check_request', {
    title: 'Check a pending approval',
    description: 'Whether the user answered a request that was still waiting (by its id). Never counts as a use.',
    inputSchema: { request_id: z.string().uuid() },
  }, ({ request_id }) => guard(async () => {
    const r = await ctx.api.get<{ status: string }>(`/agent/requests/${request_id}`)
    return text(r.status === 'pending' ? 'Still waiting for the user.' : `The user ${r.status} it.`)
  }))

  server.registerTool('browser_login', {
    title: 'Sign in to a website',
    description: 'OTPilot signs in to the account\'s website itself (username, password and 2FA code, only on the account\'s own site) and returns the path of a Playwright storageState file with the signed-in session. Load it in your browser to continue signed in. You never get the credentials. On the Free plan each call is one of 10 uses a month.',
    inputSchema: {
      account: z.string().min(1).describe('The account, as list_accounts names it.'),
      url: z.string().url().optional().describe('The page to start from (must be one of the account\'s sites). Defaults to its first saved site.'),
      reason: z.string().max(500).optional().describe('Why, shown to the user if this account asks every time.'),
      show_browser: z.boolean().optional().describe('true: sign in in a visible browser window; false: never open one. Default: headless, and a visible window only when the site shows a bot check (the user may have to solve it there).'),
    },
  }, ({ account, url, reason, show_browser }) => guard(async () => {
    const grant = await ensureGrant(ctx, account, { kind: 'signin' }, 'browser_login', reason || '')
    const { items } = await openGrants(ctx.api, ctx.creds.privateJwk, [grant], 'browser_login', reason || '', randomUUID(), wait.ms)
    const item = items.get(grant.itemId)!
    const result = await browserLogin(item, { url, outDir: `${process.cwd()}/.otpilot`, show: show_browser ?? 'auto' })
    // A sign-in that didn't finish is logged as a try (it still used the password).
    await report(ctx, grant.itemId, result.status === 'signed_in' ? 'browser_login' : 'login_attempt', new URL(result.url).hostname)
    const secrets = [item.fields.map(f => f.value || ''), item.totp?.secret || '', result.sent || []].flat().filter(Boolean)
    const more = result.needs === '2fa' ? await reportMissing(ctx, grant, { kind: 'field', field: 'totp' }, 'browser_login', reason || '') : ''
    const body = result.status === 'signed_in'
      ? `Signed in to ${result.url} ("${result.title}").\nSession: ${result.storageState}\nLoad it with Playwright: browser.newContext({ storageState: '${result.storageState}' }). Keep the file out of git (.otpilot/).`
      : `Could not finish signing in at ${result.url}: ${result.note}${more}`
    return result.status === 'signed_in' ? text(redact(body, secrets)) : fail(redact(body, secrets))
  }))

  server.registerTool('run', {
    title: 'Run a command with secrets',
    description: 'Runs a shell command with secrets from allowed accounts in its environment, for that process only. env values are references "<account>/<field>" (username, password, totp = a fresh 2FA code, notes, or a custom field\'s label; "<account>/@file" or a file field\'s label = the path of a private temporary copy of that file, deleted when the command ends). Returns the exit code and the output with every secret removed. On the Free plan each call is one of 10 uses a month, however many accounts it uses.',
    inputSchema: {
      command: z.string().min(1).max(4000).describe('The command, e.g. psql -h db.example.com -c "select 1"'),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).describe('Environment variables to set, as references: { "PGPASSWORD": "Staging DB/password" }'),
      cwd: z.string().optional(),
      timeout_seconds: z.number().int().min(1).max(600).optional(),
      reason: z.string().max(500).optional().describe('Why, shown to the user if an account asks every time.'),
    },
  }, ({ command, env, cwd, timeout_seconds, reason }) => guard(async () => {
    // Account, scope, allowlist and reference shape are checked before opening (an account
    // not allowed, or not for that field, is asked for); a wrong custom field name is only
    // found after, and that call still counts as a use.
    const refs: { name: string; grant: Grant; field: string }[] = []
    let program: { path: string; rest: string } | undefined
    for (const [name, ref] of Object.entries(env)) {
      const cut = ref.lastIndexOf('/')
      if (cut <= 0) return fail(`env ${name}: write it as "<account>/<field>", e.g. "Staging DB/password".`)
      if (!ref.slice(cut + 1).trim()) return fail(`env ${name}: the field is empty. Write "<account>/<field>", e.g. "Staging DB/password".`)
      const grant = await ensureGrant(ctx, ref.slice(0, cut), { kind: 'field', field: ref.slice(cut + 1) }, 'run', reason || '')
      const limit = resolveAllowed(command, grant.commands, cwd)
      if (limit && 'error' in limit) return fail(`${grant.title}: ${limit.error}`)
      if (limit) program = limit
      refs.push({ name, grant, field: ref.slice(cut + 1) })
    }
    // Every account opened at once: one approval each, and one use for the command.
    const used = new Map(refs.map(r => [r.grant.itemId, r.grant]))
    const { items } = used.size
      ? await openGrants(ctx.api, ctx.creds.privateJwk, [...used.values()], 'run', reason || '', randomUUID(), wait.ms)
      : { items: new Map<string, VaultItem>() }
    const values: Record<string, string> = {}
    const secrets: string[] = []
    const files: { name: string; bytes: Uint8Array; env: string }[] = []
    for (const { name, grant, field } of refs) {
      const item = items.get(grant.itemId)!
      try {
        const file = fileField(item, field)
        if (file) {
          files.push({ name: file.name, bytes: file.bytes, env: name })
          secrets.push(...fileSecrets(file.bytes, Vault.fileText(file)))
        } else {
          values[name] = await fieldValue(item, field)
          secrets.push(values[name])
        }
      } catch (e) {
        if (e instanceof MissingField) return fail(`${e.message}${await reportMissing(ctx, grant, { kind: 'field', field }, 'run', reason || '')}`)
        throw e
      }
      secrets.push(...item.fields.map(f => f.value || ''), item.totp?.secret || '')
    }
    const temp = writeTempFiles(files)
    files.forEach((f, i) => { values[f.env] = temp.paths[i] })
    let r: Awaited<ReturnType<typeof runCommand>>
    try {
      r = await runCommand(command, values, { cwd, timeoutSec: timeout_seconds, secrets: secrets.filter(Boolean), program })
    } finally { temp.cleanup() }
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
