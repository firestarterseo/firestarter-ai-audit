// Mocked-fetcher tests for lib/sitemapDiscovery.js's fetchSitemapPages() --
// plain Node, no real network calls (same injectable-fetcher convention as
// lib/webPageFetch.pure.test.js and lib/checkers/scripts/run-technical-test.js).
// Run with: node lib/sitemapDiscovery.test.js
//
// Sitemap/page-discovery bug fix (2026-09-02). See lib/sitemapDiscovery.js's
// header for the full root-cause writeup this exercises end to end.

const assert = require('assert')
const { fetchSitemapPages, MAX_SITEMAP_CANDIDATES_DISCOVERED, MAX_CHILD_SITEMAPS_PER_INDEX, MAX_SITEMAPS_FETCHED_TOTAL } = require('./sitemapDiscovery')

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

  // 12. `url` and `sitemapType` fields (2026-09-02, ROOT CAUSE #3 fix) are
  // present and correct on every returned page -- `url` is the full
  // original discovered URL (not just its pathname), and `sitemapType` is
  // the raw inferred provenance fact the classification was based on.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/post-sitemap.xml': `<urlset><url><loc>https://example.com/some-service-related-post/</loc></url></urlset>`,
      'https://example.com/page-sitemap.xml': `<urlset><url><loc>https://example.com/about/</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    const post = result.pages.find(p => p.path === '/some-service-related-post/')
    assert.strictEqual(post.url, 'https://example.com/some-service-related-post/')
    assert.strictEqual(post.sitemapType, 'post')
    assert.strictEqual(post.sourceSitemap, 'https://example.com/post-sitemap.xml')
    assert.strictEqual(post.type, 'Article')

    const about = result.pages.find(p => p.path === '/about/')
    assert.strictEqual(about.url, 'https://example.com/about/')
    assert.strictEqual(about.sitemapType, 'page')
    log('TEST 12 (every returned page carries the full original `url` and its inferred `sitemapType`, alongside the classification those facts informed) PASSED')
  }

  // 13. category/tag/author archive sitemaps are excluded from the candidate
  // universe entirely -- their pages are never collected, even though the
  // sitemap itself IS fetched (so sitemapsFetched bookkeeping stays accurate).
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/category-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/tag-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/author-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/page-sitemap.xml': `<urlset><url><loc>https://example.com/about/</loc></url></urlset>`,
      'https://example.com/category-sitemap.xml': `<urlset><url><loc>https://example.com/category/seo/</loc></url></urlset>`,
      'https://example.com/tag-sitemap.xml': `<urlset><url><loc>https://example.com/tag/link-building/</loc></url></urlset>`,
      'https://example.com/author-sitemap.xml': `<urlset><url><loc>https://example.com/author/jsmith/</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.sitemapsFetched, 5, 'the root index plus all 4 children are still fetched')
    assert.strictEqual(result.count, 1, 'only the real /about/ page counts -- category/tag/author pages are never collected')
    assert.deepStrictEqual(result.pages.map(p => p.path), ['/about/'])
    log('TEST 13 (category/tag/author archive sitemaps are fetched -- for accurate bookkeeping -- but their pages are excluded from the candidate universe entirely, never surfaced as schema page-selection candidates) PASSED')
  }

  // 14. fixture 10 -- sitemap provenance SURVIVES recursive sitemap discovery
  // end to end, into the exact shape the Schema page-selection UI consumes
  // (result.pages entries with sourceSitemap/sitemapType/type intact). Real
  // production URLs from the bug report, nested two levels deep (root index
  // -> post-sitemap.xml), must resolve to Article, not Service, exactly as
  // the pure classifyPage test already proved in isolation -- this confirms
  // the full fetchSitemapPages() pipeline preserves that same result.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex><sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/post-sitemap.xml': `<urlset>
        <url><loc>https://example.com/technical-seo-cleanup-service-indexing-crawl-budget-canonicals-redirects/</loc></url>
        <url><loc>https://example.com/seo-for-home-service-companies/</loc></url>
      </urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.pages.length, 2)
    for (const p of result.pages) {
      assert.strictEqual(p.type, 'Article', `${p.path} must survive end-to-end discovery as Article, not Service`)
      assert.strictEqual(p.classificationSource, 'sitemap_name')
      assert.strictEqual(p.sitemapType, 'post')
      assert.strictEqual(p.sourceSitemap, 'https://example.com/post-sitemap.xml')
    }
    log('TEST 14 (sitemap provenance survives recursive sitemap discovery end to end -- real "service"-slug blog-post URLs discovered via post-sitemap.xml resolve to Article, with sourceSitemap/sitemapType/classification all intact in the exact shape the Schema page-selection UI consumes) PASSED')
  }

  // 15. ROOT CAUSE #4 REGRESSION (this pass): the FIRESTARTER SHAPE -- a
  // first child sitemap alone containing MORE pages than the old 150-page
  // cap must still never crowd out a later child sitemap's pages. TEST 11
  // above only ever exercised 25 posts (comfortably under the old cap);
  // this reproduces the actual real-client failure at the scale that broke
  // it -- 200 posts in the first child, page-sitemap.xml's 4 pages
  // (including the Firestarter-analog /denver-seo-agency/) still fully
  // present, and truncated stays false since the real total is well under
  // the new MAX_SITEMAP_CANDIDATES_DISCOVERED bound.
  {
    const twoHundredPosts = Array.from({ length: 200 }, (_, i) => `<url><loc>https://example.com/blog/post-${i}/</loc></url>`).join('')
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/post-sitemap.xml': `<urlset>${twoHundredPosts}</urlset>`,
      'https://example.com/page-sitemap.xml': `<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about/</loc></url><url><loc>https://example.com/denver-seo-agency/</loc></url><url><loc>https://example.com/locations/</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, 204)
    assert.strictEqual(result.pages.length, 204, 'a first child sitemap with 200 posts -- more than the OLD 150-page cap -- must not truncate anything, since 204 is well under the new bound')
    assert.strictEqual(result.truncated, false)
    assert.deepStrictEqual(result.truncationReasons, [])
    const paths = result.pages.map(p => p.path)
    assert.ok(paths.includes('/denver-seo-agency/'), 'the real-world regression case: a high-value service page in a LATER child sitemap must survive discovery even when an EARLIER child sitemap alone exceeds the old cap')
    assert.ok(paths.includes('/locations/'))
    log('TEST 15 (ROOT CAUSE #4 regression -- the Firestarter shape: a first child sitemap with 200 posts, more than the old 150-page cap, never crowds out a later child sitemap\'s pages; nothing is truncated since the real total is under the new bound) PASSED')
  }

  // 16. an ordinary ~300-page multi-sitemap site (Firestarter's own real
  // shape: post/page/case-studies/landing-page) returns its COMPLETE
  // candidate universe, not just a subset -- every page from every child
  // sitemap present, sourceSitemap preserved throughout.
  {
    const posts = Array.from({ length: 185 }, (_, i) => `<url><loc>https://example.com/blog/post-${i}/</loc></url>`).join('')
    const pages96 = Array.from({ length: 96 }, (_, i) => `<url><loc>https://example.com/page-${i}/</loc></url>`).join('')
    const caseStudies = Array.from({ length: 18 }, (_, i) => `<url><loc>https://example.com/case-studies/study-${i}/</loc></url>`).join('')
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/case-studies-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/landing-page-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/post-sitemap.xml': `<urlset>${posts}</urlset>`,
      'https://example.com/page-sitemap.xml': `<urlset>${pages96}</urlset>`,
      'https://example.com/case-studies-sitemap.xml': `<urlset>${caseStudies}</urlset>`,
      'https://example.com/landing-page-sitemap.xml': `<urlset><url><loc>https://example.com/growth/home-services/</loc></url></urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, 300)
    assert.strictEqual(result.pages.length, 300, 'an ordinary ~300-page site must return its COMPLETE candidate universe, not a subset')
    assert.strictEqual(result.truncated, false)
    assert.ok(result.pages.every(p => typeof p.sourceSitemap === 'string' && p.sourceSitemap.length > 0), 'sourceSitemap must be preserved on every page')
    const bySitemap = {}
    for (const p of result.pages) bySitemap[p.sourceSitemap] = (bySitemap[p.sourceSitemap] || 0) + 1
    assert.strictEqual(bySitemap['https://example.com/post-sitemap.xml'], 185)
    assert.strictEqual(bySitemap['https://example.com/page-sitemap.xml'], 96)
    assert.strictEqual(bySitemap['https://example.com/case-studies-sitemap.xml'], 18)
    assert.strictEqual(bySitemap['https://example.com/landing-page-sitemap.xml'], 1)
    log('TEST 16 (an ordinary ~300-page multi-sitemap site -- Firestarter\'s own real shape -- returns its complete candidate universe across all 4 child sitemaps, with sourceSitemap preserved and correctly attributed on every page) PASSED')
  }

  // 17. the page-URL extraction bound, when a site genuinely exceeds it,
  // truncates FAIRLY -- no single high-volume sourceSitemap can starve the
  // others down to zero. Three sitemaps, each well over 1/3 of the cap,
  // summing to more than MAX_SITEMAP_CANDIDATES_DISCOVERED.
  {
    const groupA = Array.from({ length: 500 }, (_, i) => `<url><loc>https://example.com/a/page-${i}/</loc></url>`).join('')
    const groupB = Array.from({ length: 500 }, (_, i) => `<url><loc>https://example.com/b/page-${i}/</loc></url>`).join('')
    const groupC = Array.from({ length: 500 }, (_, i) => `<url><loc>https://example.com/c/page-${i}/</loc></url>`).join('')
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/a.xml</loc></sitemap>
        <sitemap><loc>https://example.com/b.xml</loc></sitemap>
        <sitemap><loc>https://example.com/c.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/a.xml': `<urlset>${groupA}</urlset>`,
      'https://example.com/b.xml': `<urlset>${groupB}</urlset>`,
      'https://example.com/c.xml': `<urlset>${groupC}</urlset>`
    })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.count, 1500, 'the true total is preserved even when the returned list is truncated')
    assert.strictEqual(result.pages.length, MAX_SITEMAP_CANDIDATES_DISCOVERED)
    assert.strictEqual(result.truncated, true)
    assert.deepStrictEqual(result.truncationReasons, ['page_url_bound_exceeded'])
    const bySitemap = {}
    for (const p of result.pages) bySitemap[p.sourceSitemap] = (bySitemap[p.sourceSitemap] || 0) + 1
    const counts = Object.values(bySitemap)
    assert.strictEqual(Object.keys(bySitemap).length, 3, 'all 3 sitemaps must be represented in the truncated list, not just the first')
    assert.ok(counts.every(c => c > 0), 'no sourceSitemap may be starved to zero')
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `round-robin sampling must split the cap near-evenly across equally-sized groups, got ${JSON.stringify(bySitemap)}`)
    log('TEST 17 (when a site genuinely exceeds the page-URL extraction bound, truncation is fair round-robin sampling across sourceSitemaps -- no single sitemap starves the others to zero, and the real total is still honestly reported) PASSED')
  }

  // 18. MAX_CHILD_SITEMAPS_PER_INDEX exceeded -- an index listing more
  // child sitemaps than the bound sets truncated=true with the specific,
  // honest reason, and never fetches the overflow children.
  {
    const manyChildren = Array.from({ length: 15 }, (_, i) => `<sitemap><loc>https://example.com/child-${i}.xml</loc></sitemap>`).join('')
    const routes = { 'https://example.com/sitemap.xml': `<sitemapindex>${manyChildren}</sitemapindex>` }
    for (let i = 0; i < 15; i++) routes[`https://example.com/child-${i}.xml`] = `<urlset><url><loc>https://example.com/child-${i}/page/</loc></url></urlset>`
    const fetcher = mockFetcher(routes)
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.truncated, true)
    assert.ok(result.truncationReasons.includes('child_sitemap_count_exceeded'))
    assert.strictEqual(result.count, MAX_CHILD_SITEMAPS_PER_INDEX, 'only the first MAX_CHILD_SITEMAPS_PER_INDEX children are ever fetched -- the rest are never explored, so their pages genuinely do not exist in the observed universe')
    log('TEST 18 (an index listing more child sitemaps than MAX_CHILD_SITEMAPS_PER_INDEX sets truncated=true with the specific reason, and never explores the overflow children) PASSED')
  }

  // 19. MAX_SITEMAP_DEPTH exceeded -- a chain of nested indexes deeper than
  // the bound stops recursing at the bound, with the specific reason, and
  // never hangs or fetches indefinitely.
  {
    const routes = {
      'https://example.com/sitemap.xml': `<sitemapindex><sitemap><loc>https://example.com/depth-1.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/depth-1.xml': `<sitemapindex><sitemap><loc>https://example.com/depth-2.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/depth-2.xml': `<sitemapindex><sitemap><loc>https://example.com/depth-3.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/depth-3.xml': `<sitemapindex><sitemap><loc>https://example.com/depth-4.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/depth-4.xml': `<urlset><url><loc>https://example.com/too-deep/</loc></url></urlset>`
    }
    const fetcher = mockFetcher(routes)
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result, null, 'every page lives past MAX_SITEMAP_DEPTH, so nothing is ever discoverable -- this must return null, not a fake empty success')
    log('TEST 19 (a nested-index chain deeper than MAX_SITEMAP_DEPTH stops recursing at the bound and never fetches past it -- confirmed here by depth-4.xml never being reachable at all) PASSED')
  }

  // 19b. same depth bound, but with a real page reachable WITHIN the bound
  // alongside a branch that exceeds it -- confirms the reason is reported
  // and the in-bounds branch still succeeds.
  {
    const routes = {
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/shallow.xml</loc></sitemap>
        <sitemap><loc>https://example.com/depth-1.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/shallow.xml': `<urlset><url><loc>https://example.com/in-bounds/</loc></url></urlset>`,
      'https://example.com/depth-1.xml': `<sitemapindex><sitemap><loc>https://example.com/depth-2.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/depth-2.xml': `<sitemapindex><sitemap><loc>https://example.com/depth-3.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/depth-3.xml': `<sitemapindex><sitemap><loc>https://example.com/depth-4.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/depth-4.xml': `<urlset><url><loc>https://example.com/too-deep/</loc></url></urlset>`
    }
    const fetcher = mockFetcher(routes)
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.truncated, true)
    assert.ok(result.truncationReasons.includes('sitemap_depth_exceeded'))
    assert.deepStrictEqual(result.pages.map(p => p.path), ['/in-bounds/'], 'the in-bounds branch must still succeed even though a sibling branch exceeded the depth bound')
    log('TEST 19b (MAX_SITEMAP_DEPTH exceeded on one branch reports the specific reason and never fetches past it, while a sibling branch within bounds still succeeds normally) PASSED')
  }

  // 20. MAX_SITEMAPS_FETCHED_TOTAL exhausted -- a total-fetch budget hit
  // partway through a tree stops fetching further sitemaps, with the
  // specific, honest reason, rather than silently under-reporting. Needs
  // TWO levels of nesting to exceed MAX_SITEMAPS_FETCHED_TOTAL(12) while
  // staying within MAX_CHILD_SITEMAPS_PER_INDEX(10) at every single index,
  // so this test isolates the total-fetch bound specifically, without also
  // tripping the child-count bound: root -> 10 child indexes, each with
  // exactly 1 grandchild urlset (1 root + up to 10x2 = 21 possible
  // fetches, budget-capped at 12).
  {
    const childIndexLocs = Array.from({ length: MAX_CHILD_SITEMAPS_PER_INDEX }, (_, i) => `<sitemap><loc>https://example.com/child-${i}.xml</loc></sitemap>`).join('')
    const routes = { 'https://example.com/sitemap.xml': `<sitemapindex>${childIndexLocs}</sitemapindex>` }
    for (let i = 0; i < MAX_CHILD_SITEMAPS_PER_INDEX; i++) {
      routes[`https://example.com/child-${i}.xml`] = `<sitemapindex><sitemap><loc>https://example.com/grandchild-${i}.xml</loc></sitemap></sitemapindex>`
      routes[`https://example.com/grandchild-${i}.xml`] = `<urlset><url><loc>https://example.com/child-${i}/page/</loc></url></urlset>`
    }
    const fetcher = mockFetcher(routes)
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.truncated, true)
    assert.ok(result.truncationReasons.includes('total_sitemap_fetches_exceeded'))
    assert.strictEqual(result.sitemapsFetched, MAX_SITEMAPS_FETCHED_TOTAL, 'fetching stops the instant the total-fetch budget is hit, never one fetch over')
    assert.ok(result.count < MAX_CHILD_SITEMAPS_PER_INDEX, 'not every child-index\'s grandchild urlset could be reached within the fetch budget, so the observed page count is honestly incomplete')
    log('TEST 20 (a tree that would need more fetches than MAX_SITEMAPS_FETCHED_TOTAL stops fetching further sitemaps at the exact bound, with the specific reason reported honestly, isolated from the child-count bound) PASSED')
  }

  // 21. sitemap cycle -- a child sitemap that references back to the root
  // (or to itself) must never cause an infinite loop or repeated fetching;
  // the cyclical reference is simply skipped (visitedSitemapUrls), and
  // everything else discoverable still resolves normally.
  {
    const fetcher = mockFetcher({
      'https://example.com/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/a.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/a.xml': `<sitemapindex>
        <sitemap><loc>https://example.com/sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/b.xml</loc></sitemap>
      </sitemapindex>`,
      'https://example.com/b.xml': `<urlset><url><loc>https://example.com/reachable/</loc></url></urlset>`
    })
    const result = await Promise.race([
      fetchSitemapPages('https://example.com/sitemap.xml', { fetcher }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TEST 21 TIMEOUT -- sitemap cycle caused an infinite loop')), 2000))
    ])
    assert.strictEqual(result.count, 1)
    assert.deepStrictEqual(result.pages.map(p => p.path), ['/reachable/'])
    log('TEST 21 (a sitemap cycle -- a child sitemap referencing back to the root -- never causes an infinite loop; the cyclical reference is skipped and everything else discoverable still resolves) PASSED')
  }

  // 22. Schema Recommended/All determinism is unaffected by a larger
  // candidate universe -- lib/schemaPagePriority.js's own tests cover this
  // directly (see lib/schemaPagePriority.test.js); this is a lightweight
  // sanity check at this layer that a candidate list well past the OLD
  // 150-item cap is still returned as an ordinary array with no shape
  // change lib/schemaPagePriority.js would need to special-case.
  {
    const manyPages = Array.from({ length: 400 }, (_, i) => `<url><loc>https://example.com/page-${i}/</loc></url>`).join('')
    const fetcher = mockFetcher({ 'https://example.com/sitemap.xml': `<urlset>${manyPages}</urlset>` })
    const result = await fetchSitemapPages('https://example.com/sitemap.xml', { fetcher })
    assert.strictEqual(result.pages.length, 400)
    assert.ok(Array.isArray(result.pages))
    assert.ok(result.pages.every(p => typeof p.type === 'string' && typeof p.path === 'string'), 'every page in a large candidate universe is still fully classified, same shape as a small one')
    log('TEST 22 (a candidate universe well past the OLD 150-item cap is still an ordinary, fully-classified array -- no shape change for lib/schemaPagePriority.js or any other consumer to special-case) PASSED')
  }

  console.log('\nAll lib/sitemapDiscovery.js mocked-fetcher tests passed (no real network calls).')
}

run()
