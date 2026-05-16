import { useState, useEffect } from 'react'
import { detectBrowser, browserMeta } from '../lib/browser'
import { useAuth } from '../lib/useAuth'
import { supabase } from '../lib/supabase'
import Logo from './Logo'

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const { user } = useAuth()
  const browser = detectBrowser()
  const { name: browserLabel, available, href } = browserMeta[browser]

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  return (
    <nav
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-[#0a0a0f]/90 backdrop-blur-md border-b border-white/5'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5">
          <Logo size={28} className="rounded-lg" />
          <span className="font-semibold text-white text-sm tracking-tight">OTPilot</span>
        </a>

        <div className="hidden md:flex items-center gap-8">
          <a href="#features" className="text-sm text-zinc-400 hover:text-white transition-colors">Features</a>
          <a href="#pricing" className="text-sm text-zinc-400 hover:text-white transition-colors">Pricing</a>
          <a href="#faq" className="text-sm text-zinc-400 hover:text-white transition-colors">FAQ</a>
        </div>

        <div className="flex items-center gap-3">
          {user ? (
            <a
              href="/dashboard"
              className="text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-500 text-black hover:from-teal-400 hover:to-emerald-400 transition-all flex items-center gap-1.5"
            >
              Dashboard
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </a>
          ) : (
            <>
              <button
                onClick={() => supabase.auth.signInWithOAuth({
                  provider: 'google',
                  options: { redirectTo: `${window.location.origin}/auth/callback` },
                })}
                className="text-sm text-zinc-400 hover:text-white transition-colors"
              >
                Sign in
              </button>
              {available && href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-500 text-black hover:from-teal-400 hover:to-emerald-400 transition-all"
                >
                  Add to {browserLabel}
                </a>
              ) : (
                <a
                  href="/dashboard/billing"
                  className="text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-500 text-black hover:from-teal-400 hover:to-emerald-400 transition-all"
                >
                  Get started
                </a>
              )}
            </>
          )}
        </div>
      </div>
    </nav>
  )
}
