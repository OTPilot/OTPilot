import { test, expect, seedUnlocked, waitForVault, TEST_PASSWORD } from './fixtures.js';

// Crypto wallets: the "Crypto wallet" item type (recovery phrase checked
// against BIP39, addresses with their network and QR code), the rules that
// keep its secrets close (master password to show / copy, never to AI agents,
// sharing and CSV warn) and the in-page phishing guard (seedGuard.js).

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BAD_CHECKSUM = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
const ETH = '0x52908400098527886E0F7030069857D2E4169EE7';
const SOL = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const SITE = 'http://localhost:8765/test/seed-phrase.html';

async function popup(context, extensionId, items = []) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  if (items.length) {
    await page.evaluate(async list => {
      await VaultStore.save(list, await VaultKeys.getKey());
    }, await page.evaluate(([phrase, eth]) => {
      const w = Vault.newItem('wallet', { title: 'Phantom' });
      Vault.getField(w, 'wallet').value = 'Phantom';
      Vault.getField(w, 'seed').value = phrase;
      return [Vault.withAddresses(w, [{ network: 'Ethereum / EVM', address: eth }])];
    }, [PHRASE, ETH]));
    await page.reload();
  }
  return page;
}

test('BIP39: word list, checksum, counts and normalizing', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  const r = await page.evaluate(async ([ok, bad]) => ({
    words: [Bip39.WORDS.length, Bip39.WORDS[0], Bip39.WORDS[2047]],
    ok: await Bip39.check(ok),
    bad: (await Bip39.check(bad)).checksum,
    // The 24-word test vector from BIP39 (entropy 0x7f7f…).
    v24: await Bip39.checksumOk(Bip39.words('legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title')),
    unknown: (await Bip39.check('abandon abandn ability')).unknown,
    numbered: Bip39.normalize('1. Abandon\n2) abandon,  3 abandon 4 abandon 5 abandon 6 abandon 7 abandon 8 abandon 9 abandon 10 abandon 11 abandon 12 ABOUT'),
    other: Bip39.normalize('  my Electrum seed wordz  '),
  }), [PHRASE, BAD_CHECKSUM]);
  expect(r.words).toEqual([2048, 'abandon', 'zoo']);
  expect([r.ok.count, r.ok.countOk, r.ok.checksum, r.ok.unknown]).toEqual([12, true, true, []]);
  expect(r.bad).toBe(false);
  expect(r.v24).toBe(true);
  expect(r.unknown).toEqual([{ index: 1, word: 'abandn' }]);
  expect(r.numbered).toBe(PHRASE);
  expect(r.other).toBe('my Electrum seed wordz'); // not all BIP39 words: kept as typed
});

test('addresses: network detection and the QR code', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  const r = await page.evaluate(([eth, sol]) => ({
    eth: CryptoAddresses.detect(eth),
    sol: CryptoAddresses.detect(sol),
    btc: CryptoAddresses.detect('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'),
    legacy: CryptoAddresses.detect('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'),
    tron: CryptoAddresses.detect('TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'),
    none: CryptoAddresses.detect('hello world'),
    qr: CryptoAddresses.qrSvg(eth).startsWith('<svg'),
    short: CryptoAddresses.short(eth),
  }), [ETH, SOL]);
  expect(r).toEqual({ eth: 'Ethereum / EVM', sol: 'Solana', btc: 'Bitcoin', legacy: 'Bitcoin', tron: 'Tron', none: '', qr: true, short: '0x52908…9EE7' });
});

test('a wallet item: its secrets are known, addresses kept apart from custom fields', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  const r = await page.evaluate(() => {
    let w = Vault.newItem('wallet');
    w.fields.push({ id: 'c-1', label: 'PIN', value: '1234', kind: 'text', custom: true });
    w = Vault.withAddresses(w, [{ network: 'Solana', address: ' abc ' }, { network: 'Bitcoin', address: '' }]);
    const again = Vault.withAddresses(w, Vault.addressesOf(w));
    return {
      ids: w.fields.map(f => f.format === 'address' ? 'addr' : f.id),
      addrs: Vault.addressesOf(w).map(a => [a.network, a.address]),
      sameId: again.fields.find(f => f.format === 'address').id === w.fields.find(f => f.format === 'address').id,
      secrets: w.fields.filter(f => Vault.isWalletSecret(w, f)).map(f => f.id),
      lostFormat: Vault.isWalletSecret(w, { id: 'seed', kind: 'hidden' }),
      loginSeed: Vault.isWalletSecret(Vault.newItem('login'), { id: 'seed', kind: 'hidden' }),
    };
  });
  expect(r.ids).toEqual(['wallet', 'seed', 'passphrase', 'password', 'privateKey', 'derivationPath', 'addr', 'c-1']);
  expect(r.addrs).toEqual([['Solana', 'abc']]);
  expect(r.sameId).toBe(true);
  expect(r.secrets).toEqual(['seed', 'passphrase', 'privateKey']);
  expect(r.lostFormat).toBe(true);
  expect(r.loginSeed).toBe(false);
});

test('creating a wallet: the phrase is checked as typed, an address finds its network, Save stores both', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await page.click('#nav-settings');
  await page.click('#btn-add');
  await page.click('[data-add-type="wallet"]');
  await page.fill('#acc-detail .item-title', 'Phantom');
  await page.fill('#acc-detail .item-field[data-id="wallet"]', 'Phantom');
  const seed = page.locator('#acc-detail .seed-input');
  const check = page.locator('#acc-detail .seed-check');
  await seed.fill(BAD_CHECKSUM);
  await expect(check).toContainText('checksum doesn\'t match');
  await seed.fill('abandon abandon abandn');
  await expect(check).toContainText('Word 3, “abandn”, isn\'t in the BIP39 list');
  // Pasted numbered, mixed case: accepted and stored as plain words.
  await seed.fill(PHRASE.split(' ').map((w, i) => `${i + 1}. ${i === 0 ? 'Abandon' : w}`).join('\n'));
  await expect(check).toHaveText('✓ Valid 12-word recovery phrase');

  await page.click('#acc-detail .addr-add');
  const row = page.locator('#acc-detail .addr-row').first();
  await row.locator('.addr-value').fill(ETH);
  await expect(row.locator('.addr-net')).toHaveValue('Ethereum / EVM');
  await row.locator('.addr-qr-btn').click();
  await expect(row.locator('.addr-qr svg')).toBeVisible();
  await page.click('#acc-detail .addr-add');
  const second = page.locator('#acc-detail .addr-row').nth(1);
  await second.locator('.addr-net').selectOption('Solana'); // picked: detection leaves it
  await second.locator('.addr-value').fill(ETH.toLowerCase());
  await expect(second.locator('.addr-net')).toHaveValue('Solana');
  await second.locator('.addr-del').click();
  await page.click('#btn-save-all');

  await expect.poll(() => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items.map(w => ({
    title: w.title, wallet: Vault.getValue(w, 'wallet'), seed: Vault.getValue(w, 'seed'),
    format: Vault.getField(w, 'seed').format, addrs: Vault.addressesOf(w).map(a => [a.network, a.address]),
  })))).toEqual([{ title: 'Phantom', wallet: 'Phantom', seed: PHRASE, format: 'bip39', addrs: [['Ethereum / EVM', ETH]] }]);
  await expect(page.locator('.acc-row', { hasText: 'Phantom' }).locator('.acc-head-email')).toHaveText('Phantom · Ethereum / EVM 0x52908…9EE7');
});

test('a saved phrase shows and copies only after the master password', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId, ['wallet']);
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Phantom' }).click();
  await expect(page.locator('#acc-detail .seed-masked')).toBeVisible();
  await expect(page.locator('#acc-detail .seed-input')).toBeHidden();
  await expect(page.locator('#acc-detail .seed-check')).toHaveText('✓ Valid 12-word recovery phrase');

  await page.click('#acc-detail .seed-show');
  const prompt = page.locator('#mp-prompt');
  await expect(prompt).toBeVisible();
  await prompt.locator('.mp-cancel').click();
  await expect(prompt).toHaveCount(0);
  await expect(page.locator('#acc-detail .seed-grid')).toBeHidden();

  await page.click('#acc-detail .seed-show');
  await prompt.locator('.mp-password').fill('wrong');
  await prompt.locator('.mp-ok').click();
  await expect(prompt.locator('.mp-err')).toHaveText('Incorrect password.');
  await prompt.locator('.mp-password').fill(TEST_PASSWORD);
  await prompt.locator('.mp-ok').click();
  await expect(prompt).toHaveCount(0);
  await expect(page.locator('#acc-detail .seed-grid li')).toHaveCount(12);
  await expect(page.locator('#acc-detail .seed-grid li').last()).toHaveText('about');

  // Confirmed a moment ago: Copy doesn't ask again.
  await page.click('#acc-detail .seed-copy');
  await expect(prompt).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PHRASE);
  await expect(page.locator('#status-msg')).toContainText('cleared in 30 s');
});

test('AI agents never get a wallet\'s phrase or keys; sharing and the CSV say what they hold', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId, ['wallet']);
  const r = await page.evaluate(async () => {
    const [w] = (await VaultStore.readAll(await VaultKeys.getKey())).items;
    Vault.getField(w, 'privateKey').value = 'k';
    const all = VaultShares.parts(w).map(p => p.key);
    const copy = Agents.copyOf(w, { kind: 'fields', parts: all });
    return {
      offered: Agents.partsFor(w).map(p => p.key.startsWith('f:addr-') ? 'addr' : p.key),
      defaults: Agents.defaultScope(w).parts.some(k => ['f:seed', 'f:privateKey'].includes(k)),
      copied: copy.fields.map(f => f.format === 'address' ? 'addr' : f.id),
      summary: Agents.scopeSummary(w, { kind: 'fields', parts: all }),
      flagged: VaultShares.parts(w).filter(p => p.walletSecret).map(p => p.key),
      hasSecret: Vault.hasWalletSecret(w),
    };
  });
  expect(r.offered).toEqual(['f:wallet', 'addr']);
  expect(r.defaults).toBe(false);
  expect(r.copied).toEqual(['wallet', 'addr']);
  expect(r.summary).toBe('Wallet app · Ethereum / EVM');
  expect(r.flagged).toEqual(['f:seed', 'f:privateKey']);
  expect(r.hasSecret).toBe(true);

  await page.click('#nav-config');
  await page.click('#row-settings-backup');
  await page.click('#btn-export-csv');
  await expect(page.locator('#csv-export-wallets')).toBeVisible();
});

test('the CSV export round-trips a wallet: its phrase stays a phrase, its addresses addresses', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId, ['wallet']);
  const r = await page.evaluate(async () => {
    const items = (await VaultStore.readAll(await VaultKeys.getKey())).items;
    const parsed = Importers.parse(Importers.toCsv(items));
    const [item] = Importers.toItems(parsed.entries, parsed.entries.map(() => ({ action: 'new' })), []);
    return {
      type: item.type,
      seed: [Vault.getValue(item, 'seed'), Vault.getField(item, 'seed').format],
      addrs: Vault.addressesOf(item).map(a => [a.network, a.address]),
      custom: item.fields.filter(f => f.custom).length,
      again: Importers.plan(parsed.entries, items)[0].action,
    };
  });
  expect(r).toEqual({
    type: 'wallet', seed: [PHRASE, 'bip39'], addrs: [['Ethereum / EVM', ETH]], custom: 0, again: 'exists',
  });
});

test('phishing guard: a recovery phrase typed into a page warns, Clear empties the field', async ({ context, extensionId }) => {
  await popup(context, extensionId);
  const site = await context.newPage();
  await site.goto(SITE);
  const banner = site.locator('#otpilot-seed-guard');
  // A single BIP39 word in an unrelated field is nothing.
  await site.fill('input[name="search"]', 'abandon');
  await site.waitForTimeout(600);
  await expect(banner).toHaveCount(0);

  await site.fill('textarea[name="phrase"]', PHRASE);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('recovery phrase');
  await banner.getByRole('button', { name: 'Clear it' }).click();
  await expect(banner).toHaveCount(0);
  await expect(site.locator('textarea[name="phrase"]')).toHaveValue('');
});

test('phishing guard: a grid of one-word boxes warns too; "It\'s my wallet" stops it on that site', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  const site = await context.newPage();
  await site.goto(SITE);
  const banner = site.locator('#otpilot-seed-guard');
  const words = PHRASE.split(' ');
  for (let i = 0; i < 11; i++) await site.fill(`input[name="w${i + 1}"]`, words[i]);
  await site.waitForTimeout(600);
  await expect(banner).toHaveCount(0); // 11 words: not yet a phrase
  await site.fill('input[name="w12"]', words[11]);
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: /It's my wallet/ }).click();
  await expect(banner).toHaveCount(0);
  expect(await page.evaluate(async () => (await chrome.storage.local.get('seedGuardAllow:localhost'))['seedGuardAllow:localhost'])).toBe(true);

  await site.reload();
  await site.fill('textarea[name="phrase"]', PHRASE);
  await site.waitForTimeout(800);
  await expect(banner).toHaveCount(0);
});

test('a masked phrase from another word list names no word until it is shown', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  await page.evaluate(async () => {
    const w = Vault.newItem('wallet', { title: 'Monero' });
    Vault.getField(w, 'seed').value = 'abandon zyzzyva ability';
    await VaultStore.save([w], await VaultKeys.getKey());
  });
  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Monero' }).click();
  const check = page.locator('#acc-detail .seed-check');
  await expect(check).toHaveText("Word 2 isn't in the BIP39 list. Fine if your wallet uses another list.");
  await page.click('#acc-detail .seed-edit');
  await page.fill('.mp-password', TEST_PASSWORD);
  await page.click('.mp-ok');
  await expect(check).toContainText('“zyzzyva”');
});

test('copying something else cancels the pending clear of a copied secret', async ({ context, extensionId }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  await page.evaluate(() => copySecret('secret words', 'Recovery phrase'));
  await page.clock.runFor(31_000);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('');
  await page.evaluate(() => copySecret('secret words', 'Recovery phrase'));
  await page.evaluate(() => copyText('an address'));
  await page.clock.runFor(31_000);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('an address');
});

test('CSV import keeps two addresses on the same network, and one address on two networks', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  const addrs = await page.evaluate(() => {
    const w = Vault.withAddresses(Vault.newItem('wallet', { title: 'Ledger' }), [
      { network: 'Ethereum / EVM', address: '0xaaa' }, { network: 'Ethereum / EVM', address: '0xbbb' }, { network: 'Other', address: '0xaaa' },
    ]);
    const parsed = Importers.parse(Importers.toCsv([w]));
    const [item] = Importers.toItems(parsed.entries, [{ action: 'new' }], []);
    return Vault.addressesOf(item).map(a => [a.network, a.address]);
  });
  expect(addrs).toEqual([['Ethereum / EVM', '0xaaa'], ['Ethereum / EVM', '0xbbb'], ['Other', '0xaaa']]);
});

test('phishing guard: a submission carrying a phrase is stopped at once', async ({ context, extensionId }) => {
  await popup(context, extensionId);
  const site = await context.newPage();
  await site.goto(SITE);
  await site.evaluate(() => {
    window.sent = 0;
    document.getElementById('one').addEventListener('submit', () => { window.sent++; });
  });
  // Set without an input event, then submitted at once: no debounce to wait for.
  await site.evaluate(phrase => { document.querySelector('textarea[name="phrase"]').value = phrase; }, PHRASE);
  await site.click('#one button');
  await expect(site.locator('#otpilot-seed-guard')).toBeVisible();
  expect(await site.evaluate(() => window.sent)).toBe(0);
});

test('phishing guard: the page\'s own script cannot click "It\'s my wallet"', async ({ context, extensionId }) => {
  const page = await popup(context, extensionId);
  const site = await context.newPage();
  await site.goto(SITE);
  await site.fill('textarea[name="phrase"]', PHRASE);
  const banner = site.locator('#otpilot-seed-guard');
  await expect(banner).toBeVisible();
  await site.evaluate(() => [...document.querySelectorAll('#otpilot-seed-guard button')].find(b => b.textContent.startsWith("It's my wallet")).click());
  await site.waitForTimeout(300);
  await expect(banner).toBeVisible();
  expect(await page.evaluate(async () => (await chrome.storage.local.get('seedGuardAllow:localhost'))['seedGuardAllow:localhost'])).toBeUndefined();
});

test('phishing guard: Reset and Cancel still work on a form holding a phrase', async ({ context, extensionId }) => {
  await popup(context, extensionId);
  const site = await context.newPage();
  await site.goto(SITE);
  const phrase = site.locator('textarea[name="phrase"]');
  const set = () => site.evaluate(p => { document.querySelector('textarea[name="phrase"]').value = p; }, PHRASE);
  await set();
  await site.click('#one button[type="reset"]');
  await expect(phrase).toHaveValue('');
  await set();
  await site.click('#cancel');
  await expect(phrase).toHaveValue('');
  await expect(site.locator('#otpilot-seed-guard')).toHaveCount(0);
});

test('a copy that fails leaves the pending clear of a secret in place', async ({ context, extensionId }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  await page.evaluate(async () => {
    await copySecret('secret words', 'Recovery phrase');
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async text => { if (text) throw new Error('blocked'); return real(text); };
    await copyText('an address');
  });
  await page.clock.runFor(31_000);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('');
});
