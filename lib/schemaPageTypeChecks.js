// PAGE-TYPE-DISPATCHED SCHEMA CHECK REGISTRY -- Phase B of the Schema
// page-workflow redesign (2026-09-02). Pure, network-free, zero
// dependencies beyond lib/businessEntityTypes.js and
// lib/checkers/lightweight-jsonld.js's already-parsed output shape (this
// file never fetches or parses HTML itself -- see lib/pageAnalysis.js for
// the orchestration that does).
//
// WHY THIS FILE EXISTS: lib/checkers/checker.js's checkSchemaAndStructure()
// runs exactly 7 checks, all written for one page type (the homepage) --
// reusing that function (or its 7-check list) blindly against a Service
// page, an Article, or a Case Study would score things that were never
// genuinely applicable to that page (e.g. "WebSite + SearchAction" on a
// blog post) and miss things that genuinely are (e.g. Service schema on a
// service page). The explicit product direction for this phase is: "Do NOT
// reuse the 7 homepage checks blindly. Build a page-type check registry...
// Design page-type-specific checks based only on schema that is genuinely
// applicable. Never fabricate schema simply because a type exists in
// Schema.org."
//
// DESIGN: one MASTER catalog of check units (CHECK_CATALOG below), each
// with a stable id, a display label, and a pure evaluate(ctx) -> boolean
// (pass/fail). A separate map, APPLICABLE_CHECKS_BY_TYPE, says which subset
// of that catalog genuinely applies to each page type. Running the
// registry for a given page type walks the FULL catalog once: any check id
// in that type's applicable list is evaluated and sorted into "applicable"
// (always) plus "missingOrInvalid" (only if it failed); every other catalog
// check id is sorted into "notApplicable" untouched -- it is never
// evaluated, and never silently disappears. This is what keeps a Service
// page's result honest about a homepage-only concept like "WebSite +
// SearchAction": it shows up explicitly as NOT APPLICABLE, not as a
// missing/failing gap the AM has to chase.
//
// This directly implements PRODUCT DECISION #10's exact analysis-result
// contract (see lib/pageAnalysis.js, which assembles the final PAGE /
// CLASSIFICATION / CURRENT SCHEMA / APPLICABLE / MISSING-INVALID / NOT
// APPLICABLE / ACTIONABLE SCHEMA GAP object using this module's output).
//
// ANY PAGE TYPE NOT EXPLICITLY DESIGNED FOR (Product, Landing Page,
// Utility/Legal, Other, and any future classification) falls back to
// DEFAULT_APPLICABLE_CHECKS -- a deliberately minimal, genuinely-universal
// set (structured data present, BreadcrumbList, required-property
// validity). This is the same "never fabricate schema simply because a
// type exists" discipline applied to page types this phase never received
// an explicit spec for: better to under-check than to invent expectations
// nobody asked for.

const { BUSINESS_ENTITY_TYPES } = require('./businessEntityTypes')

// buildContext(byType, schemaNames, failed) -> ctx object every catalog
// check's evaluate() receives. businessEntities mirrors checker.js's own
// Check-2 logic exactly (same BUSINESS_ENTITY_TYPES list, same shape) so a
// Home/About/Contact/Location page's "business entity schema" concept means
// the identical thing here as it does in the homepage-only checker.
function buildContext({ byType = {}, schemaNames = [], failed = [] }) {
  const businessEntities = []
  schemaNames.forEach(name => {
    if (BUSINESS_ENTITY_TYPES.includes(name)) {
      businessEntities.push({ name, instances: byType[name] || [] })
    }
  })
  const articleLikeNodes = [
    ...(byType.Article || []),
    ...(byType.BlogPosting || []),
    ...(byType.CreativeWork || [])
  ]
  return { byType, schemaNames, failed, businessEntities, articleLikeNodes }
}

// CHECK_CATALOG -- every check unit this registry knows about, keyed by a
// stable id (used by APPLICABLE_CHECKS_BY_TYPE, and safe to persist/log
// later without depending on the display label's exact wording).
const CHECK_CATALOG = {
  structured_data_present: {
    label: 'Structured data (JSON-LD) present',
    evaluate: ctx => ctx.schemaNames.length > 0
  },
  business_entity_schema: {
    label: 'Business entity schema (LocalBusiness/Organization)',
    evaluate: ctx => ctx.businessEntities.length > 0
  },
  same_as_links: {
    label: 'sameAs entity-disambiguation links',
    evaluate: ctx => ctx.businessEntities.some(e => e.instances.some(inst => inst.sameAs))
  },
  address_telephone: {
    label: 'Address + telephone on business entity',
    evaluate: ctx => ctx.businessEntities.some(e => e.instances.some(inst => inst.address && inst.telephone))
  },
  website_search_action: {
    label: 'WebSite + SearchAction',
    evaluate: ctx => (ctx.byType.WebSite || []).some(inst => inst.potentialAction)
  },
  breadcrumb_list: {
    label: 'BreadcrumbList schema',
    evaluate: ctx => ctx.schemaNames.includes('BreadcrumbList')
  },
  required_properties: {
    label: 'No missing required schema properties',
    evaluate: ctx => ctx.failed.length === 0
  },
  service_schema_present: {
    label: 'Service schema present',
    evaluate: ctx => ctx.schemaNames.includes('Service')
  },
  provider_business_reference: {
    label: 'Provider / business entity reference',
    evaluate: ctx =>
      (ctx.byType.Service || []).some(inst => inst.provider) ||
      ctx.articleLikeNodes.some(inst => inst.publisher) ||
      ctx.businessEntities.length > 0
  },
  article_schema_present: {
    label: 'Article / BlogPosting schema present',
    evaluate: ctx => ctx.schemaNames.includes('Article') || ctx.schemaNames.includes('BlogPosting')
  },
  headline_title: {
    label: 'Headline / title property',
    evaluate: ctx => ctx.articleLikeNodes.some(inst => inst.headline || inst.name)
  },
  author_property: {
    label: 'Author property',
    evaluate: ctx => ctx.articleLikeNodes.some(inst => inst.author)
  },
  date_published: {
    label: 'datePublished property (where supported)',
    evaluate: ctx => ctx.articleLikeNodes.some(inst => inst.datePublished)
  },
  publisher_business_reference: {
    label: 'Publisher / business reference',
    evaluate: ctx => ctx.articleLikeNodes.some(inst => inst.publisher) || ctx.businessEntities.length > 0
  },
  case_study_schema_present: {
    label: 'Article / CreativeWork-style schema present',
    evaluate: ctx => ctx.schemaNames.includes('Article') || ctx.schemaNames.includes('BlogPosting') || ctx.schemaNames.includes('CreativeWork')
  }
}

// DEFAULT_APPLICABLE_CHECKS -- see header. Used for any page type with no
// entry in APPLICABLE_CHECKS_BY_TYPE.
const DEFAULT_APPLICABLE_CHECKS = ['structured_data_present', 'breadcrumb_list', 'required_properties']

// APPLICABLE_CHECKS_BY_TYPE -- PRODUCT DECISION #9's exact per-type check
// lists, translated into catalog ids. Home's list is the same 7 checks
// checker.js already runs (by design -- this registry doesn't change what
// the homepage is scored on, only generalizes the MECHANISM so other page
// types get their own genuinely-applicable list instead of this one).
const APPLICABLE_CHECKS_BY_TYPE = {
  Home: ['structured_data_present', 'business_entity_schema', 'same_as_links', 'address_telephone', 'website_search_action', 'breadcrumb_list', 'required_properties'],
  Service: ['structured_data_present', 'service_schema_present', 'provider_business_reference', 'breadcrumb_list', 'required_properties'],
  Article: ['structured_data_present', 'article_schema_present', 'headline_title', 'author_property', 'date_published', 'publisher_business_reference', 'breadcrumb_list', 'required_properties'],
  'Case Study': ['structured_data_present', 'case_study_schema_present', 'publisher_business_reference', 'breadcrumb_list', 'required_properties'],
  About: ['structured_data_present', 'business_entity_schema', 'same_as_links', 'breadcrumb_list', 'required_properties'],
  Contact: ['structured_data_present', 'business_entity_schema', 'address_telephone', 'breadcrumb_list', 'required_properties'],
  Location: ['structured_data_present', 'business_entity_schema', 'address_telephone', 'breadcrumb_list', 'required_properties']
}

function applicableChecksForType(pageType) {
  return APPLICABLE_CHECKS_BY_TYPE[pageType] || DEFAULT_APPLICABLE_CHECKS
}

// runPageTypeChecks(pageType, { byType, schemaNames, failed }) ->
//   { currentSchema, applicable, missingOrInvalid, notApplicable, actionableGap }
//
// currentSchema:    schemaNames as observed on the page, unfiltered -- the
//                    honest "what's actually there" list regardless of
//                    what this page type expects.
// applicable:       [{ id, label }] -- every catalog check this page type
//                    is evaluated against (whether it passed or not).
// missingOrInvalid: [{ id, label }] -- the subset of `applicable` that
//                    failed. required_properties failing also carries the
//                    real failed-property list (see `failedProperties`)
//                    since "missing" alone loses which properties.
// notApplicable:    [{ id, label }] -- every OTHER catalog check, never
//                    evaluated, listed so the AM can see it was considered
//                    and deliberately excluded, not overlooked.
// actionableGap:    true iff missingOrInvalid.length > 0.
function runPageTypeChecks(pageType, { byType = {}, schemaNames = [], failed = [] } = {}) {
  const ctx = buildContext({ byType, schemaNames, failed })
  const applicableIds = applicableChecksForType(pageType)
  const applicableIdSet = new Set(applicableIds)

  const applicable = []
  const missingOrInvalid = []
  const notApplicable = []

  Object.keys(CHECK_CATALOG).forEach(id => {
    const { label } = CHECK_CATALOG[id]
    if (!applicableIdSet.has(id)) {
      notApplicable.push({ id, label })
      return
    }
    applicable.push({ id, label })
    const passed = CHECK_CATALOG[id].evaluate(ctx)
    if (!passed) {
      const entry = { id, label }
      if (id === 'required_properties' && failed.length > 0) {
        entry.failedProperties = failed.slice(0, 5).map(f => f.description)
      }
      missingOrInvalid.push(entry)
    }
  })

  return {
    currentSchema: schemaNames,
    applicable,
    missingOrInvalid,
    notApplicable,
    actionableGap: missingOrInvalid.length > 0
  }
}

module.exports = {
  CHECK_CATALOG,
  APPLICABLE_CHECKS_BY_TYPE,
  DEFAULT_APPLICABLE_CHECKS,
  applicableChecksForType,
  runPageTypeChecks
}
