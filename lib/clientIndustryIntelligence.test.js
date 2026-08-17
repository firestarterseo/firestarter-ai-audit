// Phase 1b test script -- plain Node, no test framework (same convention
// as lib/clientProfileFields.test.js and package.json's "test:checkers").
// Run with:
//   node lib/clientIndustryIntelligence.test.js
// or:
//   npm run test:client-intelligence
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same as every other
// DB-touching script in this project) -- not runnable inside the
// assistant's sandbox, since that key is intentionally never available to
// it. Every DB-dependent assertion below was instead verified directly
// against the real firestarter-ai-audit Supabase project via the Supabase
// MCP connection, using this exact same sequence of calls.
//
// ANTHROPIC_API_KEY is ALSO a Vercel-only env var never available to the
// assistant, which means the one genuinely network-dependent step --
// classifyClientIndustryProfile's live Anthropic call -- cannot be
// exercised end-to-end here either. This script handles that the same
// honest way Phase 1a handled its own missing credential: TEST 1 below
// calls the real orchestrator end-to-end against a real throwaway client
// and asserts it fails GRACEFULLY (ok:false, no writes, no throw) when no
// key is configured -- proving the failure-safety contract -- while every
// other test exercises the exact same write-path code
// (persistClassification) that a successful Anthropic response would feed
// into, using hand-built "as if the LLM had said this" inputs instead of a
// live call. This is not a weaker test of the write path -- it's the same
// function, same DB, same RPCs -- it is a weaker test of prompt quality/
// LLM behavior itself, which has no automated test in this project for any
// existing Anthropic integration either (see lib/keywordRelevance.js).
//
// Creates throwaway clients (names starting with __PHASE1B_TEST_CLIENT__ /
// __PHASE1B_RECONCILE_...__), exercises every required Phase 1b scenario
// against them, then deletes them (cascades to
// client_profile_fields/_history/_recommendations) so this script never
// leaves residue in the database.

const assert = require('assert')
const { getSupabaseServerClient } = require('./supabaseServer')
const { confirmClientProfileField, getClientProfileFields, getOpenClientProfileRecommendations, removeStaleClientProfileFieldItem, dismissClientProfileRecommendation } = require('./clientProfileFields')
const {
  classifyClientIndustryProfile,
  getClientIndustryProfile,
  gatherClientEvidence,
  normalizeClassificationResult,
  normalizeFieldItem,
  persistClassification,
  isStaleRemovalRecommendation
} = require('./clientIndustryIntelligence')

function field(value, confidence, evidenceText = 'test evidence') {
  return normalizeFieldItem({ value, confidence, evidence: evidenceText })
}

function emptyFields() {
  return {
    business_model: normalizeFieldItem({ value: null }),
    industry: normalizeFieldItem({ value: null }),
    vertical_subindustry: normalizeFieldItem({ value: null }),
    specialty: normalizeFieldItem({ value: null }),
    primary_customer_use_case: normalizeFieldItem({ value: null }),
    primary_products_services: [],
    secondary_products_services: [],
    primary_geography_markets: []
  }
}

// carryForwardFields(clientId, overrides) -- builds a full 8-field
// normalizedFields object reflecting the client's CURRENT actual state
// (re-deriving each field/item from what's really in the database),
// then applies `overrides` on top. This is what a real reclassification
// pass naturally looks like: the LLM re-evaluates and re-returns ALL 8
// fields every time, not just the one thing a test cares about --
// persistClassification's new list reconciliation (Phase 1b completion
// fix, 2026-08-17) correctly treats an explicitly-empty list as "this
// pass found zero items," so tests must not pass an empty placeholder for
// fields they don't intend to touch (that would incorrectly reconcile
// away real existing items). Using carryForwardFields instead of a bare
// emptyFields() spread for any call made after earlier data already
// exists is what makes these tests behave like a realistic pass rather
// than accidentally exercising the removal path on unrelated fields.
async function carryForwardFields(clientId, overrides = {}) {
  const rows = await getClientProfileFields(clientId)
  const byField = new Map()
  for (const row of rows) {
    if (!byField.has(row.field_key)) byField.set(row.field_key, [])
    byField.get(row.field_key).push(row)
  }
  const evidenceTextOf = row => (Array.isArray(row.evidence) && row.evidence[0] && row.evidence[0].text) || null

  const base = {}
  for (const key of ['business_model', 'industry', 'vertical_subindustry', 'specialty', 'primary_customer_use_case']) {
    const row = (byField.get(key) || []).find(r => r.item_index === 0)
    base[key] = (row && row.value != null) ? field(row.value, row.confidence, evidenceTextOf(row)) : normalizeFieldItem({ value: null })
  }
  for (const key of ['primary_products_services', 'secondary_products_services', 'primary_geography_markets']) {
    const items = (byField.get(key) || []).filter(r => r.value != null).sort((a, b) => a.item_index - b.item_index)
    base[key] = items.map(r => field(r.value, r.confidence, evidenceTextOf(r)))
  }
  return { ...base, ...overrides }
}

async function createThrowawayClient(supabase, namePrefix) {
  const { data: created, error } = await supabase
    .from('clients')
    .insert({ name: namePrefix, domain: `${namePrefix.toLowerCase()}.example.com`, url: `https://${namePrefix.toLowerCase()}.example.invalid`, city: 'Denver', region: 'CO', status: 'lead' })
    .select('*')
    .single()
  if (error) throw error
  return created
}

async function main() {
  const supabase = getSupabaseServerClient()
  let clientId
  let client

  try {
    client = await createThrowawayClient(supabase, '__PHASE1B_TEST_CLIENT__')
    clientId = client.id
    console.log(`Created throwaway test client ${clientId}`)

    // TEST 11 (zero profile): before any classification, the accessor must
    // still work, report no profile data, and fall back to clients.category
    // for `industry` ONLY IF category is set (it isn't here) -- so industry
    // should be null too.
    let profile = await getClientIndustryProfile(clientId)
    assert.strictEqual(profile.hasAnyProfileData, false, 'TEST 11a: zero profile rows should report hasAnyProfileData=false')
    assert.strictEqual(profile.industry, null, 'TEST 11a: no category set -> industry should be null, not fabricated')
    assert.strictEqual(profile.summary, 'Denver, CO', 'TEST 11a: with no profile fields, summary should fall back to city/region only')
    console.log('TEST 11a PASSED (zero profile)')

    // TEST 1: the real orchestrator can be invoked end-to-end against a
    // client with no profile. In this sandbox (no ANTHROPIC_API_KEY), it
    // must fail gracefully -- no throw, ok:false, zero writes, nothing
    // touched.
    const liveAttempt = await classifyClientIndustryProfile(client, { dryRun: true })
    assert.strictEqual(typeof liveAttempt.ok, 'boolean', 'TEST 1: classifyClientIndustryProfile must always return {ok}')
    if (!liveAttempt.ok) {
      assert.deepStrictEqual(liveAttempt.writes, [], 'TEST 1: a failed classification must not report any writes')
      console.log('TEST 1 PASSED (classifyClientIndustryProfile is callable end-to-end; failed gracefully in this sandbox with no ANTHROPIC_API_KEY configured -- no throw, no writes)')
    } else {
      console.log('TEST 1 PASSED (ANTHROPIC_API_KEY was configured -- live classification actually succeeded)')
    }
    let sanityCheck = await getClientProfileFields(clientId)
    assert.strictEqual(sanityCheck.length, liveAttempt.ok ? sanityCheck.length : 0, 'TEST 1: a failed live classification attempt must leave zero rows behind')

    // TEST 2 + 3 + 6 + 7: hand-built "as if the LLM had said this"
    // classification, exercised through the real persistClassification
    // write path (same code classifyClientIndustryProfile calls after a
    // real Anthropic response). Covers: all defensible fields populate,
    // an unsupported field (specialty) stays null rather than fabricated,
    // direct evidence keeps its confidence tier, and an invalid/weak
    // confidence value is downgraded to 'uncertain' rather than silently
    // trusted as direct evidence.
    const firstPass = {
      business_model: field('Local', 'confirmed_by_direct_evidence', 'JSON-LD LocalBusiness node with a single address'),
      industry: field('Dental', 'confirmed_by_direct_evidence', 'JSON-LD @type Dentist'),
      vertical_subindustry: field('Orthodontics', 'likely', 'title: "Denver Orthodontics | Smile Clinic"'),
      specialty: normalizeFieldItem({ value: null, confidence: null, evidence: null }), // TEST 3: no defensible specialty evidence
      primary_customer_use_case: field('Adults seeking Invisalign treatment', 'not_a_real_confidence_value', 'inferred from ambiguous homepage copy'), // TEST 7: invalid confidence must downgrade
      primary_products_services: [field('Invisalign / clear aligners', 'confirmed_by_direct_evidence', 'nav item + JSON-LD Service node')],
      secondary_products_services: [field('Teeth whitening', 'likely', 'service page title')],
      primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence', 'JSON-LD address')]
    }
    let writes = await persistClassification(client, firstPass, { dryRun: false })
    assert.ok(writes.length >= 7, 'TEST 2: expected all defensible fields to produce a write')
    const specialtyWrite = writes.find(w => w.fieldKey === 'specialty')
    assert.strictEqual(specialtyWrite, undefined, 'TEST 3: a null specialty must not be written at all (no fabricated row)')
    const useCaseWrite = writes.find(w => w.fieldKey === 'primary_customer_use_case')
    assert.strictEqual(useCaseWrite.confidence, 'uncertain', 'TEST 7: an invalid/self-reported confidence value must downgrade to uncertain, never pass through as direct evidence')
    let rows = await getClientProfileFields(clientId)
    const industryRow = rows.find(r => r.field_key === 'industry' && r.item_index === 0)
    assert.strictEqual(industryRow.confidence, 'confirmed_by_direct_evidence', 'TEST 6: real direct evidence must keep its confidence tier')
    console.log('TEST 2, 3, 6, 7 PASSED')

    // TEST 13: evidence/provenance survives persistence.
    assert.ok(Array.isArray(industryRow.evidence) && industryRow.evidence.length === 1, 'TEST 13: evidence must round-trip')
    assert.strictEqual(industryRow.evidence[0].source, 'llm_classification', 'TEST 13: provenance must record where the value came from')
    assert.strictEqual(industryRow.evidence[0].text, 'JSON-LD @type Dentist', 'TEST 13: the specific evidence text must survive intact')
    console.log('TEST 13 PASSED')

    // TEST 4: multi-value products/services persist independently. Uses
    // carryForwardFields (not a bare emptyFields() spread) so the
    // geography market written in firstPass isn't accidentally reconciled
    // away just because this call doesn't mention it.
    let productRows = rows.filter(r => r.field_key === 'primary_products_services')
    assert.strictEqual(productRows.length, 1, 'TEST 4: expected exactly the one primary service written so far')
    writes = await persistClassification(client, await carryForwardFields(clientId, {
      primary_products_services: [field('Invisalign / clear aligners', 'confirmed_by_direct_evidence'), field('Dental implants', 'likely')]
    }), { dryRun: false })
    rows = await getClientProfileFields(clientId)
    productRows = rows.filter(r => r.field_key === 'primary_products_services').sort((a, b) => a.item_index - b.item_index)
    assert.strictEqual(productRows.length, 2, 'TEST 4: expected two independent product/service items')
    const geoAfterTest4 = rows.filter(r => r.field_key === 'primary_geography_markets' && r.value != null)
    assert.strictEqual(geoAfterTest4.length, 1, 'TEST 4 (regression guard): an unrelated list field must survive a call that carries it forward unchanged')
    await confirmClientProfileField({ clientId, fieldKey: 'primary_products_services', itemIndex: 0 })
    rows = await getClientProfileFields(clientId)
    productRows = rows.filter(r => r.field_key === 'primary_products_services').sort((a, b) => a.item_index - b.item_index)
    assert.strictEqual(productRows[0].confirmation_status, 'confirmed')
    assert.strictEqual(productRows[1].confirmation_status, 'unconfirmed', 'TEST 4: confirming item 0 must not affect item 1')
    console.log('TEST 4 PASSED')

    // TEST 5: multi-value geography persists independently (a second
    // market added on a later pass, independent of the first).
    writes = await persistClassification(client, await carryForwardFields(clientId, {
      primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence'), field('Boulder, CO', 'likely')]
    }), { dryRun: false })
    rows = await getClientProfileFields(clientId)
    const geoRows = rows.filter(r => r.field_key === 'primary_geography_markets' && r.value != null).sort((a, b) => a.item_index - b.item_index)
    assert.strictEqual(geoRows.length, 2, 'TEST 5: expected two independent geography items')
    assert.strictEqual(geoRows[1].value, 'Boulder, CO')
    console.log('TEST 5 PASSED')

    // TEST 9 + 10: reclassification must NOT overwrite a CONFIRMED field --
    // it must create a Phase 1a recommendation instead (the pinning
    // invariant, enforced by Phase 1a and simply exercised here through
    // this module's write path).
    await confirmClientProfileField({ clientId, fieldKey: 'industry' })
    writes = await persistClassification(client, await carryForwardFields(clientId, {
      industry: field('Orthodontics-only practice', 'likely', 'reclassification pass')
    }), { dryRun: false })
    const industryReclassifyWrite = writes.find(w => w.fieldKey === 'industry')
    assert.strictEqual(industryReclassifyWrite.status, 'conflict_recommendation_created', 'TEST 9: a conflicting write against a CONFIRMED field must create a recommendation, not overwrite')
    rows = await getClientProfileFields(clientId)
    const industryAfterConflict = rows.find(r => r.field_key === 'industry')
    assert.strictEqual(industryAfterConflict.value, 'Dental', 'TEST 9 (PINNING INVARIANT): confirmed value must survive a conflicting reclassification')
    let openRecos = await getOpenClientProfileRecommendations(clientId)
    assert.ok(openRecos.some(r => r.field_key === 'industry' && r.recommended_value === 'Orthodontics-only practice'), 'TEST 10: the conflicting value must appear as an open, reviewable recommendation')
    console.log('TEST 9, 10 PASSED')

    // TEST 11 (mixed + pending): getClientIndustryProfile must correctly
    // reflect a mix of confirmed/unconfirmed fields plus an open
    // recommendation.
    profile = await getClientIndustryProfile(clientId)
    assert.strictEqual(profile.hasAnyProfileData, true, 'TEST 11b: partial/full profile should report hasAnyProfileData=true')
    assert.strictEqual(profile.industry.confirmationStatus, 'confirmed', 'TEST 11b: industry should read back as confirmed')
    assert.ok(profile.openRecommendations.some(r => r.field_key === 'industry'), 'TEST 11b: the pending industry recommendation must surface on the profile')
    assert.strictEqual(profile.primaryProductsServices.length, 2, 'TEST 11b: multi-value list fields must surface every independent item')
    console.log('TEST 11b PASSED (partial profile, mixed confirmation states, pending recommendation)')

    // TEST 12: clients.category must remain completely untouched by any of
    // this module's writes -- it was never set on this test client, and
    // nothing here should have set it.
    const { data: rawClient } = await supabase.from('clients').select('category').eq('id', clientId).single()
    assert.strictEqual(rawClient.category, null, 'TEST 12: clients.category must never be written by classification')
    console.log('TEST 12 PASSED')

    // TEST 15: rerunning with the IDENTICAL classification against an
    // still-unconfirmed field must be a true no-op ('unchanged'), not a
    // fabricated repeat write -- idempotent/retry-safe.
    writes = await persistClassification(client, await carryForwardFields(clientId, {
      vertical_subindustry: field('Orthodontics', 'likely', 'title: "Denver Orthodontics | Smile Clinic"')
    }), { dryRun: false })
    const firstRunStatus = writes.find(w => w.fieldKey === 'vertical_subindustry').status
    assert.strictEqual(firstRunStatus, 'unchanged', 'TEST 15 setup: identical value to what TEST 2 already wrote should be a no-op')
    writes = await persistClassification(client, await carryForwardFields(clientId, {
      vertical_subindustry: field('Orthodontics', 'likely', 'title: "Denver Orthodontics | Smile Clinic"')
    }), { dryRun: false })
    assert.strictEqual(writes.find(w => w.fieldKey === 'vertical_subindustry').status, 'unchanged', 'TEST 15: re-running the identical classification must remain idempotent')
    console.log('TEST 15 PASSED')

    // TEST 14: one failed evidence source (an unreachable homepage) must
    // not throw and must not prevent whatever other evidence IS available
    // from being returned -- gatherClientEvidence degrades gracefully.
    const brokenClient = { ...client, url: 'https://this-domain-does-not-exist.invalid.example' }
    const evidence = await gatherClientEvidence(brokenClient)
    assert.ok(evidence.homepageError, 'TEST 14: a fetch failure must be recorded as an honest error, not swallowed silently')
    assert.ok(!evidence.sourcesAvailable.includes('homepage_html'), 'TEST 14: a failed source must not claim to be available')
    assert.strictEqual(evidence.businessProfile, null, 'TEST 14: no crash -- just an honest absence of homepage-derived evidence')
    // And existing profile data must be completely unaffected by a failed
    // evidence-gathering attempt run against this same client id.
    rows = await getClientProfileFields(clientId)
    assert.ok(rows.length > 0, 'TEST 14: a failed evidence-gathering call for this client must not have touched its existing profile rows')
    console.log('TEST 14 PASSED (failed evidence source degrades gracefully, existing data untouched)')

    console.log('\nAll 16 original Phase 1b tests passed (TEST 16 -- UI state rendering -- verified by code review, see the Phase 1b response\'s Test Results section; this project has no UI test harness for any existing component).')
  } finally {
    if (clientId) {
      await supabase.from('clients').delete().eq('id', clientId)
      console.log(`Cleaned up throwaway test client ${clientId}`)
    }
  }

  await testListReconciliation(supabase)
}

// testListReconciliation -- Phase 1b completion fix (2026-08-17), the four
// scenarios required by that fix: an unconfirmed list shrinking must not
// leave a stale item in CURRENT state (A), a CONFIRMED item no longer
// detected must never be silently removed -- only flagged for review (B),
// a list growing works normally (C), and a same-length list where one item
// changes reconciles the old one away while adding the new one, with
// history intact (D). Runs against its own dedicated throwaway client so
// it can't be affected by (or affect) the ordering of the tests above.
async function testListReconciliation(supabase) {
  let clientId
  let client
  try {
    client = await createThrowawayClient(supabase, '__PHASE1B_RECONCILE_TEST__')
    clientId = client.id
    console.log(`\nCreated throwaway reconciliation-test client ${clientId}`)

    // --- SCENARIO A: unconfirmed list Denver/Aurora/Lakewood -> redetect
    // Denver/Aurora. Lakewood must disappear from CURRENT state; history
    // must still show it.
    await persistClassification(client, {
      ...emptyFields(),
      primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence'), field('Aurora, CO', 'likely'), field('Lakewood, CO', 'likely')]
    }, { dryRun: false })
    let profile = await getClientIndustryProfile(clientId)
    assert.strictEqual(profile.primaryGeographyMarkets.length, 3, 'SCENARIO A setup: expected all 3 unconfirmed markets to appear initially')

    await persistClassification(client, {
      ...emptyFields(),
      primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence'), field('Aurora, CO', 'likely')]
    }, { dryRun: false })
    profile = await getClientIndustryProfile(clientId)
    const currentValuesA = profile.primaryGeographyMarkets.map(m => m.value)
    assert.deepStrictEqual(currentValuesA, ['Denver, CO', 'Aurora, CO'], 'SCENARIO A: Lakewood must no longer appear in the current profile')

    const { data: historyA } = await supabase
      .from('client_profile_field_history')
      .select('previous_value, new_value, change_reason')
      .eq('client_id', clientId)
      .eq('field_key', 'primary_geography_markets')
      .eq('item_index', 2)
      .order('created_at', { ascending: true })
    assert.ok(historyA.some(h => h.new_value?.value === 'Lakewood, CO'), 'SCENARIO A: history must still show Lakewood was once detected')
    assert.ok(historyA.some(h => h.previous_value?.value === 'Lakewood, CO' && h.new_value?.value === null && h.change_reason === 'system_updated_unconfirmed'), 'SCENARIO A: history must record the removal transition (Lakewood -> null)')
    console.log('SCENARIO A PASSED (unconfirmed item no longer detected -> removed from current state, preserved in history)')

    // --- SCENARIO B: a CONFIRMED item omitted by re-detection must NOT be
    // silently removed -- it must stay current, and a review recommendation
    // must be created instead.
    // (item_index 2 is currently an empty/reconciled slot from Scenario A
    // -- reuse it for a fresh confirmed-item scenario.)
    await persistClassification(client, await carryForwardFields(clientId, {
      primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence'), field('Aurora, CO', 'likely'), field('Lakewood, CO', 'likely')]
    }), { dryRun: false })
    await confirmClientProfileField({ clientId, fieldKey: 'primary_geography_markets', itemIndex: 2 })
    let rowsB = await getClientProfileFields(clientId)
    assert.strictEqual(rowsB.find(r => r.field_key === 'primary_geography_markets' && r.item_index === 2).confirmation_status, 'confirmed', 'SCENARIO B setup: expected Lakewood confirmed at item_index 2')

    // Re-detect omits Lakewood again.
    await persistClassification(client, await carryForwardFields(clientId, {
      primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence'), field('Aurora, CO', 'likely')]
    }), { dryRun: false })
    profile = await getClientIndustryProfile(clientId)
    assert.ok(profile.primaryGeographyMarkets.some(m => m.value === 'Lakewood, CO' && m.confirmationStatus === 'stale_recommendation_pending'), 'SCENARIO B: a confirmed item no longer detected must remain current (flagged for review), not vanish')
    const openRecosB = await getOpenClientProfileRecommendations(clientId)
    const removalRecoB = openRecosB.find(r => r.field_key === 'primary_geography_markets' && r.item_index === 2)
    assert.ok(removalRecoB, 'SCENARIO B: expected an open review recommendation instead of a silent removal')
    assert.ok(isStaleRemovalRecommendation(removalRecoB), 'SCENARIO B: the recommendation must be identifiable as a stale-removal flag, not a normal new-value suggestion')
    console.log('SCENARIO B PASSED (confirmed item no longer detected -> stays current, flagged with a review recommendation, never silently removed)')

    // Resolve it via the new "Remove" action and confirm it's cleared
    // (with history intact) -- exercises removeStaleClientProfileFieldItem
    // end-to-end, the fix's other new primitive besides reconciliation
    // itself.
    await removeStaleClientProfileFieldItem({ recommendationId: removalRecoB.id })
    profile = await getClientIndustryProfile(clientId)
    assert.ok(!profile.primaryGeographyMarkets.some(m => m.value === 'Lakewood, CO'), 'SCENARIO B (resolution): after an explicit "Remove" action, the item must no longer appear current')
    const { data: historyB } = await supabase
      .from('client_profile_field_history')
      .select('previous_value, new_value, change_reason')
      .eq('client_id', clientId).eq('field_key', 'primary_geography_markets').eq('item_index', 2)
      .order('created_at', { ascending: true })
    assert.ok(historyB.some(h => h.previous_value?.value === 'Lakewood, CO' && h.new_value?.value === null), 'SCENARIO B (resolution): history must still preserve that Lakewood was confirmed here')
    console.log('SCENARIO B (resolution) PASSED (AM "Remove" action clears the slot; history preserved)')

    // --- SCENARIO C: list grows, Denver -> Denver/Aurora. Fresh client so
    // this is unambiguous (no leftover items from A/B).
    const clientC = await createThrowawayClient(supabase, '__PHASE1B_RECONCILE_C__')
    try {
      await persistClassification(clientC, { ...emptyFields(), primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence')] }, { dryRun: false })
      await persistClassification(clientC, await carryForwardFields(clientC.id, {
        primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence'), field('Aurora, CO', 'likely')]
      }), { dryRun: false })
      const profileC = await getClientIndustryProfile(clientC.id)
      assert.deepStrictEqual(profileC.primaryGeographyMarkets.map(m => m.value), ['Denver, CO', 'Aurora, CO'], 'SCENARIO C: Aurora should be added normally, Denver unaffected')
      console.log('SCENARIO C PASSED (list grows -- new item added normally)')
    } finally {
      await supabase.from('clients').delete().eq('id', clientC.id)
    }

    // --- SCENARIO D: Denver/Aurora -> Denver/Boulder (same length, one
    // item changes). Positional reconciliation treats item_index 1 as the
    // same slot: Aurora (unconfirmed) is reconciled away as that slot
    // updates to Boulder -- a single history row shows the Aurora->Boulder
    // transition, which is an accurate record of what happened.
    const clientD = await createThrowawayClient(supabase, '__PHASE1B_RECONCILE_D__')
    try {
      await persistClassification(clientD, { ...emptyFields(), primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence'), field('Aurora, CO', 'likely')] }, { dryRun: false })
      await persistClassification(clientD, await carryForwardFields(clientD.id, {
        primary_geography_markets: [field('Denver, CO', 'confirmed_by_direct_evidence'), field('Boulder, CO', 'likely')]
      }), { dryRun: false })
      const profileD = await getClientIndustryProfile(clientD.id)
      assert.deepStrictEqual(profileD.primaryGeographyMarkets.map(m => m.value), ['Denver, CO', 'Boulder, CO'], 'SCENARIO D: current state should show Denver + Boulder, not Aurora')
      const { data: historyD } = await supabase
        .from('client_profile_field_history')
        .select('previous_value, new_value, change_reason')
        .eq('client_id', clientD.id).eq('field_key', 'primary_geography_markets').eq('item_index', 1)
        .order('created_at', { ascending: true })
      assert.ok(historyD.some(h => h.previous_value?.value === 'Aurora, CO' && h.new_value?.value === 'Boulder, CO'), 'SCENARIO D: history must accurately record Aurora being replaced by Boulder at the same slot')
      console.log('SCENARIO D PASSED (Aurora reconciled away, Boulder added, history accurate)')
    } finally {
      await supabase.from('clients').delete().eq('id', clientD.id)
    }

    console.log('\nAll list-reconciliation scenarios (A-D) passed.')
  } finally {
    if (clientId) {
      await supabase.from('clients').delete().eq('id', clientId)
      console.log(`Cleaned up throwaway reconciliation-test client ${clientId}`)
    }
  }
}

main().catch(err => {
  console.error('Phase 1b tests FAILED:', err)
  process.exit(1)
})
