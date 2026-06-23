import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { supabase } from '../lib/supabase'

export default function AcceptInvite() {
  const { token } = useParams()
  const [state, setState] = useState<'loading' | 'need-auth' | 'ok' | 'error'>('loading')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setState('need-auth'); return }
      const res = await apiFetch(`/teams/accept/${token}`, { method: 'POST' })
      if (res.ok) {
        setState('ok')
        setTimeout(() => { window.location.href = '/dashboard/team' }, 1200)
      } else {
        const j = await res.json().catch(() => ({}))
        setMsg(j.error ?? 'This invitation is invalid or expired.')
        setState('error')
      }
    })()
  }, [token])

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center px-6">
      <div className="max-w-sm w-full rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center space-y-3">
        <h1 className="text-lg font-bold text-zinc-100">Team invitation</h1>
        {state === 'loading' && <p className="text-sm text-zinc-500">Accepting…</p>}
        {state === 'need-auth' && (
          <>
            <p className="text-sm text-zinc-400">Sign in to accept this invitation.</p>
            <a href={`/auth/login?next=${encodeURIComponent(`/teams/accept/${token}`)}`}
               className="inline-block px-4 py-2 rounded-lg bg-teal-500 text-black text-sm font-semibold hover:bg-teal-400">
              Sign in
            </a>
          </>
        )}
        {state === 'ok' && <p className="text-sm text-teal-400">You're in! Redirecting…</p>}
        {state === 'error' && <p className="text-sm text-red-400">{msg}</p>}
      </div>
    </div>
  )
}
