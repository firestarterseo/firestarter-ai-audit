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
const routePath = require.resolve(path.join(__dirname, 'route'))

// ---------------------------------------------------------------------
// Fake Supabase -- generic enough for both tables this route reads:
// clients (POST) and opportunities (POST's final read + GET).
// ---------------------------------------------------------------------
let tables = { clients: [], opportunities: [] }

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
  getOpportunityHistory: makeSpy(async () => ([]))
}

require.cache[supabaseServerPath] = { id: supabaseServerPath, filename: supabaseServerPath, loaded: true, exports: { getSupabaseServerClient: () => fakeSupabase() } }
require.cache[pageAnalysisPath] = { id: pageAnalysisPath, filename: pageAnalysisPath, loaded: true, exports: { analyzePage: spies.analyzePage, resolvePageUrl: spies.resolvePageUrl } }
require.cache[schemaOpportunityPath] = { id: schemaOpportunityPath, filename: schemaOpportunityPath, loaded: true, exports: { isEligibleForPreparedWork: spies.isEligibleForPreparedWork, qualifySchemaPageOpportunity: spies.qualifySchemaPageOpportunity, buildSchemaOpportunityFingerprint: spies.buildSchemaOpportunityFingerprint } }
require.cache[schemaPreparedWorkPath] = { id: schemaPreparedWorkPath, filename: schemaPreparedWorkPath, loaded: true, exports: { buildPreparedSchemaWork: spies.buildPreparedSchemaWork } }
require.cache[opportunityLifecyclePath] = { id: opportunityLifecyclePath, filename: opportunityLifecyclePath, loaded: true, exports: { prepareWork: spies.prepareWork, submitForApproval: spies.submitForApproval, getPreparedWork: spies.getPreparedWork, getOpportunityHistory: spies.getOpportunityHistory } }

const { POST, GET } = require(routePath)

function resetAll() {
  tables = { clients: [{ id: 'client-1', url: 'https://example.com' }], opportunities: [{ id: 'opp-1', client_id: 'client-1', fingerprint: 'schema:/about', title: 'x' }] }
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
  log('TEST (an eligible page runs the full ANALYZE -> QUALIFY -> PREPARE -> SUBMIT-FOR-APPROVAL flow, never touching WordPress/execution/verification) PASSED')
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
  assert.deepStrictEqual(imported.sort(), ['getOpportunityHistory', 'getPreparedWork', 'prepareWork', 'submitForApproval'].sort())
  for (const forbidden of ['executeOpportunity', 'requestHandoff', 'recordHandoff', 'recordHumanCompleted', 'requestVerification', 'recordVerification', 'requestRetest', 'recordRetestResult']) {
    assert.ok(!imported.includes(forbidden), `route.js must never import ${forbidden}`)
  }
  assert.ok(!/require\([^)]*wordpress[^)]*\)/i.test(source), 'route.js must never require a WordPress/publish module')
  log('TEST (route.js only imports prepareWork/submitForApproval/getPreparedWork/getOpportunityHistory -- execution/handoff/verification/retest primitives are never even imported, and no WordPress module is required) PASSED')
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

async function main() {
  await testPathValidation()
  await testClientLookup()
  await testIneligibleAnalysisNeverQualifiesOrPrepares()
  await testEligibleAnalysisRunsFullFlow()
  await testPreparationFailedNeverSubmittedForApproval()
  await testNeverCallsExecutionOrVerificationOrPublish()
  await testGetReturnsExistingOpportunityWithoutRefetching()
  await testGetReturnsNullForANeverPreparedPage()
  await testGetPathValidation()
  log('\nAll Phase 6 schema/prepare-work route tests passed (mocked dependencies + Supabase, no DB or network required).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
