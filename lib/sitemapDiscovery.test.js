// Mocked-fetcher tests for lib/sitemapDiscovery.js's fetchSitemapPages() --
// plain Node, no real network calls (same injectable-fetcher convention as
// lib/webPageFetch.pure.test.js and lib/checkers/scripts/run-technical-test.js).
// Run with: node lib/sitemapDiscovery.test.js
//
// Sitemap/page-discovery bug fix (2026-09-02). See lib/sitemapDiscovery.js's
// header for the full root-cause writeup this exercises end to end.

const assert = require('assert')
const { fetchSitemapPages, MAX_SITEMAP_CANDIDATES_DISCOVERED } = require('./sitemapDiscovery')

function log(msg) { console.log(msg) }

// mockFetcher(routes) -> a fetcher keyed by exact URL. `routes[url]` is
// either a string (200 XML body) or an object { status, throws }.
function mockFetcher(routes) {
  return async (url) => {
    const entry = routes[url]
    if (entry === undefined) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    }
    if (typeof entry === 'object' && entry.throws) {
      throw new Error('simulated network failure')
    }
    if (typeof entry === 'object' && entry.status && entry.status >= 400) {
      return { ok: false, status: entry.status, headers: { get: () => null }, text: async () => '' }
    }
    const body = typeof entry === 'string' ? entry : entry.body
    return { ok: true, status: 200, headers: { get: () => 'application/xml' }, text: async () => body }
  }
}

async function run() {
  // 1. plain urlset sitemap (no index at all) -- every real page returned,
  // count matches, nothing is misclassified as a sitemap file.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about/</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, 2)
    assert.deepStrictEqual(result.pages.map(p => p.path), ['/', '/about/'])
    assert.strictEqual(result.sitemapsFetched, 1)
    assert.strictEqual(result.truncated, false)
    log('TEST 1 (a plain urlset sitemap with no index yields its real pages directly, one fetch total) PASSED')
  }

  // 2. sitemap index with multiple child sitemaps -- the exact reported bug
  // shape: index -> post-sitemap.xml, page-sitemap.xml, case-studies-sitemap.xml,
  // landing-page-sitemap.xml. Final page list must contain real page URLs,
  // and must NEVER contain any of the four .xml sitemap URLs themselves.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/case-studies-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/landing-page-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/post-sitemap.xml': `<urlset><url><loc>https://example.com/blog/example/</loc></url></urlset>`,
      'https://example.com/page-sitemap.xml': `<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about/</loc></url><url><loc>https://example.com/contact/</loc></url></urlset>`,
      'https://example.com/case-studies-sitemap.xml': `<urlset><url><loc>https://example.com/case-studies/example/</loc></url></urlset>`,
      'https://example.com/landing-page-sitemap.xml': `<urlset><url><loc>https://example.com/services/seo/</loc></url><url><loc>https://example.com/locations/denver/</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.sitemapsFetched, 5) // root index + 4 children
    const paths = result.pages.map(p => p.path).sort()
    assert.deepStrictEqual(paths, [
      '/', '/about/', '/blog/example/', '/case-studies/example/',
      '/contact/', '/locations/denver/', '/services/seo/'
    ].sort())
    // None of the four child sitemap URLs -- or the root -- ever appear as pages.
    const sitemapXmlUrls = [
      'https://example.com/post-sitemap.xml', 'https://example.com/page-sitemap.xml',
      'https://example.com/case-studies-sitemap.xml', 'https://example.com/landing-page-sitemap.xml',
      'https://example.com/sitemap.xml'
    ]
    for (const p of result.pages) {
      assert.ok(!sitemapXmlUrls.some(xmlUrl => xmlUrl.endsWith(p.path)), `page path ${p.path} must not be a sitemap XML URL`)
      assert.ok(!p.path.endsWith('.xml'), `page path ${p.path} must not end in .xml`)
    }
    // Real page types resolved correctly.
    const byPath = Object.fromEntries(result.pages.map(p => [p.path, p.type]))
    assert.strictEqual(byPath['/'], 'Home')
    assert.strictEqual(byPath['/about/'], 'About')
    assert.strictEqual(byPath['/contact/'], 'Contact')
    assert.strictEqual(byPath['/blog/example/'], 'Article')
    assert.strictEqual(byPath['/case-studies/example/'], 'Case Study')
    assert.strictEqual(byPath['/services/seo/'], 'Service')
    assert.strictEqual(byPath['/locations/denver/'], 'Location')
    // Traceability preserved.
    assert.strictEqual(result.pages.find(p => p.path === '/about/').sourceSitemap, 'https://example.com/page-sitemap.xml')
    log('TEST 2 (a sitemap index with multiple child sitemaps -- the exact reported bug shape -- yields only real pages, correctly typed, with the source sitemap preserved, and never the .xml sitemap URLs themselves) PASSED')
  }

  // 3. nested sitemap index -- an index whose own children are themselves
  // indexes, resolved recursively down to real urlsets.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex><sitemap><loc>https://example.com/sitemap-region-a.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/sitemap-region-a.xml': `<sitemapindex><sitemap><loc>https://example.com/sitemap-region-a-pages.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/sitemap-region-a-pages.xml': `<urlset><url><loc>https://example.com/region-a/page-1/</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, 1)
    assert.strictEqual(result.pages[0].path, '/region-a/page-1/')
    assert.strictEqual(result.sitemapsFetched, 3)
    log('TEST 3 (a nested sitemap index -- index of indexes -- is followed recursively down to the real page URLs) PASSED')
  }

  // 4. duplicate page URL across sitemaps -- the same page referenced from
  // two different child sitemaps is only counted/listed once.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap><sitemap><loc>https://example.com/b.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/a.xml': `<urlset><url><loc>https://example.com/shared-page/</loc></url></urlset>`,
      'https://example.com/b.xml': `<urlset><url><loc>https://example.com/shared-page/</loc></url><url><loc>https://example.com/shared-page/?utm_source=newsletter</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, 1, 'the same page (even with a tracking param) referenced from multiple sitemaps must be deduped to one')
    assert.strictEqual(result.pages.length, 1)
    log('TEST 4 (a page URL duplicated across multiple sitemaps -- including a tracking-param variant -- is deduplicated to a single entry) PASSED')
  }

  // 5. sitemap XML URL never emitted as a page -- explicit regression check
  // for the exact reported bug: a urlset that (incorrectly, but
  // defensively handled) lists another sitemap-looking .xml URL as a <url>
  // entry must still be excluded from the page list.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/rogue-sitemap.xml</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, 1)
    assert.deepStrictEqual(result.pages.map(p => p.path), ['/'])
    log('TEST 5 (a .xml URL is never emitted as a page candidate, even if it appears directly inside a <url> block) PASSED')
  }

  // 6. non-page asset excluded -- a urlset mixing real pages with direct
  // asset links (PDF, image).
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<urlset>
        <url><loc>https://example.com/</loc></url>
        <url><loc>https://example.com/downloads/brochure.pdf</loc></url>
        <url><loc>https://example.com/images/hero.jpg</loc></url>
      </urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, 1)
    assert.deepStrictEqual(result.pages.map(p => p.path), ['/'])
    log('TEST 6 (non-HTML asset URLs -- PDFs, images -- listed directly as <url> entries are excluded from the page list) PASSED')
  }

  // 7. malformed/unreachable child sitemap fails gracefully -- one child
  // 404s and another throws a network error; both are dropped silently
  // rather than the run failing, and NEITHER child sitemap URL is ever
  // treated as a page. The still-reachable children are still processed.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/unreachable.xml</loc></sitemap>
        <sitemap><loc>https://example.com/network-error.xml</loc></sitemap>
        <sitemap><loc>https://example.com/good.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/unreachable.xml': { status: 404 },
      'https://example.com/network-error.xml': { throws: true },
      'https://example.com/good.xml': `<urlset><url><loc>https://example.com/about/</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, 1)
    assert.strictEqual(result.pages[0].path, '/about/')
    // Confirm neither failed child sitemap's own URL ever leaked into the page list.
    assert.ok(!result.pages.some(p => p.path.endsWith('.xml')))
    log('TEST 7 (an unreachable child sitemap and one that throws a network error both fail gracefully -- dropped, never treated as pages -- while reachable children are still processed) PASSED')
  }

  // 8. classification receives actual HTML page URLs -- every entry in the
  // final list is a real page path (never an .xml path), each with a
  // resolved, non-generic type wherever the URL shape supports one.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/pages.xml': `<urlset>
        <url><loc>https://example.com/</loc></url>
        <url><loc>https://example.com/services/seo/</loc></url>
        <url><loc>https://example.com/case-studies/acme/</loc></url>
      </urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    for (const p of result.pages) {
      assert.ok(!p.path.endsWith('.xml'), 'classification must never receive a sitemap XML path')
      assert.ok(typeof p.type === 'string' && p.type.length > 0)
    }
    const byPath = Object.fromEntries(result.pages.map(p => [p.path, p.type]))
    assert.strictEqual(byPath['/'], 'Home')
    assert.strictEqual(byPath['/services/seo/'], 'Service')
    assert.strictEqual(byPath['/case-studies/acme/'], 'Case Study')
    log('TEST 8 (page-type classification only ever runs against real HTML page URLs, never sitemap XML paths) PASSED')
  }

  // 9. failure/bound safety: no usable sitemap at all returns null (not a
  // zero-length result), and an unreachable root also returns null.
  {
    const fetcher = mockFetcher({ 'https://example.com/sitemap.xml': { status: 500 } })
    assert.strictEqual(await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher }), null)

    const fetcherUnknownShape = mockFetcher({ 'https://example.com/sitemap.xml': '<not-a-sitemap/>' })
    assert.strictEqual(await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher: fetcherUnknownShape }), null)

    assert.strictEqual(await fetchSitemapPages(null, { fetcher }), null)
    log('TEST 9 (an unreachable root, an unrecognizable XML shape, and a missing URL all return null -- never a fake zero-length result) PASSED')
  }

  // 10. the candidate-discovery cap is still honored --
  // MAX_SITEMAP_CANDIDATES_DISCOVERED trims the returned `pages` array while
  // `count` still reports the real total.
  {
    const many = Array.from({ length: MAX_SITEMAP_CANDIDATES_DISCOVERED + 5 }, (_, i) => `<url><loc>https://example.com/page-${i}/</loc></url>`).join('')
    const fetcher = mockFetcher({ 'https://example.com/sitemap.xml': `<urlset>${many}</urlset>` })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, MAX_SITEMAP_CANDIDATES_DISCOVERED + 5)
    assert.strictEqual(result.pages.length, MAX_SITEMAP_CANDIDATES_DISCOVERED)
    assert.strictEqual(result.truncated, true)
    log('TEST 10 (the real total page count is preserved even when the returned page list is trimmed to MAX_SITEMAP_CANDIDATES_DISCOVERED) PASSED')
  }

  // 11. DISCOVERY-ORDER BUG REGRESSION (Phase A, second real bug found): a
  // sitemap index whose FIRST child sitemap alone contains more than 20
  // posts (the old, too-small MAX_SITEMAP_PAGES_LISTED cap) must never
  // prevent a LATER child sitemap's homepage/About/Contact/Service pages
  // from being discovered. This is the exact regression that made Phase A
  // necessary -- discovery order (which sitemap the index happens to list
  // first) must never determine which pages exist in the returned candidate
  // list. (Deciding which of these candidates gets RECOMMENDED is a
  // separate, later concern -- see lib/schemaPagePriority.test.js's
  // equivalent fixture for the prioritization side of this same scenario.)
  {
    const twentyFivePosts = Array.from({ length: 25 }, (_, i) => `<url><loc>https://example.com/blog/post-${i}/</loc></url>`).join('')
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/post-sitemap.xml': `<urlset>${twentyFivePosts}</urlset>`,
      'https://example.com/page-sitemap.xml': `<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about/</loc></url><url><loc>https://example.com/contact/</loc></url><url><loc>https://example.com/services/seo/</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.truncated, false, 'well under the 150-candidate cap -- nothing should be dropped')
    const paths = result.pages.map(p => p.path)
    assert.strictEqual(paths.length, 29, '25 posts + home + about + contact + service')
    assert.ok(paths.includes('/'), 'the homepage, discovered in the SECOND child sitemap, must still be present')
    assert.ok(paths.includes('/about/'), 'About, discovered in the second child sitemap, must still be present')
    assert.ok(paths.includes('/contact/'), 'Contact, discovered in the second child sitemap, must still be present')
    assert.ok(paths.includes('/services/seo/'), 'the Service page, discovered in the second child sitemap, must still be present')
    log('TEST 11 (a first child sitemap with more than the old 20-page cap worth of posts never crowds out a later child sitemap\'s homepage/About/Contact/Service pages from the discovered candidate list) PASSED')
  }

  console.log('\nAll lib/sitemapDiscovery.js mocked-fetcher tests passed (no real network calls).')
}

run()
