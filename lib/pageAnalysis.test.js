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

  // TESTS 7-9: PAGE ANALYSIS RESULT UX pass (2026-09-02) -- end-to-end
  // analyzePage() runs against representative content for the three real
  // Firestarter pages named in that pass's validation list (/about/,
  // /contact/, /denver-seo-agency/). This sandbox has no live network
  // access to firestarterseo.com and WebFetch cannot return raw
  // <script type="application/ld+json"> content (confirmed this session --
  // it only returns rendered text), so these fixtures are REPRESENTATIVE,
  // clearly labeled as such, not a literal scrape -- the actual live pages
  // are validated by the AM via the real "Analyze page" button after this
  // deploys. What these tests DO prove for real: the full pipeline (fetch
  // -> parseJsonLd -> runPageTypeChecks) produces the new evidence-enriched
  // contract end-to-end, and that a PASSING page's result still exposes
  // the real schema/checks that justified "no action needed" -- it never
  // collapses to just the lifecycle conclusion.

  // TEST 7: /about/ with real Organization + BreadcrumbList schema -- no
  // actionable gap, and the evidence names the real schema found (never
  // hidden behind just "No action needed").
  await test('/about/ (representative): passing page still exposes real schema + check evidence', async () => {
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'Firestarter', url: 'https://www.firestarterseo.com', sameAs: ['https://www.linkedin.com/company/firestarter'] },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home' }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/about/', page: { type: 'About', classificationSource: 'url_pattern', classificationConfidence: 'high' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.actionableGap, false)
    assert.deepStrictEqual(result.currentSchema.sort(), ['BreadcrumbList', 'Organization'])
    // Every applicable check is present with real status + evidence, even
    // though the overall conclusion is "no action needed."
    assert.ok(result.applicable.every(c => c.status === 'pass'))
    const entityCheck = result.applicable.find(c => c.id === 'business_entity_schema')
    assert.ok(entityCheck.evidence.includes('Organization'), 'the passing page\'s evidence must name the real schema type, not just say "pass"')
  })

  // TEST 8: /contact/ with Organization schema but NO address/telephone --
  // a real actionable gap, with evidence explaining exactly what's missing.
  await test('/contact/ (representative): actionable gap shows which check failed and why', async () => {
    const html = htmlWithJsonLd({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Firestarter', url: 'https://www.firestarterseo.com' })
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/contact/', page: { type: 'Contact', classificationSource: 'url_pattern', classificationConfidence: 'high' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.actionableGap, true)
    const addressCheck = result.missingOrInvalid.find(c => c.id === 'address_telephone')
    assert.ok(addressCheck, 'address_telephone must be a real, named gap')
    assert.ok(addressCheck.evidence.length > 0)
    const breadcrumbCheck = result.missingOrInvalid.find(c => c.id === 'breadcrumb_list')
    assert.ok(breadcrumbCheck, 'breadcrumb_list must also be flagged missing')
  })

  // TEST 9: /denver-seo-agency/ (representative Service-type page) with
  // complete Service schema -- no actionable gap, real evidence shown.
  await test('/denver-seo-agency/ (representative): complete Service page passes with real evidence', async () => {
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'Service', name: 'Denver SEO Services', provider: { '@type': 'Organization', name: 'Firestarter' } },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/denver-seo-agency/', page: { type: 'Service', classificationSource: 'url_pattern', classificationConfidence: 'medium' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.actionableGap, false)
    const serviceCheck = result.applicable.find(c => c.id === 'service_schema_present')
    assert.strictEqual(serviceCheck.status, 'pass')
    assert.ok(serviceCheck.evidence.includes('Service schema present'))
    // WebSite+SearchAction (a Home-only concept) must be notApplicable here,
    // never silently missing.
    assert.ok(result.notApplicable.some(c => c.id === 'website_search_action'))
  })

  console.log(`\n${passCount} passed.`)
}

main().catch(e => { console.error(e); process.exit(1) })
