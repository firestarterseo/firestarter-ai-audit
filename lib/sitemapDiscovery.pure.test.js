// Pure tests for lib/sitemapDiscovery.js's parsing/classification helpers --
// plain Node, no network, no mocked fetcher. Run with:
//   node lib/sitemapDiscovery.pure.test.js
//
// Sitemap/page-discovery bug fix (2026-09-02). See lib/sitemapDiscovery.js's
// header for the full root-cause writeup. Recursive-fetch behavior (which
// needs a mock fetcher) is covered separately in lib/sitemapDiscovery.test.js.
//
// Updated 2026-09-02 (Phase A of the Schema page-workflow redesign):
// classifySitemapPath(path) -> single label was replaced by
// classifyPage({ path, sourceSitemap }) -> a full, transparent
// classification record { type, classificationSource,
// classificationConfidence, classificationReason }. These tests now exercise
// that full contract, including the new source-sitemap-filename-hint
// evidence path (post-sitemap.xml -> Article, case-studies-sitemap.xml ->
// Case Study) and the Utility/Legal category, neither of which existed
// before this pass.

const assert = require('assert')
const {
  detectSitemapKind, extractIndexChildLocs, extractUrlsetPageLocs,
  looksLikeNonPageAsset, classifyPage, inferSitemapType
} = require('./sitemapDiscovery')

function log(msg) { console.log(msg) }

const PLAIN_URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about/</loc></url>
  <url><loc>https://example.com/contact/</loc></url>
  <url><loc>https://example.com/services/seo/</loc></url>
</urlset>`

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://example.com/case-studies-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://example.com/landing-page-sitemap.xml</loc></sitemap>
</sitemapindex>`

const URLSET_WITH_IMAGE_AND_NEWS_EXTENSIONS = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>https://example.com/blog/example-post/</loc>
    <image:image><image:loc>https://example.com/wp-content/uploads/hero.jpg</image:loc></image:image>
    <news:news><news:publication><news:name>Example</news:name></news:publication></news:news>
  </url>
  <url><loc>https://example.com/downloads/brochure.pdf</loc></url>
</urlset>`

function run() {
  // 1. plain urlset sitemap: detected as urlset, page locs extracted, no
  // sitemap-index child locs found at all.
  {
    assert.strictEqual(detectSitemapKind(PLAIN_URLSET), 'urlset')
    const pages = extractUrlsetPageLocs(PLAIN_URLSET)
    assert.deepStrictEqual(pages, [
      'https://example.com/',
      'https://example.com/about/',
      'https://example.com/contact/',
      'https://example.com/services/seo/'
    ])
    log('TEST 1 (a plain <urlset> sitemap is detected as "urlset" and every real <url><loc> is extracted) PASSED')
  }

  // 2. sitemap index with multiple child sitemaps: detected as sitemapindex,
  // and its <loc> entries are the child sitemap URLs -- exactly the
  // /post-sitemap.xml / page-sitemap.xml / etc. shape from the reported bug.
  {
    assert.strictEqual(detectSitemapKind(SITEMAP_INDEX), 'sitemapindex')
    const childLocs = extractIndexChildLocs(SITEMAP_INDEX)
    assert.deepStrictEqual(childLocs, [
      'https://example.com/post-sitemap.xml',
      'https://example.com/page-sitemap.xml',
      'https://example.com/case-studies-sitemap.xml',
      'https://example.com/landing-page-sitemap.xml'
    ])
    // And, critically, a sitemap index has no <url> blocks -- the urlset
    // page extractor must find zero pages in it directly (it must be
    // recursed into by lib/sitemapDiscovery.js#fetchSitemapPages, never
    // read for pages itself).
    assert.deepStrictEqual(extractUrlsetPageLocs(SITEMAP_INDEX), [])
    log('TEST 2 (a sitemap index\'s <loc> entries are recognized as child sitemap references, not pages) PASSED')
  }

  // 3. sitemap XML URL never emitted as a page: every child sitemap URL
  // above ends in .xml and must be classified as a non-page asset if it
  // were ever (incorrectly) considered as a page candidate.
  {
    for (const url of extractIndexChildLocs(SITEMAP_INDEX)) {
      assert.strictEqual(looksLikeNonPageAsset(url), true, `${url} must be excluded as a non-page asset`)
    }
    log('TEST 3 (every sitemap XML child URL is recognized as a non-page asset, as a second independent safety net) PASSED')
  }

  // 4. non-page asset excluded: a urlset whose <url><loc> block has nested
  // image/news extensions still yields only the real page's own <loc> (the
  // nested <image:loc> is a different tag name and is never matched), and a
  // literal PDF URL used as a <url><loc> is excluded by extension.
  {
    const locs = extractUrlsetPageLocs(URLSET_WITH_IMAGE_AND_NEWS_EXTENSIONS)
    assert.deepStrictEqual(locs, [
      'https://example.com/blog/example-post/',
      'https://example.com/downloads/brochure.pdf'
    ])
    assert.strictEqual(looksLikeNonPageAsset('https://example.com/blog/example-post/'), false)
    assert.strictEqual(looksLikeNonPageAsset('https://example.com/downloads/brochure.pdf'), true)
    log('TEST 4 (an image/news sitemap extension\'s nested tags are never mistaken for the page\'s own <loc>, and a direct asset URL like a PDF is excluded by extension) PASSED')
  }

  // 5. classifyPage -- URL-pattern classification (classificationSource:
  // 'url_pattern', confidence: 'high') covers homepage/service/location/
  // article/case-study/about/contact/utility-legal, with specific patterns
  // checked before general ones, and every result carries a real,
  // human-readable reason -- never a bare label.
  {
    function urlType(path) { return classifyPage({ path, sourceSitemap: null }).type }
    assert.strictEqual(urlType('/'), 'Home')
    assert.strictEqual(urlType(''), 'Home')
    assert.strictEqual(urlType('/services/seo/'), 'Service')
    assert.strictEqual(urlType('/service-page/'), 'Service')
    assert.strictEqual(urlType('/locations/denver/'), 'Location')
    assert.strictEqual(urlType('/service-areas/denver/'), 'Location')
    assert.strictEqual(urlType('/blog/example-post/'), 'Article')
    assert.strictEqual(urlType('/news/example/'), 'Article')
    assert.strictEqual(urlType('/case-studies/example/'), 'Case Study')
    assert.strictEqual(urlType('/about/'), 'About')
    assert.strictEqual(urlType('/about-us/'), 'About')
    assert.strictEqual(urlType('/contact/'), 'Contact')
    assert.strictEqual(urlType('/privacy-policy/'), 'Utility/Legal')
    assert.strictEqual(urlType('/terms-of-service/'), 'Utility/Legal')
    // More-specific patterns win over the general 'Service' pattern.
    assert.strictEqual(urlType('/services/case-studies/example/'), 'Case Study')

    const home = classifyPage({ path: '/', sourceSitemap: null })
    assert.strictEqual(home.classificationSource, 'url_pattern')
    assert.strictEqual(home.classificationConfidence, 'high')
    assert.ok(home.classificationReason.length > 0)

    const about = classifyPage({ path: '/about/', sourceSitemap: 'https://example.com/page-sitemap.xml' })
    assert.strictEqual(about.type, 'About')
    assert.strictEqual(about.classificationSource, 'url_pattern')
    assert.strictEqual(about.classificationConfidence, 'high')
    log('TEST 5 (classifyPage\'s URL-pattern evidence covers homepage/service/location/article/case-study/about/contact/utility-legal at high confidence, specific patterns before general ones, always with a real reason) PASSED')
  }

  // 6. classifyPage -- STRONG sitemap-type provenance (classificationSource:
  // 'sitemap_name', confidence 'high'). Updated 2026-09-02 (ROOT CAUSE #3
  // fix): a page discovered in post-sitemap.xml / case-studies-sitemap.xml /
  // product-sitemap.xml is now classified from that STRONG, CMS-authored
  // provenance at HIGH confidence -- and, critically, this NO LONGER yields
  // to a competing URL-pattern match (see TEST 9/16 below for the actual
  // regression case: a Contact-pattern-matching or Service-pattern-matching
  // URL discovered in post-sitemap.xml must still resolve to Article).
  {
    const postSitemapPage = classifyPage({ path: '/ultimate-guide-google-penalties/', sourceSitemap: 'https://example.com/post-sitemap.xml' })
    assert.strictEqual(postSitemapPage.type, 'Article')
    assert.strictEqual(postSitemapPage.classificationSource, 'sitemap_name')
    assert.strictEqual(postSitemapPage.classificationConfidence, 'high')
    assert.ok(/post-sitemap\.xml/.test(postSitemapPage.classificationReason))

    const caseStudySitemapPage = classifyPage({ path: '/acme-turnaround/', sourceSitemap: 'https://example.com/case-studies-sitemap.xml' })
    assert.strictEqual(caseStudySitemapPage.type, 'Case Study')
    assert.strictEqual(caseStudySitemapPage.classificationSource, 'sitemap_name')
    assert.strictEqual(caseStudySitemapPage.classificationConfidence, 'high')

    // ROOT CAUSE #3's core regression: a URL that LOOKS like a Contact page
    // (matches the Contact URL pattern) but was discovered in post-sitemap.xml
    // now correctly resolves to Article -- explicit STRONG sitemap provenance
    // is never overridden by a URL-pattern match in this phase. (Before this
    // fix, this incorrectly resolved to Contact/url_pattern.)
    const contactInPostSitemap = classifyPage({ path: '/contact/', sourceSitemap: 'https://example.com/post-sitemap.xml' })
    assert.strictEqual(contactInPostSitemap.type, 'Article')
    assert.strictEqual(contactInPostSitemap.classificationSource, 'sitemap_name')
    assert.strictEqual(contactInPostSitemap.classificationConfidence, 'high')

    // An ambiguous/GENERIC sitemap filename (page-sitemap.xml) with no
    // URL-pattern evidence resolves to Other, at low confidence, with an
    // honest reason -- never silently mislabeled as a specific type.
    const ambiguous = classifyPage({ path: '/some-random-page/', sourceSitemap: 'https://example.com/page-sitemap.xml' })
    assert.strictEqual(ambiguous.type, 'Other')
    assert.strictEqual(ambiguous.classificationSource, 'sitemap_name')
    assert.strictEqual(ambiguous.classificationConfidence, 'low')
    assert.ok(/page-sitemap\.xml/.test(ambiguous.classificationReason))

    // No URL pattern and no sitemap-name evidence at all -- Other, source
    // 'none', with an honest "nothing resolved this" reason.
    const noEvidence = classifyPage({ path: '/some-random-page/', sourceSitemap: null })
    assert.strictEqual(noEvidence.type, 'Other')
    assert.strictEqual(noEvidence.classificationSource, 'none')
    assert.strictEqual(noEvidence.classificationConfidence, 'low')
    log('TEST 6 (classifyPage treats STRONG sitemap-type provenance -- post-sitemap.xml -> Article, case-studies-sitemap.xml -> Case Study -- as HIGH-confidence evidence that a competing URL-pattern match can no longer override; an ambiguous/GENERIC or absent sitemap name is still reported honestly as Other/low-confidence) PASSED')
  }

  // 8. GOAL fixture 1/2 (user bug report): real blog-post URLs whose slug
  // contains the bare word "service"/"services" must classify as Article
  // when discovered in post-sitemap.xml, including numbered post-sitemap
  // variants (post-sitemap2.xml) -- no hardcoding of the numbered filename,
  // just substring pattern matching on /post-sitemap/i.
  {
    const p1 = classifyPage({ path: '/technical-seo-cleanup-service-indexing-crawl-budget-canonicals-redirects/', sourceSitemap: 'https://example.com/post-sitemap.xml' })
    assert.strictEqual(p1.type, 'Article')
    assert.strictEqual(p1.classificationSource, 'sitemap_name')

    const p2 = classifyPage({ path: '/digital-pr-link-building-service-earned-media-authority-backlinks/', sourceSitemap: 'https://example.com/post-sitemap2.xml' })
    assert.strictEqual(p2.type, 'Article')
    assert.strictEqual(p2.classificationSource, 'sitemap_name')
    assert.strictEqual(inferSitemapType('https://example.com/post-sitemap2.xml'), 'post')
    log('TEST 8 (real blog-post slugs containing "service"/"services", discovered in post-sitemap.xml and the numbered variant post-sitemap2.xml, both classify as Article -- the reported bug) PASSED')
  }

  // 9. fixture 3: case-studies-sitemap.xml -> Case Study (already exercised
  // in TEST 6; reconfirmed here against a URL shape closer to the bug report).
  {
    const cs = classifyPage({ path: '/seo-for-home-service-companies/', sourceSitemap: 'https://example.com/case-studies-sitemap.xml' })
    assert.strictEqual(cs.type, 'Case Study')
    assert.strictEqual(cs.classificationSource, 'sitemap_name')
    log('TEST 9 (a "service"-mentioning slug discovered in case-studies-sitemap.xml still classifies as Case Study, not Service) PASSED')
  }

  // 10. fixture 4: landing-page-sitemap.xml with no more-specific URL match
  // defaults to the new 'Landing Page' type, at medium confidence (GENERIC
  // sitemap type, not STRONG -- URL pattern is still tried first).
  {
    const lp = classifyPage({ path: '/spring-promo-2026/', sourceSitemap: 'https://example.com/landing-page-sitemap.xml' })
    assert.strictEqual(lp.type, 'Landing Page')
    assert.strictEqual(lp.classificationSource, 'sitemap_name')
    assert.strictEqual(lp.classificationConfidence, 'medium')
    assert.ok(/landing-page-sitemap\.xml/.test(lp.classificationReason))
    log('TEST 10 (landing-page-sitemap.xml with no more-specific URL match defaults to the new Landing Page type, at medium confidence) PASSED')
  }

  // 11. fixture 5: page-sitemap.xml (GENERIC, not STRONG) + a /services/...
  // URL still resolves to Service via URL-pattern evidence -- page-sitemap.xml
  // makes no strong structural claim of its own to protect URL evidence from.
  {
    const svc = classifyPage({ path: '/services/seo/', sourceSitemap: 'https://example.com/page-sitemap.xml' })
    assert.strictEqual(svc.type, 'Service')
    assert.strictEqual(svc.classificationSource, 'url_pattern')
    log('TEST 11 (page-sitemap.xml + a /services/ URL still resolves to Service via URL-pattern evidence, since page-sitemap.xml is a GENERIC, not STRONG, sitemap type) PASSED')
  }

  // 12/13. fixtures 6 and 7: page-sitemap.xml + /about/ -> About, and
  // page-sitemap.xml + /contact/ -> Contact -- both via URL-pattern evidence,
  // unaffected by this fix (page-sitemap.xml is GENERIC).
  {
    const about = classifyPage({ path: '/about/', sourceSitemap: 'https://example.com/page-sitemap.xml' })
    assert.strictEqual(about.type, 'About')
    assert.strictEqual(about.classificationSource, 'url_pattern')

    const contact = classifyPage({ path: '/contact/', sourceSitemap: 'https://example.com/page-sitemap.xml' })
    assert.strictEqual(contact.type, 'Contact')
    assert.strictEqual(contact.classificationSource, 'url_pattern')
    log('TEST 12 (page-sitemap.xml + /about/ -> About, page-sitemap.xml + /contact/ -> Contact, both via URL-pattern evidence, unaffected by this fix) PASSED')
  }

  // 14. fixture 8: an unrecognized/non-WordPress sitemap filename falls back
  // safely -- URL pattern first, then Other/low-confidence if nothing matches
  // -- it is never treated as if it made a STRONG or GENERIC structural claim.
  {
    assert.strictEqual(inferSitemapType('https://example.com/sitemap-misc.xml'), 'unknown')
    const withUrlMatch = classifyPage({ path: '/services/consulting/', sourceSitemap: 'https://example.com/sitemap-misc.xml' })
    assert.strictEqual(withUrlMatch.type, 'Service')
    assert.strictEqual(withUrlMatch.classificationSource, 'url_pattern')

    const withoutUrlMatch = classifyPage({ path: '/random-page-name/', sourceSitemap: 'https://example.com/sitemap-misc.xml' })
    assert.strictEqual(withoutUrlMatch.type, 'Other')
    assert.strictEqual(withoutUrlMatch.classificationSource, 'none')
    assert.strictEqual(withoutUrlMatch.classificationConfidence, 'low')
    log('TEST 14 (an unrecognized/non-WordPress sitemap filename resolves to "unknown" sitemap type -- not WordPress is assumed -- and classification falls back safely to URL-pattern evidence or an honest Other/low-confidence result) PASSED')
  }

  // 15. fixture 9 -- THE CORE REGRESSION TEST for this whole fix: explicit
  // sitemap provenance (post-sitemap.xml) outranks a directly conflicting
  // slug heuristic. Real production URLs from the bug report, each
  // containing "service"/"services" in the slug but discovered in
  // post-sitemap.xml, must classify as Article, never Service.
  {
    const realUrls = [
      '/technical-seo-cleanup-service-indexing-crawl-budget-canonicals-redirects/',
      '/seo-for-home-service-companies/',
      '/digital-pr-link-building-service-earned-media-authority-backlinks/'
    ]
    for (const path of realUrls) {
      const result = classifyPage({ path, sourceSitemap: 'https://example.com/post-sitemap.xml' })
      assert.strictEqual(result.type, 'Article', `${path} must classify as Article, not ${result.type}`)
      assert.strictEqual(result.classificationSource, 'sitemap_name')
      // Sanity check the OLD (buggy) behavior really would have fired here --
      // i.e. this is a real regression test, not a vacuous one.
      assert.ok(/\bservices?\b/i.test(path), `${path} must actually contain a Service-pattern-triggering word, or this test proves nothing`)
    }
    log('TEST 15 (CORE REGRESSION: real production blog-post URLs whose slugs contain "service"/"services", discovered in post-sitemap.xml, classify as Article -- explicit sitemap provenance outranks the conflicting URL-slug heuristic) PASSED')
  }

  // 16. malformed input never throws.
  {
    assert.strictEqual(detectSitemapKind(null), 'unknown')
    assert.strictEqual(detectSitemapKind(''), 'unknown')
    assert.strictEqual(detectSitemapKind('not xml at all'), 'unknown')
    assert.strictEqual(looksLikeNonPageAsset('not a url'), false)
    assert.doesNotThrow(() => classifyPage({ path: null, sourceSitemap: undefined }))
    assert.strictEqual(inferSitemapType(null), 'unknown')
    assert.strictEqual(inferSitemapType(undefined), 'unknown')
    log('TEST 16 (malformed/empty/non-XML input never throws -- it comes back as "unknown" or a safe default) PASSED')
  }

  console.log('\nAll lib/sitemapDiscovery.js pure tests passed (no network calls, no mocked fetcher required).')
}

run()
