// Route-level tests for the Schema page-work queue-toggle POST endpoint
// (Phase 5, 2026-09). Plain Node, require.cache module injection -- no
// live Supabase connection or network fetch. Run with:
//   node "app/api/clients/[id]/schema/page-work/queue/route.test.js"

const assert = require('assert')
const path = require('path')

const supabaseServerPath = require.resolve(path.join(__dirname, '../../../../../../../lib/supabaseServer'))
const pageAnalysisPath = require.resolve(path.join(__dirname, '../../../../../../../lib/pageAnalysis'))
const schemaPageWorkPath = require.resolve(path.join(__dirname, '../../../../../../../lib/schemaPageWork'))
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

const spies = {
  resolvePageUrl: makeSyncSpy((siteUrl, p) => `${siteUrl}${p}`),
  upsertQueueState: makeSpy(async () => ({ id: 'pw-1', normalized_path: '/about', queue_status: 'queued', queued_at: '2026-09-01T00:00:00.000Z' }))
}

require.cache[supabaseServerPath] = { id: supabaseServerPath, filename: supabaseServerPath, loaded: true, exports: { getSupabaseServerClient: () => fakeSupabase() } }
require.cache[pageAnalysisPath] = { id: pageAnalysisPath, filename: pageAnalysisPath, loaded: true, exports: { resolvePageUrl: spies.resolvePageUrl } }
require.cache[schemaPageWorkPath] = { id: schemaPageWorkPath, filename: schemaPageWorkPath, loaded: true, exports: { upsertQueueState: spies.upsertQueueState } }

const { POST } = require(routePath)

function resetAll() {
  tables = { clients: [{ id: 'client-1', url: 'https://example.com' }] }
  spies.resolvePageUrl.reset((siteUrl, p) => `${siteUrl}${p}`)
  spies.upsertQueueState.reset(async () => ({ id: 'pw-1', normalized_path: '/about', queue_status: 'queued', queued_at: '2026-09-01T00:00:00.000Z' }))
}

function req(body) { return { json: async () => body } }
function ctx(id = 'client-1') { return { params: { id } } }
function log(msg) { console.log(msg) }

async function testPathValidation() {
  resetAll()
  let res = await POST(req({ queued: true }), ctx())
  assert.strictEqual(res.status, 400)
  res = await POST(req({ path: 'about', queued: true }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (path must be a site-relative path starting with "/") PASSED')
}

async function testQueuedMustBeBoolean() {
  resetAll()
  const res = await POST(req({ path: '/about/' }), ctx())
  assert.strictEqual(res.status, 400)
  const body = await res.json()
  assert.strictEqual(body.errorClass, 'validation')
  log('TEST (queued must be a boolean) PASSED')
}

async function testClientLookup() {
  resetAll()
  tables.clients = []
  let res = await POST(req({ path: '/about/', queued: true }), ctx())
  assert.strictEqual(res.status, 404)

  resetAll()
  tables.clients = [{ id: 'client-1', url: null }]
  res = await POST(req({ path: '/about/', queued: true }), ctx())
  assert.strictEqual(res.status, 400)
  log('TEST (a missing client or a client with no site URL is rejected before any persistence call) PASSED')
}

async function testUnresolvablePathIsRejected() {
  resetAll()
  spies.resolvePageUrl.reset(() => null)
  const res = await POST(req({ path: '/about/', queued: true }), ctx())
  assert.strictEqual(res.status, 400)
  assert.strictEqual(spies.upsertQueueState.calls.length, 0)
  log('TEST (a path that does not resolve to a same-origin URL is rejected before persistence) PASSED')
}

async function testQueueCallsUpsertQueueStateWithResolvedUrl() {
  resetAll()
  const res = await POST(req({ path: '/about/', queued: true, page: { type: 'About' } }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  assert.strictEqual(spies.upsertQueueState.calls.length, 1)
  const args = spies.upsertQueueState.calls[0][0]
  assert.strictEqual(args.clientId, 'client-1')
  assert.strictEqual(args.path, '/about/')
  assert.strictEqual(args.pageUrl, 'https://example.com/about/')
  assert.strictEqual(args.queued, true)
  assert.strictEqual(args.actor, 'am')
  assert.deepStrictEqual(args.classification, { type: 'About' })
  const body = await res.json()
  assert.strictEqual(body.row.normalizedPath, '/about')
  assert.strictEqual(body.row.queueStatus, 'queued')
  log('TEST (a queue request resolves the URL server-side and calls upsertQueueState with the right args) PASSED')
}

async function testUnqueueOfNeverQueuedPageReturnsNullRow() {
  resetAll()
  spies.upsertQueueState.reset(async () => null)
  const res = await POST(req({ path: '/never/', queued: false }), ctx())
  assert.strictEqual(res.status ?? 200, 200)
  const body = await res.json()
  assert.strictEqual(body.row, null)
  log('TEST (unqueueing a page with no durable row returns row: null, not an error) PASSED')
}

async function testPersistenceFailureIsClassified() {
  resetAll()
  spies.upsertQueueState.reset(async () => { throw Object.assign(new Error('relation "schema_page_work" does not exist'), { code: '42P01' }) })
  const res = await POST(req({ path: '/about/', queued: true }), ctx())
  assert.strictEqual(res.status, 500)
  const body = await res.json()
  assert.strictEqual(body.errorClass, 'persistence')
  assert.strictEqual(body.phase, 'upsert_queue_state')
  assert.strictEqual(body.code, '42P01')
  assert.ok(!JSON.stringify(body).includes('does not exist'))
  log('TEST (a thrown upsertQueueState error is a classified 500, never a raw uncaught exception or a fake success) PASSED')
}

async function main() {
  await testPathValidation()
  await testQueuedMustBeBoolean()
  await testClientLookup()
  await testUnresolvablePathIsRejected()
  await testQueueCallsUpsertQueueStateWithResolvedUrl()
  await testUnqueueOfNeverQueuedPageReturnsNullRow()
  await testPersistenceFailureIsClassified()
  log('\nAll schema/page-work/queue route tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
