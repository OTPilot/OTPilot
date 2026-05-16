import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

// Handles the redirect after magic link or OAuth sign-in.
// Supabase puts the session tokens in the URL hash — the JS client
// picks them up automatically; we just need to wait and redirect.
export default function Callback() {
  const navigate = useNavigate()

  useEffect(() => {
    function redirectAfterLogin() {
      const next = sessionStorage.getItem('auth_next')
      sessionStorage.removeItem('auth_next')
      navigate(next || '/dashboard', { replace: true })
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        redirectAfterLogin()
      } else {
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
          if (s) {
            subscription.unsubscribe()
            redirectAfterLogin()
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
