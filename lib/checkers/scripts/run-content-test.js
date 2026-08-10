const fs = require('fs')
const path = require('path')
const { checkContentAuthority } = require('../content-checker')

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8')
}

// ---------------------------------------------------------------------------
// CASE 1: Denver Tax Advisor — real data, captured live this session:
//   - homepage/service/resources page text: real (see fixture file headers
//     for exactly what was captured vs. truncated)
//   - sitemap lastmod dates: all 30, real, unmodified
//   - blog datePublished: real (most recent post found: 2019-09-07)
//   - "now" is pinned to today's real date so the freshness math is honest,
//     not dependent on when this script happens to run
// ---------------------------------------------------------------------------
async function mockFetcherDenverTaxAdvisor(url) {
  if (url === 'https://denvertaxadvisor.com/') {
    return { ok: true, status: 200, text: async () => readFixture('denvertaxadvisor.home.text.html') }
  }
  if (url === 'https://denvertaxadvisor.com/services/denver-tax-preparation/') {
    return { ok: true, status: 200, text: async () => readFixture('denvertaxadvisor.service.text.html') }
  }
  if (url === 'https://denvertaxadvisor.com/tax-resources/') {
    return { ok: true, status: 200, text: async () => readFixture('denvertaxadvisor.resources.text.html') }
  }
  if (url === 'https://denvertaxadvisor.com/sitemap.xml') {
    const { lastmods } = JSON.parse(readFixture('denvertaxadvisor.sitemap-lastmods.json'))
    const xml = `<?xml version="1.0"?><urlset>${lastmods.map(d => `<url><lastmod>${d}</lastmod></url>`).join('')}</urlset>`
    return { ok: true, status: 200, text: async () => xml }
  }
  if (url === 'https://denvertaxadvisor.com/blog/') {
    return { ok: true, status: 200, text: async () => readFixture('denvertaxadvisor.blog.html') }
  }
  return { ok: false, status: 404 }
}

// ---------------------------------------------------------------------------
// CASE 2: Negative control — synthetic site with thin pages and no dated
// content at all (entirely fabricated, deliberately the bad case).
// ---------------------------------------------------------------------------
async function mockFetcherBadSite(url) {
  if (url === 'https://badsite.example.com/') {
    return { ok: true, status: 200, text: async () => '<html><body>Home page. We do stuff.</body></html>' }
  }
  if (url === 'https://badsite.example.com/sitemap.xml') {
    return { ok: false, status: 404 }
  }
  if (url === 'https://badsite.example.com/blog/') {
    return { ok: false, status: 404 }
  }
  return { ok: false, status: 404 }
}

async function main() {
  const now = new Date('2026-08-07T00:00:00Z')

  console.log('='.repeat(70))
  console.log('CASE 1: Denver Tax Advisor — real captured content + real dates')
  console.log('='.repeat(70))
  const r1 = await checkContentAuthority('https://denvertaxadvisor.com/', {
    fetcher: mockFetcherDenverTaxAdvisor,
    samplePages: [
      'https://denvertaxadvisor.com/',
      'https://denvertaxadvisor.com/services/denver-tax-preparation/',
      'https://denvertaxadvisor.com/tax-resources/'
    ],
    now
  })
  console.log(JSON.stringify(r1, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log('CASE 2: Negative control — thin, undated synthetic site')
  console.log('='.repeat(70))
  const r2 = await checkContentAuthority('https://badsite.example.com/', {
    fetcher: mockFetcherBadSite,
    samplePages: ['https://badsite.example.com/'],
    now
  })
  console.log(JSON.stringify(r2, null, 2))
}

main()
