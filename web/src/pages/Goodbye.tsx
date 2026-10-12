import { useState } from 'react'
import { Head } from 'vite-react-ssg'
import Logo from '../components/Logo'
import { CHROME_STORE_URL } from '../lib/browser'

// Opened by Chrome right after the extension is removed
// (chrome.runtime.setUninstallURL in background.js): a short, anonymous
// "why did you leave?". The URL carries only the extension version (v), days
// installed (d) and plan (p); the answer goes to POST /feedback/uninstall.

const API_URL = import.meta.env.VITE_API_URL as string

const REASONS: { id: string; label: string }[] = [
  { id: 'missed_fill', label: 'It didn’t fill my codes or passwords on a site' },
  { id: 'missing_feature', label: 'It was missing something I need' },
  { id: 'other_manager', label: 'I use another password manager' },
  { id: 'privacy', label: 'I’m worried about its permissions or privacy' },
  { id: 'too_complex', label: 'It was too complicated' },
  { id: 'broken', label: 'Something didn’t work' },
  { id: 'just_trying', label: 'I was only trying it out' },
  { id: 'other', label: 'Something else' },
]

export default function Goodbye() {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const [reason, setReason] = useState('')
  const [site, setSite] = useState('')
  const [comment, setComment] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!reason) return
    setState('sending')
    const days = Number.parseInt(params.get('d') ?? '', 10)
    try {
      const res = await fetch(`${API_URL}/feedback/uninstall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason,
          site: reason === 'missed_fill' ? site : undefined,
          comment,
          version: params.get('v') || undefined,
          days_installed: Number.isFinite(days) ? days : undefined,
          plan: params.get('p') || undefined,
        }),
      })
      setState(res.ok ? 'sent' : 'error')
    } catch {
      setState('error')
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center px-4 py-10">
      <Head>
        <title>OTPilot — Sorry to see you go</title>
        <meta name="robots" content="noindex" />
      </Head>
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Logo size={24} />
          <span className="text-sm font-semibold text-zinc-200">OTPilot</span>
        </div>

        {state === 'sent' ? (
          <div className="space-y-3">
            <h1 className="text-lg font-bold text-zinc-100">Thank you</h1>
            <p className="text-sm text-zinc-400">This goes straight to the person who builds OTPilot, and it shapes what gets fixed next.</p>
            <a href={CHROME_STORE_URL} className="inline-block text-sm text-teal-400 hover:text-teal-300">Removed it by mistake? Install it again</a>
          </div>
        ) : (
          <form onSubmit={send} className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-bold text-zinc-100">Sorry to see you go</h1>
              <p className="text-sm text-zinc-400">What made you remove OTPilot? One click helps. Anonymous: your account isn’t included.</p>
            </div>

            <fieldset className="space-y-1.5">
              <legend className="sr-only">Why did you remove it?</legend>
              {REASONS.map((r) => (
                <label key={r.id} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm cursor-pointer ${
                  reason === r.id ? 'border-teal-500/60 bg-teal-500/10 text-zinc-100' : 'border-zinc-800 text-zinc-300 hover:border-zinc-700'}`}>
                  <input type="radio" name="reason" value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)}
                    className="mt-0.5 accent-teal-500" />
                  {r.label}
                </label>
              ))}
            </fieldset>

            {reason === 'missed_fill' && (
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">Which site? (optional)</span>
                <input id="goodbye-site" value={site} onChange={(e) => setSite(e.target.value)} maxLength={200} placeholder="e.g. xstation5.xtb.com"
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-2.5 py-1.5 text-sm text-zinc-200" />
              </label>
            )}

            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">Anything else? (optional)</span>
              <textarea id="goodbye-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} rows={3}
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-2.5 py-1.5 text-sm text-zinc-200" />
            </label>

            {state === 'error' && <p className="text-sm text-red-400">It couldn’t be sent. Check your connection and try again.</p>}

            <div className="flex items-center justify-between gap-3">
              <a href={CHROME_STORE_URL} className="text-xs text-zinc-500 hover:text-zinc-300">Removed it by mistake?</a>
              <button type="submit" disabled={!reason || state === 'sending'}
                className="px-4 py-2 rounded-lg bg-teal-500 text-black text-sm font-semibold hover:bg-teal-400 disabled:opacity-50">
                {state === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
