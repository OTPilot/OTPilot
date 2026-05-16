import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/useAuth'
import { supabase } from '../../lib/supabase'

export default function Settings() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)

  async function handleDeleteAccount() {
    if (!confirming) { setConfirming(true); return }
    // TODO: call DELETE /users/me when implemented
    await supabase.auth.signOut()
    navigate('/', { replace: true })
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-zinc-100">Settings</h1>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Account</p>
        <p className="text-sm text-zinc-300">{user?.email}</p>
      </div>

      <div className="rounded-lg border border-red-900/40 bg-zinc-900 p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-red-500">Danger zone</p>
        <p className="text-sm text-zinc-500">
          Deleting your account removes all synced data permanently.
        </p>
        <button
          onClick={handleDeleteAccount}
          className="text-sm font-medium text-red-500 hover:text-red-400 transition-colors"
        >
          {confirming ? 'Click again to confirm deletion' : 'Delete account'}
        </button>
      </div>
    </div>
  )
}
