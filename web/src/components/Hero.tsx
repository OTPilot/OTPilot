import { useState } from 'react'
import { useBrowser, browserMeta, type Browser } from '../lib/browser'
import HeroDemo from './HeroDemo'

function BrowserIcon({ browser }: { browser: Browser }) {
  switch (browser) {
    case 'edge':
      return (
        <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M21 12.5C21 7.25 17 3 12 3 7.86 3 4.4 5.7 3.24 9.5H12c2.76 0 5 2.24 5 5 0 1.38-.56 2.63-1.46 3.54C17.85 17.2 21 15.1 21 12.5z" fill="#0078D4"/>
          <path d="M3 12.5c0 4.14 3.36 7.5 7.5 7.5 1.93 0 3.7-.73 5.04-1.96C14.56 17.13 14 15.88 14 14.5c0-1.38.56-2.63 1.46-3.54H8C5.24 10.96 3 11.6 3 12.5z" fill="#50E6FF"/>
        </svg>
      )
    default:
      return (
        <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#EA4335"/>
          <path d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0 0 10l-4.33 7.5A10 10 0 0 1 12 2z" fill="#34A853"/>
          <path d="M20.66 7H12a5 5 0 0 0-4.33 7.5L3.34 7A10 10 0 0 1 20.66 7z" fill="#4285F4"/>
          <circle cx="12" cy="12" r="4" fill="white"/>
          <circle cx="12" cy="12" r="3.2" fill="#1A73E8"/>
        </svg>
      )
  }
}

function Arrow({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  )
}

const ICON = 'w-4 h-4'
const iconProps = { fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

// The 4th trust item follows the demo's tab.
const TRUST_4 = [
  'AI agents only with your approval',
  'Teammates get the code, never the secret',
  'Approved per account, revocable',
]

// Only the browsers the extension ships on.
const STRIP: Browser[] = ['chrome', 'edge']

const PRIMARY = 'inline-flex items-center gap-2.5 min-h-12 px-6 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 text-black font-semibold hover:from-teal-400 hover:to-emerald-400 transition-colors shadow-lg shadow-teal-500/20'

export default function Hero() {
  const browser = useBrowser()
  // No store listing (Firefox, Safari…): the Chrome CTA, as on 'other'.
  const shown: Browser = browserMeta[browser].available ? browser : 'other'
  const meta = browserMeta[shown]
  const [tab, setTab] = useState(0)

  const trust = [
    { text: 'AES-256-GCM on your device', icon: <svg className={ICON} {...iconProps}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg> },
    { text: 'Master password never leaves it', icon: <svg className={ICON} {...iconProps}><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3"/></svg> },
    { text: 'Open source', icon: <svg className={ICON} {...iconProps}><path d="m8 7-5 5 5 5M16 7l5 5-5 5"/></svg> },
    { text: TRUST_4[tab], icon: <svg className={ICON} {...iconProps}><path d="M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/></svg> },
  ]

  return (
    <section className="relative overflow-hidden pt-[104px] pb-14 lg:pt-[120px] lg:pb-[72px]">
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute top-1/3 left-1/3 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-teal-500/10 rounded-full blur-[120px]" />
        <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[420px] h-[420px] bg-emerald-500/8 rounded-full blur-[100px]" />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-6 grid gap-12 items-center lg:grid-cols-[minmax(0,1fr)_minmax(0,1.02fr)] lg:gap-14">
        <div>
          <a href="#ai-agents" className="inline-flex items-center gap-2 min-h-11 mb-1 text-[13px] text-zinc-400 hover:text-white transition-colors">
            <span className="font-semibold text-violet-400">2.1</span> · AI agents
            <Arrow className="w-3.5 h-3.5" />
          </a>

          <h1 className="mb-4 text-[clamp(38px,5.2vw,60px)] font-bold text-white tracking-tight leading-[1.06]">
            Password manager with{' '}
            <span className="bg-gradient-to-r from-teal-400 to-emerald-400 bg-clip-text text-transparent">built-in 2FA</span>
            <span className="block mt-3.5 text-[clamp(19px,2.2vw,24px)] leading-snug font-normal tracking-normal text-zinc-400">
              …and a safe way to let your AI agents sign in.
            </span>
          </h1>

          <p className="mt-5 mb-7 max-w-[34em] text-lg leading-relaxed text-zinc-400">
            Fills your password and your 2FA code on any login page. End-to-end encrypted. Free to start; sync across
            devices with Personal.
          </p>

          <div className="flex flex-wrap gap-3">
            <a href={meta.href!} target="_blank" rel="noopener noreferrer" className={PRIMARY}>
              <BrowserIcon browser={shown} />
              Add to {meta.name} — It's free
            </a>
            <a
              href="#security"
              className="inline-flex items-center gap-2 min-h-12 px-[22px] rounded-xl border border-white/14 text-sm font-medium text-zinc-300 hover:border-white/28 hover:text-white transition-colors"
            >
              How it keeps you safe
              <Arrow />
            </a>
          </div>

          <ul className="mt-8 grid gap-x-5 gap-y-1 sm:grid-cols-2">
            {trust.map((t, i) => (
              <li key={i}>
                <a href="#security" className="flex items-center gap-2.5 min-h-11 text-sm text-zinc-300 hover:text-white transition-colors">
                  <span className="grid place-items-center shrink-0 w-[30px] h-[30px] rounded-lg bg-teal-500/10 border border-teal-400/20 text-teal-400">
                    {t.icon}
                  </span>
                  <span>{t.text}</span>
                </a>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1">
            {STRIP.map(b => (
              <a
                key={b}
                href={browserMeta[b].href!}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 min-h-11 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <BrowserIcon browser={b} />
                {browserMeta[b].name}
              </a>
            ))}
          </div>
          <p className="mt-1 text-xs text-zinc-500">No account required for the vault.</p>
        </div>

        <HeroDemo tab={tab} onTabChange={setTab} />
      </div>
    </section>
  )
}
