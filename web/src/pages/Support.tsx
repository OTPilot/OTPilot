import { useCrisp } from '../lib/useCrisp'
import { useAuth } from '../lib/useAuth'
import Logo from '../components/Logo'

export default function Support() {
  const { user } = useAuth()
  useCrisp({
    email: user?.email,
    name:  user?.user_metadata?.full_name,
    open:  true,
  })

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center gap-3 text-zinc-500">
      <Logo size={28} />
      <p className="text-sm">Loading support chat…</p>
    </div>
  )
}
