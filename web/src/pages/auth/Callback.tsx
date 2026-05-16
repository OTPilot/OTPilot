import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

// Handles the redirect after magic link or OAuth sign-in.
// Supabase puts the session tokens in the URL hash — the JS client
// picks them up automatically; we just need to wait and redirect.
export default function Callback() {
  const navigate = useNavigate()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/dashboard', { replace: true })
      } else {
        // Wait for onAuthStateChange to fire with the new session
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
          if (s) {
            subscription.unsubscribe()
            navigate('/dashboard', { replace: true })
          }
        })
      }
    })
  }, [navigate])

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 rounded-full border-2 border-teal-400/30 border-t-teal-400 animate-spin" />
        <p className="text-sm text-zinc-500">Signing you in…</p>
      </div>
    </div>
  )
}
