const fs = require('fs')
const path = require('path')
const { checkTechnicalFoundation } = require('../technical-checker')

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8')
}

// ---------------------------------------------------------------------------
// CASE 1: Denver Tax Advisor — mock fetcher backed by real responses I
// captured live via browser automation (sandbox Node can't reach the open
// internet, so this replays real captured data rather than guessing):
//   - robots.txt: real, fetched live (200, references sitemap over http://)
//   - sitemap.xml: real shape (<urlset>, 30 <url> entries confirmed live;
//     this fixture reproduces the captured excerpt + realistic padding to
//     match the real count — see comment in the fixture file)
//   - homepage links: the real 11 internal links found on the live page,
//     all independently confirmed to return 200 via live fetch
//   - HTTP->HTTPS redirect: NOT independently observable from this sandbox
//     (fetching plain http:// from here throws — mixed content / no direct
//     path out), so the mock fetcher throws for that one call on purpose,
//     to exercise the checker's real fallback path rather than fake a result
//     I didn't actually observe
//   - PageSpeed Insights: confirmed live that Google's anonymous PSI quota
//     is 0 requests/day (HTTP 429) — no API key exists yet, so this case
//     deliberately omits one, to prove the "not verified, not penalized"
//     path works as designed
// ---------------------------------------------------------------------------
async function mockFetcherDenverTaxAdvisor(url, opts) {
  if (url === 'https://denvertaxadvisor.com/' && (!opts || opts.redirect !== 'manual')) {
    return { ok: true, status: 200, text: async () => readFixture('denvertaxadvisor.homepage.html') }
  }
  if (url === 'http://denvertaxadvisor.com/') {
    throw new Error('Fetching plain http:// is not independently reachable from this sandbox (mixed content).')
  }
  if (url === 'https://denvertaxadvisor.com/robots.txt') {
    return { ok: true, status: 200, text: async () => readFixture('denvertaxadvisor.robots.txt') }
  }
  if (url === 'https://denvertaxadvisor.com/sitemap.xml') {
    return { ok: true, status: 200, text: async () => readFixture('denvertaxadvisor.sitemap.xml') }
  }
  // Internal links sampled from the homepage fixture — all confirmed live to
  // return 200 (verified individually via browser fetch during this session).
  return { ok: true, status: 200, text: async () => '' }
}

// ---------------------------------------------------------------------------
// CASE 2: Negative control — a synthetic "broken" site, entirely fabricated
// (no live data, this is deliberately the bad case): sitewide robots.txt
// Disallow, no sitemap, a homepage with obviously broken internal links.
// ---------------------------------------------------------------------------
const BAD_HOMEPAGE_HTML = `<!DOCTYPE html><html><body>
  <a href="https://badsite.example.com/">Home</a>
  <a href="https://badsite.example.com/broken-page-1/">Broken 1</a>
  <a href="https://badsite.example.com/broken-page-2/">Broken 2</a>
  <a href="https://badsite.example.com/works-fine/">Fine</a>
</body></html>`

const BAD_ROBOTS_TXT = `User-agent: *\nDisallow: /\n`

async function mockFetcherBadSite(url) {
  if (url === 'https://badsite.example.com/') {
    return { ok: true, status: 200, text: async () => BAD_HOMEPAGE_HTML }
  }
  if (url === 'http://badsite.example.com/') {
    return { ok: false, status: null }
  }
  if (url === 'https://badsite.example.com/robots.txt') {
    return { ok: true, status: 200, text: async () => BAD_ROBOTS_TXT }
  }
  if (url === 'https://badsite.example.com/sitemap.xml') {
    return { ok: false, status: 404 }
  }
  if (url.includes('/broken-page-')) {
    return { ok: false, status: 404 }
  }
  if (url === 'https://badsite.example.com/works-fine/') {
    return { ok: true, status: 200, text: async () => '' }
  }
  return { ok: false, status: 500 }
}

async function main() {
  console.log('='.repeat(70))
  console.log('CASE 1: Denver Tax Advisor — replayed from real live responses')
  console.log('='.repeat(70))
  const r1 = await checkTechnicalFoundation('https://denvertaxadvisor.com/', { fetcher: mockFetcherDenverTaxAdvisor })
  console.log(JSON.stringify(r1, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log('CASE 2: Negative control — synthetic broken site')
  console.log('='.repeat(70))
  const r2 = await checkTechnicalFoundation('https://badsite.example.com/', { fetcher: mockFetcherBadSite })
  console.log(JSON.stringify(r2, null, 2))
}

main()
