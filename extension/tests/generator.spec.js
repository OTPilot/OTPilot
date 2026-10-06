import { test, expect, seedUnlocked } from './fixtures.js';

async function genPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/generator.js` });
  return page;
}

test('passwords have the requested length and one character from every enabled set', async ({ context, extensionId }) => {
  const page = await genPage(context, extensionId);
  const results = await page.evaluate(() => Array.from({ length: 300 }, () => Generator.generate({ length: 12 })));
  for (const pw of results) {
    expect(pw).toHaveLength(12);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[!#$%&*+\-=?@^_~]/);
    expect(pw).not.toMatch(/[0Oo1lI|]/); // ambiguous characters are avoided by default
  }
});

test('options narrow the character set; PINs are digits only', async ({ context, extensionId }) => {
  const page = await genPage(context, extensionId);
  const r = await page.evaluate(() => ({
    lettersOnly: Generator.generate({ length: 30, digits: false, symbols: false }),
    pin: Generator.generate({ mode: 'pin', length: 6 }),
    withAmbiguous: Array.from({ length: 50 }, () => Generator.generate({ length: 64, avoidAmbiguous: false })).join(''),
    nothingSelected: Generator.generate({ length: 10, upper: false, lower: false, digits: false, symbols: false }),
  }));
  expect(r.lettersOnly).toMatch(/^[A-Za-z]{30}$/);
  expect(r.pin).toMatch(/^\d{6}$/);
  expect(r.withAmbiguous).toMatch(/[0Oo1lI]/);
  expect(r.nothingSelected).toMatch(/^[a-z]{10}$/); // falls back to lowercase
});

test('length is clamped to each mode\'s limits', async ({ context, extensionId }) => {
  const page = await genPage(context, extensionId);
  const lengths = await page.evaluate(() => [
    Generator.generate({ length: 2 }).length,
    Generator.generate({ length: 500 }).length,
    Generator.generate({ mode: 'pin', length: 1 }).length,
    Generator.generate({ mode: 'pin', length: 50 }).length,
  ]);
  expect(lengths).toEqual([8, 64, 4, 12]);
});

test('characters are uniformly distributed (no modulo bias)', async ({ context, extensionId }) => {
  const page = await genPage(context, extensionId);
  // 40k PIN digits: each digit should land near 10% (±1%).
  const freq = await page.evaluate(() => {
    const counts = Array(10).fill(0);
    for (let i = 0; i < 5000; i++) for (const d of Generator.generate({ mode: 'pin', length: 8 })) counts[d]++;
    return counts.map(c => c / 40000);
  });
  for (const f of freq) expect(Math.abs(f - 0.1)).toBeLessThan(0.01);
});

test('strength reflects length and character set', async ({ context, extensionId }) => {
  const page = await genPage(context, extensionId);
  const s = await page.evaluate(() => [
    Generator.strength({ length: 16 }), // 70-char pool (ambiguous removed): 16 × log2(70) ≈ 98
    Generator.strength({ length: 20 }),
    Generator.strength({ mode: 'pin', length: 4 }),
  ]);
  expect(s[0]).toEqual({ bits: 98, label: 'Strong' });
  expect(s[1].label).toBe('Very strong');
  expect(s[2]).toEqual({ bits: 13, label: 'Weak' });
});

test('the Generate view: length, PIN mode, options and a session history of copied passwords', async ({ context, extensionId }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedUnlocked(page);
  await page.reload();
  await page.click('#nav-generate');
  const out = page.locator('#gen-output');
  await expect(out).toHaveText(/^.{16}$/);

  await page.click('#gen-minus');
  await expect(out).toHaveText(/^.{15}$/);
  await page.locator('[data-gen-opt="symbols"]').uncheck();
  await expect(out).toHaveText(/^[A-Za-z0-9]{15}$/);

  await page.click('[data-gen-mode="pin"]');
  await expect(out).toHaveText(/^\d{6}$/);
  await expect(page.locator('#gen-opts')).toBeHidden();

  const pin = await out.textContent();
  await page.click('#gen-copy');
  await expect(page.locator('#gen-history .gen-history-row span')).toHaveText([pin]);

  // Options persist across popup opens.
  await page.reload();
  await page.click('#nav-generate');
  await expect(out).toHaveText(/^\d{6}$/);
  await expect(page.locator('#gen-history .gen-history-row')).toHaveCount(1);
});
