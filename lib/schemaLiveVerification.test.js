// Pure tests for lib/schemaLiveVerification.js -- plain Node, no network
// (fixed HTML fixtures stand in for a real fetchWebPage() result). Run
// with: node lib/schemaLiveVerification.test.js
//
// Covers Phase 7 test-matrix items L (live verification success) and M
// (expected node absent -- verification failed).

const assert = require('assert')
const { verifyDeployedSchema } = require('./schemaLiveVerification')

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

  console.log('\nAll lib/schemaLiveVerification.js pure tests passed.')
}

run()
