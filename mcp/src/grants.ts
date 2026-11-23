// What this agent may use: its grants, opened with its private key. Listing
// them gives labels only (title, sites, what each allows); the values come
// from POST /agent/grants/open, once per tool call (browser_login, run) — on
// the Free plan that call is one of the month's uses. An "ask every time"
// grant first waits for the user's one-time approval, asked for here.
import { randomUUID } from 'node:crypto'
import { Api, ApiError } from './api.js'
import { unwrap } from './ecies.js'
import { VaultCrypto, Vault, generateTOTP, type EncryptedRecord, type VaultFile, type VaultItem } from './extension.js'

export type Scope = { kind: '2fa' | 'login' | 'fields'; parts?: string[] }
export type Grant = {
  itemId: string
  title: string
  urls: string[]
  type: string
  scope: Scope
  expiresAt: string | null
  askEveryTime: boolean
  commands: string[]
}

/** The Free plan's agent uses this month (null on a paid plan); `notice` is the server's line for the user. */
export type Usage = { used: number; limit: number; resets_at: string; notice: string }

type GrantRow = {
  item_id: string
  scope: Scope
  expires_at: string | null
  ask_every_time: boolean
  commands: string[]
  record: EncryptedRecord | null
  label: EncryptedRecord | null
  wrapped_key: string
}

/** Thrown while the user hasn't answered: the agent tells them to. */
export class PendingApproval extends Error {
  constructor(public requestId: string, what: string) {
    super(`Waiting for approval: ${what}. Ask the user to open the OTPilot extension (Agents) and approve it, then try again.`)
  }
}

/** The grants (labels only: a listed copy is never opened) and the Free plan's uses. */
export async function listGrants(api: Api, privateJwk: JsonWebKey): Promise<{ grants: Grant[]; usage: Usage | null }> {
  const { grants, usage } = await api.get<{ grants: GrantRow[]; usage?: Usage | null }>('/agent/grants')
  const out: Grant[] = []
  for (const g of grants) {
    try {
      const sk = VaultCrypto.b64e(await unwrap(g.wrapped_key, privateJwk))
      const label = g.label ? await VaultCrypto.decryptItem(g.label, sk) : null
      out.push({
        itemId: g.item_id,
        title: label?.title || 'Untitled',
        urls: label?.urls || [],
        type: label?.type || 'login',
        scope: g.scope,
        expiresAt: g.expires_at,
        askEveryTime: g.ask_every_time,
        commands: g.commands || [],
      })
    } catch {
      // Not for this key (re-keyed elsewhere): skipped, the user sees it in the extension.
    }
  }
  return { grants: out, usage: usage ?? null }
}

export async function loadGrants(api: Api, privateJwk: JsonWebKey): Promise<Grant[]> {
  return (await listGrants(api, privateJwk)).grants
}

/**
 * A crypto wallet's recovery phrase, passphrase and private keys move funds:
 * the extension never puts them in an agent's copy, and one that still
 * carries them (an older extension) has them dropped here.
 */
export function withoutWalletSecrets(item: VaultItem): VaultItem {
  return { ...item, fields: (item.fields || []).filter(f => !Vault.isWalletSecret(item, f)) }
}

const WALLET_SECRET_NAMES = ['seed', 'passphrase', 'privatekey', 'private key', 'recovery phrase', 'seed phrase', 'mnemonic']

/** The grant `ref` names (its item id, its exact title, or the one title containing it), or null when none does. */
export function matchGrant(grants: Grant[], ref: string): Grant | null {
  const q = ref.trim().toLowerCase()
  const exact = grants.filter(g => g.itemId === ref || g.title.toLowerCase() === q)
  const found = exact.length ? exact : grants.filter(g => g.title.toLowerCase().includes(q) || g.urls.some(u => u.toLowerCase().includes(q)))
  if (found.length > 1) throw new Error(`"${ref}" matches several accounts: ${found.map(g => `"${g.title}"`).join(', ')}. Use the exact name.`)
  return found[0] ?? null
}

/** The grant `ref` names: its item id, its exact title, or the one title containing it. */
export function findGrant(grants: Grant[], ref: string): Grant {
  const found = matchGrant(grants, ref)
  if (found) return found
  const names = grants.map(g => `"${g.title}"`).join(', ') || 'none'
  throw new Error(`No allowed account matches "${ref}". Allowed: ${names}. To use another one, call request_access.`)
}

/** What a tool needs of an account: signing in, or one field of a `run` reference. */
export type Need = { kind: 'signin' } | { kind: 'field'; field: string }

const TOTP_NAMES = ['totp', 'code', '2fa', 'otp']

/**
 * Whether a grant's scope gives what's needed, as far as its labels tell:
 * a custom field's label can only be checked once the copy is open.
 */
export function allows(grant: Grant, need: Need): boolean {
  const { kind, parts = [] } = grant.scope
  if (need.kind === 'signin') return kind === 'login' || (kind === 'fields' && parts.includes('urls') && parts.includes('f:password'))
  const f = need.field.trim().toLowerCase()
  if (TOTP_NAMES.includes(f)) return kind !== 'fields' || parts.includes('totp')
  // A field part other than the username and password: a custom field (or a
  // type's own field, a file) whose label is only known once the copy is open,
  // and may well be "Password".
  const custom = kind === 'fields' && parts.some(p => p.startsWith('f:') && p !== 'f:username' && p !== 'f:password')
  if (f === 'username' || f === 'password') return kind === 'login' || (kind === 'fields' && parts.includes(`f:${f}`)) || custom
  if (f === 'notes') return kind === 'fields' && parts.includes('notes')
  // A sign-in or a 2FA code never carries custom fields or files.
  return custom
}

/** What a need is, for the user: "its sign-in", "its 2FA code", "its "API key"". */
export function needText(need: Need): string {
  if (need.kind === 'signin') return 'its sign-in (username and password)'
  const f = need.field.trim().toLowerCase()
  if (TOTP_NAMES.includes(f)) return 'its 2FA code'
  if (f === 'username' || f === 'password' || f === 'notes') return `its ${f}`
  return `its "${need.field.trim()}"`
}

/** What a grant gives now, for the user. */
export function scopeText(grant: Grant): string {
  const { kind, parts = [] } = grant.scope
  if (kind === '2fa') return 'its 2FA code'
  if (kind === 'login') return 'its sign-in'
  const names: Record<string, string> = { totp: '2FA code', urls: 'sites', notes: 'notes', 'f:username': 'username', 'f:password': 'password' }
  return `some fields (${parts.map(p => names[p] || 'a field').join(', ') || 'none'})`
}

/** A field the account's copy doesn't hold (found once open). */
export class MissingField extends Error {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Polls a request until the user answers or `waitMs` passes. */
export async function waitForAnswer(api: Api, requestId: string, waitMs: number): Promise<'allowed' | 'denied' | 'pending'> {
  const until = Date.now() + waitMs
  // Always asked at least once (a retry checks an earlier request with no wait).
  for (let first = true; ; first = false) {
    const left = Math.max(until - Date.now(), first ? 5_000 : 0)
    if (left <= 0) return 'pending'
    // Each check gives up with the deadline, so a stalled reply can't hold the tool past it.
    // A timeout, a network blip or a server error (5xx, 429) is retried
    // within the deadline; a definite answer (revoked agent, unknown
    // request) goes up to the tool.
    const r = await api.get<{ status: 'pending' | 'allowed' | 'denied' }>(`/agent/requests/${requestId}`, Math.min(left, 15_000))
      .catch(e => {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e
        return { status: 'pending' as const }
      })
    if (r.status !== 'pending') return r.status
    if (Date.now() >= until) return 'pending'
    await sleep(Math.min(2000, Math.max(0, until - Date.now())))
  }
}

/** Requests that timed out waiting (item id → request id): a retry finishes that one instead of asking again. */
type Waiting = { id: string; tool: string; reason: string; busy: boolean }
const waiting = new Map<string, Waiting[]>()
const forget = (itemId: string, w: Waiting) => {
  const left = (waiting.get(itemId) || []).filter(x => x !== w)
  if (left.length) waiting.set(itemId, left)
  else waiting.delete(itemId)
}

/** One "ask every time" account of a call: its request, claimed (busy) by the call; `ready` once allowed. */
type Claim = { grant: Grant; w: Waiting; ready: boolean }

/**
 * How many requests one agent may have waiting for the user at once: the
 * server answers 429 beyond it (`MAX_PENDING_REQUESTS` in
 * api/src/routes/agents.rs). Keep both equal.
 */
export const MAX_PENDING_REQUESTS = 10
/**
 * How many accounts one POST /agent/grants/open may carry: the server rejects
 * more (`item_ids` 1..20 in `open_grants`, api/src/routes/agents.rs). Keep both equal.
 */
export const MAX_OPEN_ITEMS = 20
/** How long a request waits for the user's answer (`REQUEST_MINUTES` in api/src/routes/agents.rs). */
const REQUEST_MINUTES = 10

/** Delay between two checks of the requests a call waits for (tests shorten it). */
export const pollEvery = { ms: 2000 }

/** A definite refusal (revoked agent, unknown request) rather than a passing failure (network, 429, 5xx). */
const definite = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429

/**
 * An earlier request for this use of `grant` (same tool and reason, the
 * purpose the user saw), claimed: one whose approval still releases the copy
 * (ready), else one still waiting (polled with the call's new ones), else
 * null. Claimed before any wait, so two calls in parallel can't both spend
 * one; one in use by another call (busy) is left to it.
 */
async function reuse(api: Api, grant: Grant, tool: string, reason: string): Promise<Claim | null> {
  let pending: Waiting | null = null
  for (const earlier of [...(waiting.get(grant.itemId) || [])]) {
    if (earlier.busy || earlier.tool !== tool || earlier.reason !== reason) continue
    earlier.busy = true
    let r: { status: 'pending' | 'allowed' | 'denied'; released?: boolean }
    try {
      r = await api.get(`/agent/requests/${earlier.id}`, 15_000)
    } catch (e) {
      // Gone (answered requests are forgotten after a day): ask anew.
      if (e instanceof ApiError && e.status === 404) { forget(grant.itemId, earlier); continue }
      if (definite(e)) { earlier.busy = false; if (pending) pending.busy = false; throw e }
      // A passing failure: still waiting, as the wait treats one.
      r = { status: 'pending' }
    }
    if (r.status === 'pending') {
      if (pending) earlier.busy = false
      else pending = earlier
      continue
    }
    // Only this request's own approval, still in its window: another
    // request's release must never stand in for an expired one.
    if (r.status === 'allowed' && r.released) {
      if (pending) pending.busy = false
      return { grant, w: earlier, ready: true }
    }
    forget(grant.itemId, earlier) // denied, or its approval expired
  }
  return pending && { grant, w: pending, ready: false }
}

/** A new request for one use of `grant`, kept (claimed) at once: a retry finds it. */
async function ask(api: Api, grant: Grant, tool: string, reason: string): Promise<Claim> {
  let req: { id: string }
  try {
    req = await api.post<{ id: string }>('/agent/requests', { item_id: grant.itemId, tool, reason })
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`"${grant.title}" is no longer allowed.`)
    // The agent's waiting requests are at the server's cap (this call's own
    // ones so far stay, released, for a retry to reuse).
    if (e instanceof ApiError && e.status === 429) {
      throw new Error(`Too many approval requests from this agent are already waiting for the user (at most ${MAX_PENDING_REQUESTS} at a time). Ask the user to answer them in the OTPilot extension (Agents), or wait ${REQUEST_MINUTES} minutes for them to expire, then try again.`)
    }
    throw e
  }
  const w: Waiting = { id: req.id, tool, reason, busy: true }
  waiting.set(grant.itemId, [...(waiting.get(grant.itemId) || []), w])
  return { grant, w, ready: false }
}

/**
 * Polls every claim not yet ready, together, until all are allowed or
 * `waitMs` passes (PendingApproval). A denial ends the call at once; the
 * other requests stay for a retry.
 */
async function waitAll(api: Api, claims: Claim[], waitMs: number): Promise<void> {
  const until = Date.now() + waitMs
  // Each one is asked at least once (a retry checks an earlier request even with no wait left).
  for (let first = true; ; first = false) {
    const open = claims.filter(c => !c.ready)
    if (!open.length) return
    const left = Math.max(until - Date.now(), first ? 5_000 : 0)
    if (left <= 0) {
      const what = open.map(c => `"${c.grant.title}"`).join(', ')
      throw new PendingApproval(open[0].w.id, `use ${what} this time`)
    }
    // Each check gives up with the deadline, so a stalled reply can't hold the tool past it.
    const answers = await Promise.all(open.map(c =>
      api.get<{ status: 'pending' | 'allowed' | 'denied' }>(`/agent/requests/${c.w.id}`, Math.min(left, 15_000))
        .catch(e => { if (definite(e)) throw e; return { status: 'pending' as const } })))
    open.forEach((c, i) => { if (answers[i].status === 'allowed') c.ready = true })
    const denied = open.find((c, i) => answers[i].status === 'denied')
    if (denied) {
      forget(denied.grant.itemId, denied.w)
      throw new Error(`The user denied using "${denied.grant.title}" this time.`)
    }
    if (open.every(c => c.ready)) return
    await sleep(Math.min(pollEvery.ms, Math.max(0, until - Date.now())))
  }
}

type OpenResult = { grants: GrantRow[]; usage?: Usage | null }

/** Delay before retrying a failed POST /agent/grants/open (tests shorten it). */
export const openRetry = { ms: 500 }

/** POST /agent/grants/open; a network or server failure is retried with the same use_id (never counted twice). */
async function postOpen(api: Api, body: { use_id: string; tool: string; item_ids: string[] }): Promise<OpenResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.post<OpenResult>('/agent/grants/open', body)
    } catch (e) {
      const passing = !(e instanceof ApiError) || e.status >= 500 || e.status === 429
      if (!passing || attempt >= 2) throw e
      await sleep(openRetry.ms * (attempt + 1))
    }
  }
}

/**
 * The values of the accounts one tool call uses (`tool`: browser_login or
 * run), by item id: the approvals of "ask every time" ones first — every
 * request made at once, then waited for together —, then one POST
 * /agent/grants/open for all of them: on the Free plan, one use. When an
 * approval ran out before the open (409), only those accounts are asked
 * again, once, and the open retried with the same use_id (a 409 counts
 * nothing). More "ask every time" accounts waiting than the server allows
 * (MAX_PENDING_REQUESTS) fail before any request. A 402 (no uses left) or 426 (out of date) goes up as an
 * ApiError with the server's message.
 */
export async function openGrants(
  api: Api, privateJwk: JsonWebKey, grants: Grant[], tool: 'browser_login' | 'run', reason: string,
  useId: string = randomUUID(), waitMs = 90_000,
): Promise<{ items: Map<string, VaultItem>; usage: Usage | null }> {
  const unique = [...new Map(grants.map(g => [g.itemId, g])).values()]
  // Before any approval is asked for: the server would refuse the open after the user answered.
  if (unique.length > MAX_OPEN_ITEMS) {
    throw new Error(`This command uses ${unique.length} accounts; one call can use at most ${MAX_OPEN_ITEMS}. Split it into smaller commands.`)
  }
  // Approvals are spent only by a successful open; on any failure they're kept for a retry.
  let claims: Claim[] = []
  const keep = () => { for (const c of claims) c.w.busy = false }
  const spend = () => { for (const c of claims) forget(c.grant.itemId, c.w) }
  const approveAll = async (gs: Grant[]) => {
    try {
      // Every request first, then one wait for all: an approval given early
      // isn't left to run out while the next account is asked. Earlier
      // requests are claimed first, so only the accounts left need a new one.
      const toAsk: Grant[] = []
      for (const g of gs) {
        const c = await reuse(api, g, tool, reason)
        if (c) claims.push(c)
        else toAsk.push(g)
      }
      // More than the server lets wait at once: refused before asking anyone
      // (no request, no open, nothing counted) rather than by a 429 halfway.
      const needed = claims.filter(c => !c.ready).length + toAsk.length
      if (needed > MAX_PENDING_REQUESTS) {
        throw new Error(`This command needs approval for ${needed} "ask every time" accounts; the most one call can ask for is ${MAX_PENDING_REQUESTS}. Split it into smaller commands, or turn off "ask every time" for some of them in the OTPilot extension (Agents).`)
      }
      for (const g of toAsk) claims.push(await ask(api, g, tool, reason))
      await waitAll(api, claims, waitMs)
    } catch (e) { keep(); throw e }
  }
  await approveAll(unique.filter(g => g.askEveryTime))
  const titles = (gs: Grant[]) => gs.map(g => `"${g.title}"`).join(', ')
  const named = (e: ApiError) => {
    const ids = (e.body as { item_ids?: unknown })?.item_ids
    return unique.filter(g => Array.isArray(ids) && ids.includes(g.itemId))
  }
  let res: OpenResult | undefined
  for (let asked = false; !res;) {
    try {
      res = await postOpen(api, { use_id: useId, tool, item_ids: unique.map(g => g.itemId) })
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Those approvals ran out: gone. The others still release their copies: kept.
        const held = named(e)
        for (const c of claims) if (held.includes(c.grant)) forget(c.grant.itemId, c.w)
        claims = claims.filter(c => !held.includes(c.grant))
        if (!asked && held.length) {
          asked = true
          await approveAll(held)
          continue
        }
        keep()
        throw new Error(`The user's approval to use ${titles(held) || 'this account'} expired before it was used. Try again.`)
      }
      keep()
      if (e instanceof ApiError && e.status === 404) {
        if (e.code === 'not_granted') {
          throw new Error(`${titles(named(e)) || 'This account'} is no longer allowed. Call list_accounts, or request_access to ask the user again.`)
        }
        throw new Error('The OTPilot server doesn\'t support this version of the MCP yet. Try again in a few minutes.')
      }
      throw e
    }
  }
  spend()
  const items = new Map<string, VaultItem>()
  for (const row of res.grants) {
    const grant = unique.find(g => g.itemId === row.item_id)
    if (!grant) continue
    try {
      if (!row.record) throw new Error('no copy')
      const sk = VaultCrypto.b64e(await unwrap(row.wrapped_key, privateJwk))
      items.set(row.item_id, withoutWalletSecrets(await VaultCrypto.decryptItem(row.record, sk)))
    } catch {
      throw new Error(`"${grant.title}" can't be opened by this agent. Ask the user to allow it again in the OTPilot extension (Agents).`)
    }
  }
  for (const g of unique) if (!items.has(g.itemId)) throw new Error(`"${g.title}" can't be opened by this agent. Ask the user to allow it again in the OTPilot extension (Agents).`)
  return { items, usage: res.usage ?? null }
}

/**
 * The file a reference names, when it names a file field (an SSH key, a .p8, a
 * key file): by its id or label, or "@file" / "file" for the item's first one.
 * Null for any other field.
 */
export function fileField(item: VaultItem, field: string): VaultFile | null {
  const f = field.trim().toLowerCase()
  const files = item.fields.filter(x => x.kind === 'file')
  const hit = f === '@file' || f === 'file'
    ? files.find(x => x.value)
    : files.find(x => x.id.toLowerCase() === f) || files.find(x => (x.label || '').toLowerCase() === f)
  if (!hit) {
    if (f === '@file') throw new MissingField(`"${item.title}" has no file available to this agent.`)
    return null
  }
  const file = Vault.fileOf(hit.value)
  if (!file) throw new Error(`"${item.title}" has no file in "${hit.label || hit.id}".`)
  return file
}

/** One value of an item: username, password, totp (a fresh code), notes, or a custom field by label. */
export async function fieldValue(item: VaultItem, field: string): Promise<string> {
  const f = field.trim().toLowerCase()
  if (item.type === 'wallet' && WALLET_SECRET_NAMES.includes(f)) {
    throw new Error(`A crypto wallet's recovery phrase, passphrase and private keys are never available to agents.`)
  }
  if (TOTP_NAMES.includes(f)) {
    if (!item.totp?.secret) throw new MissingField(`"${item.title}" has no 2FA code available to this agent.`)
    return generateTOTP(item.totp.secret, item.totp.period || 30, item.totp.digits || 6)
  }
  if (f === 'notes') {
    if (!item.notes) throw new MissingField(`"${item.title}" has no notes available to this agent.`)
    return item.notes
  }
  const byId = item.fields.find(x => x.id.toLowerCase() === f)
  const byLabel = item.fields.find(x => (x.label || '').toLowerCase() === f)
  const hit = byId || byLabel
  const value = hit?.value ?? (f === 'username' || f === 'password' ? Vault.getValue(item, f) : '')
  if (!value) {
    const available = [...item.fields.filter(x => x.value).map(x => x.label || x.id), ...(item.totp?.secret ? ['totp'] : [])]
    throw new MissingField(`"${item.title}" has no "${field}" available to this agent. Available: ${available.join(', ') || 'nothing'}.`)
  }
  return value
}
