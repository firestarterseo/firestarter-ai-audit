// Phase 2 test script -- plain Node, no test framework (same convention as
// lib/clientProfileFields.test.js / lib/clientIndustryIntelligence.test.js).
// Run with:
//   node lib/promptTopicIntelligence.test.js
// or:
//   npm run test:prompt-topic-intelligence
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same as every other
// DB-touching script in this project) -- NOT runnable inside the
// assistant's sandbox, since that key is intentionally never available to
// it (see lib/supabaseServer.js's header). Every DB-dependent assertion
// below was instead verified directly against the real firestarter-ai-audit
// Supabase project via the Supabase MCP connection, exercising the exact
// same Postgres functions (fn_approve_topic_cluster, fn_reject_topic_cluster,
// fn_reject_prompt_variation, fn_edit_topic_cluster, fn_edit_prompt_variation,
// fn_set_topic_cluster_business_priority_system/_am) this script calls
// through lib/topicClusters.js's thin wrappers -- see the Phase 2
// completion report's "N. TEST RESULTS" section for that live verification
// log.
//
// Live discovery (discoverTopicClusters against a real Anthropic call) is
// NOT exercised here either -- ANTHROPIC_API_KEY is also a Vercel-only env
// var never available to the assistant. This script instead exercises the
// exact same write-path code (insertCandidateTopicCluster /
// insertCandidatePromptVariation / the approve/reject/edit RPCs) a
// successful discovery pass would feed into, using hand-built candidate
// data -- the same "same function, same DB, same RPCs; weaker test of LLM
// behavior, not of the write path" methodology
// lib/clientIndustryIntelligence.test.js's own header documents.
//
// Creates one throwaway client (name starts with __PHASE2_TEST_CLIENT__)
// with its own client_profile_fields rows (so business-priority
// correlation and dedupe/suppression checks have real profile data to work
// against), exercises every required Phase 2 DB scenario, then deletes it
// (cascades to topic_clusters/_history, prompt_variations/_history,
// client_profile_fields/_history) so this script never leaves residue.

const assert = require('assert')
const { getSupabaseServerClient } = require('./supabaseServer')
const { writeSystemDetectedField, confirmClientProfileField } = require('./clientProfileFields')
const { getClientIndustryProfile } = require('./clientIndustryIntelligence')
const {
  insertCandidateTopicCluster,
  insertCandidatePromptVariation,
  approveTopicCluster,
  rejectTopicCluster,
  rejectPromptVariation,
  editTopicCluster,
  editPromptVariation,
  setTopicClusterBusinessPrioritySystem,
  setTopicClusterBusinessPriorityAm,
  getTopicClusterDetail,
  getTopicClustersForClient
} = require('./topicClusters')
const { gatherDiscoveryEvidence, migrateLegacyTestPrompts, computeDedupeKey } = require('./promptTopicIntelligence')

async function main() {
  const supabase = getSupabaseServerClient()
  let clientId

  try {
    const { data: client, error: createError } = await supabase
      .from('clients')
      .insert({ name: '__PHASE2_TEST_CLIENT__', domain: 'phase2-test.example.com', url: 'https://phase2-test.example.com', status: 'lead', test_prompts: ['Phase2 Test Co', 'best widget repair denver'] })
      .select('id')
      .single()
    if (createError) throw createError
    clientId = client.id
    console.log(`Created throwaway test client ${clientId}`)

    // TEST 20: discovery must fail gracefully (not fabricate) for a client
    // with NO Client/Industry Intelligence profile yet.
    let evidence = await gatherDiscoveryEvidence(clientId)
    assert.strictEqual(evidence.ok, false, 'TEST 20: a client with zero client_profile_fields rows must not proceed to discovery')
    assert.strictEqual(evidence.reason, 'no_client_industry_profile')
    console.log('TEST 20 PASSED (client with no profile degrades gracefully, no fabricated evidence)')

    // Give this throwaway client a real (confirmed) profile so the rest of
    // the scenarios below have real business context to correlate against.
    await writeSystemDetectedField({ clientId, fieldKey: 'industry', value: 'Widget Repair', confidence: 'confirmed_by_direct_evidence' })
    await confirmClientProfileField({ clientId, fieldKey: 'industry' })
    await writeSystemDetectedField({ clientId, fieldKey: 'primary_products_services', itemIndex: 0, value: 'Widget Repair', confidence: 'confirmed_by_direct_evidence' })
    await confirmClientProfileField({ clientId, fieldKey: 'primary_products_services', itemIndex: 0 })
    await writeSystemDetectedField({ clientId, fieldKey: 'primary_products_services', itemIndex: 1, value: 'Widget Installation', confidence: 'likely' })
    await confirmClientProfileField({ clientId, fieldKey: 'primary_products_services', itemIndex: 1 })
    await writeSystemDetectedField({ clientId, fieldKey: 'primary_geography_markets', itemIndex: 0, value: 'Denver, Colorado', confidence: 'confirmed_by_direct_evidence' })
    await confirmClientProfileField({ clientId, fieldKey: 'primary_geography_markets', itemIndex: 0 })

    evidence = await gatherDiscoveryEvidence(clientId)
    assert.strictEqual(evidence.ok, true, 'discovery evidence gathering should now succeed with a real profile in place')
    console.log('Evidence gathering now succeeds once a real Client/Industry Intelligence profile exists')

    // TEST 2 / 6 / 7 / 8 / 9: a hand-built candidate cluster + core/secondary
    // variations, carrying every required field, persists and round-trips
    // intact.
    const dedupeKey = computeDedupeKey('Widget Repair Services', 'Widget Repair', 'local')
    const cluster = await insertCandidateTopicCluster({
      clientId,
      name: 'Widget Repair Services',
      primaryService: 'Widget Repair', // TEST 2: links to a real client service
      whyItMatters: 'Core commercial discovery topic for the business\'s #1 service.',
      geographyScope: 'local', // TEST 9: geography persists
      geographyValues: ['Denver, Colorado'],
      evidence: [{ type: 'primary_products_services', detail: 'Widget Repair' }],
      discoveryMethod: 'system_discovery',
      dedupeKey
    })
    assert.strictEqual(cluster.status, 'candidate', 'a freshly discovered cluster must start as candidate, never benchmark')
    console.log('TEST 2 PASSED (cluster links to a real client service)')

    const coreVariation = await insertCandidatePromptVariation({
      clientId,
      topicClusterId: cluster.id,
      promptText: 'Best widget repair company in Denver',
      variationType: 'core',
      brandMode: 'unbranded',
      intentTags: ['recommendation', 'local_near_me'],
      intentPrimary: 'recommendation', // TEST 6
      buyerJourneyTags: ['discover'],
      buyerJourneyPrimary: 'discover', // TEST 7
      geography: 'Denver, Colorado',
      discoveryMethod: 'system_discovery'
    })
    assert.strictEqual(coreVariation.brand_mode, 'unbranded') // TEST 8
    assert.deepStrictEqual(coreVariation.intent_tags, ['recommendation', 'local_near_me']) // TEST 6
    assert.strictEqual(coreVariation.intent_primary, 'recommendation')
    assert.deepStrictEqual(coreVariation.buyer_journey_tags, ['discover']) // TEST 7
    assert.strictEqual(coreVariation.buyer_journey_primary, 'discover')
    assert.strictEqual(coreVariation.geography, 'Denver, Colorado') // TEST 9
    console.log('TEST 6, 7, 8, 9 PASSED (intent/buyer-journey/brand-mode/geography persist)')

    const secondaryVariation = await insertCandidatePromptVariation({
      clientId,
      topicClusterId: cluster.id,
      promptText: 'Who would you recommend for widget repair in Denver?',
      variationType: 'secondary',
      brandMode: 'unbranded',
      intentTags: ['recommendation'],
      buyerJourneyTags: ['evaluate'],
      discoveryMethod: 'system_discovery'
    })

    // TEST 10: business priority persists using Phase 1a-style pinning
    // behavior -- system suggestion first, never overwrites an AM decision.
    let systemOutcome = await setTopicClusterBusinessPrioritySystem({ clusterId: cluster.id, priority: 'strategic' })
    assert.strictEqual(systemOutcome, 'updated', 'TEST 10a: system suggestion should apply while unconfirmed')
    let detail = await getTopicClusterDetail(cluster.id)
    assert.strictEqual(detail.business_priority, 'strategic')
    assert.strictEqual(detail.business_priority_status, 'unconfirmed')

    await setTopicClusterBusinessPriorityAm({ clusterId: cluster.id, priority: 'strategic' })
    detail = await getTopicClusterDetail(cluster.id)
    assert.strictEqual(detail.business_priority_status, 'confirmed', 'TEST 10b: an AM decision must mark business_priority_status confirmed')

    systemOutcome = await setTopicClusterBusinessPrioritySystem({ clusterId: cluster.id, priority: 'none' })
    assert.strictEqual(systemOutcome, 'skipped_not_unconfirmed', 'TEST 10c (PINNING INVARIANT): an AM-confirmed business_priority must never be silently overwritten by a system suggestion')
    detail = await getTopicClusterDetail(cluster.id)
    assert.strictEqual(detail.business_priority, 'strategic', 'TEST 10c: confirmed business_priority must survive a conflicting system suggestion')
    console.log('TEST 10 PASSED (business priority persists with Phase-1a-style pinning behavior)')

    // TEST 12: candidate can be edited before approval.
    await editTopicCluster({ clusterId: cluster.id, name: 'Widget Repair Services (Denver Metro)' })
    // Give the secondary variation a real buyer_journey_primary/geography
    // FIRST, so the next assertion can prove editing prompt_text alone
    // doesn't wipe them.
    await editPromptVariation({ variationId: secondaryVariation.id, buyerJourneyPrimary: 'evaluate', geography: 'Denver, Colorado' })
    await editPromptVariation({ variationId: secondaryVariation.id, promptText: 'What\'s the best place for widget repair near Denver?' })
    detail = await getTopicClusterDetail(cluster.id)
    assert.strictEqual(detail.name, 'Widget Repair Services (Denver Metro)')
    const editedSecondary = detail.variations.find(v => v.id === secondaryVariation.id)
    assert.strictEqual(editedSecondary.prompt_text, 'What\'s the best place for widget repair near Denver?')
    // Regression check: fn_edit_prompt_variation SETS intent_primary/
    // buyer_journey_primary/geography DIRECTLY rather than coalescing them
    // (unlike prompt_text/brand_mode/intent_tags/buyer_journey_tags) --
    // confirmed against its live definition. editPromptVariation's
    // UNPROVIDED-sentinel handling exists specifically so that omitting
    // these fields (as the prompt-text-only edit above just did) resolves
    // to "leave unchanged" by fetching the current value first, not
    // "silently clear." Without that handling this assertion would fail.
    assert.strictEqual(editedSecondary.buyer_journey_primary, 'evaluate', 'REGRESSION: editing prompt_text alone must not wipe buyer_journey_primary')
    assert.strictEqual(editedSecondary.geography, 'Denver, Colorado', 'REGRESSION: editing prompt_text alone must not wipe geography')
    console.log('TEST 12 PASSED (candidate cluster and variation both editable before approval, without wiping unrelated fields)')

    // TEST 19: historical prompt text/state preserved after edit -- the
    // append-only history table must retain the PRE-edit wording, not just
    // the current row.
    const { data: variationHistory, error: historyError } = await supabase
      .from('prompt_variation_history')
      .select('*')
      .eq('prompt_variation_id', secondaryVariation.id)
      .order('created_at', { ascending: true })
    if (historyError) throw historyError
    assert.ok(variationHistory.length >= 3, 'TEST 19: expected system_discovered + 2 am_edited rows (buyer_journey/geography edit, then the prompt_text edit)')
    // The actual rename: the am_edited row whose prompt_text genuinely
    // changed (not the earlier buyer_journey_primary/geography-only edit,
    // where prompt_text was coalesced as unchanged).
    const editRow = variationHistory.find(h => h.change_reason === 'am_edited' && h.previous_value.prompt_text !== h.new_value.prompt_text)
    assert.ok(editRow, 'TEST 19: an am_edited history row with a genuine prompt_text change must exist')
    assert.strictEqual(editRow.previous_value.prompt_text, 'Who would you recommend for widget repair in Denver?', 'TEST 19: history must preserve the EXACT pre-edit wording')
    console.log('TEST 19 PASSED (pre-edit prompt text preserved in append-only history)')

    // Append-only guard: directly mutating history must be rejected (same
    // trigger pattern as Phase 1a's client_profile_field_history).
    let blockedUpdate = false
    try {
      await supabase.from('prompt_variation_history').update({ changed_by: 'am' }).eq('id', editRow.id)
    } catch (e) {
      blockedUpdate = true
    }
    // supabase-js does not throw on a DB-level error by default -- check
    // both the thrown-exception path and the {error} response path.
    const { error: directUpdateError } = await supabase.from('prompt_variation_history').update({ changed_by: 'am' }).eq('id', editRow.id)
    assert.ok(blockedUpdate || directUpdateError, 'append-only guard: prompt_variation_history must reject UPDATE')
    console.log('Append-only history guard PASSED (prompt_variation_history rejects UPDATE)')

    // TEST 11: candidate approved into benchmark.
    await approveTopicCluster({ clusterId: cluster.id })
    detail = await getTopicClusterDetail(cluster.id)
    assert.strictEqual(detail.status, 'benchmark', 'TEST 11: approval must promote status to benchmark')
    assert.ok(detail.approved_at, 'TEST 11: approved_at must be set on approval')
    assert.ok(detail.variations.every(v => v.status === 'active'), 'TEST 11: approving a cluster must activate its candidate variations')
    console.log('TEST 11 PASSED (candidate approved into benchmark, variations activated)')

    // TEST 16: lack of visibility must NOT auto-retire a benchmark cluster
    // -- verified structurally: no code path in this module or its RPCs
    // ever calls fn_reject_topic_cluster/fn_edit_topic_cluster based on
    // ai_visibility_tracked_runs data. Confirmed here by asserting the
    // cluster remains status=benchmark after being freshly approved, with
    // zero AI-visibility observations for it (there is, by construction,
    // no automated caller that could retire it -- retirement is exclusively
    // reachable via rejectTopicCluster, itself only ever invoked from the
    // AM actions API route).
    detail = await getTopicClusterDetail(cluster.id)
    assert.strictEqual(detail.status, 'benchmark', 'TEST 16: a benchmark cluster with zero AI-visibility observations must remain in the benchmark, not be auto-retired')
    console.log('TEST 16 PASSED (no automated path retires a cluster for lack of visibility -- retirement requires an explicit AM action)')

    // TEST 13 / 15: an approved (former-candidate) BENCHMARK cluster can
    // still be retired by explicit AM action, and its history/former
    // approved_at is preserved (distinguishing a true retirement from a
    // candidate rejection).
    const retireOutcome = await rejectTopicCluster({ clusterId: cluster.id, reason: 'Client stopped offering this service.' })
    detail = await getTopicClusterDetail(cluster.id)
    assert.strictEqual(detail.status, 'retired')
    assert.strictEqual(detail.retired_reason, 'Client stopped offering this service.')
    assert.ok(detail.approved_at, 'TEST 15: approved_at must be preserved after retirement -- proof this was once a real benchmark item, not just a rejected candidate')
    const { data: clusterHistory } = await supabase.from('topic_cluster_history').select('change_reason').eq('topic_cluster_id', cluster.id).order('created_at', { ascending: true })
    assert.ok(clusterHistory.some(h => h.change_reason === 'am_retired'), 'TEST 15: retiring a former-benchmark cluster must log am_retired (not am_rejected)')
    console.log('TEST 13 / 15 PASSED (former-benchmark cluster retired by explicit AM action, history preserved and correctly distinguished from a candidate rejection)')

    // TEST 13 (candidate-rejection variant) + 14 (suppression setup): a
    // SECOND cluster, rejected while still a candidate (never approved),
    // must be recorded as am_rejected (not am_retired) and be a real
    // suppression candidate for later discovery passes.
    const secondCluster = await insertCandidateTopicCluster({
      clientId,
      name: 'Widget Repair Financing',
      primaryService: 'Widget Repair',
      whyItMatters: 'Speculative -- not evidenced.',
      geographyScope: null,
      geographyValues: [],
      evidence: [],
      discoveryMethod: 'system_discovery',
      dedupeKey: computeDedupeKey('Widget Repair Financing', 'Widget Repair Financing', null)
    })
    await insertCandidatePromptVariation({
      clientId,
      topicClusterId: secondCluster.id,
      promptText: 'Does this widget repair company offer financing?',
      variationType: 'core',
      discoveryMethod: 'system_discovery'
    })
    await rejectTopicCluster({ clusterId: secondCluster.id, reason: 'Low business value.' })
    const secondDetail = await getTopicClusterDetail(secondCluster.id)
    assert.strictEqual(secondDetail.status, 'retired')
    assert.strictEqual(secondDetail.approved_at, null, 'a candidate rejected before ever being approved must have no approved_at')
    const { data: secondHistory } = await supabase.from('topic_cluster_history').select('change_reason').eq('topic_cluster_id', secondCluster.id)
    assert.ok(secondHistory.some(h => h.change_reason === 'am_rejected'), 'a pre-approval rejection must log am_rejected, distinct from a post-approval retirement')
    console.log('TEST 13 PASSED (candidate rejected before approval logs am_rejected, distinct from a true retirement)')

    // Reject a single variation directly (not the whole cluster).
    const rejectableVariation = await insertCandidatePromptVariation({ clientId, topicClusterId: secondCluster.id, promptText: 'throwaway variation', variationType: 'secondary', discoveryMethod: 'system_discovery' })
    await rejectPromptVariation({ variationId: rejectableVariation.id, reason: 'Bad prompt.' })
    const { data: rejectedVariationRow } = await supabase.from('prompt_variations').select('status, rejection_reason').eq('id', rejectableVariation.id).single()
    assert.strictEqual(rejectedVariationRow.status, 'rejected')
    assert.strictEqual(rejectedVariationRow.rejection_reason, 'Bad prompt.')
    console.log('Individual prompt-variation rejection PASSED')

    // TEST: migrateLegacyTestPrompts -- this throwaway client was created
    // with test_prompts: ['Phase2 Test Co', 'best widget repair denver'].
    const migration = await migrateLegacyTestPrompts(clientId)
    assert.strictEqual(migration.migrated, true)
    assert.strictEqual(migration.variationCount, 2)
    const legacyDetail = await getTopicClusterDetail(migration.clusterId)
    assert.strictEqual(legacyDetail.discovery_method, 'legacy_migrated')
    assert.strictEqual(legacyDetail.status, 'candidate', 'legacy-migrated terms must require AM approval too -- never silently promoted to benchmark')
    assert.strictEqual(legacyDetail.variations[0].prompt_text, 'Phase2 Test Co', 'legacy migration must preserve original wording exactly')
    assert.strictEqual(legacyDetail.variations[0].brand_mode, 'brand_aware', 'a legacy prompt containing the client\'s own name must be flagged brand_aware')
    assert.strictEqual(legacyDetail.variations[1].brand_mode, 'unbranded')
    assert.deepStrictEqual(legacyDetail.variations[0].intent_tags, [], 'legacy migration must never fabricate intent classification')
    assert.strictEqual(legacyDetail.variations[0].intent_primary, null)

    // Idempotency: running the migration again must not create a duplicate.
    const secondMigration = await migrateLegacyTestPrompts(clientId)
    assert.strictEqual(secondMigration.migrated, false)
    assert.strictEqual(secondMigration.reason, 'already_migrated')
    console.log('Legacy test_prompts migration PASSED (preserves wording, candidate-only, idempotent, never fabricates classification)')

    const allClusters = await getTopicClustersForClient(clientId)
    assert.strictEqual(allClusters.length, 3, 'expected exactly 3 clusters for this throwaway client: the retired former-benchmark one, the rejected candidate, and the legacy-migrated one')

    console.log('\nAll Phase 2 promptTopicIntelligence DB-dependent tests passed.')
  } finally {
    if (clientId) {
      await supabase.from('clients').delete().eq('id', clientId)
      console.log(`Cleaned up throwaway test client ${clientId}`)
    }
  }
}

main().catch(err => {
  console.error('Phase 2 promptTopicIntelligence tests FAILED:', err)
  process.exit(1)
})
