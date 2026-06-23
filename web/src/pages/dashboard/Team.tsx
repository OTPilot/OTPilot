import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../lib/api'
import { decryptVault, buildShare, type VaultAccount } from '../../lib/teamCrypto'

type Me = { id: string; plan: string }
type Team = { id: string; name: string; owner_id: string; seat_limit: number }
type Member = { user_id: string; email: string | null; role: string; joined_at: string; public_key: string | null }
type TeamDetail = { team: Team; members: Member[]; used_seats: number }
type MyShare = { id: string; account_name: string; account_email: string | null; recipients: number }
type SharedWithMe = { id: string; account_name: string; account_email: string | null; owner_email: string | null }
type AuditEntry = { actor_email: string | null; action: string; metadata: unknown; created_at: string }

async function getJSON<T>(path: string): Promise<T> {
  const res = await apiFetch(path)
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return res.json()
}

export default function Team() {
  const qc = useQueryClient()
  const { data: me } = useQuery<Me>({
    queryKey: ['user-plan'],
    queryFn: () => apiFetch('/auth/sync-user', { method: 'POST' }).then((r) => r.json()),
  })
  const { data: team } = useQuery<Team | null>({
    queryKey: ['team'],
    queryFn: () => getJSON<Team | null>('/teams'),
  })

  const isTeamPlan = me?.plan === 'team_lite' || me?.plan === 'team_pro'

  if (!isTeamPlan) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-zinc-100">Team</h1>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center space-y-3">
          <p className="text-sm text-zinc-400">Share TOTP codes with your team — securely.</p>
          <a href="/dashboard/billing" className="inline-block px-4 py-2 rounded-lg bg-teal-500 text-black text-sm font-semibold hover:bg-teal-400">
            Upgrade to Team
          </a>
        </div>
      </div>
    )
  }

  if (!team) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-zinc-100">Team</h1>
        <button
          onClick={async () => { await apiFetch('/teams', { method: 'POST', body: '{}' }); qc.invalidateQueries({ queryKey: ['team'] }) }}
          className="px-4 py-2 rounded-lg bg-teal-500 text-black text-sm font-semibold hover:bg-teal-400"
        >
          Create your team
        </button>
      </div>
    )
  }

  return <TeamView teamId={team.id} meId={me?.id ?? ''} />
}

function TeamView({ teamId, meId }: { teamId: string; meId: string }) {
  const qc = useQueryClient()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['team-detail', teamId] })
    qc.invalidateQueries({ queryKey: ['my-shares', teamId] })
    qc.invalidateQueries({ queryKey: ['shared-with-me', teamId] })
    qc.invalidateQueries({ queryKey: ['team-audit', teamId] })
  }

  const { data: detail } = useQuery<TeamDetail>({ queryKey: ['team-detail', teamId], queryFn: () => getJSON(`/teams/${teamId}`) })
  const { data: myShares = [] } = useQuery<MyShare[]>({ queryKey: ['my-shares', teamId], queryFn: () => getJSON(`/teams/${teamId}/codes/mine`) })
  const { data: sharedWithMe = [] } = useQuery<SharedWithMe[]>({ queryKey: ['shared-with-me', teamId], queryFn: () => getJSON(`/teams/${teamId}/codes`) })

  const isOwner = detail?.team.owner_id === meId

  // Audit is owner-only on the server — don't even call it for members (it 403s).
  const { data: audit = [] } = useQuery<AuditEntry[]>({
    queryKey: ['team-audit', teamId],
    queryFn: () => getJSON(`/teams/${teamId}/audit`),
    enabled: isOwner,
  })
  const [shareOpen, setShareOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')

  async function renameTeam() {
    const name = nameInput.trim()
    if (!name) { setEditingName(false); return }
    await apiFetch(`/teams/${teamId}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    setEditingName(false)
    refresh()
  }

  async function invite() {
    setErr(null)
    const res = await apiFetch(`/teams/${teamId}/invite`, { method: 'POST', body: JSON.stringify({ email: inviteEmail }) })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      const msg = j.error === 'seat_limit_reached' ? 'Seat limit reached — add a seat in Billing.'
        : j.error === 'user_already_in_team' ? 'That person already belongs to a team.'
        : 'Invite failed'
      setErr(msg)
      return
    }
    setInviteEmail('')
    refresh()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        {editingName ? (
          <div className="flex items-center gap-2">
            <input autoFocus value={nameInput} onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') renameTeam(); if (e.key === 'Escape') setEditingName(false) }}
              className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-lg font-bold text-zinc-100" />
            <button onClick={renameTeam} className="text-xs text-teal-400 hover:text-teal-300">Save</button>
            <button onClick={() => setEditingName(false)} className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
          </div>
        ) : (
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
            {detail?.team.name ?? 'Team'}
            {isOwner && (
              <button onClick={() => { setNameInput(detail?.team.name ?? ''); setEditingName(true) }}
                title="Rename team" className="text-xs text-zinc-500 hover:text-zinc-300 font-normal">Edit</button>
            )}
          </h1>
        )}
        {detail && <span className="text-xs text-zinc-500">{detail.used_seats} / {detail.team.seat_limit} seats</span>}
      </div>
      {err && <p className="text-sm text-red-400">{err}</p>}

      {/* Members */}
      <Section title="Members" action={isOwner && (
        <div className="flex gap-2">
          <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="email@…" className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200" />
          <button onClick={invite} className="px-3 py-1 rounded bg-teal-500 text-black text-xs font-semibold hover:bg-teal-400">Invite</button>
        </div>
      )}>
        {detail?.members.map((m) => (
          <Row key={m.user_id}>
            <span className="text-sm text-zinc-200">{m.email ?? m.user_id}{m.user_id === meId && ' (you)'}</span>
            <span className="text-xs text-zinc-500">{m.role}</span>
            {isOwner && m.role !== 'owner' && (
              <button onClick={async () => { await apiFetch(`/teams/${teamId}/members/${m.user_id}`, { method: 'DELETE' }); refresh() }} className="text-xs text-red-400 hover:text-red-300">Remove</button>
            )}
          </Row>
        ))}
      </Section>

      {/* Codes I'm sharing */}
      <Section title="Codes I'm sharing" action={
        <button onClick={() => setShareOpen(true)} className="px-3 py-1 rounded bg-white/10 text-white text-xs font-semibold hover:bg-white/15">+ Share a code</button>
      }>
        {myShares.length === 0 && <p className="text-xs text-zinc-600 px-1">Nothing shared yet.</p>}
        {myShares.map((c) => (
          <Row key={c.id}>
            <span className="text-sm text-zinc-200">{c.account_name}{c.account_email && <span className="text-zinc-500"> · {c.account_email}</span>}</span>
            <span className="text-xs text-zinc-500">{c.recipients} recipient(s)</span>
            <button onClick={async () => { await apiFetch(`/teams/${teamId}/codes/${c.id}`, { method: 'DELETE' }); refresh() }} className="text-xs text-red-400 hover:text-red-300">Revoke</button>
          </Row>
        ))}
      </Section>

      {/* Shared with me */}
      <Section title="Shared with me">
        {sharedWithMe.length === 0 && <p className="text-xs text-zinc-600 px-1">No codes shared with you.</p>}
        {sharedWithMe.map((c) => (
          <Row key={c.id}>
            <span className="text-sm text-zinc-200">{c.account_name}{c.account_email && <span className="text-zinc-500"> · {c.account_email}</span>}</span>
            <span className="text-xs text-zinc-500">from {c.owner_email ?? 'teammate'}</span>
            <button onClick={async () => { await apiFetch(`/teams/${teamId}/codes/${c.id}/access/${meId}`, { method: 'DELETE' }); refresh() }} className="text-xs text-red-400 hover:text-red-300">Remove</button>
          </Row>
        ))}
        <p className="text-xs text-zinc-600 px-1 pt-1">View live codes in the extension popup.</p>
      </Section>

      {/* Audit log */}
      {isOwner && (
        <Section title="Activity">
          {audit.length === 0 && <p className="text-xs text-zinc-600 px-1">No activity yet.</p>}
          {audit.slice(0, 50).map((a, i) => (
            <Row key={i}>
              <span className="text-xs text-zinc-300">{a.actor_email ?? 'someone'} · {a.action}</span>
              <span className="text-xs text-zinc-600">{new Date(a.created_at).toLocaleString()}</span>
            </Row>
          ))}
        </Section>
      )}

      {!isOwner && (
        <button onClick={async () => { await apiFetch(`/teams/${teamId}/leave`, { method: 'DELETE' }); location.reload() }} className="text-sm text-red-400 hover:text-red-300">Leave team</button>
      )}

      {shareOpen && detail && (
        <ShareModal teamId={teamId} members={detail.members.filter((m) => m.user_id !== meId)} onClose={() => setShareOpen(false)} onDone={() => { setShareOpen(false); refresh() }} />
      )}
    </div>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-300">{title}</h2>
        {action}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3 py-1.5 border-b border-zinc-800/60 last:border-0">{children}</div>
}

function ShareModal({ teamId, members, onClose, onDone }: {
  teamId: string; members: Member[]; onClose: () => void; onDone: () => void
}) {
  const [recoveryKey, setRecoveryKey] = useState('')
  const [accounts, setAccounts] = useState<VaultAccount[] | null>(null)
  const [selectedIdx, setSelectedIdx] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function unlock() {
    setErr(null); setBusy(true)
    try {
      const res = await apiFetch('/accounts')
      if (!res.ok) throw new Error('Could not load your vault')
      const body = await res.json()
      if (!body?.encrypted_blob) {
        throw new Error('No synced vault found. Enable sync in the extension first, or share directly from the extension.')
      }
      const accs = await decryptVault(body.encrypted_blob, recoveryKey.trim())
      setAccounts(accs.filter((a) => a.secret))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Wrong recovery key')
    } finally {
      setBusy(false)
    }
  }

  async function share() {
    setErr(null); setBusy(true)
    try {
      const acc = accounts![Number(selectedIdx)]
      if (!acc) throw new Error('Pick an account')
      const recipients = members.filter((m) => selectedMembers.includes(m.user_id)).map((m) => ({ user_id: m.user_id, public_key: m.public_key }))
      if (recipients.length === 0) throw new Error('Pick at least one recipient')
      const payload = await buildShare(acc.name, acc.email, acc.secret, recipients)
      const res = await apiFetch(`/teams/${teamId}/codes`, { method: 'POST', body: JSON.stringify(payload) })
      if (!res.ok) throw new Error('Share failed')
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Share failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 w-[360px] space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-200">Share a code</h3>
        {err && <p className="text-xs text-red-400">{err}</p>}

        {!accounts ? (
          <>
            <p className="text-xs text-zinc-500">Enter your recovery key to unlock your vault (it stays in your browser).</p>
            <input value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} placeholder="Recovery key" className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono" />
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-400">Cancel</button>
              <button onClick={unlock} disabled={busy || !recoveryKey} className="px-3 py-1.5 rounded bg-teal-500 text-black text-xs font-semibold disabled:opacity-50">Unlock</button>
            </div>
          </>
        ) : accounts.length === 0 ? (
          <>
            <p className="text-xs text-zinc-400">No shareable accounts found.</p>
            <p className="text-xs text-zinc-500">Only synced accounts that have a secret can be shared. Add a secret (and enable sync) in the extension, or share directly from the extension ("↗ Share with team" on an account).</p>
            <div className="flex justify-end"><button onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-400">Close</button></div>
          </>
        ) : (
          <>
            <label className="block text-xs text-zinc-500">Account</label>
            <select value={selectedIdx} onChange={(e) => setSelectedIdx(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200">
              <option value="">Select…</option>
              {accounts.map((a, i) => <option key={i} value={i}>{a.name}{a.email ? ` — ${a.email}` : ''}</option>)}
            </select>
            <label className="block text-xs text-zinc-500 mt-2">Share with</label>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {members.map((m) => (
                <label key={m.user_id} className="flex items-center gap-2 text-xs text-zinc-300">
                  <input type="checkbox" checked={selectedMembers.includes(m.user_id)} disabled={!m.public_key}
                    onChange={(e) => setSelectedMembers((s) => e.target.checked ? [...s, m.user_id] : s.filter((x) => x !== m.user_id))} />
                  {m.email ?? m.user_id}{!m.public_key && <span className="text-zinc-600"> (not set up yet)</span>}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-400">Cancel</button>
              <button onClick={share} disabled={busy || !selectedIdx} className="px-3 py-1.5 rounded bg-teal-500 text-black text-xs font-semibold disabled:opacity-50">Share</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
