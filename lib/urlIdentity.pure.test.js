// Pure tests for lib/urlIdentity.js -- plain Node, no network, no DB.
// Run with: node lib/urlIdentity.pure.test.js
//
// Phase 2B ("Discovery Observation + URL Identity Primitives", 2026-09-02).

const assert = require('assert')
const { normalizeUrlIdentity } = require('./urlIdentity')

function log(msg) { console.log(msg) }

function run() {
  // 1. www normalization
  {
    const withWww = normalizeUrlIdentity('https://www.example.com/page')
    const withoutWww = normalizeUrlIdentity('https://example.com/page')
    assert.strictEqual(withWww.valid, true)
    assert.strictEqual(withWww.normalized.hostname, 'example.com')
    assert.strictEqual(withWww.key, withoutWww.key)
    log('TEST 1 (a leading "www." is stripped, so the www and bare-domain forms of the same URL share one identity) PASSED')
  }

  // 2. hostname case normalization
  {
    const upper = normalizeUrlIdentity('https://EXAMPLE.com/page')
    const lower = normalizeUrlIdentity('https://example.com/page')
    assert.strictEqual(upper.key, lower.key)
    log('TEST 2 (hostname case is normalized -- EXAMPLE.com and example.com share one identity) PASSED')
  }

  // 3. fragment removal
  {
    const withFragment = normalizeUrlIdentity('https://example.com/page#section-2')
    const withoutFragment = normalizeUrlIdentity('https://example.com/page')
    assert.strictEqual(withFragment.key, withoutFragment.key)
    assert.ok(!withFragment.key.includes('#'))
    log('TEST 3 (a URL fragment is removed entirely from the identity) PASSED')
  }

  // 4. utm parameter removal
  {
    const withUtm = normalizeUrlIdentity('https://example.com/page?utm_source=chatgpt&utm_medium=ai')
    const bare = normalizeUrlIdentity('https://example.com/page')
    assert.strictEqual(withUtm.key, bare.key)
    log('TEST 4 (utm_* tracking parameters are removed, so a tracked and untracked link to the same page share one identity) PASSED')
  }

  // 5. meaningful query parameter preservation
  {
    const withRealParam = normalizeUrlIdentity('https://example.com/search?q=seo+agency')
    const different = normalizeUrlIdentity('https://example.com/search?q=web+design')
    const same = normalizeUrlIdentity('https://example.com/search?q=seo+agency')
    assert.notStrictEqual(withRealParam.key, different.key)
    assert.strictEqual(withRealParam.key, same.key)
    assert.ok(withRealParam.key.includes('q=seo'))
    log('TEST 5 (a non-tracking query parameter is preserved and remains part of the identity -- never aggressively stripped) PASSED')
  }

  // 5b. mixed tracking + meaningful params: only tracking ones are dropped,
  // and param order does not change the resulting identity (a stable sort,
  // not a content change).
  {
    const a = normalizeUrlIdentity('https://example.com/search?utm_source=x&q=seo&utm_campaign=y')
    const b = normalizeUrlIdentity('https://example.com/search?q=seo')
    const c = normalizeUrlIdentity('https://example.com/search?q=seo&utm_source=z')
    assert.strictEqual(a.key, b.key)
    assert.strictEqual(b.key, c.key)
    log('TEST 5b (tracking and meaningful parameters mixed together still resolve to the same identity once tracking params are removed) PASSED')
  }

  // 6. trailing slash normalization
  {
    const withSlash = normalizeUrlIdentity('https://example.com/page/')
    const withoutSlash = normalizeUrlIdentity('https://example.com/page')
    assert.strictEqual(withSlash.key, withoutSlash.key)
    // The bare root is left alone -- nothing trivial to strip.
    const root = normalizeUrlIdentity('https://example.com/')
    assert.strictEqual(root.normalized.path, '/')
    log('TEST 6 (a trivial trailing-slash difference is normalized, but the bare root path is left as "/") PASSED')
  }

  // 7. two different paths remain distinct
  {
    const pageA = normalizeUrlIdentity('https://example.com/page-a')
    const pageB = normalizeUrlIdentity('https://example.com/page-b')
    assert.notStrictEqual(pageA.key, pageB.key)
    log('TEST 7 (two different paths on the same domain are never collapsed into one identity) PASSED')
  }

  // 8. malformed URL fails safely
  {
    const malformed = normalizeUrlIdentity('not a url at all')
    assert.strictEqual(malformed.valid, false)
    assert.strictEqual(malformed.normalized, null)
    assert.strictEqual(malformed.key, null)
    assert.strictEqual(malformed.raw, 'not a url at all')
    assert.ok(malformed.error)
    log('TEST 8 (an unparseable URL never throws -- it comes back with valid:false and a null identity, never a guess) PASSED')
  }

  // 8b. empty / non-string input also fails safely, never throws
  {
    const empty = normalizeUrlIdentity('')
    const nullish = normalizeUrlIdentity(null)
    const undef = normalizeUrlIdentity(undefined)
    const num = normalizeUrlIdentity(12345)
    for (const r of [empty, nullish, undef, num]) {
      assert.strictEqual(r.valid, false)
      assert.strictEqual(r.key, null)
    }
    log('TEST 8b (empty string, null, undefined, and non-string input all fail safely without throwing) PASSED')
  }

  // 9. protocol and port are NOT collapsed -- deliberately conservative
  {
    const http = normalizeUrlIdentity('http://example.com/page')
    const https = normalizeUrlIdentity('https://example.com/page')
    assert.notStrictEqual(http.key, https.key, 'http and https must remain distinct pre-fetch identities -- reconciling them is finalUrl\'s job, not this file\'s')
    const withPort = normalizeUrlIdentity('https://example.com:8443/page')
    const withoutPort = normalizeUrlIdentity('https://example.com/page')
    assert.notStrictEqual(withPort.key, withoutPort.key)
    log('TEST 9 (protocol and a non-default port are never collapsed -- conservative by design, distinct until a real fetch says otherwise) PASSED')
  }

  console.log('\nAll lib/urlIdentity.js pure tests passed (no network calls, no DB required).')
}

run()
