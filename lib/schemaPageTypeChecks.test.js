// Tests for lib/schemaPageTypeChecks.js -- the DIAGNOSTIC METHODOLOGY
// registry (2026-09-03 pass), replacing the shallow "does some business
// entity exist anywhere" registry built 2026-09-02. Plain `node`, no
// framework, matching every other lib/*.test.js in this project.

const assert = require('assert')
const {
  runPageTypeChecks, runChecksForProfile, resolveTargetProfile,
  resolveLocationProfile, resolveEntityReference, isLocationHubPath,
  computeFinalStatus, TARGET_PROFILES, buildContext
} = require('./schemaPageTypeChecks')

let passCount = 0
function test(name, fn) {
  fn()
  passCount++
  console.log(`PASS: ${name}`)
}

// ctxOf mirrors exactly what lib/pageAnalysis.js hands runPageTypeChecks --
// raw byType/schemaNames/etc through buildContext -- so every test here
// exercises the real businessEntityNodes/articleLikeNodes derivation, not a
// hand-rolled shortcut that could drift from the real contract.
function ctxOf({ byType = {}, schemaNames, failed = [], scriptCount = 0, parseFailureCount = 0, path = null } = {}) {
  return buildContext({ byType, schemaNames: schemaNames || Object.keys(byType), failed, scriptCount, parseFailureCount, path })
}

// =====================================================================
// resolveEntityReference -- the entity-graph primitive (correction #9)
// =====================================================================

test('resolveEntityReference: absent when the property is missing entirely', () => {
  assert.strictEqual(resolveEntityReference(undefined, []), 'absent')
  assert.strictEqual(resolveEntityReference(null, []), 'absent')
})

test('resolveEntityReference: valid for an embedded business-entity node with a name', () => {
  const value = { '@type': 'Organization', name: 'Firestarter' }
  assert.strictEqual(resolveEntityReference(value, []), 'valid')
})

test('resolveEntityReference: invalid for an embedded object with no @type/@id/name', () => {
  assert.strictEqual(resolveEntityReference({}, []), 'invalid')
})

test('resolveEntityReference: valid when @id matches a real business-entity node on the page', () => {
  const nodes = [{ '@type': 'Organization', name: 'Firestarter', '@id': 'https://x.com/#org' }]
  assert.strictEqual(resolveEntityReference({ '@id': 'https://x.com/#org' }, nodes), 'valid')
})

test('resolveEntityReference: invalid when @id does NOT match any business-entity node on the page -- correction #9\'s exact case (a random sitewide node cannot satisfy a reference it was never actually linked to)', () => {
  const nodes = [{ '@type': 'Organization', name: 'Firestarter', '@id': 'https://x.com/#org' }]
  assert.strictEqual(resolveEntityReference({ '@id': 'https://x.com/#some-other-thing' }, nodes), 'invalid')
})

test('resolveEntityReference: a bare string only resolves valid if it matches a real entity\'s name', () => {
  const nodes = [{ '@type': 'Organization', name: 'Firestarter' }]
  assert.strictEqual(resolveEntityReference('Firestarter', nodes), 'valid')
  assert.strictEqual(resolveEntityReference('Some Unrelated Company', nodes), 'invalid')
})

// =====================================================================
// isLocationHubPath / resolveLocationProfile -- correction #5
// =====================================================================

test('isLocationHubPath: true only for the bare index path, never a leaf beneath it', () => {
  assert.strictEqual(isLocationHubPath('/locations/'), true)
  assert.strictEqual(isLocationHubPath('/locations'), true)
  assert.strictEqual(isLocationHubPath('/service-areas/'), true)
  assert.strictEqual(isLocationHubPath('/areas-we-serve/'), true)
  assert.strictEqual(isLocationHubPath('/locations/colorado-springs-seo/'), false)
  assert.strictEqual(isLocationHubPath('/denver-seo-agency/'), false)
})

test('resolveLocationProfile: the bare hub path resolves to LOCATION_HUB regardless of on-page schema', () => {
  assert.strictEqual(resolveLocationProfile('/locations/', ctxOf({ byType: {} })), 'LOCATION_HUB')
})

test('resolveLocationProfile: a leaf page with NO physical-business claim resolves to the conservative SERVICE_AREA default -- correction #12\'s "do not infer physical office status from URL alone" means we do not assume PHYSICAL either', () => {
  const ctx = ctxOf({ byType: { Service: [{ name: 'SEO in Colorado Springs' }] } })
  assert.strictEqual(resolveLocationProfile('/locations/colorado-springs-seo/', ctx), 'SERVICE_AREA')
})

test('resolveLocationProfile: a leaf page WITH an unverified LocalBusiness/address claim resolves to LOCATION_UNCONFIRMED, never silently trusted as PHYSICAL_LOCATION', () => {
  const ctx = ctxOf({ byType: { LocalBusiness: [{ name: 'Firestarter Colorado Springs', address: { streetAddress: '1 Main St' } }] } })
  assert.strictEqual(resolveLocationProfile('/locations/colorado-springs-seo/', ctx), 'LOCATION_UNCONFIRMED')
})

test('resolveLocationProfile: a plain sitewide Organization with an address (not a LocalBusiness-subtype claim) does NOT trigger LOCATION_UNCONFIRMED -- Organization is normal sitewide identity schema, not a page-specific physical-business claim', () => {
  const ctx = ctxOf({ byType: { Organization: [{ name: 'Firestarter', address: { streetAddress: '1 Main St' } }] } })
  assert.strictEqual(resolveLocationProfile('/locations/colorado-springs-seo/', ctx), 'SERVICE_AREA')
})

test('resolveTargetProfile: never auto-selects PHYSICAL_LOCATION this pass, even with a strong physical claim -- see file header for why', () => {
  const ctx = ctxOf({ byType: { LocalBusiness: [{ name: 'Firestarter Denver', address: { streetAddress: '1 Main St' }, telephone: '303-555-0100' }] } })
  assert.notStrictEqual(resolveTargetProfile('Location', ctx), 'PHYSICAL_LOCATION')
})

// =====================================================================
// structured_data_parses -- distinguishes "absent" from "broken"
// =====================================================================

test('structured_data_parses: passes vacuously when there is no JSON-LD at all', () => {
  const result = runChecksForProfile('ABOUT', ctxOf({ byType: {}, schemaNames: [], scriptCount: 0, parseFailureCount: 0 }))
  const check = result.coreChecks.find(c => c.id === 'structured_data_parses')
  assert.strictEqual(check.status, 'fail') // absent -- but NOT "invalid/broken"
  assert.strictEqual(check.state, 'TYPE_ABSENT')
})

test('structured_data_parses: fails as genuinely BROKEN when every script tag failed to parse -- distinct from "absent"', () => {
  const result = runChecksForProfile('ABOUT', ctxOf({ byType: {}, schemaNames: [], scriptCount: 2, parseFailureCount: 2 }))
  const check = result.coreChecks.find(c => c.id === 'structured_data_parses')
  assert.strictEqual(check.status, 'fail')
  assert.strictEqual(check.state, 'TYPE_PRESENT_INVALID_INCOMPLETE')
  assert.ok(/failed to parse/.test(check.evidence))
})

test('structured_data_parses: passes when schema exists, regardless of unrelated parse failures elsewhere on the page', () => {
  const result = runChecksForProfile('ABOUT', ctxOf({ byType: { WebPage: [{}] }, schemaNames: ['WebPage'], scriptCount: 2, parseFailureCount: 1 }))
  const check = result.coreChecks.find(c => c.id === 'structured_data_parses')
  assert.strictEqual(check.status, 'pass')
})

// =====================================================================
// ABOUT -- corrections #1/#2: missing AboutPage subtype is NOT Core
// =====================================================================

test('ABOUT: a generic WebPage with no AboutPage subtype and no relationship is NO Core failure -- correction #2\'s exact instruction', () => {
  const ctx = ctxOf({ byType: { WebPage: [{ '@id': 'x' }] }, schemaNames: ['WebPage'] })
  const result = runChecksForProfile('ABOUT', ctx)
  assert.ok(result.coreChecks.every(c => c.status === 'pass'), 'no Core check should fail merely for lacking the AboutPage subtype')
  assert.strictEqual(result.finalStatus, 'IMPROVEMENT_AVAILABLE', 'missing the subtype/relationship should surface as an improvement, never ACTION_REQUIRED')
})

test('ABOUT: zero schema at all IS a Core failure (missing the primary schema representation)', () => {
  const ctx = ctxOf({ byType: {}, schemaNames: [] })
  const result = runChecksForProfile('ABOUT', ctx)
  assert.strictEqual(result.finalStatus, 'ACTION_REQUIRED')
})

test('ABOUT: a real AboutPage with a valid mainEntity relationship and BreadcrumbList -> NO_ACTION_NEEDED', () => {
  const org = { '@type': 'Organization', name: 'Firestarter' }
  const ctx = ctxOf({
    byType: { AboutPage: [{ mainEntity: org }], Organization: [org], BreadcrumbList: [{}] },
    schemaNames: ['AboutPage', 'Organization', 'BreadcrumbList']
  })
  const result = runChecksForProfile('ABOUT', ctx)
  assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
})

test('ABOUT: a mainEntity relationship that does NOT resolve to a real entity on the page IS a Core failure (materially misrepresented) -- correction #9', () => {
  const ctx = ctxOf({
    byType: { AboutPage: [{ mainEntity: { '@id': 'https://x.com/#nowhere' } }] },
    schemaNames: ['AboutPage']
  })
  const result = runChecksForProfile('ABOUT', ctx)
  const check = result.coreChecks.find(c => c.id === 'about_entity_relationship_valid_when_present')
  assert.strictEqual(check.status, 'fail')
  assert.strictEqual(result.finalStatus, 'ACTION_REQUIRED')
})

// =====================================================================
// CONTACT -- correction #3
// =====================================================================

test('CONTACT: missing ContactPage subtype alone is NOT Core -- IMPROVEMENT_AVAILABLE, not ACTION_REQUIRED', () => {
  const ctx = ctxOf({ byType: { WebPage: [{}] }, schemaNames: ['WebPage'] })
  const result = runChecksForProfile('CONTACT', ctx)
  assert.ok(result.coreChecks.every(c => c.status === 'pass'))
  assert.strictEqual(result.finalStatus, 'IMPROVEMENT_AVAILABLE')
})

test('CONTACT: a malformed address (not an object) on the business entity IS a Core failure -- "no unsupported/fabricated business/contact claims"', () => {
  const ctx = ctxOf({
    byType: { Organization: [{ name: 'Firestarter', address: 'not a real address object' }], WebPage: [{}] },
    schemaNames: ['Organization', 'WebPage']
  })
  const result = runChecksForProfile('CONTACT', ctx)
  const check = result.coreChecks.find(c => c.id === 'contact_no_fabricated_claims')
  assert.strictEqual(check.status, 'fail')
  assert.strictEqual(result.finalStatus, 'ACTION_REQUIRED')
})

// =====================================================================
// SERVICE -- correction #4: missing Service is IMPROVEMENT_AVAILABLE, not Core
// =====================================================================

test('SERVICE: a page with SOME unrelated schema but no Service node -> IMPROVEMENT_AVAILABLE, never ACTION_REQUIRED (explicit correction: promote to Core later based on evidence)', () => {
  const ctx = ctxOf({ byType: { WebPage: [{}] }, schemaNames: ['WebPage'] })
  const result = runChecksForProfile('SERVICE', ctx)
  assert.ok(result.coreChecks.every(c => c.status === 'pass'))
  assert.strictEqual(result.finalStatus, 'IMPROVEMENT_AVAILABLE')
  const svcCheck = result.recommendedChecks.find(c => c.id === 'service_schema_present')
  assert.strictEqual(svcCheck.status, 'fail')
})

test('SERVICE: a Service node whose provider names a DIFFERENT business than the one this page otherwise declares IS a Core failure -- a real misrepresentation risk, not just an incompleteness', () => {
  const ctx = ctxOf({
    byType: {
      Service: [{ name: 'SEO Services', provider: { '@type': 'Organization', name: 'A Totally Different Company' } }],
      Organization: [{ '@type': 'Organization', name: 'Firestarter' }]
    },
    schemaNames: ['Service', 'Organization']
  })
  const result = runChecksForProfile('SERVICE', ctx)
  const check = result.coreChecks.find(c => c.id === 'service_schema_valid_when_present')
  assert.strictEqual(check.status, 'fail')
  assert.strictEqual(result.finalStatus, 'ACTION_REQUIRED')
})

test('SERVICE: a complete, valid Service page -> NO_ACTION_NEEDED', () => {
  const org = { '@type': 'Organization', name: 'Firestarter' }
  const ctx = ctxOf({
    byType: {
      Service: [{ name: 'SEO Services', description: 'Full-service SEO', areaServed: 'Denver, CO', provider: org }],
      Organization: [org], BreadcrumbList: [{}]
    },
    schemaNames: ['Service', 'Organization', 'BreadcrumbList'],
    failed: []
  })
  const result = runChecksForProfile('SERVICE', ctx)
  assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
})

// =====================================================================
// LOCATION_HUB / SERVICE_AREA -- AVOID: fabricated physical-business claim
// =====================================================================

test('LOCATION_HUB: a page-specific LocalBusiness+address claim is flagged as an AVOID violation, never silently accepted', () => {
  const ctx = ctxOf({
    byType: { WebPage: [{}], LocalBusiness: [{ name: 'Firestarter', address: { streetAddress: '1 Main St' } }] },
    schemaNames: ['WebPage', 'LocalBusiness'], path: '/locations/'
  })
  const result = runChecksForProfile('LOCATION_HUB', ctx)
  assert.strictEqual(result.avoidFindings.length, 1)
  assert.strictEqual(result.avoidFindings[0].id, 'location_no_physical_business_claim')
})

test('LOCATION_HUB: a plain sitewide Organization (no address-bearing LocalBusiness subtype) triggers no AVOID finding', () => {
  const ctx = ctxOf({ byType: { WebPage: [{}], Organization: [{ name: 'Firestarter' }] }, schemaNames: ['WebPage', 'Organization'], path: '/locations/' })
  const result = runChecksForProfile('LOCATION_HUB', ctx)
  assert.strictEqual(result.avoidFindings.length, 0)
})

test('LOCATION_HUB: address/telephone concepts are explicitly NOT_APPLICABLE, not silently omitted', () => {
  const result = runChecksForProfile('LOCATION_HUB', ctxOf({ byType: {}, schemaNames: [] }))
  const naIds = result.notApplicable.map(c => c.id)
  assert.ok(naIds.includes('physical_location_address_present'))
  assert.ok(naIds.includes('physical_location_telephone_present'))
})

test('SERVICE_AREA: a genuine service-area page (Service + provider + areaServed + breadcrumbs, no LocalBusiness claim) -> NO_ACTION_NEEDED, and reports zero AVOID findings', () => {
  const org = { '@type': 'Organization', name: 'Firestarter' }
  const ctx = ctxOf({
    byType: { WebPage: [{}], Service: [{ provider: org, areaServed: 'Colorado Springs, CO' }], Organization: [org], BreadcrumbList: [{}] },
    schemaNames: ['WebPage', 'Service', 'Organization', 'BreadcrumbList']
  })
  const result = runChecksForProfile('SERVICE_AREA', ctx)
  assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
  assert.strictEqual(result.avoidFindings.length, 0)
})

// =====================================================================
// LOCATION_UNCONFIRMED -- "do not guess," return the uncertainty explicitly
// =====================================================================

test('LOCATION_UNCONFIRMED: even with structured data present and valid, final status is COULD_NOT_VERIFY, never NO_ACTION_NEEDED -- "do not guess"', () => {
  const ctx = ctxOf({ byType: { WebPage: [{}] }, schemaNames: ['WebPage'] })
  const result = runChecksForProfile('LOCATION_UNCONFIRMED', ctx)
  assert.strictEqual(result.finalStatus, 'COULD_NOT_VERIFY')
})

test('LOCATION_UNCONFIRMED: a genuinely broken page (all JSON-LD malformed) still reports ACTION_REQUIRED -- a real defect is not masked by profile uncertainty', () => {
  const ctx = ctxOf({ byType: {}, schemaNames: [], scriptCount: 1, parseFailureCount: 1 })
  const result = runChecksForProfile('LOCATION_UNCONFIRMED', ctx)
  assert.strictEqual(result.finalStatus, 'ACTION_REQUIRED')
})

test('LOCATION_UNCONFIRMED: an unverified physical-business claim is itself flagged via AVOID, not just left implicit', () => {
  const ctx = ctxOf({ byType: { LocalBusiness: [{ name: 'X', address: { streetAddress: '1 Main St' } }] }, schemaNames: ['LocalBusiness'] })
  const result = runChecksForProfile('LOCATION_UNCONFIRMED', ctx)
  assert.strictEqual(result.avoidFindings.length, 1)
})

// =====================================================================
// PHYSICAL_LOCATION -- fully implemented and testable, even though the
// auto-resolver never selects it this pass (see file header)
// =====================================================================

test('PHYSICAL_LOCATION: no LocalBusiness-family node at all is a Core failure (this profile REQUIRES one to represent a real office)', () => {
  const result = runChecksForProfile('PHYSICAL_LOCATION', ctxOf({ byType: {}, schemaNames: [] }))
  assert.strictEqual(result.finalStatus, 'ACTION_REQUIRED')
})

test('PHYSICAL_LOCATION: a complete branch record (subtype, address, telephone, parentOrganization, hours) -> NO_ACTION_NEEDED', () => {
  const ctx = ctxOf({
    byType: {
      ProfessionalService: [{
        name: 'Firestarter Denver Office', address: { streetAddress: '4700 S Syracuse St', addressLocality: 'Denver' },
        telephone: '303-555-0100', parentOrganization: { '@id': 'https://firestarterseo.com/#org' },
        geo: { '@type': 'GeoCoordinates', latitude: 39.6, longitude: -104.9 }
      }],
      Organization: [{ '@type': 'Organization', name: 'Firestarter', '@id': 'https://firestarterseo.com/#org' }],
      BreadcrumbList: [{}]
    },
    schemaNames: ['ProfessionalService', 'Organization', 'BreadcrumbList']
  })
  const result = runChecksForProfile('PHYSICAL_LOCATION', ctx)
  assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
})

// =====================================================================
// ARTICLE -- correction #6: no single Recommended property is Core
// =====================================================================

test('ARTICLE: missing every Recommended property (headline/author/date/publisher/image) is still only IMPROVEMENT_AVAILABLE, never ACTION_REQUIRED, as long as SOME schema exists', () => {
  const ctx = ctxOf({ byType: { WebPage: [{}] }, schemaNames: ['WebPage'] })
  const result = runChecksForProfile('ARTICLE', ctx)
  assert.ok(result.coreChecks.every(c => c.status === 'pass'))
  assert.strictEqual(result.finalStatus, 'IMPROVEMENT_AVAILABLE')
})

test('ARTICLE: a complete Article (headline, author, datePublished, publisher, image, mainEntityOfPage, breadcrumbs) -> NO_ACTION_NEEDED', () => {
  const org = { '@type': 'Organization', name: 'Firestarter' }
  const ctx = ctxOf({
    byType: {
      Article: [{ headline: 'Title', author: { '@type': 'Person', name: 'A' }, datePublished: '2026-01-01', publisher: org, image: 'https://x.com/img.jpg', mainEntityOfPage: 'https://x.com/post/' }],
      Organization: [org], BreadcrumbList: [{}]
    },
    schemaNames: ['Article', 'Organization', 'BreadcrumbList'],
    failed: []
  })
  const result = runChecksForProfile('ARTICLE', ctx)
  assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
})

test('ARTICLE: an Article node with no headline/name/url at all IS a Core failure -- structurally unidentifiable, not just incomplete', () => {
  const ctx = ctxOf({ byType: { Article: [{ author: { name: 'A' } }] }, schemaNames: ['Article'] })
  const result = runChecksForProfile('ARTICLE', ctx)
  assert.strictEqual(result.finalStatus, 'ACTION_REQUIRED')
})

// =====================================================================
// CASE_STUDY -- correction #7: Article-family preferred, mentions never recommended
// =====================================================================

test('CASE_STUDY: no check anywhere nudges toward `mentions` or Review/AggregateRating -- correction #7\'s "mentions is OPTIONAL, not something we routinely recommend"', () => {
  const profile = TARGET_PROFILES.CASE_STUDY
  const allIds = [...profile.core, ...profile.recommended, ...profile.avoid]
  assert.ok(!allIds.some(id => /mentions/i.test(id)))
  assert.ok(!allIds.some(id => /review|aggregate_rating/i.test(id)))
})

test('CASE_STUDY: a CreativeWork-only node (no Article/BlogPosting) satisfies structural identifiability but not the preferred-Article recommendation', () => {
  const ctx = ctxOf({ byType: { CreativeWork: [{ name: 'Client X Case Study' }] }, schemaNames: ['CreativeWork'] })
  const result = runChecksForProfile('CASE_STUDY', ctx)
  assert.ok(result.coreChecks.every(c => c.status === 'pass'))
  const articleCheck = result.recommendedChecks.find(c => c.id === 'case_study_article_schema_present')
  assert.strictEqual(articleCheck.status, 'fail')
  assert.ok(/preferred/.test(articleCheck.evidence))
})

test('CASE_STUDY: a complete Article-based case study with about/publisher -> NO_ACTION_NEEDED', () => {
  const org = { '@type': 'Organization', name: 'Firestarter' }
  const ctx = ctxOf({
    byType: { Article: [{ headline: 'How We Helped Client X', publisher: org, datePublished: '2026-01-01', about: { name: 'Client X' } }], Organization: [org], BreadcrumbList: [{}] },
    schemaNames: ['Article', 'Organization', 'BreadcrumbList']
  })
  const result = runChecksForProfile('CASE_STUDY', ctx)
  assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
})

// =====================================================================
// HOME -- legacy, byte-identical behavior (do not modify homepage scoring)
// =====================================================================

test('HOME: preserves the exact original 7-check pass/fail semantics', () => {
  const byType = {
    Organization: [{ name: 'Firestarter', url: 'https://x.com', sameAs: ['https://linkedin.com/x'], address: 'x', telephone: 'x' }],
    WebSite: [{ potentialAction: {} }], BreadcrumbList: [{}]
  }
  const result = runPageTypeChecks('Home', { byType, schemaNames: Object.keys(byType), failed: [] })
  assert.strictEqual(result.targetProfile, 'HOME')
  assert.strictEqual(result.coreChecks.length, 7)
  assert.ok(result.coreChecks.every(c => c.status === 'pass'))
  assert.strictEqual(result.finalStatus, 'NO_ACTION_NEEDED')
})

test('HOME: any of the 7 failing -> ACTION_REQUIRED (same "any check fails -> gap" semantics as before, just relabeled)', () => {
  const result = runPageTypeChecks('Home', { byType: {}, schemaNames: [], failed: [] })
  assert.strictEqual(result.finalStatus, 'ACTION_REQUIRED')
})

// =====================================================================
// GENERIC / unmapped page types -- stays deliberately minimal
// =====================================================================

test('GENERIC (unmapped page type): deliberately minimal, never fabricates an industry-specific expectation', () => {
  ;['Product', 'Landing Page', 'Utility/Legal', 'Other', 'SomeFuturePageType'].forEach(type => {
    const ctx = { byType: {}, schemaNames: [], failed: [] }
    assert.strictEqual(resolveTargetProfile(type, ctx), 'GENERIC')
  })
})

// =====================================================================
// computeFinalStatus -- direct unit coverage of the four-value contract
// =====================================================================

test('computeFinalStatus: Core failure always wins over Recommended gaps', () => {
  const core = [{ status: 'fail' }]
  const recommended = [{ status: 'fail' }]
  assert.strictEqual(computeFinalStatus('SERVICE', core, recommended), 'ACTION_REQUIRED')
})

test('computeFinalStatus: Core pass + a Recommended gap -> IMPROVEMENT_AVAILABLE', () => {
  assert.strictEqual(computeFinalStatus('SERVICE', [{ status: 'pass' }], [{ status: 'fail' }]), 'IMPROVEMENT_AVAILABLE')
})

test('computeFinalStatus: everything passing -> NO_ACTION_NEEDED', () => {
  assert.strictEqual(computeFinalStatus('SERVICE', [{ status: 'pass' }], [{ status: 'pass' }]), 'NO_ACTION_NEEDED')
})

console.log(`\n${passCount} passed.`)
