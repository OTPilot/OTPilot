import { Head } from 'vite-react-ssg'
import { Seo } from '../../seo'
import Navbar from '../../components/Navbar'
import Footer from '../../components/Footer'
import { CHROME_STORE_URL } from '../../lib/browser'
import { GUIDES, type Guide } from './guides'

// One search-intent page (an alternative, a how-to): the answer first, then
// how it works, then questions — each page ends on installing the extension.
export default function GuidePage({ guide }: { guide: Guide }) {
  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      <Seo title={guide.title} description={guide.description} path={guide.path} />
      {guide.faq.length > 0 && (
        <Head>
          <script type="application/ld+json">{JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: guide.faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
          })}</script>
        </Head>
      )}
      <Navbar />
      <main className="px-6 pt-32 pb-20">
        <article className="max-w-3xl mx-auto">
          <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight leading-tight mb-6">{guide.h1}</h1>
          <p className="text-lg text-zinc-300 leading-relaxed mb-8">{guide.intro}</p>
          <Cta />

          {guide.image && (
            <img
              src={guide.image.src}
              alt={guide.image.alt}
              width={1280}
              height={800}
              className="w-full h-auto rounded-2xl border border-white/10 shadow-2xl shadow-black/40 my-12"
            />
          )}

          {guide.sections.map((s) => (
            <section key={s.h2} className="mt-12">
              <h2 className="text-2xl font-bold text-white mb-4 tracking-tight">{s.h2}</h2>
              {s.paragraphs?.map((p) => (
                <p key={p} className="text-zinc-400 leading-relaxed mb-4">{p}</p>
              ))}
              {s.steps && (
                <ol className="list-decimal pl-6 space-y-2 text-zinc-400 leading-relaxed mb-4">
                  {s.steps.map((st) => <li key={st}>{st}</li>)}
                </ol>
              )}
              {s.bullets && (
                <ul className="space-y-3 mb-4">
                  {s.bullets.map((b) => (
                    <li key={b.title} className="text-zinc-400 leading-relaxed">
                      <span className="text-white font-medium">{b.title}.</span> {b.text}
                    </li>
                  ))}
                </ul>
              )}
              {s.table && (
                <div className="overflow-x-auto mb-4">
                  <table className="w-full text-sm text-left border-collapse">
                    <thead>
                      <tr>{s.table.head.map((h) => <th key={h} className="py-2 pr-4 text-zinc-300 font-semibold border-b border-white/10">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {s.table.rows.map((r) => (
                        <tr key={r[0]}>{r.map((c, i) => <td key={i} className={`py-2 pr-4 border-b border-white/5 ${i === 0 ? 'text-zinc-300' : 'text-zinc-400'}`}>{c}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {s.after?.map((p) => (
                <p key={p} className="text-zinc-400 leading-relaxed mb-4">{p}</p>
              ))}
            </section>
          ))}

          {guide.faq.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold text-white mb-6 tracking-tight">Questions</h2>
              <dl className="space-y-6">
                {guide.faq.map((f) => (
                  <div key={f.q}>
                    <dt className="text-white font-medium mb-1">{f.q}</dt>
                    <dd className="text-zinc-400 leading-relaxed">{f.a}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <nav aria-label="More from OTPilot" className="mt-12">
            <h2 className="text-sm font-semibold text-zinc-300 mb-3">More from OTPilot</h2>
            <ul className="flex flex-wrap gap-x-6 gap-y-2">
              {GUIDES.filter((g) => g.path !== guide.path).map((g) => (
                <li key={g.path}>
                  <a href={g.path} className="text-sm text-teal-400 hover:text-teal-300">{g.nav}</a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="mt-16 p-8 rounded-2xl border border-teal-500/20 bg-teal-500/5 text-center">
            <p className="text-2xl font-bold text-white mb-2">Password manager with built-in 2FA</p>
            <p className="text-zinc-400 mb-6">Fills your password and your 2FA code on any login page. End-to-end encrypted, synced across devices, free to start.</p>
            <Cta center />
          </div>
        </article>
      </main>
      <Footer />
    </div>
  )
}

function Cta({ center = false }: { center?: boolean }) {
  return (
    <div className={`flex flex-col sm:flex-row gap-3 ${center ? 'justify-center' : ''}`}>
      <a
        href={CHROME_STORE_URL}
        className="inline-flex items-center justify-center px-6 py-3 rounded-xl bg-gradient-to-r from-teal-400 to-emerald-400 text-zinc-950 font-semibold hover:opacity-90 transition-opacity"
      >
        Add to Chrome — it's free
      </a>
      <a
        href="/#pricing"
        className="inline-flex items-center justify-center px-6 py-3 rounded-xl border border-white/10 text-zinc-200 hover:bg-white/5 transition-colors"
      >
        See pricing
      </a>
    </div>
  )
}
