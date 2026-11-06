import AgentTerminal from './AgentTerminal'

const steps = [
  {
    title: 'Connect',
    text: 'Run npx -y @otpilot/mcp@latest connect --name "Claude Code". It starts with zero accounts.',
  },
  {
    title: 'Verify & approve',
    text: 'Compare the XXXX-XXXX code with the one in the extension, then approve the agent there.',
  },
  {
    title: 'Use',
    text: 'Allow it account by account. Every use through OTPilot\'s tools is logged, never a value.',
  },
]

const advantages = [
  'Per-account grants, revocable one by one',
  'Scopes: 2FA only, the whole sign-in, or chosen fields',
  'Expiry, or ask every time',
  'Command allowlist per account',
  "Sign-in only on the account's own site, over HTTPS (plain HTTP only for local addresses)",
  'Env vars for that command and what it starts',
  'Scrubbed output',
  'Activity log without values',
  'Revoke an agent or an account at any time',
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
              It is never handed the password.
            </span>
          </h2>
          <p className="text-lg text-zinc-400 leading-relaxed mb-8">
            Claude Code, Codex, Cursor or any MCP agent can log in to a site, pass the 2FA step and run commands with
            your credentials, using only the accounts you allow. Stop pasting secrets into chats.
          </p>
          <ol className="space-y-4 mb-8">
            {steps.map((p, n) => (
              <li key={p.title} className="flex gap-3">
                <span className="w-6 h-6 rounded-full border border-violet-400/40 bg-violet-500/10 text-violet-300 text-xs font-semibold flex items-center justify-center shrink-0 mt-0.5">
                  {n + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-white font-semibold text-sm">{p.title}</p>
                  <p className="text-zinc-400 text-sm leading-relaxed break-words">{p.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 mb-8">
            {advantages.map(t => (
              <li key={t} className="flex gap-2.5 text-sm text-zinc-300 leading-relaxed">
                <svg className="w-4 h-4 text-violet-300 mt-1 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                <span className="min-w-0">{t}</span>
              </li>
            ))}
          </ul>
          <div className="rounded-xl border border-amber-400/20 bg-amber-500/5 p-4 mb-8">
            <p className="text-amber-200 font-semibold text-sm mb-1">The honest limit</p>
            <p className="text-zinc-400 text-sm leading-relaxed">
              No OTPilot tool returns a secret. But an approved agent acts with its account, and a command it runs
              could print a secret: output is scrubbed (base64, hex, URL, JSON forms), which is not a guarantee. A
              sign-in leaves a session file in .otpilot/. An agent with its own shell on your machine can read the MCP's stored key and open the copies you granted, without a log entry. Only allow what you would trust the agent with.
            </p>
          </div>
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
          <p className="mt-5 text-sm text-zinc-500">Works with Claude Code, Codex, Cursor and any MCP client.</p>
        </div>
        <AgentTerminal />
      </div>
    </section>
  )
}
