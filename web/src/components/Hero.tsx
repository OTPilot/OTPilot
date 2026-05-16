import type { ReactElement } from 'react'
import { detectBrowser, browserMeta, CHROME_STORE_URL, type Browser } from '../lib/browser'

const BROWSER_ICONS: Record<Browser, ReactElement> = {
  chrome: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="#EA4335"/>
      <path d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0 0 10l-4.33 7.5A10 10 0 0 1 12 2z" fill="#34A853"/>
      <path d="M20.66 7H12a5 5 0 0 0-4.33 7.5L3.34 7A10 10 0 0 1 20.66 7z" fill="#4285F4"/>
      <circle cx="12" cy="12" r="4" fill="white"/>
      <circle cx="12" cy="12" r="3.2" fill="#1A73E8"/>
    </svg>
  ),
  edge: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
      <path d="M21 12.5C21 7.25 17 3 12 3 7.86 3 4.4 5.7 3.24 9.5H12c2.76 0 5 2.24 5 5 0 1.38-.56 2.63-1.46 3.54C17.85 17.2 21 15.1 21 12.5z" fill="#0078D4"/>
      <path d="M3 12.5c0 4.14 3.36 7.5 7.5 7.5 1.93 0 3.7-.73 5.04-1.96C14.56 17.13 14 15.88 14 14.5c0-1.38.56-2.63 1.46-3.54H8C5.24 10.96 3 11.6 3 12.5z" fill="#50E6FF"/>
    </svg>
  ),
  firefox: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9.5" fill="#FF9500"/>
      <path d="M18.5 8c-1-2.5-3.2-4-5.5-4-1.2 0-2.3.4-3.2 1-.9.6-1.6 1.4-2 2.3C6.5 8.7 6 10.3 6 12c0 3.3 2.7 6 6 6s6-2.7 6-6c0-1.4-.5-2.7-1.5-3.7L18.5 8z" fill="#FF6611"/>
      <path d="M12 5c1.7 0 3.2.8 4.2 2H12c-2.2 0-4 1.8-4 4 0 .7.2 1.4.5 2H7.2C6.4 11.7 6 10.9 6 10c0-2.8 2.7-5 6-5z" fill="#FFCC00"/>
    </svg>
  ),
  safari: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="#006CFF"/>
      <circle cx="12" cy="12" r="10" fill="url(#safari-grad)"/>
      <line x1="12" y1="3" x2="12" y2="21" stroke="white" strokeWidth="0.5" strokeOpacity="0.3"/>
      <line x1="3" y1="12" x2="21" y2="12" stroke="white" strokeWidth="0.5" strokeOpacity="0.3"/>
      <polygon points="12,6 13.5,12 12,10 10.5,12" fill="#FF3B30"/>
      <polygon points="12,18 10.5,12 12,14 13.5,12" fill="white"/>
      <defs>
        <radialGradient id="safari-grad" cx="50%" cy="30%">
          <stop offset="0%" stopColor="#40AFFF"/>
          <stop offset="100%" stopColor="#0055CC"/>
        </radialGradient>
      </defs>
    </svg>
  ),
  other: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="#EA4335"/>
      <path d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0 0 10l-4.33 7.5A10 10 0 0 1 12 2z" fill="#34A853"/>
      <path d="M20.66 7H12a5 5 0 0 0-4.33 7.5L3.34 7A10 10 0 0 1 20.66 7z" fill="#4285F4"/>
      <circle cx="12" cy="12" r="4" fill="white"/>
      <circle cx="12" cy="12" r="3.2" fill="#1A73E8"/>
    </svg>
  ),
}

const STRIP_BROWSERS: Browser[] = ['chrome', 'edge', 'firefox', 'safari']

export default function Hero() {
  const browser = detectBrowser()
  const meta = browserMeta[browser]

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-16">
      {/* Background glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-teal-500/10 rounded-full blur-[120px]" />
        <div className="absolute top-1/2 left-1/3 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-emerald-500/8 rounded-full blur-[100px]" />
      </div>

      {/* Grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      <div className="relative z-10 max-w-6xl mx-auto px-6 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-teal-500/20 bg-teal-500/5 text-teal-400 text-xs font-medium mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
          Now with Cloud Sync — Early Adopter pricing available
        </div>

        <h1 className="text-5xl md:text-7xl font-bold text-white tracking-tight mb-6 leading-[1.05]">
          Your 2FA codes,{' '}
          <span className="bg-gradient-to-r from-teal-400 to-emerald-400 bg-clip-text text-transparent">
            everywhere
          </span>
          <br />you are.
        </h1>

        <p className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          OTPilot auto-fills TOTP codes on any site. End-to-end encrypted, open source,
          and now synced across all your devices.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          {meta.available ? (
            <a
              href={meta.href!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2.5 px-6 py-3 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 text-black font-semibold hover:from-teal-400 hover:to-emerald-400 transition-all shadow-lg shadow-teal-500/20"
            >
              {BROWSER_ICONS[browser]}
              Add to {meta.name} — It's free
            </a>
          ) : (
            <>
              <span className="inline-flex items-center gap-2.5 px-6 py-3 rounded-xl bg-zinc-800/60 border border-zinc-700/50 text-zinc-500 font-semibold cursor-not-allowed select-none">
                {BROWSER_ICONS[browser]}
                {meta.name} — Coming soon
              </span>
              <a
                href={CHROME_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2.5 px-6 py-3 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 text-black font-semibold hover:from-teal-400 hover:to-emerald-400 transition-all shadow-lg shadow-teal-500/20"
              >
                {BROWSER_ICONS.chrome}
                Get for Chrome instead
              </a>
            </>
          )}
          <a
            href="#pricing"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-white/10 text-zinc-300 text-sm font-medium hover:border-white/20 hover:text-white transition-all"
          >
            See cloud plans
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </a>
        </div>

        {/* Browser compatibility strip */}
        <div className="mt-8 flex items-center justify-center gap-5">
          {STRIP_BROWSERS.map(b => {
            const m = browserMeta[b]
            return m.available ? (
              <a
                key={b}
                href={m.href!}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                {BROWSER_ICONS[b]}
                {m.name}
              </a>
            ) : (
              <span key={b} className="flex items-center gap-1.5 text-xs text-zinc-700">
                {BROWSER_ICONS[b]}
                {m.name}
                <span className="text-zinc-700 font-medium">· soon</span>
              </span>
            )
          })}
        </div>

        <p className="mt-5 text-xs text-zinc-600">
          100% local by default · No account required · Open source
        </p>
      </div>
    </section>
  )
}
