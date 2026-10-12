import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browserLogin } from '../src/browser.js'
import { generateTOTP } from '../src/extension.js'
import { loginItem } from './helpers.js'

// A three-step sign-in (username, then password, then a 2FA code) on a local
// site; signing in sets a session cookie, which the storageState must hold.
const SECRET = 'JBSWY3DPEHPK3PXP'
let server: Server
let base = ''
let browserOk = true

const page = (body: string) => `<!doctype html><html><head><title>Acme</title></head><body>${body}</body></html>`

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    let data = ''
    for await (const c of req) data += c
    const form = new URLSearchParams(data)
    const html = (b: string, headers: Record<string, string> = {}) => { res.writeHead(200, { 'content-type': 'text/html', ...headers }); res.end(page(b)) }
    if (url.pathname === '/') return html('<form method="post" action="/user"><input name="email" type="email" autocomplete="username"><button>Next</button></form>')
    if (url.pathname === '/user') return form.get('email') === 'ops@acme.io'
      ? html('<form method="post" action="/pass"><input type="password" name="pw"><button>Sign in</button></form>')
      : html('wrong user')
    if (url.pathname === '/pass') return form.get('pw') === 'hunter2-secret'
      ? html('<form method="post" action="/otp"><input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"><button>Verify</button></form>')
      : html('<form method="post" action="/pass"><input type="password" name="pw"></form>')
    if (url.pathname === '/otp') return form.get('code') === (await generateTOTP(SECRET))
      ? html('<h1>Dashboard</h1>', { 'set-cookie': 'session=signed-in; Path=/' })
      : html('bad code')
    res.writeHead(404); res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  try {
    const { chromium } = await import('playwright-core')
    const b = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
    await b.close()
  } catch { browserOk = false }
})
afterAll(() => new Promise<void>(r => server.close(() => r())))

describe('browser_login', () => {
  it('signs in through username, password and 2FA, and saves the session', async ctx => {
    if (!browserOk) ctx.skip()
    const out = join(tmpdir(), `otpilot-test-${Date.now()}`)
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'], totp: { secret: SECRET } }), { url: base, outDir: out })
    expect(r.status).toBe('signed_in')
    expect(r.title).toBe('Acme')
    const state = JSON.parse(readFileSync(r.storageState!, 'utf8'))
    expect(state.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`)).toContain('session=signed-in')
  })

  it('never starts on a site the account doesn\'t cover', async () => {
    await expect(browserLogin(loginItem({ urls: ['acme.example'] }), { url: base, outDir: tmpdir() })).rejects.toThrow(/only signs in there/)
  })

  it('reports a rejected password instead of claiming success', async ctx => {
    if (!browserOk) ctx.skip()
    const item = loginItem({ urls: ['127.0.0.1'] })
    item.fields[1].value = 'wrong'
    const r = await browserLogin(item, { url: base, outDir: tmpdir() })
    expect(r.status).toBe('needs_user')
  })
})
