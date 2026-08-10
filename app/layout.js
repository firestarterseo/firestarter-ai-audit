import Image from 'next/image'
import Link from 'next/link'

// Firestarter brand typography: Fjalla One for display/headings, Poppins for
// body & UI. Self-hosted via @fontsource (bundled at build time, zero
// runtime requests to Google Fonts -- more reliable than next/font/google,
// which needs live network access to fonts.googleapis.com during the build).
import '@fontsource/fjalla-one/400.css'
import '@fontsource/poppins/300.css'
import '@fontsource/poppins/400.css'
import '@fontsource/poppins/500.css'
import '@fontsource/poppins/600.css'
import '@fontsource/poppins/700.css'
import './globals.css'

export const metadata = {
  title: 'Firestarter -- Internal AI Audit Grader',
  description: 'Internal dashboard for the 5-pillar AI visibility audit tool.'
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="app-header">
          <Link href="/clients" className="logo">
            <Image src="/brand/logo-color.png" alt="Firestarter" width={150} height={45} priority style={{ height: 32, width: 'auto' }} />
          </Link>
          <span className="tag">Internal only &middot; never touches ActiveCampaign</span>
        </header>
        <main className="app-main">{children}</main>
      </body>
    </html>
  )
}
