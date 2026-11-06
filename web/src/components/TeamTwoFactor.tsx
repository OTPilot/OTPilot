import { useId } from 'react'

const bullets = [
  'Live codes for each teammate',
  'Stop sharing at any time; remove a teammate and their access ends at once.',
  "Code use shows in the team activity log (team owner): views, and copies as reported by the teammate's app.",
]

function Diagram() {
  const uid = useId()
  const grad = `${uid}-grad`
  const arrow = `${uid}-arrow`
  return (
    <svg
      viewBox="0 0 480 280"
      className="w-full h-auto block"
      role="img"
      aria-label="Diagram: the owner's secret is encrypted and stored whole on OTPilot. Its encryption key is split in two: OTPilot holds one half, the teammate's app sends the other with each request. OTPilot rebuilds the key, decrypts the secret and makes a live code. The code goes to Luis and Marta; the secret never reaches teammates."
    >
      <defs>
        <linearGradient id={grad} x1="0" x2="1">
          <stop offset="0" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#10b981" />
        </linearGradient>
        <marker id={arrow} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0 0 8 4 0 8z" fill="#71717a" />
        </marker>
      </defs>
      <rect x="8" y="104" width="112" height="56" rx="10" fill="#16161f" stroke="rgba(255,255,255,.14)" />
      <text x="64" y="123" textAnchor="middle" fill="#f4f4f5" fontSize="13" fontWeight="600">Owner's secret</text>
      <text x="64" y="140" textAnchor="middle" fill="#a1a1aa" fontSize="10.5">encrypted, stored</text>
      <text x="64" y="153" textAnchor="middle" fill="#a1a1aa" fontSize="10.5">whole on OTPilot</text>
      <path d="M120 132 H142" stroke="#71717a" strokeWidth="1.5" markerEnd={`url(#${arrow})`} />
      <rect x="146" y="84" width="82" height="26" rx="6" fill="#101017" stroke="#a78bfa" />
      <text x="187" y="101" textAnchor="middle" fill="#a78bfa" fontSize="11">key half</text>
      <rect x="146" y="154" width="82" height="26" rx="6" fill="#101017" stroke="#a78bfa" />
      <text x="187" y="171" textAnchor="middle" fill="#a78bfa" fontSize="11">their key half</text>
      <path d="M228 97 L244 120" stroke="#71717a" strokeWidth="1.5" />
      <path d="M228 167 L244 144" stroke="#71717a" strokeWidth="1.5" />
      <rect x="248" y="96" width="104" height="72" rx="12" fill="rgba(20,184,166,.1)" stroke={`url(#${grad})`} strokeWidth="1.5" />
      <text x="300" y="127" textAnchor="middle" fill="#f4f4f5" fontSize="14" fontWeight="700">OTPilot</text>
      <text x="300" y="146" textAnchor="middle" fill="#2dd4bf" fontSize="12" fontFamily="ui-monospace,Menlo,monospace">live code</text>
      <path d="M352 120 L396 78" stroke="#2dd4bf" strokeWidth="1.5" markerEnd={`url(#${arrow})`} />
      <path d="M352 144 L396 186" stroke="#2dd4bf" strokeWidth="1.5" markerEnd={`url(#${arrow})`} />
      <rect x="400" y="54" width="72" height="44" rx="10" fill="#16161f" stroke="rgba(255,255,255,.14)" />
      <text x="436" y="73" textAnchor="middle" fill="#f4f4f5" fontSize="12" fontWeight="600">Luis</text>
      <text x="436" y="88" textAnchor="middle" fill="#2dd4bf" fontSize="11" fontFamily="ui-monospace,Menlo,monospace">518 204</text>
      <rect x="400" y="166" width="72" height="44" rx="10" fill="#16161f" stroke="rgba(255,255,255,.14)" />
      <text x="436" y="185" textAnchor="middle" fill="#f4f4f5" fontSize="12" fontWeight="600">Marta</text>
      <text x="436" y="200" textAnchor="middle" fill="#2dd4bf" fontSize="11" fontFamily="ui-monospace,Menlo,monospace">518 204</text>
      <path d="M64 168 V236 H380" fill="none" stroke="#52525b" strokeWidth="1.5" strokeDasharray="4 4" />
      <circle cx="392" cy="236" r="9" fill="#0a0a0f" stroke="#f87171" />
      <path d="M387 231l10 10M397 231l-10 10" stroke="#f87171" strokeWidth="1.8" />
      <text x="240" y="258" textAnchor="middle" fill="#a1a1aa" fontSize="13">the secret never reaches teammates</text>
    </svg>
  )
}

export default function TeamTwoFactor() {
  return (
    <section id="team-2fa" className="py-8 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center p-6 sm:p-10 rounded-2xl border border-white/8 bg-white/[0.02]">
          <div className="min-w-0">
            <span className="inline-block mb-2 text-xs font-semibold uppercase tracking-wider text-teal-300">
              Only in OTPilot
            </span>
            <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight leading-[1.15] mb-3">
              Share a 2FA code, not the secret.
            </h2>
            <p className="text-zinc-400 leading-relaxed mb-4">
              Your team signs in to the shared account with a live code. Teammates never receive the 2FA secret: they
              can't copy it, export it or add it to another app. Remove someone and their access ends at once.
            </p>
            <ul className="space-y-2 mb-3">
              {bullets.map(b => (
                <li key={b} className="flex gap-2.5 items-start text-sm text-zinc-300">
                  <svg className="w-[18px] h-[18px] mt-0.5 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m5 12 5 5 9-10" />
                  </svg>
                  {b}
                </li>
              ))}
            </ul>
            <a href="#pricing" className="inline-flex items-center min-h-11 font-medium text-teal-300 hover:text-white transition-colors">
              See Team Lite →
            </a>
          </div>
          <div className="min-w-0">
            <Diagram />
          </div>
        </div>
        <p className="mt-3.5 text-xs leading-relaxed text-zinc-500 max-w-4xl">
          Each shared secret is encrypted with a key split in two: OTPilot's server holds one half, each teammate's app
          the other. To make a code, the app sends its half; the server rebuilds the key, decrypts the secret, makes the
          code and discards both. So team 2FA codes are not end-to-end encrypted: our server sees the secret while it
          makes a code. Your personal vault, shared items and collections are end-to-end encrypted.
        </p>
      </div>
    </section>
  )
}
