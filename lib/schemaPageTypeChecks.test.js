// Tests for lib/schemaPageTypeChecks.js -- the page-type-dispatched check
// registry (Phase B of the Schema page-workflow redesign). Plain `node`,
// no framework, matching every other lib/*.test.js in this project.

const assert = require('assert')
const { runPageTypeChecks, applicableChecksForType } = require('./schemaPageTypeChecks')

let passCount = 0
function test(name, fn) {
  fn()
  passCount++
  console.log(`PASS: ${name}`)
}

// TEST 1: a Service page never runs Home-only checks (WebSite+SearchAction,
// sameAs, business-entity, address/telephone) -- they must appear in
// notApplicable, never in applicable or missingOrInvalid, even when the
// page has none of that schema at all.
test('Service page: Home-only checks are notApplicable, not missing', () => {
  const result = runPageTypeChecks('Service', { byType: {}, schemaNames: [], failed: [] })
  const notApplicableIds = result.notApplicable.map(c => c.id)
  ;['business_entity_schema', 'same_as_links', 'address_telephone', 'website_search_action'].forEach(id => {
    assert.ok(notApplicableIds.includes(id), `${id} should be notApplicable for Service`)
    assert.ok(!result.missingOrInvalid.some(c => c.id === id), `${id} should not be in missingOrInvalid for Service`)
  })
})

// TEST 2: a Service page WITH real Service schema + provider passes its
// applicable checks and has no actionable gap.
test('Service page with real Service schema + provider + breadcrumbs: no actionable gap', () => {
  const byType = {
    Service: [{ '@type': 'Service', provider: { '@type': 'Organization', name: 'Acme' } }],
    BreadcrumbList: [{ '@type': 'BreadcrumbList', itemListElement: [] }]
  }
  const result = runPageTypeChecks('Service', { byType, schemaNames: ['Service', 'BreadcrumbList'], failed: [] })
  assert.strictEqual(result.actionableGap, false)
  assert.ok(result.applicable.some(c => c.id === 'service_schema_present'))
  assert.strictEqual(result.missingOrInvalid.length, 0)
})

// TEST 3: a Service page with NO schema at all has an actionable gap, and
// the missing checks are genuinely Service-applicable ones.
test('Service page with no schema: actionable gap, Service-specific misses', () => {
  const result = runPageTypeChecks('Service', { byType: {}, schemaNames: [], failed: [] })
  assert.strictEqual(result.actionableGap, true)
  const missingIds = result.missingOrInvalid.map(c => c.id)
  assert.ok(missingIds.includes('structured_data_present'))
  assert.ok(missingIds.includes('service_schema_present'))
})

// TEST 4: an Article page runs Article checks, not Service checks.
test('Article page runs Article checks, not Service checks', () => {
  const applicable = applicableChecksForType('Article')
  assert.ok(applicable.includes('article_schema_present'))
  assert.ok(applicable.includes('headline_title'))
  assert.ok(!applicable.includes('service_schema_present'))
})

// TEST 5: a fully-formed Article (headline, author, datePublished, publisher)
// has no actionable gap.
test('Complete Article schema: no actionable gap', () => {
  const byType = {
    Article: [{ '@type': 'Article', headline: 'Title', author: { name: 'A' }, datePublished: '2026-01-01', publisher: { name: 'Firestarter' } }],
    BreadcrumbList: [{ '@type': 'BreadcrumbList', itemListElement: [] }]
  }
  const result = runPageTypeChecks('Article', { byType, schemaNames: ['Article', 'BreadcrumbList'], failed: [] })
  assert.strictEqual(result.actionableGap, false)
})

// TEST 6: an Article missing datePublished (and nothing else) has an
// actionable gap containing exactly that one missing check (plus whatever
// else is genuinely absent) -- never a homepage-only check.
test('Article missing datePublished: gap contains date_published, not Home-only checks', () => {
  const byType = { Article: [{ '@type': 'Article', headline: 'Title', author: { name: 'A' }, publisher: { name: 'Firestarter' } }] }
  const result = runPageTypeChecks('Article', { byType, schemaNames: ['Article'], failed: [] })
  const missingIds = result.missingOrInvalid.map(c => c.id)
  assert.ok(missingIds.includes('date_published'))
  assert.ok(missingIds.includes('breadcrumb_list'))
  assert.ok(!missingIds.includes('website_search_action'))
})

// TEST 7: Home's applicable list is exactly the same 7 checks
// checker.js's checkSchemaAndStructure() already runs.
test('Home applicable list matches the existing 7 homepage checks', () => {
  const applicable = applicableChecksForType('Home')
  assert.strictEqual(applicable.length, 7)
  assert.deepStrictEqual(new Set(applicable), new Set([
    'structured_data_present', 'business_entity_schema', 'same_as_links',
    'address_telephone', 'website_search_action', 'breadcrumb_list', 'required_properties'
  ]))
})

// TEST 8: an unmapped page type (Product, Landing Page, Utility/Legal,
// Other, or anything future) falls back to the minimal, genuinely-universal
// default set -- never fabricates a Service/Article-specific expectation.
test('Unmapped page type falls back to the minimal default check set', () => {
  ;['Product', 'Landing Page', 'Utility/Legal', 'Other', 'SomeFuturePageType'].forEach(type => {
    const applicable = applicableChecksForType(type)
    assert.deepStrictEqual(applicable, ['structured_data_present', 'breadcrumb_list', 'required_properties'])
  })
})

// TEST 9: Case Study runs its own check list, not Article's or Service's.
test('Case Study page runs its own applicable list', () => {
  const applicable = applicableChecksForType('Case Study')
  assert.ok(applicable.includes('case_study_schema_present'))
  assert.ok(!applicable.includes('article_schema_present'))
  assert.ok(!applicable.includes('service_schema_present'))
})

// TEST 10: currentSchema always reflects exactly what's on the page,
// regardless of page type or applicability -- an honest "what's there"
// list, never filtered by relevance.
test('currentSchema is unfiltered regardless of page type', () => {
  const result = runPageTypeChecks('Service', { byType: {}, schemaNames: ['FAQPage', 'Organization'], failed: [] })
  assert.deepStrictEqual(result.currentSchema, ['FAQPage', 'Organization'])
})

// TEST 11: required_properties failures carry the real failed-property
// detail, not just a bare "missing" label.
test('required_properties failure carries real failedProperties detail', () => {
  const failed = [{ type: 'Organization', prop: 'url', test: 'Organization."url"', description: 'Organization is missing required property "url"' }]
  const result = runPageTypeChecks('Home', { byType: {}, schemaNames: [], failed })
  const entry = result.missingOrInvalid.find(c => c.id === 'required_properties')
  assert.ok(entry)
  assert.deepStrictEqual(entry.failedProperties, ['Organization is missing required property "url"'])
})

// TEST 12: every applicable entry carries a real status and a non-empty,
// data-derived evidence string -- PRODUCT DECISION (2026-09-02 PAGE
// ANALYSIS RESULT UX pass): "Do not just show a lifecycle state... display
// check-by-check results: check name, PASS/FAIL, short evidence/reason."
test('Every applicable check carries status + non-empty evidence', () => {
  const byType = { Organization: [{ '@type': 'Organization', name: 'Firestarter', url: 'https://firestarterseo.com' }] }
  const result = runPageTypeChecks('About', { byType, schemaNames: ['Organization'], failed: [] })
  assert.ok(result.applicable.length > 0)
  result.applicable.forEach(c => {
    assert.ok(c.status === 'pass' || c.status === 'fail', `${c.id} must carry a real status`)
    assert.ok(typeof c.evidence === 'string' && c.evidence.length > 0, `${c.id} must carry non-empty evidence`)
  })
})

// TEST 13: a PASSING page's evidence names the REAL schema type(s) found --
// never a generic "OK". This is what lets a "No action needed" page still
// show the AM what schema justified that conclusion.
test('Passing business_entity_schema evidence names the real schema type found', () => {
  const byType = { Organization: [{ '@type': 'Organization', name: 'Firestarter', url: 'https://firestarterseo.com' }] }
  const result = runPageTypeChecks('About', { byType, schemaNames: ['Organization'], failed: [] })
  const entry = result.applicable.find(c => c.id === 'business_entity_schema')
  assert.strictEqual(entry.status, 'pass')
  assert.ok(entry.evidence.includes('Organization'), 'evidence must name the real schema type, not a generic pass message')
})

// TEST 14: a FAILING check's evidence explains what's missing, and that
// same check appears in missingOrInvalid with matching evidence.
test('Failing check evidence explains the gap, and matches missingOrInvalid', () => {
  const result = runPageTypeChecks('Contact', { byType: {}, schemaNames: [], failed: [] })
  const applicableEntry = result.applicable.find(c => c.id === 'business_entity_schema')
  const missingEntry = result.missingOrInvalid.find(c => c.id === 'business_entity_schema')
  assert.strictEqual(applicableEntry.status, 'fail')
  assert.strictEqual(applicableEntry.evidence, missingEntry.evidence)
  assert.ok(/no localbusiness\/organization/i.test(applicableEntry.evidence))
})

// TEST 15: notApplicable checks are never evaluated and never counted as a
// failure -- PRODUCT DECISION: "SHOW NOT APPLICABLE SEPARATELY... Do not
// count these as failures."
test('notApplicable checks are never in missingOrInvalid and never affect actionableGap', () => {
  // A Contact page with a real business entity + address/telephone + breadcrumbs:
  // no actionable gap, even though Article/Service-only checks are
  // (correctly) notApplicable, not silently-passing or silently-failing.
  const byType = {
    Organization: [{ '@type': 'Organization', name: 'Firestarter', address: '123 Main St', telephone: '555-1234' }],
    BreadcrumbList: [{ '@type': 'BreadcrumbList', itemListElement: [] }]
  }
  const result = runPageTypeChecks('Contact', { byType, schemaNames: ['Organization', 'BreadcrumbList'], failed: [] })
  assert.strictEqual(result.actionableGap, false)
  const notApplicableIds = result.notApplicable.map(c => c.id)
  assert.ok(notApplicableIds.includes('service_schema_present'))
  assert.ok(notApplicableIds.includes('article_schema_present'))
  notApplicableIds.forEach(id => {
    assert.ok(!result.missingOrInvalid.some(m => m.id === id), `${id} is notApplicable and must never appear in missingOrInvalid`)
  })
})

console.log(`\n${passCount} passed.`)
