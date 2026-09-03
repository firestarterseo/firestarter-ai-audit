// Tests for lib/schemaPageHydration.js -- the pure merge logic behind
// SchemaWizard.js's Phase 5 (2026-09) hydration effect. Plain `node`, no
// DOM/React harness (this codebase deliberately has none -- see
// lib/schemaPageSelection.test.js for the same convention).

const assert = require('assert')

const { mergeDurableQueuedPaths, mergeDurableAnalyses, durableOpportunityIdForPath } = require('./schemaPageHydration')

let passCount = 0
function test(name, fn) {
  fn()
  passCount++
  console.log(`PASS: ${name}`)
}

const ANALYSIS_IMPROVEMENT = { fetchState: 'success', finalStatus: 'IMPROVEMENT_AVAILABLE', classification: { type: 'About' } }

test('mergeDurableQueuedPaths adds candidate paths matching a queued durable row', () => {
  const rows = [{ normalizedPath: '/about', queueStatus: 'queued' }, { normalizedPath: '/contact', queueStatus: 'not_queued' }]
  const result = mergeDurableQueuedPaths(new Set(), rows, ['/about/', '/contact/', '/faq/'])
  assert.deepStrictEqual([...result].sort(), ['/about/'])
})

test('mergeDurableQueuedPaths matches via normalization even when the candidate path spelling differs (trailing slash)', () => {
  const rows = [{ normalizedPath: '/about', queueStatus: 'queued' }]
  const result = mergeDurableQueuedPaths(new Set(), rows, ['/about'])
  assert.ok(result.has('/about'))
})

test('mergeDurableQueuedPaths never removes a path already queued this session, even if durable state says not_queued', () => {
  const rows = [{ normalizedPath: '/about', queueStatus: 'not_queued' }]
  const result = mergeDurableQueuedPaths(new Set(['/about/']), rows, ['/about/'])
  assert.ok(result.has('/about/'), 'in-session queue state must never be wiped by a durable "not_queued" row')
})

test('mergeDurableQueuedPaths is a no-op (empty set) when there are no durable rows', () => {
  const result = mergeDurableQueuedPaths(new Set(), [], ['/about/'])
  assert.strictEqual(result.size, 0)
})

test('mergeDurableAnalyses seeds latestAnalysis for a candidate path matching an analyzed durable row', () => {
  const rows = [{ normalizedPath: '/about', analysisStatus: 'analyzed', latestAnalysis: ANALYSIS_IMPROVEMENT }]
  const result = mergeDurableAnalyses(new Map(), rows, ['/about/'])
  assert.deepStrictEqual(result.get('/about/'), ANALYSIS_IMPROVEMENT)
})

test('mergeDurableAnalyses never overwrites an existing in-session analysis with stale durable data', () => {
  const freshAnalysis = { fetchState: 'success', finalStatus: 'NO_ACTION_NEEDED' }
  const rows = [{ normalizedPath: '/about', analysisStatus: 'analyzed', latestAnalysis: ANALYSIS_IMPROVEMENT }]
  const existing = new Map([['/about/', freshAnalysis]])
  const result = mergeDurableAnalyses(existing, rows, ['/about/'])
  assert.strictEqual(result.get('/about/'), freshAnalysis, 'a fresher in-session analysis must survive a late-resolving hydration fetch')
})

test('mergeDurableAnalyses skips a durable row that has no analysis yet (queued but never analyzed)', () => {
  const rows = [{ normalizedPath: '/about', analysisStatus: 'unanalyzed', latestAnalysis: null }]
  const result = mergeDurableAnalyses(new Map(), rows, ['/about/'])
  assert.strictEqual(result.has('/about/'), false)
})

test('mergeDurableAnalyses seeds COULD_NOT_VERIFY and NO_ACTION_NEEDED analyses identically to any other final status', () => {
  const rows = [
    { normalizedPath: '/broken', analysisStatus: 'analyzed', latestAnalysis: { fetchState: 'failed', finalStatus: 'COULD_NOT_VERIFY' } },
    { normalizedPath: '/faq', analysisStatus: 'analyzed', latestAnalysis: { fetchState: 'success', finalStatus: 'NO_ACTION_NEEDED' } }
  ]
  const result = mergeDurableAnalyses(new Map(), rows, ['/broken/', '/faq/'])
  assert.strictEqual(result.get('/broken/').finalStatus, 'COULD_NOT_VERIFY')
  assert.strictEqual(result.get('/faq/').finalStatus, 'NO_ACTION_NEEDED')
})

test('durableOpportunityIdForPath returns the linked opportunity id, or null when none/unmatched', () => {
  const rows = [{ normalizedPath: '/about', opportunityId: 'opp-1' }]
  assert.strictEqual(durableOpportunityIdForPath(rows, '/about/'), 'opp-1')
  assert.strictEqual(durableOpportunityIdForPath(rows, '/contact/'), null)
  assert.strictEqual(durableOpportunityIdForPath([], '/about/'), null)
})

console.log(`\n${passCount} passed.`)
