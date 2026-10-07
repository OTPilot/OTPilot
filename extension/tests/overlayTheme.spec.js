import { test, expect, seedUnlocked } from './fixtures.js';

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
