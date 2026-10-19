import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';

// The Personal trial in the popup: Home's banner (nudge to try sync, trial
// ending, trial ended), the Sync view's trial offer / days left, and signing
// in with a code sent by email.

const DAY = 864e5;
const codes = n => Array.from({ length: n }, (_, i) => ({ name: `Site ${i}`, email: '', secret: TEST_SECRET, urls: '' }));
const SESSION = {
  access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600e3,
  user: { id: '00000000-0000-0000-0000-000000000001', email: 'ana@example.com' },
};

// A popup on Home with `accounts` in the vault and `local` in storage.
async function homeWith(context, extensionId, { accounts = [], local = {} } = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], ...local });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) {
    await writeAccounts(page, accounts);
    await page.reload();
  }
  return page;
}

const offered = { trialOffer: { enabled: true, at: Date.now() } };

test('a browser with a few 2FA codes and no account is nudged to try sync', async ({ context, extensionId }) => {
  const page = await homeWith(context, extensionId, { accounts: codes(3), local: offered });
  const banner = page.locator('#home-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Your 3 codes live only in this browser');
  await expect(banner).toContainText('Sync free for 30 days, no card.');

  // "Not now": gone for two weeks, and counted.
  await banner.getByRole('button', { name: 'Not now' }).click();
  await expect(banner).toBeHidden();
  const seen = await page.evaluate(async () => (await chrome.storage.local.get('trialBanner')).trialBanner);
  expect(seen.nudgeDismissals).toBe(1);
  expect(seen.nudgeUntil).toBeGreaterThan(Date.now() + 13 * 864e5);
  await page.reload();
  await expect(page.locator('#home-banner')).toBeHidden();
});

test('no nudge with fewer codes, without the offer, or once this browser had a trial', async ({ context, extensionId }) => {
  for (const [accounts, local] of [
    [codes(2), offered],
    [codes(4), { trialOffer: { enabled: false, at: Date.now() } }],
    [codes(4), { ...offered, trialUsedHere: true }],
    [codes(4), { ...offered, trialBanner: { nudgeDismissals: 3 } }],
  ]) {
    const page = await homeWith(context, extensionId, { accounts, local });
    await expect(page.locator('#home-account-list, #home-list')).toBeVisible();
    // Give the banner its chance to render.
    await page.evaluate(() => renderHomeBanner());
    await expect(page.locator('#home-banner')).toBeHidden();
    await page.close();
  }
});

test('the last days of the trial show a reminder, hideable until the last day', async ({ context, extensionId }) => {
  const trial = endsIn => ({ userPlan: 'personal', userTrial: { endsAt: new Date(Date.now() + endsIn).toISOString(), active: true, available: false } });

  const page = await homeWith(context, extensionId, { accounts: codes(1), local: trial(2.5 * DAY) });
  const banner = page.locator('#home-banner');
  await expect(banner).toContainText('Your trial ends in 3 days');
  await expect(banner).toContainText('sync pauses. Nothing is deleted.');
  await expect(banner).toHaveClass(/warn/);
  await banner.getByRole('button', { name: 'Later' }).click();
  await expect(banner).toBeHidden();
  await page.close();

  const last = await homeWith(context, extensionId, { accounts: codes(1), local: { ...trial(5 * 3600e3), trialBanner: { endingUntil: Date.now() + DAY } } });
  await expect(last.locator('#home-banner')).toContainText('Your trial ends within a day');
  await expect(last.locator('#home-banner .hb-x')).toHaveCount(0);
  await last.close();

  const early = await homeWith(context, extensionId, { accounts: codes(1), local: trial(10 * DAY) });
  await early.evaluate(() => renderHomeBanner());
  await expect(early.locator('#home-banner')).toBeHidden();
});

test('an ended trial says sync is paused until dismissed', async ({ context, extensionId }) => {
  const page = await homeWith(context, extensionId, {
    accounts: codes(2),
    local: { userPlan: 'free', userTrial: { endsAt: new Date(Date.now() - DAY).toISOString(), active: false, available: false } },
  });
  const banner = page.locator('#home-banner');
  await expect(banner).toContainText('Your trial ended. Sync is paused.');
  await expect(banner).toContainText('Your 2 items are safe on this device.');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();
  await page.reload();
  await page.evaluate(() => renderHomeBanner());
  await expect(page.locator('#home-banner')).toBeHidden();
});

// The Sync view, signed in, with sync-user answering `answer`.
async function syncViewWith(context, extensionId, answer) {
  const page = await homeWith(context, extensionId, { local: { cloudSession: SESSION } });
  await page.evaluate(answer => {
    window.__calls = [];
    CloudSync.syncUser = async () => {
      window.__calls.push('syncUser');
      await chrome.storage.local.set({ userPlan: answer.plan, userTrial: answer.trial });
      return { plan: answer.plan };
    };
  }, answer);
  await page.click('#nav-sync');
  return page;
}

test('a Free account can start the trial from the Sync view', async ({ context, extensionId }) => {
  const page = await syncViewWith(context, extensionId, { plan: 'free', trial: { endsAt: null, active: false, available: true } });
  await expect(page.locator('#sv-free')).toBeVisible();
  await expect(page.locator('#sv-free-trial')).toContainText('Try Personal free for 30 days');
  await expect(page.locator('#link-upgrade')).toHaveText('Or subscribe to Personal');

  await page.evaluate(() => {
    CloudSync.startTrial = async () => { window.__calls.push('startTrial'); throw new Error('This account already had its trial'); };
  });
  await page.click('#btn-start-trial');
  await expect(page.locator('#trial-err')).toHaveText('This account already had its trial');
  expect(await page.evaluate(() => window.__calls)).toContain('startTrial');
});

test('a used trial is not offered again', async ({ context, extensionId }) => {
  const page = await syncViewWith(context, extensionId, {
    plan: 'free', trial: { endsAt: new Date(Date.now() - 3 * DAY).toISOString(), active: false, available: false },
  });
  await expect(page.locator('#sv-free-trial')).toBeHidden();
  await expect(page.locator('#sv-free-trial-ended')).toContainText('Your Personal trial ended on');
  await expect(page.locator('#link-upgrade')).toHaveText('Upgrade to Personal');
});

test('the trial card counts the days left', async ({ context, extensionId }) => {
  const page = await homeWith(context, extensionId);
  await page.evaluate(() => renderTrialCard({ endsAt: new Date(Date.now() + 17.5 * 864e5).toISOString(), active: true }));
  await expect(page.locator('#sync-trial-left')).toHaveText('18 of 30 days left');
  await expect(page.locator('#sync-trial-note')).toContainText('No card on file, so nothing is charged.');
  await page.evaluate(() => renderTrialCard({ endsAt: null, active: false }));
  await expect(page.locator('#sync-trial')).toBeHidden();
});

test('signing in with a code by email survives the popup closing', async ({ context, extensionId }) => {
  const page = await homeWith(context, extensionId);
  const fakeBackground = () => {
    window.__sent = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg?.action === 'sendEmailCode' || msg?.action === 'verifyEmailCode') {
        window.__sent.push(msg);
        const ok = msg.action === 'sendEmailCode' || msg.code.replace(/\D/g, '') === '123456';
        setTimeout(() => cb(ok ? { ok: true, session: { ...window.__session } } : { ok: false, error: 'That code is wrong or expired.' }));
        return;
      }
      return send(msg, cb);
    };
    CloudSync.syncUser = async () => {
      await chrome.storage.local.set({ cloudSession: window.__session, userPlan: 'free', userTrial: { endsAt: null, active: false, available: true } });
      return { plan: 'free' };
    };
  };
  await page.evaluate(([fake, session]) => { window.__session = session; eval(`(${fake})`)(); }, [fakeBackground.toString(), SESSION]);
  await page.click('#nav-sync');
  await expect(page.locator('#sv-signin')).toBeVisible();
  await page.fill('#signin-email', 'ana@example.com');
  await page.click('#btn-email-code');
  await expect(page.locator('#email-code-form')).toBeVisible();
  await expect(page.locator('#signin-code-email')).toHaveText('ana@example.com');

  // The popup closes while the user reads the email: the code step is back.
  await page.reload();
  await page.evaluate(([fake, session]) => { window.__session = session; eval(`(${fake})`)(); }, [fakeBackground.toString(), SESSION]);
  await page.click('#nav-sync');
  await expect(page.locator('#email-code-form')).toBeVisible();

  // "Use another email" goes back to the first step.
  await page.click('#btn-code-other');
  await expect(page.locator('#email-signin-form')).toBeVisible();
  await page.fill('#signin-email', 'ana@example.com');
  await page.click('#btn-email-code');
  await expect(page.locator('#email-code-form')).toBeVisible();

  await page.fill('#signin-code', '000000');
  await page.click('#btn-verify-code');
  await expect(page.locator('#signin-err')).toContainText('wrong or expired');

  await page.fill('#signin-code', '123 456');
  await page.click('#btn-verify-code');
  await expect(page.locator('#sv-free')).toBeVisible();
  expect(await page.evaluate(() => window.__sent.at(-1))).toMatchObject({ action: 'verifyEmailCode', email: 'ana@example.com', code: '123 456' });
  expect(await page.evaluate(async () => (await chrome.storage.session.get('emailSignIn')).emailSignIn)).toBeUndefined();

});
