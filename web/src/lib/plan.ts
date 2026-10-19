import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './api'

/** What `POST /auth/sync-user` answers. */
export type UserData = {
  id: string
  plan: string
  personal_subscription?: boolean
  created_at: string
  last_sync_at: string | null
  accounts_count: number
  syncs_this_month: number
  devices_count: number
  /** End of the Personal trial (also once over: it was used). */
  trial_ends_at?: string | null
  /** In the trial now: `plan` is `personal` because of it. */
  trial_active?: boolean
  /** Can start one (`POST /billing/trial`). */
  trial_available?: boolean
}

export const TRIAL_DAYS = 30
/** The trial card turns to a reminder this many days before the end (as the email). */
export const TRIAL_ENDING_DAYS = 3
/** Stripe needs a trial_end ≥ 48 h away to carry the trial over (api `MIN_TRIAL_CARRY_HOURS`). */
const CARRY_OVER_MS = 49 * 3600e3

export function useUserPlan(forceRefresh = false) {
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

export function trialDaysLeft(endsAt: string, now = Date.now()) {
  return Math.max(0, Math.ceil((Date.parse(endsAt) - now) / 864e5))
}

export function formatTrialEnd(endsAt: string) {
  return new Date(endsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
}

/** Subscribing now keeps the trial's remaining days free (the first charge waits for its end). */
export function trialCarriesOver(endsAt: string | null | undefined, now = Date.now()) {
  return !!endsAt && Date.parse(endsAt) - now >= CARRY_OVER_MS
}
