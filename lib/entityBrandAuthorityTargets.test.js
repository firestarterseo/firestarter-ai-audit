// Pure tests for lib/entityBrandAuthorityTargets.js -- plain Node, no
// network, no Supabase, no LLM, no mocked fetcher of any kind (this module
// has zero require() statements at all -- see that file's header). Run
// with: node lib/entityBrandAuthorityTargets.test.js
//
// Fixtures below are numbered to match Phase 1's "10. TEST FIXTURES" spec
// exactly (1-13 are behavioral; 14-16 are source-level guarantees that this
// module can never make a network/Supabase/LLM call, verified by scanning
// its own source text rather than by mocking, since there is nothing to
// mock -- there are no such calls in the file at all).

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  TARGET_TYPES,
  DEFAULT_SOFT_CAP,
  buildServiceTargets,
  buildSpecialtyTarget,
  buildGeographyTargets,
  buildTopicTargets,
  applyOverlapFlags,
  compareTargets,
  selectEntityBrandAuthorityTargets
} = require('./entityBrandAuthorityTargets')

function log(msg) { console.log(msg) }

// --- Fixture builders, matching the REAL shapes traced in this module's
// own header (getClientIndustryProfile's camelCase read model, and
// topic_clusters' raw snake_case rows) -----------------------------------

function scalarField(value, { confidence = 'likely', confirmationStatus = 'unconfirmed', evidence = [] } = {}) {
  if (value === null) return null
  return { value, confidence, evidence, confirmationStatus, lastVerifiedAt: null }
}

function listItem(itemIndex, value, { confidence = 'likely', confirmationStatus = 'unconfirmed', evidence = [] } = {}) {
  return { itemIndex, value, confidence, evidence, confirmationStatus, lastVerifiedAt: null }
}

function makeProfile(overrides = {}) {
  return {
    clientId: 'client-1',
    hasAnyProfileData: true,
    specialty: null,
    primaryProductsServices: [],
    secondaryProductsServices: [],
    primaryGeographyMarkets: [],
    ...overrides
  }
}

let clusterSeq = 0
function benchmarkCluster(overrides = {}) {
  clusterSeq += 1
  return {
    id: overrides.id || `cluster-${clusterSeq}`,
    client_id: 'client-1',
    name: 'Local SEO Services',
    primary_service: null,
    why_it_matters: 'Real commercial demand.',
    status: 'benchmark',
    business_priority: 'none',
    business_priority_status: 'confirmed',
    geography_scope: null,
    geography_values: [],
    evidence: [{ type: 'primary_products_services', detail: 'SEO Services' }],
    discovery_method: 'system_discovery',
    dedupe_key: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function candidateCluster(overrides = {}) {
  return benchmarkCluster({ status: 'candidate', approved_at: null, ...overrides })
}

function run() {
  // ---------------------------------------------------------------------
  // 1. Normal client: specialty + several services + geography + benchmark
  // topics.
  // ---------------------------------------------------------------------
  {
    const profile = makeProfile({
      specialty: scalarField('Invisalign / Clear Aligners', { confidence: 'confirmed_by_direct_evidence', confirmationStatus: 'confirmed' }),
      primaryProductsServices: [
        listItem(0, 'Orthodontics', { confidence: 'confirmed_by_direct_evidence', confirmationStatus: 'confirmed' }),
        listItem(1, 'Teeth Whitening', { confidence: 'likely', confirmationStatus: 'unconfirmed' })
      ],
      secondaryProductsServices: [listItem(0, 'Dental Cleanings', { confidence: 'uncertain', confirmationStatus: 'unconfirmed' })],
      primaryGeographyMarkets: [listItem(0, 'Denver, CO', { confidence: 'confirmed_by_direct_evidence', confirmationStatus: 'confirmed' })]
    })
    const topicClusters = [
      benchmarkCluster({ name: 'Best Orthodontist in Denver', business_priority: 'strategic' }),
      benchmarkCluster({ name: 'Invisalign Cost Questions', business_priority: 'none' })
    ]
    const { targets, meta } = selectEntityBrandAuthorityTargets({ profile, topicClusters })
    assert.strictEqual(meta.totalCandidates, 7, '1 specialty + 2 primary services + 1 secondary service + 1 geography + 2 topics = 7')
    assert.strictEqual(targets.length, 7, 'all 7 fit comfortably under the soft cap')
    for (const type of ['service', 'specialty', 'geography', 'topic']) {
      assert.ok(targets.some(t => t.targetType === type), `expected at least one ${type} target`)
    }
    log('TEST 1 (normal client with specialty + several services + geography + benchmark topics produces one target per real evidenced item, across all 4 target types) PASSED')
  }

  // ---------------------------------------------------------------------
  // 2. Client with only 3 legitimate targets -- no padding.
  // ---------------------------------------------------------------------
  {
    const profile = makeProfile({
      specialty: scalarField('Family Law', { confidence: 'likely', confirmationStatus: 'unconfirmed' }),
      primaryProductsServices: [listItem(0, 'Divorce Representation', { confidence: 'likely' })],
      primaryGeographyMarkets: [listItem(0, 'Austin, TX', { confidence: 'likely' })]
    })
    const { targets, meta } = selectEntityBrandAuthorityTargets({ profile, topicClusters: [] })
    assert.strictEqual(targets.length, 3, 'exactly 3 legitimate targets, never padded toward the soft cap of 8')
    assert.strictEqual(meta.totalCandidates, 3)
    assert.strictEqual(meta.exceededSoftCap, false)
    log('TEST 2 (a client with only 3 legitimate targets gets exactly 3 -- never padded to reach the soft cap) PASSED')
  }

  // ---------------------------------------------------------------------
  // 3. Client with >8 materially distinct high-confidence targets -- soft
  // cap is deliberately exceeded rather than dropping real evidence.
  // ---------------------------------------------------------------------
  {
    const services = Array.from({ length: 10 }, (_, i) =>
      listItem(i, `Service ${i}`, { confidence: 'confirmed_by_direct_evidence', confirmationStatus: 'confirmed' }))
    const profile = makeProfile({ primaryProductsServices: services })
    const { targets, meta } = selectEntityBrandAuthorityTargets({ profile, topicClusters: [] })
    assert.strictEqual(targets.length, 10, 'all 10 materially distinct, AM-confirmed, direct-evidence services must survive -- none dropped just to respect the soft cap')
    assert.strictEqual(meta.exceededSoftCap, true)
    assert.strictEqual(meta.overflowCount, 2, '10 total - softCap 8 = 2 pushed past the cap by the overflow rule')
    log('TEST 3 (a client with more than 8 materially distinct, AM-confirmed, direct-evidence-backed targets exceeds the soft cap rather than dropping any of them) PASSED')
  }

  // ---------------------------------------------------------------------
  // 4. Confirmed intelligence outranks likely/unconfirmed intelligence,
  // even when the unconfirmed one has nominally stronger confidence.
  // ---------------------------------------------------------------------
  {
    const profile = makeProfile({
      primaryProductsServices: [
        listItem(0, 'Weak Evidence But AM Confirmed', { confidence: 'uncertain', confirmationStatus: 'confirmed' }),
        listItem(1, 'Strong Evidence But Never Confirmed', { confidence: 'confirmed_by_direct_evidence', confirmationStatus: 'unconfirmed' })
      ]
    })
    const { targets } = selectEntityBrandAuthorityTargets({ profile, topicClusters: [] })
    assert.strictEqual(targets[0].canonicalLabel, 'Weak Evidence But AM Confirmed', 'AM confirmation must outrank raw evidence confidence in ranking priority')
    log('TEST 4 (AM-confirmed intelligence outranks unconfirmed intelligence, even when the unconfirmed item carries stronger raw confidence) PASSED')
  }

  // ---------------------------------------------------------------------
  // 5. Primary service outranks secondary service (confirmation/confidence
  // tied).
  // ---------------------------------------------------------------------
  {
    const profile = makeProfile({
      primaryProductsServices: [listItem(0, 'Primary Thing', { confidence: 'likely', confirmationStatus: 'unconfirmed' })],
      secondaryProductsServices: [listItem(0, 'Secondary Thing', { confidence: 'likely', confirmationStatus: 'unconfirmed' })]
    })
    const { targets } = selectEntityBrandAuthorityTargets({ profile, topicClusters: [] })
    assert.strictEqual(targets[0].canonicalLabel, 'Primary Thing')
    assert.strictEqual(targets[1].canonicalLabel, 'Secondary Thing')
    log('TEST 5 (a primary service outranks a secondary service once confirmation status and confidence are tied) PASSED')
  }

  // ---------------------------------------------------------------------
  // 6. Strategic benchmark topic outranks non-strategic benchmark topic.
  // ---------------------------------------------------------------------
  {
    const topicClusters = [
      benchmarkCluster({ name: 'Non-Strategic Topic', business_priority: 'none' }),
      benchmarkCluster({ name: 'Strategic Topic', business_priority: 'strategic' })
    ]
    const { targets } = selectEntityBrandAuthorityTargets({ profile: makeProfile(), topicClusters })
    assert.strictEqual(targets[0].canonicalLabel, 'Strategic Topic', 'a strategic benchmark topic must outrank a non-strategic one when every other ranking key is tied')
    assert.strictEqual(targets[1].canonicalLabel, 'Non-Strategic Topic')
    log('TEST 6 (a strategic benchmark topic outranks a non-strategic benchmark topic) PASSED')
  }

  // ---------------------------------------------------------------------
  // 7. Candidate/non-benchmark topic cluster is excluded.
  // ---------------------------------------------------------------------
  {
    const topicClusters = [
      benchmarkCluster({ name: 'Approved Benchmark Topic' }),
      candidateCluster({ name: 'Unreviewed Candidate Topic' })
    ]
    const { targets } = selectEntityBrandAuthorityTargets({ profile: makeProfile(), topicClusters })
    assert.strictEqual(targets.length, 1)
    assert.strictEqual(targets[0].canonicalLabel, 'Approved Benchmark Topic')
    assert.ok(!targets.some(t => t.canonicalLabel === 'Unreviewed Candidate Topic'), 'an unreviewed candidate topic cluster must never become a target')
    log('TEST 7 (a candidate/non-benchmark topic cluster is excluded from targets entirely) PASSED')
  }

  // ---------------------------------------------------------------------
  // 8. Uncertain but evidence-backed target remains possible rather than
  // silently disappearing.
  // ---------------------------------------------------------------------
  {
    const profile = makeProfile({
      specialty: scalarField('Possible Niche', { confidence: 'uncertain', confirmationStatus: 'unconfirmed', evidence: [{ text: 'Thin but real evidence.', source: 'llm_classification', collectedAt: '2026-01-01T00:00:00.000Z' }] })
    })
    const { targets } = selectEntityBrandAuthorityTargets({ profile, topicClusters: [] })
    assert.strictEqual(targets.length, 1, 'an uncertain, unconfirmed, but genuinely evidenced target must still appear -- never silently dropped')
    assert.strictEqual(targets[0].confidence, 'uncertain')
    assert.strictEqual(targets[0].confirmationStatus, 'unconfirmed')
    assert.strictEqual(targets[0].evidence.length, 1)
    log('TEST 8 (an uncertain but evidence-backed target remains a real, visible target rather than silently disappearing) PASSED')
  }

  // ---------------------------------------------------------------------
  // 9. Empty intelligence returns zero targets.
  // ---------------------------------------------------------------------
  {
    const { targets, meta } = selectEntityBrandAuthorityTargets({ profile: makeProfile(), topicClusters: [] })
    assert.strictEqual(targets.length, 0)
    assert.strictEqual(meta.totalCandidates, 0)
    log('TEST 9 (empty Client/Industry Intelligence and zero benchmark topics returns zero targets, never fabricated ones) PASSED')
  }

  // ---------------------------------------------------------------------
  // 10. Service and specialty with similar wording remain separate (never
  // silently merged), with a conservative, deterministic possibleOverlap
  // flag where -- and only where -- an exact token-level relationship
  // exists.
  // ---------------------------------------------------------------------
  {
    const profile = makeProfile({
      specialty: scalarField('SEO Audits', { confidence: 'likely' }),
      primaryProductsServices: [listItem(0, 'SEO Audits', { confidence: 'likely' })]
    })
    const { targets } = selectEntityBrandAuthorityTargets({ profile, topicClusters: [] })
    assert.strictEqual(targets.length, 2, 'service and specialty must remain two separate targets even with identical wording')
    const specialty = targets.find(t => t.targetType === 'specialty')
    const service = targets.find(t => t.targetType === 'service')
    assert.ok(specialty && service, 'both a specialty target and a service target must exist independently')
    assert.strictEqual(specialty.possibleOverlap, true)
    assert.strictEqual(service.possibleOverlap, true)
    assert.notStrictEqual(specialty.sourceRef.fieldKey, service.sourceRef.fieldKey, 'they must retain their own distinct provenance, not be collapsed into one record')

    // Negative control -- genuinely unrelated wording must NOT be flagged.
    const unrelatedProfile = makeProfile({
      specialty: scalarField('Invisalign', { confidence: 'likely' }),
      primaryProductsServices: [listItem(0, 'Teeth Whitening', { confidence: 'likely' })]
    })
    const unrelated = selectEntityBrandAuthorityTargets({ profile: unrelatedProfile, topicClusters: [] }).targets
    assert.ok(unrelated.every(t => !t.possibleOverlap), 'genuinely unrelated specialty/service wording must never be flagged as overlapping')
    log('TEST 10 (service and specialty targets with identical/overlapping wording remain separate identities, conservatively flagged with possibleOverlap; unrelated wording is never falsely flagged) PASSED')
  }

  // ---------------------------------------------------------------------
  // 11. Aliases remain conservative.
  // ---------------------------------------------------------------------
  {
    const profile = makeProfile({
      specialty: scalarField('SEO', { confidence: 'likely' }),
      primaryProductsServices: [listItem(0, 'Search Engine Optimization', { confidence: 'likely' })],
      primaryGeographyMarkets: [listItem(0, 'Denver, CO', { confidence: 'likely' })]
    })
    const topicClusters = [benchmarkCluster({ name: 'SEO Pricing Questions' })]
    const { targets } = selectEntityBrandAuthorityTargets({ profile, topicClusters })
    assert.ok(targets.length > 0)
    for (const target of targets) {
      assert.deepStrictEqual(target.aliases, [], `${target.canonicalLabel} must have an empty aliases array -- no synonym (e.g. SEO <-> "Search Engine Optimization") may be invented even when it looks obvious`)
    }
    log('TEST 11 (aliases are always an empty array in this phase -- no synonym is ever invented, even an "obvious" one like SEO <-> Search Engine Optimization, since no existing intelligence/topic data actually asserts that relationship) PASSED')
  }

  // ---------------------------------------------------------------------
  // 12. sourceRef correctly identifies origin, for every target type.
  // ---------------------------------------------------------------------
  {
    const profile = makeProfile({
      specialty: scalarField('Family Law', { confidence: 'likely' }),
      primaryProductsServices: [listItem(0, 'Divorce Representation', { confidence: 'likely' })],
      secondaryProductsServices: [listItem(0, 'Mediation', { confidence: 'likely' })],
      primaryGeographyMarkets: [listItem(2, 'Austin, TX', { confidence: 'likely' })]
    })
    const topicClusters = [benchmarkCluster({ id: 'cluster-xyz', name: 'Best Family Lawyer in Austin' })]
    const { targets } = selectEntityBrandAuthorityTargets({ profile, topicClusters })

    const specialty = targets.find(t => t.targetType === 'specialty')
    assert.deepStrictEqual(specialty.sourceRef, { store: 'client_profile_fields', fieldKey: 'specialty', itemIndex: 0 })

    const primaryService = targets.find(t => t.canonicalLabel === 'Divorce Representation')
    assert.deepStrictEqual(primaryService.sourceRef, { store: 'client_profile_fields', fieldKey: 'primary_products_services', itemIndex: 0 })

    const secondaryService = targets.find(t => t.canonicalLabel === 'Mediation')
    assert.deepStrictEqual(secondaryService.sourceRef, { store: 'client_profile_fields', fieldKey: 'secondary_products_services', itemIndex: 0 })

    const geography = targets.find(t => t.targetType === 'geography')
    assert.deepStrictEqual(geography.sourceRef, { store: 'client_profile_fields', fieldKey: 'primary_geography_markets', itemIndex: 2 }, 'itemIndex must be preserved even when it is not 0')

    const topic = targets.find(t => t.targetType === 'topic')
    assert.deepStrictEqual(topic.sourceRef, { store: 'topic_cluster', clusterId: 'cluster-xyz' })
    log('TEST 12 (every target\'s sourceRef correctly and specifically identifies which client_profile_fields slot or topic_cluster row produced it) PASSED')
  }

  // ---------------------------------------------------------------------
  // 13. Deterministic ordering across repeated runs, regardless of input
  // array order.
  // ---------------------------------------------------------------------
  {
    const profile = makeProfile({
      specialty: scalarField('Orthodontics', { confidence: 'confirmed_by_direct_evidence', confirmationStatus: 'confirmed' }),
      primaryProductsServices: [
        listItem(0, 'Invisalign', { confidence: 'likely' }),
        listItem(1, 'Braces', { confidence: 'uncertain' })
      ],
      primaryGeographyMarkets: [listItem(0, 'Denver, CO', { confidence: 'likely' })]
    })
    const topicClusters = [
      benchmarkCluster({ name: 'Best Orthodontist Denver', business_priority: 'strategic' }),
      benchmarkCluster({ name: 'Invisalign Cost', business_priority: 'none' })
    ]
    const run1 = selectEntityBrandAuthorityTargets({ profile, topicClusters }).targets.map(t => t.canonicalLabel)
    const run2 = selectEntityBrandAuthorityTargets({ profile, topicClusters }).targets.map(t => t.canonicalLabel)
    assert.deepStrictEqual(run1, run2, 'repeated runs on identical input must produce identical order')

    // Reorder the list-field items and topic clusters -- order must still
    // come out the same, since ranking is a full sort, never insertion order.
    const reorderedProfile = makeProfile({
      specialty: profile.specialty,
      primaryProductsServices: [profile.primaryProductsServices[1], profile.primaryProductsServices[0]],
      primaryGeographyMarkets: profile.primaryGeographyMarkets
    })
    const reorderedClusters = [topicClusters[1], topicClusters[0]]
    const run3 = selectEntityBrandAuthorityTargets({ profile: reorderedProfile, topicClusters: reorderedClusters }).targets.map(t => t.canonicalLabel)
    assert.deepStrictEqual(run1, run3, 'reordering the input arrays must never change the output order -- ranking is a full deterministic sort')
    log('TEST 13 (ordering is fully deterministic across repeated runs and independent of input array order) PASSED')
  }

  // ---------------------------------------------------------------------
  // 14. No network calls. 15. No Supabase calls. 16. No LLM calls.
  // Verified by scanning this module's own source text: it has zero
  // require() statements of any kind (confirmed structurally, not just by
  // absence of a mock), so there is no code path by which it could reach
  // the network, Supabase, or an LLM -- these are source-level guarantees,
  // not runtime assertions.
  // ---------------------------------------------------------------------
  {
    const sourcePath = path.join(__dirname, 'entityBrandAuthorityTargets.js')
    const fullSource = fs.readFileSync(sourcePath, 'utf8')
    // This file's own comments legitimately discuss require()/Supabase/LLM
    // concepts at length (explaining WHY it avoids them) -- so a text scan
    // for real usage must strip comments first, or every one of those
    // explanatory sentences would trip a naive check. Line comments and
    // block comments are stripped (a plain, good-enough stripper -- this
    // file contains no string literal that itself contains "//" or "/*",
    // confirmed by inspection) before scanning what's left for actual code.
    const codeOnly = fullSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/require\s*\(/.test(codeOnly), 'this module must have zero require() statements in actual code -- any dependency at all reopens a path to Supabase/network/LLM code')
    assert.ok(!/\bfetch\s*\(/i.test(codeOnly), 'no fetch() call may exist in this module\'s actual code')
    assert.ok(!/supabase/i.test(codeOnly), 'the word "supabase" must never appear in this module\'s actual code (only in explanatory comments, already stripped here)')
    assert.ok(!/anthropic|callAnthropicTool|openai\b/i.test(codeOnly), 'this module must never reference an LLM call in actual code')
    assert.ok(!/XMLHttpRequest|axios|node-fetch|http\.request|https\.request/i.test(codeOnly), 'this module must never reference any other network-call mechanism in actual code')

    // Every exported function must be synchronous -- an async function
    // would be the first sign this module is doing I/O of some kind.
    const mod = require('./entityBrandAuthorityTargets')
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'function') {
        assert.strictEqual(value.constructor.name, 'Function', `${name} must be a plain synchronous function, never async (async would imply I/O)`)
      }
    }
    log('TEST 14/15/16 (no network calls, no Supabase calls, no LLM calls -- structurally guaranteed by zero require() statements and zero async functions, not just untested) PASSED')
  }

  console.log('\nAll lib/entityBrandAuthorityTargets.js pure tests passed (no network, no Supabase, no LLM).')
}

run()
