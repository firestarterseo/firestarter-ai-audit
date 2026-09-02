// Tests for lib/pageAnalysis.js -- on-demand page-level schema analysis
// (Phase B of the Schema page-workflow redesign). Plain `node`, no real
// network calls -- same hand-rolled mock-fetcher convention as
// lib/webPageFetch.pure.test.js.

const assert = require('assert')
const { analyzePage, resolvePageUrl } = require('./pageAnalysis')

let passCount = 0
function test(name, fn) {
  return fn().then(() => { passCount++; console.log(`PASS: ${name}`) })
}

function mockResponse({ ok = true, status = 200, headers = {}, text = '<html></html>' } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok, status, url: null, redirected: false,
    headers: { get: name => headerMap.get(String(name).toLowerCase()) || null },
    text: async () => text,
    body: null
  }
}

function htmlWithJsonLd(obj) {
  return `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`
}

async function main() {
  // TEST 1: resolvePageUrl resolves a site-relative path against the site's base URL.
  await test('resolvePageUrl resolves a relative path against the site base URL', async () => {
    assert.strictEqual(resolvePageUrl('https://www.example.com', '/denver-seo-agency/'), 'https://www.example.com/denver-seo-agency/')
  })

  // TEST 1b: a protocol-relative path ("//evil.example.com/x") must NEVER
  // resolve off the client's own origin -- resolvePageUrl must refuse it,
  // not silently hand back a URL pointing at an attacker-controlled host
  // (this route fetches server-side; it must never become an open proxy).
  await test('Protocol-relative path never escapes the site origin', async () => {
    assert.strictEqual(resolvePageUrl('https://good.example.com', '//evil.example.com/x'), null)
    assert.strictEqual(resolvePageUrl('https://good.example.com', 'https://evil.example.com/x'), null)
    assert.strictEqual(resolvePageUrl('https://good.example.com', '/legit-page/'), 'https://good.example.com/legit-page/')
  })

  // TEST 2: an invalid site URL returns a clean invalid_url failure, never throws.
  await test('Invalid siteUrl -> invalid_url failure, never throws', async () => {
    const result = await analyzePage({ path: '/service/', page: { type: 'Service' }, siteUrl: 'not a url' })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'invalid_url')
    assert.strictEqual(result.actionableGap, null)
  })

  // TEST 3: a genuine fetch failure (404) is reported honestly, never as "no schema found."
  await test('404 fetch -> honest failure, actionableGap stays null (never false)', async () => {
    const fetcher = async () => mockResponse({ ok: false, status: 404 })
    const result = await analyzePage({ path: '/gone/', page: { type: 'Service' }, siteUrl: 'https://example.com', fetcher })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'deleted_page')
    assert.strictEqual(result.actionableGap, null)
    assert.deepStrictEqual(result.currentSchema, [])
  })

  // TEST 4: a real Service page with real Service+BreadcrumbList schema fetched
  // successfully -- runs Service checks (via lib/schemaPageTypeChecks.js), not
  // homepage checks, and reports no actionable gap.
  await test('Successful fetch of a real Service page: dispatches to Service checks', async () => {
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'Service', name: 'SEO Services', provider: { '@type': 'Organization', name: 'Firestarter' } },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({
      path: '/seo/', page: { type: 'Service', classificationSource: 'sitemap_name', classificationConfidence: 'high' },
      siteUrl: 'https://www.firestarterseo.com', fetcher
    })
    assert.strictEqual(result.fetchState, 'success')
    assert.strictEqual(result.classification.type, 'Service')
    assert.ok(result.currentSchema.includes('Service'))
    assert.strictEqual(result.actionableGap, false)
    assert.ok(result.applicable.some(c => c.id === 'service_schema_present'))
    assert.ok(result.notApplicable.some(c => c.id === 'website_search_action'), 'Home-only checks must be notApplicable for a Service page')
  })

  // TEST 4b: analyzePage itself refuses a protocol-relative/off-origin path
  // end-to-end, and never calls the fetcher at all in that case.
  await test('analyzePage refuses an off-origin path and never fetches it', async () => {
    let called = false
    const fetcher = async () => { called = true; return mockResponse({ ok: true, status: 200, text: '<html></html>' }) }
    const result = await analyzePage({ path: '//evil.example.com/steal', page: { type: 'Service' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'invalid_url')
    assert.strictEqual(called, false, 'the fetcher must never be called for an off-origin path')
  })

  // TEST 5: fetching only the single queued page, never the whole sitemap --
  // the mock fetcher records exactly one call.
  await test('analyzePage fetches exactly the one requested page, nothing else', async () => {
    let callCount = 0
    let calledUrl = null
    const fetcher = async (url) => {
      callCount++
      calledUrl = url
      return mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: '<html></html>' })
    }
    await analyzePage({ path: '/about/', page: { type: 'About' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(callCount, 1)
    assert.strictEqual(calledUrl, 'https://www.firestarterseo.com/about/')
  })

  // TEST 6: an About page with no business-entity schema has an actionable gap.
  await test('About page with no schema at all: actionable gap', async () => {
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: '<html></html>' })
    const result = await analyzePage({ path: '/about/', page: { type: 'About' }, siteUrl: 'https://example.com', fetcher })
    assert.strictEqual(result.actionableGap, true)
    assert.ok(result.missingOrInvalid.some(c => c.id === 'business_entity_schema'))
  })

  console.log(`\n${passCount} passed.`)
}

main().catch(e => { console.error(e); process.exit(1) })
