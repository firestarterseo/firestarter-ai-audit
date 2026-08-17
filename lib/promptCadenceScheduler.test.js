// Phase 2 test script -- the cadence/budget scheduler's pure core
// (computeDuePromptVariations) needs no database and no LLM call, so
// (unlike lib/clientProfileFields.test.js / lib/clientIndustryIntelligence.test.js,
// which require SUPABASE_SERVICE_ROLE_KEY) this script runs to completion
// in ANY environment, including the assistant's own sandbox, with zero
// credentials. Run with:
//   node lib/promptCadenceScheduler.test.js
// or:
//   npm run test:prompt-cadence

const assert = require('assert')
const { computeDuePromptVariations, cadenceDaysFor, DEFAULT_TESTING_CONFIG } = require('./promptCadenceScheduler')

function variation(overrides) {
  return {
    id: overrides.id,
    variation_type: 'core',
    status: 'active',
    last_tested_at: null,
    next_eligible_at: null,
    ...overrides
  }
}

function main() {
  const asOf = new Date('2026-08-17T12:00:00.000Z')
  const config = { core_cadence_days: 7, secondary_cadence_days: 28, max_prompts_per_cycle: 10 }

  // TEST 17a: a never-tested active variation is due immediately.
  {
    const { due } = computeDuePromptVariations([variation({ id: 'v1' })], config, asOf)
    assert.strictEqual(due.length, 1, 'TEST 17a: a never-tested active variation must be due')
    assert.strictEqual(due[0].id, 'v1')
  }
  console.log('TEST 17a PASSED (never-tested variation is due immediately)')

  // TEST 17b: a core variation tested 3 days ago (7-day cadence) is NOT due yet.
  {
    const lastTested = new Date(asOf.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const { due } = computeDuePromptVariations([variation({ id: 'v2', last_tested_at: lastTested })], config, asOf)
    assert.strictEqual(due.length, 0, 'TEST 17b: a core variation tested 3 days ago (7-day cadence) must not be due yet')
  }
  console.log('TEST 17b PASSED (not-yet-due core variation correctly excluded)')

  // TEST 17c: a core variation tested 10 days ago (7-day cadence) IS due.
  {
    const lastTested = new Date(asOf.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const { due } = computeDuePromptVariations([variation({ id: 'v3', last_tested_at: lastTested })], config, asOf)
    assert.strictEqual(due.length, 1, 'TEST 17c: a core variation tested 10 days ago (7-day cadence) must be due')
  }
  console.log('TEST 17c PASSED (overdue core variation correctly included)')

  // TEST 17d: secondary cadence (28 days) is honored independently of core cadence.
  {
    const lastTested = new Date(asOf.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString() // 10 days ago
    const { due } = computeDuePromptVariations([variation({ id: 'v4', variation_type: 'secondary', last_tested_at: lastTested })], config, asOf)
    assert.strictEqual(due.length, 0, 'TEST 17d: a secondary tested 10 days ago (28-day cadence) must not be due yet')
  }
  console.log('TEST 17d PASSED (secondary cadence honored independently of core cadence)')

  // TEST 17e: core-before-secondary ordering when both are due.
  {
    const variations = [
      variation({ id: 'sec1', variation_type: 'secondary' }),
      variation({ id: 'core1', variation_type: 'core' })
    ]
    const { due } = computeDuePromptVariations(variations, config, asOf)
    assert.strictEqual(due[0].id, 'core1', 'TEST 17e: core variations must sort before secondary variations when both are due')
  }
  console.log('TEST 17e PASSED (core sorted before secondary)')

  // TEST 17f: non-active variations (candidate/rejected/retired) are never due.
  {
    const variations = [
      variation({ id: 'cand', status: 'candidate' }),
      variation({ id: 'rej', status: 'rejected' }),
      variation({ id: 'ret', status: 'retired' })
    ]
    const { due } = computeDuePromptVariations(variations, config, asOf)
    assert.strictEqual(due.length, 0, 'TEST 17f: only status=active variations may ever be due')
  }
  console.log('TEST 17f PASSED (non-active variations never due)')

  // TEST 18: budget defers excess eligible prompts rather than dropping them.
  {
    const variations = Array.from({ length: 15 }, (_, i) => variation({ id: `v${i}` }))
    const tightConfig = { ...config, max_prompts_per_cycle: 10 }
    const { due, deferred } = computeDuePromptVariations(variations, tightConfig, asOf)
    assert.strictEqual(due.length, 10, 'TEST 18: due list must be capped at max_prompts_per_cycle')
    assert.strictEqual(deferred.length, 5, 'TEST 18: excess eligible variations must appear in deferred, not vanish')
    assert.ok(deferred.every(v => v.deferredDueToBudget === true), 'TEST 18: every deferred item must be flagged deferredDueToBudget')
    const allIds = new Set([...due.map(v => v.id), ...deferred.map(v => v.id)])
    assert.strictEqual(allIds.size, 15, 'TEST 18: every eligible variation must appear in due or deferred -- none silently dropped')
  }
  console.log('TEST 18 PASSED (budget defers rather than drops excess eligible prompts)')

  // Sanity: cadenceDaysFor falls back to documented defaults when unset.
  assert.strictEqual(cadenceDaysFor('core', {}), DEFAULT_TESTING_CONFIG.core_cadence_days)
  assert.strictEqual(cadenceDaysFor('secondary', {}), DEFAULT_TESTING_CONFIG.secondary_cadence_days)
  console.log('Default cadence fallback PASSED')

  console.log('\nAll Phase 2 cadence-scheduler tests passed (pure, no DB required).')
}

try {
  main()
} catch (err) {
  console.error('Phase 2 cadence-scheduler tests FAILED:', err)
  process.exit(1)
}
