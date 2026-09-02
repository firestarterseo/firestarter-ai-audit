// Pure tests for lib/schemaPagePriority.js -- plain Node, no network, no
// mocked fetcher (this module has zero dependencies, same discipline as
// lib/sitemapDiscovery.js). Run with: node lib/schemaPagePriority.test.js
//
// Covers the prioritization/client-intelligence/recommended-set fixtures
// from Phase A's spec ("10. TESTS"): utility/legal -> Low Priority; primary
// service match; secondary service match; geography match; false-positive
// service match does not occur; a large first-sitemap category never
// crowding out core/commercial pages from the RECOMMENDED set (the
// discovery-side half of this same fixture lives in
// lib/sitemapDiscovery.test.js); recommendation order deterministic; random
// content does not crowd out core/commercial pages; fewer than 10
// legitimate recommendations does not pad.

const assert = require('assert')
const { tierForType, matchClientIntelligence, buildPageDossier, computeRecommendedSet } = require('./schemaPagePriority')

function log(msg) { console.log(msg) }

// page(overrides) -- a minimal, already-classified candidate page, as
// lib/sitemapDiscovery.js#fetchSitemapPages would produce it.
function page(overrides) {
  return {
    path: '/',
    sourceSitemap: null,
    type: 'Other',
    classificationSource: 'none',
    classificationConfidence: 'low',
    classificationReason: 'test fixture',
    ...overrides
  }
}

function run() {
  // 1. Utility/Legal URL classification tiers to LOW_PRIORITY.
  {
    assert.strictEqual(tierForType('Utility/Legal'), 'LOW_PRIORITY')
    const dossier = buildPageDossier(page({ path: '/privacy-policy/', type: 'Utility/Legal', classificationSource: 'url_pattern', classificationConfidence: 'high' }))
    assert.strictEqual(dossier.tier, 'LOW_PRIORITY')
    log('TEST 1 (a Utility/Legal page always tiers to LOW_PRIORITY) PASSED')
  }

  // 2. Confirmed PRIMARY service match -- a page whose path contains every
  // token of a confirmed primary service produces a "Likely matches primary
  // service" reason, phrased as likely, never as confirmed identity.
  {
    const denverSeoPage = page({ path: '/services/denver-seo/', type: 'Service', classificationSource: 'url_pattern', classificationConfidence: 'high' })
    const clientProfile = { primaryServices: ['Denver SEO'], secondaryServices: [], geographies: [] }
    const reasons = matchClientIntelligence(denverSeoPage, clientProfile)
    assert.strictEqual(reasons.length, 1)
    assert.strictEqual(reasons[0].matchType, 'primary_service')
    assert.strictEqual(reasons[0].confidence, 'likely')
    assert.strictEqual(reasons[0].text, 'Likely matches primary service: Denver SEO')
    assert.ok(!/confirmed/i.test(reasons[0].text), 'a slug match must never be phrased as "confirmed" page identity')
    log('TEST 2 (a page path matching every token of a confirmed PRIMARY service produces a correctly-phrased "Likely matches primary service" reason) PASSED')
  }

  // 3. Confirmed SECONDARY service match.
  {
    const webDesignPage = page({ path: '/services/web-design/', type: 'Service', classificationSource: 'url_pattern', classificationConfidence: 'high' })
    const clientProfile = { primaryServices: [], secondaryServices: ['Web Design'], geographies: [] }
    const reasons = matchClientIntelligence(webDesignPage, clientProfile)
    assert.strictEqual(reasons.length, 1)
    assert.strictEqual(reasons[0].matchType, 'secondary_service')
    assert.strictEqual(reasons[0].text, 'Likely matches secondary service: Web Design')
    log('TEST 3 (a page path matching every token of a confirmed SECONDARY service produces a correctly-phrased reason) PASSED')
  }

  // 4. Confirmed GEOGRAPHY match.
  {
    const denverLocationPage = page({ path: '/locations/denver/', type: 'Location', classificationSource: 'url_pattern', classificationConfidence: 'high' })
    const clientProfile = { primaryServices: [], secondaryServices: [], geographies: ['Denver, CO'] }
    const reasons = matchClientIntelligence(denverLocationPage, clientProfile)
    assert.strictEqual(reasons.length, 1)
    assert.strictEqual(reasons[0].matchType, 'geography')
    assert.strictEqual(reasons[0].text, 'Likely matches primary geography: Denver, CO')
    log('TEST 4 (a page path matching a confirmed primary geography produces a correctly-phrased reason) PASSED')
  }

  // 5. FALSE-POSITIVE GUARD -- a confirmed service does NOT match a page
  // that merely shares one generic or substring-overlapping token with it.
  // These are the exact scenarios reasoned through during design: "Denver
  // SEO" must not match a Denver page that isn't about SEO, and "Web
  // Design" must not match on the "web" substring inside "webinar".
  {
    const clientProfile = { primaryServices: ['Denver SEO'], secondaryServices: ['Web Design'], geographies: [] }

    const denverEventsPage = page({ path: '/denver-events-calendar/', type: 'Other' })
    const denverEventsReasons = matchClientIntelligence(denverEventsPage, clientProfile)
    assert.strictEqual(denverEventsReasons.length, 0, '"Denver SEO" must not match a Denver page with no "seo" token')

    const webinarPage = page({ path: '/webinar-design-tips/', type: 'Article' })
    const webinarReasons = matchClientIntelligence(webinarPage, clientProfile)
    assert.strictEqual(webinarReasons.length, 0, '"Web Design" must never substring-match "webinar"')

    // A single-word confirmed value has nothing more specific to require,
    // so it CAN legitimately match a page that contains just that word --
    // this is expected, documented behavior (see schemaPagePriority.js),
    // not a false positive: the guard is against PARTIAL phrase matches,
    // not against short confirmed values.
    const clientProfileSingleWord = { primaryServices: [], secondaryServices: [], geographies: ['Denver'] }
    const denverEventsGeoReasons = matchClientIntelligence(denverEventsPage, clientProfileSingleWord)
    assert.strictEqual(denverEventsGeoReasons.length, 1, 'a single-token confirmed geography legitimately matches any page containing that token')

    // A confirmed value that tokenizes to nothing (e.g. only stopwords) can
    // never match anything -- there is nothing distinctive to require.
    const clientProfileEmptyPhrase = { primaryServices: ['Services'], secondaryServices: [], geographies: [] }
    const anyPage = page({ path: '/services/anything/', type: 'Service' })
    assert.strictEqual(matchClientIntelligence(anyPage, clientProfileEmptyPhrase).length, 0, 'a confirmed value that tokenizes to nothing must never match')

    log('TEST 5 (false-positive guard: a multi-token confirmed service never matches on a shared generic token or a substring overlap, while a genuinely single-token confirmed value can still legitimately match) PASSED')
  }

  // 6. RECOMMENDATION ORDER IS DETERMINISTIC -- running computeRecommendedSet
  // twice on the same (even randomly-ordered) input produces identical
  // output, and the order follows tier rank, then client-intelligence match,
  // then alphabetical path -- never insertion/discovery order.
  {
    const pages = [
      page({ path: '/blog/random-post/', type: 'Article' }),
      page({ path: '/services/seo/', type: 'Service' }),
      page({ path: '/', type: 'Home' }),
      page({ path: '/case-studies/acme/', type: 'Case Study' }),
      page({ path: '/about/', type: 'About' })
    ]
    const clientProfile = { primaryServices: ['SEO'], secondaryServices: [], geographies: [] }
    const result1 = computeRecommendedSet(pages, clientProfile)
    const result2 = computeRecommendedSet([...pages].reverse(), clientProfile)
    assert.deepStrictEqual(result1.recommended.map(d => d.path), result2.recommended.map(d => d.path), 'input order must never affect recommendation order')

    const tierOrder = { CORE: 0, COMMERCIAL: 1, PROOF: 2, CONTENT: 3, LOW_PRIORITY: 4, OTHER: 5 }
    const ranks = result1.recommended.map(d => tierOrder[d.tier])
    for (let i = 1; i < ranks.length; i++) {
      assert.ok(ranks[i] >= ranks[i - 1], 'recommended pages must be in non-decreasing tier-rank order')
    }
    log('TEST 6 (recommendation order is fully deterministic across differently-ordered input, and follows tier rank -- never sitemap/discovery order) PASSED')
  }

  // 7. RANDOM CONTENT DOES NOT CROWD OUT CORE/COMMERCIAL -- this is the
  // recommendation-side half of the discovery-order bug regression (see
  // lib/sitemapDiscovery.test.js TEST 11 for the discovery-side half): even
  // when a huge number of generic Article pages are discovered, every CORE
  // and COMMERCIAL page is still recommended, and generic articles with no
  // client-intelligence match never appear ahead of them or push them out
  // of the targetMax cap.
  {
    const manyRandomArticles = Array.from({ length: 30 }, (_, i) => page({ path: `/blog/random-post-${i}/`, type: 'Article' }))
    const corePages = [
      page({ path: '/', type: 'Home' }),
      page({ path: '/about/', type: 'About' }),
      page({ path: '/contact/', type: 'Contact' }),
      page({ path: '/services/seo/', type: 'Service' }),
      page({ path: '/services/ppc/', type: 'Service' })
    ]
    const result = computeRecommendedSet([...manyRandomArticles, ...corePages], {})
    for (const core of corePages) {
      assert.ok(result.recommended.some(d => d.path === core.path), `${core.path} must always be recommended regardless of how many unrelated articles exist`)
    }
    // None of the 30 generic (no client-intelligence match) articles made it
    // in -- they have no real reason to surface, and must never pad the set.
    const recommendedArticlePaths = result.recommended.filter(d => d.type === 'Article').map(d => d.path)
    assert.strictEqual(recommendedArticlePaths.length, 0, 'generic articles with no client-intelligence match must never be recommended just to fill the list')
    log('TEST 7 (a large number of unrelated Article pages never crowds out CORE/COMMERCIAL pages from the recommended set, and is never used to pad it) PASSED')
  }

  // 8. FEWER THAN targetMin LEGITIMATE RECOMMENDATIONS DOES NOT PAD -- a
  // small site with only 3 real CORE/COMMERCIAL/PROOF pages and a pile of
  // unrelated Article/Utility-Legal pages recommends exactly those 3, never
  // padded up toward targetMin with illegitimate picks.
  {
    const pages = [
      page({ path: '/', type: 'Home' }),
      page({ path: '/about/', type: 'About' }),
      page({ path: '/services/seo/', type: 'Service' }),
      page({ path: '/privacy-policy/', type: 'Utility/Legal' }),
      page({ path: '/terms/', type: 'Utility/Legal' }),
      ...Array.from({ length: 8 }, (_, i) => page({ path: `/blog/post-${i}/`, type: 'Article' }))
    ]
    const result = computeRecommendedSet(pages, {}, { targetMin: 10, targetMax: 15 })
    assert.strictEqual(result.recommended.length, 3, 'fewer than targetMin legitimate recommendations is a valid, expected outcome -- never padded')
    assert.deepStrictEqual(result.recommended.map(d => d.path).sort(), ['/', '/about/', '/services/seo/'].sort())
    log('TEST 8 (a small site with fewer than targetMin legitimate recommendations returns exactly those, never padded with Utility/Legal or unrelated Article pages to reach the target) PASSED')
  }

  // 9. targetMax is still honored as an upper bound when there ARE enough
  // eligible (CORE/COMMERCIAL/PROOF, or CONTENT-with-a-match) pages.
  {
    const manyServices = Array.from({ length: 20 }, (_, i) => page({ path: `/services/service-${i}/`, type: 'Service' }))
    const result = computeRecommendedSet(manyServices, {}, { targetMin: 10, targetMax: 15 })
    assert.strictEqual(result.recommended.length, 15)
    log('TEST 9 (when enough eligible pages exist, the recommended set is capped at targetMax) PASSED')
  }

  // 10. 'Product' and 'Landing Page' (added 2026-09-02 alongside the
  // sitemap-provenance classification fix in lib/sitemapDiscovery.js) tier
  // to COMMERCIAL, same as Service/Location -- both are commercially-
  // oriented page types.
  {
    assert.strictEqual(tierForType('Product'), 'COMMERCIAL')
    assert.strictEqual(tierForType('Landing Page'), 'COMMERCIAL')
    const productDossier = buildPageDossier(page({ path: '/products/widget/', type: 'Product', classificationSource: 'sitemap_name', classificationConfidence: 'high' }))
    assert.strictEqual(productDossier.tier, 'COMMERCIAL')
    assert.strictEqual(productDossier.reasons[0].text, 'Commercial product page')
    const landingDossier = buildPageDossier(page({ path: '/spring-promo/', type: 'Landing Page', classificationSource: 'sitemap_name', classificationConfidence: 'medium' }))
    assert.strictEqual(landingDossier.tier, 'COMMERCIAL')
    assert.strictEqual(landingDossier.reasons[0].text, 'Commercial landing page')
    log('TEST 10 (the new Product and Landing Page types both tier to COMMERCIAL, same as Service/Location, with correctly-phrased base reasons) PASSED')
  }

  // 11. RECOMMENDED BATCH MAX = 10, and a page passed in `excludePaths`
  // (PRODUCT DECISIONS #2/#3/#11 -- 2026-09-02 Schema recommendation/queue
  // workflow correction) is skipped entirely, never occupying a batch slot.
  {
    const manyServices = Array.from({ length: 15 }, (_, i) => page({ path: `/services/service-${i}/`, type: 'Service' }))
    const excludePaths = new Set(['/services/service-0/', '/services/service-1/'])
    const result = computeRecommendedSet(manyServices, {}, { targetMin: 10, targetMax: 10, excludePaths })
    assert.strictEqual(result.recommended.length, 10, 'a batch is capped at exactly 10 when targetMax is 10')
    assert.ok(!result.recommended.some(d => excludePaths.has(d.path)), 'an excluded (resolved) page must never occupy a recommendation-batch slot')
    // The excluded pages are NOT removed from `all` -- the full universe
    // stays available for the "view all discovered pages" secondary view
    // (PRODUCT DECISION #1).
    assert.ok(result.all.some(d => d.path === '/services/service-0/'), 'excludePaths must not remove a page from the full `all` universe')
    log('TEST 11 (a recommendation batch is capped at exactly 10, and excludePaths pages never occupy a batch slot even though they remain in the full discovered universe) PASSED')
  }

  // 12. NEXT BEST 10, NOT TOP 10 FOREVER -- once enough pages move into
  // excludePaths (simulating them being marked NO_ACTION_NEEDED/COMPLETED
  // after review), the next call with the same deterministic input
  // naturally admits the next-best still-eligible pages into the same
  // 10-slot batch -- no separate "batch index" is needed.
  {
    const pages = Array.from({ length: 20 }, (_, i) => page({ path: `/services/service-${String(i).padStart(2, '0')}/`, type: 'Service' }))
    const batch1 = computeRecommendedSet(pages, {}, { targetMin: 10, targetMax: 10 })
    assert.strictEqual(batch1.recommended.length, 10)
    const batch1Paths = new Set(batch1.recommended.map(d => d.path))

    // Simulate every batch-1 page being resolved (AM reviewed them all).
    const batch2 = computeRecommendedSet(pages, {}, { targetMin: 10, targetMax: 10, excludePaths: batch1Paths })
    assert.strictEqual(batch2.recommended.length, 10, 'the next 10 eligible pages must fill the batch once the prior 10 are resolved')
    const batch2Paths = new Set(batch2.recommended.map(d => d.path))
    for (const p of batch1Paths) {
      assert.ok(!batch2Paths.has(p), 'a resolved page from the previous batch must never reappear in the next batch')
    }
    log('TEST 12 (once a batch\'s pages are excluded/resolved, the next call surfaces the next-best 10 -- NEXT BEST 10, not TOP 10 FOREVER, with no separate batch-index state) PASSED')
  }

  // 13. A page in a resolved state that would otherwise rank #1 (e.g. the
  // homepage, CORE tier) is skipped, and the next-highest-ranked eligible
  // page takes the recommendation slot instead -- this is the exact live
  // bug fix: homepage 7/7 -> excluded, next real page recommended.
  {
    const pages = [
      page({ path: '/', type: 'Home' }),
      page({ path: '/services/seo/', type: 'Service' })
    ]
    const excludePaths = new Set(['/']) // homepage marked NO_ACTION_NEEDED
    const result = computeRecommendedSet(pages, {}, { targetMin: 10, targetMax: 10, excludePaths })
    assert.deepStrictEqual(result.recommended.map(d => d.path), ['/services/seo/'], 'a completed/passing homepage must never be recommended, and the next eligible page must take its place')
    log('TEST 13 (a completed/passing homepage is excluded from recommendations and the next eligible page is recommended in its place -- the exact live bug this phase fixes) PASSED')
  }

  console.log('\nAll lib/schemaPagePriority.js pure tests passed.')
}

run()
