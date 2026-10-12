// The web and the extension read each other's data. These fixtures were
// made by both (vault-crypto.json: `fromExtension` by vaultCrypto.js +
// keys.js, `fromWeb` by this module); both clients must open both sides —
// the extension checks the same file in tests/cryptoFixtures.spec.js.
import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/vault-crypto.json'
import { b64e, decryptItem, decryptName, encryptItem, encryptName, publicKeyOf, unwrapWithPrivateKey, wrapToPublicKey } from './vaultCrypto'

const privateKey = () => crypto.subtle.importKey('jwk', fixture.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])

describe.each(['fromExtension', 'fromWeb'] as const)('data made %s', (side) => {
  const made = fixture[side]

  it('opens the item record with the vault key', async () => {
    expect(await decryptItem(made.item, fixture.vaultKey)).toEqual(fixture.item)
  })

  it('opens the collection name and the share key under the collection key', async () => {
    expect(await decryptName(made.collectionName, fixture.collectionKey, fixture.collectionId)).toBe(fixture.collectionNameText)
    expect(await decryptName(made.shareKeyInCollection, fixture.collectionKey, fixture.shareId)).toBe(fixture.shareKey)
  })

  it('unwraps the collection key with the private key', async () => {
    expect(b64e(await unwrapWithPrivateKey(made.collectionKeyForMe, await privateKey()))).toBe(fixture.collectionKey)
  })

  it('refuses a record moved to another id', async () => {
    await expect(decryptItem({ ...made.item, id: 'another-id' }, fixture.vaultKey)).rejects.toThrow()
    await expect(decryptName(made.collectionName, fixture.collectionKey, 'another-id')).rejects.toThrow()
  })
})

describe('round trips', () => {
  it('derives the public key of the private key', async () => {
    expect(await publicKeyOf(fixture.privateJwk)).toBe(fixture.publicKey)
  })

  it('encrypts what it decrypts', async () => {
    expect(await decryptItem(await encryptItem(fixture.item, fixture.vaultKey), fixture.vaultKey)).toEqual(fixture.item)
    expect(await decryptName(await encryptName('x', fixture.collectionKey, 'c'), fixture.collectionKey, 'c')).toBe('x')
    const secret = crypto.getRandomValues(new Uint8Array(32))
    expect(b64e(await unwrapWithPrivateKey(await wrapToPublicKey(secret, fixture.publicKey), await privateKey()))).toBe(b64e(secret))
  })
})
