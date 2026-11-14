import { test, expect, seedUnlocked, waitForVault } from './fixtures.js';

// A generated password offered on new-password fields (forms.js + generator.js).

const SITE = 'http://localhost:8765/test';

async function vaultWith(context, extensionId, local = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], ...local });
  await page.reload();
  await waitForVault(page);
  return page;
}

test('focusing a new-password field suggests one; Use fills it and its confirmation, and the sign-up can be saved', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/signup-confirm.html`);
  await site.fill('input[name="email"]', 'new@example.com');
  await site.focus('input[name="pw"]');

  const offer = site.locator('#otpilot-password-suggest');
  await expect(offer).toBeVisible();
  const first = await offer.locator('.otpilot-gen-value').textContent();
  expect(first).toHaveLength(16);
  await offer.locator('.otpilot-gen-again').click();
  const value = await offer.locator('.otpilot-gen-value').textContent();
  expect(value).not.toBe(first);

  await offer.locator('.otpilot-gen-use').click();
  await expect(offer).toHaveCount(0);
  await expect(site.locator('input[name="pw"]')).toHaveValue(value);
  await expect(site.locator('input[name="pw2"]')).toHaveValue(value);

  await site.click('button');
  const save = site.locator('#otpilot-login-save');
  await expect(save).toContainText('Save this login for localhost?');
  await save.locator('.otpilot-save-confirm').click();
  await expect.poll(() => popup.evaluate(async () =>
    (await VaultStore.readAll(await VaultKeys.getKey())).items.map(i => [Vault.getValue(i, 'username'), Vault.getValue(i, 'password')])))
    .toEqual([['new@example.com', value]]);
});

test('the suggestion follows the generator settings, but is always a password', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, { generatorOptions: { mode: 'pin', length: 24, symbols: false } });
  const site = await context.newPage();
  await site.goto(`${SITE}/signup-confirm.html`);
  await site.focus('input[name="pw"]');
  await expect(site.locator('#otpilot-password-suggest .otpilot-gen-value')).toHaveText(/^[A-Za-z0-9]{24}$/);
});

test('no suggestion on a sign-in password field', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  await site.focus('input[name="password"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
});

test('the suggestion opens under the new-password field, and its badge brings it back after closing', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/signup-confirm.html`);
  await site.focus('input[name="pw"]');
  const offer = site.locator('#otpilot-password-suggest');
  await expect(offer).toBeVisible();
  const field = await site.locator('input[name="pw"]').boundingBox();
  const box = await offer.boundingBox();
  expect(Math.abs(box.y - (field.y + field.height + 6))).toBeLessThan(2);
  await site.screenshot({ path: test.info().outputPath('suggest.png') });

  await offer.locator('.otpilot-overlay-close').click();
  await expect(offer).toHaveCount(0);
  await site.locator('.otpilot-field-badge[data-kind="generate"]').first().click();
  await expect(offer).toBeVisible();
});

test('a reset page that doesn\'t mark its fields still gets the suggestion, for both fields', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/reset-password.html`);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(2);
  await site.focus('input[name="password"]');
  const offer = site.locator('#otpilot-password-suggest');
  await expect(offer).toBeVisible();
  const value = await offer.locator('.otpilot-gen-value').textContent();
  await offer.locator('.otpilot-gen-use').click();
  await expect(site.locator('input[name="password"]')).toHaveValue(value);
  await expect(site.locator('input[name="password2"]')).toHaveValue(value);
});

test('an unmarked change-password form: the current field is never filled, newPassword-style names count', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/change-password-unmarked.html`);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(2);
  await site.focus('input[name="newPassword"]');
  const offer = site.locator('#otpilot-password-suggest');
  const value = await offer.locator('.otpilot-gen-value').textContent();
  await offer.locator('.otpilot-gen-use').click();
  await expect(site.locator('input[name="current"]')).toHaveValue('');
  await expect(site.locator('input[name="newPassword"]')).toHaveValue(value);
  await expect(site.locator('input[name="new_password_confirm"]')).toHaveValue(value);
});

test('two separate sign-in panels without a form are not new-password fields', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/two-signin-panels.html`);
  await site.focus('input[name="password"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('a change-password page with just current and new: Use fills only the new one', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/change-password-two.html`);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(1);
  await site.focus('input[name="p2"]');
  const offer = site.locator('#otpilot-password-suggest');
  const value = await offer.locator('.otpilot-gen-value').textContent();
  await offer.locator('.otpilot-gen-use').click();
  await expect(site.locator('input[name="p1"]')).toHaveValue('');
  await expect(site.locator('input[name="p2"]')).toHaveValue(value);
});

test('a field labelled "Confirm current password" is never filled with the new one', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/change-password-confirm-current.html`);
  await site.focus('input[name="b"]');
  const offer = site.locator('#otpilot-password-suggest');
  const value = await offer.locator('.otpilot-gen-value').textContent();
  await offer.locator('.otpilot-gen-use').click();
  await expect(site.locator('input[name="a"]')).toHaveValue('');
  await expect(site.locator('input[name="b"]')).toHaveValue(value);
});

test('a single password field whose submit reads "Create account" gets the suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-create-button.html`);
  await site.focus('input[name="pw"]');
  await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
});

test('a sign-in form with a "Sign up" control beside "Sign in" gets no suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-signin-link.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('a combined form with an implicit "Sign up" before "Sign in" stays a sign-in', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-combined-implicit.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('a "Join meeting" password form gets no suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-join-meeting.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('a form-less sign-in panel with "Sign up" before "Sign in" gets no suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-panel-both-a.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('a form-less sign-in panel with "Sign in" before "Sign up" gets no suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-panel-both-b.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('a form-less registration panel with "Create account" gets the suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-panel-create.html`);
  await site.focus('input[name="pw"]');
  await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
});

test('a form whose single submit reads "Create account and continue" gets the suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-create-continue.html`);
  await site.focus('input[name="pw"]');
  await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
});

test('one button "Sign in or create account" stays a sign-in: no suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-signin-or-create.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('a far-away header field no longer widens a form-less panel to a distant "Sign up"', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-panel-far-header.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('"Continue with Google" beside "Sign up" and a real sign-in button gets no suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-provider-buttons.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

// Documented behavior, not a wish: with no form, a search field next to the
// password is never taken for its username (`own`), and being a stray input it
// stops buttonNear's widening before it reaches "Create account": no offer.
test('a search field beside a form-less password stops the panel from reaching "Create account": no suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-panel-search-near.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

// A lone password field is searched for its Sign up only within its own panel
// (4 levels): a filled far-away header field plus a footer "Sign up" is no offer.
test('a distant footer "Sign up" past a filled far-away header field gets no suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-panel-far-filled.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(600);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('a form-less registration panel with name and email already filled still gets the suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-panel-filled-create.html`);
  await site.focus('input[name="pw"]');
  await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
});

// Boundary of the form-less reach (buttonNear levels 1..4 from the password's
// parentElement). Fixture ancestors: d1, d2, d3, d4 = 4th, then body.
test('a form-less "Create account" whose common container is the 4th ancestor gets the suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-panel-reach-4.html`);
  await site.focus('input[name="pw"]');
  await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
});

// Same structure with one more wrapper: the common container is the 5th ancestor.
test('a form-less "Create account" whose common container is the 5th ancestor gets no suggestion', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/suggest-panel-reach-5.html`);
  await site.focus('input[name="pw"]');
  await site.waitForTimeout(800);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(0);
});

test('a "Join" modal on the login page (a form whose id / action say it registers) gets the suggestion; the sign-in form beside it does not', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/modal-join.html`);
  await site.focus('input[name="password"]');
  await site.waitForTimeout(600);
  await expect(site.locator('#otpilot-password-suggest')).toHaveCount(0);
  await site.click('#join');
  await site.focus('#id_password1_registration');
  await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(1);
});

test('a Django-style password1 field gets the suggestion even with a bare "Join" and a neutral action', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/django-signup.html`);
  await site.focus('input[name="password1"]');
  await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
});
