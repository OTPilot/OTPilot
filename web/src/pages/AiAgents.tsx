import { Head } from 'vite-react-ssg'
import { Seo } from '../seo'
import Navbar from '../components/Navbar'
import Footer from '../components/Footer'
import AgentTerminal from '../components/AgentTerminal'
import AgentSetup from '../components/AgentSetup'
import { CHROME_STORE_URL } from '../lib/browser'
import { FREE_AGENTS, FREE_AGENT_ACCOUNTS } from '../lib/agents'

// The 2.1 feature page: OTPilot for AI agents. Every claim here must match
// what the extension + the OTPilot MCP server do — check before adding one.

const problems = [
  {
    title: 'Pasted into the chat',
    text: 'A password typed into a prompt lives on in the transcript, your history, logs and the model provider\'s servers.',
  },
  {
    title: 'Left in a .env file',
    text: 'Plaintext on disk, one wrong commit away from a public repo, and readable by every tool your agent runs.',
  },
  {
    title: 'Stuck at the 2FA step',
    text: 'Even with the password, the agent stops at "enter the code from your app" and hands the task back to you.',
  },
]

const steps = [
  {
    n: '01',
    title: 'Connect your agent',
    text: 'Add the OTPilot MCP server to Claude Code, Codex, Cursor or any MCP client. It shows a short code; approve it in the extension if the codes match.',
  },
  {
    n: '02',
    title: 'Choose its accounts',
    text: 'A new agent gets nothing. Allow accounts one by one, per agent, and pick what each can use: just the 2FA code, the whole sign-in, or chosen fields.',
  },
  {
    n: '03',
    title: 'Let it work',
    text: 'The agent asks OTPilot to sign in or run a command. OTPilot does it with the real values and returns the result. Need another account? You get a request to approve.',
  },
]

const abilities = [
  {
    title: 'Sign in to websites',
    text: 'Username, password and the 2FA code, on the account\'s own site only. Your agent\'s browser gets the signed-in session, never the credentials.',
  },
  {
    title: 'Run commands with secrets',
    text: 'psql, curl, deploy scripts: secrets go in as environment variables for that one process, and are scrubbed from the output before your agent reads it.',
  },
  {
    title: 'Fresh 2FA codes for scripts',
    text: 'End-to-end tests that log in with 2FA get a current code injected at run time, so the test passes without a human holding a phone.',
  },
  {
    title: 'Know what it can use',
    text: 'The agent can list the accounts you allowed it, by name and site. Nothing else in your vault exists for it.',
  },
]

const security = [
  {
    title: 'Encrypted for that agent only',
    text: 'Each agent has its own key, kept in your computer\'s keychain. An account you allow is encrypted for that key alone; our servers only ever see ciphertext.',
  },
  {
    title: 'Two approvals',
    text: 'Connecting an agent gives it no accounts. Every account is a separate approval, per agent: two agents, two decisions.',
  },
  {
    title: 'A code to catch impostors',
    text: 'The code in your terminal and the one in OTPilot must match before you approve, so nobody can slip in their own "Claude Code".',
  },
  {
    title: 'Ask every time',
    text: 'For the accounts that matter most, OTPilot asks you before each use, and you can allow an account for an hour instead of for good.',
  },
  {
    title: 'Every use on record',
    text: 'The activity log shows which agent used which account, when and for what. Revoke an agent, or a single account, in one click.',
  },
  {
    title: 'Only on the right site',
    text: 'A sign-in is only ever made on the site saved in the account, so a prompt injection can\'t send your password somewhere else.',
  },
]

const faq = [
  {
    q: 'Which agents work with OTPilot?',
    a: 'Any agent that supports the Model Context Protocol (MCP): Claude Code, Codex, Cursor, Claude Desktop and others. Each one is connected and approved separately.',
  },
  {
    q: 'Does my agent use the browser extension?',
    a: 'No. You manage everything in the extension: which agents are connected and which accounts each can use. The agent only talks to the OTPilot MCP server running on your computer, which signs in or runs the command and returns the result.',
  },
  {
    q: 'Can the AI model see my password or 2FA code?',
    a: 'Not through OTPilot: no tool returns a secret. The agent gets results ("signed in", a command\'s output with secrets scrubbed). An agent that runs commands decides what they do, though, and could try to reveal a secret on purpose. For sensitive accounts, allow only the 2FA code, limit the commands, or turn on "ask every time".',
  },
  {
    q: 'Do I need an account? What does the agent receive?',
    a: 'You need a free OTPilot account (a free plan works) so the agent can receive what you allow. For each account you allow, OTPilot uploads a copy encrypted for that agent\'s key, holding only what you chose. Connecting an agent uploads nothing else; if you use sync, the rest of your vault stays encrypted under your own key, which agents never get.',
  },
  {
    q: 'Does it work when Chrome is closed?',
    a: 'Yes, for accounts you allowed until you revoke them: the agent doesn\'t need the browser. Approving a new request, or an account set to "ask every time", needs the extension.',
  },
  {
    q: 'What does it cost?',
    a: `It's included in every plan. Free connects ${FREE_AGENTS} agent with up to ${FREE_AGENT_ACCOUNTS} accounts; Personal and Team have no limit on agents or accounts.`,
  },
  {
    q: 'What if my agent is compromised?',
    a: 'It can only open the accounts you allowed it, not your vault. Revoke the agent in OTPilot so it can\'t get them again, and change the passwords of the accounts it had. A compromised computer is a bigger problem, as with any password manager: whoever controls it can also capture your vault when you unlock it.',
  },
]

function Check({ className = 'text-violet-300' }: { className?: string }) {
  return (
    <svg className={`w-4 h-4 mt-0.5 shrink-0 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  )
}

export default function AiAgents() {
  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      <Seo
        title="OTPilot for AI agents — let agents sign in without seeing your passwords"
        description="Let Claude Code, Codex, Cursor or any MCP agent sign in with your passwords and 2FA codes without ever seeing them. Approve each agent and each account. Free to start."
        path="/ai-agents"
        image="https://otpilot.app/og-agents.png"
        imageAlt="OTPilot 2.1 for AI agents: a coding agent signs in through OTPilot while the extension asks to allow it, without the agent seeing the password"
      />
      <Head>
        <script type="application/ld+json">{JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
        })}</script>
      </Head>
      <Navbar />

      {/* Hero */}
      <section className="relative pt-36 pb-20 px-6 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[700px] h-[600px] bg-violet-500/10 rounded-full blur-[130px]" />
          <div className="absolute top-1/2 left-1/4 w-[400px] h-[400px] bg-teal-500/8 rounded-full blur-[110px]" />
        </div>
        <div className="relative max-w-6xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-violet-400/25 bg-violet-500/10 text-violet-300 text-xs font-medium mb-8">
            <span className="px-1.5 py-0.5 rounded-md bg-violet-400 text-black text-[10px] font-bold tracking-wider">NEW</span>
            OTPilot 2.1 · for AI agents
          </div>
          <h1 className="text-5xl md:text-7xl font-bold text-white tracking-tight leading-[1.05] mb-6">
            Give your agents your logins.
            <br />
            <span className="bg-gradient-to-r from-violet-300 via-teal-300 to-emerald-300 bg-clip-text text-transparent">
              Not your passwords.
            </span>
          </h1>
          <p className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Claude Code, Codex and Cursor can sign in, pass the 2FA step and run commands with the accounts you allow.
            OTPilot uses the secrets; the model only sees the result.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16">
            <a
              href={CHROME_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-violet-400 to-teal-400 text-black font-semibold hover:opacity-90 transition-opacity shadow-lg shadow-violet-500/20"
            >
              Add to Chrome — it's free
            </a>
            <a
              href="#how"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-white/10 text-zinc-300 text-sm font-medium hover:border-white/20 hover:text-white transition-all"
            >
              How it works
            </a>
          </div>
          <div className="max-w-3xl mx-auto">
            <AgentTerminal />
          </div>
          <p className="mt-5 text-xs text-zinc-600">Works with any MCP agent · Off by default · Revoke anytime</p>
        </div>
      </section>

      {/* The problem */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight text-center mb-4">
            Agents need your logins. Today that means leaking them.
          </h2>
          <p className="text-zinc-400 text-center max-w-2xl mx-auto mb-12">
            Asking an agent to test a login, check a dashboard or query a database usually ends in one of these.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {problems.map(p => (
              <div key={p.title} className="p-6 rounded-2xl border border-rose-500/10 bg-gradient-to-br from-rose-400/[0.07] to-transparent">
                <p className="text-white font-semibold mb-2 text-sm">{p.title}</p>
                <p className="text-zinc-400 text-sm leading-relaxed">{p.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight text-center mb-4">How it works</h2>
          <p className="text-zinc-400 text-center max-w-xl mx-auto mb-14">
            You stay in the extension. Your agent stays in the terminal. The secrets stay with OTPilot.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {steps.map(s => (
              <div key={s.n} className="flex flex-col items-center text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-teal-500/10 border border-violet-400/20 flex items-center justify-center mb-6">
                  <span className="text-xl font-bold bg-gradient-to-r from-violet-300 to-teal-300 bg-clip-text text-transparent">{s.n}</span>
                </div>
                <h3 className="text-white font-semibold mb-2">{s.title}</h3>
                <p className="text-zinc-400 text-sm leading-relaxed max-w-xs">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Set up */}
      <section id="setup" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight text-center mb-4">Set it up in two minutes</h2>
          <p className="text-zinc-400 text-center max-w-xl mx-auto mb-10">
            You need the OTPilot extension and an OTPilot account (free works). Each agent is connected and approved on its own.
          </p>
          <AgentSetup />
        </div>
      </section>

      {/* What it can do */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight text-center mb-12">
            What your agent can do with it
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {abilities.map(a => (
              <div key={a.title} className="p-6 rounded-2xl border border-violet-400/10 bg-gradient-to-br from-violet-400/[0.08] to-teal-400/[0.03]">
                <p className="text-white font-semibold mb-2">{a.title}</p>
                <p className="text-zinc-400 text-sm leading-relaxed">{a.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Security */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight text-center mb-4">
            Built so you can say yes
          </h2>
          <p className="text-zinc-400 text-center max-w-2xl mx-auto mb-12">
            Everything is off by default. Each agent gets exactly what you approved, and nothing it can open without you.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {security.map(s => (
              <div key={s.title} className="p-6 rounded-2xl border border-white/8 bg-white/[0.03]">
                <div className="flex gap-2.5">
                  <Check className="text-teal-400" />
                  <div>
                    <p className="text-white font-semibold mb-1.5 text-sm">{s.title}</p>
                    <p className="text-zinc-400 text-sm leading-relaxed">{s.text}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-sm text-zinc-500 max-w-3xl mx-auto text-center mt-10 leading-relaxed">
            Honest limit: an agent that runs commands decides what those commands do, and could try to reveal a secret on purpose.
            OTPilot scrubs secrets from what it returns; for sensitive accounts, allow only the 2FA code, limit the commands,
            or turn on "ask every time".
          </p>
        </div>
      </section>

      {/* Plans */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight text-center mb-12">In every plan</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="p-7 rounded-2xl border border-white/8 bg-white/[0.03]">
              <p className="text-zinc-300 font-semibold mb-1">Free</p>
              <p className="text-3xl font-bold text-white mb-5">$0</p>
              <ul className="space-y-2.5 text-sm text-zinc-300">
                <li className="flex gap-2.5"><Check />{FREE_AGENTS} connected agent</li>
                <li className="flex gap-2.5"><Check />Up to {FREE_AGENT_ACCOUNTS} accounts for it</li>
                <li className="flex gap-2.5"><Check />Passwords and 2FA codes</li>
                <li className="flex gap-2.5"><Check />Activity log and revoke</li>
              </ul>
            </div>
            <div className="p-7 rounded-2xl border border-violet-400/30 bg-gradient-to-b from-violet-500/10 to-teal-500/5">
              <p className="text-violet-300 font-semibold mb-1">Personal &amp; Team</p>
              <p className="text-3xl font-bold text-white mb-5">from $3<span className="text-sm text-zinc-500 font-normal"> / month</span></p>
              <ul className="space-y-2.5 text-sm text-zinc-300">
                <li className="flex gap-2.5"><Check />Unlimited agents</li>
                <li className="flex gap-2.5"><Check />Unlimited accounts per agent</li>
                <li className="flex gap-2.5"><Check />Everything in your plan: sync, sharing…</li>
                <li className="flex gap-2.5"><Check />Activity log and revoke</li>
              </ul>
            </div>
          </div>
          <p className="text-center text-sm text-zinc-500 mt-8">
            <a href="/#pricing" className="text-violet-300 hover:text-violet-200">See all plans →</a>
            <span className="mx-3 text-zinc-700">·</span>
            <a href="/ai-agent-password-manager" className="text-violet-300 hover:text-violet-200">How it compares to 1Password and Bitwarden →</a>
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold text-white tracking-tight text-center mb-10">Questions</h2>
          <dl className="space-y-7">
            {faq.map(f => (
              <div key={f.q}>
                <dt className="text-white font-medium mb-1.5">{f.q}</dt>
                <dd className="text-zinc-400 leading-relaxed">{f.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-16 p-8 rounded-2xl border border-violet-400/20 bg-violet-500/5 text-center">
            <p className="text-2xl font-bold text-white mb-2">Let your agent finish the job</p>
            <p className="text-zinc-400 mb-6">Sign-ins, 2FA and secrets, handled by OTPilot. Free to start.</p>
            <a
              href={CHROME_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl bg-gradient-to-r from-violet-400 to-teal-400 text-black font-semibold hover:opacity-90 transition-opacity"
            >
              Add to Chrome — it's free
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}
