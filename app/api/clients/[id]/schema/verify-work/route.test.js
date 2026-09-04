// Route-level tests for the Schema "VERIFY LIVE" / "RECHECK LIVE" endpoint
// (Phase 7, 2026-09-04). Same convention as
// app/api/clients/[id]/schema/prepare-work/route.test.js and
// .../execute-work/route.test.js -- plain Node, require.cache module
// injection, NO live Supabase connection or network fetch anywhere in this
// file. Run with:
//   node "app/api/clients/[id]/schema/verify-work/route.test.js"
//
// lib/schemaLiveVerification.js and lib/checkers/lightweight-jsonld.js are
// used FOR REAL (not mocked) -- both are pure/synchronous with no I/O, so
// tests exercise the ACTUAL live-HTML-vs-deployed-JSON-LD matching logic,
// not a mock that just agrees with itself. Everything with I/O (Supabase,
// the live page fetch, the Phase 3 lifecycle's requestVerification/
// recordVerification gate) is mocked.

const assert = require('assert')
const path = require('path')

const supabaseServerPath = require.resolve(path.join(__dirname, '../../../../../../lib/supabaseServer'))
const pageAnalysisPath = require.resolve(path.join(__dirname, '../../../../../../lib/pageAnalysis'))
const webPageFetchPath = require.resolve(path.join(__dirname, '../../../../../../lib/webPageFetch'))
const schemaPageWorkPath = require.resolve(path.join(__dirname, '../../../../../../lib/schemaPageWork'))
const opportunityLifecyclePath = require.resolve(path.join(__dirname, '../../../../../../lib/opportunityLifecycle'))
const routePath = require.resolve(path.join(__dirname, 'route'))

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
        }
      }
      return builder
    }
  }
}
function fakeSupabase() { return { from: (t) => makeTable(t) } }

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

const DEPLOYED_ABOUT = { '@context': 'https://schema.org', '@type': 'AboutPage', '@id': 'https://example.com/about/#aboutpage', url: 'https://example.com/about/' }
function htmlWithScript(node) { return `<html><head><script type="application/ld+json">${JSON.stringify(node)}</script></head><body>hi</body></html>` }
const HTML_MATCHING = htmlWithScript(DEPLOYED_ABOUT)
const HTML_MISSING = '<html><head></head><body>no schema here</body></html>'

const spies = {
  resolvePageUrl: makeSyncSpy((siteUrl, p) => `${siteUrl}${p}`),
  fetchWebPage: makeSpy(async () => ({ fetchState: 'success', html: HTML_MATCHING })),
  getPageWorkRow: makeSpy(async () => ({ opportunity_id: 'opp-1' })),
  requestVerification: makeSpy(async () => ({ ok: true })),
  recordVerification: makeSpy(async () => ({ ok: true }))
}

require.cache[supabaseServerPath] = { id: supabaseServerPath, filename: supabaseServerPath, loaded: true, exports: { getSupabaseServerClient: () => fakeSupabase() } }
require.cache[pageAnalysisPath] = { id: pageAnalysisPath, filename: pageAnalysisPath, loaded: true, exports: { resolvePageUrl: spies.resolvePageUrl } }
require.cache[webPageFetchPath] = { id: webPageFetchPath, filename: webPageFetchPath, loaded: true, exports: { fetchWebPage: spies.fetchWebPage } }
require.cache[schemaPageWorkPath] = { id: schemaPageWorkPath, filename: schemaPageWorkPath, loaded: true, exports: { getPageWorkRow: spies.getPageWorkRow } }
require.cache[opportunityLifecyclePath] = { id: opportunityLifecyclePath, filename: opportunityLifecyclePath, loaded: true, exports: { requestVerification: spies.requestVerification, recordVerification: spies.recordVerification } }

const { POST } = require(routePath)

function resetAll() {
  tables = {
    clients: [{ id: 'client-1', url: 'https://example.com' }],
    opportunities: [{
      id: 'opp-1', client_id: 'client-1', originating_pillar: 'schema_structure',
      execution_status: 'executed',
      execution_state: { result: { ok: true, deployedJsonLd: DEPLOYED_ABOUT, postId: 42 } }
    }]
  }
  spies.resolvePageUrl.reset((siteUrl, p) => `${siteUrl}${p}`)
  spies.fetchWebPage.reset(async () => ({ fetchState: 'success', html: HTML_MATCHING }))
  spies.getPageWorkRow.reset(async () => ({ opportunity_id: 'opp-1' }))
  spies.requestVerification.reset(async () => ({ ok: true }))
  spies.recordVerification.reset(async () => ({ ok: true }))
}

function req(body) { return { json: async () => body } }
function ctx(id = 'client-1') { return { params: { id } } }
function log(msg) { console.log(msg) }

async function testPathValidation() {
  resetAll()
  let res = await POST(req({}), ctx())
  assert.strictEqual(res.status, 400)
  res = await POST(req({ path: 'about' }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (path must be a site-relative path starting with "/") PASSED')
}

async function testClientLookupMissing() {
  resetAll()
  tables.clients = []
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 404)
  log('TEST (a missing client is rejected before any other check) PASSED')
}

async function testNoOpportunityForPage() {
  resetAll()
  spies.getPageWorkRow.reset(async () => null)
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (a page with no schema opportunity at all cannot be verified) PASSED')
}

async function testOriginatingPillarMismatch() {
  resetAll()
  tables.opportunities[0].originating_pillar = 'entity_authority'
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (an opportunity outside the Schema & Structure pillar is rejected) PASSED')
}

// ---------------------------------------------------------------------
// K. Execution-vs-verification separation -- the SHARED Phase 3 gate
// (requestVerification) is what enforces "execution must actually have
// completed first." This route adds no gate logic of its own; a gate
// rejection is surfaced exactly as the shared lifecycle raises it.
// ---------------------------------------------------------------------
async function testGateRejectsVerificationBeforeExecution() {
  resetAll()
  spies.requestVerification.reset(async () => { throw new Error('Cannot request verification: opportunity has not been executed or handed off yet.') })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 409)
  assert.strictEqual(spies.fetchWebPage.calls.length, 0, 'a gate rejection must never reach the live fetch')
  assert.strictEqual(spies.recordVerification.calls.length, 0)
  log('TEST (requestVerification\'s own Phase 3 gate rejects a verification attempt before execution has completed -- surfaced as-is, no duplicate gate logic here) PASSED')
}

// ---------------------------------------------------------------------
// No Firestarter-deployed artifact on record (e.g. a RED/human_completed
// execution) -- honestly inconclusive, never guessed.
// ---------------------------------------------------------------------
async function testNoDeployedArtifactIsInconclusive() {
  resetAll()
  tables.opportunities[0].execution_state = { result: { ok: true, deployedJsonLd: null } }
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.verificationStatus, 'inconclusive')
  assert.strictEqual(spies.fetchWebPage.calls.length, 0)
  assert.strictEqual(spies.recordVerification.calls[0][1].result, 'inconclusive')
  log('TEST (no Firestarter-deployed JSON-LD on record -- e.g. a manual/human_completed execution -- is honestly inconclusive, never guessed at) PASSED')
}

async function testUnresolvableUrlIsInconclusive() {
  resetAll()
  spies.resolvePageUrl.reset(() => null)
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.verificationStatus, 'inconclusive')
  assert.strictEqual(spies.fetchWebPage.calls.length, 0)
  log('TEST (an unresolvable absolute URL is inconclusive, not a crash or a false failure) PASSED')
}

// ---------------------------------------------------------------------
// L. Live verification success.
// ---------------------------------------------------------------------
async function testLiveVerificationSucceeds() {
  resetAll()
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.verificationStatus, 'verified')
  assert.strictEqual(spies.recordVerification.calls[0][1].result, 'verified')
  log('TEST (the deployed node found live, matching @type/@id/relationships, verifies) PASSED')
}

// ---------------------------------------------------------------------
// M. Expected node absent live -- a real VERIFICATION FAILED, never
// silently retried until green.
// ---------------------------------------------------------------------
async function testLiveVerificationFailsWhenNodeAbsent() {
  resetAll()
  spies.fetchWebPage.reset(async () => ({ fetchState: 'success', html: HTML_MISSING }))
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.verificationStatus, 'failed_verification')
  assert.strictEqual(spies.recordVerification.calls[0][1].result, 'failed_verification')
  log('TEST (the deployed node genuinely absent from the live page is a real failed_verification, not silently retried) PASSED')
}

// ---------------------------------------------------------------------
// Live fetch failure after a successful deployment -- "DEPLOYED — LIVE
// VERIFICATION COULD NOT BE COMPLETED," never execution failure or
// verification failure.
// ---------------------------------------------------------------------
async function testLiveFetchFailureIsInconclusiveNotFailure() {
  resetAll()
  spies.fetchWebPage.reset(async () => ({ fetchState: 'error', failureCategory: 'timeout', failureDetail: 'The site did not respond in time.' }))
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.verificationStatus, 'inconclusive')
  assert.strictEqual(body.message, 'DEPLOYED — LIVE VERIFICATION COULD NOT BE COMPLETED')
  assert.strictEqual(spies.recordVerification.calls[0][1].result, 'inconclusive')
  log('TEST (a live-fetch failure after a successful WordPress write is reported as DEPLOYED — LIVE VERIFICATION COULD NOT BE COMPLETED, never as an execution or verification failure) PASSED')
}

// ---------------------------------------------------------------------
// "Recheck Live" is the SAME action as the first "Verify Live" -- calling
// it again (e.g. after a cache/CDN propagation delay resolves) is
// expected to produce a fresh, independent result.
// ---------------------------------------------------------------------
async function testRecheckLiveIsTheSameActionCalledAgain() {
  resetAll()
  spies.fetchWebPage.reset(async () => ({ fetchState: 'error', failureCategory: 'timeout', failureDetail: 'still propagating' }))
  let res = await POST(req({ path: '/about/' }), ctx())
  let body = await res.json()
  assert.strictEqual(body.verificationStatus, 'inconclusive')

  // The CDN has now caught up -- the exact same action, called again,
  // reflects the new reality with no special "recheck" code path needed.
  spies.fetchWebPage.reset(async () => ({ fetchState: 'success', html: HTML_MATCHING }))
  res = await POST(req({ path: '/about/' }), ctx())
  body = await res.json()
  assert.strictEqual(body.verificationStatus, 'verified')
  assert.strictEqual(spies.recordVerification.calls.length, 2, 'each recheck records its own independent verification outcome')
  log('TEST ("Recheck Live" is the identical action as "Verify Live" called again -- a later call reflects a since-resolved propagation delay with no separate code path) PASSED')
}

async function main() {
  await testPathValidation()
  await testClientLookupMissing()
  await testNoOpportunityForPage()
  await testOriginatingPillarMismatch()
  await testGateRejectsVerificationBeforeExecution()
  await testNoDeployedArtifactIsInconclusive()
  await testUnresolvableUrlIsInconclusive()
  await testLiveVerificationSucceeds()
  await testLiveVerificationFailsWhenNodeAbsent()
  await testLiveFetchFailureIsInconclusiveNotFailure()
  await testRecheckLiveIsTheSameActionCalledAgain()
  log('\nAll Phase 7 schema/verify-work route tests passed (mocked Supabase/fetch/lifecycle, real live-verification matching logic, no DB or network required).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
