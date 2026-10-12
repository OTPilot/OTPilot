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
      // Where to go back to: this tab's, or (an email link opened in another
      // tab) one saved for all tabs in the last 15 minutes. Paths only.
      let shared: string | null = null
      try {
        const s = JSON.parse(localStorage.getItem('auth_next_shared') || 'null')
        if (s && Date.now() - s.at < 15 * 60_000) shared = s.next
        localStorage.removeItem('auth_next_shared')
      } catch { /* none */ }
      const saved = sessionStorage.getItem('auth_next') || shared
      const next = saved && saved.startsWith('/') && !saved.startsWith('//') ? saved : null
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
