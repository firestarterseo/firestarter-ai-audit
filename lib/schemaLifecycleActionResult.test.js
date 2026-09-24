// Tests for lib/schemaLifecycleActionResult.js -- 2026-09-24 Part 3/
// section 9 approval UX correction. Plain `node`, no framework.

const assert = require('assert')
const { resolveLifecycleActionOutcome } = require('./schemaLifecycleActionResult')

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

console.log(`\n${passCount} passed.`)
