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
    'https://example.com/post-sitemap.xml': `<urlset><url><loc>https://example.com/blog/example/</loc></url></urlset>`,
    'https://example.com/page-sitemap.xml': `<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about/</loc></url><url><loc>https://example.com/contact/</loc></url></urlset>`,
    'https://example.com/case-studies-sitemap.xml': `<urlset><url><loc>https://example.com/case-studies/example/</loc></url></urlset>`,
    'https://example.com/landing-page-sitemap.xml': `<urlset><url><loc>https://example.com/services/seo/</loc></url></urlset>`
  })

  const result = await checkSchemaAndStructure(HOMEPAGE_HTML, { url: 'https://example.com', fetcher })

  console.log(JSON.stringify({ sitemapPageCount: result._raw.sitemapPageCount, sitemapPages: result._raw.sitemapPages }, null, 2))

  assert.strictEqual(result._raw.sitemapPageCount, 6, 'real distinct page count across all 4 child sitemaps')
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

  // Schema scoring itself must be entirely unaffected by this fix -- confirm
  // the homepage's own real checks still ran and scored normally.
  assert.strictEqual(typeof result.score, 'number')
  assert.ok(result.score > 0)
  assert.ok(Array.isArray(result.checks) && result.checks.length === 7)

  console.log('\nAll Schema & Structure sitemap/page-discovery regression checks passed.')
}

main()
