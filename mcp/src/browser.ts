// `browser_login`: OTPilot signs in itself, in its own browser (the system's
// Chrome through Playwright, else Playwright's Chromium), and hands the agent
// the signed-in session (a Playwright storageState file) — never the
// username, password or 2FA code. Every fill happens only on a page the
// account's saved sites cover (Vault.loginCoversHost, as in the extension), so
// a redirect or an injected link can't send the credentials anywhere else.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Browser, Page, Locator } from 'playwright-core'
import { Vault, generateTOTP, type VaultItem } from './extension.js'

export type LoginResult = {
  status: 'signed_in' | 'needs_user'
  url: string
  title: string
  storageState?: string
  note?: string
}

const USER = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="user" i]:not([type="hidden"]):not([type="password"])',
  'input[name*="login" i]:not([type="hidden"]):not([type="password"])',
  'input[name*="email" i]:not([type="hidden"])',
  'input[id*="user" i]:not([type="hidden"]):not([type="password"])',
  'input[id*="email" i]:not([type="hidden"])',
].join(', ')
const PASSWORD = 'input[type="password"]:not([autocomplete="new-password"])'
const OTP = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]', 'input[id*="otp" i]',
  'input[name*="totp" i]', 'input[name*="2fa" i]', 'input[name*="mfa" i]',
  'input[name*="code" i]:not([type="hidden"])', 'input[id*="code" i]:not([type="hidden"])',
  'input[inputmode="numeric"][maxlength="6"]',
].join(', ')

async function firstVisible(page: Page, selector: string): Promise<Locator | null> {
  const all = page.locator(selector)
  const n = Math.min(await all.count(), 10)
  for (let i = 0; i < n; i++) {
    const el = all.nth(i)
    if (await el.isVisible().catch(() => false) && await el.isEditable().catch(() => false)) return el
  }
  return null
}

async function launch(headless: boolean): Promise<Browser> {
  const { chromium } = await import('playwright-core')
  const tries = [
    () => chromium.launch({ channel: 'chrome', headless }),
    () => chromium.launch({ channel: 'msedge', headless }),
    () => chromium.launch({ headless }),
  ]
  let last: unknown
  for (const t of tries) {
    try { return await t() } catch (e) { last = e }
  }
  throw new Error(`No browser to sign in with: install Google Chrome, or run "npx playwright install chromium". (${String(last).split('\n')[0]})`)
}

const settle = (page: Page) => page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})

/**
 * After a submit, waits (up to `ms`) for the page to move on: a new document,
 * another URL, the submitted field gone or emptied, or the `next` step's field
 * showing on the same page (a password field revealed under the email). A sign-in can take a
 * while after the network goes quiet (a spinner, a slow API), and resubmitting
 * a password while it's still checking is how accounts get locked.
 */
async function moveOn(page: Page, field: Locator, next: string | null, ms = 20_000): Promise<boolean> {
  const url = page.url()
  await page.evaluate(() => { (window as unknown as { __otpilot?: boolean }).__otpilot = true }).catch(() => {})
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await page.waitForTimeout(400)
    if (page.url() !== url) return true
    const sameDoc = await page.evaluate(() => (window as unknown as { __otpilot?: boolean }).__otpilot === true).catch(() => false)
    if (!sameDoc) return true
    if (!(await field.isVisible().catch(() => false))) return true
    if (!(await field.inputValue().catch(() => ''))) return true
    if (next && (await firstVisible(page, next))) return true
  }
  return false
}

/** Signs in to `item`'s site and saves the session under `outDir`. */
export async function browserLogin(item: VaultItem, opts: { url?: string; outDir: string; headless?: boolean }): Promise<LoginResult> {
  const username = Vault.getValue(item, 'username')
  const password = Vault.getValue(item, 'password')
  // Only on the account's sites, and only over HTTPS — plain HTTP just for a
  // local host (localhost, 127.x, ::1, *.localhost, *.local), as in the extension.
  const covers = (url: string) => {
    try {
      const u = new URL(url)
      const host = u.hostname.replace(/^\[|\]$/g, '')
      const local = /^(localhost|127(\.\d+){3}|::1)$/.test(host) || /\.(localhost|local)$/.test(host)
      const secure = u.protocol === 'https:' || (u.protocol === 'http:' && local)
      return secure && Vault.loginCoversHost(item.urls, u.hostname)
    } catch { return false }
  }
  const start = opts.url || (item.urls[0] ? (/^https?:\/\//.test(item.urls[0]) ? item.urls[0] : `https://${item.urls[0].replace(/^\*\./, '')}`) : '')
  if (!start) throw new Error(`"${item.title}" has no website saved, so OTPilot doesn't know where to sign in.`)
  if (!covers(start)) throw new Error(`${start} isn't one of "${item.title}"'s saved sites over HTTPS; OTPilot only signs in there.`)
  if (!password && !item.totp?.secret) throw new Error(`"${item.title}" gives this agent nothing to sign in with (allow its sign-in in OTPilot).`)

  const browser = await launch(opts.headless !== false)
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await settle(page)
    let filledSomething = false
    let submittedPassword = false
    let lastStep: 'username' | 'password' | 'otp' | null = null
    let note: string | undefined
    // Each step is submitted at most once: a page still asking for the same
    // thing after it means it was rejected (or needs a person), never a retry.
    const tried = new Set<'username' | 'password' | 'otp'>()
    for (let step = 0; step < 5; step++) {
      if (!covers(page.url())) {
        if (!filledSomething) throw new Error(`The site sent the browser to ${new URL(page.url()).hostname}, which isn't one of "${item.title}"'s saved sites. Nothing was filled.`)
        break // signed in and redirected elsewhere (an app domain): done
      }
      const otp = item.totp?.secret ? await firstVisible(page, OTP) : null
      const pass = await firstVisible(page, PASSWORD)
      // The code once the password went in, even if the password field
      // lingers on the page beside it.
      if (otp && (!pass || tried.has('password'))) {
        if (tried.has('otp')) break
        await otp.fill(await generateTOTP(item.totp!.secret, item.totp!.period || 30, item.totp!.digits || 6))
        await otp.press('Enter')
        filledSomething = true
        tried.add('otp')
        lastStep = 'otp'
        if (!(await moveOn(page, otp, null))) break
      } else if (pass) {
        if (tried.has('password')) break
        if (!password) { note = 'This agent may only use the 2FA code: sign in with the password yourself first.'; break }
        const user = await firstVisible(page, USER)
        if (user && username && (await user.inputValue()) !== username) await user.fill(username)
        await pass.fill(password)
        await pass.press('Enter')
        filledSomething = true
        submittedPassword = true
        tried.add('password')
        lastStep = 'password'
        if (!(await moveOn(page, pass, item.totp?.secret ? OTP : null))) break
      } else {
        const user = await firstVisible(page, USER)
        if (user && username && (await user.inputValue()) !== username && !tried.has('username')) {
          // A username-first sign-in: the password page comes next.
          await user.fill(username)
          await user.press('Enter')
          filledSomething = true
          tried.add('username')
          lastStep = 'username'
          if (!(await moveOn(page, user, PASSWORD))) break
        } else break
      }
      await settle(page)
    }
    const onSite = covers(page.url())
    const stillAsking = onSite && ((await firstVisible(page, PASSWORD)) || (item.totp?.secret && (await firstVisible(page, OTP))))
    // A sign-in that never got past the username (rejected, or a step OTPilot
    // can't see) isn't one: only a submitted password or code counts.
    const unfinished = lastStep === 'username' || (!submittedPassword && lastStep !== 'otp')
    if (!filledSomething || stillAsking || unfinished) {
      return {
        status: 'needs_user',
        url: page.url(),
        title: await page.title(),
        note: note || (filledSomething
          ? 'The site is still asking for credentials or a code (wrong password, a captcha, or a step OTPilot doesn\'t handle). Ask the user to sign in.'
          : 'No sign-in form found on the page.'),
      }
    }
    mkdirSync(opts.outDir, { recursive: true, mode: 0o700 })
    const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session'
    // One file per sign-in: two accounts (or two sign-ins) never share one.
    const file = resolve(join(opts.outDir, `${slug}-${item.id.slice(0, 8)}-${Date.now()}.json`))
    writeFileSync(file, JSON.stringify(await context.storageState()), { mode: 0o600 })
    chmodSync(file, 0o600)
    return { status: 'signed_in', url: page.url(), title: await page.title(), storageState: file }
  } finally {
    await browser.close().catch(() => {})
  }
}
