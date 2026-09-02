// Integration-level regression test for the Schema & Structure
// sitemap/page-discovery bug fix (2026-09-02): exercises the REAL
// checkSchemaAndStructure() entry point (not just lib/sitemapDiscovery.js in
// isolation) with a mock fetcher simulating a sitemap index -- the exact
// reported bug shape (index -> post-sitemap.xml, page-sitemap.xml,
// case-studies-sitemap.xml, landing-page-sitemap.xml) -- and confirms the
// persisted `_raw.sitemapPages` / `_raw.sitemapPageCount` contract SchemaWizard.js
// reads from is correct end to end: real page URLs, correctly classified,
// and never the sitemap XML files themselves.
//
// Picked up automatically by `npm run test:checkers` (globs this directory).

const assert = require('assert')
const { checkSchemaAndStructure } = require('../checker')

const HOMEPAGE_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'LocalBusiness',
  name: 'Example Co',
  address: { '@type': 'PostalAddress', streetAddress: '123 Main St' },
  telephone: '555-1234'
})}</script>
</head><body>Example Co homepage</body></html>`

function mockFetcher(routes) {
  return async (url) => {
    const body = routes[url]
    if (body === undefined) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => body }
  }
}

async function main() {
  console.log('='.repeat(70))
  console.log('SCHEMA & STRUCTURE -- sitemap/page-discovery bug fix regression test')
  console.log('='.repeat(70))

  const fetcher = mockFetcher({
    'https://example.com/sitemap.xml': `<sitemapindex>
      <sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap>
      <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
      <sitemap><loc>https://example.com/case-studies-sitemap.xml</loc></sitemap>
      <sitemap><loc>https://example.com/landing-page-sitemap.xml</loc></sitemap>
    </sitemapindex>`,
    'https://example.com/post-sitemap.xml': `<urlset><url><loc>https://example.com/blog/example/</loc></url><url><loc>https://example.com/seo-for-home-service-companies/</loc></url></urlset>`,
    'https://example.com/page-sitemap.xml': `<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about/</loc></url><url><loc>https://example.com/contact/</loc></url></urlset>`,
    'https://example.com/case-studies-sitemap.xml': `<urlset><url><loc>https://example.com/case-studies/example/</loc></url></urlset>`,
    'https://example.com/landing-page-sitemap.xml': `<urlset><url><loc>https://example.com/services/seo/</loc></url></urlset>`
  })

  const result = await checkSchemaAndStructure(HOMEPAGE_HTML, { url: 'https://example.com', fetcher })

  console.log(JSON.stringify({ sitemapPageCount: result._raw.sitemapPageCount, sitemapPages: result._raw.sitemapPages }, null, 2))

  assert.strictEqual(result._raw.sitemapPageCount, 7, 'real distinct page count across all 4 child sitemaps')
  assert.ok(Array.isArray(result._raw.sitemapPages))

  const paths = result._raw.sitemapPages.map(p => p.path)
  assert.ok(!paths.some(p => p.endsWith('.xml')), 'no sitemap XML file may ever appear in sitemapPages')
  assert.ok(paths.includes('/'))
  assert.ok(paths.includes('/about/'))
  assert.ok(paths.includes('/services/seo/'))

  const byPath = Object.fromEntries(result._raw.sitemapPages.map(p => [p.path, p.type]))
  assert.strictEqual(byPath['/'], 'Home')
  assert.strictEqual(byPath['/about/'], 'About')
  assert.strictEqual(byPath['/contact/'], 'Contact')
  assert.strictEqual(byPath['/blog/example/'], 'Article')
  assert.strictEqual(byPath['/case-studies/example/'], 'Case Study')
  assert.strictEqual(byPath['/services/seo/'], 'Service')
  // ROOT CAUSE #3 regression (2026-09-02): a real blog-post slug containing
  // the word "service", discovered in post-sitemap.xml, must survive all the
  // way through the real checkSchemaAndStructure() entry point as Article --
  // this is the exact bug reported in production, exercised end to end
  // through the persisted _raw.sitemapPages contract, not just the pure
  // classifier or fetchSitemapPages() in isolation.
  assert.strictEqual(byPath['/seo-for-home-service-companies/'], 'Article', 'a "service"-mentioning slug discovered in post-sitemap.xml must classify as Article, not Service, all the way through the real checker entry point')

  // Phase A (2026-09-02): every page also carries a transparent
  // classification record -- source, confidence, and a real reason -- never
  // a bare type label. Spot-check both evidence paths this fixture
  // exercises: URL-pattern (high confidence, e.g. /about/) and STRONG
  // sitemap-name provenance (high confidence, e.g. /blog/example/ and the
  // "service"-slug post, both discovered in post-sitemap.xml).
  const byPathFull = Object.fromEntries(result._raw.sitemapPages.map(p => [p.path, p]))
  for (const p of result._raw.sitemapPages) {
    assert.ok(['url_pattern', 'sitemap_name', 'none'].includes(p.classificationSource), `unexpected classificationSource for ${p.path}`)
    assert.ok(['high', 'medium', 'low'].includes(p.classificationConfidence), `unexpected classificationConfidence for ${p.path}`)
    assert.ok(typeof p.classificationReason === 'string' && p.classificationReason.length > 0, `missing classificationReason for ${p.path}`)
    // ROOT CAUSE #3 (2026-09-02): sitemap provenance must survive recursive
    // sitemap discovery all the way into this persisted shape -- both the
    // full original `url` and the raw inferred `sitemapType` fact must be
    // present on every page, not just the classification they informed.
    assert.ok(typeof p.url === 'string' && p.url.length > 0, `missing url for ${p.path}`)
    assert.ok(typeof p.sourceSitemap === 'string' && p.sourceSitemap.length > 0, `missing sourceSitemap for ${p.path}`)
    assert.ok(typeof p.sitemapType === 'string' && p.sitemapType.length > 0, `missing sitemapType for ${p.path}`)
  }
  assert.strictEqual(byPathFull['/about/'].classificationSource, 'url_pattern')
  assert.strictEqual(byPathFull['/about/'].classificationConfidence, 'high')
  assert.strictEqual(byPathFull['/blog/example/'].classificationSource, 'sitemap_name')
  assert.strictEqual(byPathFull['/blog/example/'].classificationConfidence, 'high')
  assert.strictEqual(byPathFull['/blog/example/'].sitemapType, 'post')
  assert.strictEqual(byPathFull['/seo-for-home-service-companies/'].classificationSource, 'sitemap_name')
  assert.strictEqual(byPathFull['/seo-for-home-service-companies/'].sitemapType, 'post')

  // Schema scoring itself must be entirely unaffected by this fix -- confirm
  // the homepage's own real checks still ran and scored normally.
  assert.strictEqual(typeof result.score, 'number')
  assert.ok(result.score > 0)
  assert.ok(Array.isArray(result.checks) && result.checks.length === 7)

  console.log('\nAll Schema & Structure sitemap/page-discovery regression checks passed.')
}

main()
