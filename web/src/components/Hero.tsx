import { detectBrowser, browserMeta } from '../lib/browser'

export default function Hero() {
  const { label, href } = browserMeta[detectBrowser()]

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
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 text-black font-semibold hover:from-teal-400 hover:to-emerald-400 transition-all shadow-lg shadow-teal-500/20"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
            </svg>
            {label} — It's free
          </a>
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

        {/* Social proof */}
        <p className="mt-8 text-xs text-zinc-600">
          100% local by default · No account required · Open source
        </p>
      </div>
    </section>
  )
}
