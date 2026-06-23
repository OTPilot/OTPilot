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
          <a href="/security" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">Security</a>
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

        <div className="flex items-center gap-4">
          <a
            href="https://x.com/otpilotapp"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="OTPilot on X"
            className="text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
            </svg>
          </a>
          <a
            href="https://www.youtube.com/@otpilotapp"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="OTPilot on YouTube"
            className="text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814ZM9.546 15.568V8.432L15.818 12l-6.273 3.568Z" />
            </svg>
          </a>
        </div>

      </div>
    </footer>
  )
}
