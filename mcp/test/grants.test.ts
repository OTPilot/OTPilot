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
      if (p.startsWith('/agent/requests/')) return { body: { status } }
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
