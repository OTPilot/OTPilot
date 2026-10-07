import { Link } from 'react-router-dom'

export default function Privacy() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] px-6 py-16">
      <div className="max-w-2xl mx-auto">
        <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-8 inline-block">
          ← Back to home
        </Link>
        <h1 className="text-3xl font-bold text-white mb-2">Privacy Policy</h1>
        <p className="text-zinc-500 text-sm mb-10">Last updated: October 2026</p>

        <div className="space-y-8 text-zinc-400 leading-relaxed text-sm">
          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Extension — local mode</h2>
            <p>When using OTPilot without a cloud account, <strong className="text-zinc-300">no vault data is transmitted to any server</strong>. Your vault (passwords, 2FA secrets, notes and other items) is stored in your browser's local storage (<code className="bg-white/5 px-1.5 py-0.5 rounded text-zinc-300">chrome.storage.local</code>), each item encrypted with its own key, protected by your master password. We have no access to this data.</p>
            <p className="mt-3">To offer "Unlock to fill" on sign-in pages while the vault is locked, the extension also keeps a small <strong className="text-zinc-300">unencrypted index on your device</strong> with each login's name and saved web addresses (never usernames, passwords or secrets). It never leaves your browser, but anyone with access to your browser profile could see which sites you have logins for.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Email code auto-fill (processed locally)</h2>
            <p>If you enable email-code auto-fill, OTPilot reads the visible content of your open webmail tabs (Gmail, Outlook, Yahoo Mail, Proton Mail, Fastmail, Zoho Mail) to find one-time login codes. This happens <strong className="text-zinc-300">entirely on your device</strong> — the email content is never sent to us or any third party. A detected code is held in memory only (for up to 10 minutes) so it can be filled into the matching login field, then discarded. We do not read, store, or transmit your emails. You can turn this off in the extension's Settings.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Site icons</h2>
            <p>To show each account's logo, OTPilot may send that account's <strong className="text-zinc-300">domain</strong> (e.g. <code className="bg-white/5 px-1.5 py-0.5 rounded text-zinc-300">github.com</code>) to our server, which fetches and caches the site's public favicon. Only the domain is sent — never your secrets, codes, or browsing activity — and the icon is then cached in your browser for offline use.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Cloud sync — what we collect</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left py-2 pr-4 text-zinc-300 font-medium">Data</th>
                    <th className="text-left py-2 pr-4 text-zinc-300 font-medium">Purpose</th>
                    <th className="text-left py-2 text-zinc-300 font-medium">Accessible to us?</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <tr>
                    <td className="py-2.5 pr-4">Email address</td>
                    <td className="py-2.5 pr-4">Authentication</td>
                    <td className="py-2.5 text-teal-400">Yes</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4">Encrypted vault items (one per password, note, 2FA code…)</td>
                    <td className="py-2.5 pr-4">Cloud sync</td>
                    <td className="py-2.5 text-zinc-500">No — E2E encrypted</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4">Per item: id, revision, last change, whether it counts toward the free limit</td>
                    <td className="py-2.5 pr-4">Sync, plan limits</td>
                    <td className="py-2.5 text-teal-400">Yes (no content)</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4">Registered devices (name, OS, browser)</td>
                    <td className="py-2.5 pr-4">Device management</td>
                    <td className="py-2.5 text-teal-400">Yes</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4">IP address</td>
                    <td className="py-2.5 pr-4">Rate limiting, security</td>
                    <td className="py-2.5 text-zinc-500">Temporary logs only</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4">Subscription / billing info</td>
                    <td className="py-2.5 pr-4">Payment processing</td>
                    <td className="py-2.5 text-zinc-500">Via Stripe only</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Teams, collections &amp; shared codes</h2>
            <p>On a team plan you can share a <strong className="text-zinc-300">collection</strong>: its items are end-to-end encrypted with a collection key that our server never sees; each member receives that key wrapped to their own device key. The collection's name is encrypted too. For collections we store the encrypted items, the encrypted name, who belongs to each collection and with which role (view / edit / manage), and team activity entries (created, members added or removed).</p>
            <p className="mt-3">You can also share an individual 2FA code with teammates. Shared codes use a <strong className="text-zinc-300">two-of-two key split</strong>: the secret is encrypted with a key whose halves are split between the recipient's device and our server, so neither can read it alone. To generate the live 6-digit code, our server <strong className="text-zinc-300">momentarily reconstructs the key in memory</strong> — this is the only case where the server touches shared secret material, and only the resulting code is returned (the secret is never stored in clear or logged). Revoking a teammate deletes the server's half, making their half useless instantly. We also store: team membership, your email (to show teammates who shared what), your public key (to wrap shared keys to you), and a team activity log (who invited/shared/revoked). Recipients receive an email when a code is shared with them.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">What we never collect</h2>
            <ul className="space-y-1.5">
              {[
                'Your passwords, notes or 2FA secrets in plain text',
                'Your master password',
                'Browsing history or visited URLs',
                'Which sites trigger autofill',
                'Anything not listed above',
              ].map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-teal-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Third-party processors</h2>
            <ul className="space-y-2">
              <li><strong className="text-zinc-300">Supabase</strong> — authentication (magic links, OAuth). GDPR-compliant, EU hosting available.</li>
              <li><strong className="text-zinc-300">Railway</strong> — API and database hosting.</li>
              <li><strong className="text-zinc-300">Stripe</strong> — payment processing. PCI DSS compliant.</li>
              <li><strong className="text-zinc-300">Resend</strong> — transactional email delivery (welcome, new-device, plan-upgrade, team-invite, and shared-code notifications).</li>
              <li><strong className="text-zinc-300">Vercel</strong> — web frontend hosting and anonymous traffic analytics.</li>
              <li><strong className="text-zinc-300">Sentry</strong> — error monitoring and crash reporting.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">GDPR rights (EU users)</h2>
            <ul className="space-y-2">
              <li><strong className="text-zinc-300">Access:</strong> Request a copy of all data we hold about you.</li>
              <li><strong className="text-zinc-300">Deletion:</strong> Delete your account from the dashboard Settings page. All synced data is deleted immediately and permanently. Stripe billing records are retained as required by law.</li>
              <li><strong className="text-zinc-300">Portability:</strong> Export your encrypted backup, or your whole vault as CSV, at any time from the extension.</li>
              <li><strong className="text-zinc-300">Rectification:</strong> Update your email via dashboard settings.</li>
            </ul>
            <p className="mt-3">For GDPR requests, contact: <a href="mailto:privacy@otpilot.app" className="text-teal-400 hover:text-teal-300 underline">privacy@otpilot.app</a></p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Data retention</h2>
            <p>Account data is retained while your account is active. Upon deletion, all synced data (vault items, devices, sync history, team memberships) is deleted immediately and permanently; items you placed in a team collection stay with that collection for its other members. Stripe billing records are retained as required by applicable financial regulations.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Contact</h2>
            <p>Privacy questions: <a href="mailto:privacy@otpilot.app" className="text-teal-400 hover:text-teal-300 underline">privacy@otpilot.app</a></p>
          </section>
        </div>
      </div>
    </div>
  )
}
