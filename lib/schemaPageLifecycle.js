// PAGE LIFECYCLE STATE -- Phase B of the Schema page-workflow redesign
// (2026-09-02). Pure, network-free, zero dependencies, same discipline as
// lib/schemaPageSelection.js (this file is its sibling: selection is
// OPEN/QUEUED, this file is the page's own analysis lifecycle -- the two
// are deliberately kept separate since a page can be queued without being
// analyzed, analyzed without being queued at all yet, etc.).
//
// PRODUCT DECISION #3 defines five states: UNANALYZED, ACTIONABLE_GAP,
// NO_ACTION_NEEDED, WORK_IN_PROGRESS, COMPLETED. This phase's real,
// wired-up transitions are UNANALYZED -> {ACTIONABLE_GAP, NO_ACTION_NEEDED}
// (via deriveStateFromAnalysis, once lib/pageAnalysis.js's analyzePage()
// returns) and the homepage's existing 7-check result -> {ACTIONABLE_GAP,
// NO_ACTION_NEEDED} (via deriveHomepageState, so PRODUCT DECISION #12's
// "homepage 7/7 -> NO_ACTION_NEEDED, excluded from recommendations" is a
// real function, not a one-off inline check in SchemaWizard.js).
// WORK_IN_PROGRESS and COMPLETED are real, first-class states in this
// module's vocabulary (isResolvedState/isRecommendationEligible already
// handle them correctly) but nothing in this phase transitions a page INTO
// them yet -- that requires the "prepared schema work" lifecycle PRODUCT
// DECISION #10 explicitly defers ("the page becomes eligible for prepared
// schema work in the next lifecycle step... do not create a Phase 3
// opportunity merely because the page was queued"). Naming them here now,
// even unused, means the NEXT phase extends a vocabulary that already
// accounts for them instead of renegotiating page states twice.
//
// CURRENT-RUN / UI-STATE-ONLY -- deliberate, matching lib/schemaPageSelection.js
// and lib/pageAnalysis.js. Nothing here reads or writes Supabase or any
// other persistent store; every function takes and returns a plain
// Map<path, state> that the CALLER owns as React state (or a local
// variable, in a test). Per PRODUCT DECISION #11: "if those states are
// still in-memory/UI-only, that is acceptable... we will wire durable
// lifecycle after diagnosis is correct."

const PAGE_STATES = ['UNANALYZED', 'ACTIONABLE_GAP', 'NO_ACTION_NEEDED', 'WORK_IN_PROGRESS', 'COMPLETED']

// RESOLVED_STATES -- a page in one of these states has nothing left for an
// AM to look at right now, and must never occupy a recommendation-batch
// slot (PRODUCT DECISION #11: "exclude pages with states NO_ACTION_NEEDED,
// COMPLETED, dismissed/not_applicable (if such state exists)"). This phase
// has no separate "dismissed" state -- NO_ACTION_NEEDED already covers "an
// AM looked, there's no real gap," which is what "dismissed" would mean in
// practice today; a distinct dismissed state is left for a later phase if
// AMs need to explicitly override an ACTIONABLE_GAP verdict.
const RESOLVED_STATES = ['NO_ACTION_NEEDED', 'COMPLETED']

function isResolvedState(state) {
  return RESOLVED_STATES.includes(state)
}

function isRecommendationEligible(state) {
  return !isResolvedState(state)
}

// deriveHomepageState({ checksPassing, checksTotal }) -> PAGE_STATES member.
// PRODUCT DECISION #3 / #12's exact rule: "if analyzed + all-applicable-
// checks-pass + no-actionable-issue then exclude from recommended batch."
// checksTotal === 0 (or missing) means no real audit data exists yet --
// UNANALYZED, never a guessed pass/fail.
function deriveHomepageState({ checksPassing, checksTotal } = {}) {
  if (typeof checksTotal !== 'number' || checksTotal <= 0) return 'UNANALYZED'
  return checksPassing === checksTotal ? 'NO_ACTION_NEEDED' : 'ACTIONABLE_GAP'
}

// deriveStateFromAnalysis(analysisResult) -> PAGE_STATES member.
// analysisResult is whatever lib/pageAnalysis.js's analyzePage() returned.
// Updated for the DIAGNOSTIC METHODOLOGY pass (2026-09-03): analyzePage()
// now returns a 4-value `finalStatus` (ACTION_REQUIRED / IMPROVEMENT_AVAILABLE
// / NO_ACTION_NEEDED / COULD_NOT_VERIFY) instead of the old boolean
// `actionableGap`. This deliberately maps onto the SAME 5-state page
// lifecycle vocabulary, unchanged -- this pass does not touch recommendation
// batching (lib/schemaPagePriority.js) or add a new lifecycle state:
//   ACTION_REQUIRED, IMPROVEMENT_AVAILABLE -> ACTIONABLE_GAP (both mean
//     "something for an AM to look at"; the UI still shows the more precise
//     finalStatus label to the AM even though the coarse lifecycle bucket
//     -- used only for recommendation-batch eligibility -- is shared)
//   NO_ACTION_NEEDED -> NO_ACTION_NEEDED (unchanged)
//   COULD_NOT_VERIFY -> UNANALYZED (extends the pre-existing "we couldn't
//     check this page" -> UNANALYZED discipline to also cover a page whose
//     LOCATION sub-profile is still LOCATION_UNCONFIRMED -- "we don't know
//     which target profile applies yet" must never collapse into "no gap
//     found" any more than a fetch failure may)
function deriveStateFromAnalysis(analysisResult) {
  if (!analysisResult || analysisResult.fetchState !== 'success') return 'UNANALYZED'
  switch (analysisResult.finalStatus) {
    case 'ACTION_REQUIRED':
    case 'IMPROVEMENT_AVAILABLE':
      return 'ACTIONABLE_GAP'
    case 'NO_ACTION_NEEDED':
      return 'NO_ACTION_NEEDED'
    case 'COULD_NOT_VERIFY':
    default:
      return 'UNANALYZED'
  }
}

// getPageState(states, path, fallback = 'UNANALYZED') -> PAGE_STATES member.
function getPageState(states, path, fallback = 'UNANALYZED') {
  if (!states) return fallback
  return states.get(path) || fallback
}

// deriveCompletionOverride(opportunity) -> 'COMPLETED' | null
// WORKFLOW CORRECTION (2026-09-04d): a page's Schema opportunity that has
// been executed (deployed to WordPress, or handed off and human-completed)
// AND live-verified is genuinely DONE -- real, durable evidence from the
// Phase 3/7 opportunity lifecycle, stronger than deriveStateFromAnalysis's
// local heuristic, which never re-runs on its own after a fix ships (an AM
// would otherwise keep seeing a page as ACTIONABLE_GAP forever, even after
// it was fixed, published, and confirmed live). This is what makes the
// page-level workflow actually ADVANCE ("mark completed, then recommend
// the next unfinished item") without inventing a parallel completion
// concept -- it is one more real signal fed into the SAME
// excludedPathsFromStates -> computeRecommendedSet pipeline
// lib/schemaPagePriority.js already uses for the homepage's own 7-check
// completion (deriveHomepageState) below.
// When this returns non-null it always wins over whatever
// deriveStateFromAnalysis said for the same page -- see SchemaWizard.js's
// pageStates derivation, which applies this AFTER the analysis-based pass
// for exactly that reason. Returns null (never guessed) for anything short
// of executed+verified, so a merely-approved or deployed-but-unverified
// page still correctly shows as work in progress, not silently done.
function deriveCompletionOverride(opportunity) {
  if (!opportunity) return null
  const executed = opportunity.execution_status === 'executed' || opportunity.execution_status === 'human_completed'
  if (executed && opportunity.verification_status === 'verified') return 'COMPLETED'
  return null
}

// setPageState(states, path, state) -> new Map. Immutable, same convention
// as lib/schemaPageSelection.js's toggleQueuedPath -- never mutates the Map
// passed in.
function setPageState(states, path, state) {
  const next = new Map(states)
  next.set(path, state)
  return next
}

// excludedPathsFromStates(states) -> Set<path> currently in a resolved
// state. This is the exact input lib/schemaPagePriority.js's
// computeRecommendedSet needs for its new `excludePaths` option -- kept as
// its own named function (rather than inlined at each call site) so
// "which pages are excluded from recommendation" is one tested concept.
function excludedPathsFromStates(states) {
  const excluded = new Set()
  if (!states) return excluded
  for (const [path, state] of states.entries()) {
    if (isResolvedState(state)) excluded.add(path)
  }
  return excluded
}

// ---------------------------------------------------------------------
// WORKFLOW CORRECTION (2026-09-21): SchemaWizard.js's UI never finished
// consuming the durable lifecycle above -- see the audit this pass
// implements. Everything below is presentation-layer derivation (still
// pure, still zero dependencies): which queue a page belongs in, whether
// it's batch-eligible, its one unambiguous current-status label, and which
// Generate&Review/Publish/Verify stage (if any) its opportunity currently
// occupies. Nothing here changes what deriveCompletionOverride/
// deriveStateFromAnalysis/deriveHomepageState decide -- it only decides
// how the wizard PRESENTS what they already decided.
// ---------------------------------------------------------------------

// splitQueuedDossiers(queuedDossiers, pageStates) -> { activeQueuedDossiers,
// completedDossiers }. A page whose durable state is COMPLETED moves to
// the completed group; every other queued page (including NO_ACTION_NEEDED,
// which needs no further work but isn't "completed work" either) stays out
// of the completed group -- NO_ACTION_NEEDED pages are dropped from both,
// same "needs nothing from an AM right now" treatment
// excludedPathsFromStates already gives them for recommendation purposes.
// Deliberately does NOT touch `queuedPaths`/any durable record -- this is
// presentation/eligibility grouping of the SAME queued-pages array, never
// destructive.
function splitQueuedDossiers(queuedDossiers, pageStates) {
  const activeQueuedDossiers = []
  const completedDossiers = []
  for (const dossier of queuedDossiers || []) {
    const state = getPageState(pageStates, dossier.path)
    if (state === 'COMPLETED') completedDossiers.push(dossier)
    else if (!isResolvedState(state)) activeQueuedDossiers.push(dossier)
  }
  return { activeQueuedDossiers, completedDossiers }
}

// isBatchEligibleState(state) -> the ONE shared eligibility rule for
// checkbox selection / Select All Eligible / Analyze Selected / Prepare
// Selected. A resolved page (COMPLETED or NO_ACTION_NEEDED) is never
// batch-eligible -- literally isRecommendationEligible under a name that
// reads correctly at its new call site (queue-row selectability), not a
// second rule. An explicit Re-analyze Page action is NEVER gated by this --
// see SchemaWizard.js's analyzePageNow, which every row's own button calls
// regardless of state, by design (item G of the correction: re-analysis
// must remain a single explicit action, never a batch one).
function isBatchEligibleState(state) {
  return isRecommendationEligible(state)
}

// CURRENT_SCHEMA_STATUS -- the exact precedence WORKFLOW CORRECTION item C
// specifies: COMPLETED/VERIFIED > EXECUTED/DEPLOYED > APPROVED > PREPARED >
// ANALYZED > QUEUED. Each entry is {code, label, tone} -- `tone` matches
// this app's existing `issue-badge issue-*` classes (SchemaWizard.js
// already uses issue-passing/issue-minor/issue-critical/issue-info for
// WordPress execution status; reused here rather than inventing a second
// badge vocabulary).
const CURRENT_SCHEMA_STATUS = {
  COMPLETED: { code: 'COMPLETED', label: 'COMPLETED — VERIFIED LIVE', tone: 'issue-passing' },
  VERIFICATION_FAILED: { code: 'VERIFICATION_FAILED', label: 'DEPLOYED — VERIFICATION FAILED', tone: 'issue-critical' },
  DEPLOYED: { code: 'DEPLOYED', label: 'DEPLOYED — AWAITING VERIFICATION', tone: 'issue-minor' },
  APPROVED: { code: 'APPROVED', label: 'APPROVED — READY TO PUBLISH', tone: 'issue-minor' },
  AWAITING_APPROVAL: { code: 'AWAITING_APPROVAL', label: 'AWAITING APPROVAL', tone: 'issue-minor' },
  REJECTED: { code: 'REJECTED', label: 'REJECTED', tone: 'issue-critical' },
  READY_TO_PREPARE: { code: 'READY_TO_PREPARE', label: 'READY TO PREPARE', tone: 'issue-info' },
  NO_ACTION_NEEDED: { code: 'NO_ACTION_NEEDED', label: 'NO ACTION NEEDED', tone: 'issue-passing' },
  NOT_ANALYZED: { code: 'NOT_ANALYZED', label: 'NOT ANALYZED', tone: 'issue-info' }
}

// deriveCurrentSchemaStatus({pageState, opportunity}) -> ONE entry from
// CURRENT_SCHEMA_STATUS, chosen by real lifecycle precedence -- never both
// a "Completed" fact and stale "Approved -- ready for execution" copy
// shown at once (the exact contradiction the audit found). This is the
// SINGLE place that precedence is decided; SchemaWizard.js must call this
// everywhere it previously read APPROVAL_STATUS_COPY/PAGE_STATE_LABELS
// directly for a page's headline status, not scatter the precedence logic
// across JSX.
function deriveCurrentSchemaStatus({ pageState, opportunity } = {}) {
  if (pageState === 'COMPLETED' || deriveCompletionOverride(opportunity) === 'COMPLETED') {
    return CURRENT_SCHEMA_STATUS.COMPLETED
  }
  if (opportunity) {
    const executed = opportunity.execution_status === 'executed' || opportunity.execution_status === 'human_completed'
    if (executed) {
      return opportunity.verification_status === 'failed_verification'
        ? CURRENT_SCHEMA_STATUS.VERIFICATION_FAILED
        : CURRENT_SCHEMA_STATUS.DEPLOYED
    }
    if (opportunity.approval_status === 'approved') return CURRENT_SCHEMA_STATUS.APPROVED
    if (opportunity.approval_status === 'pending') return CURRENT_SCHEMA_STATUS.AWAITING_APPROVAL
    if (opportunity.approval_status === 'rejected') return CURRENT_SCHEMA_STATUS.REJECTED
  }
  if (pageState === 'ACTIONABLE_GAP') return CURRENT_SCHEMA_STATUS.READY_TO_PREPARE
  if (pageState === 'NO_ACTION_NEEDED') return CURRENT_SCHEMA_STATUS.NO_ACTION_NEEDED
  return CURRENT_SCHEMA_STATUS.NOT_ANALYZED
}

// classifyWorkStage({pageState, opportunity}) -> 'review' | 'publish' |
// 'verify' | 'completed' | 'not_active'. The single source of truth for
// which of Steps 4/5/6 a page's opportunity currently belongs to -- see
// classifyWorkItems below, which SchemaWizard.js uses to build
// reviewWorkItems/publishWorkItems/verificationWorkItems/completedWorkItems
// instead of the old single generic activeWorkItem. 'not_active' covers
// UNANALYZED, NO_ACTION_NEEDED, and a REJECTED opportunity -- none of these
// occupy an active Step 4/5/6 slot (a rejected page keeps its existing
// Step 3 badge/history, untouched -- Phase 3 lifecycle semantics are not
// changed by this pass).
function classifyWorkStage({ pageState, opportunity } = {}) {
  if (pageState === 'COMPLETED' || deriveCompletionOverride(opportunity) === 'COMPLETED') return 'completed'
  if (opportunity) {
    const executed = opportunity.execution_status === 'executed' || opportunity.execution_status === 'human_completed'
    if (executed) return 'verify'
    if (opportunity.approval_status === 'approved') return 'publish'
    if (opportunity.approval_status === 'pending') return 'review'
    return 'not_active' // rejected, or any other approval_status
  }
  if (pageState === 'ACTIONABLE_GAP') return 'review'
  return 'not_active' // UNANALYZED, NO_ACTION_NEEDED, COULD_NOT_VERIFY (already folded into UNANALYZED)
}

// classifyWorkItems(items) -> {review, publish, verify, completed}, each an
// array of the SAME item shape passed in ({path, pageState, opportunity,
// ...anything else the caller wants carried through, e.g. dossier/analysis}).
// One pass, so a page can never land in two buckets or be silently dropped
// by an ordering bug between separate filter() calls.
function classifyWorkItems(items) {
  const buckets = { review: [], publish: [], verify: [], completed: [] }
  for (const item of items || []) {
    const stage = classifyWorkStage(item)
    if (buckets[stage]) buckets[stage].push(item)
  }
  return buckets
}

module.exports = {
  PAGE_STATES,
  RESOLVED_STATES,
  isResolvedState,
  isRecommendationEligible,
  deriveHomepageState,
  deriveStateFromAnalysis,
  deriveCompletionOverride,
  getPageState,
  setPageState,
  excludedPathsFromStates,
  splitQueuedDossiers,
  isBatchEligibleState,
  CURRENT_SCHEMA_STATUS,
  deriveCurrentSchemaStatus,
  classifyWorkStage,
  classifyWorkItems
}
