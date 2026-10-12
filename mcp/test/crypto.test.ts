import { describe, expect, it, vi } from 'vitest'
import { agentCode } from '../src/code.js'
import { generateKeyPair } from '../src/ecies.js'
import { fieldValue, findGrant, loadGrants } from '../src/grants.js'
import { FakeApi, grantRow, loginItem } from './helpers.js'

describe('verification code', () => {
  it('matches the shared vector (web/src/lib/agentCode.ts, extension/agents.js)', () => {
    const key = Buffer.from([4, ...new Array(64).fill(7)]).toString('base64')
    expect(agentCode(key)).toBe('5ZOI-GAGN')
  })
})

describe('grants', () => {
  it('opens what the extension wrapped to this agent (keys.js → ecies.ts)', async () => {
    const keys = await generateKeyPair()
    const item = loginItem()
    const row = await grantRow(item, keys.publicKey, { commands: ['psql'] })
    const api = new FakeApi((m, p) => (p === '/agent/grants' ? { body: { grants: [row] } } : undefined))
    const [g] = await loadGrants(api, keys.privateJwk)
    expect(g.title).toBe('Staging')
    expect(g.commands).toEqual(['psql'])
    expect(await fieldValue(g.item!, 'password')).toBe('hunter2-secret')
  })

  it('names an ask-every-time grant from its label while its values are held back', async () => {
    const keys = await generateKeyPair()
    const row = await grantRow(loginItem({ title: 'Bank' }), keys.publicKey, { askEveryTime: true, withheld: true })
    const api = new FakeApi((m, p) => (p === '/agent/grants' ? { body: { grants: [row] } } : undefined))
    const [g] = await loadGrants(api, keys.privateJwk)
    expect([g.title, g.item, g.askEveryTime]).toEqual(['Bank', null, true])
  })

  it('skips a grant wrapped to another key', async () => {
    const mine = await generateKeyPair()
    const other = await generateKeyPair()
    const row = await grantRow(loginItem(), other.publicKey)
    const api = new FakeApi(() => ({ body: { grants: [row] } }))
    expect(await loadGrants(api, mine.privateJwk)).toEqual([])
  })

  it('finds an account by exact name, else by the one name containing it', () => {
    const g = (title: string) => ({ itemId: title, title, urls: [], type: 'login', scope: { kind: 'login' as const }, expiresAt: null, askEveryTime: false, commands: [], item: null })
    const all = [g('GitHub'), g('AWS staging'), g('AWS prod')]
    expect(findGrant(all, 'github').title).toBe('GitHub')
    expect(() => findGrant(all, 'aws')).toThrow(/several/)
    expect(() => findGrant(all, 'bank')).toThrow(/request_access/)
  })

  it('a fresh 2FA code from the extension\'s own TOTP (RFC 6238 vector)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(59_000)
    const item = loginItem({ totp: { secret: '3132333435363738393031323334353637383930', digits: 8, period: 30 } })
    expect(await fieldValue(item, 'totp')).toBe('94287082')
    vi.useRealTimers()
  })
})
