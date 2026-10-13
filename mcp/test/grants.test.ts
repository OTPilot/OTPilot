import { describe, expect, it } from 'vitest'
import { generateKeyPair } from '../src/ecies.js'
import { loadGrants, openItem, PendingApproval } from '../src/grants.js'
import { FakeApi, grantRow, loginItem } from './helpers.js'

describe('ask every time', () => {
  it('an approval given after the wait timed out is used once by the retry, then asked again', async () => {
    const item = loginItem({ title: 'Bank' })
    const keys = await generateKeyPair()
    const held = await grantRow(item, keys.publicKey, { askEveryTime: true, withheld: true })
    const released = await grantRow(item, keys.publicKey, { askEveryTime: true })
    let asks = 0
    let status = 'pending'
    const api = new FakeApi((m, p) => {
      if (p === '/agent/grants') return { body: { grants: [status === 'allowed' ? released : held] } }
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
    const api = new FakeApi((m, p) => {
      if (p === '/agent/grants') return s.failGrants ? { status: 500, body: { error: 'down' } } : { body: { grants: [s.status === 'allowed' ? released : held] } }
      if (m === 'POST' && p === '/agent/requests') { s.asks++; return { body: { id: `00000000-0000-4000-8000-00000000001${s.asks}` } } }
      if (p.startsWith('/agent/requests/')) { const st = s.onlyFirst && !p.endsWith(FIRST) ? 'pending' : s.status; if (s.flaky && p.endsWith(FIRST)) return { status: 503, body: { error: 'unavailable' } }
        if (s.gone && p.endsWith(FIRST)) return { status: 404, body: { error: 'not found' } }
        return { body: { status: st, released: st === 'allowed' && !s.expired } } }
      return undefined
    })
    const grant = (await loadGrants(api, keys.privateJwk))[0]
    const open = (tool = 'run', reason = 'deploy') => openItem(api, keys.privateJwk, grant, tool, reason, 50)
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
    const api = new FakeApi((m, p) => {
      if (p === '/agent/grants') return { body: { grants: [Object.values(status).includes('allowed') ? released : held] } }
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
