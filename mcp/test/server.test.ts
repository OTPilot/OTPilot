import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { generateKeyPair } from '../src/ecies.js'
import { buildServer, INSTRUCTIONS } from '../src/server.js'
import { FakeApi, grantRow, loginItem } from './helpers.js'

async function connect(grants: object[], extra: (m: string, p: string, b: any) => { status?: number; body: unknown } | undefined = () => undefined) {
  const keys = await generateKeyPair()
  const rows = await Promise.all(grants.map((g: any) => grantRow(g.item, keys.publicKey, g)))
  const uses: any[] = []
  const api = new FakeApi((m, p, b) => {
    if (p === '/agent/grants') return { body: { grants: rows } }
    if (p === '/agent/uses') { uses.push(b); return { body: { ok: true } } }
    return extra(m, p, b)
  })
  const server = buildServer({ api, creds: { apiUrl: '', agentId: 'a', name: 'Claude Code', token: 't', publicKey: keys.publicKey, privateJwk: keys.privateJwk } })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: object = {}) => {
    const r: any = await client.callTool({ name, arguments: args })
    return { text: r.content.map((c: any) => c.text).join('\n'), isError: !!r.isError }
  }
  return { client, call, uses, api }
}

describe('MCP server', () => {
  it('reports the client it runs in once the session starts', async () => {
    const reported: any[] = []
    await connect([], (m, p, b) => { if (p === '/agent/client') { reported.push(b); return { body: { ok: true } } } })
    await expect.poll(() => reported).toEqual([{ name: 'test', version: '1' }])
  })

  it('tells the agent how to use it, and lists accounts by name only', async () => {
    const { client, call } = await connect([{ item: loginItem({ title: 'GitHub', urls: ['github.com'] }), scope: { kind: '2fa' } }])
    expect(client.getInstructions()).toBe(INSTRUCTIONS)
    const tools = (await client.listTools()).tools.map(t => t.name).sort()
    expect(tools).toEqual(['browser_login', 'check_request', 'list_accounts', 'request_access', 'run'])
    const r = await call('list_accounts')
    expect(r.text).toContain('"GitHub" (github.com): 2FA code')
    expect(r.text).not.toContain('JBSWY3DPEHPK3PXP')
  })

  it('run: env from references, output scrubbed, use reported', async () => {
    const item = loginItem({ title: 'Staging DB' })
    const { call, uses } = await connect([{ item, commands: ['echo'] }])
    const r = await call('run', { command: 'echo "$U:$P"', env: { U: 'Staging DB/username', P: 'Staging DB/password' } })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('exit code: 0')
    expect(r.text).toContain('[REDACTED]:[REDACTED]')
    expect(r.text).not.toContain('hunter2')
    expect(uses).toEqual([{ item_id: item.id, action: 'run', detail: 'echo' }])
    // Not one of its commands.
    const refused = await call('run', { command: 'cat /etc/hosts', env: { P: 'Staging DB/password' } })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/only be used with echo/)
  })

  it('a 2FA-only account gives a code to run, but no sign-in', async () => {
    const item = loginItem({ title: 'AWS' })
    const { call } = await connect([{ item, scope: { kind: '2fa' } }])
    const r = await call('browser_login', { account: 'AWS' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/only allows its 2FA code/)
    const code = await call('run', { command: 'echo "${#CODE}"', env: { CODE: 'AWS/totp' } })
    expect(code.text).toMatch(/stdout:\n6/)
  })

  it('an ask-every-time account: the agent waits, and is told to ask the user', async () => {
    const item = loginItem({ title: 'Bank' })
    let asked: any = null
    const { call } = await connect([{ item, askEveryTime: true, withheld: true }], (m, p, b) => {
      if (m === 'POST' && p === '/agent/requests') { asked = b; return { body: { id: '00000000-0000-4000-8000-000000000001' } } }
      if (p.startsWith('/agent/requests/')) return { body: { status: 'denied' } }
      return undefined
    })
    const r = await call('run', { command: 'true', env: { P: 'Bank/password' }, reason: 'check balance' })
    expect(asked).toEqual({ item_id: item.id, tool: 'run', reason: 'check balance' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/denied/)
  })

  it('one approval covers every field of an ask-every-time account in a command', async () => {
    const item = loginItem({ title: 'Bank' })
    const keys = await generateKeyPair()
    const held = await grantRow(item, keys.publicKey, { askEveryTime: true, withheld: true })
    const released = await grantRow(item, keys.publicKey, { askEveryTime: true })
    let asks = 0
    let approved = false
    const api = new FakeApi((m, p) => {
      if (p === '/agent/grants') return { body: { grants: [approved ? released : held] } }
      if (m === 'POST' && p === '/agent/requests') { asks++; return { body: { id: '00000000-0000-4000-8000-000000000003' } } }
      if (p.startsWith('/agent/requests/')) { approved = true; return { body: { status: 'allowed' } } }
      if (p === '/agent/uses') return { body: { ok: true } }
      return undefined
    })
    const server = buildServer({ api, creds: { apiUrl: '', agentId: 'a', name: 'x', token: 't', publicKey: keys.publicKey, privateJwk: keys.privateJwk } })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 't', version: '1' })
    await Promise.all([server.connect(a), c.connect(b)])
    const r: any = await c.callTool({ name: 'run', arguments: { command: 'echo "$U $P"', env: { U: 'Bank/username', P: 'Bank/password' } } })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toContain('[REDACTED] [REDACTED]')
    expect(asks).toBe(1)
  })

  it('a passing server error doesn\'t end an approval wait', async () => {
    const keys = await generateKeyPair()
    const item = loginItem({ title: 'Bank' })
    const held = await grantRow(item, keys.publicKey, { askEveryTime: true, withheld: true })
    const released = await grantRow(item, keys.publicKey, { askEveryTime: true })
    let polls = 0
    const api = new FakeApi((m, p) => {
      if (p === '/agent/grants') return { body: { grants: [polls > 1 ? released : held] } }
      if (m === 'POST' && p === '/agent/requests') return { body: { id: '00000000-0000-4000-8000-000000000005' } }
      if (p.startsWith('/agent/requests/')) return ++polls === 1 ? { status: 500, body: { error: 'internal error' } } : { body: { status: 'allowed' } }
      if (p === '/agent/uses') return { body: { ok: true } }
      return undefined
    })
    const server = buildServer({ api, creds: { apiUrl: '', agentId: 'a', name: 'x', token: 't', publicKey: keys.publicKey, privateJwk: keys.privateJwk } })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 't', version: '1' })
    await Promise.all([server.connect(a), c.connect(b)])
    const r: any = await c.callTool({ name: 'run', arguments: { command: 'true', env: { P: 'Bank/password' } } })
    expect(r.isError).toBeFalsy()
    expect(polls).toBe(2)
  })

  it('a revoked agent waiting for an approval is told to reconnect, not to approve', async () => {
    const keys = await generateKeyPair()
    const held = await grantRow(loginItem({ title: 'Bank' }), keys.publicKey, { askEveryTime: true, withheld: true })
    const api = new FakeApi((m, p) => {
      if (p === '/agent/grants') return { body: { grants: [held] } }
      if (m === 'POST' && p === '/agent/requests') return { body: { id: '00000000-0000-4000-8000-000000000004' } }
      if (p.startsWith('/agent/requests/')) return { status: 401, body: { error: 'unauthorized' } }
      return undefined
    })
    const server = buildServer({ api, creds: { apiUrl: '', agentId: 'a', name: 'x', token: 't', publicKey: keys.publicKey, privateJwk: keys.privateJwk } })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 't', version: '1' })
    await Promise.all([server.connect(a), c.connect(b)])
    const r: any = await c.callTool({ name: 'run', arguments: { command: 'true', env: { P: 'Bank/password' } } })
    expect(r.content[0].text).toMatch(/no longer connected/)
  })

  it('request_access waits for the answer and lists the new account', async () => {
    const item = loginItem({ title: 'Cloudflare' })
    let answered = false
    const ctx = await connect([], (m, p) => {
      if (m === 'POST' && p === '/agent/requests') return { body: { id: '00000000-0000-4000-8000-000000000002' } }
      if (p.startsWith('/agent/requests/')) { answered = true; return { body: { status: 'allowed' } } }
      return undefined
    })
    const r = await ctx.call('request_access', { query: 'cloudflare', reason: 'DNS check' })
    expect(answered).toBe(true)
    expect(r.text).toMatch(/^Allowed/)
    void item
  })

  it('a revoked agent is told to reconnect', async () => {
    const { client } = await connect([])
    const api = new FakeApi(() => ({ status: 401, body: { error: 'unauthorized' } }))
    const keys = await generateKeyPair()
    const server = buildServer({ api, creds: { apiUrl: '', agentId: 'a', name: 'x', token: 't', publicKey: keys.publicKey, privateJwk: keys.privateJwk } })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 't', version: '1' })
    await Promise.all([server.connect(a), c.connect(b)])
    const r: any = await c.callTool({ name: 'list_accounts', arguments: {} })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/no longer connected/)
    void client
  })
})
