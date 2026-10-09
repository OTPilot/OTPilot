# Sharing (2.0): shares and grants

Replaces "move an item into a collection". An item stays in its owner's vault;
sharing gives other people access to a **copy** of it that the owner's
extension keeps current. One item can be shared with several people and in
several collections at once, each time choosing which fields go and whether
the others can edit.

## Concepts

- **Share** — a shared copy of one of the owner's items: either the whole item
  or a subset of its fields (username, password, 2FA, URLs, notes, each custom
  field). It has its own random key, the **share key (SK)**, stable for the
  share's life (the owner's own record is re-encrypted with a fresh item key
  on every save, so grants can't point at it). The copy is stored like any
  vault record: `encryptItem(copy, SK)` — the server sees ciphertext only.
  Two shares of the same item with the same field selection are one share.
- **Grant** — who can open a share: one person (SK wrapped to their ECDH
  public key, like collection keys today) or one collection (SK encrypted
  under the collection key CK, so every collection member can open it), with
  a role: `view` or `edit`. `edit` is only allowed on a whole-item share.
- **Collection** — a named group of shares, shared with members (unchanged:
  CK wrapped per member, roles manage/edit/view). Adding an item to a
  collection = granting the collection one of the item's shares. The item
  doesn't move and can be in several collections.

## Keeping copies current

- Owner edits the item → on save (and on sync) the owner's extension rewrites
  every share of it (re-projecting the chosen fields), with `base_revision`.
- An editor (whole-item share, `edit` grant) edits the shared copy → the
  write goes to the share (revision checked). The owner's extension pulls its
  shares' changes and applies a newer edit to the personal item (newest
  `updatedAt` wins, as in sync), then the other shares of that item are
  rewritten.
- Deleting the item deletes its shares. Removing a grant (or the last grant)
  ends that access; removing the last grant of a share deletes the share.
- Revoking someone from a whole-item share rotates SK: a new share (new SK)
  replaces the old one for the remaining grantees, so later edits don't reach
  the revoked person. What they already saw can't be taken back.

## Server (API)

- `shares`: `id` (client uuid), `team_id`, `owner_id`, `item_id`, `whole`
  (bool: a whole-item share), `encrypted_item` (the copy under SK),
  `revision` (global sequence, like `vault_items`), `updated_at`. Deleted
  outright (no tombstones): grantees notice a share is gone because it's no
  longer in their list. A trigger deletes a share when its last grant goes,
  whatever removed it.
- `share_grants`: `share_id`, either `user_id` or `collection_id`, `role`
  (`view`/`edit`; `edit` requires `whole`), `wrapped_key` (SK for that
  grantee), `granted_by`, `created_at`. A user grant needs a teammate with a
  public key; a collection grant needs the owner to be a collection member
  who can edit it, and the collection to be in the owner's team.
- Endpoints (owner): create / update / delete a share, add / change / remove
  its grants, list my shares (to apply editors' changes). (Grantees): list
  the shares I can open — directly or through a collection — with the key
  material for each; update a share I can edit (`base_revision`, 409 on
  conflict); leave a direct grant. Both lists come back **whole** on every
  call, each share with its revision (no `since` cursor: the with-me list
  spans owners, so a cursor could skip a late commit); clients download the
  copies whose revision changed.
- Locks: share writes take the team lock, then the share row — the same
  order as team departures and collection deletion.
- Team departures / account deletion: grants to the person are removed, and
  their shares (as owner) are deleted, in the same step as today's cleanup.

## Extension

- Item editor → **Share**: people and collections to share with, the field
  checklist (default: everything), Can view / Can edit.
- The Vault lists items shared with me (read-only unless I can edit), with
  "Shared by <owner>" and the collection(s) they came through.
- Autofill and 2FA work from shared copies like from personal items.
- The old 2-of-2 "Share with team" (codes without revealing the secret) is
  kept until the migration step decides its place.

## Plan

1. API: tables, endpoints, access rules, cleanup on departure / deletion; tests.
2. Extension: share keys, owner-side publishing, grantee-side pull, the Share
   dialog for direct shares.
3. Collections as groups: grant shares to collections; Team tab lists a
   collection's items; Vault shows where an item is shared.
4. Field selection (partial copies) end to end.
5. Migration: a collection's manager converts its stored items ("Convert N
   older items"): each becomes an item of theirs (marked `convertedFrom`, so a
   retry never duplicates it), shared back to the collection whole with edit
   access, then deleted from the collection. The old collection-item routes
   go once no collection holds items; the 2-of-2 codes' place is still open.
