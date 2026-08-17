import Link from 'next/link'
import { getClientWithRuns } from '../../../../lib/data'

export const dynamic = 'force-dynamic'

// Client Settings hub -- added 2026-08-17 alongside the Client/Industry
// Intelligence UX placement correction. Shared client-level configuration
// (things other pillars/features read from, not something any one pillar
// owns) lives under here, one link per area, rather than scattered across
// the pillar/audit page. Deliberately tiny -- two links today; more shared-
// config areas can be added as their own row later without restructuring
// this page.
export default async function ClientSettingsPage({ params }) {
  const { id } = await params
  const { client } = await getClientWithRuns(id)

  return (
    <div>
      <div className="section-label">
        <Link href={`/clients/${id}`} style={{ color: 'inherit' }}>&larr; {client.name}</Link>
      </div>
      <h1 style={{ marginBottom: 24 }}>Client Settings</h1>

      <div style={{ display: 'grid', gap: 10, maxWidth: 480 }}>
        <Link href={`/clients/${id}/settings/business-profile`} className="card list-row" style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Business Profile</div>
          <div className="text-small text-muted">Detected business model, industry, products/services, geography -- shared Client/Industry Intelligence.</div>
        </Link>
        <Link href={`/clients/${id}/settings/topic-intelligence`} className="card list-row" style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Topic &amp; Prompt Intelligence</div>
          <div className="text-small text-muted">Recommended topic clusters and prompt variations tracked across AI engines.</div>
        </Link>
      </div>
    </div>
  )
}
