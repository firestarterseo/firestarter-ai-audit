// Phase 1.1 (2026-09-01) -- getSourceLandscape enrichment tests. Plain
// Node, mocks lib/supabaseServer.js (require.cache injection, same
// technique as the other Phase 1/1.1 mocked tests) and calls the REAL
// getSourceLandscape() from lib/sourceCitation.js. Proves two things the
// Phase 1.1 closure pass added:
//   1. every returned opportunity carries priorityDimensions/statusTrack/
//      preparedWork (previously missing -- see the corrected header
//      comment in app/clients/[id]/SourceCitationWizard.js);
//   2. prepared work is fetched with exactly ONE batched query across
//      every opportunity, never one query per opportunity (no N+1).
// NO live Supabase connection is opened or required. Run with:
//   node lib/sourceCitation.landscapeEnrichment.test.js
// or:
//   npm run test:source-citation-landscape-enrichment

const assert = require('assert')

const supabaseServerPath = require.resolve('./supabaseServer')

const CLIENT_SOURCES_TABLE = 'client_sources'
const OPPORTUNITY_TABLE = 'opportunities'
const PREPARED_WORK_TABLE = 'opportunity_prepared_work'

let sourcesRows = []
let opportunityRows = []
let preparedWorkRows = []
const preparedWorkInCalls = []

function chainResolving(data, { onIn } = {}) {
  const result = { data, error: null }
  const obj = {
    eq: () => obj,
    order: () => obj,
    in: (_col, ids) => { if (onIn) onIn(ids); return obj },
    then: (resolve) => resolve(result)
  }
  return obj
}

// Any table this test doesn't explicitly model (ai_visibility_tracked_runs,
// client_competitors, topic_clusters -- all read inside
// analyzeOwnSiteCitationsForClient) resolves to an error. getSourceLandscape
// wraps that call in `.catch(() => null)`, so this is expected to degrade
// ownSiteCitations to null rather than crash the whole read -- exercised
// explicitly in testGracefullyDegradesWhenOwnSiteCitationsUnavailable below.
function alwaysErrorChain(tableName) {
  const err = { data: null, error: new Error(`fake supabase: "${tableName}" not modeled in this test`) }
  const obj = {
    select: () => obj,
    eq: () => obj,
    order: () => obj,
    in: () => obj,
    then: (resolve) => resolve(err)
  }
  return obj
}

function fakeSupabase() {
  return {
    from(table) {
      if (table === CLIENT_SOURCES_TABLE) return { select: () => chainResolving(sourcesRows) }
      if (table === OPPORTUNITY_TABLE) return { select: () => chainResolving(opportunityRows) }
      if (table === PREPARED_WORK_TABLE) {
        return { select: () => chainResolving(preparedWorkRows, { onIn: (ids) => preparedWorkInCalls.push(ids) }) }
      }
      return alwaysErrorChain(table)
    }
  }
}

require.cache[supabaseServerPath] = {
  id: supabaseServerPath, filename: supabaseServerPath, loaded: true,
  exports: { getSupabaseServerClient: () => fakeSupabase() }
}

const { getSourceLandscape } = require('./sourceCitation')

function reset({ sources = [], opportunities = [], preparedWork = [] }) {
  sourcesRows = sources
  opportunityRows = opportunities
  preparedWorkRows = preparedWork
  preparedWorkInCalls.length = 0
}

function log(msg) { console.log(msg) }

async function testOpportunitiesCarryPriorityDimensionsStatusTrackPreparedWork() {
  reset({
    opportunities: [
      { id: 'opp-1', client_id: 'c1', pillar: 'ai_source_citation_presence', priority_treatment: 'highest_impact', status: 'open', execution_capability: 'red', approval_status: 'pending', execution_status: 'not_started', verification_status: 'not_ready', retest_status: 'not_eligible' },
      { id: 'opp-2', client_id: 'c1', pillar: 'ai_source_citation_presence', priority_treatment: 'easy_win', status: 'open', execution_capability: 'red', approval_status: 'approved', execution_status: 'human_completed', verification_status: 'not_ready', retest_status: 'not_eligible' }
    ],
    preparedWork: [
      { id: 'pw-1', opportunity_id: 'opp-1', artifact_type: 'directory_profile_update', version: 1, status: 'ready_for_review' },
      { id: 'pw-2', opportunity_id: 'opp-2', artifact_type: 'outreach_pitch', version: 1, status: 'approved' },
      { id: 'pw-3', opportunity_id: 'opp-2', artifact_type: 'outreach_pitch', version: 2, status: 'ready_for_review' }
    ]
  })

  const landscape = await getSourceLandscape('c1')
  assert.strictEqual(landscape.opportunities.length, 2)

  const opp1 = landscape.opportunities.find(o => o.id === 'opp-1')
  const opp2 = landscape.opportunities.find(o => o.id === 'opp-2')

  // priorityDimensions -- real, derived object, not undefined
  assert.ok(opp1.priorityDimensions && typeof opp1.priorityDimensions === 'object')
  assert.ok('impact' in opp1.priorityDimensions && 'automation_capability' in opp1.priorityDimensions)
  assert.strictEqual(opp1.priorityDimensions.automation_capability.level, 'red')

  // statusTrack -- real, derived array, not undefined
  assert.ok(Array.isArray(opp1.statusTrack) && opp1.statusTrack.length > 0)
  const opp2ByStage = Object.fromEntries(opp2.statusTrack.map(s => [s.stage, s.state]))
  assert.strictEqual(opp2ByStage.executed_or_handed_off, 'completed', 'opp-2 is human_completed -- executed_or_handed_off must show completed')

  // preparedWork -- correctly grouped per opportunity, not fabricated/merged across opportunities
  assert.strictEqual(opp1.preparedWork.length, 1)
  assert.strictEqual(opp1.preparedWork[0].id, 'pw-1')
  assert.strictEqual(opp2.preparedWork.length, 2)
  assert.deepStrictEqual(opp2.preparedWork.map(pw => pw.id).sort(), ['pw-2', 'pw-3'])

  log('TEST (every opportunity from getSourceLandscape carries real priorityDimensions/statusTrack/preparedWork, correctly grouped per opportunity) PASSED')
}

async function testPreparedWorkIsOneBatchedQueryNotN() {
  reset({
    opportunities: [
      { id: 'opp-a', client_id: 'c1', pillar: 'ai_source_citation_presence', status: 'open' },
      { id: 'opp-b', client_id: 'c1', pillar: 'ai_source_citation_presence', status: 'open' },
      { id: 'opp-c', client_id: 'c1', pillar: 'ai_source_citation_presence', status: 'open' }
    ],
    preparedWork: []
  })

  await getSourceLandscape('c1')

  assert.strictEqual(preparedWorkInCalls.length, 1, `expected exactly ONE batched prepared-work query for 3 opportunities, got ${preparedWorkInCalls.length} (N+1 regression)`)
  assert.deepStrictEqual(preparedWorkInCalls[0].sort(), ['opp-a', 'opp-b', 'opp-c'])

  log('TEST (prepared work for every opportunity is fetched in exactly one batched query, never one query per opportunity) PASSED')
}

async function testNoOpportunitiesSkipsThePreparedWorkQueryEntirely() {
  reset({ opportunities: [], preparedWork: [] })
  const landscape = await getSourceLandscape('c1')
  assert.strictEqual(landscape.opportunities.length, 0)
  assert.strictEqual(preparedWorkInCalls.length, 0, 'no opportunities -- the prepared-work batch query should not even run')
  log('TEST (a client with zero Source & Citation opportunities never issues a prepared-work query at all) PASSED')
}

async function testGracefullyDegradesWhenOwnSiteCitationsUnavailable() {
  reset({ opportunities: [{ id: 'opp-1', client_id: 'c1', pillar: 'ai_source_citation_presence', status: 'open' }], preparedWork: [] })
  const landscape = await getSourceLandscape('c1')
  // ai_visibility_tracked_runs/client_competitors/topic_clusters are not
  // modeled in this test's fake -- analyzeOwnSiteCitationsForClient must
  // fail, and getSourceLandscape's own .catch(() => null) must still let
  // the rest of the landscape (including the new enrichment) return.
  assert.strictEqual(landscape.ownSiteCitations, null)
  assert.strictEqual(landscape.opportunities.length, 1)
  assert.ok(landscape.opportunities[0].priorityDimensions)
  log('TEST (an unavailable own-site-citations read degrades to null without breaking opportunity enrichment) PASSED')
}

async function main() {
  await testOpportunitiesCarryPriorityDimensionsStatusTrackPreparedWork()
  await testPreparedWorkIsOneBatchedQueryNotN()
  await testNoOpportunitiesSkipsThePreparedWorkQueryEntirely()
  await testGracefullyDegradesWhenOwnSiteCitationsUnavailable()
  log('\nAll getSourceLandscape enrichment tests passed (mocked Supabase, no live DB required).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
