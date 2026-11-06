const GITHUB_URL = 'https://github.com/OTPilot/OTPilot'

const ON_DEVICE = [
  'Your master password. It is never sent.',
  'Your vault key (also your recovery key), made on your device',
  'Your passwords, notes, 2FA secrets, keys and files, decrypted',
  'With a team plan, your sharing private key (ECDH P-256), kept under your vault key',
]

// What the API stores or sees in clear (api/migrations). Keep it honest.
const ON_SERVER = [
  'Your email, plan and Stripe customer id',
  'Your devices (name, OS, browser) and their sync logs',
  'Per encrypted item: id, revision, timestamps, whether it counts toward the Free limit, size',
  'Team name, members and roles, invites and share grants',
  "A shared 2FA code's account name and email",
  'The team activity log (who viewed or copied a team code, invites, removals)',
  'AI agents: name, machine and client, and the text of their requests',
  "What each agent did (the sites it signed in to, the programs it ran), and each grant's scope, expiry and allowed commands",
  'IP addresses, used for rate limiting',
  'The website domains we fetch icons for',
]

type Kind = 'e2e' | 'never-sent' | 'not-e2e'
const KIND_LABEL: Record<Kind, string> = { e2e: 'End-to-end encrypted', 'never-sent': 'Never sent', 'not-e2e': 'Not end-to-end' }

const ROWS: { what: string; kind: Kind; sees: string; never: string }[] = [
  {
    what: 'Personal vault and sync',
    kind: 'e2e',
    sees: 'Encrypted items, their ids, revisions, timestamps and sizes',
    never: 'Your passwords, notes, 2FA secrets, keys, files and item titles',
  },
  {
    what: 'Collections and item shares',
    kind: 'e2e',
    sees: 'Members, roles and grants',
    never: "A collection's name and the items in it or shared",
  },
  {
    what: 'AI agent copies',
    kind: 'e2e',
    sees: 'The agent, which item it was given, the grant\'s scope, expiry and allowed commands, and the sites and programs it used',
    never: 'The copy itself: only the agent can open it',
  },
  {
    what: 'Master password and recovery key',
    kind: 'never-sent',
    sees: 'Nothing: they never leave your devices',
    never: 'Either of them',
  },
  {
    what: 'Team 2FA codes (2-of-2)',
    kind: 'not-e2e',
    sees: "The account name and email, who viewed or copied it, and the secret briefly each time it rebuilds it to make a code",
    never: 'A copy of our database alone can\'t rebuild the secret. Teammates get the code, never the secret.',
  },
]

const LICENCES = [
  { part: 'Extension', licence: 'GPL-3.0' },
  { part: 'API', licence: 'AGPL-3.0' },
  { part: 'MCP server', licence: 'GPL-3.0' },
  { part: 'Website', licence: 'MIT' },
]

function Check({ className }: { className: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="m5 12 5 5 9-10" />
    </svg>
  )
}

function Step({ title, detail, accent }: { title: string; detail?: string; accent?: boolean }) {
  return (
    <li
      className={`flex-1 min-w-0 rounded-xl border px-4 py-3 ${
        accent ? 'border-teal-400/30 bg-teal-500/10' : 'border-white/10 bg-zinc-950'
      }`}
    >
      <p className="text-sm font-semibold text-white">{title}</p>
      {detail && <p className="mt-0.5 text-xs text-zinc-400 leading-snug">{detail}</p>}
    </li>
  )
}

function FlowArrow() {
  return (
    <li aria-hidden="true" className="flex items-center justify-center text-zinc-600 shrink-0">
      <svg className="w-4 h-4 rotate-90 md:rotate-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m-5-5 5 5-5 5" />
      </svg>
    </li>
  )
}

export default function SecuritySection() {
  return (
    <section id="security" className="py-24 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">
            How OTPilot{' '}
            <span className="bg-gradient-to-r from-teal-400 to-emerald-400 bg-clip-text text-transparent">keeps you safe</span>
          </h2>
          <p className="text-zinc-400 max-w-2xl mx-auto">
            Your vault is encrypted on your device with AES-256-GCM before it syncs. Here is what stays with you, what
            our server holds, and where the limits are.
          </p>
        </div>

        {/* Ledger */}
        <div className="grid gap-4 md:grid-cols-2 mb-6">
          <div className="rounded-2xl border border-teal-500/15 bg-gradient-to-br from-teal-400/10 to-teal-400/5 p-6">
            <h3 className="text-white font-semibold mb-4">On your device</h3>
            <ul className="space-y-2.5">
              {ON_DEVICE.map(t => (
                <li key={t} className="flex gap-2.5 text-sm text-zinc-300">
                  <Check className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
            <h3 className="text-white font-semibold mb-1">On our server</h3>
            <p className="text-xs text-zinc-500 mb-4">Readable by us, besides the encrypted data we can't open:</p>
            <ul className="space-y-2.5">
              {ON_SERVER.map(t => (
                <li key={t} className="flex gap-2.5 text-sm text-zinc-400">
                  <span className="w-1.5 h-1.5 mt-2 shrink-0 rounded-full bg-zinc-600" aria-hidden="true" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Keys */}
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6 mb-6">
          <h3 className="text-white font-semibold mb-4">How your keys fit together</h3>
          <ol className="flex flex-col md:flex-row gap-2 md:items-stretch" aria-label="From your master password to your encrypted items">
            <Step title="Master password" detail="Typed on your device, never sent" />
            <FlowArrow />
            <Step title="PBKDF2-SHA256" detail="600,000 iterations" />
            <FlowArrow />
            <Step title="Vault key" detail="Random, made on your device; the master password unlocks it" accent />
            <FlowArrow />
            <Step title="A key per item" detail="Each item encrypted with AES-256-GCM before it syncs" />
          </ol>
          <p className="mt-4 text-sm text-zinc-400 leading-relaxed">
            <span className="text-zinc-200 font-medium">AI agents:</span> an agent gets a scoped copy of one item under
            a fresh key, wrapped to the agent's own ECDH P-256 key.{' '}
            <span className="text-zinc-200 font-medium">Teams:</span> collections and shared items have their own keys,
            wrapped to each teammate's ECDH P-256 key.
          </p>
        </div>

        {/* Can / can't see */}
        <div className="rounded-2xl border border-white/8 overflow-hidden mb-6">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <caption className="sr-only">What OTPilot's server can and can't see</caption>
              <thead className="bg-white/[0.03] text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold">Data</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Our server can see</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Our server can't see</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {ROWS.map(r => (
                  <tr key={r.what} className="align-top">
                    <th scope="row" className="px-5 py-4 font-medium text-white">
                      {r.what}
                      <span
                        className={`block mt-1 text-[11px] font-semibold uppercase tracking-wide ${
                          r.kind === 'not-e2e' ? 'text-amber-400' : 'text-emerald-400'
                        }`}
                      >
                        {KIND_LABEL[r.kind]}
                      </span>
                    </th>
                    <td className="px-5 py-4 text-zinc-400">{r.sees}</td>
                    <td className="px-5 py-4 text-zinc-300">{r.never}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-white/5 px-5 py-4 space-y-2 text-xs leading-relaxed text-zinc-500">
            <p>
              Team 2FA codes: the key is split in two halves, one wrapped to the teammate's device key and one on our
              server. To make each code the server rebuilds the secret briefly, so it is not end-to-end against a live
              server; it protects against a database leak.
            </p>
            <p>
              AI agents: no tool returns a secret, but a command an agent runs could print one. Its output is scrubbed of
              the secrets it used (base64, hex, URL and JSON forms too), which is not a guarantee, and a sign-in leaves
              a session file in <code className="text-zinc-400">.otpilot/</code>. An agent with its own shell on your
              machine can read the MCP's stored key and open the copies you granted, without a log entry.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <a href="/security" className="inline-flex items-center gap-1.5 min-h-11 font-medium text-teal-400 hover:text-white transition-colors">
            Read the security details
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </a>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span className="text-zinc-300 font-medium">Open source</span>
            {LICENCES.map(l => (
              <span key={l.part}>
                {l.part} <span className="text-zinc-400">{l.licence}</span>
              </span>
            ))}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center min-h-11 text-teal-400 hover:text-white transition-colors"
            >
              View on GitHub →
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
