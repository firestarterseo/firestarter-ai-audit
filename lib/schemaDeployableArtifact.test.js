// Pure tests for lib/schemaDeployableArtifact.js -- plain Node, no
// network, no DB. Run with: node lib/schemaDeployableArtifact.test.js
//
// Covers Phase 7 test-matrix items D (final deployable JSON-LD
// generation), E (internal add/modify artifact never sent directly), and
// the artifact-insufficient blocking rules from instructions #3/#4.

const assert = require('assert')
const { buildDeployableSchema, BLOCKED_REASONS, EXECUTION_BLOCKED_MESSAGE } = require('./schemaDeployableArtifact')

function log(msg) { console.log(msg) }

const ABOUT_NODE = {
  '@context': 'https://schema.org',
  '@type': 'AboutPage',
  '@id': 'https://www.firestarterseo.com/about/#aboutpage',
  url: 'https://www.firestarterseo.com/about/',
  about: { '@id': 'https://www.firestarterseo.com/#organization' }
}

function run() {
  // 1. A single-ADD, pure-add payload produces the node itself as the
  // deployable JSON-LD -- the simplest, most direct valid document.
  {
    const payload = { supported: true, keep: ['WebPage'], add: [{ description: 'AboutPage node', node: ABOUT_NODE }], modify: [], remove: [], unresolvedDependencies: [] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, true)
    assert.deepStrictEqual(result.jsonLd, ABOUT_NODE)
    assert.strictEqual(result.nodeCount, 1)
    log('TEST 1 (a single ADD node deploys as itself, unchanged) PASSED')
  }

  // 2. Multiple ADD nodes deploy as one @graph, each node's own redundant
  // per-node @context stripped (a single top-level @context covers the
  // whole graph).
  {
    const secondNode = { '@context': 'https://schema.org', '@type': 'ContactPage', url: 'https://www.firestarterseo.com/contact/' }
    const payload = { supported: true, add: [{ node: ABOUT_NODE }, { node: secondNode }], modify: [], remove: [] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.jsonLd['@context'], 'https://schema.org')
    assert.strictEqual(result.jsonLd['@graph'].length, 2)
    assert.strictEqual(result.jsonLd['@graph'][0]['@type'], 'AboutPage')
    assert.strictEqual(result.jsonLd['@graph'][0]['@context'], undefined, 'a per-node @context is redundant inside a @graph and must be stripped')
    assert.strictEqual(result.jsonLd['@graph'][1]['@type'], 'ContactPage')
    assert.strictEqual(result.nodeCount, 2)
    log('TEST 2 (multiple ADD nodes deploy as one @graph document) PASSED')
  }

  // 3. INTERNAL CONTROL STRUCTURE NEVER SHIPS: the deployable output must
  // never carry the literal keys "add"/"modify"/"keep"/"unresolvedDependencies"
  // at any level, and the internal "description" field on an add entry
  // must never leak onto the node itself.
  {
    const payload = { supported: true, keep: ['WebPage'], add: [{ description: 'AboutPage node, with "about" referencing the canonical Organization', node: ABOUT_NODE }], modify: [], remove: [], unresolvedDependencies: ['some internal note'] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, true)
    const serialized = JSON.stringify(result.jsonLd)
    for (const forbidden of ['"add"', '"modify"', '"keep"', '"unresolvedDependencies"', '"description"', 'canonical Organization']) {
      assert.ok(!serialized.includes(forbidden), `deployable JSON-LD must never contain ${forbidden} -- got: ${serialized}`)
    }
    log('TEST 3 (internal control-structure keys and text never reach the deployable JSON-LD) PASSED')
  }

  // 4. MODIFY present -> always blocked, regardless of add content --
  // patching existing third-party markup is never auto-deployed.
  {
    const payload = { supported: true, add: [{ node: ABOUT_NODE }], modify: [{ description: 'Broaden @type', node: { '@type': ['WebPage', 'CollectionPage'] } }], remove: [] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.blocked, true)
    assert.strictEqual(result.code, BLOCKED_REASONS.HAS_MODIFY)
    log('TEST 4 (a prepared work with any MODIFY entries is always blocked, never auto-deployed) PASSED')
  }

  // 5. REMOVE present -> always blocked.
  {
    const payload = { supported: true, add: [{ node: ABOUT_NODE }], modify: [], remove: [{ description: 'drop something' }] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, BLOCKED_REASONS.HAS_REMOVE)
    log('TEST 5 (a prepared work with any REMOVE entries is always blocked) PASSED')
  }

  // 6. No ADD nodes at all (e.g. an unresolved-dependency-only outcome) ->
  // blocked, nothing to deploy.
  {
    const payload = { supported: false, add: [], modify: [], remove: [], unresolvedDependencies: ['No Service schema exists on this page.'] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, BLOCKED_REASONS.NOT_SUPPORTED, 'supported:false must block before even inspecting add/modify/remove')
  }
  {
    const payload = { supported: true, add: [], modify: [], remove: [] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, BLOCKED_REASONS.NO_ADD_NODES)
    log('TEST 6 (supported:false, and supported:true with an empty add list, are both blocked) PASSED')
  }

  // 7. Malformed payload shapes never throw -- they return a blocked
  // result instead (this function must be safe to call on anything a
  // database round-trip could hand back).
  {
    assert.strictEqual(buildDeployableSchema(null).ok, false)
    assert.strictEqual(buildDeployableSchema(undefined).ok, false)
    assert.strictEqual(buildDeployableSchema('not an object').ok, false)
    assert.strictEqual(buildDeployableSchema([]).ok, false)
    assert.strictEqual(buildDeployableSchema({ supported: true, add: [{ node: null }] }).code, BLOCKED_REASONS.INVALID_NODE)
    assert.strictEqual(buildDeployableSchema({ supported: true, add: [{ node: { url: 'no @type here' } }] }).code, BLOCKED_REASONS.INVALID_NODE)
    log('TEST 7 (malformed payload shapes never throw -- always a blocked result) PASSED')
  }

  // 8. Duplicate @id across ADD nodes -> blocked, never silently dedup or
  // deploy a doubled node.
  {
    const dupe = { '@context': 'https://schema.org', '@type': 'ContactPage', '@id': ABOUT_NODE['@id'] }
    const payload = { supported: true, add: [{ node: ABOUT_NODE }, { node: dupe }], modify: [], remove: [] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, BLOCKED_REASONS.DUPLICATE_ID)
    log('TEST 8 (two ADD nodes sharing the same @id is blocked, not silently deployed) PASSED')
  }

  // 9. EXECUTION_BLOCKED_MESSAGE is the exact literal phrase the spec
  // requires callers surface.
  {
    assert.strictEqual(EXECUTION_BLOCKED_MESSAGE, 'EXECUTION BLOCKED — APPROVED ARTIFACT INSUFFICIENT')
    log('TEST 9 (the blocked-message constant matches the required literal phrase) PASSED')
  }

  console.log('\nAll lib/schemaDeployableArtifact.js pure tests passed.')
}

run()
