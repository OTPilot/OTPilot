import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, seedUnlocked, waitForVault } from './fixtures.js';

// The web dashboard (web/src/lib/vaultCrypto.ts) and the extension read each
// other's data. vault-crypto.json was made by both; the extension must open
// both sides — the web checks the same file in vaultCrypto.test.ts.
const fixture = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../web/src/lib/__fixtures__/vault-crypto.json', import.meta.url)), 'utf8'));

for (const side of ['fromExtension', 'fromWeb']) {
  test(`opens the item, collection name, share key and wrapped collection key made ${side}`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
    await seedUnlocked(page, { accounts: [] });
    await page.reload();
    await waitForVault(page);
    const got = await page.evaluate(async ({ f, made }) => {
      // This user's team keypair: the fixture's.
      await TeamKeys.adoptPrivJwk(f.privateJwk);
      return {
        item: await VaultCrypto.decryptItem(made.item, f.vaultKey),
        name: await VaultCrypto.decryptName(made.collectionName, f.collectionKey, f.collectionId),
        shareKey: await VaultCrypto.decryptName(made.shareKeyInCollection, f.collectionKey, f.shareId),
        collectionKey: VaultCrypto.b64e(await TeamKeys.unwrapUserShare(made.collectionKeyForMe)),
        publicKey: await TeamKeys.getPublicKeyB64(),
      };
    }, { f: fixture, made: fixture[side] });
    expect(got).toEqual({
      item: fixture.item, name: fixture.collectionNameText, shareKey: fixture.shareKey,
      collectionKey: fixture.collectionKey, publicKey: fixture.publicKey,
    });
  });
}
