import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/useAuth'
import { supabase } from '../../lib/supabase'
import { apiFetch } from '../../lib/api'

type Phase = 'idle' | 'warn' | 'deleting' | 'error'

// What deleting the account would do (GET /users/me/deletion).
type DeletionPreview = {
  personal_subscription: boolean
  owned_teams: { name: string; members: number; subscription: boolean }[]
  member_of: string | null
}

export default function Settings() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>('idle')
  const [confirmText, setConfirmText] = useState('')
  const confirmed = confirmText === 'DELETE'
  const [preview, setPreview] = useState<DeletionPreview | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  // Confirming is only possible once we know (and show) what will happen.
  async function loadPreview() {
    setPreview(null)
    setPreviewFailed(false)
    try {
      const res = await apiFetch('/users/me/deletion')
      if (!res.ok) throw new Error('preview')
      setPreview(await res.json())
    } catch {
      setPreviewFailed(true)
    }
  }

  function startDelete() {
    setPhase('warn')
    loadPreview()
  }

  const consequences = [
    ...(preview?.personal_subscription ? ['Your Personal subscription is cancelled now. No refund for the current period.'] : []),
    ...(preview?.owned_teams ?? []).flatMap(t => [
      ...(t.subscription ? [`The "${t.name}" team subscription is cancelled now. No refund for the current period.`] : []),
      `The "${t.name}" team is dissolved: its ${t.members - 1} other member${t.members - 1 === 1 ? '' : 's'} lose its shared collections and codes and go back to Personal or Free. Their own vaults are not affected.`,
    ]),
    ...(preview?.member_of ? [`You leave the "${preview.member_of}" team.`] : []),
  ]


  async function handleDeleteAccount() {
    setPhase('deleting')
    setErrorText(null)
    try {
      const res = await apiFetch('/users/me', { method: 'DELETE' })
      if (!res.ok) {
        // e.g. "Could not cancel the team subscription; your account was not
        // deleted. Already cancelled: your Personal subscription. Try again…"
        setErrorText((await res.json().catch(() => null))?.error ?? null)
        throw new Error('Failed')
      }
    } catch {
      setPhase('error')
      loadPreview() // what's left to do may have changed
      return
    }
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

        {phase === 'idle' && (
          <>
            <p className="text-sm text-zinc-500">
              Deleting your account permanently removes all synced data.
            </p>
            <button
              onClick={startDelete}
              className="text-sm font-medium text-red-500 hover:text-red-400 transition-colors"
            >
              Delete account
            </button>
          </>
        )}

        {(phase === 'warn' || phase === 'error') && (
          <div className="space-y-4">
            <div className="rounded-md border border-red-800/50 bg-red-950/30 p-3 space-y-2">
              <p className="text-sm font-semibold text-red-400">Before you continue, read this carefully:</p>
              <ul className="text-sm text-zinc-400 space-y-1.5 list-none">
                {[
                  ...consequences,
                  'All your synced data is deleted immediately and permanently — vault items, devices, sync history, team memberships.',
                  'Items you put in a team collection stay with that collection for its other members.',
                  'This cannot be undone. There is no grace period, and no refunds for account deletion.',
                  'Your local extension data is not affected — OTPilot keeps working offline, but cloud sync stops.',
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <span className="text-red-500 mt-0.5 shrink-0">✕</span>
                    {line}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs text-zinc-500">
                Type <span className="font-mono text-zinc-300">DELETE</span> to confirm
              </p>
              <input
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder="DELETE"
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-700"
              />
            </div>

            {!preview && !previewFailed && (
              <p className="text-xs text-zinc-500">Checking your subscriptions and team…</p>
            )}
            {previewFailed && (
              <p className="text-xs text-red-400">
                Couldn't check your subscriptions and team.{' '}
                <button onClick={loadPreview} className="underline hover:text-red-300">Try again</button>
              </p>
            )}
            {phase === 'error' && (
              <p className="text-xs text-red-400">{errorText ?? 'Something went wrong. Try again or contact support.'}</p>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => { setPhase('idle'); setConfirmText(''); setPreview(null); setPreviewFailed(false); setErrorText(null) }}
                className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={!confirmed || !preview}
                className="text-sm font-medium text-red-500 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Permanently delete my account
              </button>
            </div>
          </div>
        )}

        {phase === 'deleting' && (
          <p className="text-sm text-zinc-500">Deleting account…</p>
        )}
      </div>
    </div>
  )
}
