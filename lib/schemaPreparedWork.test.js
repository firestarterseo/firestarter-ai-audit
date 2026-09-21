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
  dispatchProposal, toPreparedScriptSnippet, buildPreparedSchemaWork,
  isUsableServiceNameText, resolveServiceNameEvidence, buildServiceNodeProposal
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

// servicePageHtml -- a realistic Service-profile page: real <title>/<h1>/
// meta description (or missing, per test), plus whatever JSON-LD nodes the
// caller wants (Organization for canonical-entity resolution, etc.), no
// pre-existing Service node -- the exact shape that used to hit an
// unconditional "cannot fabricate" refusal before Phase B.
function servicePageHtml({ title, h1, metaDescription, jsonLdNodes = [] } = {}) {
  const head = [
    title ? `<title>${title}</title>` : '',
    metaDescription ? `<meta name="description" content="${metaDescription}">` : '',
    ...jsonLdNodes.map(n => `<script type="application/ld+json">${JSON.stringify(n)}</script>`)
  ].join('\n')
  const body = h1 !== undefined ? (Array.isArray(h1) ? h1.map(t => `<h1>${t}</h1>`).join('') : `<h1>${h1}</h1>`) : ''
  return `<html><head>${head}</head><body>${body}</body></html>`
}

// ---------------------------------------------------------------------
// EVIDENCE-BACKED SERVICE GENERATION (Phase B, 2026-09-21) -- pure helpers.
// ---------------------------------------------------------------------
test('isUsableServiceNameText rejects the generic denylist (exact match only) and too-short text', () => {
  assert.strictEqual(isUsableServiceNameText('Services'), false)
  assert.strictEqual(isUsableServiceNameText('Our Services'), false)
  assert.strictEqual(isUsableServiceNameText('  home  '), false)
  assert.strictEqual(isUsableServiceNameText('Welcome'), false)
  assert.strictEqual(isUsableServiceNameText('Hi'), false) // below MIN_SERVICE_NAME_LENGTH (3)
  assert.strictEqual(isUsableServiceNameText('SEO'), true) // exactly 3 chars, not denylisted -- usable
  assert.strictEqual(isUsableServiceNameText('B2B Business Services SEO'), true) // contains "services" as a substring -- must NOT be denylisted
  assert.strictEqual(isUsableServiceNameText('Home Services SEO'), true) // contains "home" as a substring -- must NOT be denylisted
})

test('resolveServiceNameEvidence prefers a single, usable H1 over the title', () => {
  const evidence = {
    headingCounts: { h1: 1, h2: 0, h3: 0 },
    headings: [{ level: 1, value: 'B2B Business Services SEO', evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'h1', sourceIndex: 0 }],
    documentMetadata: { title: { value: 'A Totally Different Title', evidenceClass: 'DOCUMENT_METADATA', sourceType: 'title_tag' } }
  }
  const result = resolveServiceNameEvidence(evidence)
  assert.strictEqual(result.name, 'B2B Business Services SEO')
  assert.strictEqual(result.evidence.sourceType, 'h1')
  assert.strictEqual(result.rejectionReasons.length, 0)
})

test('resolveServiceNameEvidence rejects a generic H1 and falls back to a defensible title', () => {
  const evidence = {
    headingCounts: { h1: 1, h2: 0, h3: 0 },
    headings: [{ level: 1, value: 'Our Services', evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'h1', sourceIndex: 0 }],
    documentMetadata: { title: { value: 'B2B Business Services SEO | Firestarter', evidenceClass: 'DOCUMENT_METADATA', sourceType: 'title_tag' } }
  }
  const result = resolveServiceNameEvidence(evidence)
  assert.strictEqual(result.name, 'B2B Business Services SEO | Firestarter')
  assert.strictEqual(result.evidence.sourceType, 'title_tag')
})

test('resolveServiceNameEvidence blocks when H1 is ambiguous (2+) and title is also generic/unavailable', () => {
  const evidence = {
    headingCounts: { h1: 2, h2: 0, h3: 0 },
    headings: [
      { level: 1, value: 'First', evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'h1', sourceIndex: 0 },
      { level: 1, value: 'Second', evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'h1', sourceIndex: 1 }
    ],
    documentMetadata: { title: { value: null, evidenceClass: 'UNAVAILABLE', sourceType: 'title_tag' } }
  }
  const result = resolveServiceNameEvidence(evidence)
  assert.strictEqual(result.name, null)
  assert.ok(result.rejectionReasons.some(r => /ambiguous/.test(r)))
  assert.ok(result.rejectionReasons.some(r => /no usable <title>/.test(r)))
})

test('resolveServiceNameEvidence blocks when H1 is missing and title is generic', () => {
  const evidence = {
    headingCounts: { h1: 0, h2: 0, h3: 0 },
    headings: [],
    documentMetadata: { title: { value: 'Home', evidenceClass: 'DOCUMENT_METADATA', sourceType: 'title_tag' } }
  }
  const result = resolveServiceNameEvidence(evidence)
  assert.strictEqual(result.name, null)
  assert.ok(result.rejectionReasons.some(r => /no H1 at all/.test(r)))
  assert.ok(result.rejectionReasons.some(r => /also too generic/.test(r)))
})

test('buildServiceNodeProposal: minimum evidence (name only, no provider, no description) still produces a partial, honest proposal', () => {
  const contentEvidence = {
    headingCounts: { h1: 1 },
    headings: [{ level: 1, value: 'B2B Business Services SEO', evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'h1', sourceIndex: 0 }],
    documentMetadata: {
      title: { value: 'B2B Business Services SEO', evidenceClass: 'DOCUMENT_METADATA', sourceType: 'title_tag' },
      metaDescription: { value: null, evidenceClass: 'UNAVAILABLE', sourceType: 'meta_description', reason: 'not_present' }
    }
  }
  const canonical = { id: null, resolved: false, source: 'no_id_present' }
  const result = buildServiceNodeProposal({ pageUrl: 'https://example.com/industries/b2b/', canonical, contentEvidence })
  assert.strictEqual(result.add.length, 1)
  const node = result.add[0].node
  assert.strictEqual(node['@type'], 'Service')
  assert.strictEqual(node.name, 'B2B Business Services SEO')
  assert.strictEqual(node.provider, undefined)
  assert.strictEqual(node.description, undefined)
  assert.strictEqual(node.serviceType, undefined)
  assert.strictEqual(node.areaServed, undefined)
  assert.ok(result.unresolvedDependencies.some(d => /provider/.test(d)))
  assert.ok(result.unresolvedDependencies.some(d => /description omitted -- insufficient approved evidence/.test(d)))
  assert.ok(result.unresolvedDependencies.some(d => /serviceType unresolved/.test(d)))
  assert.ok(result.unresolvedDependencies.some(d => /areaServed unresolved -- page-level geographic evidence/.test(d)))
})

test('buildServiceNodeProposal: full evidence (name + provider + description) produces a richer proposal, serviceType/areaServed still unresolved', () => {
  const contentEvidence = {
    headingCounts: { h1: 1 },
    headings: [{ level: 1, value: 'B2B Business Services SEO', evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'h1', sourceIndex: 0 }],
    documentMetadata: {
      title: { value: 'B2B Business Services SEO', evidenceClass: 'DOCUMENT_METADATA', sourceType: 'title_tag' },
      metaDescription: { value: 'We help B2B companies grow through SEO.', evidenceClass: 'DOCUMENT_METADATA', sourceType: 'meta_description' }
    }
  }
  const canonical = { id: 'https://www.firestarterseo.com/#organization', resolved: true, source: 'existing_schema' }
  const result = buildServiceNodeProposal({ pageUrl: 'https://www.firestarterseo.com/industries/b2b-business-services-seo/', canonical, contentEvidence })
  const node = result.add[0].node
  assert.strictEqual(node.name, 'B2B Business Services SEO')
  assert.deepStrictEqual(node.provider, { '@id': 'https://www.firestarterseo.com/#organization' })
  assert.strictEqual(node.description, 'We help B2B companies grow through SEO.')
  assert.strictEqual(node.serviceType, undefined)
  assert.strictEqual(node.areaServed, undefined)
  assert.ok(result.unresolvedDependencies.some(d => /serviceType/.test(d)))
  assert.ok(result.unresolvedDependencies.some(d => /areaServed/.test(d)))
  assert.strictEqual(result.unresolvedDependencies.some(d => /^description omitted/.test(d)), false)
})

test('buildServiceNodeProposal: a conflicting/ambiguous canonical provider is never silently chosen -- provider omitted, reported unresolved', () => {
  const contentEvidence = {
    headingCounts: { h1: 1 },
    headings: [{ level: 1, value: 'B2B Business Services SEO', evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'h1', sourceIndex: 0 }],
    documentMetadata: { title: { value: null, evidenceClass: 'UNAVAILABLE', sourceType: 'title_tag' }, metaDescription: { value: null, evidenceClass: 'UNAVAILABLE', sourceType: 'meta_description', reason: 'not_present' } }
  }
  const canonical = { id: null, resolved: false, source: 'ambiguous_multiple_ids', candidates: ['https://example.com/#a', 'https://example.com/#b'] }
  const result = buildServiceNodeProposal({ pageUrl: 'https://example.com/services/x/', canonical, contentEvidence })
  const node = result.add[0].node
  assert.strictEqual(node.provider, undefined)
  assert.ok(result.unresolvedDependencies.some(d => /canonical Organization @id could not be confidently identified/.test(d)))
})

test('buildServiceNodeProposal: deterministic @id derived from the page URL, following the existing #<type> convention', () => {
  const contentEvidence = {
    headingCounts: { h1: 1 },
    headings: [{ level: 1, value: 'B2B Business Services SEO', evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'h1', sourceIndex: 0 }],
    documentMetadata: { title: { value: null, evidenceClass: 'UNAVAILABLE', sourceType: 'title_tag' }, metaDescription: { value: null, evidenceClass: 'UNAVAILABLE', sourceType: 'meta_description', reason: 'not_present' } }
  }
  const canonical = { id: null, resolved: false, source: 'no_id_present' }
  const pageUrl = 'https://www.firestarterseo.com/industries/b2b-business-services-seo/'
  const r1 = buildServiceNodeProposal({ pageUrl, canonical, contentEvidence })
  const r2 = buildServiceNodeProposal({ pageUrl, canonical, contentEvidence })
  assert.strictEqual(r1.add[0].node['@id'], `${pageUrl}#service`)
  assert.strictEqual(r1.add[0].node.url, pageUrl)
  assert.strictEqual(r1.add[0].node['@id'], r2.add[0].node['@id'], 'repeated preparation must produce the identical @id')
})

test('buildServiceNodeProposal: insufficient name evidence blocks generation safely -- no ADD at all', () => {
  const contentEvidence = {
    headingCounts: { h1: 0 },
    headings: [],
    documentMetadata: { title: { value: 'Home', evidenceClass: 'DOCUMENT_METADATA', sourceType: 'title_tag' }, metaDescription: { value: null, evidenceClass: 'UNAVAILABLE', sourceType: 'meta_description', reason: 'not_present' } }
  }
  const canonical = { id: 'https://example.com/#organization', resolved: true }
  const result = buildServiceNodeProposal({ pageUrl: 'https://example.com/services/', canonical, contentEvidence })
  assert.deepStrictEqual(result.add, [])
  assert.strictEqual(result.unresolvedDependencies.length, 1)
  assert.ok(/no evidence-backed Service name could be established/.test(result.unresolvedDependencies[0]))
})

test('buildServiceNodeProposal: prepared-work provenance retains the evidence actually used, per property', () => {
  const contentEvidence = {
    headingCounts: { h1: 1 },
    headings: [{ level: 1, value: 'B2B Business Services SEO', evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'h1', sourceIndex: 0 }],
    documentMetadata: {
      title: { value: null, evidenceClass: 'UNAVAILABLE', sourceType: 'title_tag' },
      metaDescription: { value: 'We help B2B companies grow through SEO.', evidenceClass: 'DOCUMENT_METADATA', sourceType: 'meta_description' }
    }
  }
  const canonical = { id: 'https://www.firestarterseo.com/#organization', resolved: true }
  const result = buildServiceNodeProposal({ pageUrl: 'https://www.firestarterseo.com/industries/b2b-business-services-seo/', canonical, contentEvidence })
  const evidence = result.add[0].evidence
  assert.strictEqual(evidence.name.sourceType, 'h1')
  assert.strictEqual(evidence.name.value, 'B2B Business Services SEO')
  assert.strictEqual(evidence.provider.value, 'https://www.firestarterseo.com/#organization')
  assert.strictEqual(evidence.provider.evidenceClass, 'OBSERVED_STRUCTURED_DATA')
  assert.strictEqual(evidence.description.value, 'We help B2B companies grow through SEO.')
  assert.strictEqual(evidence.description.evidenceClass, 'DOCUMENT_METADATA')
})

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
// 2026-09-21 Phase B: SERVICE with no existing Service node now attempts an
// evidence-backed proposal FIRST (see buildServiceNodeProposal) -- this
// case exercises what happens when NO contentEvidence is supplied at all
// (an older/degenerate caller), which must behave exactly like "no usable
// H1 and no usable title": still an honest refusal, never a fabrication.
test('dispatchProposal (SERVICE) with no Service node and no content evidence at all: no ADD is fabricated, unresolved dependency explains why', () => {
  const result = dispatchProposal('SERVICE', { pageUrl: 'https://example.com/seo/', canonical: { resolved: false, source: 'no_id_present' }, gaps: new Set(['service_schema_present']), byType: {}, schemaNames: ['WebPage'] })
  assert.deepStrictEqual(result.add, [])
  assert.deepStrictEqual(result.modify, [])
  assert.strictEqual(result.unresolvedDependencies.length, 1)
  assert.ok(/does not fabricate a Service name/.test(result.unresolvedDependencies[0]))
  assert.ok(/no H1 at all/.test(result.unresolvedDependencies[0]))
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

  // ---------------------------------------------------------------------
  // buildPreparedSchemaWork (SERVICE) -- Phase B end-to-end, via a real
  // extractPageContentEvidence() pass over fake-but-realistic HTML (not a
  // hand-built contentEvidence object), so these tests exercise the actual
  // fetch -> parse -> extract -> generate pipeline exactly as production
  // does.
  // ---------------------------------------------------------------------
  await atest('buildPreparedSchemaWork (SERVICE, no existing Service node, good H1) proposes an evidence-backed Service node', async () => {
    const html = servicePageHtml({
      title: 'B2B Business Services SEO | Firestarter SEO',
      h1: 'B2B Business Services SEO',
      metaDescription: 'We help B2B companies grow through SEO.',
      jsonLdNodes: [
        { '@type': 'WebPage', url: 'https://www.firestarterseo.com/industries/b2b-business-services-seo/' },
        { '@type': 'Organization', '@id': 'https://www.firestarterseo.com/#organization', name: 'Firestarter SEO' }
      ]
    })
    const result = await buildPreparedSchemaWork({
      path: '/industries/b2b-business-services-seo/', siteUrl: 'https://www.firestarterseo.com', targetProfile: 'SERVICE',
      coreChecks: [{ id: 'service_schema_valid_when_present', status: 'pass' }],
      recommendedChecks: [{ id: 'service_schema_present', status: 'fail' }, { id: 'service_provider_relationship', status: 'fail' }],
      fetcher: fakeFetcher(html)
    })
    assert.strictEqual(result.supported, true)
    assert.strictEqual(result.add.length, 1)
    const node = result.add[0].node
    assert.strictEqual(node['@type'], 'Service')
    assert.strictEqual(node.name, 'B2B Business Services SEO')
    assert.deepStrictEqual(node.provider, { '@id': 'https://www.firestarterseo.com/#organization' })
    assert.strictEqual(node.description, 'We help B2B companies grow through SEO.')
    assert.strictEqual(node['@id'], 'https://www.firestarterseo.com/industries/b2b-business-services-seo/#service')
    assert.ok(result.add[0].evidence, 'provenance must be present on the add item')
    assert.strictEqual(result.add[0].evidence.name.value, 'B2B Business Services SEO')
  })

  await atest('buildPreparedSchemaWork (SERVICE, generic H1) stays blocked -- generic heading is never used as a name', async () => {
    const html = servicePageHtml({ title: 'Services', h1: 'Our Services', jsonLdNodes: [{ '@type': 'WebPage' }] })
    const result = await buildPreparedSchemaWork({
      path: '/services/', siteUrl: 'https://example.com', targetProfile: 'SERVICE',
      coreChecks: [{ id: 'service_schema_valid_when_present', status: 'pass' }],
      recommendedChecks: [{ id: 'service_schema_present', status: 'fail' }],
      fetcher: fakeFetcher(html)
    })
    assert.strictEqual(result.supported, false)
    assert.ok(/too generic/.test(result.unresolvedDependencies[0]))
  })

  await atest('buildPreparedSchemaWork (SERVICE, missing meta description) omits description without blocking the rest of the node', async () => {
    const html = servicePageHtml({ title: 'B2B Business Services SEO', h1: 'B2B Business Services SEO', jsonLdNodes: [{ '@type': 'WebPage' }] })
    const result = await buildPreparedSchemaWork({
      path: '/industries/b2b/', siteUrl: 'https://example.com', targetProfile: 'SERVICE',
      coreChecks: [{ id: 'service_schema_valid_when_present', status: 'pass' }],
      recommendedChecks: [{ id: 'service_schema_present', status: 'fail' }],
      fetcher: fakeFetcher(html)
    })
    assert.strictEqual(result.supported, true)
    assert.strictEqual(result.add[0].node.description, undefined)
    assert.ok(result.unresolvedDependencies.some(d => /description omitted -- insufficient approved evidence/.test(d)))
  })

  await atest('buildPreparedSchemaWork (SERVICE) repeated preparation against the identical page produces stable artifact semantics (same name/@id/provider)', async () => {
    const html = servicePageHtml({
      title: 'B2B Business Services SEO', h1: 'B2B Business Services SEO', metaDescription: 'Real description.',
      jsonLdNodes: [{ '@type': 'Organization', '@id': 'https://example.com/#organization', name: 'Acme' }]
    })
    const args = {
      path: '/industries/b2b/', siteUrl: 'https://example.com', targetProfile: 'SERVICE',
      coreChecks: [{ id: 'service_schema_valid_when_present', status: 'pass' }],
      recommendedChecks: [{ id: 'service_schema_present', status: 'fail' }]
    }
    const r1 = await buildPreparedSchemaWork({ ...args, fetcher: fakeFetcher(html) })
    const r2 = await buildPreparedSchemaWork({ ...args, fetcher: fakeFetcher(html) })
    assert.deepStrictEqual(r1.add[0].node, r2.add[0].node)
    assert.strictEqual(r1.supported, r2.supported)
  })

  console.log(`\n${passCount} passed.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
