import { test, expect, FAKE_AUTH, SESSION_24H, TEST_SECRET } from './fixtures.js';

test('autofill test page has OTP input field', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('http://localhost:8765/test/autofill.html');

  const input = page.locator('input[name="otp_token"]');
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(input).toHaveAttribute('maxlength', '6');
});

test('content script fills OTP field when triggered via extension message', async ({ context, extensionId }) => {
  // Use the popup page as the extension context for sending messages
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  // Pre-seed: session unlocked + account matching localhost
  await popupPage.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [{ name: 'TestApp', secret, urls: 'localhost', email: '' }],
      activeIndex: 0,
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  // Navigate to the autofill page and wait for content script to run
  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  // Send the fill message from the extension (popup) context
  const tabId = await popupPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/test/autofill.html' });
    return tabs[0]?.id ?? null;
  });

  expect(tabId).not.toBeNull();

  await popupPage.evaluate(id => {
    return chrome.tabs.sendMessage(id, { action: 'fill', accountIndex: 0 });
  }, tabId);

  // OTP field should now contain a 6-digit code
  const input = autofillPage.locator('input[name="otp_token"]');
  await expect(input).toHaveValue(/^\d{6}$/, { timeout: 5000 });
});

test('filled code is highlighted (filled class added)', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => {
    return new Promise(r => chrome.storage.local.set({
      auth,
      sessionExpiry: expiry,
      accounts: [{ name: 'TestApp', secret, urls: 'localhost', email: '' }],
      activeIndex: 0,
    }, r));
  }, [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  const tabId = await popupPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/test/autofill.html' });
    return tabs[0]?.id ?? null;
  });

  await popupPage.evaluate(id => {
    return chrome.tabs.sendMessage(id, { action: 'fill', accountIndex: 0 });
  }, tabId);

  // autofill.html adds a .filled class when input has 6 chars
  const input = autofillPage.locator('input[name="otp_token"]');
  await expect(input).toHaveClass(/filled/, { timeout: 5000 });
});

// ── Save-URL prompt (accounts imported without a site, e.g. from Google
// Authenticator, only fill via the popup's manual account pick — offer to
// remember the site so auto-fill finds them on its own next time) ──────────

async function sendFillMessage(popupPage, autofillPage, accountIndex = 0) {
  const tabId = await popupPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/test/autofill.html' });
    return tabs[0]?.id ?? null;
  });
  expect(tabId).not.toBeNull();
  await popupPage.evaluate(([id, idx]) => chrome.tabs.sendMessage(id, { action: 'fill', accountIndex: idx }), [tabId, accountIndex]);
}

test('manually filling an account with no matching URL offers to save the site', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => new Promise(r =>
    chrome.storage.local.set({
      auth, sessionExpiry: expiry,
      // No urls at all — exactly the state a Google Authenticator import leaves.
      accounts: [{ name: 'Vercel', secret, urls: '', email: 'me@example.com' }],
      activeIndex: 0,
    }, r)
  ), [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  await sendFillMessage(popupPage, autofillPage);

  // Code still fills even though there's no URL match (manual pick bypasses it).
  await expect(autofillPage.locator('input[name="otp_token"]')).toHaveValue(/^\d{6}$/, { timeout: 5000 });

  const overlay = autofillPage.locator('#otpilot-save-url');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('localhost');
  await expect(overlay).toContainText('Vercel');
});

test('accepting the save-URL prompt persists the site to the account (and sets its icon domain)', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => new Promise(r =>
    chrome.storage.local.set({
      auth, sessionExpiry: expiry,
      accounts: [{ name: 'Vercel', secret, urls: '', email: '' }],
      activeIndex: 0,
    }, r)
  ), [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  await sendFillMessage(popupPage, autofillPage);
  await autofillPage.locator('#otpilot-save-url .otpilot-primary').click();
  await expect(autofillPage.locator('#otpilot-save-url')).toHaveCount(0);

  const stored = await popupPage.evaluate(() =>
    new Promise(r => chrome.storage.local.get('accounts', d => r(d.accounts))));
  expect(stored[0].urls).toBe('localhost');
  expect(stored[0].domain).toBe('localhost');
  expect(Date.now() - new Date(stored[0]._updatedAt).getTime()).toBeLessThan(10000);
});

test('dismissing the save-URL prompt leaves the account unchanged and does not re-prompt for the same site', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => new Promise(r =>
    chrome.storage.local.set({
      auth, sessionExpiry: expiry,
      accounts: [{ name: 'Vercel', secret, urls: '', email: '' }],
      activeIndex: 0,
    }, r)
  ), [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  await sendFillMessage(popupPage, autofillPage);
  await autofillPage.locator('#otpilot-save-url .otpilot-secondary').click();
  await expect(autofillPage.locator('#otpilot-save-url')).toHaveCount(0);

  const stored = await popupPage.evaluate(() =>
    new Promise(r => chrome.storage.local.get('accounts', d => r(d.accounts))));
  expect(stored[0].urls).toBe('');

  // Filling again for the same account+site shouldn't nag a second time.
  await sendFillMessage(popupPage, autofillPage);
  await expect(autofillPage.locator('#otpilot-save-url')).toHaveCount(0);
});

test('regression: a dismissal does not carry over to a different account that reorders into the same index', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => new Promise(r =>
    chrome.storage.local.set({
      auth, sessionExpiry: expiry,
      accounts: [
        { name: 'Personal Vercel', secret, urls: '', email: '' },
        { name: 'Work Vercel',     secret, urls: '', email: '' },
      ],
      activeIndex: 1,
    }, r)
  ), [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  // Dismiss the prompt for "Work Vercel" (index 1).
  await sendFillMessage(popupPage, autofillPage, 1);
  await expect(autofillPage.locator('#otpilot-save-url')).toContainText('Work Vercel');
  await autofillPage.locator('#otpilot-save-url .otpilot-secondary').click();
  await expect(autofillPage.locator('#otpilot-save-url')).toHaveCount(0);

  // The list reorders — "Personal Vercel" (never shown or dismissed) now
  // sits at index 1, the position the dismissal used to key off of.
  await popupPage.evaluate(() => new Promise(r =>
    chrome.storage.local.get('accounts', d => {
      const [a, b] = d.accounts;
      chrome.storage.local.set({ accounts: [b, a] }, r);
    })
  ));

  // Filling "Personal Vercel" (now at index 1) must still show its own
  // prompt — it never inherited Work Vercel's dismissal.
  await sendFillMessage(popupPage, autofillPage, 1);
  await expect(autofillPage.locator('#otpilot-save-url')).toContainText('Personal Vercel');
});

test('a URL-matched account never triggers the save-URL prompt', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => new Promise(r =>
    chrome.storage.local.set({
      auth, sessionExpiry: expiry,
      accounts: [{ name: 'TestApp', secret, urls: 'localhost', email: '' }],
      activeIndex: 0,
    }, r)
  ), [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  await sendFillMessage(popupPage, autofillPage);
  await expect(autofillPage.locator('input[name="otp_token"]')).toHaveValue(/^\d{6}$/, { timeout: 5000 });
  await expect(autofillPage.locator('#otpilot-save-url')).toHaveCount(0);
});

test('regression: saving the URL updates the exact filled account, not the first with the same secret', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  // Two accounts sharing a secret (allowed — nothing enforces uniqueness).
  // Manually filling the *second* one must not touch the first.
  await popupPage.evaluate(([auth, expiry, secret]) => new Promise(r =>
    chrome.storage.local.set({
      auth, sessionExpiry: expiry,
      accounts: [
        { name: 'Personal Vercel', secret, urls: '', email: '' },
        { name: 'Work Vercel',     secret, urls: '', email: '' },
      ],
      activeIndex: 1,
    }, r)
  ), [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  await sendFillMessage(popupPage, autofillPage, 1);
  await expect(autofillPage.locator('#otpilot-save-url')).toContainText('Work Vercel');
  await autofillPage.locator('#otpilot-save-url .otpilot-primary').click();

  const stored = await popupPage.evaluate(() =>
    new Promise(r => chrome.storage.local.get('accounts', d => r(d.accounts))));
  expect(stored[0].urls).toBe(''); // Personal Vercel (index 0) untouched
  expect(stored[1].urls).toBe('localhost'); // Work Vercel (index 1, the one actually filled)
});

test('regression: reordering accounts while the save prompt is open does not mis-save a different account', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => new Promise(r =>
    chrome.storage.local.set({
      auth, sessionExpiry: expiry,
      accounts: [
        { name: 'Personal Vercel', secret, urls: '', email: '' },
        { name: 'Work Vercel',     secret, urls: '', email: '' },
      ],
      activeIndex: 1,
    }, r)
  ), [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  // Filled "Work Vercel" (index 1) — the prompt is now up, holding index 1.
  await sendFillMessage(popupPage, autofillPage, 1);
  await expect(autofillPage.locator('#otpilot-save-url')).toContainText('Work Vercel');

  // While it's open, the popup reorders the list — "Personal Vercel" (a
  // different account, same secret) now sits at index 1 instead.
  await popupPage.evaluate(() => new Promise(r =>
    chrome.storage.local.get('accounts', d => {
      const [a, b] = d.accounts;
      chrome.storage.local.set({ accounts: [b, a] }, r);
    })
  ));

  // Confirming the (stale) prompt must still land on "Work Vercel" by
  // content, not on whichever account now happens to sit at index 1.
  await autofillPage.locator('#otpilot-save-url .otpilot-primary').click();

  const stored = await popupPage.evaluate(() =>
    new Promise(r => chrome.storage.local.get('accounts', d => r(d.accounts))));
  const personal = stored.find(a => a.name === 'Personal Vercel');
  const work = stored.find(a => a.name === 'Work Vercel');
  expect(personal.urls).toBe('');
  expect(work.urls).toBe('localhost');
});

test('regression: if the account is gone by the time Save is clicked, the toast reports failure instead of a false success', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => new Promise(r =>
    chrome.storage.local.set({
      auth, sessionExpiry: expiry,
      accounts: [{ name: 'Vercel', secret, urls: '', email: '' }],
      activeIndex: 0,
    }, r)
  ), [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  await sendFillMessage(popupPage, autofillPage);
  await expect(autofillPage.locator('#otpilot-save-url')).toBeVisible();

  // The account is deleted from the popup while the prompt is still open —
  // no index and no full-record match can resolve a target anymore.
  await popupPage.evaluate(() => new Promise(r => chrome.storage.local.set({ accounts: [] }, r)));

  await autofillPage.locator('#otpilot-save-url .otpilot-primary').click();

  await expect(autofillPage.getByText('Could not save site — account changed')).toBeVisible();
  await expect(autofillPage.getByText('Saved —', { exact: false })).toHaveCount(0);

  const stored = await popupPage.evaluate(() =>
    new Promise(r => chrome.storage.local.get('accounts', d => r(d.accounts))));
  expect(stored).toEqual([]);
});

test('regression: auto-submit is delayed while the save-URL prompt is up, instead of racing it off the page', async ({ context, extensionId }) => {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await popupPage.evaluate(([auth, expiry, secret]) => new Promise(r =>
    chrome.storage.local.set({
      auth, sessionExpiry: expiry,
      accounts: [{ name: 'Vercel', secret, urls: '', email: '' }],
      activeIndex: 0,
    }, r)
  ), [FAKE_AUTH, SESSION_24H(), TEST_SECRET]);

  const autofillPage = await context.newPage();
  await autofillPage.goto('http://localhost:8765/test/autofill.html');
  await autofillPage.waitForLoadState('networkidle');

  await sendFillMessage(popupPage, autofillPage);
  await expect(autofillPage.locator('#otpilot-save-url')).toBeVisible();

  // The plain auto-submit fires at 600ms; the form's own submit handler flips
  // #result visible. While the prompt is still up (nobody has answered it
  // yet), submission must not have raced ahead and taken it off the page.
  await autofillPage.waitForTimeout(1500);
  await expect(autofillPage.locator('#result')).toBeHidden();
  await expect(autofillPage.locator('#otpilot-save-url')).toBeVisible();

  // Resolving the prompt (here: dismissing it) lets the deferred submit
  // proceed shortly after — it's held, not cancelled.
  await autofillPage.locator('#otpilot-save-url .otpilot-secondary').click();
  await expect(autofillPage.locator('#result')).toBeVisible({ timeout: 3000 });
});
