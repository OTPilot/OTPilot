import { useState } from 'react'

const faqs = [
  {
    q: 'Does OTPilot work without an account?',
    a: 'Yes. The extension is fully functional without creating an account: passwords, notes, 2FA codes and auto-fill all work locally in your browser. Cloud sync is an optional paid feature.',
  },
  {
    q: 'Can OTPilot read my passwords or 2FA secrets?',
    a: 'No. Every item in your vault is encrypted on your device, each with its own key, protected by your master password. Synced items reach our servers only as ciphertext; the key to read them never leaves your devices. Your master password is never sent anywhere.',
  },
  {
    q: 'What does the free plan include?',
    a: 'Unlimited 2FA codes, plus up to 50 other items (passwords, secure notes, servers, API credentials) on one browser, with auto-fill, the password generator and imports from other password managers. A login that only holds a 2FA code (and its username) never counts toward the 50. Personal removes the limit and syncs everything across your devices.',
  },
  {
    q: 'How does billing work? Can I cancel?',
    a: 'Personal is $3/month or $30/year; Team Lite is $8/month or $80/year per workspace. Plans renew automatically and you can cancel anytime from the billing page; you keep the plan until the end of the period you paid for. After that your vault stays on your devices, on the free plan: if you have more than 50 items you keep all of them, you just can\'t add new ones until you\'re back under the limit or upgrade again.',
  },
  {
    q: 'Can I import from another password manager?',
    a: 'Yes. Export a CSV from Chrome, Edge, Brave, Firefox, Bitwarden, 1Password, LastPass, Dashlane or KeePass and import it in the extension\'s Settings. If you already have a site\'s 2FA code in OTPilot, the imported password is added to that same login. You can also export your whole vault as CSV at any time.',
  },
  {
    q: 'How does sharing with my team work?',
    a: 'Two ways. Collections share everything (passwords, notes, 2FA) with the teammates you choose, end-to-end encrypted: each member gets the collection key wrapped to their own device key, so our servers never see the content. Members can view, edit or manage a collection. Or share just a live 2FA code: the secret is split in two halves, one on the teammate\'s device and one on our server, and the teammate only ever sees the current 6-digit code, never the secret.',
  },
  {
    q: 'What happens if I leave a team, or the team plan is cancelled?',
    a: 'You lose access to what was shared with you: the team\'s collections and shared codes. Your own vault is never touched. If you also pay for Personal you go back to it; otherwise you go back to the free plan, keeping all your items.',
  },
  {
    q: 'Is OTPilot open source?',
    a: 'Yes. The extension is GPL v3 and the backend is AGPL v3 — both OSI-approved open source licenses. You can read, audit, and fork every line. The copyleft terms mean that anyone who distributes a modified version must also keep it open source under the same license.',
  },
  {
    q: 'Can I get a refund?',
    a: 'Yes, within 14 days of a payment (for yearly plans, of the first purchase; renewals are not refunded), if the service didn\'t work as documented or there was a billing error. We don\'t offer refunds for "changed my mind", but you can cancel anytime and the free plan lets you try everything first.',
  },
  {
    q: 'Which browsers does OTPilot support?',
    a: 'OTPilot is available on Chrome and Edge. Firefox and Safari support is coming soon.',
  },
  {
    q: 'Can I use OTPilot on multiple devices without paying?',
    a: 'Yes. On the free plan you can move your logins and 2FA codes between devices manually with the encrypted backup (export on one browser, import on another); the CSV export also carries your secure notes, servers and API credentials. Automatic, real-time sync of everything is part of the Personal plan.',
  },
  {
    q: "I'm currently using Google Authenticator, can I switch?",
    a: 'Yes. Google Authenticator has a built-in "Transfer accounts" export that generates one or more QR codes. Screenshot them and select the images in OTPilot\'s Settings — your accounts are imported instantly, no retyping secrets. Everything is decoded locally on your device.',
  },
]

export default function FAQ() {
  const [open, setOpen] = useState<number | null>(null)

  return (
    <section id="faq" className="py-24 px-6 border-t border-white/5">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">
            Frequently asked questions
          </h2>
        </div>

        <div className="space-y-2">
          {faqs.map((faq, i) => (
            <div
              key={i}
              className="rounded-xl border border-white/8 bg-white/[0.02] overflow-hidden"
            >
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="w-full flex items-center justify-between px-5 py-4 text-left"
              >
                <span className="text-sm font-medium text-zinc-200">{faq.q}</span>
                <svg
                  className={`w-4 h-4 text-zinc-500 shrink-0 ml-4 transition-transform ${open === i ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {open === i && (
                <div className="px-5 pb-4">
                  <p className="text-sm text-zinc-400 leading-relaxed">{faq.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
