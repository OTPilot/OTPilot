import { test, expect, seedUnlocked, seedLocked } from './fixtures.js';

// In-page UI follows the theme chosen in Settings → Appearance (theme.css is
// the single definition; content.js applies the active theme's tokens).

async function suggestionWithTheme(context, extensionId, theme) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedUnlocked(popup, { accounts: [], ...(theme ? { theme } : {}) });
  const page = await context.newPage();
  await page.goto('http://localhost:8765/test/qr-anchor.html');
  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible();
  return { popup, page, overlay };
}

const colors = overlay => overlay.evaluate(el => ({
  bg: getComputedStyle(el).backgroundColor,
  title: getComputedStyle(el.querySelector('span')).color,
  primary: getComputedStyle(el.querySelector('.otpilot-primary')).backgroundColor,
}));

test('overlays use the default theme when none is chosen', async ({ context, extensionId }) => {
  const { overlay } = await suggestionWithTheme(context, extensionId, null);
  await expect.poll(() => colors(overlay)).toEqual({
    bg: 'rgb(30, 41, 59)', title: 'rgb(241, 245, 249)', primary: 'rgb(14, 165, 233)',
  });
});

test('overlays use the chosen theme and follow a change while open', async ({ context, extensionId }) => {
  const { popup, overlay } = await suggestionWithTheme(context, extensionId, 'daylight');
  // Daylight: white surface, dark ink, green accent (theme.css).
  await expect.poll(() => colors(overlay)).toEqual({
    bg: 'rgb(255, 255, 255)', title: 'rgb(23, 28, 23)', primary: 'rgb(47, 111, 79)',
  });

  await popup.evaluate(() => chrome.storage.local.set({ theme: 'vault' }));
  await expect.poll(async () => (await colors(overlay)).bg).toBe('rgb(36, 32, 25)');
});

test('the page\'s own CSS variables never leak into OTPilot overlays', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedUnlocked(popup, { accounts: [] });
  const page = await context.newPage();
  await page.goto('http://localhost:8765/test/theme-hostile.html');
  const overlay = page.locator('#otpilot-suggestion');
  await expect(overlay).toBeVisible();
  // Checked right away (before the theme request could answer) and after.
  expect((await colors(overlay)).bg).toBe('rgb(30, 41, 59)');
  await expect.poll(() => colors(overlay)).toEqual({
    bg: 'rgb(30, 41, 59)', title: 'rgb(241, 245, 249)', primary: 'rgb(14, 165, 233)',
  });
});

test('content.js keeps an exact copy of the default theme tokens', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const css = fs.readFileSync(path.join(dir, '..', 'theme.css'), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const tokens = Object.fromEntries([...root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const js = fs.readFileSync(path.join(dir, '..', 'content.js'), 'utf8');
  const block = js.slice(js.indexOf('const DEFAULT_THEME_VARS = {'), js.indexOf('};', js.indexOf('const DEFAULT_THEME_VARS = {')));
  const copy = Object.fromEntries([...block.matchAll(/'(--[\w-]+)':\s*(?:'([^']*)'|"([^"]*)")/g)].map(m => [m[1], m[2] ?? m[3]]));
  for (const [name, value] of Object.entries(copy)) expect([name, value]).toEqual([name, tokens[name]]);
});

// The toast, the email-code banner and the lock card are themed too.

const surface = loc => loc.evaluate(el => getComputedStyle(el).backgroundColor);

async function seedEmailCode(context, popup) {
  const mail = await context.newPage();
  await mail.goto('http://localhost:8765/test/email-gmail.html?otpilot_test_provider=gmail');
  await mail.waitForLoadState('networkidle');
  await popup.waitForTimeout(800); // the passive scan pushes the code to the background
}

test('the email-code banner and the toast follow the theme', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedUnlocked(popup, { accounts: [], theme: 'daylight', emailAutoFill: false });
  await seedEmailCode(context, popup);

  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/otp-split.html');
  const banner = site.locator('#otpilot-email-banner');
  await expect(banner).toBeVisible({ timeout: 6000 });
  await expect.poll(() => surface(banner)).toBe('rgb(255, 255, 255)');
  await popup.evaluate(() => chrome.storage.local.set({ theme: 'vault' }));
  await expect.poll(() => surface(banner)).toBe('rgb(36, 32, 25)');

  // With auto-fill on, the code is filled and a toast confirms it.
  await popup.evaluate(() => chrome.storage.local.set({ emailAutoFill: true, theme: 'daylight' }));
  const site2 = await context.newPage();
  await site2.goto('http://localhost:8765/test/otp-split.html');
  const toast = site2.locator('[data-otpilot-ui]', { hasText: 'Email code filled' });
  await expect(toast).toHaveCount(1, { timeout: 6000 });
  await expect.poll(() => surface(toast)).toBe('rgb(255, 255, 255)');
});

test('the in-page lock card follows the theme', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedLocked(popup, { accounts: [{ name: 'TestApp', secret: 'JBSWY3DPEHPK3PXP', urls: 'localhost', email: '' }], activeIndex: 0, theme: 'daylight' });
  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/autofill.html');
  const lock = site.locator('#otpilot-lock');
  await expect(lock).toBeVisible();
  await expect.poll(() => surface(lock)).toBe('rgb(255, 255, 255)');
  await popup.evaluate(() => chrome.storage.local.set({ theme: 'vault' }));
  await expect.poll(() => surface(lock)).toBe('rgb(36, 32, 25)');
});

test('the sign-in fill overlay follows the theme', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedUnlocked(popup, { accounts: [], theme: 'daylight' });
  await popup.reload();
  await popup.evaluate(async () => {
    const key = await VaultKeys.getKey();
    await VaultAccounts.save([{ name: 'GitHub', email: 'me@x.com', secret: '', urls: 'localhost', password: 'pw' }], key);
  });
  const site = await context.newPage();
  await site.goto('http://localhost:8765/test/login.html');
  const overlay = site.locator('#otpilot-login-fill');
  await expect(overlay).toBeVisible();
  await expect.poll(() => surface(overlay)).toBe('rgb(255, 255, 255)');
  await expect.poll(() => surface(overlay.locator('.otpilot-login-choice'))).toBe('rgb(250, 249, 245)');
});

test('opening the popup applies the stored theme without writing it back', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedUnlocked(popup, { accounts: [], theme: 'daylight' });
  await popup.reload();
  // The startup path (no user choice) never writes storage: a theme changed
  // elsewhere right after the popup read it would be overwritten otherwise.
  const writes = await popup.evaluate(async () => {
    const seen = [];
    const real = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (items, ...rest) => { if ('theme' in items) seen.push(items.theme); return real(items, ...rest); };
    applyTheme('vault');
    await new Promise(r => setTimeout(r, 100));
    return { seen, stored: (await chrome.storage.local.get('theme')).theme, shown: document.body.dataset.theme };
  });
  expect(writes).toEqual({ seen: [], stored: 'daylight', shown: 'vault' });
});
