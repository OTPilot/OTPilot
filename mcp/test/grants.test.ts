import { beforeAll, describe, expect, it } from 'vitest'
import type { Api } from '../src/api.js'
import { generateKeyPair } from '../src/ecies.js'
import { loadGrants, openGrants, openRetry, PendingApproval, type Grant } from '../src/grants.js'
import { FakeApi, grantRow, loginItem, openFrom } from './helpers.js'

beforeAll(() => { openRetry.ms = 1 })

/** One account's values for one tool call (what browser_login does). */
const openItem = (api: Api, jwk: JsonWebKey, grant: Grant, tool: 'run' | 'browser_login', reason: string, waitMs: number) =>
  openGrants(api, jwk, [grant], tool, reason, undefined, waitMs).then(r => r.items.get(grant.itemId)!)

describe('ask every time', () => {
  it('an approval given after the wait timed out is used once by the retry, then asked again', async () => {
    const item = loginItem({ title: 'Bank' })
    const keys = await generateKeyPair()
    const held = await grantRow(item, keys.publicKey, { askEveryTime: true, withheld: true })
    const released = await grantRow(item, keys.publicKey, { askEveryTime: true })
    let asks = 0
    let status = 'pending'
    const api = new FakeApi((m, p, b) => {
      if (p === '/agent/grants') return { body: { grants: [status === 'allowed' ? released : held] } }
      if (p === '/agent/grants/open') return openFrom([status === 'allowed' ? released : held], b)
      if (m === 'POST' && p === '/agent/requests') { asks++; return { body: { id: `00000000-0000-4000-8000-00000000000${asks}` } } }
      if (p.startsWith('/agent/requests/')) return { body: { status, released: status === 'allowed' } }
      return undefined
    })
    const grant = (await loadGrants(api, keys.privateJwk))[0]
    await expect(openItem(api, keys.privateJwk, grant, 'run', '', 50)).rejects.toBeInstanceOf(PendingApproval)
    // Still waiting: the retry points at the same request, no new one.
    await expect(openItem(api, keys.privateJwk, grant, 'run', '', 50)).rejects.toBeInstanceOf(PendingApproval)
    expect(asks).toBe(1)
    status = 'allowed' // the user approves late
    const opened = await openItem(api, keys.privateJwk, grant, 'run', '', 50)
    expect(opened.title).toBe('Bank')
    expect(asks).toBe(1)
    // That approval is spent: the next use asks again.
    status = 'pending'
    await expect(openItem(api, keys.privateJwk, grant, 'run', '', 50)).rejects.toBeInstanceOf(PendingApproval)
    expect(asks).toBe(2)
  })
})

describe('ask every time, a late approval', () => {
  async function setup() {
    const item = loginItem({ title: 'Vault' })
    const keys = await generateKeyPair()
    const held = await grantRow(item, keys.publicKey, { askEveryTime: true, withheld: true })
    const released = await grantRow(item, keys.publicKey, { askEveryTime: true })
    const s = { asks: 0, status: 'pending', failGrants: false, onlyFirst: false, expired: false, gone: false, flaky: false }
    const FIRST = '00000000-0000-4000-8000-000000000011'
    const api = new FakeApi((m, p, b) => {
      if (p === '/agent/grants') return { body: { grants: [held] } }
      if (p === '/agent/grants/open') return s.failGrants ? { status: 500, body: { error: 'down' } } : openFrom([s.status === 'allowed' ? released : held], b)
      if (m === 'POST' && p === '/agent/requests') { s.asks++; return { body: { id: `00000000-0000-4000-8000-00000000001${s.asks}` } } }
      if (p.startsWith('/agent/requests/')) { const st = s.onlyFirst && !p.endsWith(FIRST) ? 'pending' : s.status; if (s.flaky && p.endsWith(FIRST)) return { status: 503, body: { error: 'unavailable' } }
        if (s.gone && p.endsWith(FIRST)) return { status: 404, body: { error: 'not found' } }
        return { body: { status: st, released: st === 'allowed' && !s.expired } } }
      return undefined
    })
    const grant = (await loadGrants(api, keys.privateJwk))[0]
    const open = (tool: 'run' | 'browser_login' = 'run', reason = 'deploy') => openItem(api, keys.privateJwk, grant, tool, reason, 50)
    await expect(open()).rejects.toBeInstanceOf(PendingApproval)
    return { s, open }
  }

  it('is spent by only one of two calls in parallel', async () => {
    const { s, open } = await setup()
    s.status = 'allowed'
    s.onlyFirst = true // a new request (the other call's) stays waiting
    const results = await Promise.allSettled([open(), open()])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(s.asks).toBe(2)
  })

  it('is not used for another tool or reason', async () => {
    const { s, open } = await setup()
    s.status = 'allowed'
    s.status = 'pending' // the new ask for browser_login waits
    await expect(open('browser_login', 'deploy')).rejects.toBeInstanceOf(PendingApproval)
    expect(s.asks).toBe(2)
  })

  it('is not used once its own window passed, even while another release is live', async () => {
    const { s, open } = await setup()
    s.status = 'allowed'
    s.expired = true // its two minutes are over; the grants list still shows a released copy
    s.onlyFirst = true // the new request stays waiting
    await expect(open()).rejects.toBeInstanceOf(PendingApproval)
    expect(s.asks).toBe(2)
  })

  it('a request the server forgot (404) is dropped; the new one is kept and finishes on retry', async () => {
    const { s, open } = await setup()
    s.gone = true // only the old request is gone
    await expect(open()).rejects.toBeInstanceOf(PendingApproval) // the replacement waits
    expect(s.asks).toBe(2)
    s.status = 'allowed' // the user approves the replacement
    expect((await open()).title).toBe('Vault')
    expect(s.asks).toBe(2)
  })

  it('a passing server error keeps the request waiting, not lost', async () => {
    const { s, open } = await setup()
    s.flaky = true
    await expect(open()).rejects.toBeInstanceOf(PendingApproval)
    expect(s.asks).toBe(1)
    s.flaky = false
    s.status = 'allowed'
    expect((await open()).title).toBe('Vault')
  })

  it('survives a failed fetch of the released copy', async () => {
    const { s, open } = await setup()
    s.status = 'allowed'
    s.failGrants = true
    await expect(open()).rejects.toThrow()
    s.failGrants = false
    expect((await open()).title).toBe('Vault')
    expect(s.asks).toBe(1)
  })
})

describe('ask every time, parallel retries', () => {
  it('two requests waiting at once are both kept: each finishes once its own approval comes', async () => {
    const item = loginItem({ title: 'Ops' })
    const keys = await generateKeyPair()
    const held = await grantRow(item, keys.publicKey, { askEveryTime: true, withheld: true })
    const released = await grantRow(item, keys.publicKey, { askEveryTime: true })
    let asks = 0
    const status: Record<string, string> = {}
    const api = new FakeApi((m, p, b) => {
      if (p === '/agent/grants') return { body: { grants: [held] } }
      if (p === '/agent/grants/open') return openFrom([Object.values(status).includes('allowed') ? released : held], b)
      if (m === 'POST' && p === '/agent/requests') { asks++; const id = `00000000-0000-4000-8000-00000000002${asks}`; status[id] = 'pending'; return { body: { id } } }
      if (p.startsWith('/agent/requests/')) { const st = status[p.split('/').pop()!]; return { body: { status: st, released: st === 'allowed' } } }
      return undefined
    })
    const grant = (await loadGrants(api, keys.privateJwk))[0]
    const open = () => openItem(api, keys.privateJwk, grant, 'run', 'x', 50)
    const first = await open().catch(e => e)
    const [a, b] = await Promise.all([open().catch(e => e), open().catch(e => e)])
    expect([first, a, b].every(e => e instanceof PendingApproval)).toBe(true)
    expect(asks).toBe(2) // the first request, and one more for the call that found it busy
    // The second request is approved: a retry finishes it.
    const second = Object.keys(status)[1]
    status[second] = 'allowed'
    expect((await open()).title).toBe('Ops')
    expect(asks).toBe(2)
  })
})

describe('opening copies', () => {
  async function setup(items = [loginItem({ title: 'Staging' }), loginItem({ title: 'Prod' })]) {
    const keys = await generateKeyPair()
    const rows = await Promise.all(items.map(i => grantRow(i, keys.publicKey)))
    const opens: any[] = []
    let answer: (b: any) => { status?: number; body: unknown } | undefined = b => openFrom(rows, b)
    const api = new FakeApi((m, p, b) => {
      if (p === '/agent/grants') return { body: { grants: rows, usage: null } }
      if (p === '/agent/grants/open') { opens.push(b); return answer(b) }
      return undefined
    })
    const grants = await loadGrants(api, keys.privateJwk)
    return { keys, rows, opens, api, grants, answer: (f: typeof answer) => { answer = f } }
  }

  it('listing never opens a copy: labels only, even when the server sends one', async () => {
    const keys = await generateKeyPair()
    const row = await grantRow(loginItem({ title: 'Staging' }), keys.publicKey)
    // A copy that can't be decrypted: listing doesn't touch it.
    row.record = { v: 1, key: { iv: 'AAAA', ct: 'AAAA' }, data: { iv: 'AAAA', ct: 'AAAA' } }
    const api = new FakeApi((m, p) => (p === '/agent/grants' ? { body: { grants: [row] } } : undefined))
    const [g] = await loadGrants(api, keys.privateJwk)
    expect(g.title).toBe('Staging')
    expect('item' in g).toBe(false)
    expect(api.calls).toEqual(['GET /agent/grants'])
  })

  it('opens every account of a call in one request, exactly those', async () => {
    const { keys, api, grants, opens } = await setup()
    const { items } = await openGrants(api, keys.privateJwk, [grants[1], grants[0], grants[1]], 'run', 'deploy', 'u-1')
    expect(opens).toEqual([{ use_id: 'u-1', tool: 'run', item_ids: [grants[1].itemId, grants[0].itemId] }])
    expect([...items.values()].map(i => i.title).sort()).toEqual(['Prod', 'Staging'])
  })

  it('retries a failed request with the same use_id', async () => {
    const { keys, api, grants, opens, rows, answer } = await setup()
    let n = 0
    answer(b => {
      n++
      if (n === 1) throw new TypeError('fetch failed') // the network
      if (n === 2) return { status: 503, body: { error: 'unavailable' } }
      return openFrom(rows, b)
    })
    const { items } = await openGrants(api, keys.privateJwk, [grants[0]], 'browser_login', '')
    expect(items.get(grants[0].itemId)?.title).toBe('Staging')
    expect(opens).toHaveLength(3)
    expect(new Set(opens.map(o => o.use_id)).size).toBe(1)
  })

  it('a refusal is not retried, and names the account', async () => {
    const { keys, api, grants, opens, answer } = await setup()
    answer(b => ({ status: 404, body: { error: 'not allowed', code: 'not_granted', item_ids: [b.item_ids[1]] } }))
    await expect(openGrants(api, keys.privateJwk, grants, 'run', '')).rejects.toThrow(/^"Prod" is no longer allowed/)
    answer(b => ({ status: 409, body: { error: 'x', code: 'approval_needed', item_ids: [b.item_ids[0]] } }))
    await expect(openGrants(api, keys.privateJwk, grants, 'run', '')).rejects.toThrow(/approval to use "Staging" expired before it was used\. Try again\./)
    // An API without the endpoint yet.
    answer(() => ({ status: 404, body: { error: 'not found' } }))
    await expect(openGrants(api, keys.privateJwk, grants, 'run', '')).rejects.toThrow(/doesn't support this version of the MCP yet/)
    answer(() => ({ status: 402, body: { error: 'used up', code: 'agent_uses_exhausted' } }))
    await expect(openGrants(api, keys.privateJwk, grants, 'run', '')).rejects.toMatchObject({ status: 402, code: 'agent_uses_exhausted' })
    expect(opens).toHaveLength(4)
  })

  it('several ask-every-time accounts: one approval each, then one request', async () => {
    const keys = await generateKeyPair()
    const items = [loginItem({ title: 'Bank' }), loginItem({ title: 'Broker' })]
    const held = await Promise.all(items.map(i => grantRow(i, keys.publicKey, { askEveryTime: true, withheld: true })))
    const released = await Promise.all(items.map(i => grantRow(i, keys.publicKey, { askEveryTime: true })))
    const asked: string[] = []
    const opens: any[] = []
    const api = new FakeApi((m, p, b) => {
      if (p === '/agent/grants') return { body: { grants: held } }
      if (m === 'POST' && p === '/agent/requests') { asked.push(b.item_id); return { body: { id: `00000000-0000-4000-8000-00000000003${asked.length}` } } }
      if (p.startsWith('/agent/requests/')) return { body: { status: 'allowed', released: true } }
      if (p === '/agent/grants/open') { opens.push(b); return openFrom(released, b) }
      return undefined
    })
    const grants = await loadGrants(api, keys.privateJwk)
    const r = await openGrants(api, keys.privateJwk, grants, 'run', 'pay', undefined, 50)
    expect(asked).toEqual(grants.map(g => g.itemId))
    expect(opens).toHaveLength(1)
    expect(r.items.size).toBe(2)
  })
})
