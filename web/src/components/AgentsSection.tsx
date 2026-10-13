import AgentTerminal from './AgentTerminal'

const points = [
  {
    title: 'Never in the chat',
    text: 'Your agent asks OTPilot to sign in or run a command. OTPilot uses the password and the 2FA code on its side and hands back only the result.',
  },
  {
    title: 'You approve every agent',
    text: 'Each agent connects with a code you check, and gets no accounts until you allow them: BBVA for Claude Code, not for Codex.',
  },
  {
    title: 'Passwords and 2FA, together',
    text: 'The whole sign-in, second factor included, so your agent can actually test the login instead of stopping at the code.',
  },
]

export default function AgentsSection() {
  return (
    <section id="ai-agents" className="relative py-24 px-6 border-t border-white/5 overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[520px] h-[520px] bg-violet-500/10 rounded-full blur-[120px]" />
      </div>
      <div className="relative max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-violet-400/25 bg-violet-500/10 text-violet-300 text-xs font-medium mb-6">
            <span className="px-1.5 py-0.5 rounded-md bg-violet-400 text-black text-[10px] font-bold tracking-wider">NEW</span>
            Agentic sign-in · OTPilot for AI agents
          </div>
          <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight leading-[1.1] mb-5">
            Your AI agent can sign in.{' '}
            <span className="bg-gradient-to-r from-violet-300 to-teal-300 bg-clip-text text-transparent">
              It never sees the password.
            </span>
          </h2>
          <p className="text-lg text-zinc-400 leading-relaxed mb-8">
            Claude Code, Codex, Cursor or any MCP agent can log in to a site, pass the 2FA step and run commands with
            your credentials, using only the accounts you allow. Stop pasting secrets into chats.
          </p>
          <ul className="space-y-5 mb-9">
            {points.map(p => (
              <li key={p.title} className="flex gap-3">
                <svg className="w-5 h-5 text-violet-300 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                <div>
                  <p className="text-white font-semibold text-sm">{p.title}</p>
                  <p className="text-zinc-400 text-sm leading-relaxed">{p.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href="/ai-agents"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-violet-400 to-teal-400 text-black font-semibold hover:opacity-90 transition-opacity"
            >
              See how it works
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </a>
            <span className="inline-flex items-center justify-center px-4 py-3 text-sm text-zinc-500">
              Included in the free plan
            </span>
          </div>
        </div>
        <AgentTerminal />
      </div>
    </section>
  )
}
