import { test, expect, FAKE_AUTH, SESSION_24H } from './fixtures.js';

// Helper: open popup and seed unlocked storage with no TOTP accounts
async function seedUnlocked(context, extensionId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(([auth, expiry]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [],
      emailAutoFill: true,
    }, r));
  }, [FAKE_AUTH, SESSION_24H()]);
  return popup;
}

// Helper: open email mock page and get its tab id
async function openEmailPage(context, popup, provider, fixture) {
  const url = `http://localhost:8765/test/${fixture}?otpilot_test_provider=${provider}`;
  const emailPage = await context.newPage();
  await emailPage.goto(url);
  await emailPage.waitForLoadState('networkidle');

  const tabId = await popup.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({ url: u });
    return tabs[0]?.id ?? null;
  }, url);

  return { emailPage, tabId };
}

// Helper: send scanEmailOtp to email tab and return result.
// `expectedLength` (optional) restricts the scan to codes of that digit length.
async function scanEmailTab(popup, tabId, expectedLength) {
  return popup.evaluate(([id, len]) =>
    chrome.tabs.sendMessage(id, { action: 'scanEmailOtp', expectedLength: len ?? undefined })
  , [tabId, expectedLength ?? null]);
}

// ── Per-provider scan tests ──────────────────────────────────────────────────

test('Gmail: detects code from Spanish subject line', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'gmail', 'email-gmail.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('338226');
});

test('Gmail: returns first code when multiple OTP emails present', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'gmail', 'email-gmail.html');

  // email-gmail.html has 338226 in row1 and 112233 in row2 — should return row1
  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('338226');
});

test('Outlook: detects code from inbox row', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'outlook', 'email-outlook.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('847291');
});

test('Yahoo: detects code from inbox row', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'yahoo', 'email-yahoo.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('562938');
});

test('Proton: detects code from inbox row', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'proton', 'email-proton.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('193847');
});

test('Fastmail: detects code from inbox row', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'fastmail', 'email-fastmail.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('774421');
});

test('Zoho: detects code from inbox row', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'zoho', 'email-zoho.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('309182');
});

test('returns null when inbox has no digit codes', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'gmail', 'email-empty.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBeNull();
});

// ── Opened-email body scan tests ─────────────────────────────────────────────
// The code lives in the body of an opened email (not the subject/snippet), with
// distractor numbers (a year, an order/ticket reference) the scanner must skip.

test('Gmail: detects code in opened email body', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'gmail', 'email-gmail-body.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('672880');
});

test('Outlook: detects code in opened email body', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'outlook', 'email-outlook-body.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('847291');
});

test('Yahoo: detects code in opened email body', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'yahoo', 'email-yahoo-body.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('562938');
});

test('Proton: detects code in opened email body', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'proton', 'email-proton-body.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('193847');
});

test('Fastmail: detects code in opened email body', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'fastmail', 'email-fastmail-body.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('774421');
});

test('Zoho: detects code in opened email body', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  const { tabId } = await openEmailPage(context, popup, 'zoho', 'email-zoho-body.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('309182');
});

test('keyword proximity: picks the OTP over distractor numbers in the body', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  // email-gmail-body.html has the year 2026 and order ref 90014772 alongside the
  // real code 672880, which sits next to "Code will expire" — proximity must win.
  const { tabId } = await openEmailPage(context, popup, 'gmail', 'email-gmail-body.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('672880');
  expect(result?.code).not.toBe('90014772');
});

// ── Confidence gate / length / recency ───────────────────────────────────────

test('returns null when numbers are present but no OTP keyword is near them', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  // Distractor numbers (order #, price, counts, year) with no OTP keyword nearby.
  const { tabId } = await openEmailPage(context, popup, 'gmail', 'email-no-keyword.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBeNull();
});

test('expectedLength selects the matching-length code', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  // email-lengths.html has "code: 1234" (4-digit) and "code is 654321" (6-digit).
  const { tabId } = await openEmailPage(context, popup, 'gmail', 'email-lengths.html');

  expect((await scanEmailTab(popup, tabId, 6))?.code).toBe('654321');
  expect((await scanEmailTab(popup, tabId, 4))?.code).toBe('1234');
});

test('skips a stale OTP row and uses the recent one', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);
  // Row 1 (code 111111) has a 2020 timestamp → skipped; row 2 (222222) wins.
  const { tabId } = await openEmailPage(context, popup, 'gmail', 'email-recency.html');

  const result = await scanEmailTab(popup, tabId);
  expect(result?.code).toBe('222222');
});

// ── Split input fill test ────────────────────────────────────────────────────

test('fills split OTP inputs (one digit per box) correctly', async ({ context, extensionId }) => {
  const popup = await seedUnlocked(context, extensionId);

  // Open Gmail mock so email-reader.js detects a code passively and background caches it
  await openEmailPage(context, popup, 'gmail', 'email-gmail.html');

  // Give passive scan time to push emailOtpDetected to background SW
  await popup.waitForTimeout(800);

  // Open split-input page — tryAutoFill should fire and distribute digits
  const splitPage = await context.newPage();
  await splitPage.goto('http://localhost:8765/test/otp-split.html');
  await splitPage.waitForLoadState('networkidle');

  // Wait for auto-fill to complete (tryAutoFill has a 400ms initial delay)
  await expect(splitPage.locator('#result')).toHaveText(/^Filled: \d{6}$/, { timeout: 6000 });

  // Each individual input should hold exactly one digit from the code
  const inputs = splitPage.locator('input[autocomplete="one-time-code"]');
  await expect(inputs).toHaveCount(6);
  for (let i = 0; i < 6; i++) {
    await expect(inputs.nth(i)).toHaveValue(/^\d$/, { timeout: 3000 });
  }
});
