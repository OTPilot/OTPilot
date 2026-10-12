// A coding agent's session using OTPilot: the model only ever handles account
// names and results — never a password or a 2FA code.
const lines: { kind: 'user' | 'tool' | 'more' | 'out' | 'ok' | 'wait' | 'say' | 'dim' | 'blank'; text: string }[] = [
  { kind: 'user', text: '> Test the staging login and check the dashboard loads the payments' },
  { kind: 'blank', text: '' },
  { kind: 'tool', text: 'otpilot.list_accounts()' },
  { kind: 'out', text: 'GitHub (2FA, login) · AWS staging (2FA, login) · acme-db (password)' },
  { kind: 'blank', text: '' },
  { kind: 'tool', text: 'otpilot.browser_login(account: "AWS staging")' },
  { kind: 'wait', text: 'pending_approval — approve "Claude Code → AWS staging" in OTPilot' },
  { kind: 'blank', text: '' },
  { kind: 'say', text: 'I need access to AWS staging. Approve it in OTPilot and I\'ll continue.' },
  { kind: 'blank', text: '' },
  { kind: 'tool', text: 'otpilot.browser_login(account: "AWS staging")' },
  { kind: 'ok', text: 'signed_in — session saved to .otpilot/aws-staging.json (expires 1h)' },
  { kind: 'blank', text: '' },
  { kind: 'tool', text: 'playwright.open("https://staging.acme.io/payments",' },
  { kind: 'more', text: '              storageState: ".otpilot/aws-staging.json")' },
  { kind: 'out', text: '200 · 14 payments listed' },
  { kind: 'blank', text: '' },
  { kind: 'tool', text: 'otpilot.run("psql -h db.staging -c \'select count(*) from payments\'",' },
  { kind: 'more', text: '           env: { PGPASSWORD: "acme-db/password" })' },
  { kind: 'out', text: 'count: 14   (secrets redacted from output)' },
  { kind: 'blank', text: '' },
  { kind: 'say', text: 'Done: the staging login works and the dashboard shows all 14 payments.' },
  { kind: 'dim', text: 'I never saw the password or the 2FA code.' },
]

const color: Record<string, string> = {
  user: 'text-zinc-100',
  tool: 'text-violet-300',
  more: 'text-violet-300',
  out: 'text-zinc-500',
  ok: 'text-emerald-400',
  wait: 'text-amber-300',
  say: 'text-zinc-200',
  dim: 'text-zinc-500',
  blank: '',
}

export default function AgentTerminal({ title = 'claude — ~/code/acme' }: { title?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl shadow-black/50 overflow-hidden text-left">
      <div className="h-9 bg-[#161b22] flex items-center gap-2 px-4">
        <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-xs text-zinc-500 font-mono">{title}</span>
      </div>
      <pre className="p-5 text-[12.5px] leading-relaxed font-mono whitespace-pre-wrap overflow-x-auto">
        {lines.map((l, i) => (
          <div key={i} className={color[l.kind]}>
            {l.kind === 'tool' && <span className="text-violet-400">● </span>}
            {(l.kind === 'out' || l.kind === 'ok' || l.kind === 'wait') && <span className="text-zinc-600">  ⎿ </span>}
            {(l.kind === 'say' || l.kind === 'dim') && '  '}
            {l.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}
