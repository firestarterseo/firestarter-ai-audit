// Route-level tests for the Schema page-work hydration GET endpoint
// (Phase 5, 2026-09). Plain Node, require.cache module injection -- no
// live Supabase connection. Run with:
//   node "app/api/clients/[id]/schema/page-work/route.test.js"

const assert = require('assert')
const path = require('path')

const schemaPageWorkPath = require.resolve(path.join(__dirname, '../../../../../../lib/schemaPageWork'))
const routePath = require.resolve(path.join(__dirname, 'route'))

function makeSpy(defaultImpl) {
  const calls = []
  let impl = defaultImpl
  const fn = async (...args) => { calls.push(args); return impl(...args) }
  fn.calls = calls
  fn.reset = (nextDefault = defaultImpl) => { calls.length = 0; impl = nextDefault }
  return fn
}

const ROW = {
  id: 'pw-1', client_id: 'client-1', normalized_path: '/about', page_url: 'https://example.com/about/',
  classification: { type: 'About' }, target_profile: 'ABOUT', queue_status: 'queued', queued_at: '2026-09-01T00:00:00.000Z',
  analysis_status: 'analyzed', analyzed_at: '2026-09-01T00:00:01.000Z', final_status: 'IMPROVEMENT_AVAILABLE',
  latest_analysis: { finalStatus: 'IMPROVEMENT_AVAILABLE' }, opportunity_id: null,
  last_seen_in_sitemap_at: '2026-09-01T00:00:01.000Z', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:01.000Z'
}

const spies = {
  getPageWorkForClient: makeSpy(async () => [ROW])
}
require.cache[schemaPageWorkPath] = { id: schemaPageWorkPath, filename: schemaPageWorkPath, loaded: true, exports: spies }

const { GET } = require(routePath)

function ctx(id = 'client-1') { return { params: { id } } }

async function testHydrationShapesEveryFieldSchemaWizardNeeds() {
  spies.getPageWorkForClient.reset(async () => [ROW])
  const res = await GET({}, ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.pages.length, 1)
  const p = body.pages[0]
  assert.deepStrictEqual(p, {
    normalizedPath: '/about', pageUrl: 'https://example.com/about/', classification: { type: 'About' },
    targetProfile: 'ABOUT', queueStatus: 'queued', analysisStatus: 'analyzed', analyzedAt: '2026-09-01T00:00:01.000Z',
    finalStatus: 'IMPROVEMENT_AVAILABLE', latestAnalysis: { finalStatus: 'IMPROVEMENT_AVAILABLE' }, opportunityId: null
  })
  // Never leaks Phase-3-only fields, id, or raw row shape.
  for (const forbidden of ['approval_status', 'execution_status', 'verification_status', 'retest_status', 'id', 'client_id']) {
    assert.ok(!(forbidden in p), `hydration response must never carry a raw ${forbidden} field`)
  }
  console.log('TEST (GET returns exactly the fields SchemaWizard.js needs, camelCased, with no raw row leakage) PASSED')
}

async function testEmptyClientReturnsEmptyPages() {
  spies.getPageWorkForClient.reset(async () => [])
  const res = await GET({}, ctx())
  const body = await res.json()
  assert.deepStrictEqual(body.pages, [])
  console.log('TEST (a client with no durable page-work rows yet gets pages: [], not an error) PASSED')
}

async function testFailureIsClassifiedAsPersistence() {
  spies.getPageWorkForClient.reset(async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) })
  const res = await GET({}, ctx())
  assert.strictEqual(res.status, 500)
  const body = await res.json()
  assert.strictEqual(body.errorClass, 'persistence')
  assert.strictEqual(body.phase, 'get_read')
  assert.strictEqual(body.code, 'ECONNRESET')
  assert.ok(!JSON.stringify(body).includes('connection reset'))
  console.log('TEST (a thrown data-layer error is a classified 500, never a raw uncaught exception) PASSED')
}

async function main() {
  await testHydrationShapesEveryFieldSchemaWizardNeeds()
  await testEmptyClientReturnsEmptyPages()
  await testFailureIsClassifiedAsPersistence()
  console.log('\nAll schema/page-work GET route tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
