// Pure tests for lib/schemaLiveVerification.js -- plain Node, no network
// (fixed HTML fixtures stand in for a real fetchWebPage() result). Run
// with: node lib/schemaLiveVerification.test.js
//
// Covers Phase 7 test-matrix items L (live verification success) and M
// (expected node absent -- verification failed).

const assert = require('assert')
const { verifyDeployedSchema, verifyApprovedSchemaLive } = require('./schemaLiveVerification')

function log(msg) { console.log(msg) }

const DEPLOYED_ABOUT = {
  '@context': 'https://schema.org',
  '@type': 'AboutPage',
  '@id': 'https://www.firestarterseo.com/about/#aboutpage',
  url: 'https://www.firestarterseo.com/about/',
  about: { '@id': 'https://www.firestarterseo.com/#organization' }
}

function htmlWithScript(nodeOrNodes) {
  return `<html><head><script type="application/ld+json">${JSON.stringify(nodeOrNodes)}</script></head><body>hi</body></html>`
}

function run() {
  // 1. Exact match live (same @type, @id, and resolved relationship) ->
  // verified.
  {
    const html = htmlWithScript(DEPLOYED_ABOUT)
    const result = verifyDeployedSchema({ jsonLd: DEPLOYED_ABOUT, html })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.matched.length, 1)
    assert.strictEqual(result.matched[0].type, 'AboutPage')
    log('TEST 1 (an exact live match, including a resolved relationship reference, verifies) PASSED')
  }

  // 2. Node entirely absent from the live page -> failed, with a specific
  // missing-node reason.
  {
    const html = '<html><head></head><body>no schema here</body></html>'
    const result = verifyDeployedSchema({ jsonLd: DEPLOYED_ABOUT, html })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.missing.length, 1)
    assert.strictEqual(result.missing[0].id, DEPLOYED_ABOUT['@id'])
    log('TEST 2 (the expected node being entirely absent live fails verification with a specific reason) PASSED')
  }

  // 3. A live node with the same @id but a DIFFERENT @type -> failed (not
  // silently treated as a match just because the @id lines up).
  {
    const wrongType = { ...DEPLOYED_ABOUT, '@type': 'WebPage' }
    const html = htmlWithScript(wrongType)
    const result = verifyDeployedSchema({ jsonLd: DEPLOYED_ABOUT, html })
    assert.strictEqual(result.ok, false)
    assert.ok(/@type/.test(result.missing[0].why))
    log('TEST 3 (a live node with a matching @id but wrong @type fails verification) PASSED')
  }

  // 4. A live node with the right @type/@id but the relationship pointing
  // to a DIFFERENT @id -> failed (a genuinely partial deployment must not
  // be reported as fully verified).
  {
    const wrongRef = { ...DEPLOYED_ABOUT, about: { '@id': 'https://www.firestarterseo.com/#some-other-entity' } }
    const html = htmlWithScript(wrongRef)
    const result = verifyDeployedSchema({ jsonLd: DEPLOYED_ABOUT, html })
    assert.strictEqual(result.ok, false)
    assert.ok(/about/.test(result.missing[0].why))
    log('TEST 4 (a relationship reference resolving to the wrong @id fails verification, even with the right @type/@id) PASSED')
  }

  // 5. A @graph-deployed multi-node artifact: both nodes present live ->
  // fully verified; only one present -> partial failure naming which.
  {
    const secondNode = { '@context': 'https://schema.org', '@type': 'ContactPage', url: 'https://www.firestarterseo.com/contact/' }
    const deployed = { '@context': 'https://schema.org', '@graph': [DEPLOYED_ABOUT, secondNode] }

    const fullHtml = htmlWithScript({ '@graph': [DEPLOYED_ABOUT, secondNode] })
    const fullResult = verifyDeployedSchema({ jsonLd: deployed, html: fullHtml })
    assert.strictEqual(fullResult.ok, true)
    assert.strictEqual(fullResult.matched.length, 2)

    const partialHtml = htmlWithScript({ '@graph': [DEPLOYED_ABOUT] })
    const partialResult = verifyDeployedSchema({ jsonLd: deployed, html: partialHtml })
    assert.strictEqual(partialResult.ok, false)
    assert.strictEqual(partialResult.missing.length, 1)
    assert.strictEqual(partialResult.missing[0].type, 'ContactPage')
    log('TEST 5 (a multi-node @graph deployment verifies node-by-node -- a partial live match is reported precisely, not rounded up to fully verified) PASSED')
  }

  // 6. Malformed/empty inputs never throw.
  {
    assert.strictEqual(verifyDeployedSchema({ jsonLd: null, html: '<html></html>' }).ok, false)
    assert.strictEqual(verifyDeployedSchema({ jsonLd: DEPLOYED_ABOUT, html: null }).ok, false)
    assert.strictEqual(verifyDeployedSchema({ jsonLd: DEPLOYED_ABOUT, html: '<html><head><script type="application/ld+json">{not valid json</script></head></html>' }).ok, false)
    log('TEST 6 (malformed/empty jsonLd or html never throws -- always a clean failed result) PASSED')
  }

  // ---------------------------------------------------------------------
  // verifyApprovedSchemaLive -- 2026-09-24 correction, APPROVED -> LIVE
  // (Part 2). Uses the REAL Firestarter Service node this defect was found
  // against as the fixture, per property/kind detail (section 6/7).
  // ---------------------------------------------------------------------
  const APPROVED_SERVICE = {
    '@context': 'https://schema.org', '@type': 'Service',
    '@id': 'https://www.firestarterseo.com/industries/b2b-business-services-seo/#service',
    url: 'https://www.firestarterseo.com/industries/b2b-business-services-seo/',
    name: 'Strategic SEO for B2B Companies & Business Service Providers',
    provider: { '@id': 'https://www.firestarterseo.com/#organization' },
    description: 'Drive qualified B2B leads with proven SEO.'
  }

  // 7. The exact approved Service artifact, live and unchanged -> VERIFIED.
  {
    const html = htmlWithScript(APPROVED_SERVICE)
    const result = verifyApprovedSchemaLive({ approvedNodes: [APPROVED_SERVICE], html })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.matched.length, 1)
    log('TEST 7 (the exact approved Service artifact, live -> VERIFIED) PASSED')
  }

  // 8. Live missing description (the exact defect this correction targets)
  // -> verification failure, with the specific missing property named.
  {
    const { description, ...liveWithoutDescription } = APPROVED_SERVICE
    const html = htmlWithScript(liveWithoutDescription)
    const result = verifyApprovedSchemaLive({ approvedNodes: [APPROVED_SERVICE], html })
    assert.strictEqual(result.ok, false)
    const diff = result.missing[0].diffs.find(d => d.path === 'description')
    assert.strictEqual(diff.kind, 'removed')
    assert.strictEqual(diff.expected, APPROVED_SERVICE.description)
    log('TEST 8 (live missing the approved description -> verification failure, exact property named) PASSED')
  }

  // 9. Live has a DIFFERENT description text -> verification failure.
  {
    const html = htmlWithScript({ ...APPROVED_SERVICE, description: 'A totally different description.' })
    const result = verifyApprovedSchemaLive({ approvedNodes: [APPROVED_SERVICE], html })
    assert.strictEqual(result.ok, false)
    const diff = result.missing[0].diffs.find(d => d.path === 'description')
    assert.strictEqual(diff.kind, 'changed')
    assert.strictEqual(diff.expected, APPROVED_SERVICE.description)
    assert.strictEqual(diff.actual, 'A totally different description.')
    log('TEST 9 (live description text differs from approved -> verification failure) PASSED')
  }

  // 10. Live has a different name -> verification failure.
  {
    const html = htmlWithScript({ ...APPROVED_SERVICE, name: 'Some Other Name' })
    const result = verifyApprovedSchemaLive({ approvedNodes: [APPROVED_SERVICE], html })
    assert.strictEqual(result.ok, false)
    assert.ok(result.missing[0].diffs.some(d => d.path === 'name' && d.kind === 'changed'))
    log('TEST 10 (live name differs from approved -> verification failure) PASSED')
  }

  // 11. Live provider resolves to the WRONG @id -> verification failure.
  {
    const html = htmlWithScript({ ...APPROVED_SERVICE, provider: { '@id': 'https://www.firestarterseo.com/#some-other-entity' } })
    const result = verifyApprovedSchemaLive({ approvedNodes: [APPROVED_SERVICE], html })
    assert.strictEqual(result.ok, false)
    assert.ok(result.missing[0].diffs.some(d => d.path === 'provider.@id' && d.kind === 'changed'))
    log('TEST 11 (live provider @id does not match approved -> verification failure) PASSED')
  }

  // 12. Unrelated additional schema on the live page (a Yoast/RankMath
  // Organization node, say) never fails verification of OUR owned node.
  {
    const html = htmlWithScript([
      APPROVED_SERVICE,
      { '@context': 'https://schema.org', '@type': 'Organization', '@id': 'https://www.firestarterseo.com/#organization', name: 'Firestarter SEO' }
    ])
    const result = verifyApprovedSchemaLive({ approvedNodes: [APPROVED_SERVICE], html })
    assert.strictEqual(result.ok, true)
    log('TEST 12 (unrelated additional live schema does not cause a failure) PASSED')
  }

  // 13. serviceType/areaServed were never approved (absent from the
  // approved node) -- their absence live must never fail verification,
  // and their presence live (a human added one manually) must not fail it
  // either, since only approved properties are ever required.
  {
    const html = htmlWithScript(APPROVED_SERVICE) // no serviceType/areaServed live, as expected
    const result = verifyApprovedSchemaLive({ approvedNodes: [APPROVED_SERVICE], html })
    assert.strictEqual(result.ok, true)
    const htmlWithExtra = htmlWithScript({ ...APPROVED_SERVICE, serviceType: 'SEO Services' })
    const resultWithExtra = verifyApprovedSchemaLive({ approvedNodes: [APPROVED_SERVICE], html: htmlWithExtra })
    assert.strictEqual(resultWithExtra.ok, true, 'an unapproved property present live must never fail verification')
    log('TEST 13 (serviceType/areaServed absence, or an unapproved extra property present live, never fails verification) PASSED')
  }

  // 14. Nothing approved to verify against, or malformed input -> a clean
  // failed/false result, never a throw.
  {
    assert.strictEqual(verifyApprovedSchemaLive({ approvedNodes: [], html: '<html></html>' }).ok, false)
    assert.strictEqual(verifyApprovedSchemaLive({ approvedNodes: null, html: '<html></html>' }).ok, false)
    assert.strictEqual(verifyApprovedSchemaLive({ approvedNodes: [APPROVED_SERVICE], html: null }).ok, false)
    log('TEST 14 (no approved nodes, or malformed input, never throws -- always a clean failed result) PASSED')
  }

  console.log('\nAll lib/schemaLiveVerification.js pure tests passed.')
}

run()
