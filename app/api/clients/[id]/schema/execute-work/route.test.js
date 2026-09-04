// Route-level tests for the Schema "DEPLOY TO WORDPRESS" execution endpoint
// (Phase 7, 2026-09-04). Same convention as
// app/api/clients/[id]/schema/prepare-work/route.test.js -- plain Node,
// require.cache module injection, NO live Supabase connection or network
// fetch anywhere in this file. Run with:
//   node "app/api/clients/[id]/schema/execute-work/route.test.js"
//
// lib/schemaDeployableArtifact.js and lib/schemaPageIdentity.js are used
// FOR REAL (not mocked) -- both are pure/synchronous with no I/O, and using
// the real transform is what actually proves this route's approval-gate ->
// transform -> publish -> record wiring is correct, not just that its mocks
// agree with each other. Everything that touches the network or the
// database (Supabase, WordPress, credential decryption, the Phase 3
// lifecycle) is mocked.

const assert = require('assert')
const path = require('path')

const supabaseServerPath = require.resolve(path.join(__dirname, '../../../../../../lib/supabaseServer'))
const wpCredentialsPath = require.resolve(path.join(__dirname, '../../../../../../lib/wpCredentials'))
const wpPublishPath = require.resolve(path.join(__dirname, '../../../../../../lib/wpPublish'))
const pageAnalysisPath = require.resolve(path.join(__dirname, '../../../../../../lib/pageAnalysis'))
const schemaPageWorkPath = require.resolve(path.join(__dirname, '../../../../../../lib/schemaPageWork'))
const opportunityLifecyclePath = require.resolve(path.join(__dirname, '../../../../../../lib/opportunityLifecycle'))
const routePath = require.resolve(path.join(__dirname, 'route'))

// ---------------------------------------------------------------------
// Fake Supabase -- generic enough for the three tables this route reads:
// clients, opportunities, opportunity_prepared_work.
// ---------------------------------------------------------------------
let tables = { clients: [], opportunities: [], opportunity_prepared_work: [] }

function makeTable(tableName) {
  return {
    select() {
      const filters = {}
      const builder = {
        eq(k, v) { filters[k] = v; return builder },
        async single() {
          const rows = tables[tableName] || []
          const match = rows.find(r => Object.entries(filters).every(([k, v]) => r[k] === v))
          return match ? { data: match, error: null } : { data: null, error: { message: `${tableName} row not found` } }
        },
        async maybeSingle() {
          const rows = tables[tableName] || []
          const match = rows.find(r => Object.entries(filters).every(([k, v]) => r[k] === v))
          return { data: match || null, error: null }
        }
      }
      return builder
    }
  }
}
function fakeSupabase() { return { from: (t) => makeTable(t) } }

// ---------------------------------------------------------------------
// Spies
// ---------------------------------------------------------------------
function makeSpy(defaultImpl = async () => ({})) {
  const calls = []
  let impl = defaultImpl
  const fn = async (...args) => { calls.push(args); return impl(...args) }
  fn.calls = calls
  fn.reset = (nextDefault = defaultImpl) => { calls.length = 0; impl = nextDefault }
  return fn
}
function makeSyncSpy(defaultImpl) {
  const calls = []
  let impl = defaultImpl
  const fn = (...args) => { calls.push(args); return impl(...args) }
  fn.calls = calls
  fn.reset = (nextDefault = defaultImpl) => { calls.length = 0; impl = nextDefault }
  return fn
}

const ADD_ONLY_PAYLOAD = {
  supported: true,
  add: [{ description: 'AboutPage node', node: { '@type': 'AboutPage', '@id': 'https://example.com/about/#aboutpage', url: 'https://example.com/about/' } }],
  modify: [], remove: [], keep: ['WebPage'], unresolvedDependencies: [], canonicalEntity: { resolved: false, source: 'no_id_present' }
}
const MODIFY_PAYLOAD = { ...ADD_ONLY_PAYLOAD, modify: [{ description: 'broaden @type', node: { '@type': 'LocalBusiness' } }] }

const spies = {
  decrypt: makeSyncSpy((enc) => `plaintext-of:${enc}`),
  publishPageSchemaToWordPress: makeSpy(async () => ({ ok: true, postId: 42, updatedAt: '2026-09-04T00:00:00.000Z' })),
  resolvePageUrl: makeSyncSpy((siteUrl, p) => `${siteUrl}${p}`),
  // HOTFIX (2026-09-04c) regression coverage: getPageWorkRow now backs ONLY
  // the best-effort reconciliation/backfill, never the primary opportunity
  // lookup (fingerprint does that -- see route.js's own header) -- default
  // fixture below deliberately returns a row whose opportunity_id is
  // ALREADY missing, mirroring the exact live Firestarter SEO /about/ bug
  // this hotfix fixes, so every existing test not specifically about the
  // reconciliation path still exercises the "stale/missing link" case by
  // default rather than the easy, always-linked case.
  getPageWorkRow: makeSpy(async () => ({ opportunity_id: null, page_url: 'https://example.com/about/' })),
  linkOpportunity: makeSpy(async () => ({ id: 'pgw-1', opportunity_id: 'opp-1' })),
  executeOpportunity: makeSpy(async () => ({ ok: true }))
}

require.cache[supabaseServerPath] = { id: supabaseServerPath, filename: supabaseServerPath, loaded: true, exports: { getSupabaseServerClient: () => fakeSupabase() } }
require.cache[wpCredentialsPath] = { id: wpCredentialsPath, filename: wpCredentialsPath, loaded: true, exports: { decrypt: spies.decrypt } }
require.cache[wpPublishPath] = { id: wpPublishPath, filename: wpPublishPath, loaded: true, exports: { publishPageSchemaToWordPress: spies.publishPageSchemaToWordPress } }
require.cache[pageAnalysisPath] = { id: pageAnalysisPath, filename: pageAnalysisPath, loaded: true, exports: { resolvePageUrl: spies.resolvePageUrl } }
require.cache[schemaPageWorkPath] = { id: schemaPageWorkPath, filename: schemaPageWorkPath, loaded: true, exports: { getPageWorkRow: spies.getPageWorkRow, linkOpportunity: spies.linkOpportunity } }
require.cache[opportunityLifecyclePath] = { id: opportunityLifecyclePath, filename: opportunityLifecyclePath, loaded: true, exports: { executeOpportunity: spies.executeOpportunity } }

const { POST } = require(routePath)

function resetAll() {
  tables = {
    clients: [{ id: 'client-1', url: 'https://example.com', wp_username: 'am', wp_app_password_encrypted: 'enc:abc' }],
    opportunities: [{
      id: 'opp-1', client_id: 'client-1', fingerprint: 'schema:/about', originating_pillar: 'schema_structure',
      detail: { path: '/about/' }, approval_status: 'approved', approved_prepared_work_id: 'pw-1',
      execution_status: 'not_started', execution_state: null
    }],
    opportunity_prepared_work: [{ id: 'pw-1', opportunity_id: 'opp-1', status: 'approved', version: 1, artifact_type: 'schema_jsonld', payload: ADD_ONLY_PAYLOAD }]
  }
  spies.decrypt.reset((enc) => `plaintext-of:${enc}`)
  spies.publishPageSchemaToWordPress.reset(async () => ({ ok: true, postId: 42, updatedAt: '2026-09-04T00:00:00.000Z' }))
  spies.resolvePageUrl.reset((siteUrl, p) => `${siteUrl}${p}`)
  spies.getPageWorkRow.reset(async () => ({ opportunity_id: null, page_url: 'https://example.com/about/' }))
  spies.linkOpportunity.reset(async () => ({ id: 'pgw-1', opportunity_id: 'opp-1' }))
  spies.executeOpportunity.reset(async () => ({ ok: true }))
}

function req(body) { return { json: async () => body } }
function ctx(id = 'client-1') { return { params: { id } } }
function log(msg) { console.log(msg) }

// ---------------------------------------------------------------------
// A. Path validation.
// ---------------------------------------------------------------------
async function testPathValidation() {
  resetAll()
  let res = await POST(req({}), ctx())
  assert.strictEqual(res.status, 400)
  res = await POST(req({ path: 'about' }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (path must be a site-relative path starting with "/") PASSED')
}

// ---------------------------------------------------------------------
// B. Approved work required -- pending/rejected can never execute.
// ---------------------------------------------------------------------
async function testPendingApprovalBlocked() {
  resetAll()
  tables.opportunities[0].approval_status = 'pending'
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 409)
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 0)
  assert.strictEqual(spies.executeOpportunity.calls.length, 0)
  log('TEST (a pending, not-yet-approved opportunity cannot be executed) PASSED')
}

async function testRejectedApprovalBlocked() {
  resetAll()
  tables.opportunities[0].approval_status = 'rejected'
  tables.opportunities[0].approved_prepared_work_id = null
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 409)
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 0)
  log('TEST (a rejected opportunity cannot be executed) PASSED')
}

// ---------------------------------------------------------------------
// C. The exact approved prepared-work version is used -- never a stale or
//    unrelated version, even if another version row exists.
// ---------------------------------------------------------------------
async function testExactApprovedVersionIsUsed() {
  resetAll()
  const otherNode = { '@type': 'ContactPage', url: 'https://example.com/contact/' }
  tables.opportunity_prepared_work.push({ id: 'pw-0-stale', opportunity_id: 'opp-1', status: 'superseded', version: 0, artifact_type: 'schema_jsonld', payload: { supported: true, add: [{ node: otherNode }], modify: [], remove: [] } })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.jsonLd['@type'], 'AboutPage', 'must deploy the AboutPage node from pw-1 (the approved version), never the stale pw-0 ContactPage node')
  log('TEST (execution always reads and deploys the exact approved_prepared_work_id, never a different or stale version) PASSED')
}

// ---------------------------------------------------------------------
// G. Duplicate deployment prevented (idempotency) -- the same already-
//    deployed approved version is never redeployed.
// ---------------------------------------------------------------------
async function testDuplicateDeploymentPrevented() {
  resetAll()
  tables.opportunities[0].execution_status = 'executed'
  tables.opportunities[0].execution_state = { result: { ok: true, approvedPreparedWorkId: 'pw-1', postId: 42, deployedAt: '2026-09-01T00:00:00.000Z', deployedJsonLd: { '@type': 'AboutPage' } } }
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.alreadyDeployed, true)
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 0, 'an already-deployed exact version must never trigger a second WordPress write')
  assert.strictEqual(spies.executeOpportunity.calls.length, 0)
  log('TEST (the exact approved version already successfully deployed short-circuits -- no redundant WordPress write, no redundant execution record) PASSED')
}

async function testNewerApprovedVersionTriggersFreshExecution() {
  resetAll()
  tables.opportunities[0].execution_status = 'executed'
  tables.opportunities[0].execution_state = { result: { ok: true, approvedPreparedWorkId: 'pw-1', postId: 42, deployedAt: '2026-09-01T00:00:00.000Z', deployedJsonLd: { '@type': 'AboutPage' } } }
  // A newer version was approved since -- a genuinely different id.
  tables.opportunities[0].approved_prepared_work_id = 'pw-2'
  tables.opportunity_prepared_work.push({ id: 'pw-2', opportunity_id: 'opp-1', status: 'approved', version: 2, artifact_type: 'schema_jsonld', payload: ADD_ONLY_PAYLOAD })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.alreadyDeployed, undefined, 'a newer approved version must never be reported as already deployed')
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 1, 'a newer approved version must trigger a genuinely new WordPress write')
  log('TEST (a newer approved_prepared_work_id -- a different version than what was last deployed -- always triggers a fresh execution) PASSED')
}

// ---------------------------------------------------------------------
// H. Target-page mismatch blocked.
// ---------------------------------------------------------------------
async function testTargetPageMismatchBlocked() {
  resetAll()
  tables.opportunities[0].detail = { path: '/contact/' } // opportunity recorded against a DIFFERENT page than the one being executed
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 409)
  const body = await res.json()
  assert.ok(/target page mismatch/i.test(body.error))
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 0)
  log('TEST (an opportunity recorded against a different page than the one being executed is blocked, never deployed to the wrong page) PASSED')
}

// ---------------------------------------------------------------------
// I. WordPress disconnected blocked.
// ---------------------------------------------------------------------
async function testWordPressDisconnectedBlocked() {
  resetAll()
  tables.clients[0].wp_username = null
  tables.clients[0].wp_app_password_encrypted = null
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 0)
  log('TEST (a client with no WordPress connection on file is blocked before any transform or publish attempt) PASSED')
}

// ---------------------------------------------------------------------
// J. Auth/write error handling -- a real WordPress-side failure is
//    recorded as a genuine execution failure, not silently swallowed.
// ---------------------------------------------------------------------
async function testWordPressWriteFailureIsRecordedAndReported() {
  resetAll()
  spies.publishPageSchemaToWordPress.reset(async () => ({ ok: false, error: 'WordPress rejected the connection -- the Application Password may be wrong, revoked, or the account no longer has permission.', pageNotResolved: false }))
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 502)
  assert.strictEqual(spies.executeOpportunity.calls.length, 1, 'a failed WordPress write is still recorded via executeOpportunity, with ok:false')
  assert.strictEqual(spies.executeOpportunity.calls[0][1].result.ok, false)
  const body = await res.json()
  assert.strictEqual(body.ok, false)
  log('TEST (a WordPress auth/write failure is reported as a real execution failure -- recorded via executeOpportunity with ok:false, never silently treated as success) PASSED')
}

// ---------------------------------------------------------------------
// D/E/F equivalents -- insufficient artifact (MODIFY present) blocks with
// the literal EXECUTION BLOCKED message, never reaching WordPress. (The
// pure transform logic itself is already exhaustively covered by
// lib/schemaDeployableArtifact.test.js -- this just proves the route wires
// a block into an HTTP response instead of deploying.)
// ---------------------------------------------------------------------
async function testInsufficientArtifactBlocksBeforePublish() {
  resetAll()
  tables.opportunity_prepared_work[0].payload = MODIFY_PAYLOAD
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 409)
  const body = await res.json()
  assert.strictEqual(body.error, 'EXECUTION BLOCKED — APPROVED ARTIFACT INSUFFICIENT')
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 0)
  assert.strictEqual(spies.executeOpportunity.calls.length, 0, 'a transform-time block is a validation outcome, never an execution attempt -- executeOpportunity must not be called')
  log('TEST (approved work with any MODIFY content blocks with the literal EXECUTION BLOCKED — APPROVED ARTIFACT INSUFFICIENT message, before any WordPress call) PASSED')
}

// ---------------------------------------------------------------------
// Additional gate checks.
// ---------------------------------------------------------------------
async function testOriginatingPillarMismatchBlocked() {
  resetAll()
  tables.opportunities[0].originating_pillar = 'entity_authority'
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (an opportunity that does not belong to the Schema & Structure pillar is rejected) PASSED')
}

async function testPreparedWorkRowNotApprovedBlocked() {
  resetAll()
  tables.opportunity_prepared_work[0].status = 'superseded'
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 409)
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 0)
  log('TEST (a superseded prepared-work row -- even if still referenced by an approved_prepared_work_id somehow -- is rejected rather than deployed) PASSED')
}

async function testNoOpportunityForPageBlocked() {
  resetAll()
  tables.opportunities = [] // no row matches this client_id + fingerprint at all
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (a page with no schema opportunity at all -- no row matching this fingerprint -- cannot be executed) PASSED')
}

// ---------------------------------------------------------------------
// HOTFIX (2026-09-04c) regression coverage -- the exact live bug: a fully
// approved opportunity exists (found by fingerprint, the SAME lookup the
// UI uses) but schema_page_work.opportunity_id is null/stale, either
// because the link write never ran (a legacy/pre-linking opportunity) or
// because it drifted. Execution must succeed anyway -- it must NEVER be
// gated on that secondary link -- and the link should be backfilled
// on-read rather than left stale, without ever creating a duplicate
// opportunity.
// ---------------------------------------------------------------------
async function testMissingPageWorkLinkDoesNotBlockExecution() {
  resetAll() // default fixture already has getPageWorkRow return opportunity_id: null
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200, 'a stale/missing schema_page_work link must never block execution of an opportunity the fingerprint lookup resolved correctly')
  const body = await res.json()
  assert.strictEqual(body.ok, true)
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 1)
  log('TEST (a missing schema_page_work.opportunity_id link -- the exact live Firestarter SEO /about/ bug -- no longer blocks execution; the route resolves the opportunity by fingerprint instead) PASSED')
}

async function testMissingPageWorkLinkGetsBackfilledOnDeploy() {
  resetAll()
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  assert.strictEqual(spies.linkOpportunity.calls.length, 1, 'a stale/missing link must be backfilled (reconciled) during a successful deploy')
  assert.strictEqual(spies.linkOpportunity.calls[0][0].opportunityId, 'opp-1', 'reconciliation must link to the EXACT opportunity this route resolved -- never create or point at a different one')
  assert.strictEqual(spies.linkOpportunity.calls[0][0].clientId, 'client-1')
  log('TEST (deploy backfills the stale schema_page_work link to the exact opportunity it resolved, via the existing idempotent linkOpportunity() -- never creating a duplicate opportunity) PASSED')
}

async function testAlreadyCorrectLinkIsNotRewritten() {
  resetAll()
  spies.getPageWorkRow.reset(async () => ({ opportunity_id: 'opp-1', page_url: 'https://example.com/about/' }))
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  assert.strictEqual(spies.linkOpportunity.calls.length, 0, 'an already-correct link must not be rewritten on every deploy -- no noisy duplicate history event')
  log('TEST (deploy makes no reconciliation write when schema_page_work is already linked to the correct opportunity) PASSED')
}

async function testReconciliationFailureNeverBlocksExecution() {
  resetAll()
  spies.linkOpportunity.reset(async () => { throw new Error('opportunity_id column is unique and already taken') })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200, 'a reconciliation/backfill failure must never block an otherwise-valid deploy -- it is best-effort only')
  const body = await res.json()
  assert.strictEqual(body.ok, true)
  assert.strictEqual(spies.publishPageSchemaToWordPress.calls.length, 1)
  log('TEST (a linkOpportunity failure during reconciliation is swallowed -- the deploy itself still succeeds) PASSED')
}

async function testGetPageWorkRowFailureNeverBlocksExecution() {
  resetAll()
  spies.getPageWorkRow.reset(async () => { throw new Error('connection reset') })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200, 'a failure reading schema_page_work (now only used for best-effort reconciliation) must never block execution of an opportunity already resolved by fingerprint')
  log('TEST (a getPageWorkRow failure during reconciliation is swallowed -- execution proceeds on the fingerprint-resolved opportunity regardless) PASSED')
}

async function testNoDuplicateOpportunityIsEverCreated() {
  // Structural check, same convention as prepare-work/route.test.js's own
  // "never calls execution/verification/publish" test: this route must
  // never even import a primitive capable of CREATING a new opportunity --
  // reconciliation only ever links an EXISTING opportunityId to the
  // existing schema_page_work row via linkOpportunity(), which itself
  // never inserts into `opportunities`.
  const source = require('fs').readFileSync(require.resolve(path.join(__dirname, 'route.js')), 'utf8')
  for (const forbidden of ['qualifySchemaPageOpportunity', 'qualifyOpportunity', 'prepareWork', 'submitForApproval']) {
    assert.ok(!source.includes(forbidden), `route.js must never import or call ${forbidden} -- it must never create a new opportunity, only resolve and reconcile an existing one`)
  }
  log('TEST (route.js never imports any opportunity-creating primitive -- reconciliation can only ever link to an EXISTING opportunity, never create a duplicate) PASSED')
}

async function testClientLookupMissing() {
  resetAll()
  tables.clients = []
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 404)
  log('TEST (a missing client is rejected before any other check) PASSED')
}

async function main() {
  await testPathValidation()
  await testPendingApprovalBlocked()
  await testRejectedApprovalBlocked()
  await testExactApprovedVersionIsUsed()
  await testDuplicateDeploymentPrevented()
  await testNewerApprovedVersionTriggersFreshExecution()
  await testTargetPageMismatchBlocked()
  await testWordPressDisconnectedBlocked()
  await testWordPressWriteFailureIsRecordedAndReported()
  await testInsufficientArtifactBlocksBeforePublish()
  await testOriginatingPillarMismatchBlocked()
  await testPreparedWorkRowNotApprovedBlocked()
  await testNoOpportunityForPageBlocked()
  await testClientLookupMissing()
  await testMissingPageWorkLinkDoesNotBlockExecution()
  await testMissingPageWorkLinkGetsBackfilledOnDeploy()
  await testAlreadyCorrectLinkIsNotRewritten()
  await testReconciliationFailureNeverBlocksExecution()
  await testGetPageWorkRowFailureNeverBlocksExecution()
  await testNoDuplicateOpportunityIsEverCreated()
  log('\nAll Phase 7 schema/execute-work route tests passed (mocked Supabase/WordPress/lifecycle, real deployable-artifact transform, no DB or network required).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
