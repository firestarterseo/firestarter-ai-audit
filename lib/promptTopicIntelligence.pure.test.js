// Phase 2 test script -- the discovery module's pure, DB-free and LLM-free
// helpers (core/secondary enforcement, dedupe/suppression, normalization,
// the business-priority correlation rule, and the legacy brand_mode
// heuristic). Unlike gatherDiscoveryEvidence/discoverTopicClusters/
// migrateLegacyTestPrompts (which need SUPABASE_SERVICE_ROLE_KEY and, for
// a live discovery pass, ANTHROPIC_API_KEY -- neither available in the
// assistant's sandbox, same constraint documented in
// lib/clientIndustryIntelligence.test.js's own header), every function
// exercised here takes plain JS objects and returns plain JS objects, so
// this script runs to completion in ANY environment. Run with:
//   node lib/promptTopicIntelligence.pure.test.js
// or:
//   npm run test:prompt-topic-intelligence-pure

const assert = require('assert')
const {
  enforceCoreSecondaryConvention,
  computeDedupeKey,
  shouldSuppressCandidate,
  suggestSystemBusinessPriority,
  normalizeVariation,
  normalizeDiscoveryResult,
  looksBranded,
  MAX_SECONDARY_PER_CLUSTER
} = require('./promptTopicIntelligence')

function main() {
  // TEST 5a: zero variations marked "core" -- the first one is promoted.
  {
    const { variations } = enforceCoreSecondaryConvention([
      { variation_type: 'secondary', prompt_text: 'a' },
      { variation_type: 'secondary', prompt_text: 'b' }
    ])
    assert.strictEqual(variations.filter(v => v.variation_type === 'core').length, 1, 'TEST 5a: exactly one core must exist even when the model marked none')
    assert.strictEqual(variations[0].prompt_text, 'a', 'TEST 5a: the first variation becomes core when none was marked')
  }
  console.log('TEST 5a PASSED (promotes first variation to core when none marked)')

  // TEST 5b: multiple variations marked "core" -- only the first stays core.
  {
    const { variations } = enforceCoreSecondaryConvention([
      { variation_type: 'core', prompt_text: 'a' },
      { variation_type: 'core', prompt_text: 'b' },
      { variation_type: 'secondary', prompt_text: 'c' }
    ])
    const cores = variations.filter(v => v.variation_type === 'core')
    assert.strictEqual(cores.length, 1, 'TEST 5b: exactly one core must survive even when the model marked several')
    assert.strictEqual(cores[0].prompt_text, 'a')
    assert.strictEqual(variations.length, 3, 'TEST 5b: no variation should be dropped just for having been mis-marked core')
  }
  console.log('TEST 5b PASSED (demotes extra "core" variations to secondary instead of dropping them)')

  // TEST 5c / 3: secondary count capped at MAX_SECONDARY_PER_CLUSTER (3) --
  // "normally 1 CORE + 1-3 SECONDARY per cluster," enforced in app logic,
  // not a DB constraint.
  {
    const raw = [{ variation_type: 'core', prompt_text: 'core' }]
    for (let i = 0; i < 6; i++) raw.push({ variation_type: 'secondary', prompt_text: `sec${i}` })
    const { variations, droppedCount } = enforceCoreSecondaryConvention(raw)
    assert.strictEqual(variations.filter(v => v.variation_type === 'core').length, 1, 'TEST 3: exactly one core prompt must exist per cluster')
    assert.strictEqual(variations.filter(v => v.variation_type === 'secondary').length, MAX_SECONDARY_PER_CLUSTER, `TEST 5c: secondary count must be capped at ${MAX_SECONDARY_PER_CLUSTER}`)
    assert.strictEqual(droppedCount, 6 - MAX_SECONDARY_PER_CLUSTER, 'TEST 5c: excess secondaries must be reported as dropped, not silently discarded')
  }
  console.log('TEST 5c / 3 PASSED (secondary count capped, core prompt always present, drops are visible not silent)')

  // TEST 14: dedupe/suppression -- a rejected candidate must NOT be
  // regenerated identically absent materially new evidence.
  {
    const dedupeKey = computeDedupeKey('Local SEO', 'SEO Services', 'local')
    const rejectedClusters = [{ id: 'r1', name: 'Local SEO', dedupe_key: dedupeKey, retired_at: '2026-08-01T00:00:00.000Z', retired_reason: 'Wrong geography' }]

    // Profile last verified BEFORE the rejection -- no new evidence since
    // the AM rejected it. Must stay suppressed.
    const staleProfile = { primaryProductsServices: [{ value: 'SEO Services', lastVerifiedAt: '2026-07-01T00:00:00.000Z' }], businessModel: null, industry: null, verticalSubindustry: null, specialty: null, primaryCustomerUseCase: null, secondaryProductsServices: [], primaryGeographyMarkets: [] }
    const stillSuppressed = shouldSuppressCandidate(dedupeKey, rejectedClusters, staleProfile)
    assert.strictEqual(stillSuppressed.suppressed, true, 'TEST 14a: a rejected candidate with no new profile evidence since rejection must remain suppressed')

    // Profile re-verified AFTER the rejection -- materially new evidence.
    // Must no longer be suppressed.
    const freshProfile = { primaryProductsServices: [{ value: 'SEO Services', lastVerifiedAt: '2026-08-15T00:00:00.000Z' }], businessModel: null, industry: null, verticalSubindustry: null, specialty: null, primaryCustomerUseCase: null, secondaryProductsServices: [], primaryGeographyMarkets: [] }
    const noLongerSuppressed = shouldSuppressCandidate(dedupeKey, rejectedClusters, freshProfile)
    assert.strictEqual(noLongerSuppressed.suppressed, false, 'TEST 14b: materially new evidence (profile re-verified after the rejection) must lift the suppression')
    assert.strictEqual(noLongerSuppressed.materiallyNewEvidence, true)

    // A dedupe key with no matching rejection at all -- never suppressed.
    const noMatch = shouldSuppressCandidate('service:something else|geo:null', rejectedClusters, freshProfile)
    assert.strictEqual(noMatch.suppressed, false, 'TEST 14c: a candidate with no matching prior rejection must never be suppressed')
  }
  console.log('TEST 14 PASSED (rejected candidates suppressed unless materially new evidence exists)')

  // Business-priority correlation rule -- a cluster on the client's #1
  // primary service is suggested 'strategic'; everything else is 'none'.
  // This is a plain correlation rule, not LLM discretion (see TEST 10's
  // live-DB counterpart for the persisted pinning-invariant behavior).
  {
    const profile = { primaryProductsServices: [{ value: 'SEO Services' }, { value: 'PPC Advertising' }] }
    assert.strictEqual(suggestSystemBusinessPriority({ primary_service: 'SEO Services' }, profile), 'strategic', 'Top primary service must be suggested strategic')
    assert.strictEqual(suggestSystemBusinessPriority({ primary_service: 'PPC Advertising' }, profile), 'none', 'A secondary-ranked primary service must not be suggested strategic')
    assert.strictEqual(suggestSystemBusinessPriority({ primary_service: null }, profile), 'none', 'A cluster with no primary_service must default to none')
  }
  console.log('Business-priority correlation rule PASSED')

  // normalizeVariation -- invalid/out-of-vocabulary enum values from a
  // hypothetical malformed LLM response must be dropped/nulled, never
  // silently accepted -- "do not force false precision."
  {
    const v = normalizeVariation({
      prompt_text: '  Best SEO company in Denver  ',
      variation_type: 'core',
      brand_mode: 'not_a_real_mode',
      intent_tags: ['recommendation', 'not_a_real_intent'],
      intent_primary: 'not_a_real_intent',
      buyer_journey_tags: ['discover', 'bogus'],
      buyer_journey_primary: 'bogus'
    })
    assert.strictEqual(v.prompt_text, 'Best SEO company in Denver', 'prompt_text must be trimmed')
    assert.strictEqual(v.brand_mode, 'unbranded', 'an invalid brand_mode must fall back to unbranded, not be persisted as-is')
    assert.deepStrictEqual(v.intent_tags, ['recommendation'], 'out-of-vocabulary intent tags must be filtered out')
    assert.strictEqual(v.intent_primary, null, 'an out-of-vocabulary intent_primary must become null, never a fabricated value')
    assert.deepStrictEqual(v.buyer_journey_tags, ['discover'])
    assert.strictEqual(v.buyer_journey_primary, null)
  }
  console.log('normalizeVariation enum-safety PASSED')

  // normalizeDiscoveryResult -- end-to-end shaping of a hand-built,
  // as-if-the-LLM-said-this tool result (same testing technique
  // lib/clientIndustryIntelligence.test.js's own header documents using for
  // the parts of this pipeline that require a live Anthropic call).
  {
    const raw = {
      topic_clusters: [
        {
          name: 'Local SEO Services',
          primary_service: 'SEO Services',
          why_it_matters: 'Core commercial discovery query for the business.',
          geography_scope: 'local',
          geography_values: ['Denver, Colorado'],
          evidence: [{ type: 'primary_products_services', detail: 'SEO Services' }],
          prompt_variations: [
            { prompt_text: 'Best SEO company in Denver', variation_type: 'core', brand_mode: 'unbranded', intent_tags: ['recommendation'], intent_primary: 'recommendation', buyer_journey_tags: ['discover'], buyer_journey_primary: 'discover' },
            { prompt_text: 'Who would you recommend for local SEO in Denver?', variation_type: 'secondary', brand_mode: 'unbranded', intent_tags: ['recommendation'], intent_primary: null, buyer_journey_tags: ['evaluate'], buyer_journey_primary: null }
          ]
        },
        {
          name: 'No variations -- must be dropped',
          primary_service: null,
          why_it_matters: 'x',
          geography_scope: null,
          geography_values: [],
          evidence: [],
          prompt_variations: []
        }
      ]
    }
    const normalized = normalizeDiscoveryResult(raw)
    assert.strictEqual(normalized.length, 1, 'a cluster with zero usable prompt variations must be dropped, not persisted empty')
    assert.strictEqual(normalized[0].variations.length, 2)
    assert.strictEqual(normalized[0].variations[0].variation_type, 'core')
    assert.ok(normalized[0].dedupe_key.includes('seo services'), 'dedupe key must be derived from the primary service')
  }
  console.log('normalizeDiscoveryResult PASSED (drops empty clusters, preserves valid ones, computes dedupe key)')

  // Legacy migration's brand_mode heuristic -- a plain literal-text check,
  // never an LLM guess (see migrateLegacyTestPrompts' header on why
  // intent/buyer_journey are left null but brand_mode gets this one
  // mechanical inference).
  {
    assert.strictEqual(looksBranded('Firestarter SEO', 'Firestarter SEO'), true)
    assert.strictEqual(looksBranded('Denver SEO Agency', 'Firestarter SEO'), false)
    assert.strictEqual(looksBranded('is firestarter seo good?', 'Firestarter SEO'), true, 'match must be case-insensitive')
  }
  console.log('Legacy brand_mode heuristic (looksBranded) PASSED')

  console.log('\nAll Phase 2 promptTopicIntelligence pure-function tests passed (no DB, no LLM required).')
}

try {
  main()
} catch (err) {
  console.error('Phase 2 promptTopicIntelligence pure tests FAILED:', err)
  process.exit(1)
}
