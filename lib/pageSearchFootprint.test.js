// Pure tests for lib/pageSearchFootprint.js -- plain Node, no network, no
// Supabase, no LLM, no mocked fetcher (this module has exactly one
// dependency, lib/urlIdentity.js, itself pure/zero-dependency). Run with:
//   node lib/pageSearchFootprint.test.js
//
// Page Leverage Intelligence Audit follow-up (2026-09-02): "Page Search
// Footprint Primitive" -- joins Ahrefs organic-keyword ranking evidence
// (now carrying a per-row `rankingUrl`, see lib/checkers/ahrefs.js) to
// already-discovered sitemap pages (lib/sitemapDiscovery.js's output
// shape), conservatively, via lib/urlIdentity.js. These tests exercise the
// 20 fixtures named in that phase's spec, plus a few extra edge cases the
// real join logic surfaced during implementation.

const assert = require('assert')
const { buildPageSearchFootprint, classifyPositionBand, UNMATCHED_REASONS } = require('./pageSearchFootprint')

function log(msg) { console.log(msg) }

// sitemapPage(overrides) -- a minimal already-discovered sitemap page, as
// lib/sitemapDiscovery.js#fetchSitemapPages would produce it. Only
// `.path`/`.url` are read by this module; other real fields (type,
// sourceSitemap, etc.) are irrelevant here and omitted.
function sitemapPage(path, url, overrides = {}) {
  return { path, url, type: 'Other', ...overrides }
}

// keywordRow(overrides) -- a minimal already-fetched Ahrefs organic-keyword
// row, as lib/checkers/ahrefs.js#getOrganicKeywords now returns it.
function keywordRow(overrides = {}) {
  return { keyword: 'test keyword', volume: 100, position: 5, rankingUrl: null, branded: false, local: false, ...overrides }
}

function findPage(result, path) {
  return result.pages.find(p => p.path === path)
}

function run() {
  // 1. Exact sitemap URL <-> Ahrefs URL match.
  {
    const sitemapPages = [sitemapPage('/services/seo/', 'https://example.com/services/seo/')]
    const organicKeywordRows = [keywordRow({ keyword: 'denver seo', rankingUrl: 'https://example.com/services/seo/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    const page = findPage(result, '/services/seo/')
    assert.strictEqual(page.hasObservedRankings, true)
    assert.strictEqual(page.keywordCount, 1)
    assert.strictEqual(page.rankingObservations[0].keyword, 'denver seo')
    assert.strictEqual(result.unmatchedRankingEvidence.length, 0)
    log('TEST 1 (an exact sitemap URL <-> Ahrefs ranking URL match attaches the observation to the correct page) PASSED')
  }

  // 2. www normalization -- a ranking URL with a leading www. matches a
  // sitemap page without one (and vice versa), since lib/urlIdentity.js
  // strips www. from both sides before comparing.
  {
    const sitemapPages = [sitemapPage('/about/', 'https://example.com/about/')]
    const organicKeywordRows = [keywordRow({ keyword: 'about us', rankingUrl: 'https://www.example.com/about/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(findPage(result, '/about/').hasObservedRankings, true)
    log('TEST 2 (www vs non-www normalizes to the same identity and matches) PASSED')
  }

  // 3. Trailing-slash normalization.
  {
    const sitemapPages = [sitemapPage('/contact', 'https://example.com/contact')]
    const organicKeywordRows = [keywordRow({ keyword: 'contact us', rankingUrl: 'https://example.com/contact/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(findPage(result, '/contact').hasObservedRankings, true)
    log('TEST 3 (a trivial trailing-slash difference normalizes to the same identity and matches) PASSED')
  }

  // 4. Tracking-parameter normalization -- a ranking URL carrying a known
  // tracking param (utm_source) still matches a sitemap page without one.
  {
    const sitemapPages = [sitemapPage('/pricing/', 'https://example.com/pricing/')]
    const organicKeywordRows = [keywordRow({ keyword: 'pricing', rankingUrl: 'https://example.com/pricing/?utm_source=newsletter' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(findPage(result, '/pricing/').hasObservedRankings, true)
    log('TEST 4 (a known tracking query parameter is stripped by lib/urlIdentity.js and the URLs still match) PASSED')
  }

  // 5. http vs https remains distinct -- lib/urlIdentity.js deliberately
  // never collapses protocol, so this must NOT match, and must be
  // preserved as unmatched with the specific protocol-mismatch reason
  // (never silently guessed as the same page).
  {
    const sitemapPages = [sitemapPage('/services/', 'https://example.com/services/')]
    const organicKeywordRows = [keywordRow({ keyword: 'services', rankingUrl: 'http://example.com/services/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(findPage(result, '/services/').hasObservedRankings, false)
    assert.strictEqual(result.unmatchedRankingEvidence.length, 1)
    assert.strictEqual(result.unmatchedRankingEvidence[0].reason, UNMATCHED_REASONS.PROTOCOL_MISMATCH_WITH_SITEMAP_PAGE)
    log('TEST 5 (http vs https stays distinct per lib/urlIdentity.js -- never matched, preserved as unmatched with an honest protocol-mismatch reason, not a generic one) PASSED')
  }

  // 6. A meaningful (non-tracking) query parameter keeps two URLs distinct.
  {
    const sitemapPages = [sitemapPage('/products/', 'https://example.com/products/?id=5')]
    const organicKeywordRows = [keywordRow({ keyword: 'widget', rankingUrl: 'https://example.com/products/?id=6' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(findPage(result, '/products/').hasObservedRankings, false)
    assert.strictEqual(result.unmatchedRankingEvidence.length, 1)
    assert.strictEqual(result.unmatchedRankingEvidence[0].reason, UNMATCHED_REASONS.NOT_IN_SITEMAP)
    log('TEST 6 (a meaningful, non-tracking query parameter is never stripped -- two URLs differing only in it stay distinct and unmatched) PASSED')
  }

  // 7. Malformed ranking URL is preserved as unmatched, never thrown or dropped.
  {
    const sitemapPages = [sitemapPage('/', 'https://example.com/')]
    const organicKeywordRows = [keywordRow({ keyword: 'garbled', rankingUrl: 'not a url at all' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(result.unmatchedRankingEvidence.length, 1)
    assert.strictEqual(result.unmatchedRankingEvidence[0].reason, UNMATCHED_REASONS.MALFORMED_RANKING_URL)
    assert.strictEqual(result.unmatchedRankingEvidence[0].rankingUrl, 'not a url at all', 'the raw malformed value must be preserved verbatim, not discarded')
    log('TEST 7 (a malformed ranking URL never throws -- it is preserved as unmatched evidence with its raw value intact) PASSED')
  }

  // 8. A ranking URL not present in the sitemap at all is preserved as unmatched.
  {
    const sitemapPages = [sitemapPage('/', 'https://example.com/')]
    const organicKeywordRows = [keywordRow({ keyword: 'orphan page term', rankingUrl: 'https://example.com/deleted-page/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(result.unmatchedRankingEvidence.length, 1)
    assert.strictEqual(result.unmatchedRankingEvidence[0].reason, UNMATCHED_REASONS.NOT_IN_SITEMAP)
    log('TEST 8 (a ranking URL that is not among the discovered sitemap pages is preserved as unmatched, not dropped) PASSED')
  }

  // 9. Multiple keywords ranking to the same page all attach to it.
  {
    const sitemapPages = [sitemapPage('/services/seo/', 'https://example.com/services/seo/')]
    const organicKeywordRows = [
      keywordRow({ keyword: 'denver seo', position: 3, rankingUrl: 'https://example.com/services/seo/' }),
      keywordRow({ keyword: 'seo agency denver', position: 7, rankingUrl: 'https://example.com/services/seo/' }),
      keywordRow({ keyword: 'best seo company', position: 12, rankingUrl: 'https://example.com/services/seo/' })
    ]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    const page = findPage(result, '/services/seo/')
    assert.strictEqual(page.keywordCount, 3)
    assert.strictEqual(page.strongestPosition, 3)
    log('TEST 9 (multiple keywords ranking to the same page all attach to that one page, with the strongest position correctly identified) PASSED')
  }

  // 10. Same keyword text ranking to different pages stays separate --
  // never merged by keyword string.
  {
    const sitemapPages = [
      sitemapPage('/services/seo/', 'https://example.com/services/seo/'),
      sitemapPage('/locations/denver/', 'https://example.com/locations/denver/')
    ]
    const organicKeywordRows = [
      keywordRow({ keyword: 'denver seo', position: 4, rankingUrl: 'https://example.com/services/seo/' }),
      keywordRow({ keyword: 'denver seo', position: 9, rankingUrl: 'https://example.com/locations/denver/' })
    ]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(findPage(result, '/services/seo/').keywordCount, 1)
    assert.strictEqual(findPage(result, '/locations/denver/').keywordCount, 1)
    assert.strictEqual(findPage(result, '/services/seo/').rankingObservations[0].position, 4)
    assert.strictEqual(findPage(result, '/locations/denver/').rankingObservations[0].position, 9)
    log('TEST 10 (the same keyword text ranking to two different pages is never merged -- each page keeps its own independent observation) PASSED')
  }

  // 11. Position-band classification -- deterministic, categorical bands.
  {
    assert.strictEqual(classifyPositionBand(1), 'TOP_3')
    assert.strictEqual(classifyPositionBand(3), 'TOP_3')
    assert.strictEqual(classifyPositionBand(4), 'POSITIONS_4_10')
    assert.strictEqual(classifyPositionBand(10), 'POSITIONS_4_10')
    assert.strictEqual(classifyPositionBand(11), 'POSITIONS_11_20')
    assert.strictEqual(classifyPositionBand(20), 'POSITIONS_11_20')
    assert.strictEqual(classifyPositionBand(21), 'POSITIONS_21_PLUS')
    assert.strictEqual(classifyPositionBand(150), 'POSITIONS_21_PLUS')
    assert.strictEqual(classifyPositionBand(null), 'POSITION_DATA_UNAVAILABLE')

    const sitemapPages = [sitemapPage('/services/seo/', 'https://example.com/services/seo/')]
    const organicKeywordRows = [keywordRow({ keyword: 'denver seo', position: 2, rankingUrl: 'https://example.com/services/seo/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(findPage(result, '/services/seo/').positionBand, 'TOP_3')
    log('TEST 11 (position values classify into the correct deterministic band, both standalone and on a real page result) PASSED')
  }

  // 12. No observed rankings -- a discovered sitemap page with zero
  // matching keyword rows still appears, honestly, with an explicit
  // no-ranking-data state (never omitted, never a fabricated zero score).
  {
    const sitemapPages = [sitemapPage('/blog/unrelated-post/', 'https://example.com/blog/unrelated-post/')]
    const organicKeywordRows = []
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    const page = findPage(result, '/blog/unrelated-post/')
    assert.strictEqual(page.hasObservedRankings, false)
    assert.strictEqual(page.keywordCount, 0)
    assert.deepStrictEqual(page.rankingObservations, [])
    assert.strictEqual(page.strongestPosition, null)
    assert.strictEqual(page.positionBand, 'NO_OBSERVED_RANKINGS')
    assert.deepStrictEqual(page.observedVolume, { totalVolume: null, keywordsWithVolumeDataCount: 0 })
    log('TEST 12 (a page with zero observed rankings is reported honestly, not omitted or scored as zero) PASSED')
  }

  // 13. Raw keyword evidence is preserved -- every requested field survives
  // intact on a matched observation.
  {
    const sitemapPages = [sitemapPage('/services/seo/', 'https://example.com/services/seo/')]
    const organicKeywordRows = [keywordRow({ keyword: 'denver seo', volume: 480, position: 3, branded: false, local: true, rankingUrl: 'https://example.com/services/seo/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    const observation = findPage(result, '/services/seo/').rankingObservations[0]
    assert.deepStrictEqual(observation, { keyword: 'denver seo', volume: 480, position: 3, branded: false, local: true, rankingUrl: 'https://example.com/services/seo/' })
    log('TEST 13 (every raw Ahrefs evidence field -- keyword, volume, position, branded, local, rankingUrl -- is preserved verbatim on a matched observation) PASSED')
  }

  // 14. No composite score exists anywhere in the output shape.
  {
    const sitemapPages = [sitemapPage('/services/seo/', 'https://example.com/services/seo/')]
    const organicKeywordRows = [keywordRow({ keyword: 'denver seo', rankingUrl: 'https://example.com/services/seo/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    const page = findPage(result, '/services/seo/')
    const forbiddenKeys = ['score', 'opportunity', 'priority', 'rank', 'value', 'grade']
    for (const key of forbiddenKeys) {
      assert.ok(!(key in page), `page output must never contain a "${key}" field -- this file describes evidence, not a verdict`)
    }
    log('TEST 14 (no composite score, opportunity label, priority, or grade field exists anywhere in a page\'s output) PASSED')
  }

  // 15. No business-relevance inference -- this module never reads or
  // reasons about client-profile/service/geography data at all (it isn't
  // even passed any), confirmed by checking its own exported surface and
  // that a page's output carries no such field.
  {
    const sitemapPages = [sitemapPage('/local-seo/', 'https://example.com/local-seo/')]
    const organicKeywordRows = [keywordRow({ keyword: 'local seo', rankingUrl: 'https://example.com/local-seo/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    const page = findPage(result, '/local-seo/')
    assert.ok(!('businessRelevance' in page) && !('matchesService' in page) && !('clientIntelligence' in page))
    log('TEST 15 (search-footprint output never contains a business-relevance / client-intelligence field -- that stays a separate, later concern) PASSED')
  }

  // 16. No topic-cluster inference -- same discipline, no such field, and
  // the function signature itself takes no topic-cluster input.
  {
    const sitemapPages = [sitemapPage('/local-seo/', 'https://example.com/local-seo/')]
    const organicKeywordRows = [keywordRow({ keyword: 'local seo', rankingUrl: 'https://example.com/local-seo/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows, topicClusters: [{ name: 'should be ignored' }] })
    const page = findPage(result, '/local-seo/')
    assert.ok(!('topicCluster' in page) && !('benchmarkTopic' in page), 'a topicClusters-shaped argument, even if passed, must be silently ignored -- this module has no topic-relationship concept at all')
    log('TEST 16 (search-footprint output never contains a topic-cluster field, and even a topic-cluster-shaped stray argument is ignored, not accidentally used) PASSED')
  }

  // 17. No network call from the pure module -- static source-text check,
  // same technique already established by lib/entityBrandAuthorityTargets.test.js.
  {
    const fs = require('fs')
    const source = fs.readFileSync(require.resolve('./pageSearchFootprint.js'), 'utf8')
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/\bfetch\s*\(/.test(codeOnly), 'pageSearchFootprint.js must never call fetch()')
    assert.ok(!/XMLHttpRequest|axios|node-fetch|http\.request|https\.request/.test(codeOnly), 'pageSearchFootprint.js must never use any other network primitive')
    log('TEST 17 (static source check: no fetch() or any other network call exists anywhere in pageSearchFootprint.js) PASSED')
  }

  // 18. No Supabase dependency -- same static check technique.
  {
    const fs = require('fs')
    const source = fs.readFileSync(require.resolve('./pageSearchFootprint.js'), 'utf8')
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/supabase/i.test(codeOnly), 'pageSearchFootprint.js must never reference Supabase')
    const requireMatches = [...codeOnly.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1])
    assert.deepStrictEqual(requireMatches, ['./urlIdentity'], 'pageSearchFootprint.js must have exactly one require -- lib/urlIdentity.js -- and nothing else')
    log('TEST 18 (static source check: no Supabase reference anywhere, and the only require() in the whole file is lib/urlIdentity.js) PASSED')
  }

  // 19. Deterministic output independent of input row order -- the same
  // set of keyword rows, supplied in a different order, must produce an
  // identical rankingObservations list for the affected page.
  {
    const sitemapPages = [sitemapPage('/services/seo/', 'https://example.com/services/seo/')]
    const rowsA = [
      keywordRow({ keyword: 'seo agency denver', position: 7, rankingUrl: 'https://example.com/services/seo/' }),
      keywordRow({ keyword: 'denver seo', position: 3, rankingUrl: 'https://example.com/services/seo/' }),
      keywordRow({ keyword: 'best seo company', position: 3, rankingUrl: 'https://example.com/services/seo/' })
    ]
    const rowsB = [...rowsA].reverse()
    const resultA = buildPageSearchFootprint({ sitemapPages, organicKeywordRows: rowsA })
    const resultB = buildPageSearchFootprint({ sitemapPages, organicKeywordRows: rowsB })
    assert.deepStrictEqual(findPage(resultA, '/services/seo/').rankingObservations, findPage(resultB, '/services/seo/').rankingObservations)
    log('TEST 19 (the same keyword rows supplied in a different order produce an identical, deterministically-sorted rankingObservations list) PASSED')
  }

  // 20. A sitemap page with no Ahrefs evidence at all remains present in
  // `pages`, honestly reporting no-observed-ranking state (duplicates the
  // intent of TEST 12 with a full-audit-shaped input, including OTHER pages
  // that DO have evidence, to confirm no page is ever silently dropped from
  // the output just because it has nothing to report).
  {
    const sitemapPages = [
      sitemapPage('/', 'https://example.com/'),
      sitemapPage('/services/seo/', 'https://example.com/services/seo/'),
      sitemapPage('/blog/some-post/', 'https://example.com/blog/some-post/')
    ]
    const organicKeywordRows = [keywordRow({ keyword: 'denver seo', rankingUrl: 'https://example.com/services/seo/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(result.pages.length, 3, 'every discovered sitemap page must appear in the output, regardless of whether it has ranking evidence')
    assert.strictEqual(findPage(result, '/').hasObservedRankings, false)
    assert.strictEqual(findPage(result, '/blog/some-post/').hasObservedRankings, false)
    assert.strictEqual(findPage(result, '/services/seo/').hasObservedRankings, true)
    log('TEST 20 (pages with no Ahrefs evidence are never dropped from the output, even when other pages in the same result do have evidence) PASSED')
  }

  // 21. AMBIGUOUS identity -- two distinct sitemap pages that normalize to
  // the same identity key (a caller/input-data problem this file must never
  // silently resolve by guessing). Neither page receives the observation;
  // it is preserved as unmatched with an explicit ambiguous reason.
  {
    const sitemapPages = [
      sitemapPage('/service/', 'https://example.com/service/', { note: 'first' }),
      sitemapPage('/service', 'https://example.com/service', { note: 'second-but-same-identity-after-trailing-slash-normalization' })
    ]
    const organicKeywordRows = [keywordRow({ keyword: 'ambiguous target', rankingUrl: 'https://example.com/service/' })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(result.unmatchedRankingEvidence.length, 1)
    assert.strictEqual(result.unmatchedRankingEvidence[0].reason, UNMATCHED_REASONS.AMBIGUOUS_SITEMAP_IDENTITY)
    assert.strictEqual(findPage(result, '/service/').hasObservedRankings, false)
    assert.strictEqual(findPage(result, '/service').hasObservedRankings, false)
    log('TEST 21 (two distinct sitemap page entries that collide to the same normalized identity are never guessed between -- the ranking observation is preserved as unmatched/ambiguous, and neither colliding page receives it) PASSED')
  }

  // 22. No ranking URL returned at all by Ahrefs for a given keyword row --
  // a real, expected case (not every keyword row necessarily carries
  // best_position_url) -- preserved as unmatched with its own honest reason,
  // never conflated with a malformed or absent-from-sitemap URL.
  {
    const sitemapPages = [sitemapPage('/', 'https://example.com/')]
    const organicKeywordRows = [keywordRow({ keyword: 'no url keyword', rankingUrl: null })]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    assert.strictEqual(result.unmatchedRankingEvidence.length, 1)
    assert.strictEqual(result.unmatchedRankingEvidence[0].reason, UNMATCHED_REASONS.NO_RANKING_URL_RETURNED)
    log('TEST 22 (a keyword row with no rankingUrl at all from Ahrefs is preserved as unmatched with its own specific, honest reason) PASSED')
  }

  // 23. Volume context is descriptive and honest -- summed only across
  // observations that actually carry volume data, with the count of how
  // many did, never inflating or assuming a value for missing data.
  {
    const sitemapPages = [sitemapPage('/services/seo/', 'https://example.com/services/seo/')]
    const organicKeywordRows = [
      keywordRow({ keyword: 'a', volume: 100, rankingUrl: 'https://example.com/services/seo/' }),
      keywordRow({ keyword: 'b', volume: null, rankingUrl: 'https://example.com/services/seo/' }),
      keywordRow({ keyword: 'c', volume: 50, rankingUrl: 'https://example.com/services/seo/' })
    ]
    const result = buildPageSearchFootprint({ sitemapPages, organicKeywordRows })
    const page = findPage(result, '/services/seo/')
    assert.deepStrictEqual(page.observedVolume, { totalVolume: 150, keywordsWithVolumeDataCount: 2 })
    log('TEST 23 (observed volume is summed only across observations that actually carry volume data, with an honest count of how many did) PASSED')
  }

  console.log('\nAll lib/pageSearchFootprint.js pure tests passed (no network calls, no Supabase, no LLM).')
}

run()
