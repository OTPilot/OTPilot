import type { QueryClient } from '@tanstack/react-query'

// The account each client's data belongs to. Kept with the client, not with
// the component that reports it: the dashboard layout unmounts (sign-out in
// another tab → login redirect) while the app's client keeps its cache, and a
// remount (Back) with another account must still drop the previous one's data.
const accountOf = new WeakMap<QueryClient, string>()

/**
 * Drops cached data when the signed-in account changes (switching Supabase
 * accounts in the same browser profile), so one user never sees another's
 * plan / team / devices.
 *
 * Only on a real switch: the first account a client sees has nothing to drop,
 * and `clear()` silently cancels the queries already in flight (React Query
 * v5), which left the page that started them loading until its next render
 * (Billing opened from the offer email: buttons disabled, no offer banner).
 */
export function noteAccount(queryClient: QueryClient, userId: string | null | undefined) {
  if (!userId) return
  const last = accountOf.get(queryClient)
  if (last && last !== userId) queryClient.clear()
  accountOf.set(queryClient, userId)
}
