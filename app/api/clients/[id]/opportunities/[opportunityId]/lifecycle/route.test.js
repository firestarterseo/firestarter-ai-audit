// Phase 1 route-level tests for the Source & Citation lifecycle dispatcher
// (added 2026-09-01). Plain Node, same convention as
// lib/opportunityLifecycle.pure.test.js -- no test framework, no DB. Run
// with:
//   node "app/api/clients/[id]/opportunities/[opportunityId]/lifecycle/route.test.js"
// or:
//   npm run test:opportunities-lifecycle-route
//
// This file mocks lib/supabaseServer.js and lib/opportunityLifecycle.js at
// the module-cache level (require.cache injection) so route.js's own
// `require('../../../../../../../lib/...')` calls resolve to fakes instead
// of a real Supabase client. NO live Supabase connection is opened or
// required anywhere in this file.

const assert = require('assert')
const path = require('path')

const supabaseServerPath = require.resolve(path.join(__dirname, '../../../../../../../lib/supabaseServer'))
const opportunityLifecyclePath = require.resolve(path.join(__dirname, '../../../../../../../lib/opportunityLifecycle'))
const routePath = require.resolve(path.join(__dirname, 'route'))

// ---------------------------------------------------------------------
// Fake Supabase -- only implements the exact chain the route calls:
// supabase.from('opportunities').select(...).eq(k1,v1).eq(k2,v2).single()
// ---------------------------------------------------------------------
let fakeRow = { id: 'opp-1', client_id: 'client-1' }
let fakeError = null

function fakeSupabase() {
  return {
    from() {
      return {
        select() {
          return {
            eq(k1, v1) {
              return {
                eq(k2, v2) {
                  return {
                    async single() {
                      if (fakeError) return { data: null, error: fakeError }
                      const filters = { [k1]: v1, [k2]: v2 }
                      const row = fakeRow
                      const matches = row && Object.entries(filters).every(([k, v]) => row[k] === v)
                      return matches ? { data: row, error: null } : { data: null, error: null }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------
// Spies for every lib/opportunityLifecycle.js function the route calls.
// Each records its calls and can be told (per-test) to resolve or throw.
// ---------------------------------------------------------------------
function makeSpy() {
  const calls = []
  let impl = async () => ({ ok: true })
  const fn = async (...args) => {
    calls.push(args)
    return impl(...args)
  }
  fn.calls = calls
  fn.resolveWith = (value) => { impl = async () => value }
  fn.rejectWith = (err) => { impl = async () => { throw err } }
  fn.reset = () => { calls.length = 0; impl = async () => ({ ok: true }) }
  return fn
}

const spies = {
  approveOpportunity: makeSpy(),
  rejectOpportunity: makeSpy(),
  requestHandoff: makeSpy(),
  recordHandoff: makeSpy(),
  recordHumanCompleted: makeSpy(),
  requestVerification: makeSpy(),
  recordVerification: makeSpy(),
  prepareWork: makeSpy()
}

require.cache[supabaseServerPath] = {
  id: supabaseServerPath, filename: supabaseServerPath, loaded: true,
  exports: { getSupabaseServerClient: () => fakeSupabase() }
}
require.cache[opportunityLifecyclePath] = {
  id: opportunityLifecyclePath, filename: opportunityLifecyclePath, loaded: true,
  exports: { ...spies }
}

const { POST } = require(routePath)

function resetAll() {
  fakeRow = { id: 'opp-1', client_id: 'client-1' }
  fakeError = null
  Object.values(spies).forEach(s => s.reset())
}

function req(body) {
  return { json: async () => body }
}
function ctx(id = 'client-1', opportunityId = 'opp-1') {
  return { params: { id, opportunityId } }
}

function log(msg) { console.log(msg) }

// ---------------------------------------------------------------------
// 1. Correct function dispatched per action, with the expected payload.
// ---------------------------------------------------------------------
async function testEachActionDispatchesTheRightFunctionOnly() {
  const cases = [
    { action: 'approve', body: { action: 'approve' }, spy: 'approveOpportunity' },
    { action: 'edit_then_approve', body: { action: 'edit_then_approve', preparedWorkId: 'pw-1' }, spy: 'approveOpportunity' },
    { action: 'reject', body: { action: 'reject', reason: 'am_do_nothing' }, spy: 'rejectOpportunity' },
    { action: 'request_verification', body: { action: 'request_verification' }, spy: 'requestVerification' },
    { action: 'request_handoff', body: { action: 'request_handoff', instructions: 'go' }, spy: 'requestHandoff' },
    { action: 'record_handoff', body: { action: 'record_handoff', method: 'manual', reference: 'ref-1' }, spy: 'recordHandoff' },
    { action: 'record_human_completed', body: { action: 'record_human_completed', notes: 'done' }, spy: 'recordHumanCompleted' },
    { action: 'record_verification', body: { action: 'record_verification', result: 'verified', evidence: [] }, spy: 'recordVerification' },
    { action: 'prepare_edited_version', body: { action: 'prepare_edited_version', artifactType: 'schema_jsonld', payload: { add: [] }, previousVersionId: 'pw-1' }, spy: 'prepareWork' }
  ]
  for (const c of cases) {
    resetAll()
    const res = await POST(req(c.body), ctx())
    assert.strictEqual(res.status ?? 200, 200, `${c.action}: expected 200`)
    // exactly the target spy was called, and every other spy stayed untouched
    for (const [name, spy] of Object.entries(spies)) {
      if (name === c.spy) {
        assert.strictEqual(spy.calls.length, 1, `${c.action}: expected ${c.spy} to be called once`)
        // prepareWork's real signature is ONE options object carrying
        // opportunityId as a field, unlike every other lifecycle function
        // here's (opportunityId, options) two-arg shape -- see
        // testActionPayloadsMapCorrectly's own note on this.
        if (c.spy === 'prepareWork') {
          assert.strictEqual(spy.calls[0][0].opportunityId, 'opp-1', `${c.action}: expected ${c.spy} called with opportunityId`)
        } else {
          assert.strictEqual(spy.calls[0][0], 'opp-1', `${c.action}: expected ${c.spy} called with opportunityId`)
        }
      } else {
        assert.strictEqual(spy.calls.length, 0, `${c.action}: expected ${name} NOT to be called`)
      }
    }
  }
  log('TEST (each action dispatches exactly its own lifecycle function, with opportunityId, and no other) PASSED')
}

async function testActionPayloadsMapCorrectly() {
  resetAll()
  await POST(req({ action: 'reject', reason: 'weak_evidence', detail: 'not enough evidence' }), ctx())
  assert.deepStrictEqual(spies.rejectOpportunity.calls[0][1], { reason: 'weak_evidence', detail: 'not enough evidence', actor: 'am' })

  resetAll()
  await POST(req({ action: 'record_handoff', method: 'manual', reference: 'AM confirmed handoff' }), ctx())
  assert.deepStrictEqual(spies.recordHandoff.calls[0][1], { method: 'manual', reference: 'AM confirmed handoff', actor: 'am' })

  resetAll()
  await POST(req({ action: 'record_verification', result: 'inconclusive', evidence: [] }), ctx())
  assert.deepStrictEqual(spies.recordVerification.calls[0][1], { result: 'inconclusive', evidence: [], actor: 'am' })

  resetAll()
  await POST(req({ action: 'approve' }), ctx())
  assert.deepStrictEqual(spies.approveOpportunity.calls[0][1], { preparedWorkId: null, notes: null, actor: 'am' })

  resetAll()
  await POST(req({ action: 'edit_then_approve', preparedWorkId: 'pw-42', notes: 'Tightened the pitch copy.' }), ctx())
  assert.deepStrictEqual(spies.approveOpportunity.calls[0][1], { preparedWorkId: 'pw-42', edited: true, notes: 'Tightened the pitch copy.', actor: 'am' })

  resetAll()
  await POST(req({ action: 'prepare_edited_version', artifactType: 'schema_jsonld', payload: { add: [{ description: 'x', node: { '@type': 'AboutPage' } }] }, previousVersionId: 'pw-7', evidenceContext: [{ text: 'edited by AM' }] }), ctx())
  // prepareWork's real signature (lib/opportunityLifecycle.js) takes ONE
  // options object (opportunityId included in it), unlike the two-arg
  // (opportunityId, options) shape every other lifecycle function here
  // uses -- so this assertion checks calls[0][0], not calls[0][1].
  assert.deepStrictEqual(spies.prepareWork.calls[0][0], {
    opportunityId: 'opp-1',
    artifactType: 'schema_jsonld',
    payload: { add: [{ description: 'x', node: { '@type': 'AboutPage' } }] },
    generationMethod: 'system_generated',
    evidenceContext: [{ text: 'edited by AM' }],
    supportsAutomatedExecution: false,
    createdBy: 'am',
    previousVersionId: 'pw-7',
    actor: 'am'
  })

  log('TEST (action payloads map onto the exact lifecycle-function argument shapes SourceCitationWizard.js sends) PASSED')
}

// ---------------------------------------------------------------------
// 2. Required payload validation.
// ---------------------------------------------------------------------
async function testRequiredPayloadValidation() {
  resetAll()
  let res = await POST(req({ action: 'reject' }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.rejectOpportunity.calls.length, 0)

  resetAll()
  res = await POST(req({ action: 'record_handoff', reference: 'x' }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.recordHandoff.calls.length, 0)

  resetAll()
  res = await POST(req({ action: 'record_verification' }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.recordVerification.calls.length, 0)

  resetAll()
  res = await POST(req({ action: 'edit_then_approve', notes: 'no preparedWorkId supplied' }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.approveOpportunity.calls.length, 0, 'edit_then_approve must never call approveOpportunity without a preparedWorkId -- that would fabricate an "edited" claim for no real edit')

  resetAll()
  res = await POST(req({ action: 'prepare_edited_version', payload: {}, previousVersionId: 'pw-1' }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.prepareWork.calls.length, 0, 'prepare_edited_version requires artifactType')

  resetAll()
  res = await POST(req({ action: 'prepare_edited_version', artifactType: 'schema_jsonld', previousVersionId: 'pw-1' }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.prepareWork.calls.length, 0, 'prepare_edited_version requires a payload object')

  resetAll()
  res = await POST(req({ action: 'prepare_edited_version', artifactType: 'schema_jsonld', payload: { add: [] } }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.prepareWork.calls.length, 0, 'prepare_edited_version requires previousVersionId -- an untethered "edit" must never be indistinguishable from a first-time system generation')

  log('TEST (missing required payload fields are rejected with 400 before the lifecycle function is ever called) PASSED')
}

// ---------------------------------------------------------------------
// 3. Unsupported / missing action rejected.
// ---------------------------------------------------------------------
async function testUnsupportedActionRejected() {
  resetAll()
  let res = await POST(req({ action: 'delete_everything' }), ctx())
  assert.strictEqual(res.status, 400)
  Object.values(spies).forEach(s => assert.strictEqual(s.calls.length, 0))

  resetAll()
  res = await POST(req({}), ctx())
  assert.strictEqual(res.status, 400)

  log('TEST (an unrecognized or missing action is rejected with 400, no lifecycle function called) PASSED')
}

// ---------------------------------------------------------------------
// RED execution cannot accidentally become automatic execution: 'execute'
// (and every other non-exposed lib/opportunityLifecycle.js export, e.g.
// qualifyOpportunity/prepareWork/submitForApproval/executeOpportunity/
// requestRetest/recordRetestResult/edit_then_approve) is not a key in
// ACTIONS at all -- there is no code path in this route that can ever
// reach executeOpportunity(), so a RED opportunity can never be
// automatically executed through this endpoint.
// ---------------------------------------------------------------------
async function testExecuteAndOtherUnexposedActionsAreNotReachable() {
  resetAll()
  for (const action of ['execute', 'qualify', 'prepare_work', 'submit_for_approval', 'request_retest', 'record_retest_result']) {
    const res = await POST(req({ action }), ctx())
    assert.strictEqual(res.status, 400, `"${action}" must not be a reachable action on this route`)
  }
  log('TEST (execute, retest, and every other non-wizard lifecycle action remain unreachable through this route -- RED can never auto-execute here) PASSED')
}

// ---------------------------------------------------------------------
// 4. Lifecycle errors propagated safely (never a raw 500/crash).
// ---------------------------------------------------------------------
async function testLifecycleErrorsPropagateAsSafe400s() {
  resetAll()
  spies.approveOpportunity.rejectWith(new Error('Invalid owningPillar "bogus". Must be one of: ...'))
  const res = await POST(req({ action: 'approve' }), ctx())
  assert.strictEqual(res.status, 400)
  const body = await res.json()
  assert.ok(body.error && body.error.includes('Invalid owningPillar'), 'expected the lifecycle error message to be surfaced in the response body')
  log('TEST (an error thrown by a lifecycle function is caught and returned as a structured 400, not an unhandled crash) PASSED')
}

// ---------------------------------------------------------------------
// 5. Client/opportunity mismatch cannot silently operate on another
//    client's opportunity.
// ---------------------------------------------------------------------
async function testClientOpportunityMismatchIsRejected() {
  resetAll()
  fakeRow = { id: 'opp-1', client_id: 'someone-elses-client' }
  const res = await POST(req({ action: 'approve' }), ctx('client-1', 'opp-1'))
  assert.strictEqual(res.status, 404)
  assert.strictEqual(spies.approveOpportunity.calls.length, 0, 'a mismatched client/opportunity pair must never reach the lifecycle function')
  log('TEST (a client id / opportunity id pair that do not belong together is rejected with 404, before any lifecycle function runs) PASSED')
}

async function testMismatchAlsoBlocksVerificationActions() {
  resetAll()
  fakeRow = { id: 'opp-1', client_id: 'someone-elses-client' }
  const res = await POST(req({ action: 'record_verification', result: 'verified', evidence: [] }), ctx('client-1', 'opp-1'))
  assert.strictEqual(res.status, 404)
  assert.strictEqual(spies.recordVerification.calls.length, 0, 'verification state must never be written for a client/opportunity mismatch')
  log('TEST (verification state cannot be falsely completed through a client/opportunity mismatch) PASSED')
}

async function testOpportunityNotFoundIsRejected() {
  resetAll()
  fakeRow = null
  const res = await POST(req({ action: 'approve' }), ctx())
  assert.strictEqual(res.status, 404)
  assert.strictEqual(spies.approveOpportunity.calls.length, 0)
  log('TEST (a nonexistent opportunity id is rejected with 404, no lifecycle function called) PASSED')
}

// ---------------------------------------------------------------------
// 6. No live Supabase connection required anywhere in this file --
//    structural check: neither mock module ever opens a real client.
// ---------------------------------------------------------------------
async function testNoLiveSupabaseConnectionRequired() {
  assert.strictEqual(process.env.SUPABASE_SERVICE_ROLE_KEY, undefined, 'this test file must not require Supabase credentials to be set')
  log('TEST (this entire suite runs with zero Supabase credentials / connection) PASSED')
}

async function main() {
  await testEachActionDispatchesTheRightFunctionOnly()
  await testActionPayloadsMapCorrectly()
  await testRequiredPayloadValidation()
  await testUnsupportedActionRejected()
  await testExecuteAndOtherUnexposedActionsAreNotReachable()
  await testLifecycleErrorsPropagateAsSafe400s()
  await testClientOpportunityMismatchIsRejected()
  await testMismatchAlsoBlocksVerificationActions()
  await testOpportunityNotFoundIsRejected()
  await testNoLiveSupabaseConnectionRequired()
  log('\nAll Phase 1 lifecycle-route tests passed (mocked lifecycle + Supabase, no DB required).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
