// Tests for lib/schemaArtifactIntegrity.js -- 2026-09-24 correction. Plain
// `node`, no framework.

const assert = require('assert')
const {
  buildApprovedNodes, extractDeployableNodes, diffSchemaNodes, verifyApprovedToDeployableIntegrity
} = require('./schemaArtifactIntegrity')

let passCount = 0
function test(name, fn) { fn(); passCount++; console.log(`PASS: ${name}`) }

// ---------------------------------------------------------------------
// buildApprovedNodes / extractDeployableNodes
// ---------------------------------------------------------------------
test('buildApprovedNodes extracts entry.node for every ADD entry, ignoring envelope fields', () => {
  const payload = { add: [{ description: 'prose', evidence: {}, node: { '@type': 'Service', name: 'X' } }] }
  assert.deepStrictEqual(buildApprovedNodes(payload), [{ '@type': 'Service', name: 'X' }])
})

test('buildApprovedNodes never crashes on malformed input', () => {
  assert.deepStrictEqual(buildApprovedNodes(null), [])
  assert.deepStrictEqual(buildApprovedNodes({}), [])
  assert.deepStrictEqual(buildApprovedNodes({ add: [{ node: null }, { node: 'not an object' }] }), [])
})

test('extractDeployableNodes handles a single-node artifact', () => {
  const node = { '@type': 'Service', name: 'X' }
  assert.deepStrictEqual(extractDeployableNodes(node), [node])
})

test('extractDeployableNodes handles a @graph artifact', () => {
  const graph = { '@context': 'https://schema.org', '@graph': [{ '@type': 'AboutPage' }, { '@type': 'ContactPage' }] }
  assert.deepStrictEqual(extractDeployableNodes(graph), graph['@graph'])
})

// ---------------------------------------------------------------------
// diffSchemaNodes -- generic, order-independent structural diff.
// ---------------------------------------------------------------------
test('diffSchemaNodes reports no diffs for identical objects regardless of key order', () => {
  const a = { name: 'X', '@type': 'Service', url: 'https://x/' }
  const b = { url: 'https://x/', '@type': 'Service', name: 'X' }
  assert.deepStrictEqual(diffSchemaNodes(a, b), [])
})

test('diffSchemaNodes detects a removed (missing) property', () => {
  const diffs = diffSchemaNodes({ name: 'X', description: 'Y' }, { name: 'X' })
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].kind, 'removed')
  assert.strictEqual(diffs[0].path, 'description')
  assert.strictEqual(diffs[0].expected, 'Y')
})

test('diffSchemaNodes detects a changed scalar value', () => {
  const diffs = diffSchemaNodes({ name: 'X' }, { name: 'Y' })
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].kind, 'changed')
  assert.strictEqual(diffs[0].expected, 'X')
  assert.strictEqual(diffs[0].actual, 'Y')
})

test('diffSchemaNodes detects an added property (strict mode, default)', () => {
  const diffs = diffSchemaNodes({ name: 'X' }, { name: 'X', extra: 'unexpected' })
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].kind, 'added')
  assert.strictEqual(diffs[0].path, 'extra')
})

test('diffSchemaNodes detects a changed @id and @type the same way as any other property', () => {
  const diffs = diffSchemaNodes({ '@id': 'https://x/#a', '@type': 'Service' }, { '@id': 'https://x/#b', '@type': 'Article' })
  const paths = diffs.map(d => d.path).sort()
  assert.deepStrictEqual(paths, ['@id', '@type'])
})

test('diffSchemaNodes detects a change inside a nested object (e.g. provider.@id)', () => {
  const diffs = diffSchemaNodes(
    { provider: { '@id': 'https://x/#organization' } },
    { provider: { '@id': 'https://x/#different-org' } }
  )
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].path, 'provider.@id')
})

test('diffSchemaNodes detects a removed array member', () => {
  const diffs = diffSchemaNodes({ '@type': ['WebPage', 'CollectionPage'] }, { '@type': ['WebPage'] })
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].kind, 'removed')
  assert.strictEqual(diffs[0].path, '@type[1]')
})

test('diffSchemaNodes detects a changed array member', () => {
  const diffs = diffSchemaNodes({ items: ['a', 'b'] }, { items: ['a', 'c'] })
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].path, 'items[1]')
})

test('diffSchemaNodes subsetOnly mode never flags extra actual-only properties (approved -> live)', () => {
  const diffs = diffSchemaNodes({ name: 'X' }, { name: 'X', extraFromAnotherPlugin: 'ignored' }, '', { subsetOnly: true })
  assert.deepStrictEqual(diffs, [])
})

test('diffSchemaNodes subsetOnly mode still detects a missing or changed approved property', () => {
  const missing = diffSchemaNodes({ name: 'X', description: 'Y' }, { name: 'X' }, '', { subsetOnly: true })
  assert.strictEqual(missing.length, 1)
  assert.strictEqual(missing[0].kind, 'removed')
  const changed = diffSchemaNodes({ name: 'X' }, { name: 'Z' }, '', { subsetOnly: true })
  assert.strictEqual(changed.length, 1)
  assert.strictEqual(changed[0].kind, 'changed')
})

// ---------------------------------------------------------------------
// verifyApprovedToDeployableIntegrity -- APPROVED -> DEPLOYED.
// ---------------------------------------------------------------------
const SERVICE_NODE = {
  '@context': 'https://schema.org', '@type': 'Service',
  '@id': 'https://www.firestarterseo.com/industries/b2b-business-services-seo/#service',
  url: 'https://www.firestarterseo.com/industries/b2b-business-services-seo/',
  name: 'Strategic SEO for B2B Companies & Business Service Providers',
  provider: { '@id': 'https://www.firestarterseo.com/#organization' },
  description: 'Drive qualified B2B leads with proven SEO.'
}

test('verifyApprovedToDeployableIntegrity passes for a faithful single-node deploy', () => {
  const payload = { add: [{ node: SERVICE_NODE }] }
  const result = verifyApprovedToDeployableIntegrity(payload, SERVICE_NODE)
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.diffs, [])
})

test('verifyApprovedToDeployableIntegrity allows the one permitted normalization: adding a default @context when the approved node had none', () => {
  const { '@context': _ctx, ...noContext } = SERVICE_NODE
  const payload = { add: [{ node: noContext }] }
  const deployed = { '@context': 'https://schema.org', ...noContext }
  const result = verifyApprovedToDeployableIntegrity(payload, deployed)
  assert.strictEqual(result.ok, true)
})

test('verifyApprovedToDeployableIntegrity detects a stripped property (the exact description-loss defect)', () => {
  const degraded = { ...SERVICE_NODE }
  delete degraded.description
  const payload = { add: [{ node: SERVICE_NODE }] }
  const result = verifyApprovedToDeployableIntegrity(payload, degraded)
  assert.strictEqual(result.ok, false)
  assert.ok(result.diffs.some(d => d.path === 'add[0].description' && d.kind === 'removed' && d.expected === SERVICE_NODE.description))
})

test('verifyApprovedToDeployableIntegrity detects a changed value', () => {
  const mutated = { ...SERVICE_NODE, name: 'Something Else Entirely' }
  const payload = { add: [{ node: SERVICE_NODE }] }
  const result = verifyApprovedToDeployableIntegrity(payload, mutated)
  assert.strictEqual(result.ok, false)
  assert.ok(result.diffs.some(d => d.path === 'add[0].name' && d.kind === 'changed'))
})

test('verifyApprovedToDeployableIntegrity handles a multi-node @graph deploy, ignoring the per-node @context hoist', () => {
  const secondNode = { '@context': 'https://schema.org', '@type': 'ContactPage', '@id': 'https://x/#contactpage' }
  const payload = { add: [{ node: SERVICE_NODE }, { node: secondNode }] }
  const { '@context': _c1, ...serviceNoCtx } = SERVICE_NODE
  const { '@context': _c2, ...contactNoCtx } = secondNode
  const jsonLd = { '@context': 'https://schema.org', '@graph': [serviceNoCtx, contactNoCtx] }
  const result = verifyApprovedToDeployableIntegrity(payload, jsonLd)
  assert.strictEqual(result.ok, true)
})

test('verifyApprovedToDeployableIntegrity detects a missing node entirely', () => {
  const payload = { add: [{ node: SERVICE_NODE }] }
  const result = verifyApprovedToDeployableIntegrity(payload, { '@type': 'AboutPage', '@id': 'https://different/#node' })
  assert.strictEqual(result.ok, false)
  assert.ok(result.diffs.some(d => d.kind === 'node_missing'))
})

console.log(`\n${passCount} passed.`)
