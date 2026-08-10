export const metadata = {
  title: 'Firestarter AI Audit -- Internal Grader',
  description: 'Internal dashboard for the 5-pillar AI audit tool.'
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, -apple-system, sans-serif', margin: 0, background: '#f7f7f8', color: '#1a1a1a' }}>
        <header style={{ padding: '16px 24px', background: '#111827', color: 'white', display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="/clients" style={{ color: 'white', textDecoration: 'none', fontWeight: 600, fontSize: 18 }}>
            Firestarter AI Audit -- Internal Grader
          </a>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>Internal only &middot; never touches ActiveCampaign</span>
        </header>
        <main style={{ maxWidth: 1000, margin: '0 auto', padding: '24px' }}>{children}</main>
      </body>
    </html>
  )
}
