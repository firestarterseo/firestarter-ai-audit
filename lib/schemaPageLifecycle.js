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

module.exports = {
  PAGE_STATES,
  RESOLVED_STATES,
  isResolvedState,
  isRecommendationEligible,
  deriveHomepageState,
  deriveStateFromAnalysis,
  getPageState,
  setPageState,
  excludedPathsFromStates
}
