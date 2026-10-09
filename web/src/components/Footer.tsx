import Logo from './Logo'
import { GUIDES } from '../pages/guides/guides'

const link = 'text-sm text-zinc-500 hover:text-zinc-300 transition-colors'

// Columns of links: the product, the search pages (src/pages/guides/guides.ts)
// grouped by kind, and the company / legal pages.
const COLUMNS: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: 'Product',
    links: [
      { href: '/#features', label: 'Features' },
      { href: '/#pricing', label: 'Pricing' },
      { href: '/#faq', label: 'FAQ' },
      { href: '/security', label: 'Security' },
    ],
  },
  { title: 'Compare', links: GUIDES.filter(g => g.kind === 'compare').map(g => ({ href: g.path, label: g.nav })) },
  { title: 'Guides', links: GUIDES.filter(g => g.kind === 'guide').map(g => ({ href: g.path, label: g.nav })) },
  {
    title: 'Company',
    links: [
      { href: 'mailto:hello@otpilot.app', label: 'Contact' },
      { href: 'https://github.com/otpilot-app/otpilot', label: 'GitHub', external: true },
      { href: '/tos', label: 'Terms of Service' },
      { href: '/privacy', label: 'Privacy Policy' },
      { href: '/gdpr', label: 'GDPR' },
      { href: '/refunds', label: 'Refund Policy' },
    ],
  },
]

export default function Footer() {
  return (
    <footer className="border-t border-white/5 py-14 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-[1.3fr_repeat(4,1fr)] gap-x-8 gap-y-10">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2.5 mb-3">
              <Logo size={24} className="rounded-md" />
              <span className="text-sm font-semibold text-zinc-300">OTPilot</span>
            </div>
            <p className="text-sm text-zinc-500 leading-relaxed max-w-xs">
              Password manager with built-in 2FA. Fills your password and your 2FA code on any login page.
            </p>
            <div className="flex items-center gap-4 mt-5">
              <a
                href="https://x.com/otpilotapp"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="OTPilot on X"
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
                </svg>
              </a>
              <a
                href="https://www.youtube.com/@otpilotapp"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="OTPilot on YouTube"
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814ZM9.546 15.568V8.432L15.818 12l-6.273 3.568Z" />
                </svg>
              </a>
            </div>
          </div>

          {COLUMNS.filter(c => c.links.length > 0).map((c) => (
            <nav key={c.title} aria-label={c.title}>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-4">{c.title}</h2>
              <ul className="space-y-2.5">
                {c.links.map((l) => (
                  <li key={l.href}>
                    <a
                      href={l.href}
                      className={link}
                      {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <p className="text-xs text-zinc-600 mt-12">© {new Date().getFullYear()} OTPilot</p>
      </div>
    </footer>
  )
}
