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
let spaLogins = 0

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
    // A single-page sign-in that takes a while to answer, then rejects.
    if (url.pathname === '/spa') return html(`<input name="email" type="email" autocomplete="username"><input type="password" name="pw"><p id="err"></p>
      <script>document.querySelector('[name=pw]').addEventListener('keydown', e => { if (e.key !== 'Enter') return
        fetch('/spa-login', { method: 'POST' }).then(() => setTimeout(() => { err.textContent = 'Try again later' }, 1500)) })</script>`)
    // Username first, then the password field shows under it on the same page.
    if (url.pathname === '/reveal') return html(`<form method="post" action="/pass"><input name="email" type="email" autocomplete="username">
      <input type="password" name="pw" style="display:none"><button>Continue</button></form>
      <script>document.querySelector('[name=email]').addEventListener('keydown', e => { if (e.key !== 'Enter' || document.querySelector('[name=pw]').style.display !== 'none') return
        e.preventDefault(); setTimeout(() => { document.querySelector('[name=pw]').style.display = '' }, 500) })</script>`)
    // Password and code on one page: the code field shows once the password is in, the password stays.
    if (url.pathname === '/both') return html(`<form method="post" action="/otp"><input type="password" name="pw">
      <input name="code" autocomplete="one-time-code" style="display:none"><button>Go</button></form>
      <script>document.querySelector('[name=pw]').addEventListener('keydown', e => { if (e.key !== 'Enter' || document.querySelector('[name=code]').style.display !== 'none') return
        e.preventDefault(); document.querySelector('[name=code]').style.display = '' })</script>`)
    // A bot check that stays (headless never gets through it).
    if (url.pathname === '/bot') return html('<h1>Verify you are human</h1><p>Performing security verification</p>')
    // A bot check that clears by itself after a moment, then the sign-in form.
    if (url.pathname === '/bot-clears') return html(`<h1>Verify you are human</h1><script>setTimeout(() => { document.body.innerHTML =
      '<form method="post" action="/pass"><input name="email" type="email" autocomplete="username"><input type="password" name="pw"><button>Sign in</button></form>' }, 2500)</script>`)
    // The submit turned down (a bot check on the button), then the person gets it through: the 2FA step.
    if (url.pathname === '/turned-down') return html(`<input name="email" type="email" autocomplete="username"><input type="password" name="pw"><p id="err"></p>
      <script>document.querySelector('[name=pw]').addEventListener('keydown', e => { if (e.key !== 'Enter') return
        err.textContent = 'Something went wrong'; setTimeout(() => { location.href = '/pass-ok' }, 23000) })</script>`)
    if (url.pathname === '/pass-ok') return html('<form method="post" action="/otp"><input name="code" autocomplete="one-time-code"><button>Verify</button></form>')
    // A 2FA code in one box per digit, sent on the last one (Enter does nothing).
    if (url.pathname === '/boxes') return html(`<form method="post" action="/otp"><input type="hidden" name="code">
      ${'<input class="d" maxlength="1" inputmode="numeric" autocomplete="one-time-code">'.repeat(6)}</form>
      <script>const d = [...document.querySelectorAll('.d')]; d.forEach((b, i) => {
        b.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault() })
        b.addEventListener('input', () => { if (b.value.length === 1 && d[i + 1]) d[i + 1].focus()
          if (d.every(x => x.value.length === 1)) { document.querySelector('[name=code]').value = d.map(x => x.value).join(''); document.forms[0].submit() } }) })</script>`)
    // Boxes that don't move the focus by themselves, with a button to send.
    if (url.pathname === '/boxes-still') return html(`<form method="post" action="/otp" onsubmit="this.code.value = [...document.querySelectorAll('.d')].map(x => x.value).join('')">
      <input type="hidden" name="code">${'<input class="d" maxlength="1" autocomplete="one-time-code">'.repeat(6)}<button>Verify</button></form>`)
    // The username turned down, then the person gets it through: the password page.
    if (url.pathname === '/user-turned-down') return html(`<input name="email" type="email" autocomplete="username"><p id="err"></p>
      <script>document.querySelector('[name=email]').addEventListener('keydown', e => { if (e.key !== 'Enter') return
        err.textContent = 'Something went wrong'; setTimeout(() => { location.href = '/user-ok' }, 23000) })</script>`)
    if (url.pathname === '/user-ok') return html('<form method="post" action="/pass"><input type="password" name="pw"><button>Sign in</button></form>')
    if (url.pathname === '/spa-login') { spaLogins++; res.writeHead(204); return res.end() }
    if (url.pathname === '/otp') return form.get('code') === (await generateTOTP(SECRET))
      ? html('<h1>Dashboard</h1>', { 'set-cookie': 'session=signed-in; Path=/' })
      : html('bad code')
    res.writeHead(404); res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  try {
    const { chromium } = await import('playwright-core')
    const b = await chromium.launch({ channel: 'chrome', timeout: 30_000 }).catch(() => chromium.launch({ timeout: 30_000 }))
    await b.close()
  } catch { browserOk = false }
}, 90_000) // a cold browser start on a CI runner can take a while
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

  it('never sends a password over plain HTTP to a public site', async () => {
    await expect(browserLogin(loginItem({ urls: ['acme.example'] }), { url: 'http://acme.example/login', outDir: tmpdir() })).rejects.toThrow(/over HTTPS/)
  })

  it('a username the site doesn\'t take is not a sign-in', async ctx => {
    if (!browserOk) ctx.skip()
    const item = loginItem({ urls: ['127.0.0.1'] })
    item.fields[0].value = 'nobody@acme.io'
    const r = await browserLogin(item, { url: base, outDir: tmpdir() })
    expect(r.status).toBe('needs_user')
  })

  it('never starts on a site the account doesn\'t cover', async () => {
    await expect(browserLogin(loginItem({ urls: ['acme.example'] }), { url: base, outDir: tmpdir() })).rejects.toThrow(/only signs in there/)
  })

  it('submits a password once, even when the site is slow to answer', async ctx => {
    if (!browserOk) ctx.skip()
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'] }), { url: `${base}spa`, outDir: tmpdir() })
    expect(r.status).toBe('needs_user')
    expect(spaLogins).toBe(1)
  }, 60_000)

  it('goes on when the password field shows under the username on the same page', async ctx => {
    if (!browserOk) ctx.skip()
    const started = Date.now()
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'], totp: { secret: SECRET } }), { url: `${base}reveal`, outDir: join(tmpdir(), `otpilot-test-${Date.now()}`) })
    expect(r.status).toBe('signed_in')
    expect(Date.now() - started).toBeLessThan(15_000) // not after the 20 s wait
  }, 40_000)

  it('fills the 2FA code when it shows beside the password field', async ctx => {
    if (!browserOk) ctx.skip()
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'], totp: { secret: SECRET } }), { url: `${base}both`, outDir: join(tmpdir(), `otpilot-test-${Date.now()}`) })
    expect(r.status).toBe('signed_in')
  }, 40_000)

  it('stops at a bot check without sending anything, and says so', async ctx => {
    if (!browserOk) ctx.skip()
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'] }), { url: `${base}bot`, outDir: tmpdir(), show: false })
    expect(r).toMatchObject({ status: 'needs_user', blocked: true })
    expect(r.note).toMatch(/bot check/)
  })

  it('retries a bot check in a visible window, where it clears (or says there is no display)', async ctx => {
    if (!browserOk) ctx.skip()
    const display = process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'], totp: { secret: SECRET } }), { url: `${base}bot-clears`, outDir: join(tmpdir(), `otpilot-test-${Date.now()}`) })
    if (display) expect(r.status).toBe('signed_in')
    else expect(r.note).toMatch(/no display/)
  }, 90_000)

  it('in a visible window, waits for the person to get a turned-down submit through, then fills the code', async ctx => { // after the 20 s a submit gets
    if (!browserOk || process.platform === 'linux' && !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) ctx.skip()
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'], totp: { secret: SECRET } }), { url: `${base}turned-down`, outDir: join(tmpdir(), `otpilot-test-${Date.now()}`), show: true })
    expect(r.status).toBe('signed_in')
  }, 90_000)

  it('in a visible window, goes on to the password once the person gets a turned-down username through', async ctx => {
    if (!browserOk || process.platform === 'linux' && !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) ctx.skip()
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'], totp: { secret: SECRET } }), { url: `${base}user-turned-down`, outDir: join(tmpdir(), `otpilot-test-${Date.now()}`), show: true })
    expect(r.status).toBe('signed_in')
  }, 90_000)

  it('types a 2FA code into one box per digit', async ctx => {
    if (!browserOk) ctx.skip()
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'], totp: { secret: SECRET } }), { url: `${base}boxes`, outDir: join(tmpdir(), `otpilot-test-${Date.now()}`) })
    expect(r.status).toBe('signed_in')
  }, 40_000)

  it('puts each digit in its box when the page doesn\'t move the focus', async ctx => {
    if (!browserOk) ctx.skip()
    const r = await browserLogin(loginItem({ urls: ['127.0.0.1'], totp: { secret: SECRET } }), { url: `${base}boxes-still`, outDir: join(tmpdir(), `otpilot-test-${Date.now()}`) })
    expect(r.status).toBe('signed_in')
  }, 40_000)

  it('reports a rejected password instead of claiming success', async ctx => {
    if (!browserOk) ctx.skip()
    const item = loginItem({ urls: ['127.0.0.1'] })
    item.fields[1].value = 'wrong'
    const r = await browserLogin(item, { url: base, outDir: tmpdir() })
    expect(r.status).toBe('needs_user')
  })
})
