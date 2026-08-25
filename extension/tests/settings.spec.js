import { test, expect, FAKE_AUTH, SESSION_24H, TEST_SECRET } from './fixtures.js';

// ── Google Authenticator migration protobuf helpers (test-side encoder — the
// extension only ever needs to decode, so there's no encoder in the codebase) ──

function varint(n) {
  const out = [];
  n = BigInt(n);
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return out;
}
const tag = (field, wireType) => varint((field << 3) | wireType);
const lenDelim = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const str = s => [...Buffer.from(s, 'utf8')];

function buildOtpParam({ secret, name, issuer, type, digits = 0, algorithm = 0 }) {
  const out = [];
  out.push(...lenDelim(1, secret));
  out.push(...lenDelim(2, str(name)));
  out.push(...lenDelim(3, str(issuer)));
  out.push(...tag(4, 0), ...varint(algorithm));
  out.push(...tag(5, 0), ...varint(digits));
  out.push(...tag(6, 0), ...varint(type));
  return out;
}

function buildMigrationUri({ otpParams, version = 1, batchSize = 1, batchIndex = 0, batchId = 1 }) {
  const payload = [];
  for (const p of otpParams) payload.push(...lenDelim(1, buildOtpParam(p)));
  payload.push(...tag(2, 0), ...varint(version));
  payload.push(...tag(3, 0), ...varint(batchSize));
  payload.push(...tag(4, 0), ...varint(batchIndex));
  payload.push(...tag(5, 0), ...varint(batchId));
  const b64 = Buffer.from(payload).toString('base64');
  return 'otpauth-migration://offline?data=' + encodeURIComponent(b64);
}

async function unlock(page, accounts = [], extra = {}) {
  await page.evaluate(([auth, expiry, accs, extraData]) => new Promise(r =>
    chrome.storage.local.set({ auth, sessionExpiry: expiry, accounts: accs, ...extraData }, r)
  ), [FAKE_AUTH, SESSION_24H(), accounts, extra]);
  await page.reload();
}

// ── Settings navigation (persistent menu + content, no drill-down) ──────────

test('settings: the menu stays visible and each row selects its content pane', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await unlock(page);
  await page.click('#nav-config');

  // Settings opens straight onto Appearance — the menu is a persistent column,
  // not a screen you drill into and back out of.
  await expect(page.locator('#settings-list')).toBeVisible();
  await expect(page.locator('#settings-theme-view')).toBeVisible();
  await expect(page.locator('#row-settings-theme')).toHaveClass(/sel/);

  const rows = [
    ['row-settings-backup', 'settings-backup-view'],
    ['row-settings-google-import', 'settings-google-import-view'],
    ['row-settings-autofill', 'settings-autofill-view'],
    ['row-settings-password', 'settings-password-view'],
  ];

  for (const [rowId, viewId] of rows) {
    await page.click(`#${rowId}`);
    await expect(page.locator(`#${viewId}`)).toBeVisible();
    await expect(page.locator('#settings-list')).toBeVisible(); // menu never hides
    await expect(page.locator(`#${rowId}`)).toHaveClass(/sel/);

    // Every other subview is hidden while this one is selected.
    for (const [, otherViewId] of rows) {
      if (otherViewId !== viewId) await expect(page.locator(`#${otherViewId}`)).toBeHidden();
    }
  }
});

test('regression: a pending import review is dismissed when navigating to another settings row', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await unlock(page);
  await page.click('#nav-config');

  await page.evaluate(() => showImportPicker([{ name: 'Test', email: '', secret: 'JBSWY3DPEHPK3PXP', urls: '', autofill: true }]));
  await expect(page.locator('#import-picker')).toBeVisible();

  // Navigating to an unrelated row must close the stale review, not leave it
  // confirmable from a screen that has nothing to do with the import.
  await page.click('#row-settings-autofill');
  await expect(page.locator('#import-picker')).toBeHidden();
});

// ── Category filter regression (production bug: removing the last category
// tag left a stale filter active, hiding every account) ─────────────────────

test('regression: removing the last category tag does not hide every account', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // All accounts have no category, but a stale filter from before the last
  // tag was removed is still stored — this is exactly the state that used to
  // render "0 of N" with every row hidden.
  await unlock(page, Array.from({ length: 5 }, (_, i) => ({
    name: `Account ${i}`, secret: TEST_SECRET, urls: '', email: '', category: '',
  })), { categoryFilter: 'ghost-category' });

  await page.click('#nav-settings'); // Accounts (vault) view

  await expect(page.locator('#acc-count')).toHaveText('5 accounts');
  const visible = await page.locator('.acc-row').evaluateAll(els =>
    els.filter(el => el.style.display !== 'none').length);
  expect(visible).toBe(5);
});

// ── Change master password ──────────────────────────────────────────────────

test('change master password: rejects wrong current password and mismatched confirmation', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await unlock(page);
  await page.evaluate(() => createAuth('oldpass123'));
  await page.click('#nav-config');
  await page.click('#row-settings-password');

  await page.fill('#change-pw-current', 'WRONGPASS');
  await page.fill('#change-pw-new', 'newpass456');
  await page.fill('#change-pw-confirm', 'newpass456');
  await page.click('#change-pw-submit');
  await expect(page.locator('#change-pw-err')).toHaveText('Current password is incorrect.');

  await page.fill('#change-pw-current', 'oldpass123');
  await page.fill('#change-pw-confirm', 'doesnotmatch');
  await page.click('#change-pw-submit');
  await expect(page.locator('#change-pw-err')).toHaveText('New passwords do not match.');
});

test('change master password: successful change invalidates the old password and accepts the new one', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await unlock(page);
  await page.evaluate(() => createAuth('oldpass123'));
  await page.click('#nav-config');
  await page.click('#row-settings-password');

  await page.fill('#change-pw-current', 'oldpass123');
  await page.fill('#change-pw-new', 'newpass456');
  await page.fill('#change-pw-confirm', 'newpass456');
  await page.click('#change-pw-submit');

  // Back on the settings list, with a confirmation toast.
  await expect(page.locator('#settings-list')).toBeVisible();
  await expect(page.locator('#status-msg')).toHaveText('Master password updated');

  const { oldWorks, newWorks } = await page.evaluate(async () => {
    const { auth } = await loadAuthState();
    return {
      oldWorks: await verifyMasterPassword('oldpass123', auth),
      newWorks: await verifyMasterPassword('newpass456', auth),
    };
  });
  expect(oldWorks).toBe(false);
  expect(newWorks).toBe(true);
});

test('regression: a successful password change renews the session instead of keeping the old near-expiry', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await unlock(page);
  await page.evaluate(() => createAuth('oldpass123'));

  // Session about to expire in 5 seconds — changing the password should
  // renew it, not leave this stale near-expiry in place (setup/login both
  // renew on successful auth; this flow just verified the current password
  // too, so it should behave the same way).
  const almostExpired = Date.now() + 5000;
  await page.evaluate(exp => new Promise(r =>
    chrome.storage.local.set({ sessionExpiry: exp, sessionDuration: 86400000 }, r)), almostExpired);

  await page.click('#nav-config');
  await page.click('#row-settings-password');
  await page.fill('#change-pw-current', 'oldpass123');
  await page.fill('#change-pw-new', 'newpass456');
  await page.fill('#change-pw-confirm', 'newpass456');
  await page.click('#change-pw-submit');
  await expect(page.locator('#status-msg')).toHaveText('Master password updated');

  const { sessionExpiry } = await page.evaluate(() =>
    new Promise(r => chrome.storage.local.get('sessionExpiry', r)));
  expect(sessionExpiry).toBeGreaterThan(almostExpired);
});

// ── Google Authenticator migration import ───────────────────────────────────

test('parseMigrationUri decodes accounts, skipping HOTP and unsupported algorithm/digit settings', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await unlock(page);

  const uri = buildMigrationUri({
    otpParams: [
      { secret: [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0x21], name: 'alice@example.com', issuer: 'GitHub', type: 2, algorithm: 1, digits: 1 },
      { secret: [1, 2, 3, 4], name: 'bob@example.com', issuer: 'OldSite', type: 1 }, // HOTP
      { secret: [5, 6, 7, 8], name: 'carol@example.com', issuer: 'Sha256Site', type: 2, algorithm: 2 }, // unsupported algorithm
    ],
  });

  const payload = await page.evaluate(u => parseMigrationUri(u), uri);
  expect(payload.otpParameters).toHaveLength(3);

  const totpOnly = payload.otpParameters.filter(o => o.type !== 1);
  expect(totpOnly).toHaveLength(2);
  const supported = totpOnly.filter(o => (o.algorithm === 0 || o.algorithm === 1) && (o.digits === 0 || o.digits === 1));
  expect(supported).toHaveLength(1);
  expect(supported[0].issuer).toBe('GitHub');

  const secretB32 = await page.evaluate(bytes => base32Encode(new Uint8Array(bytes)), supported[0].secret);
  expect(secretB32).toBe('JBSWY3DPEEQQ');
});

test('importing a Google Authenticator screenshot flows through the file input to the review picker', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await unlock(page);

  const uri = buildMigrationUri({
    otpParams: [{ secret: [1, 2, 3, 4, 5, 6, 7, 8], name: 'me@example.com', issuer: 'Vercel', type: 2, algorithm: 1, digits: 1 }],
  });

  // Stub image decoding — this test targets the file-input → handleGoogleAuthFiles
  // wiring (regression for a bug where resetting input.value cleared the live
  // FileList before the files were read), not jsQR/BarcodeDetector themselves.
  await page.evaluate(u => { window.decodeQrFromImageFile = async () => u; }, uri);

  await page.click('#nav-config');
  await page.click('#row-settings-google-import');
  await page.setInputFiles('#google-import-file', {
    name: 'qr.png', mimeType: 'image/png', buffer: Buffer.from([0]),
  });

  await expect(page.locator('#import-picker')).toBeVisible();
  await expect(page.locator('#import-picker-list')).toContainText('Vercel');
  await expect(page.locator('#import-picker-list')).toContainText('me@example.com');
});
