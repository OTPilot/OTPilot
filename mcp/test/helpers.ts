import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Api, ApiError } from '../src/api.js'
import { VaultCrypto, type VaultItem } from '../src/extension.js'

/** The extension's TeamKeys (keys.js), with a stand-in chrome.storage: wrapUserShare is pure. */
export function extensionTeamKeys(): { wrapUserShare(k: Uint8Array, pub: string): Promise<string> } {
  const src = readFileSync(join(__dirname, '..', '..', 'extension', 'keys.js'), 'utf8')
  const chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } }
  return new Function('chrome', `${src}\nreturn TeamKeys;`)(chrome)
}

export function loginItem(over: Partial<VaultItem> = {}): VaultItem {
  return {
    id: crypto.randomUUID(), type: 'login', title: 'Staging', urls: ['127.0.0.1'],
    fields: [{ id: 'username', label: 'Username', value: 'ops@acme.io' }, { id: 'password', label: 'Password', value: 'hunter2-secret' }],
    totp: { secret: 'JBSWY3DPEHPK3PXP' }, notes: '', ...over,
  }
}

/** A grant row as the API returns it, made the way the extension makes them (agents.js). */
export async function grantRow(item: VaultItem, agentPub: string, opts: { scope?: object; askEveryTime?: boolean; commands?: string[]; withheld?: boolean } = {}) {
  const sk = VaultCrypto.generateKey()
  const k = VaultCrypto.b64e(sk)
  return {
    item_id: item.id,
    scope: opts.scope ?? { kind: 'login' },
    expires_at: null,
    ask_every_time: !!opts.askEveryTime,
    commands: opts.commands ?? [],
    record: opts.withheld ? null : await VaultCrypto.encryptItem(item, k),
    label: await VaultCrypto.encryptItem({ id: item.id, type: item.type, title: item.title, urls: item.urls, fields: [], totp: null, notes: '' }, k),
    wrapped_key: await extensionTeamKeys().wrapUserShare(sk, agentPub),
  }
}

type Handler = (method: string, path: string, body: any) => { status?: number; body: unknown } | undefined

/**
 * POST /agent/grants/open as the API answers it from `rows` (the grants with
 * their copies; a withheld record = an "ask every time" grant not approved):
 * exactly the ids asked, all or nothing.
 */
export function openFrom(rows: { item_id: string; record: unknown }[], body: { item_ids: string[] }, usage: unknown = null) {
  const asked = rows.filter(r => body.item_ids.includes(r.item_id))
  const missing = body.item_ids.filter(id => !rows.some(r => r.item_id === id))
  if (missing.length) return { status: 404, body: { error: 'not allowed', code: 'not_granted', item_ids: missing } }
  const held = asked.filter(r => !r.record)
  if (held.length) return { status: 409, body: { error: 'needs approval', code: 'approval_needed', item_ids: held.map(r => r.item_id) } }
  return { body: { grants: asked, usage } }
}

/** An Api answered by `handler` (no network); `calls` records what was asked. */
export class FakeApi extends Api {
  calls: string[] = []
  constructor(private handler: Handler) { super('http://fake') }
  async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    this.calls.push(`${method} ${path}`)
    const r = this.handler(method, path, body)
    if (!r) throw new ApiError(404, { error: 'not found' })
    const status = r.status ?? 200
    if (status >= 400) throw new ApiError(status, r.body)
    return { status, body: r.body as T }
  }
}
