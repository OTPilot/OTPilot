import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../lib/api'

type Device = {
  id: string
  device_id: string
  name: string
  os: string
  browser: string
  first_seen_at: string
  last_seen_at: string
  pending_action: string | null
}

type SyncLog = {
  id: string
  action: string
  accounts_count: number
  created_at: string
}

function formatTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min}m ago`
  if (hr < 24) return `${hr}h ago`
  if (day < 30) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function Devices() {
  const qc = useQueryClient()

  const { data: devices = [], isLoading } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await apiFetch('/devices')
      if (!res.ok) throw new Error('Failed to load devices')
      return res.json()
    },
  })

  const disconnect = useMutation({
    mutationFn: async (device_id: string) => {
      const res = await apiFetch(`/devices/${device_id}/disconnect`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })

  const erase = useMutation({
    mutationFn: async (device_id: string) => {
      const res = await apiFetch(`/devices/${device_id}/erase`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })

  if (isLoading) {
    return (
      <div className="flex justify-center pt-16">
        <div className="w-5 h-5 rounded-full border-2 border-teal-400/30 border-t-teal-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-zinc-100">Devices</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {devices.length === 0
            ? 'No devices have synced yet.'
            : `${devices.length} device${devices.length !== 1 ? 's' : ''} connected`}
        </p>
      </div>

      {devices.length > 0 && (
        <div className="space-y-3">
          {devices.map(device => (
            <DeviceCard
              key={device.device_id}
              device={device}
              onDisconnect={() => disconnect.mutate(device.device_id)}
              onRemove={() => erase.mutate(device.device_id)}
              isMutating={disconnect.isPending || erase.isPending}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DeviceCard({
  device,
  onDisconnect,
  onRemove,
  isMutating,
}: {
  device: Device
  onDisconnect: () => void
  onRemove: () => void
  isMutating: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirm, setConfirm] = useState<'disconnect' | 'erase' | null>(null)

  const { data: logs, isError: logsError } = useQuery<SyncLog[]>({
    queryKey: ['device-logs', device.device_id],
    queryFn: async () => {
      const res = await apiFetch(`/devices/${encodeURIComponent(device.device_id)}/logs`)
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json()
    },
    enabled: expanded,
    retry: false,
  })

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100 truncate">{device.name}</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Last seen {formatTime(device.last_seen_at)}
            {' · '}
            Connected {formatTime(device.first_seen_at)}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {device.pending_action ? (
            <span className="text-xs text-amber-400 bg-amber-400/10 rounded px-2 py-1">
              Waiting for device…
            </span>
          ) : confirm !== null ? (
            <>
              <span className="text-xs text-zinc-400">
                {confirm === 'erase' ? 'Remove all local data?' : 'Disconnect this device?'}
              </span>
              <button
                onClick={() => {
                  if (confirm === 'disconnect') onDisconnect()
                  else onRemove()
                  setConfirm(null)
                }}
                disabled={isMutating}
                className={`text-xs rounded px-2 py-1 transition-colors disabled:opacity-50 ${
                  confirm === 'erase'
                    ? 'bg-red-900/50 text-red-300 hover:bg-red-900'
                    : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                }`}
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirm(null)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setExpanded(e => !e)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {expanded ? 'Hide logs' : 'Logs'}
              </button>
              <button
                onClick={() => setConfirm('disconnect')}
                disabled={isMutating}
                className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-500 rounded px-2 py-1 transition-colors disabled:opacity-50"
              >
                Disconnect
              </button>
              <button
                onClick={() => setConfirm('erase')}
                disabled={isMutating}
                className="text-xs text-red-400 hover:text-red-300 border border-red-900 hover:border-red-700 rounded px-2 py-1 transition-colors disabled:opacity-50"
              >
                Remove
              </button>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 pt-3">
          {logsError ? (
            <p className="text-xs text-red-400">Failed to load logs.</p>
          ) : !logs ? (
            <div className="flex justify-center py-2">
              <div className="w-4 h-4 rounded-full border-2 border-teal-400/30 border-t-teal-400 animate-spin" />
            </div>
          ) : logs.length === 0 ? (
            <p className="text-xs text-zinc-600">No sync history yet — sync from the extension first.</p>
          ) : (
            <ul className="space-y-1.5">
              {logs.slice(0, 20).map(log => (
                <li key={log.id} className="flex items-center justify-between text-xs">
                  <span className="text-zinc-400">
                    {log.action} · {log.accounts_count} account{log.accounts_count !== 1 ? 's' : ''}
                  </span>
                  <span className="text-zinc-600">{formatTime(log.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
