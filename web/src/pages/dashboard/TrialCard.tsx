import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../lib/api'
import {
  TRIAL_DAYS, TRIAL_ENDING_DAYS, formatTrialEnd, trialDaysLeft, type UserData,
} from '../../lib/plan'

/** The Personal trial on the dashboard: days left while it runs, or the offer
 *  to start it (Free accounts that never had one). Nothing otherwise. */
export default function TrialCard({ user, showSubscribe = true }: { user: UserData; showSubscribe?: boolean }) {
  if (user.trial_active && user.trial_ends_at) {
    return <RunningTrial endsAt={user.trial_ends_at} showSubscribe={showSubscribe} />
  }
  if (user.trial_available) return <TrialOffer />
  return null
}

function RunningTrial({ endsAt, showSubscribe }: { endsAt: string; showSubscribe: boolean }) {
  const left = trialDaysLeft(endsAt)
  const ending = left <= TRIAL_ENDING_DAYS
  const used = Math.min(TRIAL_DAYS, Math.max(0, TRIAL_DAYS - left))
  const tone = ending
    ? { box: 'border-amber-400/35 bg-amber-400/[0.06]', label: 'text-amber-300', bar: 'bg-amber-400' }
    : { box: 'border-teal-400/35 bg-teal-400/[0.06]', label: 'text-teal-400', bar: 'bg-teal-400' }
  return (
    <div className={`rounded-xl border ${tone.box} p-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center`}>
      <div>
        <p className={`text-xs font-semibold tracking-wide ${tone.label}`}>PERSONAL TRIAL</p>
        <p className="text-base font-bold text-zinc-100 mt-0.5">
          {left <= 1 ? 'Ends within a day' : `${left} days left`}
        </p>
        <p className="text-sm text-zinc-400 mt-1">
          Ends {formatTrialEnd(endsAt)}. After that sync pauses; your data stays on your devices.
        </p>
      </div>
      {showSubscribe && (
        <div className="flex gap-2">
          <Link to="/dashboard/billing"
            className={`px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${ending ? 'bg-amber-400 text-zinc-950 hover:bg-amber-300' : 'bg-teal-400 text-zinc-950 hover:bg-teal-300'}`}>
            Subscribe · $3/mo
          </Link>
        </div>
      )}
      <div className="sm:col-span-2 space-y-1.5">
        <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
          <div className={`h-full ${tone.bar}`} style={{ width: `${(used / TRIAL_DAYS) * 100}%` }} />
        </div>
        <p className="text-xs text-zinc-500 tabular-nums text-right">Day {used} of {TRIAL_DAYS}</p>
      </div>
    </div>
  )
}

function TrialOffer() {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch('/billing/trial', { method: 'POST' })
      if (!res.ok) {
        setError(res.status === 400 ? 'This account already had its trial.' : 'Could not start the trial. Try again in a moment.')
        return
      }
      await queryClient.invalidateQueries({ queryKey: ['user-plan'] })
    } catch {
      setError('Could not reach OTPilot. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-teal-400/35 bg-teal-400/[0.06] p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <p className="text-xs font-semibold tracking-wide text-teal-400">TRY PERSONAL</p>
        <p className="text-base font-bold text-zinc-100 mt-0.5">30 days of sync, free</p>
        <p className="text-sm text-zinc-400 mt-1">
          Your vault on every browser, end-to-end encrypted. No card; afterwards you're back on Free and nothing is deleted.
        </p>
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
      <button onClick={start} disabled={busy}
        className="shrink-0 px-4 py-2 rounded-lg bg-teal-400 text-zinc-950 text-sm font-semibold hover:bg-teal-300 disabled:opacity-50">
        {busy ? 'Starting…' : 'Start free trial'}
      </button>
    </div>
  )
}
