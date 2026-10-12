// What this agent may use: its grants, opened with its private key. A grant
// always comes with its label (title, sites); its copy (the values) only
// while it may be used — an "ask every time" grant waits for the user's
// one-time approval, asked for here.
import { Api, ApiError } from './api.js'
import { unwrap } from './ecies.js'
import { VaultCrypto, Vault, generateTOTP, type EncryptedRecord, type VaultItem } from './extension.js'

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
  item: VaultItem | null
}

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

export async function loadGrants(api: Api, privateJwk: JsonWebKey): Promise<Grant[]> {
  const { grants } = await api.get<{ grants: GrantRow[] }>('/agent/grants')
  const out: Grant[] = []
  for (const g of grants) {
    try {
      const sk = VaultCrypto.b64e(await unwrap(g.wrapped_key, privateJwk))
      const label = g.label ? await VaultCrypto.decryptItem(g.label, sk) : null
      const item = g.record ? await VaultCrypto.decryptItem(g.record, sk) : null
      out.push({
        itemId: g.item_id,
        title: item?.title || label?.title || 'Untitled',
        urls: item?.urls || label?.urls || [],
        type: item?.type || label?.type || 'login',
        scope: g.scope,
        expiresAt: g.expires_at,
        askEveryTime: g.ask_every_time,
        commands: g.commands || [],
        item,
      })
    } catch {
      // Not for this key (re-keyed elsewhere): skipped, the user sees it in the extension.
    }
  }
  return out
}

/** The grant `ref` names: its item id, its exact title, or the one title containing it. */
export function findGrant(grants: Grant[], ref: string): Grant {
  const q = ref.trim().toLowerCase()
  const exact = grants.filter(g => g.itemId === ref || g.title.toLowerCase() === q)
  const found = exact.length ? exact : grants.filter(g => g.title.toLowerCase().includes(q) || g.urls.some(u => u.toLowerCase().includes(q)))
  if (found.length === 1) return found[0]
  const names = grants.map(g => `"${g.title}"`).join(', ') || 'none'
  if (!found.length) throw new Error(`No allowed account matches "${ref}". Allowed: ${names}. To use another one, call request_access.`)
  throw new Error(`"${ref}" matches several accounts: ${found.map(g => `"${g.title}"`).join(', ')}. Use the exact name.`)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Polls a request until the user answers or `waitMs` passes. */
export async function waitForAnswer(api: Api, requestId: string, waitMs: number): Promise<'allowed' | 'denied' | 'pending'> {
  const until = Date.now() + waitMs
  for (;;) {
    const left = until - Date.now()
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
    await sleep(Math.min(2000, Math.max(0, until - Date.now())))
  }
}

/** The grant's values, asking the user for this one use when it asks every time. */
export async function openItem(api: Api, privateJwk: JsonWebKey, grant: Grant, tool: string, reason: string, waitMs: number): Promise<VaultItem> {
  if (grant.item) return grant.item
  let req: { id: string }
  try {
    req = await api.post<{ id: string }>('/agent/requests', { item_id: grant.itemId, tool, reason })
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`"${grant.title}" is no longer allowed.`)
    throw e
  }
  const answer = await waitForAnswer(api, req.id, waitMs)
  if (answer === 'denied') throw new Error(`The user denied using "${grant.title}" this time.`)
  if (answer === 'pending') throw new PendingApproval(req.id, `use "${grant.title}" this time`)
  const again = (await loadGrants(api, privateJwk)).find(g => g.itemId === grant.itemId)
  if (!again?.item) throw new Error(`"${grant.title}" was approved but its approval expired. Try again.`)
  return again.item
}

/** One value of an item: username, password, totp (a fresh code), notes, or a custom field by label. */
export async function fieldValue(item: VaultItem, field: string): Promise<string> {
  const f = field.trim().toLowerCase()
  if (f === 'totp' || f === 'code' || f === '2fa' || f === 'otp') {
    if (!item.totp?.secret) throw new Error(`"${item.title}" has no 2FA code available to this agent.`)
    return generateTOTP(item.totp.secret, item.totp.period || 30, item.totp.digits || 6)
  }
  if (f === 'notes') {
    if (!item.notes) throw new Error(`"${item.title}" has no notes available to this agent.`)
    return item.notes
  }
  const byId = item.fields.find(x => x.id.toLowerCase() === f)
  const byLabel = item.fields.find(x => (x.label || '').toLowerCase() === f)
  const hit = byId || byLabel
  const value = hit?.value ?? (f === 'username' || f === 'password' ? Vault.getValue(item, f) : '')
  if (!value) {
    const available = [...item.fields.filter(x => x.value).map(x => x.label || x.id), ...(item.totp?.secret ? ['totp'] : [])]
    throw new Error(`"${item.title}" has no "${field}" available to this agent. Available: ${available.join(', ') || 'nothing'}.`)
  }
  return value
}
