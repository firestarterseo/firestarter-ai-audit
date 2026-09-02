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
  looksLikeNonPageAsset, classifyPage
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

  // 6. classifyPage -- sitemap-filename-hint evidence (classificationSource:
  // 'sitemap_name'). This is the fix for the real misclassification the
  // architecture audit found: a page with no URL-pattern evidence at all
  // (e.g. /ultimate-guide-google-penalties/) still resolves correctly when
  // it was discovered in a sitemap whose filename is unambiguous evidence.
  {
    const postSitemapPage = classifyPage({ path: '/ultimate-guide-google-penalties/', sourceSitemap: 'https://example.com/post-sitemap.xml' })
    assert.strictEqual(postSitemapPage.type, 'Article')
    assert.strictEqual(postSitemapPage.classificationSource, 'sitemap_name')
    assert.strictEqual(postSitemapPage.classificationConfidence, 'medium')
    assert.ok(/post-sitemap\.xml/.test(postSitemapPage.classificationReason))

    const caseStudySitemapPage = classifyPage({ path: '/acme-turnaround/', sourceSitemap: 'https://example.com/case-studies-sitemap.xml' })
    assert.strictEqual(caseStudySitemapPage.type, 'Case Study')
    assert.strictEqual(caseStudySitemapPage.classificationSource, 'sitemap_name')
    assert.strictEqual(caseStudySitemapPage.classificationConfidence, 'medium')

    // A URL pattern match still wins over a sitemap-filename hint when both
    // are present -- URL evidence is stronger/more specific than a filename.
    const contactInPostSitemap = classifyPage({ path: '/contact/', sourceSitemap: 'https://example.com/post-sitemap.xml' })
    assert.strictEqual(contactInPostSitemap.type, 'Contact')
    assert.strictEqual(contactInPostSitemap.classificationSource, 'url_pattern')

    // An ambiguous sitemap filename (page-sitemap.xml, landing-page-sitemap.xml)
    // with no URL-pattern evidence resolves to Other, at low confidence, with
    // an honest reason -- never silently mislabeled as a specific type.
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
    log('TEST 6 (classifyPage falls back to source-sitemap-filename evidence when no URL pattern resolves a type -- post-sitemap.xml -> Article, case-studies-sitemap.xml -> Case Study, at medium confidence -- URL evidence still wins when both are present, and an ambiguous or absent sitemap name is reported honestly as Other/low-confidence rather than silently guessed) PASSED')
  }

  // 7. malformed input never throws.
  {
    assert.strictEqual(detectSitemapKind(null), 'unknown')
    assert.strictEqual(detectSitemapKind(''), 'unknown')
    assert.strictEqual(detectSitemapKind('not xml at all'), 'unknown')
    assert.strictEqual(looksLikeNonPageAsset('not a url'), false)
    assert.doesNotThrow(() => classifyPage({ path: null, sourceSitemap: undefined }))
    log('TEST 7 (malformed/empty/non-XML input never throws -- it comes back as "unknown" or a safe default) PASSED')
  }

  console.log('\nAll lib/sitemapDiscovery.js pure tests passed (no network calls, no mocked fetcher required).')
}

run()
