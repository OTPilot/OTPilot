// Sharing from the web against a fake API: the share key ends up in the
// item (a newer version is retried on, shares made meanwhile are kept), and
// a share whose key can't be stored is taken back.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './__fixtures__/vault-crypto.json'
import { shareItem, type StoredItem, type VaultItem } from './teamVault'
import { b64e, decryptItem, encryptItem, generateKey, type ItemRecord } from './vaultCrypto'

type Req = { method: string; path: string; body: Record<string, unknown> | null }
const server = vi.hoisted(() => ({ handle: null as null | ((r: { method: string; path: string; body: Record<string, unknown> | null }) => Promise<[number, unknown]>), calls: [] as string[] }))

vi.mock('./api', () => ({
  apiFetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method || 'GET'
    server.calls.push(`${method} ${path.split('?')[0]}`)
    const [status, body] = await server.handle!({ method, path, body: init.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify(body), { status })
  },
}))


const VK = fixture.vaultKey
const unlocked = async () => ({
  vaultKey: VK,
  privateKey: await crypto.subtle.importKey('jwk', fixture.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']),
  publicKey: fixture.publicKey,
})
const bob = { user_id: 'bob', email: 'bob@x.io', public_key: fixture.publicKey }
const base = { id: 'item-1', type: 'login', title: 'GitHub', updatedAt: '2026-10-01T00:00:00Z' }

let shares: Map<string, { id: string; item_id: string; whole: boolean; grants: unknown[] }>
let vault: { record: ItemRecord; revision: number }
let onPut: (r: Req) => Promise<[number, unknown] | null>

beforeEach(async () => {
  server.calls = []
  shares = new Map()
  vault = { record: await encryptItem(base, VK), revision: 1 }
  onPut = async () => null
  server.handle = async (r) => {
    if (r.path === '/shares/mine') return [200, { shares: [...shares.values()].map((s) => ({ ...s, revision: 1 })) }]
    if (r.path === '/shares' && r.method === 'POST') {
      const b = r.body as { id: string; item_id: string; whole: boolean; grants: unknown[] }
      shares.set(b.id, { id: b.id, item_id: b.item_id, whole: b.whole, grants: b.grants })
      return [200, { id: b.id, revision: 1 }]
    }
    if (r.path.startsWith('/shares/') && r.method === 'DELETE') { shares.delete(r.path.split('/')[2]); return [200, { ok: true }] }
    if (r.path === '/vault/items/item-1' && r.method === 'PUT') {
      const custom = await onPut(r)
      if (custom) return custom
      if (r.body!.base_revision !== vault.revision) return [409, { item: { id: 'item-1', record: vault.record, revision: vault.revision } }]
      vault = { record: r.body!.record as ItemRecord, revision: vault.revision + 1 }
      return [200, { revision: vault.revision }]
    }
    return [404, { error: `unhandled ${r.method} ${r.path}` }]
  }
})

const stored = async (): Promise<StoredItem> => ({ item: await decryptItem<VaultItem>(vault.record, VK), revision: vault.revision })

describe('shareItem', () => {
  it('stores the new share key in the item, keeping its updatedAt', async () => {
    await shareItem(await unlocked(), await stored(), [{ user: bob }], 'view')
    const item = await decryptItem<VaultItem>(vault.record, VK)
    expect(item.shares).toHaveLength(1)
    expect(shares.has(item.shares![0].id)).toBe(true)
    expect(item.shares![0].whole).toBe(true)
    expect(item.updatedAt).toBe(base.updatedAt)
  })

  it('retries on a newer version and keeps a share another tab attached meanwhile', async () => {
    const first = await stored()
    // Another tab shares it and stores its key first.
    const other = { id: 'other-share', sk: b64e(generateKey()), whole: false, parts: ['urls'] }
    shares.set(other.id, { id: other.id, item_id: 'item-1', whole: false, grants: [] })
    vault = { record: await encryptItem({ ...base, title: 'GitHub (work)', shares: [other] }, VK), revision: 2 }
    await shareItem(await unlocked(), first, [{ user: bob }], 'edit')
    const item = await decryptItem<VaultItem>(vault.record, VK)
    expect(item.title).toBe('GitHub (work)')
    expect(item.shares!.map((s) => s.id)).toContain('other-share')
    expect(item.shares).toHaveLength(2)
  })

  it('creates no share when its key can\'t be stored in the item', async () => {
    onPut = async () => [500, { error: 'boom' }]
    await expect(shareItem(await unlocked(), await stored(), [{ user: bob }], 'view')).rejects.toThrow()
    expect(shares.size).toBe(0)
    expect(server.calls.some((c) => c === 'POST /shares')).toBe(false)
  })

  it('removes the key from the item again when creating the share fails', async () => {
    const handle = server.handle!
    server.handle = async (r) => (r.path === '/shares' && r.method === 'POST' ? [500, { error: 'boom' }] : handle(r))
    await expect(shareItem(await unlocked(), await stored(), [{ user: bob }], 'view')).rejects.toThrow()
    expect((await decryptItem<VaultItem>(vault.record, VK)).shares ?? []).toEqual([])
  })

  it('puts the key back when a sync dropped it between the two writes', async () => {
    const handle = server.handle!
    server.handle = async (r) => {
      const out = await handle(r)
      if (r.path === '/shares' && r.method === 'POST') {
        // The extension synced meanwhile and dropped the then-unknown share.
        const { shares: _gone, ...rest } = await decryptItem<VaultItem>(vault.record, VK)
        void _gone
        vault = { record: await encryptItem(rest, VK), revision: vault.revision + 1 }
      }
      return out
    }
    await shareItem(await unlocked(), await stored(), [{ user: bob }], 'view')
    const item = await decryptItem<VaultItem>(vault.record, VK)
    expect(item.shares?.map((x) => x.id)).toEqual([...shares.keys()])
  })

  it('takes the share back when the key can\'t be put back', async () => {
    const handle = server.handle!
    let puts = 0
    onPut = async () => (++puts > 1 ? [500, { error: 'boom' }] : null)
    server.handle = async (r) => {
      const out = await handle(r)
      if (r.path === '/shares' && r.method === 'POST') {
        const { shares: _gone, ...rest } = await decryptItem<VaultItem>(vault.record, VK)
        void _gone
        vault = { record: await encryptItem(rest, VK), revision: vault.revision + 1 }
      }
      return out
    }
    await expect(shareItem(await unlocked(), await stored(), [{ user: bob }], 'view')).rejects.toThrow()
    expect(shares.size).toBe(0)
  })

  it('adds grants to the whole share the item already has', async () => {
    await shareItem(await unlocked(), await stored(), [{ user: bob }], 'view')
    server.calls = []
    server.handle = ((h) => async (r: Req) => (r.method === 'PUT' && r.path.endsWith('/grants') ? [200, { ok: true }] : h!(r)))(server.handle) as typeof server.handle
    await shareItem(await unlocked(), await stored(), [{ user: { ...bob, user_id: 'carol' } }], 'view')
    expect(server.calls.filter((c) => c.startsWith('POST /shares'))).toEqual([])
    expect(server.calls.some((c) => /^PUT \/shares\/.+\/grants$/.test(c))).toBe(true)
  })
})
