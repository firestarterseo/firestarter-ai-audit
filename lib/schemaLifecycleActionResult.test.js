// Tests for lib/schemaLifecycleActionResult.js -- 2026-09-24 Part 3/
// section 9 approval UX correction. Plain `node`, no framework.

const assert = require('assert')
const { resolveLifecycleActionOutcome, resolveApprovalAction, resolveRejectionAction } = require('./schemaLifecycleActionResult')

let passCount = 0
function test(name, fn) { fn(); passCount++; console.log(`PASS: ${name}`) }

test('successful server approval, confirmed by the follow-up re-read -> confirmed:true, no error', () => {
  const outcome = resolveLifecycleActionOutcome({ ok: true, status: 200, body: { result: { approvalStatus: 'approved' } }, refreshConfirmed: true })
  assert.strictEqual(outcome.confirmed, true)
  assert.strictEqual(outcome.error, null)
})

test('failed approval (server rejects) -> confirmed:false, the server\'s own error message surfaced', () => {
  const outcome = resolveLifecycleActionOutcome({ ok: false, status: 409, body: { error: 'Lifecycle invariant violated.' }, refreshConfirmed: false })
  assert.strictEqual(outcome.confirmed, false)
  assert.strictEqual(outcome.error, 'Lifecycle invariant violated.')
})

test('failed approval with no parsable body -> confirmed:false, a generic HTTP-status error, never blank', () => {
  const outcome = resolveLifecycleActionOutcome({ ok: false, status: 500, body: null, refreshConfirmed: false })
  assert.strictEqual(outcome.confirmed, false)
  assert.strictEqual(outcome.error, 'Request failed (HTTP 500).')
})

test('server approval succeeds, but the follow-up re-read fails -> confirmed:false with an explicit "could not be confirmed" error, never silently treated as approved', () => {
  const outcome = resolveLifecycleActionOutcome({ ok: true, status: 200, body: { result: {} }, refreshConfirmed: false })
  assert.strictEqual(outcome.confirmed, false)
  assert.ok(/could not be confirmed/.test(outcome.error))
})

test('stale/refetch state never falsely reports confirmed -- confirmed is ONLY true when both the POST and the re-read succeeded', () => {
  assert.strictEqual(resolveLifecycleActionOutcome({ ok: true, status: 200, body: {}, refreshConfirmed: false }).confirmed, false)
  assert.strictEqual(resolveLifecycleActionOutcome({ ok: false, status: 400, body: {}, refreshConfirmed: true }).confirmed, false)
  assert.strictEqual(resolveLifecycleActionOutcome({ ok: true, status: 200, body: {}, refreshConfirmed: true }).confirmed, true)
})

// ---------------------------------------------------------------------
// resolveApprovalAction / resolveRejectionAction -- the "click Approve" /
// "click Reject" interaction mapping (2026-09-24 Approve-button
// investigation, section 7). Two independent live-browser tests against
// the real deployed Step 4 review layout (fetch intercepted before the
// network) already proved the exact same {action, extra} shape these
// functions produce is what actually gets sent -- see that turn's report.
// These tests pin the mapping itself as a permanent regression.
// ---------------------------------------------------------------------
test('resolveApprovalAction: a system-generated version -> action "approve", with its own id as preparedWorkId', () => {
  const result = resolveApprovalAction({ id: '800bf489-3023-4dee-9292-ce0d1e54717a', created_by: 'system' })
  assert.strictEqual(result.action, 'approve')
  assert.deepStrictEqual(result.extra, { preparedWorkId: '800bf489-3023-4dee-9292-ce0d1e54717a' })
})

test('resolveApprovalAction: an AM-edited version -> action "edit_then_approve", never plain "approve"', () => {
  const result = resolveApprovalAction({ id: 'edited-version-id', created_by: 'am' })
  assert.strictEqual(result.action, 'edit_then_approve')
  assert.deepStrictEqual(result.extra, { preparedWorkId: 'edited-version-id' })
})

test('resolveRejectionAction: always action "reject" with reason "am_rejected"', () => {
  assert.deepStrictEqual(resolveRejectionAction(), { action: 'reject', extra: { reason: 'am_rejected' } })
})

test('resolveApprovalAction matches the exact real Firestarter Service opportunity click observed live (version 2, created_by: system)', () => {
  // The exact prepared-work id/created_by this session's real, intercepted
  // (never sent) live click against production actually produced.
  const result = resolveApprovalAction({ id: '800bf489-3023-4dee-9292-ce0d1e54717a', created_by: 'system' })
  assert.deepStrictEqual(result, { action: 'approve', extra: { preparedWorkId: '800bf489-3023-4dee-9292-ce0d1e54717a' } })
})

console.log(`\n${passCount} passed.`)
