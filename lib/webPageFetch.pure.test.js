// Pure/mocked tests for lib/webPageFetch.js -- plain Node, no real network
// calls, no DB. Run with: node lib/webPageFetch.pure.test.js
//
// Phase 2A ("Shared Web Page Fetch / Inspection Infrastructure",
// 2026-09-01), STEP 8. Every fetcher here is a hand-rolled mock (same
// injectable-fetcher convention this repo already uses in
// lib/citedPageInspection.js, lib/checkers/technical-checker.js, etc.) --
// no real URL is ever contacted by this file.

const assert = require('assert')
const {
  fetchWebPage, checkRobotsAllowed, categorizeHttpStatus, looksLikeHtmlContentType, readBoundedText
} = require('./webPageFetch')

function log(msg) { console.log(msg) }

// Minimal fetch-Response-shaped mock. headers defaults to a real-ish Headers
// object (via a Map) so contentType extraction is exercised in the common
// case; individual tests override where they specifically want a mock that
// lacks .headers/.body entirely (the "simple mock" shape every existing
// test-mock fetcher in this repo already uses).
function mockResponse({ ok = true, status = 200, url = null, redirected = false, headers = {}, text = '<html></html>', body = null } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok, status, url, redirected,
    headers: { get: (name) => headerMap.get(String(name).toLowerCase()) || null },
    text: async () => text,
    body
  }
}

async function run() {
  // 1. Successful HTML response -----------------------------------------
  {
    const fetcher = async (url, opts) => mockResponse({ ok: true, status: 200, url, headers: { 'content-type': 'text/html; charset=utf-8' }, text: '<html><body>hi</body></html>' })
    const result = await fetchWebPage('https://example.com/page', { fetcher })
    assert.strictEqual(result.fetchState, 'success')
    assert.strictEqual(result.status, 200)
    assert.strictEqual(result.html, '<html><body>hi</body></html>')
    assert.strictEqual(result.contentType, 'text/html; charset=utf-8')
    assert.strictEqual(result.failureCategory, null)
    assert.strictEqual(result.truncated, false)
    log('TEST 1 (successful HTML response returns fetchState success with html/status/contentType populated) PASSED')
  }

  // 2. Redirect / final URL where supported -------------------------------
  {
    const fetcher = async (url) => mockResponse({ ok: true, status: 200, url: 'https://example.com/final', redirected: true, text: 'ok' })
    const result = await fetchWebPage('https://example.com/start', { fetcher })
    assert.strictEqual(result.fetchState, 'success')
    assert.strictEqual(result.finalUrl, 'https://example.com/final')
    assert.strictEqual(result.redirected, true)
    assert.strictEqual(result.requestedUrl, 'https://example.com/start')
    log('TEST 2 (a redirected response preserves both the originally-requested URL and the final resolved URL) PASSED')
  }

  // 3. Timeout ------------------------------------------------------------
  {
    const fetcher = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
    const result = await fetchWebPage('https://example.com/slow', { fetcher, timeoutMs: 30 })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'timeout')
    assert.strictEqual(result.status, null)
    log('TEST 3 (a request that never resolves within timeoutMs comes back as failureCategory "timeout", not a generic network failure) PASSED')
  }

  // 4. Blocked / 403 --------------------------------------------------------
  {
    const fetcher = async () => mockResponse({ ok: false, status: 403 })
    const result = await fetchWebPage('https://example.com/blocked', { fetcher })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'blocked_access')
    assert.strictEqual(result.status, 403)
    log('TEST 4 (HTTP 403 maps to failureCategory "blocked_access" with the real status preserved) PASSED')
  }

  // 5. Rate limited / 429 ---------------------------------------------------
  {
    const fetcher = async () => mockResponse({ ok: false, status: 429 })
    const result = await fetchWebPage('https://example.com/too-fast', { fetcher })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'rate_limited')
    assert.strictEqual(result.status, 429)
    log('TEST 5 (HTTP 429 maps to failureCategory "rate_limited") PASSED')
  }

  // 6. 5xx server error -----------------------------------------------------
  {
    const fetcher = async () => mockResponse({ ok: false, status: 503 })
    const result = await fetchWebPage('https://example.com/down', { fetcher })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'server_error')
    assert.strictEqual(result.status, 503)
    assert.strictEqual(categorizeHttpStatus(500), 'server_error')
    assert.strictEqual(categorizeHttpStatus(404), 'deleted_page')
    assert.strictEqual(categorizeHttpStatus(410), 'deleted_page')
    assert.strictEqual(categorizeHttpStatus(401), 'auth_required')
    log('TEST 6 (HTTP 5xx maps to failureCategory "server_error"; categorizeHttpStatus covers the full documented status table) PASSED')
  }

  // 7. Non-HTML response, requireHtml opt-in --------------------------------
  {
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'application/pdf' }, text: '%PDF-1.4...' })
    const rejected = await fetchWebPage('https://example.com/file.pdf', { fetcher, requireHtml: true })
    assert.strictEqual(rejected.fetchState, 'failed')
    assert.strictEqual(rejected.failureCategory, 'non_html')

    // requireHtml OFF (the default) must NOT reject the same response --
    // existing callers (sitemap.xml, robots.txt) rely on this.
    const accepted = await fetchWebPage('https://example.com/file.pdf', { fetcher })
    assert.strictEqual(accepted.fetchState, 'success')
    assert.strictEqual(accepted.html, '%PDF-1.4...')

    assert.strictEqual(looksLikeHtmlContentType('text/html; charset=utf-8'), true)
    assert.strictEqual(looksLikeHtmlContentType('application/pdf'), false)
    assert.strictEqual(looksLikeHtmlContentType(null), true) // missing header never punished
    log('TEST 7 (a non-HTML content-type only becomes a failure when the caller opts into requireHtml; off by default so sitemap/robots fetches are unaffected) PASSED')
  }

  // 8. Malformed URL --------------------------------------------------------
  {
    const fetcher = async () => { throw new Error('should never be called') }
    const result = await fetchWebPage('not a url at all', { fetcher })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'invalid_url')
    log('TEST 8 (an unparseable URL fails fast as "invalid_url" without ever calling the fetcher) PASSED')
  }

  // 9. Network failure ------------------------------------------------------
  {
    const fetcher = async () => { throw new Error('ECONNRESET') }
    const result = await fetchWebPage('https://example.com/reset', { fetcher })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'network_failure')
    assert.strictEqual(result.failureDetail, 'ECONNRESET')
    log('TEST 9 (a thrown non-abort error from the fetcher comes back as "network_failure" with the underlying message preserved) PASSED')
  }

  // 10. robots denied where enabled -----------------------------------------
  {
    const fetcher = async (url) => {
      if (String(url).endsWith('/robots.txt')) {
        return mockResponse({ ok: true, status: 200, text: 'User-agent: *\nDisallow: /private\n' })
      }
      throw new Error('should never fetch the page itself once robots denies it')
    }
    const result = await fetchWebPage('https://example.com/private/secret', { fetcher, respectRobots: true })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'robots_blocked')
    assert.strictEqual(result.robotsState, 'disallowed')
    log('TEST 10 (respectRobots:true honors a matching Disallow rule and never calls the fetcher for the page itself) PASSED')
  }

  // 11. robots unknown / robots.txt fetch failure never becomes page absence -
  {
    const fetcher = async (url) => {
      if (String(url).endsWith('/robots.txt')) throw new Error('robots.txt unreachable')
      return mockResponse({ ok: true, status: 200, text: '<html>real content</html>' })
    }
    const result = await fetchWebPage('https://example.com/page', { fetcher, respectRobots: true })
    assert.strictEqual(result.fetchState, 'success')
    assert.strictEqual(result.robotsState, 'allowed')
    assert.strictEqual(result.html, '<html>real content</html>')

    const allowedDirectly = await checkRobotsAllowed('https://example.com', 'https://example.com/page', async () => { throw new Error('down') }, 1000)
    assert.strictEqual(allowedDirectly, true)
    log('TEST 11 (an unfetchable robots.txt fails OPEN -- the page is still fetched and inspected, never silently treated as blocked or absent) PASSED')
  }

  // 12. Response size handling / truncation ----------------------------------
  {
    // 12a: fetcher exposes only .text() (the simple mock shape every
    // existing test-mock fetcher in this repo already uses) -- oversized
    // body is truncated by character count, not thrown away entirely.
    const bigText = 'x'.repeat(1000)
    const truncatedResult = await fetchWebPage('https://example.com/big', {
      fetcher: async () => mockResponse({ ok: true, status: 200, text: bigText }),
      maxBytes: 100
    })
    assert.strictEqual(truncatedResult.fetchState, 'success')
    assert.strictEqual(truncatedResult.truncated, true)
    assert.strictEqual(truncatedResult.html.length, 100)

    const fitsResult = await fetchWebPage('https://example.com/small', {
      fetcher: async () => mockResponse({ ok: true, status: 200, text: 'small body' }),
      maxBytes: 100
    })
    assert.strictEqual(fitsResult.truncated, false)
    assert.strictEqual(fitsResult.html, 'small body')

    // 12b: a real streaming body (ReadableStream-shaped, via getReader) is
    // also correctly bounded -- exercises the non-fallback path in
    // readBoundedText directly, since Node's global fetch mock above never
    // constructs a real stream.
    function streamOf(chunks) {
      let i = 0
      return {
        getReader() {
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined }
              const value = Buffer.from(chunks[i++], 'utf8')
              return { done: false, value }
            },
            async cancel() {},
            releaseLock() {}
          }
        }
      }
    }
    const streamed = await readBoundedText({ body: streamOf(['hello ', 'world ', 'this is more text than allowed']) }, 12)
    assert.strictEqual(streamed.truncated, true)
    assert.strictEqual(streamed.text, 'hello world ')

    const streamedFits = await readBoundedText({ body: streamOf(['all good']) }, 100)
    assert.strictEqual(streamedFits.truncated, false)
    assert.strictEqual(streamedFits.text, 'all good')
    log('TEST 12 (an oversized body is truncated to maxBytes rather than rejected outright, for both simple text()-only mocks and real streaming bodies) PASSED')
  }

  // 13. Auth required (401) covered alongside the other status-derived states
  {
    const fetcher = async () => mockResponse({ ok: false, status: 401 })
    const result = await fetchWebPage('https://example.com/members', { fetcher })
    assert.strictEqual(result.failureCategory, 'auth_required')
    log('TEST 13 (HTTP 401 maps to failureCategory "auth_required") PASSED')
  }

  // 14. Deleted page (404/410)
  {
    const notFound = await fetchWebPage('https://example.com/gone', { fetcher: async () => mockResponse({ ok: false, status: 404 }) })
    const removed = await fetchWebPage('https://example.com/removed', { fetcher: async () => mockResponse({ ok: false, status: 410 }) })
    assert.strictEqual(notFound.failureCategory, 'deleted_page')
    assert.strictEqual(removed.failureCategory, 'deleted_page')
    log('TEST 14 (both HTTP 404 and 410 map to failureCategory "deleted_page") PASSED')
  }

  // 15. Headers option never leaks a default User-Agent when a caller
  // explicitly wants none (the exact concern lib/citedPageInspection.js's
  // and lib/checkers/checker.js's migrations both depended on).
  {
    let capturedOpts = null
    const fetcher = async (url, opts) => { capturedOpts = opts; return mockResponse({ ok: true, status: 200, text: 'ok' }) }
    await fetchWebPage('https://example.com/no-ua', { fetcher, headers: {} })
    assert.deepStrictEqual(capturedOpts.headers, {})
    await fetchWebPage('https://example.com/default-ua', { fetcher })
    assert.strictEqual(capturedOpts.headers['User-Agent'], 'FirestarterAIAudit/1.0')
    log('TEST 15 (passing headers:{} sends no headers at all, rather than lib/webPageFetch.js\'s own default User-Agent -- required for byte-for-byte-compatible caller migrations) PASSED')
  }

  console.log('\nAll lib/webPageFetch.js pure/mocked tests passed (no real network calls, no DB required).')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
