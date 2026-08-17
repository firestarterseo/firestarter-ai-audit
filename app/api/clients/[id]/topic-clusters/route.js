const { getTopicClustersWithVariations, getClientPromptTestingConfig } = require('../../../../../lib/topicClusters')
const { discoverTopicClusters, migrateLegacyTestPrompts } = require('../../../../../lib/promptTopicIntelligence')

// GET -> every topic cluster for this client, each with its nested
// prompt_variations, plus the effective testing-cadence config (real row
// or documented defaults). Mirrors app/api/clients/[id]/profile-fields/
// route.js's GET (a plain read, no orchestration).
async function GET(request, { params }) {
  const { id } = await params
  try {
    const clusters = await getTopicClustersWithVariations(id)
    const testingConfig = await getClientPromptTestingConfig(id)
    return Response.json({ clusters, testingConfig })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

// POST body: { action: 'discover' | 'migrate_legacy', dryRun? }
//
// 'discover' -- runs one bounded discovery pass (business-context read +
// Ahrefs supporting evidence + one forced-tool-use Anthropic call),
// producing new status='candidate' clusters/variations. dryRun (default
// true here, unlike Phase 1b's classify route which defaults dryRun to
// false) previews the proposed benchmark without writing anything --
// matching the spec's explicit "as a dry-run/candidate generation first"
// instruction for real-client validation. The AM Review UI's "Discover
// topics" button passes dryRun:false once an AM is ready to actually
// generate reviewable candidates.
//
// 'migrate_legacy' -- one-time (idempotent) migration of this client's
// existing clients.test_prompts into a single legacy-migrated candidate
// cluster. Always a real write (no dryRun concept -- it's a mechanical
// carry-over of already-existing data, not a judgment call to preview).
//
// maxDuration: discovery does at most 1 Ahrefs call + 1 Anthropic call
// (same bounded-external-calls shape as Phase 1b's classify route) --
// generous but well under audit/route.js's 120s ceiling.
const maxDuration = 60

async function POST(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const { action } = body

  try {
    if (action === 'discover') {
      const dryRun = body.dryRun !== false
      const result = await discoverTopicClusters(id, { dryRun })
      return Response.json(result)
    } else if (action === 'migrate_legacy') {
      const result = await migrateLegacyTestPrompts(id)
      return Response.json(result)
    } else {
      return Response.json({ error: `Unknown action "${action}".` }, { status: 400 })
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

module.exports = { GET, POST, maxDuration }
