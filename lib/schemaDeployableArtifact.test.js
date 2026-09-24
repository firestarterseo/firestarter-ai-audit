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

  // ---------------------------------------------------------------------
  // 2026-09-24 correction: a real, legitimate schema.org property whose
  // NAME happens to collide with an unrelated internal/envelope field name
  // must survive deployment -- the old stripInternalKeys() name-based
  // blacklist deleted a genuine, approved Service.description. These tests
  // pin the fix using the REAL Firestarter Service fixture that exposed it.
  // ---------------------------------------------------------------------
  const SERVICE_NODE = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': 'https://www.firestarterseo.com/industries/b2b-business-services-seo/#service',
    url: 'https://www.firestarterseo.com/industries/b2b-business-services-seo/',
    name: 'Strategic SEO for B2B Companies & Business Service Providers',
    provider: { '@id': 'https://www.firestarterseo.com/#organization' },
    description: 'Drive qualified B2B leads with proven SEO. We help IT services, consultants, and accounting firms grow visibility and pipeline.'
  }

  // 10. Service.description (a REAL schema.org property on the node) must
  // survive -- this is the exact defect the 2026-09-24 investigation found.
  {
    const payload = { supported: true, add: [{ node: SERVICE_NODE, description: 'Service node, name from this page\'s <h1>...', evidence: { name: { sourceType: 'h1' } } }], modify: [], remove: [] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert.strictEqual(result.jsonLd.description, SERVICE_NODE.description, 'a real, approved Service.description must survive deployment, never silently stripped')
    log('TEST 10 (Service.description survives -- the description-stripping defect is fixed) PASSED')
  }

  // 11. Every other real, approved property on the same node -- name, url,
  // nested provider.@id -- also survives, confirming the fix isn't a
  // one-off exception scoped only to "description."
  {
    const payload = { supported: true, add: [{ node: SERVICE_NODE, description: 'envelope prose' }], modify: [], remove: [] }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.jsonLd.name, SERVICE_NODE.name)
    assert.strictEqual(result.jsonLd.url, SERVICE_NODE.url)
    assert.deepStrictEqual(result.jsonLd.provider, SERVICE_NODE.provider)
    assert.strictEqual(result.jsonLd['@id'], SERVICE_NODE['@id'])
    // serviceType/areaServed were never approved (never on the node) --
    // must never be silently added.
    assert.strictEqual(result.jsonLd.serviceType, undefined)
    assert.strictEqual(result.jsonLd.areaServed, undefined)
    log('TEST 11 (name/url/nested provider.@id all survive; unapproved serviceType/areaServed are never added) PASSED')
  }

  // 12. The envelope's OWN "description" (the prose summary sibling of
  // `node`) still never leaks onto the deployed node -- confirms the
  // sanitization boundary is now structural (envelope vs. node), not a
  // name-based rule that happened to also do this by accident.
  {
    const payload = {
      supported: true,
      add: [{
        node: { '@context': 'https://schema.org', '@type': 'AboutPage', '@id': ABOUT_NODE['@id'], url: ABOUT_NODE.url, about: ABOUT_NODE.about },
        description: 'THIS ENVELOPE PROSE MUST NEVER APPEAR IN THE DEPLOYED NODE',
        evidence: { about: { sourceType: 'existing_schema_canonical_entity', reasoning: 'THIS EVIDENCE/REASONING MUST NEVER APPEAR EITHER' } }
      }],
      modify: [], remove: []
    }
    const result = buildDeployableSchema(payload)
    assert.strictEqual(result.ok, true)
    const serialized = JSON.stringify(result.jsonLd)
    assert.ok(!serialized.includes('ENVELOPE PROSE'), 'the envelope\'s own description field must never leak onto the deployed node')
    assert.ok(!serialized.includes('REASONING MUST NEVER'), 'evidence/reasoning metadata must never leak onto the deployed node')
    log('TEST 12 (envelope-level description/evidence/reasoning metadata never deploys, even though the node itself may legitimately carry a "description" property) PASSED')
  }

  // 13. APPROVED -> DEPLOYED integrity gate: a hand-crafted mismatch
  // between what an entry claims (via a corrupted node the caller controls
  // directly, bypassing the normal generator) and what actually gets built
  // must block, never silently publish a degraded artifact. This exercises
  // the gate itself, independent of the sanitization-boundary fix above --
  // defense in depth.
  {
    // Simulate a hypothetical future transform bug by calling the
    // integrity check directly against a payload/jsonLd pair that
    // disagree, since buildDeployableSchema itself no longer introduces
    // any such mismatch -- proves the gate fires when one exists.
    const { verifyApprovedToDeployableIntegrity } = require('./schemaArtifactIntegrity')
    const payload = { add: [{ node: SERVICE_NODE }] }
    const degradedJsonLd = { ...SERVICE_NODE, description: undefined }
    delete degradedJsonLd.description
    const integrity = verifyApprovedToDeployableIntegrity(payload, degradedJsonLd)
    assert.strictEqual(integrity.ok, false)
    assert.ok(integrity.diffs.some(d => d.path.endsWith('.description') && d.kind === 'removed'))
    log('TEST 13 (the approved->deployed integrity gate itself detects a stripped property, independent of the sanitization fix) PASSED')
  }

  console.log('\nAll lib/schemaDeployableArtifact.js pure tests passed.')
}

run()
