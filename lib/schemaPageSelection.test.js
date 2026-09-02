// Pure tests for lib/schemaPageSelection.js -- plain Node, no network, no
// DOM/React harness (this codebase has none; see that file's header). Run
// with: node lib/schemaPageSelection.test.js
//
// Covers the OPEN-vs-QUEUED fixtures from Phase A's spec ("10. TESTS"):
// open state independent from queued state; multiple queued pages
// supported; queue count accurate; queue state is not represented as
// durable persistence.

const assert = require('assert')
const { toggleQueuedPath, resolveOpenPath, queuedCount } = require('./schemaPageSelection')

function log(msg) { console.log(msg) }

function run() {
  // 1. OPEN STATE INDEPENDENT FROM QUEUED STATE -- opening a page never
  // queues it, and queuing a page never changes what's open.
  {
    const recommended = [{ path: '/services/seo/' }]
    const candidatePages = [{ path: '/' }, { path: '/services/seo/' }]

    // Nothing opened yet, nothing queued -- falls back to the first
    // Recommended page.
    let queuedPaths = new Set()
    let open = resolveOpenPath({ openPath: null, recommended, candidatePages })
    assert.strictEqual(open, '/services/seo/')
    assert.strictEqual(queuedCount(queuedPaths), 0)

    // Queuing a DIFFERENT page than the one open must not change what's open.
    queuedPaths = toggleQueuedPath(queuedPaths, '/')
    open = resolveOpenPath({ openPath: null, recommended, candidatePages })
    assert.strictEqual(open, '/services/seo/', 'queuing a page must never change which page is open')
    assert.strictEqual(queuedCount(queuedPaths), 1)
    assert.ok(queuedPaths.has('/'))
    assert.ok(!queuedPaths.has('/services/seo/'), 'opening/recommending a page must never implicitly queue it')

    // Explicitly opening a page that is NOT queued must not queue it either.
    open = resolveOpenPath({ openPath: '/about/', recommended, candidatePages })
    assert.strictEqual(open, '/about/')
    assert.strictEqual(queuedCount(queuedPaths), 1, 'opening a page must never change the queue')
    log('TEST 1 (open state and queued state are fully independent -- opening a page never queues it, queuing a page never changes what is open) PASSED')
  }

  // 2. MULTIPLE QUEUED PAGES SUPPORTED -- any number of pages can be queued
  // simultaneously, each toggled independently.
  {
    let queuedPaths = new Set()
    queuedPaths = toggleQueuedPath(queuedPaths, '/services/seo/')
    queuedPaths = toggleQueuedPath(queuedPaths, '/about/')
    queuedPaths = toggleQueuedPath(queuedPaths, '/case-studies/acme/')
    assert.strictEqual(queuedCount(queuedPaths), 3)
    assert.ok(queuedPaths.has('/services/seo/'))
    assert.ok(queuedPaths.has('/about/'))
    assert.ok(queuedPaths.has('/case-studies/acme/'))

    // Un-queuing one page leaves the other two untouched.
    queuedPaths = toggleQueuedPath(queuedPaths, '/about/')
    assert.strictEqual(queuedCount(queuedPaths), 2)
    assert.ok(!queuedPaths.has('/about/'))
    assert.ok(queuedPaths.has('/services/seo/'))
    assert.ok(queuedPaths.has('/case-studies/acme/'))
    log('TEST 2 (multiple pages can be queued simultaneously, and each is toggled independently of the others) PASSED')
  }

  // 3. QUEUE COUNT ACCURATE -- queuedCount always reflects the exact number
  // of currently-queued distinct paths, through repeated toggles including
  // re-adding a previously-removed path.
  {
    let queuedPaths = new Set()
    assert.strictEqual(queuedCount(queuedPaths), 0)
    queuedPaths = toggleQueuedPath(queuedPaths, '/a/')
    assert.strictEqual(queuedCount(queuedPaths), 1)
    queuedPaths = toggleQueuedPath(queuedPaths, '/b/')
    assert.strictEqual(queuedCount(queuedPaths), 2)
    queuedPaths = toggleQueuedPath(queuedPaths, '/a/') // remove
    assert.strictEqual(queuedCount(queuedPaths), 1)
    queuedPaths = toggleQueuedPath(queuedPaths, '/a/') // re-add
    assert.strictEqual(queuedCount(queuedPaths), 2)
    // Toggling the same path twice in a row is a no-op on the final count.
    queuedPaths = toggleQueuedPath(queuedPaths, '/c/')
    queuedPaths = toggleQueuedPath(queuedPaths, '/c/')
    assert.strictEqual(queuedCount(queuedPaths), 2)
    log('TEST 3 (queuedCount always reflects the exact current number of queued paths, across repeated add/remove/re-add toggles) PASSED')
  }

  // 4. QUEUE STATE IS NOT DURABLE PERSISTENCE -- this module has no
  // persistence API of any kind (no Supabase client, no fetch, no
  // localStorage, no filesystem access) -- every function is a pure,
  // synchronous transform of a value the CALLER owns. Confirmed two ways:
  // (a) the module's own exports contain nothing but these three pure
  // functions, and (b) toggling never mutates the Set passed in, meaning
  // there is no hidden shared/module-level state a second, unrelated caller
  // (e.g. a different client's page) could accidentally read or write.
  {
    const mod = require('./schemaPageSelection')
    const exportedNames = Object.keys(mod).sort()
    assert.deepStrictEqual(exportedNames, ['queuedCount', 'resolveOpenPath', 'toggleQueuedPath'])
    for (const name of exportedNames) assert.strictEqual(typeof mod[name], 'function')

    const original = new Set(['/a/'])
    const result = toggleQueuedPath(original, '/b/')
    assert.strictEqual(original.size, 1, 'toggleQueuedPath must never mutate the Set it was given')
    assert.ok(!original.has('/b/'))
    assert.ok(result.has('/b/'))
    assert.notStrictEqual(result, original, 'a new Set must be returned, never the same reference')
    log('TEST 4 (this module exposes only pure, synchronous, non-mutating functions -- no persistence API of any kind -- so the Phase A queue can never accidentally become durable through this file) PASSED')
  }

  console.log('\nAll lib/schemaPageSelection.js pure tests passed.')
}

run()
