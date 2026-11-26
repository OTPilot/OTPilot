import { test, expect, seedUnlocked, waitForVault, writeAccounts } from './fixtures.js';

// Security questions: a `hidden` custom field with `format: 'question'` (the
// question as its label, the answer as its value). Captured from a form that
// sets a password (forms.js securityQuestions + background cleanQuestions /
// applyQuestions), added in the editor ("+ Security question"), shown on
// Home, kept by the CSV, and never given to an AI agent.

const SITE = 'http://localhost:8765/test';

async function vaultWith(context, extensionId, accounts = []) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], obfuscated: false });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  return page;
}

const logins = page => page.evaluate(async () =>
  (await VaultStore.readAll(await VaultKeys.getKey())).items
    .filter(i => i.type === 'login')
    .map(i => ({
      title: i.title,
      username: Vault.getValue(i, 'username'), password: Vault.getValue(i, 'password'),
      fields: (i.fields || []).filter(f => f.custom)
        .map(f => ({ label: f.label, value: f.value, kind: f.kind, format: f.format, section: f.section, fill: f.fill })),
    })));

const question = (label, value) => ({ label, value, kind: 'hidden', format: 'question', section: 'Security questions', fill: undefined });

async function activate(site, { q1 = "Mother's maiden name", a1 = 'Smith', q2 = 'City of birth', a2 = 'Rosario' } = {}) {
  await site.goto(`${SITE}/signup-questions.html`);
  await site.fill('input[name="email"]', 'me@example.com');
  await site.fill('input[name="password"]', 'n3w-Pass!');
  await site.fill('input[name="confirmPassword"]', 'n3w-Pass!');
  if (q1) await site.selectOption('select[name="securityQuestion1"]', { label: q1 });
  await site.fill('input[name="securityAnswer1"]', a1);
  if (q2) await site.selectOption('select[name="securityQuestion2"]', { label: q2 });
  await site.fill('input[name="securityAnswer2"]', a2);
  await site.click('button');
  await expect(site).toHaveURL(/welcome\.html/);
}

test('a sign-up with picked questions saves them with the new login; the masked answer is no password', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId);
  const site = await context.newPage();
  await activate(site);

  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Save this login for localhost?');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: 2 security questions');
  // The page's DOM never gets an answer.
  for (const secret of ['Smith', 'Rosario', 'n3w-Pass!']) expect(await offer.innerHTML()).not.toContain(secret);
  await offer.locator('.otpilot-save-confirm').click();

  await expect.poll(() => logins(popup)).toEqual([{
    title: 'localhost', username: 'me@example.com', password: 'n3w-Pass!',
    fields: [question("Mother's maiden name", 'Smith'), question('City of birth', 'Rosario')],
  }]);
});

test('a question left on "Select a question" is not saved', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId);
  const site = await context.newPage();
  await activate(site, { q2: null });
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: 1 security question');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup))[0]?.fields).toEqual([question("Mother's maiden name", 'Smith')]);
});

test('the same form again: a changed answer updates the saved question, however it is written', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{
    name: 'Portal', email: 'me@example.com', secret: '', urls: 'localhost', password: 'n3w-Pass!',
    customFields: [
      { label: 'MOTHER’S MAIDEN NAME:', value: 'Smith', kind: 'hidden', format: 'question', section: 'Security questions' },
      { label: 'City of birth', value: 'Rosario', kind: 'hidden', format: 'question', section: 'Security questions' },
      { label: 'Customer no.', value: '77', kind: 'text' },
    ],
  }]);
  const site = await context.newPage();
  await activate(site, { a1: 'Gómez' });
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update Portal?');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Saves: 1 security question');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup))[0]?.fields).toEqual([
    question('MOTHER’S MAIDEN NAME:', 'Gómez'),
    question('City of birth', 'Rosario'),
    { label: 'Customer no.', value: '77', kind: 'text', format: undefined, section: undefined, fill: undefined },
  ]);

  // Nothing changed: no offer.
  await activate(site, { a1: 'Gómez' });
  await site.waitForTimeout(1000);
  await expect(offer).toHaveCount(0);
});

test('fixed questions (the answer field labelled by its question) are saved; other fields are not questions', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/signup-questions-fixed.html`);
  await site.fill('input[name="username"]', 'rex-owner');
  await site.fill('input[name="password"]', 'pw-Fixed-1');
  await site.fill('input[name="securityAnswer1"]', 'Rex');
  await site.fill('input[name="securityAnswer2"]', 'Córdoba');
  await site.fill('input[name="company"]', 'ACME');
  await site.click('button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: 2 security questions');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(() => logins(popup)).toEqual([{
    title: 'localhost', username: 'rex-owner', password: 'pw-Fixed-1',
    fields: [question('What was the name of your first pet?', 'Rex'), question('In what city were you born?', 'Córdoba')],
  }]);
});

test('the editor adds a security question to its own section; Home shows it masked', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, [{ name: 'Bank', email: 'me@example.com', secret: '', urls: 'bank.example', password: 'pw' }]);
  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Bank' }).click();
  await page.click('#acc-detail .cf-add-question');
  const section = page.locator('#acc-detail .cf-section.cf-named');
  await expect(section.locator('.cf-section-name')).toHaveValue('Security questions');
  const row = section.locator('.cf-row.cf-question');
  await expect(row.locator('.cf-label')).toBeFocused();
  await expect(row.locator('.cf-label')).toHaveAttribute('list', 'cf-sq-list');
  await expect(row.locator('.cf-value')).toHaveAttribute('type', 'password');
  // Always hidden: no plain-text switch.
  await expect(row.locator('.cf-hide')).toHaveCount(0);
  await row.locator('.cf-label').fill('Name of your first pet');
  await row.locator('.cf-value').fill('Rex');
  // A second one joins the same section.
  await page.click('#acc-detail .cf-add-question');
  await expect(section).toHaveCount(1);
  await section.locator('.cf-row.cf-question').last().locator('.cf-label').fill('City of birth');
  await section.locator('.cf-row.cf-question').last().locator('.cf-value').fill('Rosario');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await logins(page))[0].fields).toEqual([
    question('Name of your first pet', 'Rex'), question('City of birth', 'Rosario'),
  ]);

  // Reopened: still questions; editing one keeps it a question.
  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Bank' }).click();
  await expect(page.locator('#acc-detail .cf-row.cf-question')).toHaveCount(2);
  await page.locator('#acc-detail .cf-row.cf-question').first().locator('.cf-value').fill('Rex II');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await logins(page))[0].fields[0]).toEqual(question('Name of your first pet', 'Rex II'));

  // Home: its own section, the answer masked until Show.
  await page.click('#nav-home');
  await page.locator('#home-list .lc-row', { hasText: 'Bank' }).click();
  const sec = page.locator('#home-creds .home-sec', { hasText: 'Security questions' });
  const pet = sec.locator('.home-cred', { hasText: 'Name of your first pet' });
  await expect(pet.locator('.home-cred-value')).toHaveText(/^•+$/);
  await pet.locator('.home-cred-btn', { hasText: 'Show' }).click();
  await expect(pet.locator('.home-cred-value')).toHaveText('Rex II');
});

test('AI agents never get a security answer; the CSV keeps it a question', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, [{
    name: 'Bank', email: 'me@example.com', secret: '', urls: 'bank.example', password: 'pw',
    customFields: [
      { label: 'City of birth', value: 'Rosario', kind: 'hidden', format: 'question', section: 'Security questions' },
      { label: 'Customer no.', value: '77', kind: 'text' },
    ],
  }]);
  const r = await page.evaluate(async () => {
    const [item] = (await VaultStore.readAll(await VaultKeys.getKey())).items;
    const all = VaultShares.parts(item).map(p => p.key);
    const label = key => VaultShares.parts(item).find(p => p.key === key)?.label;
    const parsed = Importers.parse(Importers.toCsv([item]));
    const [back] = Importers.toItems(parsed.entries, [{ action: 'new' }], []);
    return {
      offered: Agents.partsFor(item).map(p => label(p.key)),
      copied: Agents.copyOf(item, { kind: 'fields', parts: all }).fields.map(f => f.label),
      signIn: Agents.copyOf(item, { kind: 'login' }).fields.map(f => f.label),
      defaults: Agents.defaultScope(item),
      flagged: VaultShares.parts(item).filter(p => p.securityQuestion).map(p => label(p.key)),
      csv: (back?.fields || []).filter(f => f.custom).map(f => [f.label, f.value, f.kind, f.format]),
    };
  });
  expect(r.offered).toContain('Customer no.');
  expect(r.offered).not.toContain('City of birth');
  expect(r.copied).not.toContain('City of birth');
  expect(r.copied).toContain('Customer no.');
  expect(r.signIn).not.toContain('City of birth');
  expect(r.defaults).toEqual({ kind: 'login' });
  expect(r.flagged).toEqual(['City of birth']);
  expect(r.csv).toEqual([['City of birth', 'Rosario', 'hidden', 'question'], ['Customer no.', '77', 'text', undefined]]);
});

// Review of #208: an answer field named like nothing in particular is the
// answer only (never also an extra, which could fill and reach an agent),
// and a question never takes the next question's answer.
test('an answer field without "answer" in its name is saved as the answer only, never as an extra', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-questions.html`);
  await site.fill('input[name="email"]', 'me@example.com');
  await site.fill('input[name="password"]', 'pw-Login-1');
  await site.selectOption('select[name="securityQuestion"]', { label: 'Name of your first pet' });
  await site.fill('input[name="response"]', 'Rex');
  await site.click('button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: 1 security question');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(() => logins(popup)).toEqual([{
    title: 'localhost', username: 'me@example.com', password: 'pw-Login-1',
    fields: [question('Name of your first pet', 'Rex')],
  }]);
});

test('a question whose answer field is hidden never takes the next question\'s answer', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-questions.html?hidden=1`);
  await site.fill('input[name="email"]', 'me@example.com');
  await site.fill('input[name="password"]', 'pw-Login-1');
  await site.selectOption('select[name="securityQuestionA"]', { label: 'City of birth' });
  await site.selectOption('select[name="securityQuestion"]', { label: 'Name of your first pet' });
  await site.fill('input[name="response"]', 'Rex');
  await site.click('button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: 1 security question');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(() => logins(popup)).toEqual([{
    title: 'localhost', username: 'me@example.com', password: 'pw-Login-1',
    fields: [question('Name of your first pet', 'Rex')],
  }]);
});

// ── Answering a saved question on a page (forms.js challengeTexts /
// openAnswers + background questionLogins / fillAnswer) ──────────────────

const portal = (urls = 'localhost') => ({
  name: 'Portal', email: 'me@example.com', secret: '', urls, password: 'pw-1',
  customFields: [
    { label: "Mother's maiden name", value: 'Smith', kind: 'hidden', format: 'question', section: 'Security questions' },
    { label: 'City of birth', value: 'Rosario', kind: 'hidden', format: 'question', section: 'Security questions' },
    { label: 'What was the name of your first pet?', value: 'Rex', kind: 'hidden', format: 'question', section: 'Security questions' },
  ],
});
const answerBadge = site => site.locator('.otpilot-field-badge[data-kind="answer"]');
const answerDrop = site => site.locator('#otpilot-login-dropdown');

test('a question the site asks is answered from the login with the click, never submitted', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [portal()]);
  const site = await context.newPage();
  await site.goto(`${SITE}/challenge-question.html`);
  await expect(answerBadge(site)).toHaveCount(1);
  // Nothing is in the page before a click.
  expect(await site.locator('body').innerHTML()).not.toContain('Smith');
  await answerBadge(site).click();
  await expect(answerDrop(site)).toContainText('Fill the answer saved in');
  await answerDrop(site).locator('.otpilot-answer-choice', { hasText: 'Portal' }).click();
  // "Mother's maiden name" is in "What is your mother's maiden name?".
  await expect(site.locator('input[name="answer"]')).toHaveValue('Smith');
  await site.waitForTimeout(1500);
  expect(site.url()).toContain('challenge-question.html');
});

test('focusing the empty answer field opens the choice where an answer matches; the text before the field counts', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [portal()]);
  const site = await context.newPage();
  await site.goto(`${SITE}/challenge-question.html?mode=text&q=${encodeURIComponent('Security question: City of birth')}`);
  await site.locator('input[name="securityAnswer"]').focus();
  await answerDrop(site).locator('.otpilot-answer-choice').click();
  await expect(site.locator('input[name="securityAnswer"]')).toHaveValue('Rosario');
});

test('each field gets its own question\'s answer (a masked one too)', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [portal()]);
  const site = await context.newPage();
  await site.goto(`${SITE}/challenge-question.html?mode=two`);
  await expect(answerBadge(site)).toHaveCount(2);
  // "In what city were you born?" is not "City of birth": no guess.
  await site.locator('#a1').focus();
  await site.waitForTimeout(800);
  await expect(answerDrop(site)).toHaveCount(0);
  await site.locator('#a2').focus();
  await answerDrop(site).locator('.otpilot-answer-choice').click();
  await expect(site.locator('#a1')).toHaveValue('');
  await expect(site.locator('#a2')).toHaveValue('Rex');
});

test('no saved answer: focusing opens nothing, the badge says so; another site\'s login is never offered', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [portal('example.com')]);
  const site = await context.newPage();
  await site.goto(`${SITE}/challenge-question.html`);
  await site.locator('input[name="answer"]').focus();
  await site.waitForTimeout(800);
  await expect(answerDrop(site)).toHaveCount(0);
  await answerBadge(site).click();
  await expect(answerDrop(site)).toContainText('No saved answer for this question');
  await expect(answerDrop(site).locator('.otpilot-answer-choice')).toHaveCount(0);
});

test('a question that matches two saved answers equally fills nothing', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{
    ...portal(),
    customFields: [
      { label: 'Name of your first pet', value: 'Rex', kind: 'hidden', format: 'question', section: 'Security questions' },
      { label: 'name of your first pet!', value: 'Toby', kind: 'hidden', format: 'question', section: 'Security questions' },
    ],
  }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/challenge-question.html?q=${encodeURIComponent('Name of your first pet?')}`);
  await answerBadge(site).click();
  await expect(answerDrop(site)).toContainText('No saved answer for this question');
});
