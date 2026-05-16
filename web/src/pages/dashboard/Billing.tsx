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

      {/* Current plan card */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Current plan</p>
          {isLoading && <div className="w-4 h-4 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin" />}
        </div>

        <div className="flex items-center gap-3">
          <span className={`text-2xl font-bold ${isPaid ? 'text-teal-400' : 'text-zinc-100'}`}>
            {isPaid ? 'Personal' : 'Free'}
          </span>
          {isPaid && (
            <span className="text-xs font-semibold bg-teal-500/15 text-teal-400 border border-teal-500/25 px-2 py-0.5 rounded-full">
              Lifetime
            </span>
          )}
        </div>

        <ul className="space-y-1.5">
          {isPaid ? (
            <>
              <PlanFeature text="Cloud sync across all your devices" active />
              <PlanFeature text="End-to-end encrypted backups" active />
              <PlanFeature text="One-time payment — no subscription" active />
            </>
          ) : (
            <>
              <PlanFeature text="Unlimited TOTP accounts" active />
              <PlanFeature text="Auto-fill on any site" active />
              <PlanFeature text="Auto-detect 2FA setup" active />
              <PlanFeature text="Master password lock" active />
              <PlanFeature text="Local encrypted backup" active />
              <PlanFeature text="Chrome, Firefox & Edge" active />
              <PlanFeature text="Cloud sync across devices" active={false} />
              <PlanFeature text="Cross-device access" active={false} />
            </>
          )}
        </ul>
      </div>

      {/* Upgrade CTA */}
      {!isPaid && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-5 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">Upgrade</p>
            <p className="text-2xl font-bold text-zinc-100">
              $15
              <span className="text-sm font-normal text-zinc-500 ml-1">one-time</span>
            </p>
            <p className="text-xs text-zinc-500 mt-0.5">Paid once — your access and price are locked in.</p>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            onClick={handleUpgrade}
            disabled={upgrading || isLoading}
            className="w-full py-2.5 rounded-lg bg-teal-500 hover:bg-teal-400 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-950 text-sm font-semibold transition-colors"
          >
            {upgrading ? 'Redirecting to Stripe…' : 'Upgrade to Personal — $15'}
          </button>

          <p className="text-xs text-zinc-600 text-center">
            Secure payment via Stripe · 14-day refund policy
          </p>
        </div>
      )}
    </div>
  )
}

function PlanFeature({ text, active }: { text: string; active: boolean }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {active ? (
        <svg className="w-3.5 h-3.5 text-teal-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5 text-zinc-700 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      )}
      <span className={active ? 'text-zinc-300' : 'text-zinc-600'}>{text}</span>
    </li>
  )
}
