import Logo from './Logo'

export default function Footer() {
  return (
    <footer className="border-t border-white/5 py-12 px-6">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-2.5">
          <Logo size={24} className="rounded-md" />
          <span className="text-sm font-medium text-zinc-400">OTPilot</span>
        </div>

        <div className="flex flex-wrap justify-center gap-6">
          <a href="/tos" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">Terms of Service</a>
          <a href="/privacy" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">Privacy Policy</a>
          <a href="/gdpr" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">GDPR</a>
          <a href="/refunds" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">Refund Policy</a>
          <a
            href="https://github.com/otpilot-app/otpilot"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            GitHub
          </a>
          <a href="mailto:hello@otpilot.app" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
            Contact
          </a>
        </div>

      </div>
    </footer>
  )
}
