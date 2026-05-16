import { Link } from 'react-router-dom'

export default function Tos() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] px-6 py-16">
      <div className="max-w-2xl mx-auto">
        <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-8 inline-block">
          ← Back to home
        </Link>
        <h1 className="text-3xl font-bold text-white mb-2">Terms of Service</h1>
        <p className="text-zinc-500 text-sm mb-10">Last updated: May 2026</p>

        <div className="prose prose-sm prose-invert max-w-none space-y-8 text-zinc-400 leading-relaxed">
          <section>
            <h2 className="text-white font-semibold text-lg mb-3">1. Acceptance</h2>
            <p>By installing the OTPilot browser extension or using the OTPilot Cloud Service, you agree to these Terms. If you do not agree, do not use the Service.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">2. Definition of "Lifetime"</h2>
            <p>"Lifetime" in the context of the Personal Cloud plan refers to the operational lifetime of the OTPilot Cloud Service, not the User's lifetime. We reserve the right to discontinue the Service at any time with <strong className="text-zinc-300">90 days prior written notice</strong>. No refunds will be issued for Lifetime plans upon service shutdown, except as stated in our <Link to="/refunds" className="text-teal-400 hover:text-teal-300 underline">Refund Policy</Link>.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">3. Local functionality</h2>
            <p>The browser extension's local functionality — including TOTP generation and local storage — will remain fully operational regardless of the status of the cloud service. Cloud-dependent features will cease to function upon service shutdown, but your locally stored data will never be affected.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">4. Modifications to the Service</h2>
            <p>We may modify or remove features with reasonable notice. Material changes to paid plan features will be communicated at least <strong className="text-zinc-300">30 days in advance</strong> via email.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">5. Account termination</h2>
            <p>We may suspend or terminate accounts that violate these Terms, including accounts used for abuse, unauthorized access attempts, or circumventing technical measures. In such cases, no refund will be issued.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">6. Limitation of liability</h2>
            <p>The Service is provided "as is" without warranty of any kind. We are not liable for any loss of data, security breaches caused by user-side vulnerabilities (e.g., a compromised master password), or indirect, incidental, or consequential damages.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">7. Governing law</h2>
            <p>These Terms are governed by the laws of Argentina. Disputes will be resolved in the courts of Buenos Aires, Argentina.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">8. Contact</h2>
            <p>Questions about these Terms? Contact us at <a href="mailto:hello@otpilot.app" className="text-teal-400 hover:text-teal-300 underline">hello@otpilot.app</a>.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
