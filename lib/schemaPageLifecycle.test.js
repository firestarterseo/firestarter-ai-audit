// Tests for lib/schemaPageLifecycle.js -- page lifecycle state (Phase B of
// the Schema page-workflow redesign). Plain `node`, no framework.

const assert = require('assert')
const {
  isResolvedState, isRecommendationEligible, deriveHomepageState,
  deriveStateFromAnalysis, deriveCompletionOverride, getPageState, setPageState, excludedPathsFromStates,
  splitQueuedDossiers, isBatchEligibleState, deriveCurrentSchemaStatus, classifyWorkStage, classifyWorkItems
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

// TESTS 4-6b: updated for the DIAGNOSTIC METHODOLOGY pass (2026-09-03) --
// analyzePage() now returns a 4-value `finalStatus` (ACTION_REQUIRED /
// IMPROVEMENT_AVAILABLE / NO_ACTION_NEEDED / COULD_NOT_VERIFY) instead of
// the old boolean `actionableGap`. See lib/schemaPageLifecycle.js's
// deriveStateFromAnalysis header comment for the exact mapping.

// TEST 4: ACTION_REQUIRED -> ACTIONABLE_GAP.
test('Successful analysis, ACTION_REQUIRED -> ACTIONABLE_GAP', () => {
  const state = deriveStateFromAnalysis({ fetchState: 'success', finalStatus: 'ACTION_REQUIRED' })
  assert.strictEqual(state, 'ACTIONABLE_GAP')
})

// TEST 4b: IMPROVEMENT_AVAILABLE also -> ACTIONABLE_GAP -- a page with an
// available improvement is not "no action needed," so it stays
// recommendation-eligible even though its Core checks all passed.
test('Successful analysis, IMPROVEMENT_AVAILABLE -> ACTIONABLE_GAP (still recommendation-eligible)', () => {
  const state = deriveStateFromAnalysis({ fetchState: 'success', finalStatus: 'IMPROVEMENT_AVAILABLE' })
  assert.strictEqual(state, 'ACTIONABLE_GAP')
})

// TEST 5: NO_ACTION_NEEDED -> NO_ACTION_NEEDED, unchanged.
test('Successful analysis, NO_ACTION_NEEDED -> NO_ACTION_NEEDED', () => {
  const state = deriveStateFromAnalysis({ fetchState: 'success', finalStatus: 'NO_ACTION_NEEDED' })
  assert.strictEqual(state, 'NO_ACTION_NEEDED')
})

// TEST 6: a FAILED fetch must never collapse into "no gap" -- stays
// UNANALYZED so it's never wrongly excluded from recommendations with zero
// real evidence.
test('Failed fetch -> UNANALYZED, never NO_ACTION_NEEDED', () => {
  const state = deriveStateFromAnalysis({ fetchState: 'failed', finalStatus: 'COULD_NOT_VERIFY' })
  assert.strictEqual(state, 'UNANALYZED')
})

// TEST 6b: a successful fetch whose target profile is still
// LOCATION_UNCONFIRMED (finalStatus COULD_NOT_VERIFY even though the fetch
// itself succeeded) must ALSO stay UNANALYZED, for the identical reason --
// "we don't know which profile applies yet" is never allowed to collapse
// into "no gap found" any more than a fetch failure may.
test('Successful fetch but COULD_NOT_VERIFY (e.g. LOCATION_UNCONFIRMED) -> UNANALYZED, never NO_ACTION_NEEDED', () => {
  const state = deriveStateFromAnalysis({ fetchState: 'success', finalStatus: 'COULD_NOT_VERIFY' })
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

// TESTS 11-15: deriveCompletionOverride -- 2026-09-04d WORKFLOW CORRECTION.
// Durable evidence (executed + verified) always wins, and is the exact
// mechanism that lets the page-level workflow ADVANCE past a finished item
// to the next unfinished one (via excludedPathsFromStates ->
// computeRecommendedSet, unchanged).

// TEST 11: executed + verified -> COMPLETED.
test('Executed and verified -> COMPLETED', () => {
  const state = deriveCompletionOverride({ execution_status: 'executed', verification_status: 'verified' })
  assert.strictEqual(state, 'COMPLETED')
})

// TEST 12: a manual/RED handoff (human_completed) that was later verified
// live also counts -- completion is never tied to the WordPress-specific
// execution method.
test('human_completed and verified -> COMPLETED', () => {
  const state = deriveCompletionOverride({ execution_status: 'human_completed', verification_status: 'verified' })
  assert.strictEqual(state, 'COMPLETED')
})

// TEST 13: approved but not yet executed -> null, never guessed complete.
test('Approved but not executed -> null (still work in progress)', () => {
  assert.strictEqual(deriveCompletionOverride({ execution_status: 'not_started', verification_status: 'not_ready' }), null)
  assert.strictEqual(deriveCompletionOverride({ approval_status: 'approved' }), null)
})

// TEST 14: executed but not yet (or no longer) verified -> null. Deployed-
// but-unverified, or a genuine failed/inconclusive verification, must
// never be silently marked done.
test('Executed but not verified -> null', () => {
  assert.strictEqual(deriveCompletionOverride({ execution_status: 'executed', verification_status: 'not_ready' }), null)
  assert.strictEqual(deriveCompletionOverride({ execution_status: 'executed', verification_status: 'failed_verification' }), null)
  assert.strictEqual(deriveCompletionOverride({ execution_status: 'executed', verification_status: 'inconclusive' }), null)
})

// TEST 15: no opportunity at all -> null, never a crash.
test('No opportunity -> null', () => {
  assert.strictEqual(deriveCompletionOverride(null), null)
  assert.strictEqual(deriveCompletionOverride(undefined), null)
})

// ---------------------------------------------------------------------
// TESTS 16+: 2026-09-21 WORKFLOW CORRECTION -- active/completed queue
// split, batch eligibility, current-status precedence, and Generate&Review/
// Publish/Verify stage classification. Numbered against the correction
// spec's own 28-item regression list where a pure selector test applies;
// items 8/20/21/22/23 (explicit Re-analyze availability, distinct-per-step
// empty-state copy, no Deploy/Verify control without the right state) are
// UI-level and covered by the browser/live validation pass instead, not
// duplicated here as JSX tests per the spec's own "prefer pure selector/
// status tests where practical" instruction. Items 24-28 (WordPress
// execution / Verify Live / Phase 5 persistence / Phase 6 batch / Phase 3
// lifecycle regressions) are each covered by their own existing test file.
// ---------------------------------------------------------------------

// TEST 16 (spec items 1-3): splitQueuedDossiers -- a COMPLETED page leaves
// the active queue and appears in the completed group; NO_ACTION_NEEDED
// (resolved, but not "completed work") appears in neither; an unresolved
// page stays active. queuedPaths itself is never touched by this function
// -- it only ever regroups the SAME dossiers array passed in.
test('splitQueuedDossiers -- COMPLETED moves to completed, NO_ACTION_NEEDED drops from both, unresolved stays active', () => {
  const dossiers = [
    { path: '/about/', type: 'Service' },
    { path: '/contact/', type: 'Service' },
    { path: '/no-gap/', type: 'Service' },
    { path: '/industries/b2b/', type: 'Service' }
  ]
  const states = new Map([
    ['/about/', 'COMPLETED'],
    ['/contact/', 'COMPLETED'],
    ['/no-gap/', 'NO_ACTION_NEEDED'],
    ['/industries/b2b/', 'ACTIONABLE_GAP']
  ])
  const { activeQueuedDossiers, completedDossiers } = splitQueuedDossiers(dossiers, states)
  assert.deepStrictEqual(activeQueuedDossiers.map(d => d.path), ['/industries/b2b/'])
  assert.deepStrictEqual(completedDossiers.map(d => d.path).sort(), ['/about/', '/contact/'])
})

// TEST 17 (spec items 4-6): isBatchEligibleState -- the ONE shared rule
// behind checkbox selection / Select All Eligible / Analyze Selected /
// Prepare Selected in SchemaWizard.js's isSelectablePath. A completed (or
// otherwise resolved) page is never batch-eligible; an unresolved page is.
test('isBatchEligibleState -- false for COMPLETED/NO_ACTION_NEEDED, true otherwise', () => {
  assert.strictEqual(isBatchEligibleState('COMPLETED'), false)
  assert.strictEqual(isBatchEligibleState('NO_ACTION_NEEDED'), false)
  assert.strictEqual(isBatchEligibleState('ACTIONABLE_GAP'), true)
  assert.strictEqual(isBatchEligibleState('UNANALYZED'), true)
  assert.strictEqual(isBatchEligibleState('WORK_IN_PROGRESS'), true)
})

// TEST 18 (spec item 7): a page that is executed AND verified reports
// COMPLETED current status even though its opportunity's approval_status
// is still literally 'approved' -- this is the exact contradiction the
// audit found (a verified page still showing "Approved -- ready for
// execution"). Current lifecycle truth (COMPLETED/VERIFIED) outranks the
// stale approval-status field.
test('deriveCurrentSchemaStatus -- executed+verified overrides a lingering approved approval_status', () => {
  const status = deriveCurrentSchemaStatus({
    pageState: 'COMPLETED',
    opportunity: { approval_status: 'approved', execution_status: 'executed', verification_status: 'verified' }
  })
  assert.strictEqual(status.code, 'COMPLETED')
  assert.strictEqual(status.label, 'COMPLETED — VERIFIED LIVE')
})

// TEST 19: deriveCurrentSchemaStatus's full precedence ladder, one rung per
// the spec's own worked examples (item C).
test('deriveCurrentSchemaStatus -- full precedence ladder matches the spec\'s worked examples', () => {
  assert.strictEqual(
    deriveCurrentSchemaStatus({ pageState: 'ACTIONABLE_GAP', opportunity: { execution_status: 'executed', verification_status: 'not_ready' } }).code,
    'DEPLOYED'
  )
  assert.strictEqual(
    deriveCurrentSchemaStatus({ pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'approved', execution_status: 'not_started' } }).code,
    'APPROVED'
  )
  assert.strictEqual(
    deriveCurrentSchemaStatus({ pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'pending' } }).code,
    'AWAITING_APPROVAL'
  )
  assert.strictEqual(
    deriveCurrentSchemaStatus({ pageState: 'ACTIONABLE_GAP', opportunity: null }).code,
    'READY_TO_PREPARE'
  )
  assert.strictEqual(
    deriveCurrentSchemaStatus({ pageState: 'UNANALYZED', opportunity: null }).code,
    'NOT_ANALYZED'
  )
})

// TESTS 20-27 (spec items 9-19, 22-23): classifyWorkStage -- the single
// source of truth for which of Generate & Review / Publish / Verify /
// Completed a queued page's opportunity currently belongs to.

test('classifyWorkStage -- unanalyzed page is not review-stage work', () => {
  assert.strictEqual(classifyWorkStage({ pageState: 'UNANALYZED', opportunity: null }), 'not_active')
})

test('classifyWorkStage -- NO_ACTION_NEEDED page is not review-stage work', () => {
  assert.strictEqual(classifyWorkStage({ pageState: 'NO_ACTION_NEEDED', opportunity: null }), 'not_active')
})

test('classifyWorkStage -- analyzed actionable gap with no opportunity yet enters review', () => {
  assert.strictEqual(classifyWorkStage({ pageState: 'ACTIONABLE_GAP', opportunity: null }), 'review')
})

test('classifyWorkStage -- prepared work pending approval stays review-stage, not publish-ready', () => {
  const item = { pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'pending' } }
  assert.strictEqual(classifyWorkStage(item), 'review')
})

test('classifyWorkStage -- approved prepared work enters publish, no longer review', () => {
  const item = { pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'approved', execution_status: 'not_started' } }
  assert.strictEqual(classifyWorkStage(item), 'publish')
})

test('classifyWorkStage -- executed page enters verify (no Deploy/Verify control implied without the right state)', () => {
  const item = { pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'approved', execution_status: 'executed', verification_status: 'not_ready' } }
  assert.strictEqual(classifyWorkStage(item), 'verify')
})

test('classifyWorkStage -- failed verification remains verify-stage work, not completed', () => {
  const item = { pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'approved', execution_status: 'executed', verification_status: 'failed_verification' } }
  assert.strictEqual(classifyWorkStage(item), 'verify')
})

test('classifyWorkStage -- verified page leaves verify and enters completed', () => {
  const item = { pageState: 'COMPLETED', opportunity: { approval_status: 'approved', execution_status: 'executed', verification_status: 'verified' } }
  assert.strictEqual(classifyWorkStage(item), 'completed')
})

test('classifyWorkStage -- a rejected opportunity is not active work in any of the three stages', () => {
  const item = { pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'rejected' } }
  assert.strictEqual(classifyWorkStage(item), 'not_active')
})

// TEST 28: classifyWorkItems buckets a mixed batch correctly in one pass --
// the exact shape SchemaWizard.js builds reviewWorkItems/publishWorkItems/
// verificationWorkItems/completedWorkItems from.
test('classifyWorkItems -- buckets a mixed set of queued pages into the four stages', () => {
  const items = [
    { path: '/unanalyzed/', pageState: 'UNANALYZED', opportunity: null },
    { path: '/review/', pageState: 'ACTIONABLE_GAP', opportunity: null },
    { path: '/pending/', pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'pending' } },
    { path: '/publish/', pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'approved', execution_status: 'not_started' } },
    { path: '/verify/', pageState: 'ACTIONABLE_GAP', opportunity: { approval_status: 'approved', execution_status: 'executed', verification_status: 'not_ready' } },
    { path: '/about/', pageState: 'COMPLETED', opportunity: { approval_status: 'approved', execution_status: 'executed', verification_status: 'verified' } }
  ]
  const buckets = classifyWorkItems(items)
  assert.deepStrictEqual(buckets.review.map(i => i.path), ['/review/', '/pending/'])
  assert.deepStrictEqual(buckets.publish.map(i => i.path), ['/publish/'])
  assert.deepStrictEqual(buckets.verify.map(i => i.path), ['/verify/'])
  assert.deepStrictEqual(buckets.completed.map(i => i.path), ['/about/'])
})

console.log(`\n${passCount} passed.`)
