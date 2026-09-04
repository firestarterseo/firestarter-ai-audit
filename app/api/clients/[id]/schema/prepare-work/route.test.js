// Route-level tests for the Schema Prepared Work + AM Review "Prepare
// Schema Work" endpoint (Phase 6, 2026-09-03). Same convention as
// app/api/clients/[id]/opportunities/[opportunityId]/lifecycle/route.test.js
// -- plain Node, require.cache module injection, NO live Supabase
// connection or network fetch anywhere in this file. Run with:
//   node "app/api/clients/[id]/schema/prepare-work/route.test.js"

const assert = require('assert')
const path = require('path')

const supabaseServerPath = require.resolve(path.join(__dirname, '../../../../../../lib/supabaseServer'))
const pageAnalysisPath = require.resolve(path.join(__dirname, '../../../../../../lib/pageAnalysis'))
const schemaOpportunityPath = require.resolve(path.join(__dirname, '../../../../../../lib/schemaOpportunity'))
const schemaPreparedWorkPath = require.resolve(path.join(__dirname, '../../../../../../lib/schemaPreparedWork'))
const opportunityLifecyclePath = require.resolve(path.join(__dirname, '../../../../../../lib/opportunityLifecycle'))
const schemaPageWorkPath = require.resolve(path.join(__dirname, '../../../../../../lib/schemaPageWork'))
const routePath = require.resolve(path.join(__dirname, 'route'))

// ---------------------------------------------------------------------
// Fake Supabase -- generic enough for both tables this route reads:
// clients (POST) and opportunities (POST's final read + GET).
// ---------------------------------------------------------------------
let tables = { clients: [], opportunities: [] }
// forceThrowForTable -- lets a test simulate a Supabase client call that
// THROWS (e.g. a real connection error), distinct from one that resolves
// with an {error} object (already covered by the `tables` fixtures above).
// Reset in resetAll() so a forced failure from one test never leaks into
// the next.
let forceThrowForTable = null

function makeTable(tableName) {
  return {
    select() {
      const filters = {}
      const builder = {
        eq(k, v) { filters[k] = v; return builder },
        async single() {
          if (forceThrowForTable && forceThrowForTable.table === tableName) throw forceThrowForTable.error
          const rows = tables[tableName] || []
          const match = rows.find(r => Object.entries(filters).every(([k, v]) => r[k] === v))
          return match ? { data: match, error: null } : { data: null, error: { message: `${tableName} row not found` } }
        },
        async maybeSingle() {
          if (forceThrowForTable && forceThrowForTable.table === tableName) throw forceThrowForTable.error
          const rows = tables[tableName] || []
          const match = rows.find(r => Object.entries(filters).every(([k, v]) => r[k] === v))
          return { data: match || null, error: null }
        }
      }
      return builder
    }
  }
}

function fakeSupabase() {
  return { from: (t) => makeTable(t) }
}

// ---------------------------------------------------------------------
// Spies
// ---------------------------------------------------------------------
function makeSpy(defaultImpl = async () => ({})) {
  const calls = []
  let impl = defaultImpl
  const fn = async (...args) => { calls.push(args); return impl(...args) }
  fn.calls = calls
  fn.resolveWith = (value) => { impl = async () => value }
  fn.reset = (nextDefault = defaultImpl) => { calls.length = 0; impl = nextDefault }
  return fn
}

// SYNC spy -- for the three real exports that are plain synchronous
// functions (isEligibleForPreparedWork, resolvePageUrl,
// buildSchemaOpportunityFingerprint). Wrapping a sync function in an
// async spy would make route.js's un-awaited `if (!fn(x))` checks always
// see a truthy Promise instead of the real boolean -- this keeps the
// mock's calling convention identical to the real implementation.
function makeSyncSpy(defaultImpl) {
  const calls = []
  let impl = defaultImpl
  const fn = (...args) => { calls.push(args); return impl(...args) }
  fn.calls = calls
  fn.reset = (nextDefault = defaultImpl) => { calls.length = 0; impl = nextDefault }
  return fn
}

const ANALYSIS_ELIGIBLE = {
  path: '/about/', fetchState: 'success', classification: { type: 'About', source: 'sitemap', confidence: 'high' },
  targetProfile: 'ABOUT', currentSchema: ['WebPage'],
  coreChecks: [{ id: 'about_page_type_representation', status: 'pass', tier: 'core', evidence: 'ok' }],
  recommendedChecks: [{ id: 'about_page_subtype', status: 'fail', tier: 'recommended', evidence: 'generic WebPage type used' }],
  avoidFindings: [], notApplicable: [], finalStatus: 'IMPROVEMENT_AVAILABLE'
}
const ANALYSIS_NO_ACTION = { ...ANALYSIS_ELIGIBLE, finalStatus: 'NO_ACTION_NEEDED', recommendedChecks: [] }

const spies = {
  analyzePage: makeSpy(async () => ANALYSIS_ELIGIBLE),
  resolvePageUrl: makeSyncSpy((siteUrl, p) => `${siteUrl}${p}`),
  isEligibleForPreparedWork: makeSyncSpy((analysis) => analysis.finalStatus === 'ACTION_REQUIRED' || analysis.finalStatus === 'IMPROVEMENT_AVAILABLE'),
  qualifySchemaPageOpportunity: makeSpy(async () => ({ eligible: true, opportunityId: 'opp-1', action: 'created', fingerprint: 'schema:/about' })),
  buildSchemaOpportunityFingerprint: makeSyncSpy((p) => `schema:${p.length > 1 ? p.replace(/\/$/, '') : p}`),
  buildPreparedSchemaWork: makeSpy(async () => ({ supported: true, add: [{ description: 'AboutPage node', node: { '@type': 'AboutPage' } }], modify: [], remove: [], unresolvedDependencies: [], keep: ['WebPage'], canonicalEntity: { resolved: false, source: 'no_id_present' } })),
  prepareWork: makeSpy(async () => ({ preparedWorkId: 'pw-1', version: 1, status: 'ready_for_review' })),
  submitForApproval: makeSpy(async () => ({ ok: true })),
  getPreparedWork: makeSpy(async () => ([{ id: 'pw-1', version: 1, status: 'ready_for_review' }])),
  getOpportunityHistory: makeSpy(async () => ([])),
  upsertAnalysisResult: makeSpy(async () => ({ id: 'pw-row-1' })),
  linkOpportunity: makeSpy(async () => ({ id: 'pw-row-1', opportunity_id: 'opp-1' })),
  // Phase 7 (2026-09-04) -- the EXECUTION CAPABILITY SYNC block's one write
  // primitive. Default fixtures below keep the opportunity's
  // execution_capability already matching what the (disconnected) default
  // client fixture implies, so most existing tests never trigger a call --
  // only the dedicated capability-sync tests further down flip one side of
  // that match to exercise it.
  setPriorityTreatment: makeSpy(async () => ({ opportunityId: 'opp-1', treatment: null, priorityAssessment: {} }))
}

require.cache[supabaseServerPath] = { id: supabaseServerPath, filename: supabaseServerPath, loaded: true, exports: { getSupabaseServerClient: () => fakeSupabase() } }
require.cache[pageAnalysisPath] = { id: pageAnalysisPath, filename: pageAnalysisPath, loaded: true, exports: { analyzePage: spies.analyzePage, resolvePageUrl: spies.resolvePageUrl } }
require.cache[schemaOpportunityPath] = { id: schemaOpportunityPath, filename: schemaOpportunityPath, loaded: true, exports: { isEligibleForPreparedWork: spies.isEligibleForPreparedWork, qualifySchemaPageOpportunity: spies.qualifySchemaPageOpportunity, buildSchemaOpportunityFingerprint: spies.buildSchemaOpportunityFingerprint } }
require.cache[schemaPreparedWorkPath] = { id: schemaPreparedWorkPath, filename: schemaPreparedWorkPath, loaded: true, exports: { buildPreparedSchemaWork: spies.buildPreparedSchemaWork } }
require.cache[opportunityLifecyclePath] = { id: opportunityLifecyclePath, filename: opportunityLifecyclePath, loaded: true, exports: { prepareWork: spies.prepareWork, submitForApproval: spies.submitForApproval, getPreparedWork: spies.getPreparedWork, getOpportunityHistory: spies.getOpportunityHistory, setPriorityTreatment: spies.setPriorityTreatment } }
require.cache[schemaPageWorkPath] = { id: schemaPageWorkPath, filename: schemaPageWorkPath, loaded: true, exports: { upsertAnalysisResult: spies.upsertAnalysisResult, linkOpportunity: spies.linkOpportunity } }

const { POST, GET } = require(routePath)

function resetAll() {
  // execution_capability: 'red' matches this default client fixture (no
  // wp_username/wp_app_password_encrypted) so the Phase 7 capability-sync
  // block is a no-op by default -- existing tests below never see a
  // surprise setPriorityTreatment call unless they deliberately mismatch
  // the two, as the dedicated capability-sync tests do.
  tables = { clients: [{ id: 'client-1', url: 'https://example.com' }], opportunities: [{ id: 'opp-1', client_id: 'client-1', fingerprint: 'schema:/about', title: 'x', execution_capability: 'red' }] }
  forceThrowForTable = null
  spies.analyzePage.reset(async () => ANALYSIS_ELIGIBLE)
  spies.resolvePageUrl.reset((siteUrl, p) => `${siteUrl}${p}`)
  spies.isEligibleForPreparedWork.reset((analysis) => analysis.finalStatus === 'ACTION_REQUIRED' || analysis.finalStatus === 'IMPROVEMENT_AVAILABLE')
  spies.qualifySchemaPageOpportunity.reset(async () => ({ eligible: true, opportunityId: 'opp-1', action: 'created', fingerprint: 'schema:/about' }))
  spies.buildSchemaOpportunityFingerprint.reset((p) => `schema:${p.length > 1 ? p.replace(/\/$/, '') : p}`)
  spies.buildPreparedSchemaWork.reset(async () => ({ supported: true, add: [{ description: 'AboutPage node', node: { '@type': 'AboutPage' } }], modify: [], remove: [], unresolvedDependencies: [], keep: ['WebPage'], canonicalEntity: { resolved: false, source: 'no_id_present' } }))
  spies.prepareWork.reset(async () => ({ preparedWorkId: 'pw-1', version: 1, status: 'ready_for_review' }))
  spies.submitForApproval.reset(async () => ({ ok: true }))
  spies.getPreparedWork.reset(async () => ([{ id: 'pw-1', version: 1, status: 'ready_for_review' }]))
  spies.getOpportunityHistory.reset(async () => ([]))
  spies.upsertAnalysisResult.reset(async () => ({ id: 'pw-row-1' }))
  spies.linkOpportunity.reset(async () => ({ id: 'pw-row-1', opportunity_id: 'opp-1' }))
  spies.setPriorityTreatment.reset(async () => ({ opportunityId: 'opp-1', treatment: null, priorityAssessment: {} }))
}

function req(body) { return { json: async () => body } }
function getReq(query) { return { url: `https://internal.local/api?${new URLSearchParams(query)}` } }
function ctx(id = 'client-1') { return { params: { id } } }

function log(msg) { console.log(msg) }

// ---------------------------------------------------------------------
// 1. Path validation.
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
// 2. Client lookup.
// ---------------------------------------------------------------------
async function testClientLookup() {
  resetAll()
  tables.clients = []
  let res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 404)

  resetAll()
  tables.clients = [{ id: 'client-1', url: null }]
  res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (a missing client or a client with no site URL is rejected before any fetch/qualify) PASSED')
}

// ---------------------------------------------------------------------
// 3. NO_ACTION_NEEDED / ineligible pages never qualify or prepare.
// ---------------------------------------------------------------------
async function testIneligibleAnalysisNeverQualifiesOrPrepares() {
  resetAll()
  spies.analyzePage.reset(async () => ANALYSIS_NO_ACTION)
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.qualifySchemaPageOpportunity.calls.length, 0, 'NO_ACTION_NEEDED must never call qualifySchemaPageOpportunity')
  assert.strictEqual(spies.buildPreparedSchemaWork.calls.length, 0, 'NO_ACTION_NEEDED must never generate prepared work')
  assert.strictEqual(spies.prepareWork.calls.length, 0)
  const body = await res.json()
  assert.ok(body.error.includes('NO_ACTION_NEEDED'))
  log('TEST (an ineligible diagnosis (NO_ACTION_NEEDED) never calls qualify or prepare -- no opportunity, no prepared work) PASSED')
}

// ---------------------------------------------------------------------
// 4. Eligible analysis -> full ANALYZE -> QUALIFY -> PREPARE -> SUBMIT
//    flow, in order, with the right arguments.
// ---------------------------------------------------------------------
async function testEligibleAnalysisRunsFullFlow() {
  resetAll()
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  assert.strictEqual(spies.analyzePage.calls.length, 1)
  assert.strictEqual(spies.qualifySchemaPageOpportunity.calls.length, 1)
  assert.strictEqual(spies.qualifySchemaPageOpportunity.calls[0][0].actor, 'am')
  assert.strictEqual(spies.buildPreparedSchemaWork.calls.length, 1)
  assert.strictEqual(spies.buildPreparedSchemaWork.calls[0][0].targetProfile, 'ABOUT')
  assert.strictEqual(spies.prepareWork.calls.length, 1)
  assert.strictEqual(spies.prepareWork.calls[0][0].opportunityId, 'opp-1')
  assert.strictEqual(spies.prepareWork.calls[0][0].artifactType, 'schema_jsonld')
  assert.strictEqual(spies.prepareWork.calls[0][0].generationMethod, 'system_generated')
  assert.strictEqual(spies.prepareWork.calls[0][0].createdBy, 'system')
  assert.strictEqual(spies.submitForApproval.calls.length, 1, 'ready_for_review prepared work must be submitted for AM approval')
  assert.strictEqual(spies.submitForApproval.calls[0][0], 'opp-1')
  assert.strictEqual(spies.submitForApproval.calls[0][1].preparedWorkId, 'pw-1')
  const body = await res.json()
  assert.strictEqual(body.opportunity.id, 'opp-1')
  assert.ok(Array.isArray(body.preparedWork))
  assert.strictEqual(spies.upsertAnalysisResult.calls.length, 1, 'a successful prepare must persist the fresh diagnosis to schema_page_work')
  assert.strictEqual(spies.upsertAnalysisResult.calls[0][0].clientId, 'client-1')
  assert.strictEqual(spies.upsertAnalysisResult.calls[0][0].actor, 'am')
  assert.strictEqual(spies.linkOpportunity.calls.length, 1, 'a successful prepare must link the durable page-work row to the opportunity just qualified')
  assert.strictEqual(spies.linkOpportunity.calls[0][0].opportunityId, 'opp-1')
  assert.deepStrictEqual(body.pageWorkPersistence, { ok: true })
  log('TEST (an eligible page runs the full ANALYZE -> QUALIFY -> PREPARE -> SUBMIT-FOR-APPROVAL flow, never touching WordPress/execution/verification) PASSED')
}

// ---------------------------------------------------------------------
// 4b. A schema_page_work persistence failure is non-fatal -- the real
//    Phase 3 opportunity/prepared-work already succeeded and must still
//    be returned, with the failure reported via pageWorkPersistence.
// ---------------------------------------------------------------------
async function testPageWorkPersistenceFailureIsNonFatal() {
  resetAll()
  spies.upsertAnalysisResult.reset(async () => { throw Object.assign(new Error('relation "schema_page_work" does not exist'), { code: '42P01' }) })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200, 'a page-work persistence failure must never fail the overall Prepare Schema Work response')
  const body = await res.json()
  assert.strictEqual(body.opportunity.id, 'opp-1', 'the real Phase 3 opportunity must still be returned')
  assert.strictEqual(spies.linkOpportunity.calls.length, 0, 'linkOpportunity must never be called after upsertAnalysisResult throws')
  assert.strictEqual(body.pageWorkPersistence.ok, false)
  assert.strictEqual(body.pageWorkPersistence.errorClass, 'persistence')
  assert.strictEqual(body.pageWorkPersistence.code, '42P01')
  assert.ok(!JSON.stringify(body.pageWorkPersistence).includes('does not exist'), 'the raw Postgres error message must never be echoed to the client')
  log('TEST (a schema_page_work persistence failure is non-fatal -- the opportunity/prepared-work flow still succeeds, reported via pageWorkPersistence) PASSED')
}

// ---------------------------------------------------------------------
// 5. A preparation_failed result never gets submitted for approval (no
//    fake "ready for review" state for content nobody can review).
// ---------------------------------------------------------------------
async function testPreparationFailedNeverSubmittedForApproval() {
  resetAll()
  spies.buildPreparedSchemaWork.reset(async () => ({ supported: false, reason: 'nothing defensible', add: [], modify: [], remove: [], unresolvedDependencies: ['no evidence'], keep: ['WebPage'], canonicalEntity: { resolved: false, source: 'no_id_present' } }))
  spies.prepareWork.reset(async () => ({ preparedWorkId: 'pw-2', version: 1, status: 'preparation_failed' }))
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  assert.strictEqual(spies.prepareWork.calls[0][0].generationMethod, 'system_failed')
  assert.strictEqual(spies.submitForApproval.calls.length, 0, 'a preparation_failed version must never be submitted for approval')
  log('TEST (when nothing content-defensible could be prepared, generationMethod is system_failed and submitForApproval is never called) PASSED')
}

// ---------------------------------------------------------------------
// 5b-5d. EXECUTION CAPABILITY SYNC (Phase 7, 2026-09-04) -- reconciles an
// EXISTING opportunity's execution_capability against the client's real,
// current WordPress-connection state, in both directions, via the
// existing setPriorityTreatment() primitive -- and is a true no-op (no
// write at all) when the two already agree, so it never generates a noisy
// duplicate history event on every single "Prepare Schema Work" click.
// ---------------------------------------------------------------------
async function testCapabilitySyncUpgradesRedToYellowWhenWordPressConnected() {
  resetAll()
  tables.clients = [{ id: 'client-1', url: 'https://example.com', wp_username: 'am', wp_app_password_encrypted: 'enc:abc' }]
  // opp-1's fixture execution_capability stays 'red' (resetAll's default) --
  // deliberately mismatched against this now-WordPress-connected client.
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  assert.strictEqual(spies.setPriorityTreatment.calls.length, 1, 'a newly-connected client must upgrade a RED opportunity to YELLOW')
  assert.strictEqual(spies.setPriorityTreatment.calls[0][0], 'opp-1')
  assert.strictEqual(spies.setPriorityTreatment.calls[0][1].executionCapability, 'yellow')
  assert.strictEqual(spies.setPriorityTreatment.calls[0][1].actor, 'system')
  log('TEST (a WordPress-connected client upgrades an existing RED opportunity to YELLOW via setPriorityTreatment) PASSED')
}

async function testCapabilitySyncDowngradesYellowToRedWhenWordPressDisconnected() {
  resetAll()
  tables.opportunities = [{ id: 'opp-1', client_id: 'client-1', fingerprint: 'schema:/about', title: 'x', execution_capability: 'yellow' }]
  // Default client fixture (resetAll) has no wp_username/wp_app_password_encrypted --
  // deliberately mismatched against this already-YELLOW opportunity.
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  assert.strictEqual(spies.setPriorityTreatment.calls.length, 1, 'a disconnected client must downgrade a stale YELLOW opportunity back to RED')
  assert.strictEqual(spies.setPriorityTreatment.calls[0][0], 'opp-1')
  assert.strictEqual(spies.setPriorityTreatment.calls[0][1].executionCapability, 'red')
  log('TEST (a WordPress-disconnected client downgrades an existing YELLOW opportunity back to RED via setPriorityTreatment -- capability never left stale) PASSED')
}

async function testCapabilitySyncIsNoopWhenAlreadyMatching() {
  resetAll() // default: client disconnected, opportunity already 'red' -- already in agreement
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  assert.strictEqual(spies.setPriorityTreatment.calls.length, 0, 'capability already matching reality must never trigger a write or a history event')
  log('TEST (execution_capability already matching the client\'s real WordPress-connection state triggers no setPriorityTreatment call -- no noisy no-op history event) PASSED')
}

async function testCapabilitySyncFailureIsNonFatal() {
  resetAll()
  tables.clients = [{ id: 'client-1', url: 'https://example.com', wp_username: 'am', wp_app_password_encrypted: 'enc:abc' }]
  spies.setPriorityTreatment.reset(async () => { throw new Error('opportunity was concurrently modified') })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200, 'a capability-sync failure must never fail the overall Prepare Schema Work response -- it is best-effort only')
  const body = await res.json()
  assert.strictEqual(body.opportunity.id, 'opp-1', 'the real Phase 3 opportunity/prepared-work flow must still complete and be returned')
  log('TEST (a setPriorityTreatment failure during capability sync is swallowed and never fails the overall prepare-work response) PASSED')
}

// ---------------------------------------------------------------------
// 6. This route never calls WordPress publish / execution / verification
//    primitives -- structural check that they are not even imported.
// ---------------------------------------------------------------------
async function testNeverCallsExecutionOrVerificationOrPublish() {
  // Checks the actual import line, not comment prose (this file's own
  // header comments legitimately NAME executeOpportunity/requestHandoff/
  // requestVerification/etc. to explain that they are deliberately never
  // called) -- what matters is that they are never destructured off
  // lib/opportunityLifecycle.js, so there is no code path that could call
  // them at all.
  const source = require('fs').readFileSync(require.resolve(path.join(__dirname, 'route.js')), 'utf8')
  const importLine = source.match(/require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/opportunityLifecycle'\)/)
  assert.ok(importLine, 'expected a single opportunityLifecycle require to inspect')
  const destructureMatch = source.match(/const \{([^}]+)\}\s*=\s*require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/opportunityLifecycle'\)/)
  assert.ok(destructureMatch, 'expected a destructured require of opportunityLifecycle')
  const imported = destructureMatch[1].split(',').map(s => s.trim())
  // Phase 7 (2026-09-04): setPriorityTreatment joined this list -- it's the
  // one EXISTING lifecycle primitive the new execution-capability-sync
  // block reuses (never a new write path of its own). Every actual
  // execution/handoff/verification/retest primitive remains absent below.
  assert.deepStrictEqual(imported.sort(), ['getOpportunityHistory', 'getPreparedWork', 'prepareWork', 'submitForApproval', 'setPriorityTreatment'].sort())
  for (const forbidden of ['executeOpportunity', 'requestHandoff', 'recordHandoff', 'recordHumanCompleted', 'requestVerification', 'recordVerification', 'requestRetest', 'recordRetestResult']) {
    assert.ok(!imported.includes(forbidden), `route.js must never import ${forbidden}`)
  }
  assert.ok(!/require\([^)]*wordpress[^)]*\)/i.test(source), 'route.js must never require a WordPress/publish module')
  log('TEST (route.js only imports prepareWork/submitForApproval/getPreparedWork/getOpportunityHistory/setPriorityTreatment -- execution/handoff/verification/retest primitives are never even imported, and no WordPress module is required) PASSED')
}

// ---------------------------------------------------------------------
// 6b-6e. HOTFIX (2026-09-04b) -- GET must ALSO reconcile execution_capability,
// not only POST. Root cause this covers: "Prepare schema work" only ever
// renders (and POST only ever fires) for a page with no opportunity yet --
// once approved, nothing in the UI calls POST for that page again, so an
// opportunity approved before WordPress was connected (or before this sync
// existed) was permanently stuck at RED. GET, unlike POST, IS already
// called automatically on every page load (SchemaWizard.js's hydration
// effect) -- confirmed live against production data for exactly this
// scenario (Firestarter SEO's /about/ and /contact/ opportunities,
// approved before their WordPress connection was ever synced).
// ---------------------------------------------------------------------
async function testGetUpgradesRedToYellowWhenWordPressConnected() {
  resetAll()
  tables.clients = [{ id: 'client-1', url: 'https://example.com', wp_username: 'am', wp_app_password_encrypted: 'enc:abc' }]
  // opp-1 stays 'red' (resetAll's default) -- an already-approved opportunity
  // that predates this client's WordPress connection being synced.
  const res = await GET(getReq({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(spies.setPriorityTreatment.calls.length, 1, 'GET must self-heal a stale RED opportunity for an already-connected client')
  assert.strictEqual(spies.setPriorityTreatment.calls[0][0], 'opp-1')
  assert.strictEqual(spies.setPriorityTreatment.calls[0][1].executionCapability, 'yellow')
  assert.strictEqual(body.opportunity.execution_capability, 'yellow', 'the SAME response that triggered the sync must already reflect it -- no second round-trip required')
  log('TEST (GET reconciles a stale RED opportunity to YELLOW for an already-WordPress-connected client -- fixes the "Deploy to WordPress" button never appearing for opportunities approved before the connection was synced) PASSED')
}

async function testGetDowngradesYellowToRedWhenWordPressDisconnected() {
  resetAll()
  tables.opportunities = [{ id: 'opp-1', client_id: 'client-1', fingerprint: 'schema:/about', title: 'x', execution_capability: 'yellow' }]
  // Default client fixture has no wp_username/wp_app_password_encrypted.
  const res = await GET(getReq({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(spies.setPriorityTreatment.calls.length, 1)
  assert.strictEqual(spies.setPriorityTreatment.calls[0][1].executionCapability, 'red')
  assert.strictEqual(body.opportunity.execution_capability, 'red')
  log('TEST (GET also downgrades a stale YELLOW opportunity back to RED for a since-disconnected client) PASSED')
}

async function testGetIsNoopWhenCapabilityAlreadyMatches() {
  resetAll() // default: client disconnected, opp-1 already 'red' -- already correct
  const res = await GET(getReq({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  assert.strictEqual(spies.setPriorityTreatment.calls.length, 0, 'a GET read must never write or log a history event when capability already matches reality')
  log('TEST (GET makes no write when execution_capability already matches the client\'s real WordPress-connection state) PASSED')
}

async function testGetSyncFailureNeverBreaksTheRead() {
  resetAll()
  tables.clients = [{ id: 'client-1', url: 'https://example.com', wp_username: 'am', wp_app_password_encrypted: 'enc:abc' }]
  spies.setPriorityTreatment.reset(async () => { throw new Error('opportunity was concurrently modified') })
  const res = await GET(getReq({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200, 'a capability-sync failure during GET must never turn an otherwise-successful read into an error')
  const body = await res.json()
  assert.strictEqual(body.opportunity.id, 'opp-1')
  log('TEST (a setPriorityTreatment failure during GET\'s capability sync is swallowed -- the opportunity read still succeeds) PASSED')
}

// ---------------------------------------------------------------------
// 7. GET -- read-only refresh, no fetch/qualify/prepare.
// ---------------------------------------------------------------------
async function testGetReturnsExistingOpportunityWithoutRefetching() {
  resetAll()
  const res = await GET(getReq({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.opportunity.id, 'opp-1')
  assert.strictEqual(spies.analyzePage.calls.length, 0, 'GET must never trigger a live fetch/re-diagnosis')
  assert.strictEqual(spies.qualifySchemaPageOpportunity.calls.length, 0)
  assert.strictEqual(spies.buildPreparedSchemaWork.calls.length, 0)
  log('TEST (GET returns the existing opportunity/prepared-work/history read-only, with zero live fetch or re-qualification) PASSED')
}

async function testGetReturnsNullForANeverPreparedPage() {
  resetAll()
  const res = await GET(getReq({ path: '/never-prepared/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.opportunity, null)
  assert.deepStrictEqual(body.preparedWork, [])
  log('TEST (GET for a page with no opportunity yet returns opportunity: null, not an error) PASSED')
}

async function testGetPathValidation() {
  resetAll()
  const res = await GET(getReq({}), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (GET requires a path query parameter) PASSED')
}

// ---------------------------------------------------------------------
// 8-12. ERROR CLASSIFICATION -- 2026-09 persistence/integration debugging
// pass, Section 4/21. A thrown exception at any stage of the ANALYZE ->
// QUALIFY -> PREPARE -> SUBMIT-FOR-APPROVAL flow must come back as a real,
// classified HTTP error (never an uncaught 500 the client can't parse, and
// never something that could be mistaken client-side for "could not reach
// the server" -- that message is reserved for an actual fetch()-level
// network failure, which this server-side route can never produce itself).
// ---------------------------------------------------------------------
async function testAnalyzeFailureIsClassifiedAsPreparationFailedNotPersistence() {
  resetAll()
  spies.analyzePage.reset(async () => { throw Object.assign(new Error('site timed out'), { code: 'ETIMEDOUT' }) })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 502)
  const body = await res.json()
  assert.strictEqual(body.errorClass, 'preparation_failed')
  assert.strictEqual(body.phase, 'analyze')
  assert.strictEqual(body.code, 'ETIMEDOUT')
  assert.ok(!JSON.stringify(body).includes('site timed out'), 'the raw error message must never be echoed to the client')
  assert.strictEqual(spies.qualifySchemaPageOpportunity.calls.length, 0, 'a failed analysis must never reach qualify')
  log('TEST (an analyzePage exception is a 502 preparation_failed error, not a generic 500 or a network-error-shaped response) PASSED')
}

async function testQualifyFailureIsClassifiedAsPersistenceAndPreservesAnalysis() {
  resetAll()
  spies.qualifySchemaPageOpportunity.reset(async () => { throw Object.assign(new Error('column "originating_pillar" of relation "opportunities" does not exist'), { code: '42703' }) })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 500)
  const body = await res.json()
  assert.strictEqual(body.errorClass, 'persistence')
  assert.strictEqual(body.phase, 'qualify')
  assert.strictEqual(body.code, '42703')
  assert.ok(body.analysis, 'the diagnosis that already succeeded must still be returned to the client')
  assert.ok(!JSON.stringify(body).includes('does not exist'), 'the raw Postgres error message must never be echoed to the client')
  assert.strictEqual(spies.buildPreparedSchemaWork.calls.length, 0, 'a failed qualify must never reach prepare')
  log('TEST (a qualifySchemaPageOpportunity exception -- e.g. a real Postgres 42703 -- is a 500 persistence error with the diagnosis preserved and no raw DB message leaked) PASSED')
}

async function testBuildPreparedWorkFailureIsClassifiedAsPreparationFailed() {
  resetAll()
  spies.buildPreparedSchemaWork.reset(async () => { throw new Error('unexpected page shape') })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 500)
  const body = await res.json()
  assert.strictEqual(body.errorClass, 'preparation_failed')
  assert.strictEqual(body.phase, 'build_prepared_work')
  assert.strictEqual(body.opportunityId, 'opp-1', 'the opportunity was already durably qualified before this step failed, and that must be visible to the client')
  assert.strictEqual(spies.prepareWork.calls.length, 0)
  log('TEST (a buildPreparedSchemaWork exception is a preparation_failed error that still reports the already-saved opportunityId) PASSED')
}

async function testPrepareWorkFailureIsClassifiedAsPersistence() {
  resetAll()
  spies.prepareWork.reset(async () => { throw Object.assign(new Error('relation "opportunity_prepared_work" does not exist'), { code: '42P01' }) })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 500)
  const body = await res.json()
  assert.strictEqual(body.errorClass, 'persistence')
  assert.strictEqual(body.phase, 'prepare_work')
  assert.strictEqual(body.code, '42P01')
  assert.strictEqual(spies.submitForApproval.calls.length, 0)
  log('TEST (a prepareWork exception -- e.g. a missing opportunity_prepared_work table -- is a 500 persistence error, never surfaced as a network failure) PASSED')
}

async function testFinalReadFailureIsClassifiedAsPersistence() {
  resetAll()
  tables.opportunities = [] // .single() on the post-write read now finds nothing -> its own {error} path
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 500)
  const body = await res.json()
  assert.strictEqual(body.errorClass, 'persistence')
  assert.strictEqual(body.phase, 'final_read')
  log('TEST (a failure reading back the just-written opportunity is a 500 persistence error, not a silent 200 or an uncaught exception) PASSED')
}

async function testGetFailureIsClassifiedAsPersistenceNotLeakingRawError() {
  resetAll()
  forceThrowForTable = { table: 'opportunities', error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }
  const res = await GET(getReq({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 500)
  const body = await res.json()
  assert.strictEqual(body.errorClass, 'persistence')
  assert.strictEqual(body.phase, 'get_read')
  assert.strictEqual(body.code, 'ECONNRESET')
  assert.ok(!JSON.stringify(body).includes('connection reset'))
  log('TEST (GET surfaces a thrown Supabase error as a classified 500 persistence error, never a raw uncaught exception) PASSED')
}

async function main() {
  await testPathValidation()
  await testClientLookup()
  await testIneligibleAnalysisNeverQualifiesOrPrepares()
  await testEligibleAnalysisRunsFullFlow()
  await testPageWorkPersistenceFailureIsNonFatal()
  await testPreparationFailedNeverSubmittedForApproval()
  await testCapabilitySyncUpgradesRedToYellowWhenWordPressConnected()
  await testCapabilitySyncDowngradesYellowToRedWhenWordPressDisconnected()
  await testCapabilitySyncIsNoopWhenAlreadyMatching()
  await testCapabilitySyncFailureIsNonFatal()
  await testNeverCallsExecutionOrVerificationOrPublish()
  await testGetUpgradesRedToYellowWhenWordPressConnected()
  await testGetDowngradesYellowToRedWhenWordPressDisconnected()
  await testGetIsNoopWhenCapabilityAlreadyMatches()
  await testGetSyncFailureNeverBreaksTheRead()
  await testGetReturnsExistingOpportunityWithoutRefetching()
  await testGetReturnsNullForANeverPreparedPage()
  await testGetPathValidation()
  await testAnalyzeFailureIsClassifiedAsPreparationFailedNotPersistence()
  await testQualifyFailureIsClassifiedAsPersistenceAndPreservesAnalysis()
  await testBuildPreparedWorkFailureIsClassifiedAsPreparationFailed()
  await testPrepareWorkFailureIsClassifiedAsPersistence()
  await testFinalReadFailureIsClassifiedAsPersistence()
  await testGetFailureIsClassifiedAsPersistenceNotLeakingRawError()
  log('\nAll Phase 6 schema/prepare-work route tests passed (mocked dependencies + Supabase, no DB or network required).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
