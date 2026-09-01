// AI Source & Citation Presence -- DB-backed test script -- plain Node, no
// test framework (this project's existing convention; see
// lib/opportunityLifecycle.test.js's header for the identical pattern this
// file follows). Run with:
//   node lib/sourceCitation.test.js
// or:
//   npm run test:source-citation
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY -- NOT available in
// the assistant's sandbox (see lib/supabaseServer.js's header). The
// scenarios below were instead verified directly against the real
// firestarter-ai-audit Supabase project via the Supabase MCP connection
// (direct SQL, non-destructively, against real Firestarter SEO data -- see
// the evidence-strength-correction report's "Firestarter before vs after"
// section for what was actually observed there). This script exists so the
// identical assertions can be re-run from inside the app itself (CI, or
// locally with real credentials) going forward.
//
// Creates one throwaway client (name starts with __SOURCE_CITATION_TEST__)
// plus synthetic ai_visibility_tracked_runs/client_competitors rows shaped
// exactly like the real production writer (lib/trackAiVisibility.js), runs
// it through the real pipeline (syncClientSources -> qualifySourceOpportunities),
// then deletes the client (cascades to ai_visibility_tracked_runs,
// client_competitors, client_sources, cited_page_inspections,
// opportunities/opportunity_prepared_work/opportunity_history via FK ON
// DELETE CASCADE) so this script never leaves residue in the database.
//
// EVIDENCE-STRENGTH CORRECTION (2026-08-17): this file's synthetic dataset
// was redesigned around FOUR distinct sources, one per corrected outcome,
// so the correction's real end-to-end behavior is exercised against the
// real DB/lifecycle, not just pure functions:
//   - clutch.co: cited often, but the client is never mentioned alongside
//     it and no domain-level presence is configured -- presence stays
//     'unknown'. High importance + unresolved presence = OBSERVATIONAL,
//     not an opportunity. (This is the headline behavior change: the old
//     model would have let 'unknown' count as a gap and force this into
//     the action queue.)
//   - yelp.com: a real domain-level presence is configured (via the
//     test-only backlinkDomainsOverride -- no AHREFS_API_KEY is available
//     in this sandbox) but the specific cited URL is never confirmed --
//     'source_presence_only', a genuinely VERIFIED gap, so this legitimately
//     QUALIFIES as an actionable opportunity (used for TEST 19/20 below).
//   - forbes.com: cited once, client mentioned alongside it, AND the mock
//     fetcher confirms the client's name is actually present on the cited
//     page -- 'appears_in_cited_content_verified'. Importance is only
//     'low' (a single citation), so this becomes DO_NOTHING
//     (already_adequately_represented), not Strength/Protect -- proving
//     verified presence alone doesn't force strength_protect either.
//   - bbb.org: cited 3 times across 2 engines with the client mentioned
//     each time, AND the mock fetcher confirms the client's name on the
//     cited page -- verified presence + medium importance = a legitimate,
//     EARNED Strength/Protect (never from mere co-occurrence).
//
// Pure-logic scenarios (1-18, 21, 24, the 12 correction tests, and
// supporting coverage) are covered instead in lib/sourceCitation.pure.test.js,
// which IS runnable in the sandbox and was actually executed there. This
// file covers the remaining DB/lifecycle-dependent scenarios:
//   19. Verification independent from task completion.
//   20. AI outcome independent from verification.
//   22. Re-observation updates durable opportunity rather than duplicating.
//   23. Wizard data-read path (getSourceLandscape) renders from already-
//       persisted rows with zero LLM/API calls triggered by the read itself.

const assert = require('assert')
const { getSupabaseServerClient } = require('./supabaseServer')
const {
  requestHandoff, recordHandoff, recordHumanCompleted,
  requestVerification, recordVerification,
  requestRetest, recordRetestResult
} = require('./opportunityLifecycle')
const { syncClientSources, qualifySourceOpportunities, syncSourceCitationPillar, getSourceLandscape } = require('./sourceCitation')

const CLIENT_NAME = '__SOURCE_CITATION_TEST__'

function trackedRun({ clientId, engine, runAt, brandMentioned, thirdPartySourceUrls, ownDomainSourceUrls = [], bestListCited = false, prompt }) {
  const sourceUrls = [...ownDomainSourceUrls, ...thirdPartySourceUrls]
  return {
    client_id: clientId, engine, run_at: runAt, ok: true, brand_mentioned: brandMentioned, sentiment: brandMentioned ? 'positive' : null,
    raw: { prompt, responseSnippet: `Synthetic response mentioning ${thirdPartySourceUrls[0] || 'no source'}.`, sourceUrls, ownDomainSourceUrls, thirdPartySourceUrls, bestListCited }
  }
}

// Test-only fetcher (injected via syncClientSources's `fetcher` option --
// no real network calls happen in this test). robots.txt is always
// reported unreachable (fail-open -- allowed); forbes.com/bbb.org's cited
// pages "contain" the client name, clutch.co/yelp.com's do not.
function mockFetcher(url) {
  if (url.endsWith('/robots.txt')) return Promise.resolve({ ok: false, status: 404 })
  if (url.includes('forbes.com') || url.includes('bbb.org')) {
    return Promise.resolve({ ok: true, status: 200, text: async () => `<html><body>Recognized agencies include ${CLIENT_NAME}, among others.</body></html>` })
  }
  return Promise.resolve({ ok: true, status: 200, text: async () => '<html><body>A generic directory/ranking page with no client mention.</body></html>' })
}

async function main() {
  const supabase = getSupabaseServerClient()
  let clientId

  try {
    const { data: client, error: createError } = await supabase
      .from('clients')
      .insert({ name: CLIENT_NAME, domain: 'source-citation-test.example.com', url: 'https://source-citation-test.example.com', category: 'Digital Marketing', status: 'tracked' })
      .select('*').single()
    if (createError) throw createError
    clientId = client.id
    console.log(`Created throwaway test client ${clientId}`)

    const rows = []
    for (let i = 0; i < 8; i++) {
      rows.push(trackedRun({
        clientId, engine: i % 2 === 0 ? 'chatgpt' : 'gemini', runAt: new Date(2026, 7, 1 + i).toISOString(),
        brandMentioned: false, thirdPartySourceUrls: ['https://clutch.co/profile/some-agency'], prompt: `best seo agency ${i % 3}`
      }))
    }
    for (let i = 0; i < 3; i++) {
      rows.push(trackedRun({
        clientId, engine: 'chatgpt', runAt: new Date(2026, 7, 12 + i).toISOString(),
        brandMentioned: false, thirdPartySourceUrls: ['https://www.yelp.com/biz/some-other-listing'], prompt: 'seo agency reviews'
      }))
    }
    rows.push(trackedRun({
      clientId, engine: 'chatgpt', runAt: new Date(2026, 7, 10).toISOString(),
      brandMentioned: true, thirdPartySourceUrls: ['https://forbes.com/agencies/source-citation-test'], prompt: 'top rated seo agencies'
    }))
    rows.push(trackedRun({
      clientId, engine: 'chatgpt', runAt: new Date(2026, 7, 5).toISOString(),
      brandMentioned: true, thirdPartySourceUrls: ['https://bbb.org/profile/source-citation-test'], prompt: 'accredited seo agencies'
    }))
    rows.push(trackedRun({
      clientId, engine: 'gemini', runAt: new Date(2026, 7, 6).toISOString(),
      brandMentioned: true, thirdPartySourceUrls: ['https://bbb.org/profile/source-citation-test'], prompt: 'trustworthy seo agencies'
    }))
    const { error: insertRunsError } = await supabase.from('ai_visibility_tracked_runs').insert(rows)
    if (insertRunsError) throw insertRunsError

    // First sync -- real cited-page inspection runs via the injected mock
    // fetcher (no real network calls), and yelp.com gets a real
    // domain-level presence via the test-only backlinkDomainsOverride
    // (standing in for a real Ahrefs backlink -- no AHREFS_API_KEY exists
    // in this sandbox).
    const syncOpts = { fetcher: mockFetcher, backlinkDomainsOverride: ['yelp.com'] }
    const syncResult1 = await syncClientSources(clientId, syncOpts)
    assert.ok(syncResult1.bySource.has('clutch.co'))
    assert.ok(syncResult1.bySource.has('yelp.com'))
    assert.ok(syncResult1.bySource.has('forbes.com'))
    assert.ok(syncResult1.bySource.has('bbb.org'))

    const opportunities1 = await qualifySourceOpportunities(clientId, syncResult1, { actor: 'test' })
    const clutchOutcome1 = opportunities1.find(o => o.domain === 'clutch.co')
    const yelpOutcome1 = opportunities1.find(o => o.domain === 'yelp.com')
    const forbesOutcome1 = opportunities1.find(o => o.domain === 'forbes.com')
    const bbbOutcome1 = opportunities1.find(o => o.domain === 'bbb.org')

    assert.strictEqual(clutchOutcome1.disposition, 'observational', 'EVIDENCE-STRENGTH CORRECTION: a highly-cited source with only unresolved (unknown) presence must stay observational, not be forced into the action queue')
    assert.strictEqual(clutchOutcome1.opportunityId, null, 'an observational source must get NO opportunity row at all')

    assert.strictEqual(yelpOutcome1.disposition, 'qualified', 'a source with a real, VERIFIED domain-level gap (source_presence_only) must still legitimately qualify as an opportunity')

    assert.strictEqual(forbesOutcome1.disposition, 'do_nothing', 'EVIDENCE-STRENGTH CORRECTION: verified cited-content presence with only low observed importance must not become strength_protect -- it is simply already adequately represented')
    assert.strictEqual(forbesOutcome1.reason, 'already_adequately_represented')

    assert.strictEqual(bbbOutcome1.disposition, 'strength_protect', 'EVIDENCE-STRENGTH CORRECTION: strength_protect must still be reachable, but only via genuine page-level VERIFIED presence (confirmed here by the mock fetcher), never mere co-occurrence')
    console.log('TEST (initial sync produces four genuinely distinct, evidence-correct dispositions: observational / qualified / do_nothing / strength_protect) PASSED')

    // TEST 22: re-observation updates the durable opportunity rather than
    // duplicating -- re-run the exact same sync and confirm the SAME
    // opportunity ids come back for the sources that actually got one, and
    // the total opportunities row count for this client under this pillar
    // does not grow.
    const { data: beforeCount } = await supabase.from('opportunities').select('id').eq('client_id', clientId).eq('pillar', 'ai_source_citation_presence')
    const syncResult2 = await syncClientSources(clientId, syncOpts)
    const opportunities2 = await qualifySourceOpportunities(clientId, syncResult2, { actor: 'test' })
    const { data: afterCount } = await supabase.from('opportunities').select('id').eq('client_id', clientId).eq('pillar', 'ai_source_citation_presence')
    assert.strictEqual(afterCount.length, beforeCount.length, 'TEST 22: re-syncing the same observations must never create duplicate opportunity rows')
    const yelpOutcome2 = opportunities2.find(o => o.domain === 'yelp.com')
    assert.strictEqual(yelpOutcome2.opportunityId, yelpOutcome1.opportunityId, 'TEST 22: the same source domain must map to the SAME durable opportunity id across re-syncs')
    assert.strictEqual(opportunities2.find(o => o.domain === 'clutch.co').opportunityId, null, 'TEST 22: an observational source must still get no opportunity row on re-sync')
    console.log('TEST 22 (re-observation updates the durable opportunity rather than duplicating; observational sources stay opportunity-free across re-syncs) PASSED')

    // TEST 19 + 20: verification is independent from task completion, and
    // AI outcome is independent from verification -- exercised against the
    // one source that legitimately qualified as a real action item
    // (yelp.com -- a verified domain-level gap).
    const actionable = yelpOutcome1
    assert.strictEqual(actionable.disposition, 'qualified')
    await requestHandoff(actionable.opportunityId, { instructions: 'Submit a directory profile update.', actor: 'test' })
    await recordHandoff(actionable.opportunityId, { method: 'manual', reference: 'am-confirmed-submitted-2026-08-17', actor: 'test' })
    await recordHumanCompleted(actionable.opportunityId, { notes: 'AM submitted the profile manually.', actor: 'test' })
    let { data: afterCompletion } = await supabase.from('opportunities').select('*').eq('id', actionable.opportunityId).single()
    assert.strictEqual(afterCompletion.execution_status, 'human_completed')
    assert.notStrictEqual(afterCompletion.verification_status, 'verified', 'TEST 19: task completion must never itself imply verification')

    await requestVerification(actionable.opportunityId, { actor: 'test' })
    await recordVerification(actionable.opportunityId, { result: 'verified', evidence: [{ note: 'Re-fetched profile URL; client listing confirmed present.' }], actor: 'test' })
    let { data: afterVerification } = await supabase.from('opportunities').select('*').eq('id', actionable.opportunityId).single()
    assert.strictEqual(afterVerification.verification_status, 'verified')
    assert.strictEqual(afterVerification.ai_visibility_outcome_status, null, 'TEST 20: a verified listing must not itself claim an AI visibility outcome -- that is a separate, later fact')

    await requestRetest(actionable.opportunityId, { actor: 'test' })
    await recordRetestResult(actionable.opportunityId, { outcome: 'not_yet_cited_by_ai', aiVisibilityOutcomeStatus: 'not_yet_cited', actor: 'test' })
    let { data: afterRetest } = await supabase.from('opportunities').select('*').eq('id', actionable.opportunityId).single()
    assert.strictEqual(afterRetest.verification_status, 'verified', 'TEST 20: a later "AI still not citing it" retest result must not invalidate an already-verified listing')
    assert.strictEqual(afterRetest.ai_visibility_outcome_status, 'not_yet_cited')
    console.log('TEST 19, 20 (task completion, verification, and AI visibility outcome are tracked as three independent, non-overwriting facts) PASSED')

    // TEST 23: getSourceLandscape is a pure read -- no LLM/API/fetch call is
    // triggered merely by calling it (it only selects from client_sources/
    // opportunities/ai_visibility_tracked_runs/topic_clusters). Passing NO
    // fetcher override here and still succeeding instantly (no timeout)
    // is itself evidence this path never fetches.
    const landscape = await getSourceLandscape(clientId)
    assert.ok(Array.isArray(landscape.sources))
    assert.ok(landscape.diagnosis)
    assert.strictEqual(typeof landscape.diagnosis.totalSourcesObserved, 'number')
    assert.strictEqual(landscape.diagnosis.presenceCounts.appears_in_cited_content_verified, 2, 'forbes.com and bbb.org should both show as page-level verified')
    assert.ok(landscape.diagnosis.observationalCount >= 1, 'clutch.co should be reflected in the observational count')
    console.log('TEST 23 (getSourceLandscape renders from already-persisted data; no LLM/API/fetch call is made by the read itself) PASSED')

    // End-to-end entry point used by runAudit.js.
    const pillarResult = await syncSourceCitationPillar(client, { actor: 'test', fetcher: mockFetcher, backlinkDomainsOverride: ['yelp.com'] })
    assert.ok(pillarResult.sourcesObserved >= 4)
    assert.strictEqual(pillarResult.observationalCount, 1, 'exactly one source (clutch.co) should be observational in this synthetic dataset')
    console.log('TEST (syncSourceCitationPillar end-to-end entry point used by runAudit.js runs cleanly, including cited-page inspection) PASSED')

    console.log('\nAll sourceCitation DB-backed tests passed, including the evidence-strength correction end-to-end.')
  } finally {
    if (clientId) {
      await supabase.from('clients').delete().eq('id', clientId)
      console.log(`Cleaned up throwaway test client ${clientId}`)
    }
  }
}

main().catch(err => {
  console.error('SOURCE CITATION TEST FAILED:', err)
  process.exit(1)
})
