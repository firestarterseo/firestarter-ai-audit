import Link from 'next/link'
import { getClientWithRuns } from '../../../../../lib/data'
import { getClientIndustryProfile } from '../../../../../lib/clientIndustryIntelligence'
import ClientIntelligenceCard from '../../ClientIntelligenceCard'

export const dynamic = 'force-dynamic'

// Client Settings -> Business Profile.
//
// UX correction (2026-08-17): Client / Industry Intelligence is SHARED
// CLIENT CONFIGURATION, not part of any one pillar's diagnosis/execution
// workflow -- so the full editable "Detected Business Context" experience
// (confidence, evidence drill-down, Confirm All / Confirm Field / Edit /
// Override / Re-detect / Accept / Dismiss) lives here, at a dedicated,
// persistent Client Settings location, not inside the client audit page.
// This is the FIRST place a brand-new client lands after creation (see
// app/clients/new/page.js's redirect) -- "the first automatic
// classification should occur as part of client setup" -- and the
// canonical place to come back to later to correct or re-detect it. The
// client audit page (app/clients/[id]/page.js) shows only a compact,
// read-only summary chip that links back here -- see that file's own
// comment on why it deliberately does NOT render ClientIntelligenceCard
// itself.
//
// No new Phase 1a/1b logic here at all -- this page is pure UI placement,
// reusing the exact same component/data functions the (never-wired-in)
// prior implementation already built.
export default async function BusinessProfilePage({ params }) {
  const { id } = await params
  const { client } = await getClientWithRuns(id)
  const profile = await getClientIndustryProfile(id)

  return (
    <div>
      <div className="section-label">
        <Link href={`/clients/${id}/settings`} style={{ color: 'inherit' }}>&larr; {client.name} Settings</Link>
      </div>
      <h1 style={{ marginBottom: 4 }}>Business Profile</h1>
      <p className="text-small text-muted" style={{ margin: '0 0 24px' }}>
        Shared Client / Industry Intelligence -- the canonical business-context input every pillar and Prompt &amp; Topic Intelligence reads from. Detected automatically first; correct here only by exception.
      </p>

      <ClientIntelligenceCard clientId={id} initialProfile={profile} />
    </div>
  )
}
