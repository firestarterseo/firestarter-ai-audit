// Tests for lib/schemaPreparedWorkPresentation.js -- AM-facing presentation
// primitives for prepared schema work (Phase C, 2026-09-23 Step 4 AM Review
// UI correction). Plain `node`, no framework.

const assert = require('assert')
const {
  describeEvidenceSource, summarizeDiagnosisForApproval, checkSeverityTone,
  orderedPropertyKeys, buildPropertyPresentation, buildChangePresentation,
  parseUnresolvedDependency
} = require('./schemaPreparedWorkPresentation')

let passCount = 0
function test(name, fn) { fn(); passCount++; console.log(`PASS: ${name}`) }

// ---------------------------------------------------------------------
// describeEvidenceSource -- evidence source -> AM label.
// ---------------------------------------------------------------------
test('describeEvidenceSource translates known engineering sourceTypes into AM-readable phrases', () => {
  assert.strictEqual(describeEvidenceSource('h1'), 'H1 on this page')
  assert.strictEqual(describeEvidenceSource('meta_description'), 'Meta description on this page')
  assert.strictEqual(describeEvidenceSource('existing_schema_canonical_entity'), 'Existing canonical Organization schema')
  assert.strictEqual(describeEvidenceSource('title_tag'), "This page's <title>")
})

test('describeEvidenceSource humanizes an unrecognized sourceType rather than showing it raw, and never crashes on null', () => {
  assert.strictEqual(describeEvidenceSource('some_new_source_type'), 'Some New Source Type')
  assert.strictEqual(describeEvidenceSource(null), null)
  assert.strictEqual(describeEvidenceSource(undefined), null)
})

// ---------------------------------------------------------------------
// summarizeDiagnosisForApproval -- "WHY WE'RE RECOMMENDING THIS," derived
// from real diagnosis data, never a hardcoded per-client sentence.
// ---------------------------------------------------------------------
test('summarizeDiagnosisForApproval (IMPROVEMENT_AVAILABLE) uses "Recommended enhancement" language, not alarming', () => {
  const result = summarizeDiagnosisForApproval({
    finalStatus: 'IMPROVEMENT_AVAILABLE',
    coreChecks: [{ id: 'a', status: 'pass' }],
    recommendedChecks: [{ id: 'service_schema_present', status: 'fail', evidence: 'No Service schema found on this commercial service page.' }]
  })
  assert.strictEqual(result.severity, 'recommended')
  assert.strictEqual(result.headline, 'Recommended enhancement, not a Core issue')
  assert.ok(/structurally valid/.test(result.detail))
  assert.ok(/No Service schema found/.test(result.detail))
})

test('summarizeDiagnosisForApproval (ACTION_REQUIRED) uses stronger, non-sensational "Core schema issue" language', () => {
  const result = summarizeDiagnosisForApproval({
    finalStatus: 'ACTION_REQUIRED',
    coreChecks: [{ id: 'x', status: 'fail', evidence: 'A Service node is missing its name.' }],
    recommendedChecks: []
  })
  assert.strictEqual(result.severity, 'core')
  assert.strictEqual(result.headline, 'Core schema issue requires attention')
  assert.strictEqual(result.detail, 'A Service node is missing its name.')
})

test('summarizeDiagnosisForApproval never crashes on NO_ACTION_NEEDED/COULD_NOT_VERIFY (not expected in review, but handled honestly)', () => {
  assert.strictEqual(summarizeDiagnosisForApproval({ finalStatus: 'NO_ACTION_NEEDED' }).severity, 'neutral')
  assert.strictEqual(summarizeDiagnosisForApproval({}).severity, 'neutral')
})

// ---------------------------------------------------------------------
// checkSeverityTone -- Core fail stays critical; Recommended fail is
// neutral/amber, never styled as identically alarming (section 5).
// ---------------------------------------------------------------------
test('checkSeverityTone: a failing Core check stays issue-critical', () => {
  assert.strictEqual(checkSeverityTone({ tier: 'core', status: 'fail' }), 'issue-critical')
})

test('checkSeverityTone: a failing Recommended check is issue-minor, never issue-critical', () => {
  assert.strictEqual(checkSeverityTone({ tier: 'recommended', status: 'fail' }), 'issue-minor')
})

test('checkSeverityTone: a passing check of either tier is issue-passing', () => {
  assert.strictEqual(checkSeverityTone({ tier: 'core', status: 'pass' }), 'issue-passing')
  assert.strictEqual(checkSeverityTone({ tier: 'recommended', status: 'pass' }), 'issue-passing')
})

// ---------------------------------------------------------------------
// orderedPropertyKeys / buildPropertyPresentation / buildChangePresentation
// ---------------------------------------------------------------------
test('orderedPropertyKeys excludes @context/@type and orders known properties first', () => {
  const node = { '@context': 'https://schema.org', '@type': 'Service', url: 'https://x/', name: 'X', '@id': 'https://x/#service', provider: { '@id': 'https://x/#org' } }
  assert.deepStrictEqual(orderedPropertyKeys(node), ['name', 'provider', 'url', '@id'])
})

test('orderedPropertyKeys appends an unrecognized property after the known ones, never dropping it', () => {
  const node = { '@type': 'Service', name: 'X', someFutureProperty: 'Y' }
  assert.deepStrictEqual(orderedPropertyKeys(node), ['name', 'someFutureProperty'])
})

test('buildPropertyPresentation: a real, evidence-backed scalar property gets its value and source label', () => {
  const node = { name: 'Strategic SEO for B2B Companies & Business Service Providers' }
  const evidence = { name: { value: node.name, sourceType: 'h1', evidenceClass: 'OBSERVED_PAGE_CONTENT' } }
  const result = buildPropertyPresentation('name', node, evidence, null)
  assert.strictEqual(result.value, node.name)
  assert.strictEqual(result.sourceLabel, 'H1 on this page')
  assert.strictEqual(result.label, 'name')
})

test('buildPropertyPresentation: a missing property returns null, never a fabricated row', () => {
  assert.strictEqual(buildPropertyPresentation('description', { name: 'X' }, null, null), null)
})

test('buildPropertyPresentation: provider shows the real canonical entity NAME as the headline value, with the @id URL as supporting detail, never the bare URL as the primary value', () => {
  const node = { provider: { '@id': 'https://www.firestarterseo.com/#organization' } }
  const evidence = { provider: { sourceType: 'existing_schema_canonical_entity' } }
  const canonicalEntity = { id: 'https://www.firestarterseo.com/#organization', resolved: true, entityName: 'Firestarter SEO' }
  const result = buildPropertyPresentation('provider', node, evidence, canonicalEntity)
  assert.strictEqual(result.value, 'Firestarter SEO')
  assert.strictEqual(result.supportingDetail, 'https://www.firestarterseo.com/#organization')
  assert.strictEqual(result.sourceLabel, 'Existing canonical Organization schema')
})

test('buildPropertyPresentation: provider with no known entity name falls back to the @id URL as the value, not a fabricated name', () => {
  const node = { provider: { '@id': 'https://example.com/#organization' } }
  const result = buildPropertyPresentation('provider', node, null, { resolved: true, entityName: null })
  assert.strictEqual(result.value, 'https://example.com/#organization')
  assert.strictEqual(result.supportingDetail, null)
})

test('buildPropertyPresentation: url/@id get a structural source label even with no per-property evidence (legacy or new)', () => {
  const node = { url: 'https://example.com/about/', '@id': 'https://example.com/about/#aboutpage' }
  const urlResult = buildPropertyPresentation('url', node, null, null)
  const idResult = buildPropertyPresentation('@id', node, null, null)
  assert.strictEqual(urlResult.sourceLabel, "This page's resolved URL")
  assert.strictEqual(idResult.sourceLabel, "Derived from this page's canonical URL")
})

test('buildChangePresentation: the real evidence-backed Service ADD item renders every property with correct source labels', () => {
  const item = {
    node: {
      '@context': 'https://schema.org', '@type': 'Service',
      '@id': 'https://www.firestarterseo.com/industries/b2b-business-services-seo/#service',
      url: 'https://www.firestarterseo.com/industries/b2b-business-services-seo/',
      name: 'Strategic SEO for B2B Companies & Business Service Providers',
      provider: { '@id': 'https://www.firestarterseo.com/#organization' },
      description: 'Drive qualified B2B leads with proven SEO.'
    },
    evidence: {
      name: { sourceType: 'h1', value: 'Strategic SEO for B2B Companies & Business Service Providers' },
      provider: { sourceType: 'existing_schema_canonical_entity', value: 'https://www.firestarterseo.com/#organization' },
      description: { sourceType: 'meta_description', value: 'Drive qualified B2B leads with proven SEO.' }
    },
    description: 'Service node, name from this page\'s <h1>...'
  }
  const canonicalEntity = { resolved: true, entityName: 'Firestarter SEO', id: 'https://www.firestarterseo.com/#organization' }
  const result = buildChangePresentation(item, 'add', canonicalEntity)
  assert.strictEqual(result.kind, 'add')
  assert.strictEqual(result.nodeType, 'Service')
  assert.strictEqual(result.fallbackDescription, null, 'a real property list must be used instead of the fallback prose')
  const byKey = Object.fromEntries(result.properties.map(p => [p.key, p]))
  assert.strictEqual(byKey.name.sourceLabel, 'H1 on this page')
  assert.strictEqual(byKey.description.sourceLabel, 'Meta description on this page')
  assert.strictEqual(byKey.provider.value, 'Firestarter SEO')
  assert.strictEqual(byKey.url.sourceLabel, "This page's resolved URL")
  assert.strictEqual(byKey['@id'].sourceLabel, "Derived from this page's canonical URL")
})

test('buildChangePresentation: a legacy MODIFY item with no per-property evidence still renders its real property (About/Contact regression)', () => {
  const item = { description: 'Add "about": {"@id": "https://example.com/#organization"} to the existing AboutPage node', node: { about: { '@id': 'https://example.com/#organization' } } }
  const canonicalEntity = { resolved: true, entityName: 'Acme Co', id: 'https://example.com/#organization' }
  const result = buildChangePresentation(item, 'modify', canonicalEntity)
  assert.strictEqual(result.nodeType, null, 'a modify patch carries no @type of its own')
  assert.strictEqual(result.properties.length, 1)
  assert.strictEqual(result.properties[0].key, 'about')
  assert.strictEqual(result.properties[0].value, 'Acme Co', 'even a legacy item benefits from the shared canonicalEntity name lookup')
  assert.strictEqual(result.properties[0].sourceLabel, null, 'no per-property evidence exists on a legacy item -- never fabricated')
  assert.strictEqual(result.fallbackDescription, null)
})

test('buildChangePresentation: an item with no presentable properties at all falls back to its prose description, never a blank view', () => {
  const item = { description: 'Some legacy change with an unrecognized shape', node: {} }
  const result = buildChangePresentation(item, 'add', null)
  assert.strictEqual(result.properties.length, 0)
  assert.strictEqual(result.fallbackDescription, 'Some legacy change with an unrecognized shape')
})

test('buildChangePresentation: a null/undefined item returns null rather than throwing', () => {
  assert.strictEqual(buildChangePresentation(null, 'add', null), null)
  assert.strictEqual(buildChangePresentation(undefined, 'remove', null), null)
})

// ---------------------------------------------------------------------
// parseUnresolvedDependency -- "WHAT WE'RE DELIBERATELY LEAVING OUT."
// ---------------------------------------------------------------------
test('parseUnresolvedDependency extracts property + reason from the real serviceType/areaServed/description messages', () => {
  assert.deepStrictEqual(
    parseUnresolvedDependency('serviceType unresolved -- not inferred in this phase; add the specific service classification manually if desired.'),
    { property: 'serviceType', reason: 'not inferred in this phase; add the specific service classification manually if desired.' }
  )
  assert.deepStrictEqual(
    parseUnresolvedDependency('areaServed unresolved -- page-level geographic evidence has not yet been approved for automatic mapping.'),
    { property: 'areaServed', reason: 'page-level geographic evidence has not yet been approved for automatic mapping.' }
  )
  assert.deepStrictEqual(
    parseUnresolvedDependency('description omitted -- insufficient approved evidence'),
    { property: 'description', reason: 'insufficient approved evidence' }
  )
})

test('parseUnresolvedDependency falls back to property:null for a sentence that does not lead with a bare property name (never fabricates one)', () => {
  const text = 'A canonical Organization @id could not be confidently identified on this page (no_id_present). The "provider" reference on the new Service node was left out rather than fabricated -- resolve a stable, reused canonical Organization @id before this relationship can be added.'
  const result = parseUnresolvedDependency(text)
  assert.strictEqual(result.property, null)
  assert.strictEqual(result.reason, text)
})

console.log(`\n${passCount} passed.`)
