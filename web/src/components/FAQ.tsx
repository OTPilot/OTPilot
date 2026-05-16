import { useState } from 'react'

const faqs = [
  {
    q: 'Does OTPilot work without an account?',
    a: 'Yes. The extension is fully functional without creating an account. All your codes are stored locally in your browser. Cloud sync is an optional paid feature.',
  },
  {
    q: 'Can OTPilot read my TOTP secrets?',
    a: 'No. Your secrets are encrypted with your master password before leaving your device. We never see them in plain text, not even for cloud sync. The encryption key exists only on your device.',
  },
  {
    q: 'What does "locked in" mean for Early Adopters?',
    a: 'It means your $15 is your price forever, no renewals, no future charges, no price increases for you. The pricing model may change for new customers down the road, but everyone who buys now keeps their access under the same terms. If the cloud service is ever discontinued, we\'ll give 90 days advance notice and your local extension keeps working regardless.',
  },
  {
    q: 'What happens if I cancel my Team plan?',
    a: 'Your extension reverts to local-only mode. Cloud sync stops immediately — the Personal Cloud plan and the Team plan are independent, so cancelling Team does not grant Personal sync. All locally stored accounts remain intact. Shared codes that teammates accessed via your team become inaccessible to them, but their own local accounts are unaffected.',
  },
  {
    q: 'Is OTPilot open source?',
    a: 'Yes. The extension is GPL v3 and the backend is AGPL v3 — both OSI-approved open source licenses. You can read, audit, and fork every line. The copyleft terms mean that anyone who distributes a modified version must also keep it open source under the same license.',
  },
  {
    q: 'Can I get a refund?',
    a: 'Yes, within 14 days of purchase, if the service didn\'t work as documented or there was a billing error. We don\'t offer refunds for "changed my mind", but you can always stay on the free plan before committing.',
  },
  {
    q: 'Which browsers does OTPilot support?',
    a: 'OTPilot is available on Chrome and Edge. Firefox and Safari support is coming soon.',
  },
  {
    q: 'Can I use OTPilot on multiple devices without paying?',
    a: 'Yes. On the free plan you can move your accounts between devices manually using the encrypted export/import feature, just export from one browser and import on another. Cloud sync (automatic, real-time) is available on the Personal plan.',
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
