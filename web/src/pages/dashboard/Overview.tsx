import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../lib/useAuth'
import { apiFetch } from '../../lib/api'

type UserData = { id: string; plan: string; created_at: string }
type SyncData = { updated_at: string } | null

function useUserPlan() {
  return useQuery<UserData>({
    queryKey: ['user-plan'],
    queryFn: async () => {
      const res = await apiFetch('/auth/sync-user', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to load plan')
      return res.json()
    },
    staleTime: 60_000,
  })
}

function useSyncInfo() {
  return useQuery<SyncData>({
    queryKey: ['sync-info'],
    queryFn: async () => {
      const res = await apiFetch('/accounts')
      if (!res.ok) return null
      return res.json()
    },
    staleTime: 30_000,
  })
}

function formatSyncTime(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return d.toLocaleDateString()
}

export default function Overview() {
  const { user } = useAuth()
  const { data: userData } = useUserPlan()
  const { data: syncData } = useSyncInfo()

  const PLAN_LABELS: Record<string, string> = {
    free: 'Free',
    personal: 'Personal',
    team_lite: 'Team',
    team_pro: 'Team Pro',
  }
  const planLabel = userData ? (PLAN_LABELS[userData.plan] ?? userData.plan) : '–'

  const lastSync = syncData?.updated_at
    ? formatSyncTime(syncData.updated_at)
    : 'Never'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-zinc-100">Overview</h1>
        <p className="text-sm text-zinc-500 mt-1">Welcome back, {user?.email}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard label="Plan" value={planLabel} />
        <StatCard label="Last sync" value={lastSync} />
      </div>

    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className="text-lg font-bold text-zinc-100">{value}</p>
    </div>
  )
}
