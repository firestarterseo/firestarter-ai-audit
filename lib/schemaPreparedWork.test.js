// Tests for lib/schemaPreparedWork.js -- the page-type-dispatched prepared
// schema work generator (Phase 6, 2026-09-03). Plain `node`, no framework.
// buildPreparedSchemaWork uses a real fetch under the hood
// (lib/webPageFetch.js#fetchWebPage) -- every test here injects a fake
// `fetcher`, the same injectable-fetcher convention every checker in this
// repo already uses (see lib/webPageFetch.js's own header), so nothing
// here makes a real network call.

const assert = require('assert')
const {
  detectCanonicalEntityRef, buildSubtypePageProposal, buildEntityRelationshipModifyProposal,
  dispatchProposal, toPreparedScriptSnippet, buildPreparedSchemaWork
} = require('./schemaPreparedWork')

let passCount = 0
function test(name, fn) { fn(); passCount++; console.log(`PASS: ${name}`) }
async function atest(name, fn) { await fn(); passCount++; console.log(`PASS: ${name}`) }

function fakeFetcher(html, { status = 200, contentType = 'text/html' } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    url: null,
    redirected: false,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => html
  })
}

function jsonLdPage(nodes) {
  return `<html><head>${nodes.map(n => `<script type="application/ld+json">${JSON.stringify(n)}</script>`).join('\n')}</head><body></body></html>`
}

// ---------------------------------------------------------------------
// detectCanonicalEntityRef -- correction #8: prefer a real, already-in-use
// @id; never fabricate one; surface ambiguity/absence honestly.
// ---------------------------------------------------------------------
test('detectCanonicalEntityRef resolves when exactly one distinct @id exists among business-entity nodes', () => {
  const nodes = [{ '@type': 'Organization', '@id': 'https://example.com/#organization', name: 'Acme Co' }]
  const result = detectCanonicalEntityRef(nodes)
  assert.deepStrictEqual(result, { id: 'https://example.com/#organization', resolved: true, source: 'existing_schema', entityName: 'Acme Co' })
})

test('detectCanonicalEntityRef is unresolved when no business-entity node carries an @id at all (never invents #organization)', () => {
  const nodes = [{ '@type': 'Organization', name: 'Acme Co', url: 'https://example.com' }]
  const result = detectCanonicalEntityRef(nodes)
  assert.strictEqual(result.resolved, false)
  assert.strictEqual(result.id, null)
  assert.strictEqual(result.source, 'no_id_present')
})

test('detectCanonicalEntityRef is unresolved (not guessed) when multiple distinct @ids exist -- ambiguous, never silently picked', () => {
  const nodes = [
    { '@type': 'Organization', '@id': 'https://example.com/#org-a', name: 'Acme Co' },
    { '@type': 'LocalBusiness', '@id': 'https://example.com/#org-b', name: 'Acme Denver Branch' }
  ]
  const result = detectCanonicalEntityRef(nodes)
  assert.strictEqual(result.resolved, false)
  assert.strictEqual(result.source, 'ambiguous_multiple_ids')
  assert.deepStrictEqual(result.candidates.sort(), ['https://example.com/#org-a', 'https://example.com/#org-b'])
})

test('detectCanonicalEntityRef treats no business-entity nodes at all as unresolved, not a crash', () => {
  assert.deepStrictEqual(detectCanonicalEntityRef([]), { id: null, resolved: false, source: 'no_id_present' })
  assert.deepStrictEqual(detectCanonicalEntityRef(undefined), { id: null, resolved: false, source: 'no_id_present' })
})

// ---------------------------------------------------------------------
// buildSubtypePageProposal -- About/Contact pattern.
// ---------------------------------------------------------------------
test('buildSubtypePageProposal (ABOUT) proposes an AboutPage node with about->@id when canonical resolved and both subtype+relationship gaps exist', () => {
  const canonical = { id: 'https://example.com/#organization', resolved: true }
  const gaps = new Set(['about_page_subtype', 'about_entity_relationship_present'])
  const result = buildSubtypePageProposal({ profile: 'ABOUT', pageUrl: 'https://example.com/about/', canonical, gaps })
  assert.strictEqual(result.add.length, 1)
  assert.strictEqual(result.add[0].node['@type'], 'AboutPage')
  assert.deepStrictEqual(result.add[0].node.about, { '@id': 'https://example.com/#organization' })
  assert.strictEqual(result.unresolvedDependencies.length, 0)
  assert.strictEqual(result.modify.length, 0)
})

test('buildSubtypePageProposal (CONTACT) omits the relationship (never fabricates a reference) and reports it unresolved when canonical cannot be identified', () => {
  const canonical = { id: null, resolved: false, source: 'no_id_present' }
  const gaps = new Set(['contact_page_subtype', 'contact_entity_relationship_present'])
  const result = buildSubtypePageProposal({ profile: 'CONTACT', pageUrl: 'https://example.com/contact/', canonical, gaps })
  assert.strictEqual(result.add.length, 1)
  assert.strictEqual(result.add[0].node['@type'], 'ContactPage')
  assert.strictEqual(result.add[0].node.about, undefined, 'must never fabricate an about/@id reference when canonical is unresolved')
  assert.strictEqual(result.unresolvedDependencies.length, 1)
  assert.ok(/canonical Organization @id could not be confidently identified/.test(result.unresolvedDependencies[0]))
})

test('buildSubtypePageProposal proposes nothing when neither the subtype nor the relationship check is actually failing', () => {
  const canonical = { id: 'https://example.com/#organization', resolved: true }
  const result = buildSubtypePageProposal({ profile: 'ABOUT', pageUrl: 'https://example.com/about/', canonical, gaps: new Set() })
  assert.deepStrictEqual(result.add, [])
  assert.deepStrictEqual(result.unresolvedDependencies, [])
})

// ---------------------------------------------------------------------
// buildEntityRelationshipModifyProposal -- Service/Article MODIFY fallback.
// ---------------------------------------------------------------------
test('buildEntityRelationshipModifyProposal proposes a structural MODIFY (never a full re-generated node) when canonical is resolved', () => {
  const canonical = { id: 'https://example.com/#organization', resolved: true }
  const result = buildEntityRelationshipModifyProposal({ relationshipProp: 'provider', canonical, nodeLabel: 'Service' })
  assert.strictEqual(result.modify.length, 1)
  assert.deepStrictEqual(result.modify[0].node, { provider: { '@id': 'https://example.com/#organization' } })
  assert.strictEqual(result.unresolvedDependencies.length, 0)
})

test('buildEntityRelationshipModifyProposal proposes nothing and reports unresolved when canonical is not resolved', () => {
  const canonical = { id: null, resolved: false, source: 'ambiguous_multiple_ids' }
  const result = buildEntityRelationshipModifyProposal({ relationshipProp: 'publisher', canonical, nodeLabel: 'Article' })
  assert.deepStrictEqual(result.modify, [])
  assert.strictEqual(result.unresolvedDependencies.length, 1)
})

// ---------------------------------------------------------------------
// dispatchProposal -- per-profile routing, never fabricating a brand-new
// content-bearing node (Service/Article) from nothing.
// ---------------------------------------------------------------------
test('dispatchProposal (SERVICE) with no Service node at all: no ADD is fabricated, unresolved dependency explains why', () => {
  const result = dispatchProposal('SERVICE', { pageUrl: 'https://example.com/seo/', canonical: { resolved: false, source: 'no_id_present' }, gaps: new Set(['service_schema_present']), byType: {}, schemaNames: ['WebPage'] })
  assert.deepStrictEqual(result.add, [])
  assert.deepStrictEqual(result.modify, [])
  assert.strictEqual(result.unresolvedDependencies.length, 1)
  assert.ok(/does not fabricate Service/.test(result.unresolvedDependencies[0]))
})

test('dispatchProposal (SERVICE) with an existing Service node missing provider: proposes a MODIFY adding provider, when canonical resolved', () => {
  const services = [{ '@type': 'Service', name: 'SEO Services' }]
  const result = dispatchProposal('SERVICE', { pageUrl: 'https://example.com/seo/', canonical: { id: 'https://example.com/#organization', resolved: true }, gaps: new Set(['service_provider_relationship']), byType: { Service: services }, schemaNames: ['WebPage', 'Service'] })
  assert.strictEqual(result.modify.length, 1)
  assert.deepStrictEqual(result.modify[0].node, { provider: { '@id': 'https://example.com/#organization' } })
})

test('dispatchProposal (LOCATION_HUB) missing CollectionPage subtype: proposes broadening the existing WebPage @type, never a duplicate node', () => {
  const result = dispatchProposal('LOCATION_HUB', { pageUrl: 'https://example.com/locations/', canonical: { resolved: false, source: 'no_id_present' }, gaps: new Set(['hub_collection_page_subtype']), byType: {}, schemaNames: ['WebPage'] })
  assert.strictEqual(result.modify.length, 1)
  assert.deepStrictEqual(result.modify[0].node['@type'], ['WebPage', 'CollectionPage'])
})

test('dispatchProposal (LOCATION_HUB) missing ItemList: never fabricates a link list, reports unresolved instead', () => {
  const result = dispatchProposal('LOCATION_HUB', { pageUrl: 'https://example.com/locations/', canonical: { resolved: false, source: 'no_id_present' }, gaps: new Set(['hub_item_list_present']), byType: {}, schemaNames: ['WebPage', 'CollectionPage'] })
  assert.deepStrictEqual(result.add, [])
  assert.ok(result.unresolvedDependencies.some(d => /ItemList/.test(d)))
})

test('dispatchProposal (ARTICLE) with no Article-like node: never fabricates headline/author, reports unresolved', () => {
  const result = dispatchProposal('ARTICLE', { pageUrl: 'https://example.com/blog/post/', canonical: { resolved: false, source: 'no_id_present' }, gaps: new Set(['article_schema_present']), byType: {}, schemaNames: ['WebPage'] })
  assert.deepStrictEqual(result.add, [])
  assert.ok(result.unresolvedDependencies.some(d => /does not fabricate headline/.test(d)))
})

test('dispatchProposal (CASE_STUDY) with an existing Article node missing publisher: proposes a MODIFY, never regenerates the node', () => {
  const nodes = [{ '@type': 'Article', headline: 'How We Helped Acme Grow' }]
  const result = dispatchProposal('CASE_STUDY', { pageUrl: 'https://example.com/case-studies/acme/', canonical: { id: 'https://example.com/#organization', resolved: true }, gaps: new Set(['case_study_publisher_relationship']), byType: { Article: nodes }, schemaNames: ['WebPage', 'Article'] })
  assert.strictEqual(result.modify.length, 1)
  assert.deepStrictEqual(result.modify[0].node, { publisher: { '@id': 'https://example.com/#organization' } })
})

test('dispatchProposal falls through to "nothing proposed" honestly for an unmapped profile (never crashes, never fabricates)', () => {
  const result = dispatchProposal('GENERIC', { pageUrl: 'https://example.com/x/', canonical: { resolved: false, source: 'no_id_present' }, gaps: new Set(['generic_webpage_representation']), byType: {}, schemaNames: [] })
  assert.deepStrictEqual(result, { add: [], modify: [], unresolvedDependencies: [] })
})

test('toPreparedScriptSnippet renders one <script type="application/ld+json"> block per ADD node only', () => {
  const snippet = toPreparedScriptSnippet([{ description: 'x', node: { '@type': 'AboutPage' } }])
  assert.ok(snippet.includes('<script type="application/ld+json">'))
  assert.ok(snippet.includes('"AboutPage"'))
})

// ---------------------------------------------------------------------
// buildPreparedSchemaWork -- end to end, via an injected fetcher.
// ---------------------------------------------------------------------
async function main() {
  await atest('buildPreparedSchemaWork (About, canonical resolved) proposes an AboutPage node referencing the real canonical @id, preserving existing schema in `keep`', async () => {
    const html = jsonLdPage([
      { '@type': 'WebPage', url: 'https://example.com/about/' },
      { '@type': 'Organization', '@id': 'https://example.com/#organization', name: 'Acme Co', url: 'https://example.com' },
      { '@type': 'BreadcrumbList', itemListElement: [] }
    ])
    const result = await buildPreparedSchemaWork({
      path: '/about/', siteUrl: 'https://example.com', targetProfile: 'ABOUT',
      coreChecks: [{ id: 'about_page_type_representation', status: 'pass' }],
      recommendedChecks: [
        { id: 'about_page_subtype', status: 'fail' },
        { id: 'about_entity_relationship_present', status: 'fail' },
        { id: 'breadcrumb_present', status: 'pass' }
      ],
      fetcher: fakeFetcher(html)
    })
    assert.strictEqual(result.supported, true)
    assert.deepStrictEqual(result.keep.sort(), ['BreadcrumbList', 'Organization', 'WebPage'])
    assert.strictEqual(result.canonicalEntity.resolved, true)
    assert.strictEqual(result.canonicalEntity.id, 'https://example.com/#organization')
    assert.strictEqual(result.add.length, 1)
    assert.strictEqual(result.add[0].node['@type'], 'AboutPage')
    assert.deepStrictEqual(result.add[0].node.about, { '@id': 'https://example.com/#organization' })
    assert.strictEqual(result.remove.length, 0)
    assert.ok(result.scriptSnippet.includes('AboutPage'))
  })

  await atest('buildPreparedSchemaWork (About, canonical unresolved -- realistic Firestarter case: schemaGenerator.js emits no @id) omits the reference and surfaces it as unresolved, never fabricates one', async () => {
    const html = jsonLdPage([
      { '@type': 'WebPage', url: 'https://example.com/about/' },
      { '@type': 'Organization', name: 'Firestarter', url: 'https://www.firestarterseo.com' }
    ])
    const result = await buildPreparedSchemaWork({
      path: '/about/', siteUrl: 'https://example.com', targetProfile: 'ABOUT',
      coreChecks: [{ id: 'about_page_type_representation', status: 'pass' }],
      recommendedChecks: [{ id: 'about_page_subtype', status: 'fail' }, { id: 'about_entity_relationship_present', status: 'fail' }],
      fetcher: fakeFetcher(html)
    })
    assert.strictEqual(result.canonicalEntity.resolved, false)
    assert.strictEqual(result.canonicalEntity.source, 'no_id_present')
    assert.strictEqual(result.add[0].node.about, undefined)
    assert.strictEqual(result.unresolvedDependencies.length, 1)
    assert.strictEqual(result.supported, true, 'the AboutPage subtype node itself is still a real, defensible addition even with the relationship omitted')
  })

  await atest('buildPreparedSchemaWork reports an honest fetch failure (not a fabricated empty schema) when the page cannot be fetched', async () => {
    const failingFetcher = async () => { throw new Error('boom') }
    const result = await buildPreparedSchemaWork({ path: '/about/', siteUrl: 'https://example.com', targetProfile: 'ABOUT', coreChecks: [], recommendedChecks: [], fetcher: failingFetcher })
    assert.strictEqual(result.supported, false)
    assert.ok(/Could not fetch this page/.test(result.reason))
  })

  await atest('buildPreparedSchemaWork reports an unresolved URL honestly for a cross-origin/unresolvable path (no fetch attempted)', async () => {
    const result = await buildPreparedSchemaWork({ path: '//evil.example.com/x', siteUrl: 'https://example.com', targetProfile: 'ABOUT', coreChecks: [], recommendedChecks: [] })
    assert.strictEqual(result.supported, false)
    assert.ok(/same-origin URL/.test(result.reason))
  })

  await atest('buildPreparedSchemaWork returns supported:false with an honest reason (not preparation_failed silently claimed as success) when nothing content-defensible can be proposed', async () => {
    const html = jsonLdPage([{ '@type': 'WebPage', url: 'https://example.com/seo/' }])
    const result = await buildPreparedSchemaWork({
      path: '/seo/', siteUrl: 'https://example.com', targetProfile: 'SERVICE',
      coreChecks: [{ id: 'service_schema_valid_when_present', status: 'pass' }],
      recommendedChecks: [{ id: 'service_schema_present', status: 'fail' }],
      fetcher: fakeFetcher(html)
    })
    assert.strictEqual(result.supported, false)
    assert.ok(result.reason && result.reason.length > 0)
    assert.strictEqual(result.unresolvedDependencies.length, 1)
  })

  console.log(`\n${passCount} passed.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
