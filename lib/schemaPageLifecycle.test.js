// Tests for lib/schemaPageLifecycle.js -- page lifecycle state (Phase B of
// the Schema page-workflow redesign). Plain `node`, no framework.

const assert = require('assert')
const {
  isResolvedState, isRecommendationEligible, deriveHomepageState,
  deriveStateFromAnalysis, getPageState, setPageState, excludedPathsFromStates
} = require('./schemaPageLifecycle')

let passCount = 0
function test(name, fn) {
  fn()
  passCount++
  console.log(`PASS: ${name}`)
}

// TEST 1: homepage 7/7 passing -> NO_ACTION_NEEDED (the exact live bug this
// phase fixes -- PRODUCT DECISION #3/#12).
test('Homepage 7/7 passing -> NO_ACTION_NEEDED', () => {
  assert.strictEqual(deriveHomepageState({ checksPassing: 7, checksTotal: 7 }), 'NO_ACTION_NEEDED')
})

// TEST 2: homepage failing some checks -> ACTIONABLE_GAP, stays recommendable.
test('Homepage 5/7 passing -> ACTIONABLE_GAP', () => {
  assert.strictEqual(deriveHomepageState({ checksPassing: 5, checksTotal: 7 }), 'ACTIONABLE_GAP')
})

// TEST 3: no real audit data at all -> UNANALYZED, never a guessed pass/fail.
test('No checksTotal -> UNANALYZED, not guessed', () => {
  assert.strictEqual(deriveHomepageState({}), 'UNANALYZED')
  assert.strictEqual(deriveHomepageState({ checksPassing: 0, checksTotal: 0 }), 'UNANALYZED')
})

// TEST 4: a successful page analysis with an actionable gap -> ACTIONABLE_GAP.
test('Successful analysis with a gap -> ACTIONABLE_GAP', () => {
  const state = deriveStateFromAnalysis({ fetchState: 'success', actionableGap: true })
  assert.strictEqual(state, 'ACTIONABLE_GAP')
})

// TEST 5: a successful page analysis with no gap -> NO_ACTION_NEEDED.
test('Successful analysis with no gap -> NO_ACTION_NEEDED', () => {
  const state = deriveStateFromAnalysis({ fetchState: 'success', actionableGap: false })
  assert.strictEqual(state, 'NO_ACTION_NEEDED')
})

// TEST 6: a FAILED fetch must never collapse into "no gap" -- stays
// UNANALYZED so it's never wrongly excluded from recommendations with zero
// real evidence.
test('Failed fetch -> UNANALYZED, never NO_ACTION_NEEDED', () => {
  const state = deriveStateFromAnalysis({ fetchState: 'failed', actionableGap: null })
  assert.strictEqual(state, 'UNANALYZED')
})

// TEST 7: NO_ACTION_NEEDED and COMPLETED are resolved / recommendation-
// ineligible; UNANALYZED, ACTIONABLE_GAP, WORK_IN_PROGRESS are not.
test('isResolvedState / isRecommendationEligible cover all 5 states correctly', () => {
  assert.strictEqual(isResolvedState('NO_ACTION_NEEDED'), true)
  assert.strictEqual(isResolvedState('COMPLETED'), true)
  assert.strictEqual(isResolvedState('UNANALYZED'), false)
  assert.strictEqual(isResolvedState('ACTIONABLE_GAP'), false)
  assert.strictEqual(isResolvedState('WORK_IN_PROGRESS'), false)
  assert.strictEqual(isRecommendationEligible('NO_ACTION_NEEDED'), false)
  assert.strictEqual(isRecommendationEligible('ACTIONABLE_GAP'), true)
})

// TEST 8: setPageState is immutable -- never mutates the Map passed in.
test('setPageState never mutates its input', () => {
  const original = new Map([['/a/', 'UNANALYZED']])
  const next = setPageState(original, '/a/', 'ACTIONABLE_GAP')
  assert.strictEqual(original.get('/a/'), 'UNANALYZED')
  assert.strictEqual(next.get('/a/'), 'ACTIONABLE_GAP')
})

// TEST 9: getPageState falls back to UNANALYZED for an unseen path.
test('getPageState falls back to UNANALYZED', () => {
  const states = new Map([['/a/', 'COMPLETED']])
  assert.strictEqual(getPageState(states, '/a/'), 'COMPLETED')
  assert.strictEqual(getPageState(states, '/never-seen/'), 'UNANALYZED')
})

// TEST 10: excludedPathsFromStates returns exactly the resolved paths.
test('excludedPathsFromStates returns exactly the resolved paths', () => {
  const states = new Map([
    ['/', 'NO_ACTION_NEEDED'],
    ['/service/', 'ACTIONABLE_GAP'],
    ['/old-page/', 'COMPLETED'],
    ['/blog/post/', 'UNANALYZED']
  ])
  const excluded = excludedPathsFromStates(states)
  assert.deepStrictEqual([...excluded].sort(), ['/', '/old-page/'])
})

console.log(`\n${passCount} passed.`)
