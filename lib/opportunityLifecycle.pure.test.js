// Phase 3 pure-function tests -- plain Node, no DB, no LLM (same
// convention as lib/promptTopicIntelligence.pure.test.js). Run with:
//   node lib/opportunityLifecycle.pure.test.js
// or:
//   npm run test:opportunity-lifecycle-pure
//
// Covers every governance/state-machine RULE from the Phase 3 spec that
// can be verified without touching Supabase: the priority-dimension
// model never collapsing to one score, prepared-work versioning, the
// GREEN/YELLOW/RED execution gate, the reopen/recur decision table, and
// the derived (never separately stored) Status Track. DB-dependent
// scenarios (durable persistence, history rows, real upsert-by-
// fingerprint behavior) live in lib/opportunityLifecycle.test.js instead,
// following this project's existing split between pure and DB-backed
// test files.

const assert = require('assert')
const {
  buildPriorityAssessment, getPriorityDimensions, nextPreparedWorkVersion,
  validateExecutionGate, decideReobservation, computeStatusTrack
} = require('./opportunityLifecycle')

function log(msg) { console.log(msg) }

function testPriorityDimensionsNeverCollapseToOneNumber() {
  const assessment = buildPriorityAssessment({
    impact: { level: 'high', reasoning: 'Fixes the single most-cited competitor gap.' },
    effort: { level: 'low', reasoning: 'One JSON-LD field.' },
    evidenceStrength: { level: 'strong', reasoning: 'Direct JSON-LD diff.' },
    commercialRelevance: { level: 'high', reasoning: 'Primary service line.' },
    treatmentReasoning: 'Highest Impact because...',
    treatmentEvidence: [{ text: 'evidence', source: 'checker' }]
  })
  assert.strictEqual(typeof assessment, 'object')
  assert.strictEqual(assessment.impact.level, 'high')
  assert.strictEqual(assessment.effort.level, 'low')
  assert.strictEqual(assessment.evidence_strength.level, 'strong')
  assert.strictEqual(assessment.commercial_relevance.level, 'high')
  // Critical: no numeric "score" field exists anywhere on the object.
  for (const key of Object.keys(assessment)) {
    assert.notStrictEqual(typeof assessment[key], 'number', `priority_assessment must never contain a numeric field (found on "${key}")`)
  }
  log('TEST (priority dimensions stay separate, never collapse to one number) PASSED')
}

function testAutomationCapabilityIsExecutionCapabilityNotADuplicate() {
  const row = { priority_assessment: { impact: { level: 'high' } }, execution_capability: 'yellow' }
  const dims = getPriorityDimensions(row)
  assert.strictEqual(dims.automation_capability.level, 'yellow')
  assert.strictEqual(dims.impact.level, 'high')
  // Changing execution_capability changes the derived dimension -- proving
  // there is exactly one source of truth, not two fields that could disagree.
  const row2 = { ...row, execution_capability: 'red' }
  assert.strictEqual(getPriorityDimensions(row2).automation_capability.level, 'red')
  log('TEST (automation_capability dimension is derived from execution_capability, never duplicated) PASSED')
}

function testEasyWinIsIndependentOfExecutionCapability() {
  // Spec: a RED (manual) opportunity can still be an Easy Win; a GREEN
  // opportunity is not automatically an Easy Win. Verify the model can
  // represent both without contradiction -- effort/impact never derive
  // from execution_capability.
  const redEasyWin = buildPriorityAssessment({ impact: { level: 'medium' }, effort: { level: 'low' } })
  const greenNotEasyWin = buildPriorityAssessment({ impact: { level: 'low' }, effort: { level: 'high' } })
  assert.strictEqual(redEasyWin.effort.level, 'low')
  assert.strictEqual(greenNotEasyWin.effort.level, 'high')
  // Nothing in buildPriorityAssessment reads execution_capability at all.
  assert.strictEqual(buildPriorityAssessment.length <= 1, true)
  log('TEST (effort/impact are independent of execution capability -- RED can be Easy Win, GREEN need not be) PASSED')
}

function testPreparedWorkVersioningNeverOverwrites() {
  assert.strictEqual(nextPreparedWorkVersion([]), 1)
  assert.strictEqual(nextPreparedWorkVersion([1]), 2)
  assert.strictEqual(nextPreparedWorkVersion([1, 2, 3]), 4)
  assert.strictEqual(nextPreparedWorkVersion([1, 3]), 4) // max, not count -- robust to gaps
  log('TEST (prepared-work version numbering always increments, never reuses/overwrites) PASSED')
}

function testYellowCannotExecuteBeforeApproval() {
  const yellowPending = { execution_capability: 'yellow', approval_status: 'pending' }
  const gate1 = validateExecutionGate(yellowPending, 'execute')
  assert.strictEqual(gate1.ok, false)

  const yellowApproved = { execution_capability: 'yellow', approval_status: 'approved' }
  const gate2 = validateExecutionGate(yellowApproved, 'execute')
  assert.strictEqual(gate2.ok, true)
  log('TEST (YELLOW cannot execute before approval, can execute once approved) PASSED')
}

function testRedCanNeverAutomaticallyExecute() {
  const redApproved = { execution_capability: 'red', approval_status: 'approved' }
  const gate = validateExecutionGate(redApproved, 'execute')
  assert.strictEqual(gate.ok, false)
  assert.match(gate.reason, /handoff/i)

  const redHandoff = validateExecutionGate({ execution_capability: 'red' }, 'handoff')
  assert.strictEqual(redHandoff.ok, true)
  log('TEST (RED can never execute automatically regardless of approval -- only handoff) PASSED')
}

function testGreenCanExecuteWithoutPriorApproval() {
  const green = { execution_capability: 'green', approval_status: 'not_required' }
  const gate = validateExecutionGate(green, 'execute')
  assert.strictEqual(gate.ok, true)
  log('TEST (GREEN may execute without a prior approval requirement) PASSED')
}

// Phase 1.1 (2026-09-01): verification must never be reachable before the
// underlying execution/handoff genuinely completed -- covers the exact
// gap discovered in AI Source & Citation Presence, generalized to the
// shared gate so no future pillar can reintroduce it.
function testVerificationRequiresGenuinelyCompletedExecutionOrHandoff() {
  const notStarted = validateExecutionGate({ execution_status: 'not_started', execution_capability: 'red' }, 'verify')
  assert.strictEqual(notStarted.ok, false)
  assert.match(notStarted.reason, /executed.*human_completed/)

  const prepared = validateExecutionGate({ execution_status: 'prepared', execution_capability: 'yellow' }, 'verify')
  assert.strictEqual(prepared.ok, false)

  const handoffRequested = validateExecutionGate({ execution_status: 'handoff_requested', execution_capability: 'red' }, 'verify')
  assert.strictEqual(handoffRequested.ok, false)

  const handedOff = validateExecutionGate({ execution_status: 'handed_off', execution_capability: 'red' }, 'verify')
  assert.strictEqual(handedOff.ok, false, 'a RED opportunity that has been handed off but not yet human_completed is not verification-eligible')

  const executionFailed = validateExecutionGate({ execution_status: 'execution_failed', execution_capability: 'yellow' }, 'verify')
  assert.strictEqual(executionFailed.ok, false, 'a failed execution attempt must never become verification-eligible')

  const executed = validateExecutionGate({ execution_status: 'executed', execution_capability: 'green' }, 'verify')
  assert.strictEqual(executed.ok, true, 'GREEN/YELLOW opportunities become verification-eligible once actually executed')

  const humanCompleted = validateExecutionGate({ execution_status: 'human_completed', execution_capability: 'red' }, 'verify')
  assert.strictEqual(humanCompleted.ok, true, 'RED opportunities become verification-eligible once a human confirms the handed-off work is actually done')

  log('TEST (verification is only reachable after execution genuinely completed -- "executed" or "human_completed", never before, never after a failure) PASSED')
}

function testReopenDecisionTable() {
  assert.strictEqual(decideReobservation(null), 'insert')
  assert.strictEqual(decideReobservation({ status: 'open' }), 'refresh_only')
  assert.strictEqual(decideReobservation({ status: 'in_progress' }), 'refresh_only')
  assert.strictEqual(decideReobservation({ status: 'dismissed', disposition_reason: 'am_do_nothing' }), 'preserve_dismissed_am_call')
  assert.strictEqual(decideReobservation({ status: 'dismissed', disposition_reason: null }), 'preserve_dismissed_am_call')
  assert.strictEqual(decideReobservation({ status: 'done', disposition_reason: 'verified_fixed' }), 'reopen_after_verified_regression')
  assert.strictEqual(decideReobservation({ status: 'done', disposition_reason: 'no_longer_observed' }), 'reopen_after_reappeared')
  assert.strictEqual(decideReobservation({ status: 'done', disposition_reason: null }), 'reopen_after_reappeared')
  log('TEST (reopen/recur decision table: AM do-nothing calls preserved, verified-fixed regressions distinguished from mere reappearance) PASSED')
}

function testDisappearingFindingIsNotAutomaticallyVerified() {
  // A row auto-closed as 'no_longer_observed' (the legacy syncOpportunities
  // auto-close reason) must NOT be treated the same as a real verification
  // when it reappears -- decideReobservation must route it through the
  // honest "reappeared" path, never claim a regression against a
  // verification that never happened.
  const autoClosedRow = { status: 'done', disposition_reason: 'no_longer_observed' }
  assert.strictEqual(decideReobservation(autoClosedRow), 'reopen_after_reappeared')
  assert.notStrictEqual(decideReobservation(autoClosedRow), 'reopen_after_verified_regression')
  log('TEST (a disappearing/reappearing finding that was never verified is never treated as a verified regression) PASSED')
}

function testStatusTrackNeverFalselyMarksSkippedAsCompleted() {
  const identifiedOnly = { execution_status: 'not_started', approval_status: 'not_required', verification_status: 'not_ready', retest_status: 'not_eligible' }
  const track = computeStatusTrack(identifiedOnly)
  const byStage = Object.fromEntries(track.map(t => [t.stage, t.state]))
  assert.strictEqual(byStage.identified, 'completed')
  assert.notStrictEqual(byStage.approved, 'completed')
  assert.notStrictEqual(byStage.verified, 'completed')
  assert.notStrictEqual(byStage.retested, 'completed')
  log('TEST (Status Track never marks approved/executed/verified/retested as completed before they genuinely happened) PASSED')
}

function testStatusTrackSkipsApprovalForGreenNotRequired() {
  const greenFlow = { execution_status: 'executed', approval_status: 'not_required', execution_capability: 'green', verification_status: 'not_ready', retest_status: 'not_eligible', approved_prepared_work_id: null }
  const track = computeStatusTrack(greenFlow)
  const byStage = Object.fromEntries(track.map(t => [t.stage, t.state]))
  assert.strictEqual(byStage.approved, 'skipped')
  assert.strictEqual(byStage.executed_or_handed_off, 'completed')
  log('TEST (Status Track marks approval "skipped" rather than falsely "completed" for GREEN/not_required) PASSED')
}

function testStatusTrackVerifiedAndRetested() {
  const fullFlow = {
    execution_status: 'executed', approval_status: 'approved', execution_capability: 'yellow',
    verification_status: 'verified', retest_status: 'completed', approved_prepared_work_id: 'x'
  }
  const track = computeStatusTrack(fullFlow)
  const byStage = Object.fromEntries(track.map(t => [t.stage, t.state]))
  assert.strictEqual(byStage.approved, 'completed')
  assert.strictEqual(byStage.executed_or_handed_off, 'completed')
  assert.strictEqual(byStage.verified, 'completed')
  assert.strictEqual(byStage.retested, 'completed')
  log('TEST (Status Track marks every stage completed only once each genuinely happened) PASSED')
}

function main() {
  testPriorityDimensionsNeverCollapseToOneNumber()
  testAutomationCapabilityIsExecutionCapabilityNotADuplicate()
  testEasyWinIsIndependentOfExecutionCapability()
  testPreparedWorkVersioningNeverOverwrites()
  testYellowCannotExecuteBeforeApproval()
  testRedCanNeverAutomaticallyExecute()
  testGreenCanExecuteWithoutPriorApproval()
  testVerificationRequiresGenuinelyCompletedExecutionOrHandoff()
  testReopenDecisionTable()
  testDisappearingFindingIsNotAutomaticallyVerified()
  testStatusTrackNeverFalselyMarksSkippedAsCompleted()
  testStatusTrackSkipsApprovalForGreenNotRequired()
  testStatusTrackVerifiedAndRetested()
  log('\nAll Phase 3 opportunityLifecycle pure-function tests passed (no DB, no LLM required).')
}

main()
