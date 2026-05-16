import { Link } from 'react-router-dom'

export default function Refunds() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] px-6 py-16">
      <div className="max-w-2xl mx-auto">
        <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-8 inline-block">
          ← Back to home
        </Link>
        <h1 className="text-3xl font-bold text-white mb-2">Refund Policy</h1>
        <p className="text-zinc-500 text-sm mb-10">Last updated: May 2026</p>

        <div className="space-y-8 text-zinc-400 leading-relaxed text-sm">
          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Our approach</h2>
            <p>We offer refunds for technical failures and billing errors — not for change of mind. We recommend using the free plan before purchasing to make sure OTPilot fits your needs.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Valid reasons for a refund</h2>
            <ul className="space-y-2">
              {[
                'The cloud service was inaccessible for more than 24 continuous hours due to a provider failure on our end.',
                'A documented feature did not work as described, and the issue was not resolved within 7 days of your report.',
                'You were charged the wrong amount or charged twice due to a billing error.',
              ].map((item, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className="text-teal-400 font-semibold shrink-0">{i + 1}.</span>
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Reasons that do not qualify</h2>
            <ul className="space-y-1.5">
              {[
                '"I no longer need it" or "I don\'t use it enough"',
                '"I found a better alternative"',
                '"I don\'t like the interface"',
                'Accounts terminated for Terms of Service violations',
              ].map((item) => (
                <li key={item} className="flex items-center gap-2 text-zinc-500">
                  <svg className="w-3.5 h-3.5 text-zinc-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Refund windows and amounts</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left py-2 pr-4 text-zinc-300 font-medium">Plan</th>
                    <th className="text-left py-2 pr-4 text-zinc-300 font-medium">Window</th>
                    <th className="text-left py-2 text-zinc-300 font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <tr>
                    <td className="py-2.5 pr-4">Personal Lifetime ($15)</td>
                    <td className="py-2.5 pr-4">Within 14 days</td>
                    <td className="py-2.5 text-teal-400">Full refund</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4">Personal Lifetime ($15)</td>
                    <td className="py-2.5 pr-4">After 14 days</td>
                    <td className="py-2.5 text-zinc-500">No refund</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">How to request a refund</h2>
            <ol className="space-y-2 list-none">
              <li className="flex items-start gap-2.5"><span className="text-teal-400 font-semibold">1.</span> Email <a href="mailto:refunds@otpilot.app" className="text-teal-400 hover:text-teal-300 underline">refunds@otpilot.app</a> with subject line "Refund Request".</li>
              <li className="flex items-start gap-2.5"><span className="text-teal-400 font-semibold">2.</span> Include your account email and a brief description of the issue.</li>
              <li className="flex items-start gap-2.5"><span className="text-teal-400 font-semibold">3.</span> We'll respond within 5 business days.</li>
              <li className="flex items-start gap-2.5"><span className="text-teal-400 font-semibold">4.</span> Approved refunds are processed via Stripe and typically appear within 5–10 business days.</li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  )
}
