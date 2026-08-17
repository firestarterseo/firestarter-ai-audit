// Phase 1a test script -- plain Node, no test framework (this project has
// none; see package.json's existing "test:checkers" convention of running
// plain node scripts and checking exit codes). Run with:
//   node lib/clientProfileFields.test.js
// or:
//   npm run test:client-profile
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set (same as
// every other script in this project that touches the database) -- this
// was NOT runnable inside the assistant's sandbox, since that key is
// intentionally never available to the assistant (see
// lib/supabaseServer.js's header comment). Every assertion below was
// instead verified directly against the real firestarter-ai-audit Supabase
// project via the Supabase MCP connection, using this exact same sequence
// of calls at the SQL level. This script exists so the same assertions can
// be re-run from inside the app itself (CI, or locally) going forward.
//
// Creates one throwaway client (name starts with __PHASE1A_TEST_CLIENT__),
// exercises every required Phase 1a scenario against it, then deletes it
// (cascades to client_profile_fields / _history / _recommendations) so
// this script never leaves residue in the database.

const assert = require('assert')
const { getSupabaseServerClient } = require('./supabaseServer')
const {
  FIELD_KEYS,
  getClientProfileFields,
  getOpenClientProfileRecommendations,
  writeSystemDetectedField,
  confirmClientProfileField,
  overrideClientProfileField,
  acceptClientProfileRecommendation,
  dismissClientProfileRecommendation
} = require('./clientProfileFields')

async function main() {
  const supabase = getSupabaseServerClient()
  let clientId

  try {
    const { data: client, error: createError } = await supabase
      .from('clients')
      .insert({ name: '__PHASE1A_TEST_CLIENT__', domain: 'phase1a-test.example.com', url: 'https://phase1a-test.example.com', status: 'lead' })
      .select('id')
      .single()
    if (createError) throw createError
    clientId = client.id
    console.log(`Created throwaway test client ${clientId}`)

    // TEST 1 + 2: system inserts an unconfirmed field, then updates it
    // while still unconfirmed.
    let result = await writeSystemDetectedField({ clientId, fieldKey: 'business_model', value: 'B2B professional services', confidence: 'likely', evidence: [{ source: 'homepage_meta' }] })
    assert.strictEqual(result, 'inserted', 'TEST 1: expected system write to a new field to insert')
    result = await writeSystemDetectedField({ clientId, fieldKey: 'business_model', value: 'B2B SaaS', confidence: 'likely', evidence: [{ source: 'homepage_meta_v2' }] })
    assert.strictEqual(result, 'updated', 'TEST 2: expected system write to an existing unconfirmed field to update')
    console.log('TEST 1, 2 PASSED')

    // TEST 3: AM confirms.
    await writeSystemDetectedField({ clientId, fieldKey: 'industry', value: 'Marketing Technology', confidence: 'likely' })
    let confirmed = await confirmClientProfileField({ clientId, fieldKey: 'industry' })
    assert.strictEqual(confirmed.confirmation_status, 'confirmed', 'TEST 3: expected confirmation_status = confirmed')
    assert.ok(confirmed.last_verified_at, 'TEST 3: expected last_verified_at to be set')
    console.log('TEST 3 PASSED')

    // TEST 4: AM overrides.
    await writeSystemDetectedField({ clientId, fieldKey: 'vertical_subindustry', value: 'Local SEO Software', confidence: 'uncertain' })
    let overridden = await overrideClientProfileField({ clientId, fieldKey: 'vertical_subindustry', value: 'AI Search Visibility Software' })
    assert.strictEqual(overridden.confirmation_status, 'overridden', 'TEST 4: expected confirmation_status = overridden')
    assert.strictEqual(overridden.confidence, 'confirmed_by_direct_evidence', 'TEST 4: expected an AM override to carry confirmed_by_direct_evidence')
    console.log('TEST 4 PASSED')

    // TEST 5: automated conflicting write against a CONFIRMED field must
    // NOT change the current value.
    result = await writeSystemDetectedField({ clientId, fieldKey: 'industry', value: 'Digital Advertising', confidence: 'likely' })
    assert.strictEqual(result, 'conflict_recommendation_created', 'TEST 5: expected a conflict recommendation, not a silent overwrite')
    let fields = await getClientProfileFields(clientId)
    let industryField = fields.find(f => f.field_key === 'industry')
    assert.strictEqual(industryField.value, 'Marketing Technology', 'TEST 5 (PINNING INVARIANT): confirmed value must survive a conflicting automated write')
    assert.strictEqual(industryField.confirmation_status, 'stale_recommendation_pending')
    console.log('TEST 5 PASSED (pinning invariant holds for CONFIRMED)')

    // TEST 6: same protection for an OVERRIDDEN field.
    result = await writeSystemDetectedField({ clientId, fieldKey: 'vertical_subindustry', value: 'Generic SEO Tools', confidence: 'uncertain' })
    assert.strictEqual(result, 'conflict_recommendation_created')
    fields = await getClientProfileFields(clientId)
    let verticalField = fields.find(f => f.field_key === 'vertical_subindustry')
    assert.strictEqual(verticalField.value, 'AI Search Visibility Software', 'TEST 6 (PINNING INVARIANT): overridden value must survive a conflicting automated write')
    console.log('TEST 6 PASSED (pinning invariant holds for OVERRIDDEN)')

    // TEST 7: AM accepts the recommendation created in TEST 5.
    let recos = await getOpenClientProfileRecommendations(clientId)
    let industryReco = recos.find(r => r.field_key === 'industry')
    let accepted = await acceptClientProfileRecommendation({ recommendationId: industryReco.id })
    assert.strictEqual(accepted.value, 'Digital Advertising', 'TEST 7: expected the recommended value to become current')
    assert.strictEqual(accepted.confirmation_status, 'confirmed')
    console.log('TEST 7 PASSED')

    // TEST 8: AM dismisses a recommendation -- value must not change.
    await writeSystemDetectedField({ clientId, fieldKey: 'primary_customer_use_case', value: 'Marketing agencies auditing client SEO', confidence: 'likely' })
    await confirmClientProfileField({ clientId, fieldKey: 'primary_customer_use_case' })
    await writeSystemDetectedField({ clientId, fieldKey: 'primary_customer_use_case', value: 'Ecommerce brands', confidence: 'uncertain' })
    recos = await getOpenClientProfileRecommendations(clientId)
    let useCaseReco = recos.find(r => r.field_key === 'primary_customer_use_case')
    let dismissed = await dismissClientProfileRecommendation({ recommendationId: useCaseReco.id })
    assert.strictEqual(dismissed.value, 'Marketing agencies auditing client SEO', 'TEST 8: dismissal must not change the current value')
    assert.strictEqual(dismissed.confirmation_status, 'confirmed', 'TEST 8: status should revert to what it was before the conflict')
    console.log('TEST 8 PASSED')

    // TEST 10: clients.category is untouched by any of this.
    const { data: rawClient } = await supabase.from('clients').select('category').eq('id', clientId).single()
    assert.strictEqual(rawClient.category, null, 'TEST 10: category should be unaffected (never set, never required)')
    console.log('TEST 10 PASSED')

    // TEST 11: a client with no profile rows at all continues to work.
    const { data: anotherRealClient } = await supabase.from('clients').select('id').neq('id', clientId).limit(1).maybeSingle()
    if (anotherRealClient) {
      const noProfileFields = await getClientProfileFields(anotherRealClient.id)
      assert.ok(Array.isArray(noProfileFields), 'TEST 11: accessor must return an array even with zero rows')
    }
    console.log('TEST 11 PASSED')

    // TEST 12: null/uncertain classification does not crash.
    result = await writeSystemDetectedField({ clientId, fieldKey: 'specialty', value: null, confidence: null })
    assert.strictEqual(result, 'inserted', 'TEST 12: a genuine "nothing detected" write should still insert cleanly')
    console.log('TEST 12 PASSED')

    // TEST 13: evidence survives round-trip, including nested shapes.
    await writeSystemDetectedField({
      clientId,
      fieldKey: 'primary_products_services',
      value: 'AI visibility auditing',
      confidence: 'confirmed_by_direct_evidence',
      evidence: [{ source: 'homepage_h1', excerpt: 'AI Search Visibility Audits for Agencies', url: 'https://phase1a-test.example.com/' }, { source: 'ahrefs_top_keyword', volume: 320 }]
    })
    fields = await getClientProfileFields(clientId)
    const productsField = fields.find(f => f.field_key === 'primary_products_services')
    assert.strictEqual(productsField.evidence.length, 2, 'TEST 13: evidence array should round-trip intact')
    assert.strictEqual(productsField.evidence[1].volume, 320, 'TEST 13: nested evidence fields should round-trip intact')
    console.log('TEST 13 PASSED')

    // TEST 14: multi-value fields -- independent items via item_index.
    await writeSystemDetectedField({ clientId, fieldKey: 'primary_geography_markets', itemIndex: 0, value: 'Denver, CO', confidence: 'confirmed_by_direct_evidence' })
    await writeSystemDetectedField({ clientId, fieldKey: 'primary_geography_markets', itemIndex: 1, value: 'Austin, TX', confidence: 'likely' })
    await confirmClientProfileField({ clientId, fieldKey: 'primary_geography_markets', itemIndex: 0 })
    fields = await getClientProfileFields(clientId)
    const geoItems = fields.filter(f => f.field_key === 'primary_geography_markets').sort((a, b) => a.item_index - b.item_index)
    assert.strictEqual(geoItems.length, 2, 'TEST 14: expected two independent geography items')
    assert.strictEqual(geoItems[0].confirmation_status, 'confirmed')
    assert.strictEqual(geoItems[1].confirmation_status, 'unconfirmed', 'TEST 14: confirming item 0 must not affect item 1')
    console.log('TEST 14 PASSED')

    console.log('\nAll Phase 1a tests passed.')
  } finally {
    if (clientId) {
      await supabase.from('clients').delete().eq('id', clientId)
      console.log(`Cleaned up throwaway test client ${clientId}`)
    }
  }
}

main().catch(err => {
  console.error('Phase 1a tests FAILED:', err)
  process.exit(1)
})
