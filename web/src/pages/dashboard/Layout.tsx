import { NavLink, Outlet, Navigate, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../lib/useAuth'
import { supabase } from '../../lib/supabase'
import Logo from '../../components/Logo'

const navItems = [
  { to: '/dashboard',          label: 'Overview',  end: true },
  { to: '/dashboard/billing',  label: 'Billing' },
  { to: '/dashboard/team',     label: 'Team' },
  { to: '/dashboard/settings', label: 'Settings' },
]

export default function DashboardLayout() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-teal-400/30 border-t-teal-400 animate-spin" />
      </div>
    )
  }

  if (!user) return <Navigate to="/" replace />

  async function handleSignOut() {
    queryClient.clear()
    await supabase.auth.signOut()
    navigate('/', { replace: true })
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Top bar */}
      <header className="border-b border-zinc-800 px-6 h-14 flex items-center gap-4">
        <a href="/" className="flex items-center gap-2 mr-4">
          <Logo size={22} />
          <span className="font-bold text-sm text-zinc-100">OTPilot</span>
        </a>

        <nav className="flex gap-1">
          {navItems.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-zinc-500 hidden sm:block">{user.email}</span>
          <button
            onClick={handleSignOut}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Page content */}
      <main className="max-w-4xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
