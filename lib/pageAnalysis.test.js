// Tests for lib/pageAnalysis.js -- on-demand page-level schema analysis.
// Plain `node`, no real network calls -- same hand-rolled mock-fetcher
// convention as lib/webPageFetch.pure.test.js.
//
// Updated 2026-09-03 for the DIAGNOSTIC METHODOLOGY pass: analyzePage()'s
// result shape changed from {applicable, missingOrInvalid, notApplicable,
// actionableGap} to {targetProfile, coreChecks, recommendedChecks,
// avoidFindings, notApplicable, finalStatus} -- see
// lib/schemaPageTypeChecks.js for the full methodology this implements.

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
    assert.strictEqual(result.finalStatus, 'COULD_NOT_VERIFY')
  })

  // TEST 3: a genuine fetch failure (404) is reported honestly, never as "no schema found."
  await test('404 fetch -> honest failure, finalStatus stays COULD_NOT_VERIFY (never NO_ACTION_NEEDED)', async () => {
    const fetcher = async () => mockResponse({ ok: false, status: 404 })
    const result = await analyzePage({ path: '/gone/', page: { type: 'Service' }, siteUrl: 'https://example.com', fetcher })
    assert.strictEqual(result.fetchState, 'failed')
    assert.strictEqual(result.failureCategory, 'deleted_page')
    assert.strictEqual(result.finalStatus, 'COULD_NOT_VERIFY')
    assert.deepStrictEqual(result.currentSchema, [])
  })

  // TEST 4: a real Service page with real Service+provider+BreadcrumbList
  // schema fetched successfully -- dispatches to the SERVICE target profile
  // (via lib/schemaPageTypeChecks.js), not Home's. This fixture deliberately
  // omits `description`/`areaServed` (both Recommended, not Core), so it
  // correctly reports IMPROVEMENT_AVAILABLE, not NO_ACTION_NEEDED -- see
  // TEST 9 for a fully-complete Service page.
  await test('Successful fetch of a real Service page: dispatches to the SERVICE target profile', async () => {
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'Service', name: 'SEO Services', provider: { '@type': 'Organization', name: 'Firestarter' } },
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'Firestarter', url: 'https://www.firestarterseo.com' },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({
      path: '/seo/', page: { type: 'Service', classificationSource: 'sitemap_name', classificationConfidence: 'high' },
      siteUrl: 'https://www.firestarterseo.com', fetcher
    })
    assert.strictEqual(result.fetchState, 'success')
    assert.strictEqual(result.targetProfile, 'SERVICE')
    assert.ok(result.currentSchema.includes('Service'))
    assert.ok(result.coreChecks.every(c => c.status === 'pass'))
    assert.strictEqual(result.finalStatus, 'IMPROVEMENT_AVAILABLE')
    assert.ok(result.recommendedChecks.some(c => c.id === 'service_schema_present' && c.status === 'pass'))
    assert.ok(result.recommendedChecks.some(c => c.id === 'service_description_supported' && c.status === 'fail'))
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

  // TEST 6: an About page with literally zero schema at all IS an actionable
  // (Core) gap -- missing the primary schema representation entirely, per
  // the DIAGNOSTIC METHODOLOGY's correction #1/#2 ("missing the primary
  // schema representation we intentionally require" is Core; a missing
  // AboutPage SUBTYPE alone is not -- see TEST 7 below for that distinction).
  await test('About page with zero schema at all: ACTION_REQUIRED (missing the primary representation)', async () => {
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: '<html></html>' })
    const result = await analyzePage({ path: '/about/', page: { type: 'About' }, siteUrl: 'https://example.com', fetcher })
    assert.strictEqual(result.finalStatus, 'ACTION_REQUIRED')
    assert.ok(result.coreChecks.some(c => c.id === 'about_page_type_representation' && c.status === 'fail'))
  })

  // TESTS 7-13: DIAGNOSTIC METHODOLOGY pass (2026-09-03) -- end-to-end
  // analyzePage() runs against representative content for the seven real
  // Firestarter pages named in this pass's validation list: /about/,
  // /contact/, /denver-seo-agency/, /locations/, /locations/colorado-
  // springs-seo/, one blog post, one case study. This sandbox has no live
  // network access to firestarterseo.com and WebFetch cannot return raw
  // <script type="application/ld+json"> content (confirmed earlier this
  // session -- it only returns rendered text), so these fixtures are
  // REPRESENTATIVE, clearly labeled as such, not a literal scrape -- actual
  // live results are reported separately from the deployed "Analyze page"
  // button once this pushes. What these tests DO prove for real: the full
  // pipeline (fetch -> parseJsonLd -> runPageTypeChecks) produces the new
  // TARGET PROFILE / CORE / RECOMMENDED / AVOID / NOT APPLICABLE / FINAL
  // STATUS contract end-to-end for every one of the profiles this pass
  // implements.

  // TEST 7: /about/ with ONLY a sitewide Organization + BreadcrumbList (no
  // AboutPage subtype, no about/mainEntity relationship) -- this is
  // representative of the exact live-audit finding that started this pass
  // ("a sitewide entity satisfies every old check"). Under the NEW
  // methodology this is IMPROVEMENT_AVAILABLE, never a false NO_ACTION_NEEDED
  // -- but also never a false ACTION_REQUIRED, per correction #2's explicit
  // "do not make absence of AboutPage alone ACTION REQUIRED."
  await test('/about/ (representative, sitewide-only schema): IMPROVEMENT_AVAILABLE, not falsely NO_ACTION_NEEDED or ACTION_REQUIRED', async () => {
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'WebPage', '@id': 'https://www.firestarterseo.com/about/' },
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'Firestarter', url: 'https://www.firestarterseo.com', sameAs: ['https://www.linkedin.com/company/firestarter'] },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home' }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/about/', page: { type: 'About', classificationSource: 'url_pattern', classificationConfidence: 'high' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.targetProfile, 'ABOUT')
    assert.ok(result.coreChecks.every(c => c.status === 'pass'))
    assert.strictEqual(result.finalStatus, 'IMPROVEMENT_AVAILABLE')
    const subtypeCheck = result.recommendedChecks.find(c => c.id === 'about_page_subtype')
    assert.strictEqual(subtypeCheck.status, 'fail')
  })

  // TEST 8: /contact/ -- same sitewide-only pattern as About. Under the new
  // methodology, missing address/telephone-completeness on the sitewide
  // entity is no longer even checked directly (that concept moved to the
  // "no fabricated claims" Core check, which passes on well-formed-but-
  // incomplete data) -- the gap that surfaces is the missing ContactPage
  // subtype/relationship, correctly filed as Recommended, not Core.
  await test('/contact/ (representative, sitewide-only schema): IMPROVEMENT_AVAILABLE for the missing ContactPage subtype/relationship', async () => {
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'WebPage', '@id': 'https://www.firestarterseo.com/contact/' },
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'Firestarter', url: 'https://www.firestarterseo.com' }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/contact/', page: { type: 'Contact', classificationSource: 'url_pattern', classificationConfidence: 'high' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.targetProfile, 'CONTACT')
    assert.ok(result.coreChecks.every(c => c.status === 'pass'))
    assert.strictEqual(result.finalStatus, 'IMPROVEMENT_AVAILABLE')
    assert.ok(result.recommendedChecks.some(c => c.id === 'contact_page_subtype' && c.status === 'fail'))
  })

  // TEST 9: /denver-seo-agency/ (representative Service-type page) with a
  // complete, correctly-related Service node -- provider resolves to a real
  // Organization this page itself carries -- NO_ACTION_NEEDED.
  await test('/denver-seo-agency/ (representative): complete, correctly-related Service page -> NO_ACTION_NEEDED', async () => {
    const org = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Firestarter', url: 'https://www.firestarterseo.com' }
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'Service', name: 'Denver SEO Services', description: 'Full-service SEO for Denver-area businesses.', areaServed: 'Denver, CO', provider: { '@type': 'Organization', name: 'Firestarter' } },
      org,
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/denver-seo-agency/', page: { type: 'Service', classificationSource: 'url_pattern', classificationConfidence: 'medium' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.targetProfile, 'SERVICE')
    assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
    const providerCheck = result.recommendedChecks.find(c => c.id === 'service_provider_relationship')
    assert.strictEqual(providerCheck.status, 'pass')
  })

  // TEST 10: /locations/ -- the bare hub path resolves to LOCATION_HUB
  // regardless of on-page schema (real structural evidence -- the path
  // itself). Representative content: a generic WebPage listing links to
  // individual location pages, no CollectionPage/ItemList typing yet, and
  // (this is the important negative case) NO page-specific LocalBusiness
  // claim -- so the AVOID check stays clean.
  await test('/locations/ (representative hub page): resolves to LOCATION_HUB, no physical-business AVOID violation, subtype/ItemList absence is Recommended-only', async () => {
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'WebPage', '@id': 'https://www.firestarterseo.com/locations/' },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/locations/', page: { type: 'Location', classificationSource: 'url_pattern', classificationConfidence: 'high' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.targetProfile, 'LOCATION_HUB')
    assert.strictEqual(result.avoidFindings.length, 0)
    assert.strictEqual(result.finalStatus, 'IMPROVEMENT_AVAILABLE') // CollectionPage/ItemList subtype not yet used
    assert.ok(result.notApplicable.some(c => c.id === 'physical_location_address_present'))
  })

  // TEST 11: /locations/colorado-springs-seo/ -- a leaf under /locations/
  // with a genuine Service representation and NO physical-business claim on
  // it. Per correction #12 ("do not infer physical office status from URL
  // alone"), this resolves to the conservative SERVICE_AREA default, never
  // an assumed PHYSICAL_LOCATION -- and correctly reports no AVOID
  // violation, since it never claims to be a physical office in the first
  // place.
  await test('/locations/colorado-springs-seo/ (representative service-area leaf): resolves to SERVICE_AREA, not a guessed PHYSICAL_LOCATION', async () => {
    const org = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Firestarter' }
    const html = htmlWithJsonLd([
      { '@context': 'https://schema.org', '@type': 'Service', name: 'Colorado Springs SEO', areaServed: 'Colorado Springs, CO', provider: { '@type': 'Organization', name: 'Firestarter' } },
      org,
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/locations/colorado-springs-seo/', page: { type: 'Location', classificationSource: 'url_pattern', classificationConfidence: 'high' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.targetProfile, 'SERVICE_AREA')
    assert.strictEqual(result.avoidFindings.length, 0)
    assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
  })

  // TEST 12: a representative blog post -- complete Article schema
  // (headline, author, datePublished, publisher resolving to the real
  // Organization, image, breadcrumbs) -> NO_ACTION_NEEDED.
  await test('Representative blog post (/blog/five-ways-to-improve-local-seo/): complete Article -> NO_ACTION_NEEDED', async () => {
    const org = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Firestarter', url: 'https://www.firestarterseo.com' }
    const html = htmlWithJsonLd([
      {
        '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'Five Ways to Improve Local SEO',
        author: { '@type': 'Person', name: 'Firestarter Team' }, datePublished: '2026-06-01',
        publisher: { '@type': 'Organization', name: 'Firestarter' }, image: 'https://www.firestarterseo.com/img/local-seo.jpg',
        mainEntityOfPage: 'https://www.firestarterseo.com/blog/five-ways-to-improve-local-seo/'
      },
      org,
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/blog/five-ways-to-improve-local-seo/', page: { type: 'Article', classificationSource: 'sitemap_name', classificationConfidence: 'high' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.targetProfile, 'ARTICLE')
    assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
  })

  // TEST 13: a representative case study -- Article-typed (the preferred
  // representation per correction #7), with about naming the real subject
  // and publisher resolving to the real Organization -> NO_ACTION_NEEDED.
  await test('Representative case study (/case-studies/acme-plumbing/): Article-based with about + publisher -> NO_ACTION_NEEDED', async () => {
    const org = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Firestarter' }
    const html = htmlWithJsonLd([
      {
        '@context': 'https://schema.org', '@type': 'Article', headline: 'How Acme Plumbing Tripled Organic Leads',
        about: { '@type': 'Organization', name: 'Acme Plumbing' }, datePublished: '2026-04-15',
        publisher: { '@type': 'Organization', name: 'Firestarter' }
      },
      org,
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }
    ])
    const fetcher = async () => mockResponse({ ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: html })
    const result = await analyzePage({ path: '/case-studies/acme-plumbing/', page: { type: 'Case Study', classificationSource: 'sitemap_name', classificationConfidence: 'high' }, siteUrl: 'https://www.firestarterseo.com', fetcher })
    assert.strictEqual(result.targetProfile, 'CASE_STUDY')
    assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
    assert.ok(result.recommendedChecks.some(c => c.id === 'case_study_about_subject' && c.status === 'pass'))
  })

  console.log(`\n${passCount} passed.`)
}

main().catch(e => { console.error(e); process.exit(1) })
