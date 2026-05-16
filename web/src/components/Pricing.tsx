import { useState } from 'react'
import { detectBrowser, browserMeta } from '../lib/browser'

export default function Pricing() {
  const [yearly, setYearly] = useState(false)
  const { label: browserLabel, href: browserHref } = browserMeta[detectBrowser()]

  const plans = [
    {
      name: 'Free',
      price: '$0',
      priceNote: 'forever',
      description: 'Everything you need for personal use, locally.',
      cta: browserLabel,
      ctaHref: browserHref,
      ctaExternal: true,
      highlight: false,
      features: [
        'Unlimited TOTP accounts',
        'Auto-fill on any site',
        'Auto-detect 2FA setup',
        'Master password lock',
        'Local encrypted backup',
        'Chrome, Firefox & Edge',
      ],
    },
    {
      name: 'Personal Cloud',
      price: '$15',
      priceLabel: 'one-time payment',
      priceNote: 'your price, locked in forever',
      annualEquiv: 'No future charges for you',
      description: 'Sync your accounts across every browser and device.',
      cta: 'Lock in Early Adopter access',
      ctaHref: '#',
      ctaExternal: false,
      highlight: true,
      badge: 'Early Adopter',
      features: [
        'Everything in Free',
        'End-to-end encrypted sync',
        'Multi-device, multi-browser',
        'Cloud backup',
      ],
    },
    {
      name: 'Team Lite',
      price: yearly ? '$80' : '$8',
      priceNote: yearly ? 'per workspace / year' : 'per workspace / month',
      annualEquiv: yearly ? 'Save 2 months vs monthly' : undefined,
      description: 'Shared 2FA for small teams and startups.',
      cta: 'Start team plan',
      ctaHref: '#',
      ctaExternal: false,
      highlight: false,
      features: [
        'Everything in Personal',
        '5 seats included',
        'Shared TOTP accounts',
        'Invite & revoke access',
        '+$2 / extra seat / month',
      ],
    },
  ]

  return (
    <section id="pricing" className="py-24 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">
            Simple, honest pricing
          </h2>
          <p className="text-zinc-400 mb-8">
            Start free. Upgrade when you need more.
          </p>

          {/* Toggle — only relevant for Team */}
          <div className="inline-flex items-center gap-3 p-1 rounded-xl bg-white/5 border border-white/10">
            <button
              onClick={() => setYearly(false)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                !yearly ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setYearly(true)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                yearly ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Yearly
              <span className="text-xs px-1.5 py-0.5 rounded-md bg-teal-500/20 text-teal-400">
                Save 2 months
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-2xl p-6 flex flex-col ${
                plan.highlight
                  ? 'bg-gradient-to-b from-teal-500/10 to-emerald-500/5 border border-teal-500/30'
                  : 'bg-white/[0.03] border border-white/8'
              }`}
            >
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="px-3 py-1 rounded-full text-xs font-medium bg-gradient-to-r from-teal-500 to-emerald-500 text-black">
                    {plan.badge}
                  </span>
                </div>
              )}

              <div className="mb-6">
                <h3 className={`font-semibold mb-3 ${plan.highlight ? 'text-teal-300' : 'text-zinc-300'}`}>
                  {plan.name}
                </h3>

                {/* Price block */}
                {'priceLabel' in plan && plan.priceLabel ? (
                  // Lifetime deal: label first, then price
                  <div className="mb-1">
                    <span className="inline-block text-xs font-semibold uppercase tracking-wider text-teal-400 mb-1.5">
                      {plan.priceLabel}
                    </span>
                    <div className="flex items-end gap-1.5">
                      <span className="text-4xl font-bold text-white">{plan.price}</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-end gap-1.5 mb-1">
                    <span className="text-4xl font-bold text-white">{plan.price}</span>
                  </div>
                )}

                <p className="text-xs text-zinc-500">{plan.priceNote}</p>
                {'annualEquiv' in plan && plan.annualEquiv && (
                  <p className="text-xs text-teal-400/70 mt-0.5">{plan.annualEquiv}</p>
                )}

                <p className="text-sm text-zinc-400 mt-3 leading-relaxed">{plan.description}</p>
              </div>

              <ul className="space-y-2.5 flex-1 mb-8">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-300">
                    <svg className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>

              <a
                href={plan.ctaHref}
                target={plan.ctaExternal ? '_blank' : undefined}
                rel={plan.ctaExternal ? 'noopener noreferrer' : undefined}
                className={`w-full py-2.5 rounded-xl text-sm font-semibold text-center transition-all ${
                  plan.highlight
                    ? 'bg-gradient-to-r from-teal-500 to-emerald-500 text-black hover:from-teal-400 hover:to-emerald-400'
                    : 'bg-white/8 text-white hover:bg-white/12 border border-white/10'
                }`}
              >
                {plan.cta}
              </a>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-zinc-600 mt-8">
          All plans include a 14-day refund window for technical issues.{' '}
          <a href="/refunds" className="underline hover:text-zinc-400 transition-colors">Refund policy →</a>
        </p>
      </div>
    </section>
  )
}
