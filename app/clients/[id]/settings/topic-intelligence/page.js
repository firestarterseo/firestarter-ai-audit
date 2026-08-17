import Link from 'next/link'
import { getClientWithRuns } from '../../../../../lib/data'
import { getClientIndustryProfile } from '../../../../../lib/clientIndustryIntelligence'
import { getTopicClustersWithVariations } from '../../../../../lib/topicClusters'
import TopicClusterReview from '../../TopicClusterReview'

export const dynamic = 'force-dynamic'

// Client Settings -> Topic & Prompt Intelligence (Phase 2).
//
// Same placement rationale as Business Profile (see the
// settings/business-profile page's header comment, added the same day):
// Topic & Prompt Intelligence is SHARED intelligence other things read from
// (the AI & GEO Visibility pillar's prompt testing, going forward) -- "this
// is shared intelligence, not another scored pillar" is the Phase 2 spec's
// own words for exactly this reason. It gets its own persistent Client
// Settings location instead of a big card bolted onto the top of the
// pillar/audit page, so Phase 2's AM review UI follows the same pattern
// Business Profile was just corrected to use, rather than the pattern that
// correction was moving away from.
//
// The main client page (app/clients/[id]/page.js) shows only a compact
// read-only summary + link back here -- it does not render
// TopicClusterReview itself.
export default async function TopicIntelligencePage({ params }) {
  const { id } = await params
  const { client } = await getClientWithRuns(id)
  const profile = await getClientIndustryProfile(id)
  const clusters = await getTopicClustersWithVariations(id)

  return (
    <div>
      <div className="section-label">
        <Link href={`/clients/${id}/settings`} style={{ color: 'inherit' }}>&larr; {client.name} Settings</Link>
      </div>
      <h1 style={{ marginBottom: 4 }}>Topic &amp; Prompt Intelligence</h1>
      <p className="text-small text-muted" style={{ margin: '0 0 24px' }}>
        What commercially meaningful questions to track for this client across AI engines -- topic clusters with controlled prompt variations, not a keyword list. Recommended automatically from{' '}
        <Link href={`/clients/${id}/settings/business-profile`}>the confirmed Business Profile</Link>; nothing enters the benchmark without your approval.
      </p>

      <TopicClusterReview clientId={id} initialClusters={clusters} hasBusinessProfile={!!profile.hasAnyProfileData} />
    </div>
  )
}
