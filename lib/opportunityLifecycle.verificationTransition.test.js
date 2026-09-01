// Phase 1.1 (2026-09-01) -- verification state-transition tests. Plain
// Node, same convention as the rest of this repo's test files. Unlike
// opportunityLifecycle.pure.test.js (validateExecutionGate in isolation),
// this file mocks lib/supabaseServer.js (require.cache injection, same
// technique as the lifecycle route tests) and calls the REAL
// requestVerification() from lib/opportunityLifecycle.js, to prove the
// gate is actually wired into the DB-writing function -- not just correct
// in isolation. NO live Supabase connection is opened or required. Run
// with:
//   node lib/opportunityLifecycle.verificationTransition.test.js
// or:
//   npm run test:verification-transition

const assert = require('assert')

const supabaseServerPath = require.resolve('./supabaseServer')

let currentRow = null
const updateCalls = []
const insertCalls = []

function fakeSupabase() {
  return {
    from(table) {
      return {
        select() {
          return {
            eq(_k, v) {
              return {
                async single() {
                  if (currentRow && currentRow.id === v) return { data: currentRow, error: null }
                  return { data: null, error: { message: 'not found' } }
                }
              }
            }
          }
        },
        update(updates) {
          return {
            async eq(k, v) {
              updateCalls.push({ table, updates, match: { [k]: v } })
              return { error: null }
            }
          }
        },
        async insert(payload) {
          insertCalls.push({ table, payload })
          return { error: null }
        }
      }
    }
  }
}

require.cache[supabaseServerPath] = {
  id: supabaseServerPath, filename: supabaseServerPath, loaded: true,
  exports: { getSupabaseServerClient: () => fakeSupabase() }
}

const { requestVerification } = require('./opportunityLifecycle')

function reset(row) {
  currentRow = row
  updateCalls.length = 0
  insertCalls.length = 0
}

function log(msg) { console.log(msg) }

async function testRequestVerificationRejectsBeforeExecutionCompletes() {
  reset({ id: 'opp-1', client_id: 'c1', execution_status: 'not_started', execution_capability: 'red', verification_status: 'not_ready' })
  await assert.rejects(() => requestVerification('opp-1', { actor: 'am' }), /executed.*human_completed/)
  assert.strictEqual(updateCalls.length, 0, 'not_started: no DB write should happen when the gate rejects')
  assert.strictEqual(insertCalls.length, 0, 'not_started: no history row should be written when the gate rejects')

  reset({ id: 'opp-2', client_id: 'c1', execution_status: 'handed_off', execution_capability: 'red', verification_status: 'not_ready' })
  await assert.rejects(() => requestVerification('opp-2', { actor: 'am' }))
  assert.strictEqual(updateCalls.length, 0, 'handed_off (not yet human_completed): must still be rejected')

  reset({ id: 'opp-3', client_id: 'c1', execution_status: 'execution_failed', execution_capability: 'yellow', verification_status: 'not_ready' })
  await assert.rejects(() => requestVerification('opp-3', { actor: 'am' }))
  assert.strictEqual(updateCalls.length, 0, 'execution_failed: must never become verification-eligible')

  log('TEST (requestVerification rejects and writes nothing to Supabase for not_started / handed_off / execution_failed opportunities) PASSED')
}

async function testRequestVerificationSucceedsAfterExecutedOrHumanCompleted() {
  reset({ id: 'opp-4', client_id: 'c1', execution_status: 'executed', execution_capability: 'green', verification_status: 'not_ready' })
  const result = await requestVerification('opp-4', { actor: 'am' })
  assert.strictEqual(result.verificationStatus, 'ready_to_verify')
  assert.strictEqual(updateCalls.length, 1)
  assert.strictEqual(updateCalls[0].updates.verification_status, 'ready_to_verify')
  assert.strictEqual(updateCalls[0].match.id, 'opp-4')
  assert.strictEqual(insertCalls.length, 1)
  assert.strictEqual(insertCalls[0].payload.event_type, 'verification_requested')
  assert.strictEqual(insertCalls[0].payload.actor, 'am')

  reset({ id: 'opp-5', client_id: 'c1', execution_status: 'human_completed', execution_capability: 'red', verification_status: 'not_ready' })
  const result2 = await requestVerification('opp-5', { actor: 'am' })
  assert.strictEqual(result2.verificationStatus, 'ready_to_verify')
  assert.strictEqual(updateCalls.length, 1)
  assert.strictEqual(insertCalls[0].payload.event_type, 'verification_requested')

  log('TEST (requestVerification succeeds and writes verification_status=ready_to_verify + a verification_requested history row for "executed" and "human_completed" opportunities) PASSED')
}

async function main() {
  await testRequestVerificationRejectsBeforeExecutionCompletes()
  await testRequestVerificationSucceedsAfterExecutedOrHumanCompleted()
  log('\nAll verification state-transition tests passed (mocked Supabase, no live DB required).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
