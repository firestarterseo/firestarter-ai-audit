// APPROVAL UX CORRECTION (2026-09-24, Part 3/section 9). Pure, network-
// free -- extracts the ONE decision app/clients/[id]/SchemaWizard.js's
// runOpportunityLifecycleAction makes after every Approve/Reject/Edit
// click, so it's testable without a DOM (this codebase deliberately has no
// React/DOM test harness -- see every other lib/*.js module's own header).
//
// REQUIRED BEHAVIOR (section 9): Approve clicked -> server confirms
// approval -> refreshed server state confirms approval -> UI shows
// APPROVED. If server approval fails: UI remains AWAITING APPROVAL and
// displays a visible error. Never optimistically show APPROVED without
// confirmed persisted state.
//
// resolveLifecycleActionOutcome({ ok, status, body, refreshConfirmed }) ->
// { error: string|null, confirmed: boolean }.
//   - `ok`/`status`/`body`: the lifecycle POST's own fetch Response
//     (`ok`/`status`) and parsed JSON body (or null if unparsable).
//   - `refreshConfirmed`: whether the FOLLOW-UP re-read (the GET that
//     re-hydrates preparedWorkByPath from the server) itself succeeded --
//     the UI must never show a post-action status (approved, rejected,
//     ...) on the strength of the POST alone; it only ever reflects
//     whatever this fresh read actually returned.
//
// `confirmed: true` is the ONLY case where the caller may consider the
// action's effect trustworthy; `confirmed: false` always pairs with a
// non-null `error` the caller must surface, never silently swallowed.
function resolveLifecycleActionOutcome({ ok, status, body, refreshConfirmed }) {
  if (!ok) {
    return { error: (body && body.error) || `Request failed (HTTP ${status}).`, confirmed: false }
  }
  if (!refreshConfirmed) {
    return {
      error: 'This action was saved, but the current status could not be confirmed -- refresh the page to check.',
      confirmed: false
    }
  }
  return { error: null, confirmed: true }
}

module.exports = { resolveLifecycleActionOutcome }
