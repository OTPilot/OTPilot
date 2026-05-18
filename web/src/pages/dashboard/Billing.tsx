import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../lib/api'

type UserData = { id: string; plan: string; created_at: string }

function useUserPlan(forceRefresh: boolean) {
  return useQuery<UserData>({
    queryKey: ['user-plan'],
    queryFn: async () => {
      const res = await apiFetch('/auth/sync-user', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to load plan')
      return res.json()
    },
    staleTime: forceRefresh ? 0 : 60_000,
    refetchOnMount: forceRefresh ? 'always' : true,
  })
}

export default function Billing() {
  const [params] = useSearchParams()
  const justUpgraded = params.get('upgraded') === '1'
  const { data: userData, isLoading } = useUserPlan(justUpgraded)
  const [upgrading, setUpgrading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleUpgrade() {
    setUpgrading(true)
    setError(null)
    try {
      const res = await apiFetch('/billing/checkout', { method: 'POST' })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Checkout failed')
      const { url } = await res.json()
      window.location.href = url
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setUpgrading(false)
    }
  }

  const plan = userData?.plan ?? 'free'
  const isPaid = plan !== 'free'

  const freePlanFeatures = [
    'Unlimited TOTP accounts',
    'Auto-fill on any site',
    'Auto-detect 2FA setup',
    'Master password lock',
    'Local encrypted backup',
    'Chrome, Firefox & Edge',
  ]

  const personalFeatures = [
    'Everything in Free',
    'End-to-end encrypted sync',
    'Multi-device, multi-browser',
    'Cloud backup',
  ]

  const teamFeatures = [
    'Everything in Personal',
    '5 seats included',
    'Shared TOTP accounts',
    'Invite & revoke access',
    '+$2 / extra seat / month',
  ]

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-zinc-100">Billing</h1>

      {justUpgraded && (
        <div className="rounded-lg border border-teal-500/30 bg-teal-500/10 px-4 py-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-teal-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-sm text-teal-300">Payment confirmed — you're on the Personal plan!</p>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* Free */}
        <PlanCard
          name="Free"
          price="$0"
          priceNote="forever"
          features={freePlanFeatures}
          current={plan === 'free'}
          highlight={false}
          cta={plan === 'free' ? 'Current plan' : null}
          ctaDisabled
        />

        {/* Personal Cloud */}
        <PlanCard
          name="Personal Cloud"
          price="$15"
          priceLabel="one-time payment"
          priceNote="your price, locked in forever"
          badge={isPaid ? undefined : 'Early Adopter'}
          features={personalFeatures}
          current={plan === 'personal'}
          highlight={!isPaid}
          cta={isPaid ? 'Current plan' : (upgrading ? 'Redirecting to Stripe…' : 'Upgrade — $15 one-time')}
          ctaDisabled={isPaid || isLoading}
          onCtaClick={!isPaid ? handleUpgrade : undefined}
          ctaNote={!isPaid ? 'Secure payment via Stripe · 14-day refund policy' : undefined}
        />

        {/* Team Lite */}
        <PlanCard
          name="Team Lite"
          price="$8"
          priceNote="per workspace / month"
          features={teamFeatures}
          current={plan === 'team_lite' || plan === 'team_pro'}
          highlight={false}
          cta="Coming soon"
          ctaDisabled
        />

      </div>

      <p className="text-xs text-zinc-600 text-center">
        All plans include a 14-day refund window for technical issues.{' '}
        <a href="/refunds" className="underline hover:text-zinc-400 transition-colors">Refund policy →</a>
      </p>
    </div>
  )
}

function PlanCard({
  name, price, priceLabel, priceNote, badge, features,
  current, highlight, cta, ctaDisabled, onCtaClick, ctaNote,
}: {
  name: string
  price: string
  priceLabel?: string
  priceNote: string
  badge?: string
  features: string[]
  current: boolean
  highlight: boolean
  cta: string | null
  ctaDisabled?: boolean
  onCtaClick?: () => void
  ctaNote?: string
}) {
  return (
    <div className={`relative rounded-2xl p-5 flex flex-col ${
      highlight
        ? 'bg-gradient-to-b from-teal-500/10 to-emerald-500/5 border border-teal-500/30'
        : 'bg-white/[0.03] border border-white/8'
    }`}>
      {badge && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-gradient-to-r from-teal-500 to-emerald-500 text-black">
            {badge}
          </span>
        </div>
      )}

      {current && (
        <div className="absolute top-3 right-3">
          <span className="text-xs font-semibold bg-teal-500/15 text-teal-400 border border-teal-500/25 px-2 py-0.5 rounded-full">
            Current plan
          </span>
        </div>
      )}

      <div className="mb-5">
        <h3 className={`font-semibold mb-3 ${highlight ? 'text-teal-300' : 'text-zinc-300'}`}>
          {name}
        </h3>

        {priceLabel && (
          <span className="inline-block text-xs font-semibold uppercase tracking-wider text-teal-400 mb-1.5">
            {priceLabel}
          </span>
        )}
        <div className="flex items-end gap-1.5 mb-1">
          <span className="text-4xl font-bold text-white">{price}</span>
        </div>
        <p className="text-xs text-zinc-500">{priceNote}</p>
      </div>

      <ul className="space-y-2.5 flex-1 mb-6">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-300">
            <svg className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            {f}
          </li>
        ))}
      </ul>

      {cta && (
        <div className="space-y-2">
          <button
            onClick={onCtaClick}
            disabled={ctaDisabled}
            className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all ${
              ctaDisabled
                ? 'bg-white/4 text-zinc-600 border border-white/5 cursor-not-allowed'
                : highlight
                  ? 'bg-gradient-to-r from-teal-500 to-emerald-500 text-black hover:from-teal-400 hover:to-emerald-400'
                  : 'bg-white/8 text-white hover:bg-white/12 border border-white/10'
            }`}
          >
            {cta}
          </button>
          {ctaNote && <p className="text-xs text-zinc-600 text-center">{ctaNote}</p>}
        </div>
      )}
    </div>
  )
}
