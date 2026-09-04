// Pure tests for lib/schemaBatchAnalysis.js -- plain Node, no network, no
// DOM/React harness (this codebase has none; see that file's header). Run
// with: node lib/schemaBatchAnalysis.test.js
//
// Covers Phase 6's "11. CONCURRENCY / IDEMPOTENCY" guarantees: results
// preserve input order regardless of completion timing; concurrency is
// actually bounded; one item's failure never affects another's result or
// stops the batch; the function never throws itself, even in edge cases
// (empty input, a non-array, an all-rejecting worker, a nonsense
// concurrency value).

const assert = require('assert')
const { runWithBoundedConcurrency } = require('./schemaBatchAnalysis')

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function log(msg) { console.log(msg) }

async function run() {
  // 1. RESULTS PRESERVE INPUT ORDER regardless of completion order -- an
  // item scheduled first but finishing LAST must still land at its own
  // index, never wherever it happened to resolve.
  {
    const items = [30, 5, 20, 1]
    const results = await runWithBoundedConcurrency(items, async (ms) => {
      await delay(ms)
      return ms
    }, 4)
    assert.deepStrictEqual(results.map(r => r.value), [30, 5, 20, 1], 'results must be in the same order as the input items, not completion order')
    assert.ok(results.every(r => r.status === 'fulfilled'))
    log('TEST 1 (results preserve input order regardless of actual completion order) PASSED')
  }

  // 2. CONCURRENCY IS ACTUALLY BOUNDED -- with concurrency=2 over 6 items
  // that each hold their slot briefly, at most 2 should ever be in flight
  // at once.
  {
    let inFlight = 0
    let maxInFlight = 0
    const items = [1, 2, 3, 4, 5, 6]
    await runWithBoundedConcurrency(items, async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await delay(15)
      inFlight -= 1
    }, 2)
    assert.strictEqual(maxInFlight, 2, `expected at most 2 concurrent workers, saw ${maxInFlight}`)
    log('TEST 2 (concurrency is actually bounded to the requested limit) PASSED')
  }

  // 3. ONE ITEM FAILING NEVER INVALIDATES OR STOPS THE OTHERS -- the exact
  // Phase 6 Section 11 guarantee. A rejecting worker for one item must
  // still let every other item run to completion and be reported
  // correctly.
  {
    const items = ['/a/', '/b/', '/c/', '/d/']
    const results = await runWithBoundedConcurrency(items, async (path) => {
      if (path === '/b/') throw new Error('simulated failure for /b/')
      return `ok:${path}`
    }, 2)
    assert.strictEqual(results.length, 4, 'every item must get exactly one result')
    assert.strictEqual(results[0].status, 'fulfilled')
    assert.strictEqual(results[0].value, 'ok:/a/')
    assert.strictEqual(results[1].status, 'rejected')
    assert.strictEqual(results[1].error.message, 'simulated failure for /b/')
    assert.strictEqual(results[2].status, 'fulfilled')
    assert.strictEqual(results[2].value, 'ok:/c/')
    assert.strictEqual(results[3].status, 'fulfilled')
    assert.strictEqual(results[3].value, 'ok:/d/')
    log('TEST 3 (one item failing never invalidates or blocks any other item -- each gets its own independent result) PASSED')
  }

  // 4. A WORKER THAT REJECTS (returns a rejected promise, never throws
  // synchronously) is handled identically to one that throws.
  {
    const results = await runWithBoundedConcurrency([1, 2], (n) => (
      n === 1 ? Promise.reject(new Error('rejected promise')) : Promise.resolve('fine')
    ), 2)
    assert.strictEqual(results[0].status, 'rejected')
    assert.strictEqual(results[0].error.message, 'rejected promise')
    assert.strictEqual(results[1].status, 'fulfilled')
    assert.strictEqual(results[1].value, 'fine')
    log('TEST 4 (a worker returning a rejected promise is handled the same as one that throws) PASSED')
  }

  // 5. THE FUNCTION ITSELF NEVER THROWS, in edge cases: empty array,
  // non-array input, every worker call rejecting, and a nonsense
  // concurrency value (0, negative, or NaN) that would otherwise leave
  // nothing scheduled and hang forever.
  {
    assert.deepStrictEqual(await runWithBoundedConcurrency([], async () => 'x', 3), [])
    assert.deepStrictEqual(await runWithBoundedConcurrency(null, async () => 'x', 3), [])
    assert.deepStrictEqual(await runWithBoundedConcurrency(undefined, async () => 'x', 3), [])

    const allFail = await runWithBoundedConcurrency([1, 2, 3], async () => { throw new Error('always fails') }, 3)
    assert.strictEqual(allFail.length, 3)
    assert.ok(allFail.every(r => r.status === 'rejected'))

    const zeroConcurrency = await runWithBoundedConcurrency([1, 2], async (n) => n * 2, 0)
    assert.deepStrictEqual(zeroConcurrency.map(r => r.value), [2, 4], 'concurrency <= 0 must be clamped to at least 1, never hang')

    const negativeConcurrency = await runWithBoundedConcurrency([1, 2], async (n) => n * 2, -5)
    assert.deepStrictEqual(negativeConcurrency.map(r => r.value), [2, 4])

    const nanConcurrency = await runWithBoundedConcurrency([1, 2], async (n) => n * 2, NaN)
    assert.deepStrictEqual(nanConcurrency.map(r => r.value), [2, 4])

    const hugeConcurrency = await runWithBoundedConcurrency([1, 2], async (n) => n * 2, 999)
    assert.deepStrictEqual(hugeConcurrency.map(r => r.value), [2, 4], 'concurrency greater than item count must not error or duplicate work')

    log('TEST 5 (never throws on empty/non-array input, an all-rejecting worker, or a nonsense concurrency value) PASSED')
  }

  // 6. ITEMS ARE NEVER MUTATED, and each worker receives its own item plus
  // its index.
  {
    const items = [{ path: '/a/' }, { path: '/b/' }]
    const seenIndexes = []
    const results = await runWithBoundedConcurrency(items, async (item, index) => {
      seenIndexes.push(index)
      return item.path
    }, 2)
    assert.deepStrictEqual(seenIndexes.sort(), [0, 1])
    assert.deepStrictEqual(results.map(r => r.item), items)
    assert.strictEqual(results[0].item, items[0], 'the exact original item reference must be preserved on the result')
    log('TEST 6 (each worker receives its item and index; items are passed through unmutated) PASSED')
  }

  console.log('\nAll lib/schemaBatchAnalysis.js pure tests passed.')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
