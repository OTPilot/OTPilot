import { Link } from 'react-router-dom'

export default function Tos() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] px-6 py-16">
      <div className="max-w-2xl mx-auto">
        <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-8 inline-block">
          ← Back to home
        </Link>
        <h1 className="text-3xl font-bold text-white mb-2">Terms of Service</h1>
        <p className="text-zinc-500 text-sm mb-10">Last updated: October 2026</p>

        <div className="prose prose-sm prose-invert max-w-none space-y-8 text-zinc-400 leading-relaxed">
          <section>
            <h2 className="text-white font-semibold text-lg mb-3">1. Acceptance</h2>
            <p>By installing the OTPilot browser extension or using the OTPilot Cloud Service, you agree to these Terms. If you do not agree, do not use the Service.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">2. Your account</h2>
            <p>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. You must provide accurate information when creating an account. Accounts must be used by a single human — automated registration or use by bots is not permitted.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">3. Acceptable use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc list-inside space-y-1 mt-2">
              <li>Resell, sublicense, or redistribute the Service or access to it</li>
              <li>Reverse-engineer, decompile, or attempt to extract the source code of the Service</li>
              <li>Use the Service to build a competing product</li>
              <li>Attempt to gain unauthorized access to other users' data or our infrastructure</li>
              <li>Transmit malware, spam, or any content that violates applicable law</li>
              <li>Abuse, harass, or impersonate other users or our team</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">4. License</h2>
            <p>We grant you a limited, non-exclusive, non-transferable license to install and use the OTPilot extension and Cloud Service for your personal or internal business purposes, subject to these Terms. This license terminates automatically if you violate any of its restrictions.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">5. Intellectual property</h2>
            <p>OTPilot and all related software, designs, and content are the exclusive property of Alberto Paparelli. Nothing in these Terms grants you any right to use our trademarks, logos, or branding without prior written permission.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">6. Plans, subscriptions and billing</h2>
            <p>The free plan includes unlimited 2FA codes and up to <strong className="text-zinc-300">50 other vault items</strong> (passwords, secure notes, servers, API credentials and similar); a login that only holds a 2FA code and its username does not count toward that limit. Paid plans (Personal, Team Lite and extra seats) are <strong className="text-zinc-300">subscriptions billed monthly or yearly in advance</strong> through Stripe, and renew automatically until cancelled. You can cancel at any time from the dashboard's Billing page; cancellation stops future renewals and the plan remains active until the end of the paid period. Refunds follow our <Link to="/refunds" className="text-teal-400 hover:text-teal-300 underline">Refund Policy</Link>. We may change prices for future billing periods with at least <strong className="text-zinc-300">30 days prior notice</strong> by email. When a paid plan ends, your account moves to the free plan: your data is not deleted, and if you are over the free limit you keep every item but cannot add new ones. We may discontinue the Cloud Service with <strong className="text-zinc-300">90 days prior written notice</strong>; renewals stop and unused prepaid time is refunded pro rata.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">7. Local functionality</h2>
            <p>The browser extension's local functionality — including your local vault, auto-fill and 2FA code generation — will remain fully operational regardless of the status of the cloud service. Cloud-dependent features will cease to function upon service shutdown, but your locally stored data will never be affected.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">7A. Teams, collections and shared codes</h2>
            <p>On a team plan, the team owner is responsible for managing members and seats, and for all charges on the team subscription, including extra seats. Team members can share in two ways. A <strong className="text-zinc-300">collection</strong> shares its full contents (passwords, notes, 2FA secrets and other items) with the members added to it, with view, edit or manage permissions; anyone who can view a collection can read and copy what it contains, so removing a member does not undo what they already saw — change the affected passwords if needed. A <strong className="text-zinc-300">shared code</strong> grants access to the live, time-based code only, never the underlying secret, and can be revoked at any time. You agree to share only accounts and information you are authorized to share, and to use what is shared with you solely for its intended purpose. Leaving a team, being removed from it, or cancelling the team subscription removes access to its collections and shared codes; each member's own vault is not affected.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">8. Modifications to the Service</h2>
            <p>We may modify or remove features with reasonable notice. Material changes to paid plan features will be communicated at least <strong className="text-zinc-300">30 days in advance</strong> via email.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">9. Account termination</h2>
            <p>We may suspend or terminate accounts that violate these Terms, including accounts used for abuse, unauthorized access attempts, or circumventing technical measures. In such cases, no refund will be issued.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">10. Limitation of liability</h2>
            <p>The Service is provided "as is" without warranty of any kind. We are not liable for any loss of data, security breaches caused by user-side vulnerabilities (e.g., a compromised master password), or indirect, incidental, or consequential damages. To the extent permitted by law, our total liability for any claim arising out of these Terms is limited to the amount you paid us in the 12 months preceding the claim.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">11. Indemnification</h2>
            <p>You agree to indemnify and hold harmless OTPilot and its owner from any claims, damages, or expenses (including legal fees) arising from your use of the Service, your violation of these Terms, or your infringement of any third-party rights.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">12. Changes to these Terms</h2>
            <p>We may update these Terms from time to time. We will notify you of material changes via email at least 14 days before they take effect. Continued use of the Service after changes take effect constitutes your acceptance of the revised Terms.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">13. Governing law</h2>
            <p>These Terms are governed by the laws of Argentina. Disputes will be resolved in the courts of Buenos Aires, Argentina.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">14. Contact</h2>
            <p>Questions about these Terms? Contact us at <a href="mailto:hello@otpilot.app" className="text-teal-400 hover:text-teal-300 underline">hello@otpilot.app</a>.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
