import { useRef, useState, type KeyboardEvent } from 'react'

// How to connect each agent to OTPilot (mirrors mcp/README.md and what
// `npx -y @otpilot/mcp connect` prints).
const CLIENTS: { id: string; label: string; steps: { text: string; code?: string }[] }[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    steps: [
      { text: 'Install the plugin (the MCP server plus a skill that teaches Claude to use it):', code: '/plugin install otpilot --marketplace OTPilot/OTPilot' },
      { text: 'Connect it once, then approve it in the extension if the codes match:', code: 'npx -y @otpilot/mcp connect --name "Claude Code"' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    steps: [
      { text: 'Connect it, then approve it in the extension if the codes match:', code: 'npx -y @otpilot/mcp connect --name Codex' },
      { text: 'Add the server to ~/.codex/config.toml:', code: '[mcp_servers.otpilot]\ncommand = "npx"\nargs = ["-y", "@otpilot/mcp", "--profile", "codex"]' },
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    steps: [
      { text: 'Connect it, then approve it in the extension if the codes match:', code: 'npx -y @otpilot/mcp connect --name Cursor' },
      { text: 'Add the server to ~/.cursor/mcp.json:', code: '{\n  "mcpServers": {\n    "otpilot": { "command": "npx", "args": ["-y", "@otpilot/mcp", "--profile", "cursor"] }\n  }\n}' },
    ],
  },
  {
    id: 'server',
    label: 'Server / VPS',
    steps: [
      { text: 'On the machine where your agent runs (Node 20+), connect it. Open the link it prints on any device signed in to OTPilot, and approve it in the extension if the codes match:', code: 'npx -y @otpilot/mcp connect --name VPS --no-open' },
      { text: 'Point your agent at the server over stdio:', code: 'npx -y @otpilot/mcp --profile vps' },
      { text: 'For browser sign-ins on a server without Chrome, add a headless Chromium. The credentials stay on that machine (a 0600 file when it has no keychain), so only connect machines you trust.', code: 'npx playwright install --with-deps chromium' },
    ],
  },
  {
    id: 'other',
    label: 'Any MCP agent',
    steps: [
      { text: 'Connect it with a name of your choice, then approve it in the extension if the codes match:', code: 'npx -y @otpilot/mcp connect --name "My agent"' },
      { text: 'Run the server over stdio with the profile connect printed:', code: 'npx -y @otpilot/mcp --profile my-agent' },
    ],
  },
]

export default function AgentSetup() {
  const [tab, setTab] = useState('claude')
  const client = CLIENTS.find(c => c.id === tab)!
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  // Arrow keys (and Home / End) move between tabs, as a tablist should.
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = CLIENTS.length
    const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    setTab(CLIENTS[to].id)
    tabs.current[to]?.focus()
  }
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden text-left">
      <div className="flex flex-wrap gap-1 p-2 border-b border-white/10" role="tablist" aria-label="Your agent">
        {CLIENTS.map((c, i) => (
          <button
            key={c.id}
            ref={el => { tabs.current[i] = el }}
            id={`setup-tab-${c.id}`}
            role="tab"
            aria-selected={tab === c.id}
            aria-controls="setup-panel"
            tabIndex={tab === c.id ? 0 : -1}
            onKeyDown={e => onKey(e, i)}
            onClick={() => setTab(c.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === c.id ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white'}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <ol className="p-5 space-y-4" id="setup-panel" role="tabpanel" aria-labelledby={`setup-tab-${tab}`}>
        {client.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="w-6 h-6 shrink-0 rounded-full bg-violet-400/15 text-violet-300 text-xs font-bold flex items-center justify-center">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-300 mb-2">{s.text}</p>
              {s.code && <pre className="text-[12.5px] font-mono text-zinc-200 bg-black/40 border border-white/10 rounded-lg p-3 overflow-x-auto whitespace-pre">{s.code}</pre>}
            </div>
          </li>
        ))}
        <li className="flex gap-3">
          <span className="w-6 h-6 shrink-0 rounded-full bg-violet-400/15 text-violet-300 text-xs font-bold flex items-center justify-center">{client.steps.length + 1}</span>
          <p className="text-sm text-zinc-300">In the extension, open <b className="text-white">Agents</b> and allow it the accounts it may use — or let it ask as it works.</p>
        </li>
      </ol>
    </div>
  )
}
