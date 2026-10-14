// Team collections and item sharing (2.0) for the web dashboard — the same
// operations as the extension's vaultCollections.js / vaultShares.js, against
// the same API, so the extension and the web see one state.
//
// Membership and roles are plain server data. Names, item titles and the
// keys needed to share are end-to-end encrypted: they need the vault, which
// the user unlocks here with their recovery key (the vault key), or the
// extension hands over (lib/extensionBridge.ts). The key stays in this page's
// memory. A pasted one opens the synced v1 blob, which carries the user's team
// private key (cloudSync.js) — the one that unwraps collection keys and share
// keys wrapped to them; the extension sends that key along.

import { apiFetch } from './api'
import {
  b64d, b64e, decryptItem, decryptName, encryptItem, encryptName, generateKey,
  publicKeyOf, unwrapWithPrivateKey, wrapToPublicKey, type ItemRecord,
} from './vaultCrypto'

export type Role = 'view' | 'edit' | 'manage'
export type Unlocked = { vaultKey: string; privateKey: CryptoKey; publicKey: string }

export type Field = { id: string; label?: string; value?: string; kind?: string; custom?: boolean; section?: string }
export type ShareRef = { id: string; sk: string; whole: boolean; parts: string[] | null }
export type VaultItem = {
  id: string; type: string; title?: string; urls?: string[]; fields?: Field[]
  totp?: { secret?: string } | null; notes?: string; tags?: string[]; autofill?: boolean
  passwordHistory?: unknown[]; shares?: ShareRef[]; createdAt?: string; updatedAt?: string
  [k: string]: unknown
}

export class ApiError extends Error {
  status: number
  body: { error?: string } | null
  constructor(status: number, body: { error?: string } | null) {
    super(body?.error || `request failed (${status})`)
    this.status = status
    this.body = body
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}

// ── Unlock ──────────────────────────────────────────────────────────────

/** Checks the recovery key against the synced vault and opens the team private key. */
export async function unlock(recoveryKey: string): Promise<Unlocked> {
  const vaultKey = recoveryKey.trim()
  let raw: Uint8Array
  try { raw = b64d(vaultKey) } catch { throw new Error('That is not a recovery key') }
  if (raw.length !== 32) throw new Error('That is not a recovery key')
  const body = await call<{ encrypted_blob?: string } | null>('/accounts')
  if (!body?.encrypted_blob) {
    throw new Error('No synced vault yet. Turn on sync in the extension first.')
  }
  let payload: { teamKey?: JsonWebKey | null }
  try {
    const { v, iv, data } = JSON.parse(body.encrypted_blob)
    if (v !== 1) throw new Error()
    const key = await crypto.subtle.importKey('raw', raw.slice().buffer, 'AES-GCM', false, ['decrypt'])
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(iv).slice().buffer }, key, b64d(data).slice().buffer)
    payload = JSON.parse(new TextDecoder().decode(plain))
  } catch {
    throw new Error('Wrong recovery key')
  }
  const jwk = payload?.teamKey
  if (!jwk?.d) throw new Error('Your team key hasn\'t synced yet. Open the extension once, then try again.')
  return opened(vaultKey, jwk)
}

/** The keys the extension handed over (lib/extensionBridge.ts), already checked there. */
export async function unlockWithKeys(vaultKey: string, teamKey: JsonWebKey): Promise<Unlocked> {
  let raw: Uint8Array
  try { raw = b64d(vaultKey) } catch { raw = new Uint8Array() }
  if (raw.length !== 32 || !teamKey?.d) throw new Error('The extension sent something unexpected. Try your recovery key.')
  return opened(vaultKey, teamKey)
}

async function opened(vaultKey: string, jwk: JsonWebKey): Promise<Unlocked> {
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
  return { vaultKey, privateKey, publicKey: await publicKeyOf(jwk) }
}

// ── Collections ─────────────────────────────────────────────────────────

type CollectionRow = { id: string; team_id: string; encrypted_name: string; role: Role; wrapped_key: string; members: number }
export type Collection = { id: string; teamId: string; role: Role; members: number; name: string | null; key: string | null }
export type CollectionMember = { user_id: string; email: string | null; role: Role }
export type Teammate = { user_id: string; email: string | null; public_key: string | null }

/** My collections; `name` / `key` only when unlocked (and the key opens). */
export async function listCollections(u: Unlocked | null): Promise<Collection[]> {
  const { collections = [] } = await call<{ collections: CollectionRow[] }>('/collections')
  return Promise.all(collections.map(async (c) => {
    let key: string | null = null
    let name: string | null = null
    if (u) {
      try {
        key = b64e(await unwrapWithPrivateKey(c.wrapped_key, u.privateKey))
        name = await decryptName(c.encrypted_name, key, c.id)
      } catch { key = null; name = null }
    }
    return { id: c.id, teamId: c.team_id, role: c.role, members: c.members, name, key }
  }))
}

export async function createCollection(u: Unlocked, teamId: string, name: string): Promise<void> {
  const id = crypto.randomUUID()
  const raw = generateKey()
  await call(`/teams/${teamId}/collections`, {
    method: 'POST',
    body: JSON.stringify({
      id,
      encrypted_name: await encryptName(name, raw, id),
      wrapped_key: await wrapToPublicKey(raw, u.publicKey),
    }),
  })
}

export async function renameCollection(c: Collection, name: string): Promise<void> {
  if (!c.key) throw new Error('Unlock to rename')
  await call(`/collections/${c.id}`, { method: 'PATCH', body: JSON.stringify({ encrypted_name: await encryptName(name, c.key, c.id) }) })
}

export const deleteCollection = (c: Collection) => call(`/collections/${c.id}`, { method: 'DELETE' })

export async function collectionMembers(cid: string): Promise<CollectionMember[]> {
  return (await call<{ members: CollectionMember[] }>(`/collections/${cid}/members`)).members || []
}

export async function addCollectionMember(c: Collection, user: Teammate, role: Role): Promise<void> {
  if (!c.key) throw new Error('Unlock to add people')
  if (!user.public_key) throw new Error('They have to sign in to the OTPilot extension once first')
  await call(`/collections/${c.id}/members/${user.user_id}`, {
    method: 'PUT',
    body: JSON.stringify({ role, wrapped_key: await wrapToPublicKey(b64d(c.key), user.public_key) }),
  })
}

export const setCollectionRole = (cid: string, userId: string, role: Role) =>
  call(`/collections/${cid}/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) })

export const removeCollectionMember = (cid: string, userId: string) =>
  call(`/collections/${cid}/members/${userId}`, { method: 'DELETE' })

/** Titles of the items stored in the collection itself (the older model). */
export async function collectionItemTitles(c: Collection): Promise<string[]> {
  if (!c.key) return []
  const titles: string[] = []
  for (let since = 0, more = true; more;) {
    const page = await call<{ items: { record: ItemRecord | null; deleted: boolean }[]; revision: number; more: boolean }>(
      `/collections/${c.id}/items?since=${since}`,
    )
    for (const r of page.items) {
      if (r.deleted || !r.record) continue
      try { titles.push((await decryptItem<VaultItem>(r.record, c.key)).title || 'Untitled') } catch { /* not readable */ }
    }
    since = page.revision
    more = page.more
  }
  return titles
}

// ── My vault ────────────────────────────────────────────────────────────

export type StoredItem = { item: VaultItem; revision: number }

/** My personal items (decrypted), with their server revisions. */
export async function myItems(u: Unlocked): Promise<StoredItem[]> {
  const byId = new Map<string, StoredItem | null>()
  for (let since = 0, more = true; more;) {
    const page = await call<{ items: { id: string; record: ItemRecord | null; deleted: boolean; revision: number }[]; revision: number; more: boolean }>(
      `/vault/items?since=${since}`,
    )
    for (const r of page.items) {
      if (r.deleted || !r.record) { byId.set(r.id, null); continue }
      try { byId.set(r.id, { item: await decryptItem<VaultItem>(r.record, u.vaultKey), revision: r.revision }) } catch { byId.delete(r.id) }
    }
    since = page.revision
    more = page.more
  }
  return [...byId.values()].filter((x): x is StoredItem => !!x)
}

// Vault.countsForLimit (vault.js): a login holding only a 2FA code (and a
// username) doesn't count toward the Free limit.
function countsForLimit(item: VaultItem): boolean {
  if (item.type !== 'login' || !item.totp?.secret) return true
  if (String(item.notes ?? '').trim() !== '') return true
  if ((item.passwordHistory || []).length) return true
  return (item.fields || []).some((f) => f.id !== 'username' && String(f.value ?? '').trim() !== '')
}

// ── Sharing ─────────────────────────────────────────────────────────────

export type Grant = { user_id: string | null; collection_id: string | null; role: 'view' | 'edit' }
export type MyShare = { id: string; item_id: string; whole: boolean; revision: number; grants: Grant[] }
export type Grantee = { user: Teammate } | { collection: Collection }

export async function mySharesList(): Promise<MyShare[]> {
  return (await call<{ shares: MyShare[] }>('/shares/mine')).shares || []
}

// vaultShares.js project(): the copy a whole share carries — never the
// item's tags, password history or its own shares.
function wholeCopy(item: VaultItem, shareId: string): VaultItem {
  return {
    id: shareId,
    type: item.type,
    title: item.title || '',
    tags: [],
    favorite: false,
    urls: [...(item.urls || [])],
    autofill: item.autofill !== false,
    fields: (item.fields || []).map((f) => ({ ...f })),
    totp: item.totp ? { ...item.totp } : null,
    notes: item.notes || '',
    passwordHistory: [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

async function grantBody(sk: string, shareId: string, g: Grantee, role: 'view' | 'edit') {
  if ('user' in g) {
    if (!g.user.public_key) throw new Error('They have to sign in to the OTPilot extension once first')
    return { user_id: g.user.user_id, role, wrapped_key: await wrapToPublicKey(b64d(sk), g.user.public_key) }
  }
  if (!g.collection.key) throw new Error('That collection can\'t be opened here')
  return { collection_id: g.collection.id, role, wrapped_key: await encryptName(sk, g.collection.key, shareId) }
}

/**
 * Shares the whole of `stored.item` with `grantees`. Like the extension: a
 * whole share it already has gets the new grants; otherwise a new share is
 * made and its key stored in the item (written back to the vault, so the
 * owner's extension keeps the copy current).
 */
export async function shareItem(u: Unlocked, stored: StoredItem, grantees: Grantee[], role: 'view' | 'edit'): Promise<void> {
  if (!grantees.length) throw new Error('Pick at least one teammate or collection')
  const onServer = new Set((await mySharesList()).map((s) => s.id))
  const existing = (stored.item.shares || []).find((s) => s.whole && onServer.has(s.id))
  if (existing) {
    for (const g of grantees) {
      await call(`/shares/${existing.id}/grants`, { method: 'PUT', body: JSON.stringify(await grantBody(existing.sk, existing.id, g, role)) })
    }
    return
  }
  const s: ShareRef = { id: crypto.randomUUID(), sk: b64e(generateKey()), whole: true, parts: null }
  // The key goes into the item first, so there's never a share on the
  // server its owner has no key for: if creating it fails, the item holds a
  // reference to a share the server doesn't have, which the extension drops
  // on its next sync (and we try to remove now).
  const attached = await attachShare(u, stored, s)
  try {
    await call('/shares', {
      method: 'POST',
      body: JSON.stringify({
        id: s.id, item_id: stored.item.id, whole: true,
        record: await encryptItem(wholeCopy(stored.item, s.id), s.sk),
        grants: await Promise.all(grantees.map((g) => grantBody(s.sk, s.id, g, role))),
      }),
    })
  } catch (e) {
    await attachShare(u, attached, null).catch(() => {})
    throw e
  }
  // An extension sync between the two writes may have dropped the reference
  // (the share wasn't on the server yet): make sure it's there — writing
  // against the revision we know, so a newer server version (409) is what
  // gets checked.
  try {
    await attachShare(u, attached, s, true)
  } catch (e) {
    await call(`/shares/${s.id}`, { method: 'DELETE' }).catch(() => {})
    throw e
  }
}

// Stores share `s` (its key) in the item — or, with null, removes nothing
// but stale references — keeping its updatedAt (only `shares` changes).
// References to shares the server doesn't have are pruned, except `s`
// itself (it may not be created yet). On a newer server version (409) it
// starts again from that version, with the server's list read again each
// time, so a share another tab stored meanwhile is kept. Returns the item as
// stored. Writes nothing when `shares` wouldn't change — unless `verify`:
// then the first attempt writes anyway, since `stored` may be out of date.
async function attachShare(u: Unlocked, stored: StoredItem, s: ShareRef | null, verify = false): Promise<StoredItem> {
  let { item, revision } = stored
  for (let attempt = 0; attempt < 3; attempt++) {
    const onServer = new Set((await mySharesList()).map((x) => x.id))
    const shares = [...(item.shares || []).filter((x) => onServer.has(x.id) && x.id !== s?.id), ...(s ? [s] : [])]
    const same = JSON.stringify(shares.map((x) => x.id).sort()) === JSON.stringify((item.shares || []).map((x) => x.id).sort())
    if (same && !(verify && attempt === 0)) return { item, revision }
    const next: VaultItem = { ...item, shares }
    if (!shares.length) delete next.shares
    const res = await apiFetch(`/vault/items/${item.id}`, {
      method: 'PUT',
      body: JSON.stringify({ record: await encryptItem(next, u.vaultKey), base_revision: revision, counts_for_limit: countsForLimit(next) }),
    })
    const body = await res.json().catch(() => null)
    if (res.ok) return { item: next, revision: body?.revision ?? revision }
    if (res.status !== 409 || !body?.item?.record) throw new ApiError(res.status, body)
    item = await decryptItem<VaultItem>(body.item.record, u.vaultKey)
    revision = body.item.revision
  }
  throw new Error('Your vault kept changing — try again')
}

/**
 * Changes an existing grant's role on one of my shares. Never adds a grant:
 * one removed meanwhile (e.g. on another device) is a 404, not restored.
 */
export async function changeGrant(share: MyShare, g: Grant, role: 'view' | 'edit'): Promise<void> {
  const target = g.user_id ? { user_id: g.user_id } : { collection_id: g.collection_id }
  await call(`/shares/${share.id}/grants`, { method: 'PATCH', body: JSON.stringify({ ...target, role }) })
}

export async function removeGrant(shareId: string, g: { user_id?: string | null; collection_id?: string | null }): Promise<void> {
  const q = g.user_id ? `user_id=${encodeURIComponent(g.user_id)}` : `collection_id=${encodeURIComponent(g.collection_id!)}`
  await call(`/shares/${shareId}/grants?${q}`, { method: 'DELETE' })
}

// ── Shared with me ──────────────────────────────────────────────────────

type Via = { user_id?: string; collection_id?: string; wrapped_key: string }
type WithMeRow = { id: string; owner: { id: string; email: string | null }; whole: boolean; role: 'view' | 'edit'; record: ItemRecord; via: Via[] }
export type SharedWithMe = { id: string; owner: string | null; role: 'view' | 'edit'; direct: boolean; collections: string[]; title: string | null }

export async function sharedWithMe(u: Unlocked | null, collections: Collection[]): Promise<SharedWithMe[]> {
  const { shares = [] } = await call<{ shares: WithMeRow[] }>('/shares/with-me')
  const byId = new Map(collections.map((c) => [c.id, c]))
  return Promise.all(shares.map(async (s) => {
    let title: string | null = null
    if (u) {
      for (const via of s.via) {
        try {
          let sk: string | null = null
          if (via.user_id) sk = b64e(await unwrapWithPrivateKey(via.wrapped_key, u.privateKey))
          else {
            const ck = byId.get(via.collection_id!)?.key
            if (ck) sk = await decryptName(via.wrapped_key, ck, s.id)
          }
          if (!sk) continue
          title = (await decryptItem<VaultItem>(s.record, sk)).title || 'Untitled'
          break
        } catch { /* try the next grant */ }
      }
    }
    return {
      id: s.id,
      owner: s.owner.email,
      role: s.role,
      direct: s.via.some((v) => v.user_id),
      collections: s.via.filter((v) => v.collection_id).map((v) => v.collection_id!),
      title,
    }
  }))
}

/** Leaves a share given to me directly (one through a collection stays). */
export const leaveShare = (shareId: string, myId: string) => removeGrant(shareId, { user_id: myId })
