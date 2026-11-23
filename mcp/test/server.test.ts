import { existsSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { generateKeyPair } from '../src/ecies.js'
import { openRetry } from '../src/grants.js'
import { buildServer, INSTRUCTIONS, wait } from '../src/server.js'
import { FakeApi, grantRow, loginItem, openFrom } from './helpers.js'

beforeAll(() => { openRetry.ms = 1 })

async function connect(grants: object[], extra: (m: string, p: string, b: any) => { status?: number; body: unknown } | undefined = () => undefined, usage: unknown = null) {
  const keys = await generateKeyPair()
  const rows = await Promise.all(grants.map((g: any) => grantRow(g.item, keys.publicKey, g)))
  const uses: any[] = []
  const opens: any[] = []
  const api = new FakeApi((m, p, b) => {
    if (p === '/agent/grants') return { body: { grants: rows, usage } }
    if (p === '/agent/uses') { uses.push(b); return { body: { ok: true } } }
    if (p === '/agent/grants/open') { opens.push(b); return extra(m, p, b) ?? openFrom(rows, b) }
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
  return { client, call, uses, api, opens }
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

  it('run: a file field comes as the path of a private temp copy, gone after the command', async () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n'
    const dataUrl = (name: string, bytes: Buffer) => `data:application/octet-stream;name=${encodeURIComponent(name)};base64,${bytes.toString('base64')}`
    const item = loginItem({
      title: 'Deploy key', type: 'ssh',
      fields: [
        { id: 'privateKey', label: 'Private key', kind: 'file', value: dataUrl('id_ed25519', Buffer.from(pem)) },
        { id: 'c1', label: 'Cert', kind: 'file', custom: true, value: dataUrl('dist.p12', Buffer.from([0, 1, 2, 3, 4])) },
      ],
    })
    const { call } = await connect([{ item, scope: { kind: 'fields', parts: ['f:privateKey', 'f:c1'] } }])
    const r = await call('run', {
      command: 'echo "path=$KEY"; ls -l "$KEY" | cut -c1-10; head -2 "$KEY"; wc -c < "$CERT"; basename "$CERT"',
      env: { KEY: 'Deploy key/@file', CERT: 'Deploy key/Cert' },
    })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('exit code: 0')
    expect(r.text).toContain('-rw-------')
    expect(r.text).toMatch(/^\s*5$/m)
    expect(r.text).toContain('dist.p12')
    expect(r.text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ')
    const path = /path=(\S+)/.exec(r.text)![1]
    expect(path.endsWith('/id_ed25519')).toBe(true)
    expect(existsSync(path)).toBe(false)
    // A reference to an item without a file says so (once open: its fields' kinds aren't known before).
    const plain = loginItem({ title: 'Plain', fields: [{ id: 'c1', label: 'Token', value: 'tok-123', custom: true }] })
    const none = await connect([{ item: plain, scope: { kind: 'fields', parts: ['f:c1'] } }])
    const bad = await none.call('run', { command: 'true', env: { K: 'Plain/@file' } })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('has no file')
  })

  it('a 2FA-only account gives a code to run; signing in asks the user for its sign-in first', async () => {
    const item = loginItem({ title: 'AWS' })
    const asked: any[] = []
    const { call, opens } = await connect([{ item, scope: { kind: '2fa' } }], (m, p, b) => {
      if (m === 'POST' && p === '/agent/requests') { asked.push(b); return { body: { id: '00000000-0000-4000-8000-00000000000a' } } }
      if (p.startsWith('/agent/requests/')) return { body: { status: 'denied' } }
      return undefined
    })
    const r = await call('browser_login', { account: 'AWS', reason: 'check billing' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/didn't allow its sign-in .* of "AWS"/)
    expect(asked).toEqual([{ query: 'AWS', tool: 'browser_login', reason: 'browser_login: needs its sign-in (username and password) of "AWS"; it may only use its 2FA code now. check billing' }])
    expect(opens).toHaveLength(0) // refused before anything is opened (no use)
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
    const api = new FakeApi((m, p, body) => {
      if (p === '/agent/grants') return { body: { grants: [held] } }
      if (p === '/agent/grants/open') return openFrom([approved ? released : held], body)
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
    const api = new FakeApi((m, p, body) => {
      if (p === '/agent/grants') return { body: { grants: [held] } }
      if (p === '/agent/grants/open') return openFrom([polls > 1 ? released : held], body)
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

  it('run: every reference is checked first, then all its accounts open in one request (one use)', async () => {
    const db = loginItem({ title: 'Staging DB' })
    const api = loginItem({ title: 'Stripe', fields: [{ id: 'c1', label: 'Secret key', value: 'sk_test_abc123', custom: true }] })
    const { call, opens, uses, api: fake } = await connect([{ item: db }, { item: api, scope: { kind: 'fields', parts: ['f:c1'] } }])
    const r = await call('run', { command: 'echo "$U $P $K"', env: { U: 'Staging DB/username', P: 'Staging DB/password', K: 'Stripe/Secret key' }, reason: 'deploy' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('[REDACTED] [REDACTED] [REDACTED]')
    expect(opens).toHaveLength(1)
    expect(opens[0]).toMatchObject({ tool: 'run', item_ids: [db.id, api.id] })
    expect(opens[0].use_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(uses.map(u => u.item_id)).toEqual([db.id, api.id])
    expect(fake.calls.filter(c => c === 'GET /agent/grants')).toHaveLength(1) // one list for the whole call
    // A reference to an account it doesn't have: nothing is opened (the user is asked).
    const bad = await call('run', { command: 'true', env: { P: 'Staging DB/password', X: 'Nope/password' } })
    expect(bad.isError).toBe(true)
    expect(opens).toHaveLength(1)
  })

  it('an account it isn\'t allowed is asked for, waited on, then used; a retry waits for the same request', async () => {
    const keys = await generateKeyPair()
    const item = loginItem({ title: 'GitHub', urls: ['github.com'] })
    const row = await grantRow(item, keys.publicKey)
    const asked: any[] = []
    let status = 'pending'
    const api = new FakeApi((m, p, b) => {
      if (p === '/agent/grants') return { body: { grants: status === 'allowed' ? [row] : [] } }
      if (p === '/agent/grants/open') return openFrom([row], b)
      if (m === 'POST' && p === '/agent/requests') { asked.push(b); return { body: { id: '00000000-0000-4000-8000-00000000000b' } } }
      if (p.startsWith('/agent/requests/')) return { body: { status, item_id: status === 'allowed' ? item.id : null } }
      if (p === '/agent/uses') return { body: { ok: true } }
      return undefined
    })
    const server = buildServer({ api, creds: { apiUrl: '', agentId: 'a', name: 'x', token: 't', publicKey: keys.publicKey, privateJwk: keys.privateJwk } })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 't', version: '1' })
    await Promise.all([server.connect(a), c.connect(b)])
    wait.ms = 50
    const first: any = await c.callTool({ name: 'run', arguments: { command: 'echo "$T"', env: { T: 'github/password' } } }).finally(() => { wait.ms = 90_000 })
    expect(first.isError).toBe(true)
    expect(first.content[0].text).toMatch(/Waiting for approval: access to "github"/)
    expect(asked).toEqual([{ query: 'github', tool: 'run', reason: 'run: needs the password of "github", which it isn\'t allowed to use.' }])
    status = 'allowed'
    const again: any = await c.callTool({ name: 'run', arguments: { command: 'echo "$T"', env: { T: 'github/password' } } })
    expect(again.isError).toBeFalsy()
    expect(again.content[0].text).toContain('[REDACTED]')
    expect(asked).toHaveLength(1) // the same request, not a second one
  })

  it('a custom field labelled "Password" in a fields grant is used as such, not asked for', async () => {
    const item = loginItem({ title: 'Router', fields: [{ id: 'c1', label: 'Password', value: 'router-pw-9', custom: true }] })
    const { call, opens } = await connect([{ item, scope: { kind: 'fields', parts: ['f:c1'] } }])
    const r = await call('run', { command: 'echo "$P"', env: { P: 'Router/Password' } })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('[REDACTED]')
    expect(opens).toHaveLength(1)
  })

  it('a built-in field approved under another label (a wallet\'s "Unlock password") is used, not asked for', async () => {
    const item = loginItem({ title: 'Wallet', fields: [{ id: 'password', label: 'Unlock password', value: 'unlock-77' }] })
    const { call, opens } = await connect([{ item, scope: { kind: 'fields', parts: ['f:password'] } }])
    const r = await call('run', { command: 'echo "$P"', env: { P: 'Wallet/Unlock password' } })
    expect(r.isError).toBe(false)
    expect(opens).toHaveLength(1)
  })

  it('a field missing from the copy is reported to the user; an answered request is never pointed to again', async () => {
    const item = loginItem({ title: 'Vault', totp: null })
    const asked: any[] = []
    const { call } = await connect([{ item }], (m, p, b) => {
      if (m === 'POST' && p === '/agent/requests') { asked.push(b); return { body: { id: `00000000-0000-4000-8000-00000000010${asked.length}` } } }
      if (p.startsWith('/agent/requests/')) return { body: { status: 'denied' } }
      return undefined
    })
    await call('run', { command: 'true', env: { C: 'Vault/totp' } })
    const again = await call('run', { command: 'true', env: { C: 'Vault/totp' } })
    expect(asked).toHaveLength(2)
    expect(again.text).toContain('request 00000000-0000-4000-8000-000000000102')
  })

  it('a field missing from the copy is reported to the user', async () => {
    const item = loginItem({ title: 'Stripe', totp: null })
    const asked: any[] = []
    const { call } = await connect([{ item }], (m, p, b) => {
      if (m === 'POST' && p === '/agent/requests') { asked.push(b); return { body: { id: '00000000-0000-4000-8000-00000000000c' } } }
      return undefined
    })
    const r = await call('run', { command: 'true', env: { C: 'Stripe/totp' } })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/no 2FA code available .* OTPilot asked the user to allow it \(request 00000000-0000-4000-8000-00000000000c\)/)
    expect(asked[0]).toMatchObject({ query: 'Stripe', tool: 'run' })
  })

  it('run: an empty field part is refused before opening; a wrong field label is only found after (one open)', async () => {
    const item = loginItem({ title: 'Stripe', fields: [{ id: 'c1', label: 'Secret key', value: 'sk_test_abc123', custom: true }] })
    const { call, opens } = await connect([{ item, scope: { kind: 'fields', parts: ['f:c1'] } }])
    for (const ref of ['Stripe/', 'Stripe/  ']) {
      const r = await call('run', { command: 'true', env: { K: ref } })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/field is empty/)
    }
    expect(opens).toHaveLength(0)
    const wrong = await call('run', { command: 'true', env: { K: 'Stripe/Nope key' } })
    expect(wrong.isError).toBe(true)
    expect(wrong.text).toContain('"Nope key"')
    expect(opens).toHaveLength(1)
  })

  it('browser_login opens its account once, with its own use_id', async () => {
    const item = loginItem({ title: 'Acme', urls: ['127.0.0.1'] })
    const { call, opens } = await connect([{ item }], (m, p) => p === '/agent/grants/open' ? { status: 402, body: { error: 'used up', code: 'agent_uses_exhausted' } } : undefined)
    await call('browser_login', { account: 'Acme' })
    await call('browser_login', { account: 'Acme' })
    expect(opens.map(o => o.tool)).toEqual(['browser_login', 'browser_login'])
    expect(opens[0].item_ids).toEqual([item.id])
    expect(opens[0].use_id).not.toBe(opens[1].use_id)
  })

  it('relays the server\'s uses-exhausted message as is, and runs nothing', async () => {
    const error = 'You\'ve used your 10 free agent uses for this month. They renew on Jul 1. Upgrade to Personal for unlimited uses ($3/month or $30/year) at https://otpilot.app/dashboard/billing.'
    const item = loginItem({ title: 'Staging DB' })
    const { call } = await connect([{ item }], (m, p) => p === '/agent/grants/open'
      ? { status: 402, body: { error, code: 'agent_uses_exhausted', used: 10, limit: 10, resets_at: '2026-07-01T00:00:00Z', upgrade_url: 'https://otpilot.app/dashboard/billing', trial_available: false, trial_days: 30 } }
      : undefined)
    for (const [tool, args] of [
      ['run', { command: 'echo ran', env: { P: 'Staging DB/password' } }],
      ['browser_login', { account: 'Staging DB' }],
    ] as const) {
      const r = await call(tool, args)
      expect(r.isError).toBe(true)
      expect(r.text).toBe(`${error} Tell the user this message, with the link. Don't call browser_login or run again before it renews.`)
    }
  })

  it('relays the server\'s out-of-date message', async () => {
    const error = 'This OTPilot MCP is out of date. Restart your AI agent so it runs the latest @otpilot/mcp (npx -y @otpilot/mcp@latest), then try again.'
    const item = loginItem({ title: 'Bank' })
    const { call } = await connect([{ item, askEveryTime: true, withheld: true }], (m, p) => m === 'POST' && p === '/agent/requests'
      ? { status: 426, body: { error, code: 'mcp_outdated' } }
      : undefined)
    const r = await call('run', { command: 'true', env: { P: 'Bank/password' } })
    expect(r.isError).toBe(true)
    expect(r.text).toBe(`${error} Tell the user this message.`)
  })

  it('list_accounts adds the Free plan\'s uses left, on its own line', async () => {
    const notice = 'Free plan: 7 of 10 uses left this month (renews Jul 1).'
    const usage = { used: 3, limit: 10, resets_at: '2026-07-01T00:00:00Z', notice }
    const free = await connect([{ item: loginItem({ title: 'GitHub', urls: ['github.com'] }) }], undefined, usage)
    const r = await free.call('list_accounts')
    expect(r.text.split('\n').at(-1)).toBe(notice)
    expect(r.text).toContain('"GitHub" (github.com)')
    expect(free.opens).toHaveLength(0)
    const none = await connect([], undefined, usage)
    expect((await none.call('list_accounts')).text).toBe(`No accounts allowed yet. Call request_access to ask the user for one.\n${notice}`)
    const paid = await connect([{ item: loginItem({ title: 'GitHub' }) }])
    expect((await paid.call('list_accounts')).text).not.toContain('Free plan')
  })

  it('tells the agent what counts on the Free plan', async () => {
    expect(INSTRUCTIONS).toMatch(/browser_login or run call is one of 10 uses a month/)
    expect(INSTRUCTIONS).toMatch(/list_accounts, request_access and check_request are free/)
    expect(INSTRUCTIONS).toMatch(/relay its message to the user as is/)
    const { client } = await connect([])
    const tools = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t.description || '']))
    expect(tools.run).toMatch(/one of 10 uses a month/)
    expect(tools.browser_login).toMatch(/one of 10 uses a month/)
    for (const free of ['list_accounts', 'request_access', 'check_request']) expect(tools[free]).toMatch(/Never counts as a use/)
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
