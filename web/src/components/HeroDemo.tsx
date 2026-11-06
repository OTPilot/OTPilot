import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useReducedMotion } from '../lib/useReducedMotion'

// Hard-coded demo values only: nothing here reads the clock or a random source
// while rendering, so the prerendered HTML and the first client render match.

// ── Login scene ─────────────────────────────────────────────────────────────
const DEMO_USER = 'user@example.com'
const DEMO_CODE = '482913'
const PW_LEN = 12

type LoginState = {
  phase: 1 | 2 | 3
  uFocus: boolean
  caret: boolean
  drop: boolean
  u: number
  pwFocus: boolean
  pw: number
  ready: boolean
  code: number
  verify: boolean
}
type LoginFrame = LoginState & { ms: number }

const LOGIN: LoginFrame[] = (() => {
  const frames: LoginFrame[] = []
  let s: LoginState = { phase: 1, uFocus: false, caret: false, drop: false, u: 0, pwFocus: false, pw: 0, ready: false, code: 0, verify: false }
  const push = (patch: Partial<LoginState>, ms: number) => {
    s = { ...s, ...patch }
    frames.push({ ...s, ms })
  }
  push({}, 500)
  push({ uFocus: true, caret: true }, 500)
  push({ drop: true }, 1300)
  for (let i = 1; i <= DEMO_USER.length; i++) push({ drop: false, caret: false, u: i }, 28)
  for (let i = 1; i <= PW_LEN; i++) push({ uFocus: false, pwFocus: true, pw: i }, 40)
  push({ ready: true }, 700)
  push({ pwFocus: false, phase: 2 }, 1100)
  for (let i = 1; i <= DEMO_CODE.length; i++) push({ code: i }, 90)
  push({ verify: true }, 600)
  push({ phase: 3 }, 2600)
  return frames
})()
const LOGIN_LAST = LOGIN.length - 1

// ── Team scene ──────────────────────────────────────────────────────────────
const TEAM_CODES = ['518 204', '730 961', '264 587']

// ── Terminal scene ──────────────────────────────────────────────────────────
type Seg = { t: string; c?: string }
type TermLine = { kind: 'cmd' | 'out' | 'gap'; segs: Seg[] }

const DIM = 'text-zinc-500'
const OK = 'text-emerald-400'
const PR = 'text-teal-400'
const VI = 'text-violet-400'

const SCRIPT: TermLine[] = [
  { kind: 'cmd', segs: [{ t: '$', c: PR }, { t: ' npx -y @otpilot/mcp@latest connect --name "Claude Code"' }] },
  { kind: 'out', segs: [{ t: '  Verification code: ' }, { t: 'K7QD-2MXP', c: VI }] },
  { kind: 'out', segs: [{ t: '  ' }, { t: '→ matches in the extension', c: DIM }, { t: ' ' }, { t: '✓ approved', c: OK }] },
  { kind: 'gap', segs: [] },
  { kind: 'cmd', segs: [{ t: '>', c: PR }, { t: ' browser_login("Example app")' }] },
  { kind: 'out', segs: [{ t: '  ' }, { t: '✓', c: OK }, { t: ' signed in on example.com ' }, { t: '— no password returned', c: DIM }] },
  { kind: 'gap', segs: [] },
  { kind: 'cmd', segs: [{ t: '>', c: PR }, { t: ' run deploy --env API_KEY=example/api-key' }] },
  { kind: 'out', segs: [{ t: '  authenticated with API_KEY=' }, { t: '[REDACTED]', c: VI }, { t: ' ' }, { t: '· exit 0', c: DIM }] },
]

// `lines` complete lines are shown; `typed` chars of the next (a command) are being typed.
type TermFrame = { lines: number; typed: number | null; ms: number }

const cmdRest = (l: TermLine) => l.segs.slice(1).map(s => s.t).join('')

const TERM: TermFrame[] = (() => {
  const frames: TermFrame[] = []
  SCRIPT.forEach((line, i) => {
    if (line.kind === 'cmd') {
      const rest = cmdRest(line)
      for (let n = 0; n <= rest.length; n++) frames.push({ lines: i, typed: n, ms: 16 })
      frames.push({ lines: i + 1, typed: null, ms: 450 })
    } else {
      frames.push({ lines: i + 1, typed: null, ms: line.kind === 'out' ? 350 : 120 })
    }
  })
  frames[frames.length - 1].ms = 4200
  return frames
})()
const TERM_LAST = TERM.length - 1

// ── Shared bits ─────────────────────────────────────────────────────────────
const TABS = ['For you', 'For your team', 'For your AI agents']
const AUTO_ADVANCE_MS = 8000

const subscribeNever = () => () => {}
const onClient = () => true
const onServer = () => false

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
const docVisible = () => document.visibilityState !== 'hidden'

const RING = 87.96 // 2πr, r = 14

function Ring({ secs }: { secs: number }) {
  return (
    <div className="relative ml-auto w-[34px] h-[34px] shrink-0">
      <svg className="w-[34px] h-[34px] -rotate-90" viewBox="0 0 34 34" aria-hidden="true">
        <circle cx="17" cy="17" r="14" fill="none" strokeWidth="3" className="stroke-white/10" />
        <circle
          cx="17" cy="17" r="14" fill="none" strokeWidth="3" strokeLinecap="round"
          className="stroke-teal-400"
          strokeDasharray={RING}
          strokeDashoffset={(RING * (1 - secs / 30)).toFixed(1)}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[10px] text-zinc-400 tabular-nums">{secs}</span>
    </div>
  )
}

const LockIcon = ({ className }: { className: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
)
const ShieldIcon = ({ className }: { className: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3z" />
  </svg>
)

function Frame({ url, mono, caption, children }: { url: string; mono?: boolean; caption?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col h-[480px] rounded-2xl border border-white/14 bg-zinc-950 shadow-2xl shadow-black/60 overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 py-3 bg-zinc-900 border-b border-white/8">
        <div className="flex gap-1.5" aria-hidden="true">
          <i className="w-[11px] h-[11px] rounded-full bg-rose-400/80" />
          <i className="w-[11px] h-[11px] rounded-full bg-amber-400/80" />
          <i className="w-[11px] h-[11px] rounded-full bg-emerald-400/80" />
        </div>
        <div className={`flex-1 min-w-0 flex items-center gap-1.5 px-3 py-[5px] rounded-md bg-[#0a0a0f] text-xs text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis ${mono ? 'font-mono' : ''}`}>
          {!mono && <LockIcon className="w-[11px] h-[11px] shrink-0 text-emerald-400" />}
          {url}
        </div>
      </div>
      {children}
      {caption && (
        <p className="m-0 px-4 py-3 border-t border-white/8 flex items-center gap-2 text-xs text-zinc-400">
          <ShieldIcon className="w-3.5 h-3.5 shrink-0 text-teal-400" />
          <span className="min-w-0">{caption}</span>
        </p>
      )}
    </div>
  )
}

const FIELD = 'relative h-10 mb-3 px-3 flex items-center rounded-lg border bg-[#0a0a0f] text-sm transition-[border-color,box-shadow] duration-200'
const fieldState = (focus: boolean) => (focus ? 'border-teal-500 ring-[3px] ring-teal-500/20' : 'border-white/14')
const SUBMIT = 'h-10 grid place-items-center rounded-lg text-sm font-medium transition-colors duration-200'
const submitState = (ready: boolean) => (ready ? 'bg-gradient-to-r from-teal-500 to-emerald-500 text-black' : 'bg-zinc-800 text-zinc-400')
const CARET = "after:content-[''] after:inline-block after:w-px after:h-4 after:ml-px after:align-middle after:bg-teal-400 after:animate-blink"

function SiteHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <div className="flex items-center gap-2 mb-3.5 text-[15px] font-semibold text-zinc-200">
        <i className="w-[22px] h-[22px] rounded-md bg-zinc-700" />Example
      </div>
      <h3 className="mb-1 text-lg font-semibold text-white">{title}</h3>
      <p className="mb-4 text-xs text-zinc-500">{sub}</p>
    </>
  )
}

function LoginScene({ f }: { f: LoginState }) {
  return (
    <div className="w-full max-w-[330px] mx-auto">
      {f.phase === 1 && (
        <div className="animate-fade-in">
          <SiteHeader title="Sign in" sub="Welcome back" />
          <span className="block mb-1.5 text-xs text-zinc-400">Email</span>
          <div className={`${FIELD} ${fieldState(f.uFocus)}`}>
            <span className={f.caret ? CARET : ''}>{DEMO_USER.slice(0, f.u)}</span>
            <span className="ml-auto grid place-items-center w-5 h-5 shrink-0 rounded-[5px] bg-gradient-to-br from-teal-500 to-emerald-500 text-black">
              <ShieldIcon className="w-3 h-3" />
            </span>
            <div
              className={`absolute left-0 right-0 top-[calc(100%+6px)] z-10 p-1.5 rounded-[10px] border border-white/14 bg-zinc-900 shadow-xl shadow-black/50 transition-[opacity,transform] duration-200 ${
                f.drop ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
              }`}
            >
              <div className="flex items-center gap-2.5 p-2 rounded-md bg-teal-500/12">
                <span className="grid place-items-center w-7 h-7 rounded-md bg-zinc-700 text-xs font-semibold">E</span>
                <span className="text-[13px] leading-tight">Example<small className="block text-[11px] text-zinc-400">{DEMO_USER}</small></span>
              </div>
              <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[10px] text-zinc-500">
                <ShieldIcon className="w-2.5 h-2.5" />OTPilot
              </div>
            </div>
          </div>
          <span className="block mb-1.5 text-xs text-zinc-400">Password</span>
          <div className={`${FIELD} ${fieldState(f.pwFocus)}`}>
            <span className="tracking-[3px] text-[13px]">{'•'.repeat(f.pw)}</span>
          </div>
          <div className={`${SUBMIT} ${submitState(f.ready)}`}>Continue</div>
        </div>
      )}
      {f.phase === 2 && (
        <div className="animate-fade-in">
          <SiteHeader title="Two-factor code" sub="Enter the 6-digit code from your authenticator" />
          <div className="flex items-center gap-3 mb-3 px-3 py-2.5 rounded-[10px] border border-white/14 bg-zinc-900">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">OTPilot · Example</div>
              <div className="font-mono text-xl font-semibold tracking-[.12em] text-teal-400">482 913</div>
            </div>
            <Ring secs={21} />
          </div>
          <span className="block mb-1.5 text-xs text-zinc-400">Code</span>
          <div className={`${FIELD} ${fieldState(true)}`}>
            <span className="font-mono text-base tracking-[.3em]">{DEMO_CODE.slice(0, f.code)}</span>
          </div>
          <div className={`${SUBMIT} ${submitState(f.verify)}`}>Verify</div>
        </div>
      )}
      {f.phase === 3 && (
        <div className="animate-fade-in text-center">
          <div className="grid place-items-center w-14 h-14 mx-auto mb-3.5 rounded-full border border-emerald-400/40 bg-emerald-400/12 text-emerald-400">
            <svg className="w-[26px] h-[26px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 12 5 5 9-10" />
            </svg>
          </div>
          <b className="block mb-1 text-[17px] text-white">Signed in</b>
          <span className="text-[13px] text-zinc-400">Welcome back, {DEMO_USER}</span>
        </div>
      )}
    </div>
  )
}

function TeamScene({ tick }: { tick: number }) {
  const secs = 30 - (tick % 30)
  const code = TEAM_CODES[Math.floor(tick / 30) % TEAM_CODES.length]
  return (
    <div className="w-full max-w-[340px] mx-auto grid gap-2.5">
      <div className="p-3.5 rounded-xl border border-white/14 bg-zinc-900">
        <div className="flex items-center gap-2.5 mb-2.5">
          <span className="grid place-items-center w-[30px] h-[30px] shrink-0 rounded-lg bg-zinc-700 text-[11px] font-bold">AW</span>
          <span className="text-sm font-semibold leading-tight text-white">
            AWS root · shared by Ana<small className="block text-[11px] font-normal text-zinc-400">Team 2FA code</small>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[26px] font-semibold tracking-[.12em] text-teal-400">{code}</span>
          <Ring secs={secs} />
          <span className="inline-flex items-center min-h-9 px-3.5 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-500 text-[13px] font-semibold text-black">
            Copy
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-3 text-xs text-zinc-500">
          <LockIcon className="w-[13px] h-[13px] shrink-0" />Secret: not shared with teammates
        </div>
      </div>
      <div className="flex items-center gap-2 px-1 text-xs text-zinc-500">
        <i className="w-1.5 h-1.5 shrink-0 rounded-full bg-emerald-400" />Live code · refreshes every 30 s
      </div>
    </div>
  )
}

function TermScene({ f }: { f: TermFrame }) {
  const typing = f.typed !== null ? SCRIPT[f.lines] : null
  return (
    <div className="w-full self-start font-mono text-[12.5px] leading-[1.65] text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">
      {SCRIPT.slice(0, f.lines).map((line, i) => (
        <span key={i} className="block min-h-[1.65em]">
          {line.segs.map((s, j) => <span key={j} className={s.c}>{s.t}</span>)}
        </span>
      ))}
      {typing && (
        <span className="block min-h-[1.65em]">
          <span className={typing.segs[0].c}>{typing.segs[0].t}</span>
          <span className={CARET}>{cmdRest(typing).slice(0, f.typed ?? 0)}</span>
        </span>
      )}
    </div>
  )
}

export default function HeroDemo({ tab, onTabChange }: { tab: number; onTabChange: (tab: number) => void }) {
  const uid = useId()
  const tabId = (i: number) => `${uid}tab${i}`
  const panelId = (i: number) => `${uid}panel${i}`

  const hydrated = useSyncExternalStore(subscribeNever, onClient, onServer)
  const reduced = useReducedMotion()
  const visible = useSyncExternalStore(subscribeVisibility, docVisible, onClient)
  const [onScreen, setOnScreen] = useState(false)
  const [auto, setAuto] = useState(true)
  const [loginStep, setLoginStep] = useState(0)
  const [teamTick, setTeamTick] = useState(0)
  const [termStep, setTermStep] = useState(TERM_LAST)
  const rootRef = useRef<HTMLDivElement>(null)

  // Reduced motion shows the final frames (only once hydrated: the
  // prerendered HTML is the login scene's first step).
  const still = hydrated && reduced
  const running = hydrated && !reduced && visible && onScreen

  const select = useCallback((i: number) => {
    onTabChange(i)
    if (i === 0) setLoginStep(0)
    if (i === 2) setTermStep(0)
  }, [onTabChange])

  const stopAuto = () => setAuto(false)

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => {
      for (const e of entries) setOnScreen(e.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!auto || !running) return
    const id = setTimeout(() => select((tab + 1) % TABS.length), AUTO_ADVANCE_MS)
    return () => clearTimeout(id)
  }, [auto, running, tab, select])

  useEffect(() => {
    if (!running || tab !== 0) return
    const id = setTimeout(() => setLoginStep(s => (s + 1) % LOGIN.length), LOGIN[loginStep].ms)
    return () => clearTimeout(id)
  }, [running, tab, loginStep])

  useEffect(() => {
    if (!running || tab !== 1) return
    const id = setInterval(() => setTeamTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [running, tab])

  useEffect(() => {
    if (!running || tab !== 2) return
    const id = setTimeout(() => setTermStep(s => (s + 1) % TERM.length), TERM[termStep].ms)
    return () => clearTimeout(id)
  }, [running, tab, termStep])

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let n: number | null = null
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = TABS.length - 1
    if (n === null) return
    e.preventDefault()
    stopAuto()
    select(n)
    document.getElementById(tabId(n))?.focus()
  }

  const login = LOGIN[still ? LOGIN_LAST : loginStep]
  const term = TERM[still ? TERM_LAST : termStep]

  return (
    <div ref={rootRef} className="min-w-0" onPointerDown={stopAuto} onFocus={stopAuto}>
      <div role="tablist" aria-label="Product demo" className="inline-flex max-w-full p-1 mb-3.5 rounded-xl border border-white/8 bg-zinc-950">
        {TABS.map((label, i) => (
          <button
            key={label}
            type="button"
            role="tab"
            id={tabId(i)}
            aria-controls={panelId(i)}
            aria-selected={tab === i}
            tabIndex={tab === i ? 0 : -1}
            onClick={() => { stopAuto(); select(i) }}
            onKeyDown={e => onTabKey(e, i)}
            className={`min-h-11 px-2 sm:px-3.5 whitespace-nowrap rounded-[9px] text-[12.5px] sm:text-sm font-medium cursor-pointer transition-colors ${
              tab === i ? 'bg-zinc-800 text-white ring-1 ring-inset ring-white/14' : 'text-zinc-400 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div id={panelId(0)} role="tabpanel" aria-labelledby={tabId(0)} hidden={tab !== 0} tabIndex={0}>
        <Frame url="accounts.example.com/login">
          <div
            className="relative flex-1 min-h-0 grid place-items-center px-5 py-7 sm:px-7 overflow-hidden"
            role="img"
            aria-label="Animated demo: OTPilot fills a username, a password and a two-factor code, then the site shows Signed in."
          >
            <LoginScene f={login} />
          </div>
        </Frame>
      </div>

      <div id={panelId(1)} role="tabpanel" aria-labelledby={tabId(1)} hidden={tab !== 1} tabIndex={0}>
        <Frame url="console.aws.example.com/signin" caption="Teammates get the code, never the secret.">
          <div
            className="relative flex-1 min-h-0 grid place-items-center px-5 py-7 sm:px-7 overflow-hidden"
            role="img"
            aria-label="Demo: a teammate's OTPilot shows the shared 2FA code for AWS root, shared by Ana, with a countdown. The secret is not shared with teammates. Live code, refreshes every 30 seconds."
          >
            <TeamScene tick={still ? 0 : teamTick} />
          </div>
        </Frame>
      </div>

      <div id={panelId(2)} role="tabpanel" aria-labelledby={tabId(2)} hidden={tab !== 2} tabIndex={0}>
        <Frame
          url="claude-code — terminal"
          mono
          caption={<>
            Every use through OTPilot's tools is logged. No tool returns a secret — a command you allow could still print one.{' '}
            <a href="#ai-agents" className="whitespace-nowrap font-medium text-teal-300 hover:text-white transition-colors">Limits →</a>
          </>}
        >
          <div
            className="relative flex-1 min-h-0 grid items-start px-5 py-7 sm:px-7 overflow-hidden"
            role="img"
            aria-label="Terminal demo: an AI agent connects through the OTPilot MCP server, signs in to a site without receiving the password, and runs a command with a redacted API key."
          >
            <TermScene f={term} />
          </div>
        </Frame>
      </div>
    </div>
  )
}
