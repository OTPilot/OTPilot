import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import { agentCode } from '../../lib/agentCode'
import Logo from '../../components/Logo'

// Opened by `otpilot-mcp connect` (docs/agents/plan.md): the signed-in user
// claims the agent's pairing. Approval happens in the extension, where the
// vault is, after checking the same code there.

type Pairing = { id: string; name: string; machine: string; public_key: string }
type State =
  | { kind: 'loading' }
  | { kind: 'need-auth' }
  | { kind: 'confirm'; pairing: Pairing; code: string }
  | { kind: 'claiming'; pairing: Pairing; code: string }
  | { kind: 'claimed'; pairing: Pairing; code: string }
  | { kind: 'error'; message: string }

export default function AgentConnect() {
  const [params] = useSearchParams()
  const id = params.get('p') ?? ''
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [netError, setNetError] = useState(false)

  // Signed in from another tab (an email link opens one): this tab picks
  // the session up and continues with its own pairing.
  const [signedIn, setSignedIn] = useState(0)
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      // Only a page still waiting for sign-in reloads: one already
      // confirming or connected keeps what it shows.
      if (event === 'SIGNED_IN') setState(cur => { if (cur.kind === 'need-auth') setSignedIn(n => n + 1); return cur })
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setState({ kind: 'need-auth' }); return }
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        setState({ kind: 'error', message: 'This link is incomplete. Run the connect command again.' })
        return
      }
      const res = await apiFetch(`/agents/pair/${id}`).catch(() => null)
      if (!res) {
        setState({ kind: 'error', message: 'Could not reach OTPilot. Check your connection and reload this page.' })
        return
      }
      if (!res.ok) {
        setState({ kind: 'error', message: 'This connection request has expired or was already used. Run the connect command again.' })
        return
      }
      const pairing: Pairing = await res.json()
      setState({ kind: 'confirm', pairing, code: await agentCode(pairing.public_key) })
    })()
  }, [id, signedIn])

  async function claim() {
    if (state.kind !== 'confirm') return
    setNetError(false)
    setState({ ...state, kind: 'claiming' })
    const res = await apiFetch(`/agents/pair/${id}/claim`, { method: 'POST' }).catch(() => null)
    if (!res) {
      setState({ ...state, kind: 'confirm' })
      setNetError(true)
      return
    }
    if (res.ok) { setState({ ...state, kind: 'claimed' }); return }
    const j = await res.json().catch(() => ({}))
    setState({ kind: 'error', message: j.error ?? 'Could not connect this agent. Run the connect command again.' })
  }

  function signIn() {
    sessionStorage.setItem('auth_next', window.location.pathname + window.location.search)
    window.location.href = '/auth/login'
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center px-6">
      <div className="max-w-md w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-7 space-y-5">
        <div className="flex items-center gap-2.5">
          <Logo size={26} className="rounded-md" />
          <span className="font-semibold text-zinc-100">Connect an AI agent</span>
        </div>

        {state.kind === 'loading' && <p className="text-sm text-zinc-500">Loading…</p>}

        {state.kind === 'need-auth' && (
          <>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Sign in to OTPilot to connect this agent to your account. A free account works.
            </p>
            <p className="text-xs text-zinc-500">Signing in with an email link? Keep this tab open: it continues here once you're in.</p>
            <button onClick={signIn} className="w-full py-2.5 rounded-xl bg-teal-500 text-black text-sm font-semibold hover:bg-teal-400">
              Sign in
            </button>
          </>
        )}

        {(state.kind === 'confirm' || state.kind === 'claiming' || state.kind === 'claimed') && (
          <>
            <div>
              <p className="text-white font-semibold">{state.pairing.name}</p>
              {state.pairing.machine && <p className="text-xs text-zinc-500 mt-0.5">{state.pairing.machine}</p>}
            </div>
            <div className="rounded-xl bg-black/40 border border-zinc-800 p-4 flex items-center gap-4">
              <span className="font-mono text-2xl font-bold tracking-[0.15em] text-white">{state.code}</span>
              <span className="text-xs text-zinc-400 leading-relaxed">
                Your terminal shows a code too. <b className="text-zinc-200">Continue only if they match.</b>
              </span>
            </div>
            {state.kind !== 'claimed' ? (
              <>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Connecting gives it <b className="text-zinc-200">no accounts</b>. You approve it, and choose what it can use, in the OTPilot extension.
                </p>
                {netError && <p className="text-sm text-red-400">Could not reach OTPilot. Check your connection and try again.</p>}
                <div className="flex gap-3">
                  <button
                    disabled={state.kind === 'claiming'}
                    onClick={() => setState({ kind: 'error', message: 'Not connected. Close this tab: someone else may be trying to connect an agent to your account. Nothing was shared.' })}
                    className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-300 text-sm font-medium hover:border-zinc-500 disabled:opacity-60"
                  >
                    Codes don't match
                  </button>
                  <button
                    onClick={claim}
                    disabled={state.kind === 'claiming'}
                    className="flex-1 py-2.5 rounded-xl bg-teal-500 text-black text-sm font-semibold hover:bg-teal-400 disabled:opacity-60"
                  >
                    {state.kind === 'claiming' ? 'Connecting…' : 'Codes match · Continue'}
                  </button>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-teal-500/30 bg-teal-500/5 p-4 space-y-1.5">
                <p className="text-sm text-teal-300 font-semibold">Almost there</p>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Open the OTPilot extension: <b className="text-zinc-200">{state.pairing.name}</b> is waiting in Agents. Check the code once more and approve it.
                </p>
              </div>
            )}
          </>
        )}

        {state.kind === 'error' && <p className="text-sm text-red-400 leading-relaxed">{state.message}</p>}
      </div>
    </div>
  )
}
