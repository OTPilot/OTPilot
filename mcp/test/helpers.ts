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
