import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, FocusEvent, PointerEvent, MouseEvent } from 'react'
import { useAuth } from '../lib/useAuth'
import Logo from './Logo'

// Absolute /#… links: the nav also renders on /ai-agents and the guides.
const SOLUTIONS = [
  {
    heading: 'For you',
    items: [
      { label: '2FA authenticator', href: '/autofill-2fa-codes-chrome', text: 'Your 2FA codes in the browser, filled on the sign-in page.' },
      { label: 'Password manager', href: '/#features', text: 'Logins, notes, keys and files in one encrypted vault.' },
    ],
  },
  {
    heading: 'For teams',
    items: [
      { label: 'Team 2FA sharing', href: '/#team-2fa', text: 'Share a 2FA code with a teammate without sharing its secret.', tag: 'Only in OTPilot' },
      { label: 'Team password sharing', href: '/#team-sharing', text: 'Share logins and collections, end-to-end encrypted.' },
    ],
  },
]

const LINKS = [
  { label: 'Security', href: '/#security' },
  { label: 'Pricing', href: '/#pricing' },
  { label: 'FAQ', href: '/#faq' },
]

function subscribeScroll(onChange: () => void) {
  window.addEventListener('scroll', onChange, { passive: true })
  return () => window.removeEventListener('scroll', onChange)
}
const isScrolled = () => window.scrollY > 20
const serverScrolled = () => false

function Chevron({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  )
}

function NewTag() {
  return (
    <span className="px-1.5 py-px rounded-full bg-gradient-to-r from-teal-500 to-emerald-500 text-black text-[9px] font-bold tracking-wider">
      NEW
    </span>
  )
}

function OnlyTag() {
  return (
    <span className="px-[7px] py-px rounded-full border border-teal-400/35 bg-teal-500/10 text-teal-400 text-[10px] font-semibold tracking-wide uppercase whitespace-nowrap">
      Only in OTPilot
    </span>
  )
}

function SolutionsMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // How it was opened. Only a keyboard open survives the pointer leaving;
  // a click on a hover-opened menu keeps it open under the pointer.
  const openedBy = useRef<'hover' | 'click' | 'keyboard' | null>(null)
  const focusFirst = useRef(false)
  const menuId = useId()

  useEffect(() => {
    if (!open) openedBy.current = null
    if (open && focusFirst.current) {
      focusFirst.current = false
      menuRef.current?.querySelector('a')?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const onKeyDown = (e: KeyboardEvent) => {
    // Keyboard use inside an open menu: it no longer belongs to the pointer.
    if (open) openedBy.current = 'keyboard'
    if (e.key === 'Escape' && open) {
      e.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
  }
  const onBlur = (e: FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
  }
  const onPointerEnter = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || open) return
    openedBy.current = 'hover'
    setOpen(true)
  }
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || openedBy.current === 'keyboard') return
    openedBy.current = null
    setOpen(false)
  }
  // Enter / Space reach the button as a click with detail 0: a plain toggle.
  // A mouse click on a hover-opened menu keeps it open.
  const onClick = (e: MouseEvent) => {
    const keyboard = e.detail === 0
    if (!keyboard && open && openedBy.current === 'hover') {
      openedBy.current = 'click'
      return
    }
    openedBy.current = open ? null : keyboard ? 'keyboard' : 'click'
    setOpen(!open)
  }
  const onButtonKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown') return
    e.preventDefault()
    openedBy.current = 'keyboard'
    if (open) menuRef.current?.querySelector('a')?.focus()
    else {
      focusFirst.current = true
      setOpen(true)
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={onClick}
        onKeyDown={onButtonKeyDown}
        className={`min-h-11 px-2 lg:px-3 inline-flex items-center gap-1.5 whitespace-nowrap text-sm transition-colors cursor-pointer ${open ? 'text-white' : 'text-zinc-400 hover:text-white'}`}
      >
        Solutions
        <Chevron />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        hidden={!open}
        className="absolute top-full -left-2 w-[560px] p-4 grid grid-cols-2 gap-x-5 gap-y-1 rounded-xl border border-white/10 bg-zinc-950 shadow-2xl shadow-black/50"
      >
        {SOLUTIONS.map(group => (
          <div key={group.heading}>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{group.heading}</p>
            {group.items.map(item => (
              <a
                key={item.label}
                href={item.href}
                onClick={() => setOpen(false)}
                className="block min-h-11 -mx-2 p-2 rounded-lg hover:bg-white/5 transition-colors"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                  {item.label}
                  {'tag' in item && <OnlyTag />}
                </span>
                <span className="block mt-0.5 text-xs leading-snug text-zinc-500">{item.text}</span>
              </a>
            ))}
          </div>
        ))}
        <div className="col-span-2 mt-2 pt-2 border-t border-white/8 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <a href="/#developers" onClick={() => setOpen(false)} className="inline-flex items-center min-h-11 px-2 text-[13px] text-zinc-400 hover:text-white transition-colors">
            Developers — SSH keys, API keys, .env files
          </a>
          <a href="/ai-agents" onClick={() => setOpen(false)} className="inline-flex items-center min-h-11 px-2 text-[13px] text-teal-400 hover:text-white transition-colors">
            Secure AI agents →
          </a>
        </div>
      </div>
    </div>
  )
}

function DashboardButton() {
  return (
    <a
      href="/dashboard"
      className="text-sm font-medium min-h-11 px-4 whitespace-nowrap rounded-lg bg-gradient-to-r from-teal-500 to-emerald-500 text-black hover:from-teal-400 hover:to-emerald-400 transition-colors inline-flex items-center gap-1.5"
    >
      Dashboard
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </a>
  )
}

export default function Navbar() {
  const scrolled = useSyncExternalStore(subscribeScroll, isScrolled, serverScrolled)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { user } = useAuth()
  const mobileId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!mobileOpen) return
    const md = window.matchMedia('(min-width: 768px)')
    const onWide = () => { if (md.matches) setMobileOpen(false) }
    md.addEventListener('change', onWide)
    return () => md.removeEventListener('change', onWide)
  }, [mobileOpen])

  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileOpen(false)
        toggleRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  const solid = scrolled || mobileOpen
  const closeMobile = () => setMobileOpen(false)

  return (
    <nav
      aria-label="Main"
      className={`fixed top-0 inset-x-0 z-50 border-b transition-[background-color,border-color] duration-300 ${
        solid ? 'bg-[#0a0a0f]/90 backdrop-blur-md border-white/5' : 'bg-transparent border-transparent'
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5 min-h-11">
          <Logo size={28} className="rounded-lg" />
          <span className="font-semibold text-white text-sm tracking-tight">OTPilot</span>
        </a>

        <div className="hidden md:flex items-center lg:gap-2">
          <SolutionsMenu />
          <a href="/ai-agents" className="min-h-11 px-2 lg:px-3 inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-zinc-400 hover:text-white transition-colors">
            AI agents
            <NewTag />
          </a>
          {LINKS.map(l => (
            <a key={l.href} href={l.href} className="min-h-11 px-2 lg:px-3 inline-flex items-center whitespace-nowrap text-sm text-zinc-400 hover:text-white transition-colors">
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {!user && (
            <a href="/auth/login" className="hidden md:inline-flex items-center min-h-11 px-2 lg:px-3 whitespace-nowrap text-sm text-zinc-400 hover:text-white transition-colors">
              Sign in
            </a>
          )}
          <DashboardButton />
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={mobileOpen}
            aria-controls={mobileId}
            aria-label="Menu"
            onClick={() => setMobileOpen(o => !o)}
            className="md:hidden inline-flex items-center justify-center w-11 h-11 rounded-lg text-zinc-300 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              {mobileOpen
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>

      <div id={mobileId} hidden={!mobileOpen} className="md:hidden border-t border-white/5 px-6 pb-6 max-h-[calc(100vh-4rem)] overflow-y-auto">
        {SOLUTIONS.map(group => (
          <div key={group.heading} className="pt-4">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{group.heading}</p>
            {group.items.map(item => (
              <a key={item.label} href={item.href} onClick={closeMobile} className="flex items-center gap-2 min-h-11 text-sm text-zinc-200 hover:text-white">
                {item.label}
                {'tag' in item && <OnlyTag />}
              </a>
            ))}
          </div>
        ))}
        <div className="pt-4 mt-4 border-t border-white/5">
          <a href="/#developers" onClick={closeMobile} className="flex items-center min-h-11 text-sm text-zinc-200 hover:text-white">Developers</a>
          <a href="/ai-agents" onClick={closeMobile} className="flex items-center min-h-11 text-sm text-zinc-200 hover:text-white">AI agents</a>
          {LINKS.map(l => (
            <a key={l.href} href={l.href} onClick={closeMobile} className="flex items-center min-h-11 text-sm text-zinc-200 hover:text-white">{l.label}</a>
          ))}
          {!user && (
            <a href="/auth/login" onClick={closeMobile} className="flex items-center min-h-11 text-sm text-zinc-400 hover:text-white">Sign in</a>
          )}
        </div>
      </div>
    </nav>
  )
}
