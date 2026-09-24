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

// ---------------------------------------------------------------------
// INTERACTION MAPPING (2026-09-24, Approve-button investigation, section
// 7). Two independent live-browser click tests against the real deployed
// Step 4 review layout (Approve and Reject, fetch intercepted before it
// ever reached the network) already proved the button->handler->fetch
// chain is wired correctly end-to-end, with the exact request this repo
// has no DOM/component-test harness to re-run automatically. What CAN be
// pinned as a permanent, plain-`node` regression is the one pure decision
// PreparedWorkPanel's Approve/Reject buttons rely on: WHICH action string
// and WHICH extra body fields a click should produce, given the prepared-
// work version being acted on. Extracted here (unchanged logic, moved out
// of app/clients/[id]/SchemaWizard.js's approvePreparedWork/
// rejectPreparedWork) so that mapping itself -- the one part of this chain
// that actually varies by input and could regress silently -- is
// independently, permanently testable without a browser.
// ---------------------------------------------------------------------

// resolveApprovalAction(latest) -> {action, extra}. 'approve' for a
// system-generated version; 'edit_then_approve' ONLY when the version
// being approved was itself AM-edited (created_by: 'am') -- see
// lib/opportunityLifecycle.js#approveOpportunity's own doc comment on why
// that distinction is never invented for a version nobody actually edited.
function resolveApprovalAction(latest) {
  const action = latest && latest.created_by === 'am' ? 'edit_then_approve' : 'approve'
  return { action, extra: { preparedWorkId: latest && latest.id } }
}

// resolveRejectionAction() -> {action, extra}. Reject never varies by
// input today -- kept as a function (not a constant) so a future reason-
// picker UI has one obvious place to extend without touching the click
// handler itself.
function resolveRejectionAction() {
  return { action: 'reject', extra: { reason: 'am_rejected' } }
}

module.exports = { resolveLifecycleActionOutcome, resolveApprovalAction, resolveRejectionAction }
