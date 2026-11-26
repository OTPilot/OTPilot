import type { QueryClient } from '@tanstack/react-query'

/**
 * Drops cached data when the signed-in account changes (switching Supabase
 * accounts in the same browser profile), so one user never sees another's
 * plan / team / devices.
 *
 * Only on a real switch: the first account to arrive has nothing to drop, and
 * `clear()` silently cancels the queries already in flight (React Query v5),
 * which left the page that started them loading until its next render
 * (Billing opened from the offer email: buttons disabled, no offer banner).
 */
export function accountSwitchGuard(queryClient: QueryClient) {
  let last: string | null = null
  return (userId: string | null | undefined) => {
    if (!userId) return
    if (last && last !== userId) queryClient.clear()
    last = userId
  }
}
