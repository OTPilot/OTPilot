import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError, addCollectionMember, changeGrant, collectionItemTitles, collectionMembers, createCollection,
  deleteCollection, leaveShare, listCollections, myItems, mySharesList, removeCollectionMember, removeGrant,
  renameCollection, setCollectionRole, shareItem, sharedWithMe, unlock, unlockWithKeys,
  type Collection, type Grant, type Grantee, type MyShare, type Role, type StoredItem, type Teammate, type Unlocked,
} from '../../lib/teamVault'
import { findExtension, keysFromExtension, type FoundExtension } from '../../lib/extensionBridge'

// Collections and shared items (2.0), next to the Team page's members and
// 2FA codes. Who has what and with which role is plain server data; names,
// item titles and sharing need the vault, unlocked here with the recovery
// key or by the OTPilot extension (kept in this page's memory only).

type Run = (fn: () => Promise<unknown>) => Promise<string | null>

// Query-cache prefix of everything decrypted (see TeamSharing).
const DECRYPTED = 'decrypted'

const ROLE_LABEL: Record<string, string> = { view: 'Can view', edit: 'Can edit', manage: 'Can manage' }

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'You don\'t have permission to do that.'
    if (e.body?.error) return e.body.error
  }
  return e instanceof Error ? e.message : 'Something went wrong. Try again.'
}

export default function TeamSharing({ teamId, meId, teammates }: { teamId: string; meId: string; teammates: Teammate[] }) {
  const qc = useQueryClient()
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const locked = !unlocked

  // Everything decrypted (items with their secrets, collection and share
  // keys, names) is cached under DECRYPTED, and dropped on Lock and when
  // leaving the page; what's cached while locked holds no secrets.
  const scope = (...k: unknown[]) => (unlocked ? [DECRYPTED, ...k] : k)
  const collections = useQuery({ queryKey: scope('collections'), queryFn: () => listCollections(unlocked) })
  const mine = useQuery({ queryKey: ['shares-mine'], queryFn: mySharesList })
  const items = useQuery({ queryKey: scope('vault-items'), queryFn: () => myItems(unlocked!), enabled: !!unlocked })
  const withMe = useQuery({
    queryKey: scope('shares-with-me', collections.data?.map((c) => c.id).join()),
    queryFn: () => sharedWithMe(unlocked, collections.data ?? []),
    enabled: !!collections.data,
  })

  const forget = useCallback(() => {
    qc.cancelQueries({ queryKey: [DECRYPTED] })
    qc.removeQueries({ queryKey: [DECRYPTED] })
  }, [qc])
  useEffect(() => forget, [forget])
  const lock = () => { forget(); setUnlocked(null) }

  const refresh = () => {
    for (const k of [DECRYPTED, 'collections', 'shares-mine', 'shares-with-me', 'collection-members', 'collection-items']) {
      qc.invalidateQueries({ queryKey: [k] })
    }
  }
  // Runs an action; returns what went wrong (null when it worked), shown
  // above the sections too. Refreshes either way.
  const run = async (fn: () => Promise<unknown>): Promise<string | null> => {
    setErr(null)
    let failed: string | null = null
    try { await fn() } catch (e) { failed = errorText(e) }
    setErr(failed)
    refresh()
    return failed
  }

  const itemsById = useMemo(() => new Map((items.data ?? []).map((s) => [s.item.id, s])), [items.data])
  const others = teammates.filter((t) => t.user_id !== meId)

  return (
    <div className="space-y-6">
      <UnlockBar meId={meId} unlocked={unlocked} onUnlock={setUnlocked} onLock={lock} />
      {err && <p className="text-sm text-red-400">{err}</p>}

      <CollectionsSection
        teamId={teamId} meId={meId} teammates={others} unlocked={unlocked}
        collections={collections.data ?? []} loading={collections.isLoading} error={collections.error} retry={() => collections.refetch()}
        shares={mine.data ?? []} itemsById={itemsById} withMe={withMe.data ?? []} run={run}
      />

      <Section
        title="Items I share"
        action={unlocked && items.data && (
          <ShareButton unlocked={unlocked} items={items.data} teammates={others} shares={mine.data ?? []}
            collections={(collections.data ?? []).filter((c) => c.key && c.role !== 'view')} run={run} />
        )}
      >
        <Loading q={mine} />
        {mine.isSuccess && mine.data.length === 0 && <Empty>Nothing shared yet. Share items here or from the extension (Share… in an item).</Empty>}
        {unlocked && <Loading q={items} what="your vault" />}
        {(mine.data ?? []).map((s) => (
          <MyShareRow key={s.id} share={s} stored={itemsById.get(s.item_id)} locked={locked}
            teammates={others} collections={collections.data ?? []} run={run} />
        ))}
      </Section>

      <Section title="Items shared with me">
        <Loading q={withMe} />
        {withMe.isSuccess && withMe.data.length === 0 && <Empty>No items shared with you.</Empty>}
        {(withMe.data ?? []).map((s) => (
          <Row key={s.id}>
            <span className="text-sm text-zinc-200 min-w-0 truncate">
              {s.title ?? <Muted>{locked ? 'Unlock to see its name' : 'An item'}</Muted>}
              <span className="text-zinc-500"> · from {s.owner ?? 'a teammate'}</span>
            </span>
            <span className="text-xs text-zinc-500 shrink-0">
              {ROLE_LABEL[s.role]}{s.collections.length > 0 && ` · via ${s.collections.map((id) => collectionName(collections.data, id, locked)).join(', ')}`}
            </span>
            {s.direct
              ? <button onClick={() => run(() => leaveShare(s.id, meId))} className="text-xs text-red-400 hover:text-red-300 shrink-0">Leave</button>
              : <span className="w-10" />}
          </Row>
        ))}
        <p className="text-xs text-zinc-600 px-1 pt-1">They open and fill from the extension.</p>
      </Section>
    </div>
  )
}

function collectionName(list: Collection[] | undefined, id: string, locked: boolean): string {
  const c = list?.find((x) => x.id === id)
  return c?.name ? `"${c.name}"` : locked ? 'a collection' : 'a collection you can\'t open'
}

function UnlockBar({ meId, unlocked, onUnlock, onLock }: { meId: string; unlocked: Unlocked | null; onUnlock: (u: Unlocked) => void; onLock: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'extension' | 'key' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // The extension, when installed here: it can unlock this tab (lib/extensionBridge.ts).
  const [ext, setExt] = useState<FoundExtension | null>(null)
  const [useKey, setUseKey] = useState(false)
  useEffect(() => {
    if (unlocked) return
    let live = true
    findExtension(meId).then((found) => { if (live) setExt(found) })
    return () => { live = false }
  }, [meId, unlocked])
  if (unlocked) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-teal-900/60 bg-teal-950/30 px-4 py-2.5">
        <span className="text-xs text-teal-300">Vault unlocked in this tab. Names are shown and you can share.</span>
        <button onClick={onLock} className="text-xs text-zinc-400 hover:text-zinc-200">Lock</button>
      </div>
    )
  }
  async function attempt(how: 'extension' | 'key', fn: () => Promise<Unlocked>) {
    setErr(null); setBusy(how)
    try { onUnlock(await fn()); setKey('') } catch (e) { setErr(errorText(e)) } finally { setBusy(null) }
  }
  const go = () => attempt('key', () => unlock(key))
  const fromExtension = () => attempt('extension', async () => {
    const keys = await keysFromExtension(ext!.id, meId)
    return unlockWithKeys(keys.vaultKey, keys.teamKey)
  })
  const canUseExtension = ext?.account === 'same'
  const keyInput = (
    <div className="flex flex-wrap gap-2">
      <input id="team-recovery-key" type="password" value={key} onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && key) go() }} placeholder="Recovery key" autoComplete="off"
        className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono" />
      <button onClick={go} disabled={!!busy || !key}
        className={`px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-50 ${canUseExtension ? 'border border-zinc-700 text-zinc-200' : 'bg-teal-500 text-black'}`}>
        {busy === 'key' ? 'Unlocking…' : 'Unlock'}
      </button>
    </div>
  )
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-2">
      <p className="text-sm text-zinc-300">Collection names and shared items are end-to-end encrypted.</p>
      {canUseExtension ? (
        <>
          <p className="text-xs text-zinc-500">Unlock them with the OTPilot extension: allow it in the window the extension opens. The key stays in this tab and is never sent.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button id="team-unlock-extension" onClick={fromExtension} disabled={!!busy}
              className="px-3 py-1.5 rounded bg-teal-500 text-black text-xs font-semibold disabled:opacity-50">
              {busy === 'extension' ? 'Waiting for the extension…' : 'Unlock with the extension'}
            </button>
            {!useKey && (
              <button onClick={() => setUseKey(true)} className="text-xs text-zinc-400 hover:text-zinc-200">Use your recovery key instead</button>
            )}
          </div>
          {useKey && keyInput}
        </>
      ) : (
        <>
          <p className="text-xs text-zinc-500">
            Enter your recovery key to see them and to share from here. It stays in this tab and is never sent.
            {ext?.account === 'other' && ' (The OTPilot extension here is signed in to a different account, so it can\'t unlock this one.)'}
            {ext?.account === 'signed-out' && ' Or sign in to the OTPilot extension to unlock from it.'}
          </p>
          {keyInput}
        </>
      )}
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  )
}

// ── Collections ─────────────────────────────────────────────────────────

function CollectionsSection(props: {
  teamId: string; meId: string; teammates: Teammate[]; unlocked: Unlocked | null
  collections: Collection[]; loading: boolean; shares: MyShare[]; itemsById: Map<string, StoredItem>
  withMe: Awaited<ReturnType<typeof sharedWithMe>>; run: Run; error: unknown; retry: () => void
}) {
  const { teamId, unlocked, collections, loading, error, retry, run } = props
  const [name, setName] = useState('')
  return (
    <Section title="Collections" action={unlocked && (
      <div className="flex gap-2">
        <input id="collection-new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="New collection"
          className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-36" />
        <button disabled={!name.trim()} onClick={() => run(async () => { await createCollection(unlocked, teamId, name.trim()); setName('') })}
          className="px-3 py-1 rounded bg-teal-500 text-black text-xs font-semibold hover:bg-teal-400 disabled:opacity-50">Create</button>
      </div>
    )}>
      {loading && <Empty>Loading…</Empty>}
      {!!error && <Failed retry={retry}>Your collections could not be loaded.</Failed>}
      {!loading && !error && collections.length === 0 && <Empty>No collections yet. A collection shares items with chosen teammates.</Empty>}
      {collections.map((c) => <CollectionRow key={c.id} c={c} {...props} />)}
    </Section>
  )
}

function CollectionRow({ c, meId, teammates, unlocked, shares, itemsById, withMe, run }: {
  c: Collection; meId: string; teammates: Teammate[]; unlocked: Unlocked | null; shares: MyShare[]
  itemsById: Map<string, StoredItem>; withMe: Awaited<ReturnType<typeof sharedWithMe>>
  run: Run
}) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [who, setWho] = useState('')
  const [role, setRole] = useState<Role>('edit')
  const manage = c.role === 'manage'
  const members = useQuery({ queryKey: ['collection-members', c.id], queryFn: () => collectionMembers(c.id), enabled: open })
  const legacy = useQuery({ queryKey: [DECRYPTED, 'collection-items', c.id], queryFn: () => collectionItemTitles(c), enabled: open && !!c.key })
  const label = c.name ?? (unlocked ? 'A collection you can\'t open here' : 'Locked collection')
  const memberIds = new Set((members.data ?? []).map((m) => m.user_id))
  const addable = teammates.filter((t) => !memberIds.has(t.user_id))

  const inside = [
    ...shares.filter((s) => s.grants.some((g) => g.collection_id === c.id))
      .map((s) => ({ key: s.id, title: itemsById.get(s.item_id)?.item.title ?? null, by: 'you' })),
    ...withMe.filter((s) => s.collections.includes(c.id)).map((s) => ({ key: s.id, title: s.title, by: s.owner ?? 'a teammate' })),
    ...(legacy.data ?? []).map((t, i) => ({ key: `legacy-${i}`, title: t, by: 'the collection' })),
  ]

  return (
    <div className="border-b border-zinc-800/60 last:border-0">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between gap-3 py-2 text-left">
        <span className={`text-sm truncate ${c.name ? 'text-zinc-200' : 'text-zinc-500 italic'}`}>{open ? '▾' : '▸'} {label}</span>
        <span className="text-xs text-zinc-500 shrink-0">{ROLE_LABEL[c.role]} · {c.members} {c.members === 1 ? 'member' : 'members'}</span>
      </button>
      {open && (
        <div className="pl-4 pb-3 space-y-3">
          <div>
            <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Members</h3>
            {(members.data ?? []).map((m) => (
              <Row key={m.user_id}>
                <span className="text-sm text-zinc-300 truncate">{m.email ?? m.user_id}{m.user_id === meId && ' (you)'}</span>
                {manage && m.user_id !== meId ? (
                  <select value={m.role} onChange={(e) => run(() => setCollectionRole(c.id, m.user_id, e.target.value as Role))}
                    className="bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-300">
                    {(['view', 'edit', 'manage'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                ) : <span className="text-xs text-zinc-500">{ROLE_LABEL[m.role]}</span>}
                {(manage || m.user_id === meId) ? (
                  <button onClick={() => run(() => removeCollectionMember(c.id, m.user_id))} className="text-xs text-red-400 hover:text-red-300">
                    {m.user_id === meId ? 'Leave' : 'Remove'}
                  </button>
                ) : <span className="w-10" />}
              </Row>
            ))}
            {manage && addable.length > 0 && (
              unlocked && c.key ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  <select value={who} onChange={(e) => setWho(e.target.value)} className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300">
                    <option value="">Add a teammate…</option>
                    {addable.map((t) => <option key={t.user_id} value={t.user_id} disabled={!t.public_key}>{t.email ?? t.user_id}{!t.public_key && ' (not set up yet)'}</option>)}
                  </select>
                  <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300">
                    {(['view', 'edit', 'manage'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  <button disabled={!who} onClick={() => run(async () => { await addCollectionMember(c, addable.find((t) => t.user_id === who)!, role); setWho('') })}
                    className="px-3 py-1 rounded bg-teal-500 text-black text-xs font-semibold disabled:opacity-50">Add</button>
                </div>
              ) : <p className="text-xs text-zinc-600 pt-1">Unlock to add teammates.</p>
            )}
          </div>

          <div>
            <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Items</h3>
            {inside.length === 0 && <Empty>Nothing in it yet. Share items into it below, or from the extension.</Empty>}
            {inside.map((x) => (
              <Row key={x.key}>
                <span className="text-sm text-zinc-300 truncate">{x.title ?? <Muted>{unlocked ? 'An item' : 'Unlock to see its name'}</Muted>}</span>
                <span className="text-xs text-zinc-500">{x.by}</span>
              </Row>
            ))}
          </div>

          {manage && (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {renaming ? (
                <>
                  <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                    className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200" />
                  <button onClick={() => run(async () => { if (newName.trim()) await renameCollection(c, newName.trim()); setRenaming(false) })}
                    className="text-xs text-teal-400 hover:text-teal-300">Save</button>
                  <button onClick={() => setRenaming(false)} className="text-xs text-zinc-500">Cancel</button>
                </>
              ) : c.key && (
                <button onClick={() => { setNewName(c.name ?? ''); setRenaming(true) }} className="text-xs text-zinc-400 hover:text-zinc-200">Rename</button>
              )}
              <ConfirmButton label="Delete collection" confirm="Delete it for everyone? Items shared into it stay in their owners' vaults."
                onConfirm={() => run(() => deleteCollection(c))} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Items I share ───────────────────────────────────────────────────────

function MyShareRow({ share, stored, locked, teammates, collections, run }: {
  share: MyShare; stored: StoredItem | undefined; locked: boolean; teammates: Teammate[]
  collections: Collection[]; run: Run
}) {
  const nameOf = (g: Grant) => g.user_id
    ? (teammates.find((t) => t.user_id === g.user_id)?.email ?? 'a teammate')
    : collectionName(collections, g.collection_id!, locked)
  return (
    <div className="py-2 border-b border-zinc-800/60 last:border-0">
      <div className="text-sm text-zinc-200">
        {stored?.item.title ?? <Muted>{locked ? 'Unlock to see its name' : 'An item'}</Muted>}
        <span className="text-xs text-zinc-500"> · {share.whole ? 'the whole item' : 'some fields'}</span>
      </div>
      {share.grants.map((g) => {
        return (
          <div key={g.user_id ?? g.collection_id} className="flex items-center justify-between gap-3 pl-3 py-1">
            <span className="text-xs text-zinc-400 truncate">{nameOf(g)}</span>
            <select value={g.role} onChange={(e) => run(() => changeGrant(share, g, e.target.value as 'view' | 'edit'))}
              className="bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-300">
              <option value="view">Can view</option>
              <option value="edit" disabled={!share.whole}>Can edit</option>
            </select>
            <button onClick={() => run(() => removeGrant(share.id, g))} className="text-xs text-red-400 hover:text-red-300">Remove</button>
          </div>
        )
      })}
    </div>
  )
}

function ShareButton({ unlocked, items, teammates, collections, shares, run }: {
  unlocked: Unlocked; items: StoredItem[]; teammates: Teammate[]; collections: Collection[]; shares: MyShare[]
  run: Run
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} className="px-3 py-1 rounded bg-white/10 text-white text-xs font-semibold hover:bg-white/15">+ Share an item</button>
      {open && <ShareItemModal unlocked={unlocked} items={items} teammates={teammates} collections={collections} shares={shares} run={run} onClose={() => setOpen(false)} />}
    </>
  )
}

function ShareItemModal({ unlocked, items, teammates, collections, shares, run, onClose }: {
  unlocked: Unlocked; items: StoredItem[]; teammates: Teammate[]; collections: Collection[]; shares: MyShare[]
  run: Run; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [people, setPeople] = useState<string[]>([])
  const [colls, setColls] = useState<string[]>([])
  const [role, setRole] = useState<'view' | 'edit'>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sorted = useMemo(() => [...items].sort((a, b) => (a.item.title || '').localeCompare(b.item.title || '')), [items])
  const shown = sorted.filter((s) => (s.item.title || '').toLowerCase().includes(query.toLowerCase())).slice(0, 50)
  const stored = items.find((s) => s.item.id === picked)
  // Who already has the picked item: shown as shared, not sent again (that
  // would rewrite their role) — their access changes under "Items I share".
  const granted = shares.filter((s) => s.item_id === picked && s.whole).flatMap((s) => s.grants)
  const hasUser = (id: string) => granted.some((g) => g.user_id === id)
  const hasColl = (id: string) => granted.some((g) => g.collection_id === id)
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  async function share() {
    if (!stored) return
    setBusy(true)
    const grantees: Grantee[] = [
      ...teammates.filter((t) => people.includes(t.user_id) && !hasUser(t.user_id)).map((user) => ({ user })),
      ...collections.filter((c) => colls.includes(c.id) && !hasColl(c.id)).map((collection) => ({ collection })),
    ]
    setError(null)
    const failed = await run(() => shareItem(unlocked, stored, grantees, role))
    setBusy(false)
    if (failed) setError(failed)
    else onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 w-full max-w-[420px] space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-200">Share an item</h3>
        <p className="text-xs text-zinc-500">They get a copy of the whole item, end-to-end encrypted, kept up to date by your extension. To share only some fields, use Share… in the extension.</p>
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your vault…"
          className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200" />
        <div className="max-h-40 overflow-y-auto rounded border border-zinc-800">
          {shown.map((s) => (
            <button key={s.item.id} onClick={() => setPicked(s.item.id)}
              className={`w-full text-left px-2 py-1.5 text-xs ${picked === s.item.id ? 'bg-teal-500/15 text-teal-300' : 'text-zinc-300 hover:bg-white/5'}`}>
              {s.item.title || 'Untitled'} <span className="text-zinc-600">· {s.item.type}</span>
            </button>
          ))}
          {shown.length === 0 && <p className="px-2 py-2 text-xs text-zinc-600">No items match.</p>}
        </div>
        <div>
          <p className="text-xs text-zinc-500 mb-1">Share with</p>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {teammates.map((t) => (
              <label key={t.user_id} className="flex items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" disabled={!t.public_key || hasUser(t.user_id)} checked={hasUser(t.user_id) || people.includes(t.user_id)} onChange={() => toggle(people, setPeople, t.user_id)} />
                {t.email ?? t.user_id}{hasUser(t.user_id) ? <span className="text-zinc-600"> (shared)</span> : !t.public_key && <span className="text-zinc-600"> (not set up yet)</span>}
              </label>
            ))}
            {collections.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" disabled={hasColl(c.id)} checked={hasColl(c.id) || colls.includes(c.id)} onChange={() => toggle(colls, setColls, c.id)} />
                Collection "{c.name}"{hasColl(c.id) && <span className="text-zinc-600"> (shared)</span>}
              </label>
            ))}
          </div>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex items-center justify-between gap-2 pt-1">
          <select value={role} onChange={(e) => setRole(e.target.value as 'view' | 'edit')}
            className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300">
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
          </select>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-400">Cancel</button>
            <button onClick={share} disabled={busy || !stored || !(people.some((id) => !hasUser(id)) || colls.some((id) => !hasColl(id)))}
              className="px-3 py-1.5 rounded bg-teal-500 text-black text-xs font-semibold disabled:opacity-50">{busy ? 'Sharing…' : 'Share'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Bits ────────────────────────────────────────────────────────────────

function ConfirmButton({ label, confirm, onConfirm }: { label: string; confirm: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) return <button onClick={() => setAsking(true)} className="text-xs text-red-400 hover:text-red-300">{label}</button>
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-zinc-400">{confirm}</span>
      <button onClick={() => { setAsking(false); onConfirm() }} className="text-xs text-red-400 hover:text-red-300 font-semibold">Delete</button>
      <button onClick={() => setAsking(false)} className="text-xs text-zinc-500">Cancel</button>
    </span>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
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

// A query's loading / failed state (its data renders elsewhere).
function Loading({ q, what = 'this list' }: { q: { isLoading: boolean; isError: boolean; refetch: () => unknown }; what?: string }) {
  if (q.isLoading) return <Empty>Loading…</Empty>
  if (q.isError) return <Failed retry={() => q.refetch()}>{`${what[0].toUpperCase()}${what.slice(1)} could not be loaded.`}</Failed>
  return null
}

function Failed({ children, retry }: { children: React.ReactNode; retry: () => void }) {
  return (
    <p className="text-xs text-red-400 px-1">
      {children} <button onClick={retry} className="underline hover:text-red-300">Try again</button>
    </p>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-zinc-600 px-1">{children}</p>
const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-zinc-500 italic">{children}</span>
