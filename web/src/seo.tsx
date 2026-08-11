import { Head } from 'vite-react-ssg'

export const SITE = 'https://otpilot.app'
const DEFAULT_IMG = `${SITE}/og.png`

/** Per-page head: title, description, canonical, Open Graph and Twitter. Rendered
 * into the static HTML at build (vite-react-ssg) and updated on the client. Every
 * page should render exactly one <Seo>. */
export function Seo({
  title,
  description,
  path,
  image,
  type = 'website',
}: {
  title: string
  description: string
  path: string
  image?: string
  type?: 'website' | 'article'
}) {
  const url = `${SITE}${path}`
  const img = image ?? DEFAULT_IMG
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={url} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={img} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:site" content="@otpilotapp" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={img} />
    </Head>
  )
}
