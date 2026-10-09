// Search-intent pages (rendered by GuidePage, prerendered, listed in the
// sitemap and the footer). Every claim here must match what the extension
// does today: check before adding one.

export type Guide = {
  path: string
  /** 'compare': an alternative / comparison page; 'guide': how to do something. */
  kind: 'compare' | 'guide'
  /** Short link text (footer, "more" lists). */
  nav: string
  title: string
  description: string
  h1: string
  intro: string
  image?: { src: string; alt: string }
  sections: {
    h2: string
    paragraphs?: string[]
    steps?: string[]
    /** Shown after the steps (a caveat about them). */
    after?: string[]
    bullets?: { title: string; text: string }[]
    table?: { head: string[]; rows: string[][] }
  }[]
  faq: { q: string; a: string }[]
}

const FILL_SHOT = {
  src: '/screens/2-fill-2fa.webp',
  alt: 'A two-factor authentication page with the code already filled in by OTPilot',
}

export const GUIDES: Guide[] = [
  {
    path: '/google-authenticator-for-chrome',
    kind: 'compare',
    nav: 'Google Authenticator for Chrome',
    title: 'Google Authenticator for Chrome: your 2FA codes, filled in | OTPilot',
    description:
      'Use your Google Authenticator codes in Chrome without reaching for your phone. OTPilot imports your accounts and fills the 2FA code on the login page. Free.',
    h1: 'Google Authenticator codes, right in Chrome',
    intro:
      'Google Authenticator lives on your phone, so every sign-in means unlocking it and typing six digits before they expire. OTPilot keeps the same codes in your browser and fills them in on the login page, along with your password.',
    image: FILL_SHOT,
    sections: [
      {
        h2: 'Move your accounts in a minute',
        paragraphs: ['Google Authenticator can export its accounts as QR codes. OTPilot reads them from screenshots, on your device: nothing is uploaded.'],
        steps: [
          'In Google Authenticator, open the ⋮ menu → Transfer accounts → Export accounts, and select the accounts.',
          'Take a screenshot of each QR code it shows.',
          'In OTPilot, open Settings → From Google Authenticator, click Select screenshots… and choose them.',
          'Check the accounts to bring over and click Import selected.',
          'Google Authenticator doesn\'t record which website each code belongs to, so link each one the first time: on the site\'s 2FA page, open the OTPilot popup, pick the account and click Fill Page. OTPilot asks to save the site ("It\'ll auto-fill here next time"): click Save. From then on the code fills on its own.',
        ],
        after: ['OTPilot supports the codes almost every site uses: six digits, changing every 30 seconds. Accounts with other settings are skipped, and the import says how many.'],
      },
      {
        h2: 'What changes when your codes are in the browser',
        bullets: [
          { title: 'Filled for you', text: 'When a site asks for the code, OTPilot fills the current one and submits the form. No phone, no typing.' },
          { title: 'Only on the right site', text: 'Each code is tied to the sites you saved it for, so it is never filled on a lookalike page.' },
          { title: 'Several accounts, one site', text: 'Work and personal accounts on the same service? OTPilot asks which one, in one click.' },
          { title: 'Your passwords too', text: 'OTPilot is a full password manager: it fills the username and password first, then the code.' },
        ],
      },
      {
        h2: 'Same standard, same codes',
        paragraphs: [
          'Google Authenticator and OTPilot both use the TOTP standard (RFC 6238): for the same account they show exactly the same code. You can keep Google Authenticator on your phone as a backup while OTPilot does the work on your computer.',
        ],
      },
      {
        h2: 'Is it safe to keep 2FA codes in the browser?',
        paragraphs: [
          'Your vault is encrypted on your device under your master password (AES-256-GCM, with the key derived through 600,000 PBKDF2 iterations) and locks itself after the time you choose. If you turn on sync, our servers only ever store ciphertext. The extension is open source.',
          'Keeping your password and your second factor in one vault is a trade-off: it removes the friction that makes people skip 2FA, and codes are only filled on the sites they belong to. Read how OTPilot protects your data on the security page.',
        ],
      },
    ],
    faq: [
      { q: 'Do I need an account?', a: 'No. OTPilot works without an account, fully on your device. An account is only needed to sync across devices.' },
      { q: 'Can I keep using Google Authenticator?', a: 'Yes. Both apps generate the same codes from the same secret, so you can use both at the same time.' },
      { q: 'Is there a phone app?', a: 'No. OTPilot runs in your browser: Chrome, Edge and other Chromium browsers. Keep your phone app for signing in on your phone.' },
      { q: 'How much does it cost?', a: 'Free for unlimited 2FA codes and up to 50 passwords, notes and other items. Sync across devices is $3/month or $30/year.' },
    ],
  },
  {
    path: '/authy-alternative',
    kind: 'compare',
    nav: 'Authy alternative',
    title: 'Authy alternative for your computer: 2FA codes in the browser | OTPilot',
    description:
      'Authy no longer has desktop apps. OTPilot puts your 2FA codes in Chrome, fills them on the login page and syncs them end-to-end encrypted. Free to start.',
    h1: 'An Authy alternative that lives in your browser',
    intro:
      'Authy no longer offers desktop apps, so signing in on your computer means picking up your phone for every code. OTPilot keeps your 2FA codes in the browser and fills them in on the login page, together with your password.',
    image: FILL_SHOT,
    sections: [
      {
        h2: 'Moving from Authy',
        paragraphs: [
          'Authy does not let you export your 2FA secrets, so no app can import them directly. The way out is to re-add each account, and OTPilot makes that quick: when a site shows its 2FA setup QR code, OTPilot detects it and saves the account in one click.',
        ],
        steps: [
          'Install OTPilot and set your master password.',
          'For each account, open the site\'s security settings and set up the authenticator app again.',
          'When the QR code appears, click "Add account" in the OTPilot prompt on the page, then finish the setup on the site with the code.',
          'Keep Authy until every account works in OTPilot, then remove it from the ones you moved.',
        ],
      },
      {
        h2: 'What you get',
        bullets: [
          { title: 'Codes filled on the page', text: 'When a site asks for the code, OTPilot fills the current one and submits. No phone.' },
          { title: 'Sync without trusting us', text: 'Sync across your devices is end-to-end encrypted: our servers only ever see ciphertext.' },
          { title: 'Your codes are yours', text: 'Export everything any time, as an encrypted backup or a CSV.' },
          { title: 'Passwords and teams', text: 'A full password manager, with sharing for teams, including live 2FA codes shared without revealing the secret.' },
        ],
      },
      {
        h2: 'Authy and OTPilot side by side',
        table: {
          head: ['', 'Authy', 'OTPilot'],
          rows: [
            ['Desktop', 'No desktop apps', 'Chrome, Edge and other Chromium browsers'],
            ['Fills the code on the login page', 'No', 'Yes'],
            ['Export your 2FA secrets', 'No', 'Yes: encrypted backup or CSV'],
            ['Passwords', 'No', 'Yes'],
            ['Phone app', 'Yes', 'No'],
          ],
        },
      },
    ],
    faq: [
      { q: 'Can OTPilot import my Authy accounts?', a: 'Not directly: Authy does not export secrets. Re-add each account from the site\'s 2FA settings; OTPilot detects the setup QR code and saves it in one click.' },
      { q: 'Do I need an account?', a: 'No. OTPilot works without an account, fully on your device. An account is only needed to sync across devices.' },
      { q: 'How much does it cost?', a: 'Free for unlimited 2FA codes and up to 50 passwords, notes and other items. Sync across devices is $3/month or $30/year.' },
    ],
  },
  {
    path: '/autofill-2fa-codes-chrome',
    kind: 'guide',
    nav: 'Autofill 2FA codes in Chrome',
    title: 'Autofill 2FA codes in Chrome | OTPilot',
    description:
      'Stop copying six-digit codes. OTPilot fills your 2FA code on the login page and submits it, on the sites you saved it for. Also reads email codes. Free.',
    h1: 'Autofill your 2FA codes in Chrome',
    intro:
      'Two-factor authentication should not mean copying six digits from your phone on every sign-in. OTPilot generates the code in your browser and fills it in the moment the site asks for it.',
    image: FILL_SHOT,
    sections: [
      {
        h2: 'How it works',
        steps: [
          'Save the account: OTPilot detects the 2FA setup QR code on the page, or you paste the setup key, or import from Google Authenticator (imported accounts are linked to their site the first time you use Fill Page there).',
          'Sign in: OTPilot offers your saved login in the username field and fills the password.',
          'The code field appears: OTPilot fills the current code and submits the form.',
          'Several accounts on that site? Pick one in the prompt. Vault locked? Unlock it right on the page.',
        ],
      },
      {
        h2: 'Email codes too',
        paragraphs: [
          'Some sites send the code by email. OTPilot reads it from an open Gmail, Outlook, Yahoo Mail, Proton Mail, Fastmail or Zoho Mail tab and fills it in. The email is read only on your device and never sent anywhere; you can turn it off in Settings.',
        ],
      },
      {
        h2: 'Built to stay out of the way',
        bullets: [
          { title: 'Only on the right site', text: 'A code is filled only on the sites you saved it for, never on a lookalike domain.' },
          { title: 'Sites that block automatic submit', text: 'Some sites reject a form submitted by an extension. OTPilot notices, and on those sites fills the code and leaves the final click to you.' },
          { title: 'Works offline', text: 'Codes are generated on your device from the standard TOTP algorithm (RFC 6238). No network needed.' },
        ],
      },
    ],
    faq: [
      { q: 'Does autofilling 2FA codes make 2FA useless?', a: 'It keeps your second factor in the same vault as your password, which is a trade-off. You still get what most people need 2FA for: a leaked password alone does not get anyone in, and codes are only filled on the sites they belong to.' },
      { q: 'Which sites does it work with?', a: 'Sites that use standard authenticator-app codes: six digits, changing every 30 seconds (TOTP with SHA-1), which is what almost every site uses. Plus email codes from the supported webmails.' },
      { q: 'How much does it cost?', a: 'Free for unlimited 2FA codes and up to 50 passwords, notes and other items. Sync across devices is $3/month or $30/year.' },
    ],
  },
  {
    path: '/microsoft-authenticator-alternative',
    kind: 'compare',
    nav: 'Microsoft Authenticator alternative',
    title: 'Microsoft Authenticator alternative for passwords and 2FA | OTPilot',
    description: 'Microsoft Authenticator no longer fills passwords. OTPilot keeps your passwords and 2FA codes together in Chrome and fills both on the login page. Free to start.',
    h1: 'Passwords and 2FA codes together, after Microsoft Authenticator',
    intro: 'In 2025 Microsoft removed password autofill from Microsoft Authenticator: saved passwords moved to Microsoft Edge, and the app kept 2FA codes and passkeys. OTPilot keeps your passwords and your 2FA codes in one place in your browser, and fills both on the login page.',
    image: FILL_SHOT,
    sections: [
      {
        h2: 'What changed in Microsoft Authenticator',
        paragraphs: [
          'Microsoft stopped password autofill in Authenticator in July 2025 and removed the saved passwords from the app in August 2025; they stay in your Microsoft account and in Edge. The app still generates 2FA codes on your phone.',
        ],
      },
      {
        h2: 'What OTPilot does instead',
        bullets: [
          { title: 'One place for both', text: 'Your password and your 2FA code for a site live in the same login, and are filled one after the other.' },
          { title: 'No phone at sign-in', text: 'The code is generated in your browser and filled on the page.' },
          { title: 'Bring your passwords', text: 'Export your passwords from Edge (or any browser) as a CSV and import them in Settings → From a password manager.' },
          { title: 'Encrypted on your device', text: 'Your vault is encrypted under your master password; sync only ever sends ciphertext.' },
        ],
      },
      {
        h2: 'Moving your 2FA codes',
        paragraphs: [
          'Microsoft Authenticator has no export for other apps, so 2FA accounts are moved one by one: in each site\'s security settings, set up the authenticator app again. OTPilot detects the setup QR code on the page and saves the account in one click. Keep Microsoft Authenticator until every account works in OTPilot.',
        ],
      },
    ],
    faq: [
      { q: 'Do I need an account?', a: 'No. OTPilot works without an account, fully on your device. An account is only needed to sync across devices.' },
      { q: 'Does OTPilot work in Edge?', a: 'Yes. OTPilot is available for Chrome and Edge, and works in other Chromium browsers.' },
      { q: 'How much does it cost?', a: 'Free for unlimited 2FA codes and up to 50 passwords, notes and other items. Sync across devices is $3/month or $30/year.' },
    ],
  },
  {
    path: '/bitwarden-alternative',
    kind: 'compare',
    nav: 'Bitwarden alternative',
    title: 'Bitwarden alternative with free 2FA codes | OTPilot',
    description: 'Bitwarden\'s built-in authenticator is a Premium feature. OTPilot includes unlimited 2FA codes for free and fills them on the login page, after your password.',
    h1: 'A password manager with 2FA codes included, free',
    intro: 'Bitwarden can store your 2FA codes, but its built-in authenticator is part of Premium. In OTPilot, 2FA is the core: unlimited 2FA codes are free, and they are filled on the page right after your password.',
    image: FILL_SHOT,
    sections: [
      {
        h2: 'OTPilot and Bitwarden side by side',
        table: {
          head: ['', 'Bitwarden', 'OTPilot'],
          rows: [
            ['Built-in 2FA codes', 'Premium plan', 'Free, unlimited'],
            ['Email codes from your webmail', 'No', 'Yes'],
            ['Platforms', 'Desktop, mobile and browser apps', 'Chrome, Edge and other Chromium browsers'],
            ['End-to-end encrypted', 'Yes', 'Yes'],
          ],
        },
        after: ['Bitwarden is a great open-source password manager with apps everywhere. If you sign in mostly from your computer\'s browser and want 2FA codes without a paid plan, OTPilot is built for that.'],
      },
      {
        h2: 'Switching',
        steps: [
          'In Bitwarden, export your vault as a CSV (unencrypted .csv).',
          'In OTPilot, open Settings → From a password manager and select the file. Passwords and 2FA keys come in together, and logins you already have are matched instead of duplicated.',
          'Delete the CSV afterwards: it isn\'t encrypted.',
        ],
      },
    ],
    faq: [
      { q: 'Do I need an account?', a: 'No. OTPilot works without an account, fully on your device. An account is only needed to sync across devices.' },
      { q: 'How much does it cost?', a: 'Free for unlimited 2FA codes and up to 50 passwords, notes and other items. Sync across devices is $3/month or $30/year.' },
    ],
  },
  {
    path: '/authenticator-extension-chrome',
    kind: 'compare',
    nav: 'Authenticator extension for Chrome',
    title: 'Authenticator extension for Chrome that fills the code | OTPilot',
    description: 'Most authenticator extensions show a code for you to copy. OTPilot fills the 2FA code on the login page, saves accounts from setup pages, and keeps your passwords too.',
    h1: 'An authenticator extension that fills the code for you',
    intro: 'A typical authenticator extension shows a list of codes: you open it, find the account, copy the code and paste it. OTPilot skips all of that: when the site asks for the code, it is already in the field.',
    image: FILL_SHOT,
    sections: [
      {
        h2: 'What it does that a code list doesn\'t',
        bullets: [
          { title: 'Fills and submits', text: 'The current code is filled on the page and the form submitted. On sites that block that, the code is filled and the click is left to you.' },
          { title: 'Knows the site', text: 'Codes are tied to the sites you saved them for, so the right one is used, and never on a lookalike domain.' },
          { title: 'Saves accounts from the setup page', text: 'When you turn on 2FA somewhere, OTPilot detects the QR code and saves the account in one click.' },
          { title: 'Also a password manager', text: 'Username and password first, then the code: the whole sign-in.' },
          { title: 'Locked when you\'re away', text: 'A master password protects the vault, and it locks itself after the time you choose.' },
        ],
      },
    ],
    faq: [
      { q: 'Can I bring my codes from another authenticator?', a: 'From Google Authenticator, yes: screenshot its "Transfer accounts" QR codes and select them. From apps with a CSV export, use Settings → From a password manager. Otherwise, re-add each account from the site\'s 2FA settings.' },
      { q: 'Do I need an account?', a: 'No. OTPilot works without an account, fully on your device. An account is only needed to sync across devices.' },
      { q: 'How much does it cost?', a: 'Free for unlimited 2FA codes and up to 50 passwords, notes and other items. Sync across devices is $3/month or $30/year.' },
    ],
  },
]
