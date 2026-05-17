import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../lib/useAuth'
import { apiFetch } from '../../lib/api'

type UserData = {
  id: string
  plan: string
  created_at: string
  last_sync_at: string | null
  accounts_count: number
  syncs_this_month: number
  devices_count: number
}

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

function formatRelative(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return new Date(iso).toLocaleDateString()
}

function formatMemberSince(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export default function Overview() {
  const { user } = useAuth()
  const { data: userData } = useUserPlan()

  const PLAN_LABELS: Record<string, string> = {
    free: 'Free',
    personal: 'Personal',
    team_lite: 'Team',
    team_pro: 'Team Pro',
  }

  const planLabel  = userData ? (PLAN_LABELS[userData.plan] ?? userData.plan) : '–'
  const lastSync   = userData?.last_sync_at ? formatRelative(userData.last_sync_at) : 'Never'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-zinc-100">Overview</h1>
        <p className="text-sm text-zinc-500 mt-1">Welcome back, {user?.email}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard label="Plan"             value={planLabel}                                          to="/dashboard/billing" />
        <StatCard label="Last sync"        value={lastSync} />
        <StatCard label="Accounts"         value={String(userData?.accounts_count   ?? '–')} />
        <StatCard label="Devices"          value={String(userData?.devices_count    ?? '–')}          to="/dashboard/devices" />
        <StatCard label="Syncs this month" value={String(userData?.syncs_this_month ?? '–')} />
        <StatCard label="Member since"     value={userData ? formatMemberSince(userData.created_at) : '–'} />
      </div>
    </div>
  )
}

function StatCard({ label, value, to }: { label: string; value: string; to?: string }) {
  const content = (
    <>
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className="text-lg font-bold text-zinc-100">{value}</p>
    </>
  )

  const cls = 'rounded-lg border border-zinc-800 bg-zinc-900 p-4' +
    (to ? ' hover:border-zinc-600 transition-colors' : '')

  if (to) return <Link to={to} className={cls}>{content}</Link>
  return <div className={cls}>{content}</div>
}
