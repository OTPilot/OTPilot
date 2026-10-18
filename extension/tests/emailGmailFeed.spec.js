import { test, expect, seedUnlocked } from './fixtures.js';

// Email codes read from Gmail's Atom feed by the background, with no Gmail tab
// open: the feed (and the print view of a message) are routed here.

async function setup(context, extensionId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedUnlocked(popup);
  await popup.evaluate(() => new Promise(r => chrome.storage.local.set({ accounts: [], emailAutoFill: true }, r)));
  return popup;
}

const entry = ({ title, summary, from = 'noreply@localhost', name = 'Test App', minutesAgo = 1, id = '19a0b1c2d3e4f5a6' }) => `
  <entry>
    <title>${title}</title>
    <summary>${summary}</summary>
    <link rel="alternate" href="https://mail.google.com/mail?account_id=me@gmail.com&amp;message_id=${id}&amp;view=conv&amp;extsrc=atom" type="text/html" />
    <issued>${new Date(Date.now() - minutesAgo * 60000).toISOString()}</issued>
    <author><name>${name}</name><email>${from}</email></author>
  </entry>`;

const feed = entries => `<?xml version="1.0" encoding="UTF-8"?>
<feed version="0.3" xmlns="http://purl.org/atom/ns#">
  <title>Gmail - Inbox for me@gmail.com</title>
  <fullcount>${entries.length}</fullcount>
  ${entries.join('')}
</feed>`;

// /u/0 answers the feed; any other account index is "signed out".
async function routeGmail(context, entries, { body } = {}) {
  const seen = { feed: 0, print: 0 };
  await context.route('https://mail.google.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/mail/u/0/feed/atom') {
      seen.feed++;
      return route.fulfill({ contentType: 'application/atom+xml; charset=UTF-8', body: feed(entries) });
    }
    if (url.pathname === '/mail/u/0/' && url.searchParams.get('view') === 'pt' && body) {
      seen.print++;
      return route.fulfill({ contentType: 'text/html', body });
    }
    return route.fulfill({ status: 401, contentType: 'text/html', body: 'Unauthorized' });
  });
  return seen;
}

async function openOtpPage(context) {
  const page = await context.newPage();
  await page.goto('http://localhost:8765/test/otp-split.html');
  return page;
}

test('fills a code from a Gmail email of the same site, without a Gmail tab', async ({ context, extensionId }) => {
  await setup(context, extensionId);
  await routeGmail(context, [
    entry({ title: 'Your Test App code', summary: 'Your verification code is 482913. It expires in 10 minutes.' }),
  ]);
  const page = await openOtpPage(context);
  await expect(page.locator('#result')).toHaveText('Filled: 482913', { timeout: 8000 });
});

test('picks the newest code, and an email arriving later is found by the poll', async ({ context, extensionId }) => {
  await setup(context, extensionId);
  const entries = [];
  await routeGmail(context, entries);
  const page = await openOtpPage(context);
  await page.waitForTimeout(1500);
  await expect(page.locator('#result')).toHaveText('');
  entries.push(
    entry({ title: 'Old code', summary: 'Your code is 111111', minutesAgo: 6, id: 'a1' }),
    entry({ title: 'New code', summary: 'Your code is 222222', minutesAgo: 0, id: 'a2' }),
  );
  await expect(page.locator('#result')).toHaveText('Filled: 222222', { timeout: 12000 });
});

test("never gives a page another site's code, nor an old one", async ({ context, extensionId }) => {
  await setup(context, extensionId);
  await routeGmail(context, [
    entry({ title: 'Your BBVA code', summary: 'Tu código de verificación es 731942', from: 'noreply@bbva.es', name: 'BBVA' }),
    // Another domain that names this site, in the subject or as its own name.
    entry({ title: 'Your localhost security code', summary: 'Your code is 246810', from: 'noreply@phish.example', name: 'localhost' }),
    entry({ title: 'Your code', summary: 'Your code is 135791', from: 'noreply@localhost.evil' }),
    entry({ title: 'Your Test App code', summary: 'Your code is 555555', minutesAgo: 30 }),
  ]);
  const page = await openOtpPage(context);
  await page.waitForTimeout(5000);
  await expect(page.locator('#result')).toHaveText('');
});

test('reads the message when the code is past the snippet', async ({ context, extensionId }) => {
  await setup(context, extensionId);
  const seen = await routeGmail(context, [
    entry({ title: 'Sign-in attempt', summary: 'Hello, we noticed someone is signing in to your Test App account from a new device…' }),
  ], { body: '<html><head><style>p{}</style></head><body><p>Hello,</p><p>Use this verification code to continue:</p><p><b>604281</b></p></body></html>' });
  const page = await openOtpPage(context);
  await expect(page.locator('#result')).toHaveText('Filled: 604281', { timeout: 8000 });
  expect(seen.print).toBe(1);
});

test("a newer email's code in the message wins over an older one's in the snippet", async ({ context, extensionId }) => {
  await setup(context, extensionId);
  await routeGmail(context, [
    entry({ title: 'Your code', summary: 'Your verification code is 111111', minutesAgo: 4, id: 'b1' }),
    entry({ title: 'Your new sign-in code', summary: 'Hello, you asked for a new code to sign in to your Test App account from a new device…', minutesAgo: 0, id: 'b2' }),
  ], { body: '<html><body><p>Your verification code:</p><p><span>604</span><span>281</span></p></body></html>' });
  const page = await openOtpPage(context);
  // Digit-by-digit spans stay one number.
  await expect(page.locator('#result')).toHaveText('Filled: 604281', { timeout: 8000 });
});

test('a code handed out is not filled again', async ({ context, extensionId }) => {
  await setup(context, extensionId);
  await routeGmail(context, [entry({ title: 'Your code', summary: 'Your verification code is 482913' })]);
  const first = await openOtpPage(context);
  await expect(first.locator('#result')).toHaveText('Filled: 482913', { timeout: 8000 });
  const again = await openOtpPage(context);
  await again.waitForTimeout(4000);
  await expect(again.locator('#result')).toHaveText('');
});

test('two pages at once: one gets the code; a new email with the same digits is a new code', async ({ context, extensionId }) => {
  await setup(context, extensionId);
  const entries = [entry({ title: 'Your code', summary: 'Your verification code is 482913', id: 'c1' })];
  await routeGmail(context, entries);
  const [a, b] = await Promise.all([openOtpPage(context), openOtpPage(context)]);
  await a.waitForTimeout(4000);
  const filled = [await a.locator('#result').textContent(), await b.locator('#result').textContent()];
  expect(filled.filter(t => t === 'Filled: 482913')).toHaveLength(1);
  entries.push(entry({ title: 'Your code', summary: 'Your verification code is 482913', minutesAgo: 0, id: 'c2' }));
  const other = filled[0] ? b : a;
  await expect(other.locator('#result')).toHaveText('Filled: 482913', { timeout: 10000 });
});
