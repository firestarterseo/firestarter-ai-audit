// Route-level tests for the Schema page analysis POST endpoint (Phase B,
// 2026-09-02, extended in Phase 5, 2026-09 with durable page-work
// persistence). Plain Node, require.cache module injection -- no live
// Supabase connection or network fetch. This file did not previously
// exist; created alongside the Phase 5 persistence wiring so this route's
// path validation, client lookup, and (new) best-effort persistence
// behavior all have real coverage. Run with:
//   node "app/api/clients/[id]/schema/analyze-page/route.test.js"

const assert = require('assert')
const path = require('path')

const supabaseServerPath = require.resolve(path.join(__dirname, '../../../../../../lib/supabaseServer'))
const pageAnalysisPath = require.resolve(path.join(__dirname, '../../../../../../lib/pageAnalysis'))
const schemaPageWorkPath = require.resolve(path.join(__dirname, '../../../../../../lib/schemaPageWork'))
const routePath = require.resolve(path.join(__dirname, 'route'))

let tables = { clients: [] }

function fakeSupabase() {
  return {
    from(tableName) {
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
  }
}

function makeSpy(defaultImpl) {
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

const ANALYSIS_IMPROVEMENT = { path: '/about/', fetchState: 'success', finalStatus: 'IMPROVEMENT_AVAILABLE', classification: { type: 'About' }, coreChecks: [], recommendedChecks: [] }
const ANALYSIS_COULD_NOT_VERIFY = { path: '/broken/', fetchState: 'failed', finalStatus: 'COULD_NOT_VERIFY', coreChecks: [], recommendedChecks: [] }

const spies = {
  analyzePage: makeSpy(async () => ANALYSIS_IMPROVEMENT),
  resolvePageUrl: makeSyncSpy((siteUrl, p) => `${siteUrl}${p}`),
  upsertAnalysisResult: makeSpy(async () => ({ id: 'pw-1' }))
}

require.cache[supabaseServerPath] = { id: supabaseServerPath, filename: supabaseServerPath, loaded: true, exports: { getSupabaseServerClient: () => fakeSupabase() } }
require.cache[pageAnalysisPath] = { id: pageAnalysisPath, filename: pageAnalysisPath, loaded: true, exports: { analyzePage: spies.analyzePage, resolvePageUrl: spies.resolvePageUrl } }
require.cache[schemaPageWorkPath] = { id: schemaPageWorkPath, filename: schemaPageWorkPath, loaded: true, exports: { upsertAnalysisResult: spies.upsertAnalysisResult } }

const { POST } = require(routePath)

function resetAll() {
  tables = { clients: [{ id: 'client-1', url: 'https://example.com' }] }
  spies.analyzePage.reset(async () => ANALYSIS_IMPROVEMENT)
  spies.resolvePageUrl.reset((siteUrl, p) => `${siteUrl}${p}`)
  spies.upsertAnalysisResult.reset(async () => ({ id: 'pw-1' }))
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

async function testClientLookup() {
  resetAll()
  tables.clients = []
  let res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 404)

  resetAll()
  tables.clients = [{ id: 'client-1', url: null }]
  res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (a missing client or a client with no site URL is rejected before any fetch/persistence) PASSED')
}

async function testSuccessfulAnalysisIsReturnedAndPersisted() {
  resetAll()
  const res = await POST(req({ path: '/about/', page: { type: 'About', classificationSource: 'sitemap', classificationConfidence: 'high' } }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.finalStatus, 'IMPROVEMENT_AVAILABLE')
  assert.deepStrictEqual(body.persistence, { ok: true })
  assert.strictEqual(spies.upsertAnalysisResult.calls.length, 1)
  const args = spies.upsertAnalysisResult.calls[0][0]
  assert.strictEqual(args.clientId, 'client-1')
  assert.strictEqual(args.path, '/about/')
  assert.strictEqual(args.pageUrl, 'https://example.com/about/')
  assert.strictEqual(args.analysis, ANALYSIS_IMPROVEMENT)
  assert.strictEqual(args.actor, 'system')
  assert.deepStrictEqual(args.classification, { type: 'About', source: 'sitemap', confidence: 'high' })
  log('TEST (a successful analysis is returned verbatim and persisted with the resolved page URL) PASSED')
}

async function testCouldNotVerifyIsPersistedIdenticallyToAnySuccessfulDiagnosis() {
  resetAll()
  spies.analyzePage.reset(async () => ANALYSIS_COULD_NOT_VERIFY)
  const res = await POST(req({ path: '/broken/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.finalStatus, 'COULD_NOT_VERIFY')
  assert.strictEqual(spies.upsertAnalysisResult.calls.length, 1, 'a genuine fetch failure must still be persisted, never skipped')
  assert.strictEqual(spies.upsertAnalysisResult.calls[0][0].analysis, ANALYSIS_COULD_NOT_VERIFY)
  log('TEST (COULD_NOT_VERIFY, including a genuine fetch failure, is persisted identically to any other diagnosis) PASSED')
}

async function testPersistenceFailureIsNonFatalAndDiagnosisIsNeverWithheld() {
  resetAll()
  spies.upsertAnalysisResult.reset(async () => { throw Object.assign(new Error('relation "schema_page_work" does not exist'), { code: '42P01' }) })
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status ?? 200, 200, 'a persistence failure must never turn a successful diagnosis into an error response')
  const body = await res.json()
  assert.strictEqual(body.finalStatus, 'IMPROVEMENT_AVAILABLE', 'the real diagnosis must never be withheld because of a database hiccup')
  assert.strictEqual(body.persistence.ok, false)
  assert.strictEqual(body.persistence.errorClass, 'persistence')
  assert.strictEqual(body.persistence.phase, 'upsert_analysis_result')
  assert.strictEqual(body.persistence.code, '42P01')
  assert.ok(!JSON.stringify(body.persistence).includes('does not exist'), 'the raw Postgres error message must never be echoed to the client')
  log('TEST (a schema_page_work persistence failure is non-fatal -- the diagnosis is still returned, with the failure reported via persistence) PASSED')
}

async function main() {
  await testPathValidation()
  await testClientLookup()
  await testSuccessfulAnalysisIsReturnedAndPersisted()
  await testCouldNotVerifyIsPersistedIdenticallyToAnySuccessfulDiagnosis()
  await testPersistenceFailureIsNonFatalAndDiagnosisIsNeverWithheld()
  log('\nAll schema/analyze-page route tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
