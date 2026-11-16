import { beforeAll, describe, expect, it } from 'vitest'
import type { Api } from '../src/api.js'
import { generateKeyPair } from '../src/ecies.js'
import { loadGrants, MAX_OPEN_ITEMS, MAX_PENDING_REQUESTS, openGrants, openRetry, PendingApproval, pollEvery, type Grant } from '../src/grants.js'
import { FakeApi, grantRow, loginItem, openFrom } from './helpers.js'

beforeAll(() => { openRetry.ms = 1; pollEvery.ms = 1 })

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
    // An API without the endpoint yet.
    answer(() => ({ status: 404, body: { error: 'not found' } }))
    await expect(openGrants(api, keys.privateJwk, grants, 'run', '')).rejects.toThrow(/doesn't support this version of the MCP yet/)
    answer(() => ({ status: 402, body: { error: 'used up', code: 'agent_uses_exhausted' } }))
    await expect(openGrants(api, keys.privateJwk, grants, 'run', '')).rejects.toMatchObject({ status: 402, code: 'agent_uses_exhausted' })
    expect(opens).toHaveLength(3)
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

describe('ask every time, several accounts in one call', () => {
  /**
   * A server for three "ask every time" accounts: requests with their own
   * approval windows, and POST /agent/grants/open as the API answers it (409
   * before any use token; a use_id counted once).
   */
  async function setup(count = 3, onlyFirstAsks = false) {
    const keys = await generateKeyPair()
    const titles = ['Bank', 'Broker', 'Payroll']
    const items = Array.from({ length: count }, (_, i) => loginItem({ title: titles[i] ?? `Account ${i + 1}` }))
    const rows = await Promise.all(items.map(i => grantRow(i, keys.publicKey, { askEveryTime: !onlyFirstAsks || i === items[0] })))
    const s = {
      requests: new Map<string, { item: string; status: string; released: boolean; checks: number }>(),
      asked: [] as string[],
      opens: [] as any[],
      tokens: new Set<string>(),
      uses: 0,
      /** Checks after which each item's request is answered (the user approves at different times). */
      answerAfter: {} as Record<string, number>,
      /** Called on each open, before it's answered (an approval running out). */
      beforeOpen: (_n: number) => {},
      /** Called on each POST /agent/requests (n from 1); a status answers it instead (the server's 429). */
      onAsk: (_n: number): number | void => {},
    }
    const api = new FakeApi((m, p, b) => {
      if (p === '/agent/grants') return { body: { grants: rows.map(r => ({ ...r, record: null })) } }
      if (m === 'POST' && p === '/agent/requests') {
        const refused = s.onAsk(s.asked.length + 1)
        if (refused) return { status: refused, body: { error: 'Too many requests' } }
        s.asked.push(b.item_id)
        const id = `00000000-0000-4000-8000-${String(s.asked.length).padStart(12, '0')}`
        s.requests.set(id, { item: b.item_id, status: 'pending', released: false, checks: 0 })
        return { body: { id } }
      }
      if (p.startsWith('/agent/requests/')) {
        const r = s.requests.get(p.split('/').pop()!)!
        r.checks++
        if (r.status === 'pending' && r.checks >= (s.answerAfter[r.item] ?? 1)) { r.status = 'allowed'; r.released = true }
        return { body: { status: r.status, released: r.released } }
      }
      if (p === '/agent/grants/open') {
        s.opens.push(b)
        s.beforeOpen(s.opens.length)
        const held = b.item_ids.filter((id: string) => rows.find(r => r.item_id === id)?.ask_every_time && ![...s.requests.values()].some(r => r.item === id && r.released))
        if (held.length) return { status: 409, body: { error: 'needs approval', code: 'approval_needed', item_ids: held } }
        if (!s.tokens.has(b.use_id)) { s.tokens.add(b.use_id); s.uses++ }
        return { body: { grants: rows.filter(r => b.item_ids.includes(r.item_id)), usage: null } }
      }
      return undefined
    })
    const grants = await loadGrants(api, keys.privateJwk)
    const expire = (item: string) => { for (const r of s.requests.values()) if (r.item === item) r.released = false }
    return { keys, api, grants, s, expire }
  }

  it('asks for every account at once, waits for all together, then opens once', async () => {
    const { keys, api, grants, s } = await setup()
    s.answerAfter = { [grants[0].itemId]: 1, [grants[1].itemId]: 3, [grants[2].itemId]: 5 }
    api.calls.length = 0
    const r = await openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-1', 5_000)
    // The three requests before any check of one.
    expect(api.calls.slice(0, 3)).toEqual(Array(3).fill('POST /agent/requests'))
    expect(api.calls.slice(3).every(c => c !== 'POST /agent/requests')).toBe(true)
    expect(s.asked).toEqual(grants.map(g => g.itemId))
    expect(s.opens).toHaveLength(1)
    expect(s.uses).toBe(1)
    expect(r.items.size).toBe(3)
  })

  it('an approval that ran out before the open: only that one is asked again, the others kept, one use', async () => {
    const { keys, api, grants, s, expire } = await setup()
    s.beforeOpen = n => { if (n === 1) expire(grants[0].itemId) }
    const r = await openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-2', 5_000)
    expect(s.asked).toEqual([...grants.map(g => g.itemId), grants[0].itemId])
    expect(s.opens).toHaveLength(2)
    expect(s.opens.every(o => o.use_id === 'u-2')).toBe(true)
    expect(s.uses).toBe(1)
    expect(r.items.size).toBe(3)
    // Spent: the next call asks for all three again.
    s.beforeOpen = () => {}
    await openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-3', 5_000)
    expect(s.asked).toHaveLength(7)
    expect(s.uses).toBe(2)
  })

  it('runs out again: fails, keeps the valid approvals, and the retry asks only for the expired one', async () => {
    const { keys, api, grants, s, expire } = await setup()
    s.beforeOpen = n => { if (n <= 2) expire(grants[0].itemId) }
    await expect(openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-4', 5_000))
      .rejects.toThrow(/approval to use "Bank" expired before it was used\. Try again\./)
    expect(s.asked).toEqual([...grants.map(g => g.itemId), grants[0].itemId])
    expect(s.uses).toBe(0)
    const r = await openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-5', 5_000)
    expect(s.asked).toEqual([...grants.map(g => g.itemId), grants[0].itemId, grants[0].itemId])
    expect(r.items.size).toBe(3)
    expect(s.uses).toBe(1)
  })

  it('nothing answered in time: PendingApproval, and the retry finishes the same requests', async () => {
    const { keys, api, grants, s } = await setup()
    s.answerAfter = Object.fromEntries(grants.map(g => [g.itemId, Infinity]))
    await expect(openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-6', 30)).rejects.toBeInstanceOf(PendingApproval)
    expect(s.asked).toHaveLength(3)
    for (const r of s.requests.values()) { r.status = 'allowed'; r.released = true }
    const r = await openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-7', 30)
    expect(r.items.size).toBe(3)
    expect(s.asked).toHaveLength(3)
    expect(s.opens).toHaveLength(1)
  })

  it('a denial ends the call; the other approvals stay for a retry', async () => {
    const { keys, api, grants, s } = await setup()
    s.answerAfter = { [grants[1].itemId]: Infinity }
    const broker = () => [...s.requests.values()].find(r => r.item === grants[1].itemId && r.status === 'pending')!
    const run = openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-8', 5_000)
    await new Promise(r => setTimeout(r, 20))
    broker().status = 'denied'
    await expect(run).rejects.toThrow(/denied using "Broker"/)
    s.answerAfter = {}
    const r = await openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-9', 5_000)
    expect(r.items.size).toBe(3)
    expect(s.asked.filter(id => id === grants[1].itemId)).toHaveLength(2)
    expect(s.asked.filter(id => id !== grants[1].itemId)).toHaveLength(2)
  })

  it('more accounts than the server lets wait at once: refused before asking anyone or opening', async () => {
    const { keys, api, grants, s } = await setup(MAX_PENDING_REQUESTS + 1)
    api.calls.length = 0
    await expect(openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-10', 5_000))
      .rejects.toThrow(`This command needs approval for 11 "ask every time" accounts; the most one call can ask for is 10. Split it into smaller commands`)
    expect(s.asked).toHaveLength(0)
    expect(api.calls.filter(c => c === 'POST /agent/requests')).toHaveLength(0)
    expect(s.opens).toHaveLength(0)
    expect(s.uses).toBe(0)
    // Exactly the cap is fine.
    const r = await openGrants(api, keys.privateJwk, grants.slice(0, MAX_PENDING_REQUESTS), 'run', 'pay', 'u-11', 5_000)
    expect(r.items.size).toBe(MAX_PENDING_REQUESTS)
    expect(s.opens).toHaveLength(1)
  })

  it('more accounts than one open may carry: refused before any approval is asked, exactly the cap opens', async () => {
    const { keys, api, grants: all, s } = await setup(MAX_OPEN_ITEMS + 1, true)
    const grants = all
    api.calls.length = 0
    await expect(openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-20', 5_000))
      .rejects.toThrow('This command uses 21 accounts; one call can use at most 20. Split it into smaller commands.')
    expect(api.calls.filter(c => c === 'POST /agent/requests')).toHaveLength(0)
    expect(s.asked).toHaveLength(0)
    expect(s.opens).toHaveLength(0)
    expect(s.uses).toBe(0)
    const r = await openGrants(api, keys.privateJwk, grants.slice(0, MAX_OPEN_ITEMS), 'run', 'pay', 'u-21', 5_000)
    expect(r.items.size).toBe(MAX_OPEN_ITEMS)
    expect(s.opens).toHaveLength(1)
  })

  it('a 429 while asking fails plainly, opens nothing, and the retry reuses the requests already made', async () => {
    const { keys, api, grants, s } = await setup()
    s.onAsk = n => (n === 3 ? 429 : undefined)
    s.answerAfter = Object.fromEntries(grants.map(g => [g.itemId, Infinity]))
    await expect(openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-12', 5_000))
      .rejects.toThrow(/Too many approval requests from this agent are already waiting for the user \(at most 10 at a time\)/)
    expect(s.asked).toEqual([grants[0].itemId, grants[1].itemId])
    expect(s.opens).toHaveLength(0)
    expect(s.uses).toBe(0)
    // Released, not left busy: the retry claims the two waiting requests and asks only for the third.
    s.onAsk = () => {}
    s.answerAfter = {}
    const r = await openGrants(api, keys.privateJwk, grants, 'run', 'pay', 'u-13', 5_000)
    expect(s.asked).toEqual(grants.map(g => g.itemId))
    expect(r.items.size).toBe(3)
    expect(s.opens).toHaveLength(1)
    expect(s.uses).toBe(1)
  })
})
