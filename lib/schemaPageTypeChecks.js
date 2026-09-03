// PAGE-TYPE DIAGNOSTIC METHODOLOGY -- DIAGNOSTIC METHODOLOGY pass
// (2026-09-03), superseding the "shallow" page-type check registry built
// 2026-09-02. That registry's whole methodology reduced to one question per
// page type: "does *some* business-entity schema exist *somewhere* on this
// page." That question is satisfied by a single sitewide Organization block
// that most WordPress/Yoast sites inject into every page's <head> -- which
// is exactly why /about/, /contact/, and /locations/ could all return
// "No action needed" without any of them having their own AboutPage,
// ContactPage, or location-specific schema at all (see the read-only
// methodology audit this pass approves, with corrections).
//
// APPROVED METHODOLOGY (with corrections):
//   CORE       = the page is materially misrepresented, structurally
//                broken, or missing the primary schema representation we
//                intentionally require for that page type. A more specific
//                subtype existing in schema.org's vocabulary (AboutPage,
//                ContactPage, Service on every commercial page, ...) is NOT
//                by itself a Core bar -- this is an SEO execution platform,
//                not a Schema.org completeness validator.
//   RECOMMENDED = a defensible, page-specific enhancement, supported by
//                real page content, that we intentionally prefer but do not
//                block "no action needed" on.
//   OPTIONAL   = valid enrichment we do not routinely recommend (never
//                becomes an active check at all -- see FAQPage/Review/
//                AggregateRating/`mentions` below).
//   AVOID      = unsupported, misleading, fabricated, or inappropriate
//                markup for this page type -- a violation here is reported
//                on its own, separate list, never folded into Core/
//                Recommended.
//
// FINAL STATUS = ACTION_REQUIRED (a Core check genuinely fails) |
//                IMPROVEMENT_AVAILABLE (Core passes, a Recommended item is
//                absent) | NO_ACTION_NEEDED (Core passes, nothing
//                meaningful missing) | COULD_NOT_VERIFY (fetch/parse/
//                evidence prevents a reliable conclusion -- see
//                LOCATION_UNCONFIRMED below for a non-fetch-failure use of
//                this same status).
//
// ENTITY GRAPH DISCIPLINE (approved, correction #9): "a random sitewide
// Organization node cannot satisfy Service.provider / Article.publisher /
// AboutPage.about-or-mainEntity / ContactPage.about-or-mainEntity unless the
// appropriate page node actually references it." See resolveEntityReference
// below -- a relationship property is only 'valid' when it embeds a real
// business-entity node (with a name) or references (@id or matching name) a
// business-entity node that actually exists somewhere on THIS page. This is
// page-scoped, not sitewide: this pipeline fetches and analyzes one page at
// a time with no persistent "canonical entity" store across pages (adding
// one is future, persistence-dependent work, explicitly out of this pass's
// scope) -- so "the canonical entity" here means "a real business-entity
// node this page itself declares," not a site-level record.
//
// LOCATION METHODOLOGY (correction #5): four distinct profiles --
// LOCATION_HUB, SERVICE_AREA, PHYSICAL_LOCATION, LOCATION_UNCONFIRMED. Per
// correction #12, "do not infer physical office status from URL alone,"
// and this pass excludes persistence (no per-location Client-Intelligence
// flag exists yet to confirm one). So PHYSICAL_LOCATION's check list is
// fully implemented and tested here, but the auto-resolver
// (resolveLocationProfile) NEVER selects it on its own -- see that
// function's header for the full reasoning. It resolves instead to:
// LOCATION_HUB for the bare index path (real structural evidence, not a
// guess); LOCATION_UNCONFIRMED when the page's own schema already contains
// an unverified physical-business claim (flagged for review, never
// silently trusted); SERVICE_AREA otherwise, since a geography-targeted
// leaf page with no physical-business claim on it needs no such claim to
// begin with, and assuming "just a service page" is the conservative
// default correction #12 asks for, not "assume it's a real office."
//
// Zero dependencies beyond lib/businessEntityTypes.js and
// lib/checkers/lightweight-jsonld.js's already-parsed output shape -- this
// file never fetches or parses HTML itself (see lib/pageAnalysis.js).

const { BUSINESS_ENTITY_TYPES } = require('./businessEntityTypes')

// ---------------------------------------------------------------------
// CONTEXT BUILDING
// ---------------------------------------------------------------------

// buildContext(...) -> ctx object every check's evaluate() receives.
// businessEntities mirrors checker.js's own Check-2 logic (same
// BUSINESS_ENTITY_TYPES list, same shape) so "a business entity exists"
// means the identical thing here as in the homepage-only legacy checker.
// businessEntityNodes flattens that into raw nodes for @id/name matching
// (see resolveEntityReference) -- the primitive the entity-graph discipline
// above is built on.
function buildContext({ byType = {}, schemaNames = [], failed = [], scriptCount = 0, parseFailureCount = 0, path = null } = {}) {
  const businessEntities = []
  const businessEntityNodes = []
  schemaNames.forEach(name => {
    if (BUSINESS_ENTITY_TYPES.includes(name)) {
      const instances = byType[name] || []
      businessEntities.push({ name, instances })
      instances.forEach(inst => businessEntityNodes.push(inst))
    }
  })
  const articleLikeNodes = [
    ...(byType.Article || []),
    ...(byType.BlogPosting || []),
    ...(byType.CreativeWork || [])
  ]
  return { byType, schemaNames, failed, scriptCount, parseFailureCount, path, businessEntities, businessEntityNodes, articleLikeNodes }
}

// ---------------------------------------------------------------------
// SHARED PRIMITIVES
// ---------------------------------------------------------------------

// resolveEntityReference(value, businessEntityNodes) -> 'absent' | 'invalid' | 'valid'
// The entity-graph primitive (correction #9). A property value only
// resolves 'valid' when it is a REAL, checkable reference to a business
// entity this exact page declares -- never merely "some business entity
// happens to be on the page too."
//   - an embedded node whose @type is a BUSINESS_ENTITY_TYPES value AND
//     which carries a name -> valid, UNLESS at least one other real
//     business-entity node exists on this page and NONE of them share that
//     name -- in that case the embedded node is naming a DIFFERENT business
//     than the one this page otherwise represents, which is exactly the
//     "misleading schema" case correction #4 asks Service's Core check to
//     catch. With no other business-entity evidence on the page at all,
//     the embedded node IS the only evidence there is, so it's trusted.
//   - an object with an @id matching a real business-entity node's own
//     @id on this page -> valid (a genuine cross-reference)
//   - an object or string naming a business-entity node's own `name`
//     exactly -> valid (a lightweight but real, matching reference)
//   - present but none of the above resolves -> invalid (a reference to
//     something we can't confirm as this page's own business entity --
//     "do not guess," never credited as valid)
//   - missing entirely -> absent
function resolveEntityReference(value, businessEntityNodes) {
  if (value === undefined || value === null) return 'absent'
  const candidates = Array.isArray(value) ? value : [value]
  if (candidates.length === 0) return 'absent'
  for (const v of candidates) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rawType = v['@type']
      const types = Array.isArray(rawType) ? rawType : (rawType ? [rawType] : [])
      if (types.some(t => BUSINESS_ENTITY_TYPES.includes(t)) && v.name) {
        if (businessEntityNodes.length === 0 || businessEntityNodes.some(n => n.name === v.name)) return 'valid'
        continue // named entity embedded, but it names a DIFFERENT business than every one this page otherwise declares
      }
      if (v['@id'] && businessEntityNodes.some(n => n['@id'] && n['@id'] === v['@id'])) return 'valid'
      if (v.name && businessEntityNodes.some(n => n.name === v.name)) return 'valid'
    } else if (typeof v === 'string' && v.trim() && businessEntityNodes.some(n => n.name === v)) {
      return 'valid'
    }
  }
  return 'invalid'
}

// hasWellFormedAddress(node) -> true iff `address` is present and is at
// least a plausible address shape (an object carrying some real locality
// information), not just any truthy value. Structural only -- this can
// never verify the address is real, only that it isn't an empty/garbage
// shell. Used by PHYSICAL_LOCATION's Core check and by the
// physical-business-claim AVOID checks on the other Location profiles.
function hasWellFormedAddress(node) {
  const addr = node && node.address
  if (!addr || typeof addr !== 'object' || Array.isArray(addr)) return false
  return Boolean(addr.streetAddress || addr.addressLocality || addr.postalCode)
}

// ---------------------------------------------------------------------
// CHECK RESULT VOCABULARY
// ---------------------------------------------------------------------
// Every check's evaluate(ctx) returns one of:
//   'pass'        -- the construct is present and structurally valid
//   'fail_absent' -- the construct this check looks for isn't present
//   'fail_invalid'-- the construct IS present but is structurally broken
//                    or doesn't resolve to a real, checkable reference
// which is then mapped to the six PRESENCE_QUALITY_STATES states
// (correction #11) by tier:
//   pass                          -> TYPE_PRESENT_CORE_VALID
//   fail_absent,  tier: core      -> TYPE_ABSENT
//   fail_absent,  tier: recommended -> TYPE_PRESENT_RECOMMENDED_AVAILABLE
//                    (absence of a Recommended item is framed as "available
//                    to add," never as a bald "absent" -- an AM reading
//                    this should see an opportunity, not a scolding)
//   fail_invalid, any tier        -> TYPE_PRESENT_INVALID_INCOMPLETE
// A check not in this page type's core/recommended/avoid lists at all is
// never evaluated -- it is reported as NOT_APPLICABLE, exactly as before.
const PRESENCE_QUALITY_STATES = [
  'TYPE_ABSENT', 'TYPE_PRESENT_INVALID_INCOMPLETE', 'TYPE_PRESENT_CORE_VALID',
  'TYPE_PRESENT_RECOMMENDED_AVAILABLE', 'NOT_APPLICABLE', 'UNKNOWN_COULD_NOT_VERIFY'
]

function stateFor(tier, result) {
  if (result === 'pass') return 'TYPE_PRESENT_CORE_VALID'
  if (result === 'fail_invalid') return 'TYPE_PRESENT_INVALID_INCOMPLETE'
  return tier === 'recommended' ? 'TYPE_PRESENT_RECOMMENDED_AVAILABLE' : 'TYPE_ABSENT'
}

// ---------------------------------------------------------------------
// CHECK CATALOG
// ---------------------------------------------------------------------
// One master catalog of check units, each a stable id + label +
// evaluate(ctx) -> 'pass'|'fail_absent'|'fail_invalid' + evidence(ctx, result)
// -> a short, real, data-derived sentence. TARGET_PROFILES below decides
// which ids are core/recommended/avoid for which profile -- the same
// "evaluate once against the full catalog, only score what's applicable"
// discipline as the previous registry, now tier-aware.
const CHECK_CATALOG = {
  // --- universal-ish (referenced by nearly every non-Home profile) ---
  structured_data_parses: {
    label: 'Structured data parses successfully',
    evaluate: ctx => {
      if (ctx.scriptCount > 0 && ctx.parseFailureCount >= ctx.scriptCount) return 'fail_invalid'
      if (ctx.schemaNames.length === 0) return 'fail_absent'
      return 'pass'
    },
    evidence: (ctx, r) => {
      if (r === 'fail_invalid') return `Found ${ctx.scriptCount} JSON-LD block(s) on this page, but every one failed to parse -- this is broken markup, not an absence of schema.`
      if (r === 'fail_absent') return 'No JSON-LD structured data found on this page at all.'
      return `Found: ${ctx.schemaNames.join(', ')}.`
    }
  },
  breadcrumb_present: {
    label: 'BreadcrumbList present',
    evaluate: ctx => ctx.schemaNames.includes('BreadcrumbList') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'BreadcrumbList schema present.' : 'No BreadcrumbList schema found.'
  },
  required_properties_valid: {
    label: 'Required/core properties valid',
    evaluate: ctx => ctx.failed.length === 0 ? 'pass' : 'fail_invalid',
    evidence: (ctx, r) => r === 'pass'
      ? 'No missing required schema properties detected.'
      : `${ctx.failed.length} required propert${ctx.failed.length === 1 ? 'y' : 'ies'} missing: ${ctx.failed.slice(0, 5).map(f => f.description).join('; ')}${ctx.failed.length > 5 ? ', and more' : ''}.`
  },

  // --- Home (legacy -- see file header; behavior byte-identical to the
  // original 7-check homepage list, only the envelope shape changed) ---
  home_structured_data_present: {
    label: 'Structured data present',
    evaluate: ctx => ctx.schemaNames.length > 0 ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? `Found: ${ctx.schemaNames.join(', ')}.` : 'No JSON-LD structured data found on this page at all.'
  },
  home_business_entity_schema: {
    label: 'Business/entity reference present',
    evaluate: ctx => ctx.businessEntities.length > 0 ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? `Business entity schema present: ${ctx.businessEntities.map(e => e.name).join(', ')}.` : 'No LocalBusiness/Organization-style schema found.'
  },
  home_same_as_links: {
    label: 'sameAs entity-disambiguation links',
    evaluate: ctx => ctx.businessEntities.some(e => e.instances.some(inst => inst.sameAs)) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'sameAs property present, linking this entity to external profiles.' : 'No sameAs links found on the business entity.'
  },
  home_address_telephone: {
    label: 'Address + telephone on business entity',
    evaluate: ctx => ctx.businessEntities.some(e => e.instances.some(inst => inst.address && inst.telephone)) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'Business entity includes both address and telephone.' : (ctx.businessEntities.length > 0 ? 'Business entity schema exists but is missing address and/or telephone.' : 'No business entity schema to carry address/telephone.')
  },
  home_website_search_action: {
    label: 'WebSite + SearchAction',
    evaluate: ctx => (ctx.byType.WebSite || []).some(inst => inst.potentialAction) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'WebSite schema includes a SearchAction.' : 'No WebSite schema with a SearchAction found.'
  },
  home_breadcrumb_list: {
    label: 'BreadcrumbList present',
    evaluate: ctx => ctx.schemaNames.includes('BreadcrumbList') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'BreadcrumbList schema present.' : 'No BreadcrumbList schema found.'
  },
  home_required_properties: {
    label: 'Required/core properties valid',
    evaluate: ctx => ctx.failed.length === 0 ? 'pass' : 'fail_invalid',
    evidence: (ctx, r) => r === 'pass' ? 'No missing required schema properties detected.' : `${ctx.failed.length} required propert${ctx.failed.length === 1 ? 'y' : 'ies'} missing: ${ctx.failed.slice(0, 5).map(f => f.description).join('; ')}${ctx.failed.length > 5 ? ', and more' : ''}.`
  },

  // --- About ---
  about_page_type_representation: {
    label: 'Page represented as WebPage or AboutPage',
    evaluate: ctx => (ctx.schemaNames.includes('WebPage') || ctx.schemaNames.includes('AboutPage')) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? `This page is typed as ${ctx.schemaNames.includes('AboutPage') ? 'AboutPage' : 'WebPage'}.` : 'This page has no WebPage or AboutPage schema at all.'
  },
  about_entity_relationship_valid_when_present: {
    label: 'Canonical entity relationship valid when present',
    evaluate: ctx => {
      const nodes = [...(ctx.byType.WebPage || []), ...(ctx.byType.AboutPage || [])]
      const values = nodes.flatMap(n => [n.about, n.mainEntity]).filter(v => v !== undefined)
      if (values.length === 0) return 'pass' // vacuously fine -- absence is a Recommended concern, not Core
      return values.some(v => resolveEntityReference(v, ctx.businessEntityNodes) === 'valid') ? 'pass' : 'fail_invalid'
    },
    evidence: (ctx, r) => r === 'fail_invalid'
      ? 'This page declares an about/mainEntity relationship, but it does not resolve to a real business entity this page itself carries -- a sitewide entity elsewhere on the site does not count.'
      : 'No unresolved about/mainEntity claim on this page.'
  },
  about_page_subtype: {
    label: 'AboutPage subtype used',
    evaluate: ctx => ctx.schemaNames.includes('AboutPage') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'AboutPage subtype present.' : 'This page uses a generic WebPage type rather than the more specific AboutPage subtype.'
  },
  about_entity_relationship_present: {
    label: 'about/mainEntity relationship to the canonical entity',
    evaluate: ctx => {
      const nodes = [...(ctx.byType.WebPage || []), ...(ctx.byType.AboutPage || [])]
      const values = nodes.flatMap(n => [n.about, n.mainEntity]).filter(v => v !== undefined)
      const anyValid = values.some(v => resolveEntityReference(v, ctx.businessEntityNodes) === 'valid')
      return anyValid ? 'pass' : 'fail_absent'
    },
    evidence: (ctx, r) => r === 'pass' ? 'This page\'s about/mainEntity relationship resolves to a real business entity it carries.' : 'No about/mainEntity relationship connecting this page to the primary business entity.'
  },

  // --- Contact ---
  contact_page_type_representation: {
    label: 'Page represented as WebPage or ContactPage',
    evaluate: ctx => (ctx.schemaNames.includes('WebPage') || ctx.schemaNames.includes('ContactPage')) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? `This page is typed as ${ctx.schemaNames.includes('ContactPage') ? 'ContactPage' : 'WebPage'}.` : 'This page has no WebPage or ContactPage schema at all.'
  },
  contact_no_fabricated_claims: {
    label: 'No unsupported/fabricated contact claims',
    // Structural only -- this cannot and does not verify the contact
    // information is factually accurate for the business; it only guards
    // against an obviously malformed claim (an `address` that isn't even
    // shaped like an address, a non-string `telephone`).
    evaluate: ctx => {
      const broken = ctx.businessEntityNodes.some(n => {
        const addrBroken = n.address !== undefined && (typeof n.address !== 'object' || Array.isArray(n.address))
        const phoneBroken = n.telephone !== undefined && typeof n.telephone !== 'string' && typeof n.telephone !== 'number'
        return addrBroken || phoneBroken
      })
      return broken ? 'fail_invalid' : 'pass'
    },
    evidence: (ctx, r) => r === 'fail_invalid'
      ? 'A business-entity node on this page has an address or telephone value that is not a well-formed shape -- this is a structural check only and cannot confirm the contact details are accurate for the business.'
      : 'No structurally malformed contact claims found (this does not confirm the details are accurate -- only that nothing on the page is obviously broken).'
  },
  contact_page_subtype: {
    label: 'ContactPage subtype used',
    evaluate: ctx => ctx.schemaNames.includes('ContactPage') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'ContactPage subtype present.' : 'This page uses a generic WebPage type rather than the more specific ContactPage subtype.'
  },
  contact_entity_relationship_present: {
    label: 'about/mainEntity relationship to the canonical entity',
    evaluate: ctx => {
      const nodes = [...(ctx.byType.WebPage || []), ...(ctx.byType.ContactPage || [])]
      const values = nodes.flatMap(n => [n.about, n.mainEntity]).filter(v => v !== undefined)
      return values.some(v => resolveEntityReference(v, ctx.businessEntityNodes) === 'valid') ? 'pass' : 'fail_absent'
    },
    evidence: (ctx, r) => r === 'pass' ? 'This page\'s about/mainEntity relationship resolves to a real business entity it carries.' : 'No about/mainEntity relationship connecting this page to the primary business entity.'
  },
  contact_point_present: {
    label: 'ContactPoint schema',
    // Schema-only presence check -- "when visible page content supports
    // it" would require extracting the page's visible text (as
    // lib/schemaGenerator.js's extractPlainTextAddress does for a
    // different purpose); wiring that into this checker is a real future
    // enhancement, not attempted here to avoid claiming a judgment about
    // page content this check doesn't actually make.
    evaluate: ctx => ctx.schemaNames.includes('ContactPoint') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'ContactPoint schema present.' : 'No ContactPoint schema found (only checked for presence -- not verified against visible page content).'
  },

  // --- Service ---
  service_schema_valid_when_present: {
    label: 'Service representation and provider relationship valid when present',
    evaluate: ctx => {
      const services = ctx.byType.Service || []
      if (services.length === 0) return 'pass' // vacuous -- absence is Recommended, not Core
      const unidentified = services.some(s => !s.name && !s.serviceType)
      if (unidentified) return 'fail_invalid'
      const withProvider = services.filter(s => s.provider !== undefined)
      if (withProvider.length === 0) return 'pass'
      const anyMisreferenced = withProvider.some(s => resolveEntityReference(s.provider, ctx.businessEntityNodes) === 'invalid')
      return anyMisreferenced ? 'fail_invalid' : 'pass'
    },
    evidence: (ctx, r) => r === 'fail_invalid'
      ? 'A Service node on this page is either missing any name/serviceType, or its provider does not resolve to a real business entity this page carries -- a mismatched or unconfirmed provider claim is a misrepresentation risk.'
      : 'No structurally invalid Service representation found.'
  },
  service_schema_present: {
    label: 'Service schema present',
    evaluate: ctx => ctx.schemaNames.includes('Service') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'Service schema present.' : 'No Service schema found on this commercial service page.'
  },
  service_provider_relationship: {
    label: 'provider relationship to the canonical entity',
    evaluate: ctx => {
      const services = ctx.byType.Service || []
      return services.some(s => resolveEntityReference(s.provider, ctx.businessEntityNodes) === 'valid') ? 'pass' : 'fail_absent'
    },
    evidence: (ctx, r) => r === 'pass' ? 'Service.provider resolves to a real business entity this page carries.' : 'No Service.provider relationship connecting this service to the primary business entity.'
  },
  service_name_type: {
    label: 'name/serviceType present',
    evaluate: ctx => (ctx.byType.Service || []).some(s => s.name || s.serviceType) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'Service name/serviceType present.' : 'No name or serviceType found on the Service node.'
  },
  service_description_supported: {
    label: 'description present',
    evaluate: ctx => (ctx.byType.Service || []).some(s => s.description) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'Service description present.' : 'No description found on the Service node (only checked for presence, not verified against page copy).'
  },
  service_area_served_supported: {
    label: 'areaServed present',
    evaluate: ctx => (ctx.byType.Service || []).some(s => s.areaServed) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'areaServed present on the Service node.' : 'No areaServed found (only checked for presence, not verified against page copy).'
  },

  // --- Location: shared AVOID primitive across HUB/SERVICE_AREA/UNCONFIRMED ---
  // Fires when a genuinely business-specific LocalBusiness-family type
  // (excluding plain 'Organization', which is normal sitewide identity
  // schema and not itself a physical-location claim) declares its own
  // address. Scoped this way so a sitewide Organization block that happens
  // to also appear on a hub/service-area page is NOT mistaken for "this
  // page claims to be a physical office" -- only a genuine LocalBusiness-
  // subtype-with-address claim triggers this.
  location_no_physical_business_claim: {
    label: 'No page-specific LocalBusiness/address claim',
    evaluate: ctx => {
      const claimTypes = BUSINESS_ENTITY_TYPES.filter(t => t !== 'Organization')
      const claim = claimTypes.some(t => (ctx.byType[t] || []).some(inst => hasWellFormedAddress(inst)))
      return claim ? 'fail_invalid' : 'pass'
    },
    evidence: (ctx, r) => r === 'fail_invalid'
      ? 'This page declares a LocalBusiness-family node with its own address -- confirm a real, staffed office actually exists at this URL before treating this as intentional; otherwise this risks misrepresenting a physical presence that does not exist.'
      : 'No page-specific physical-business address claim found.'
  },

  // --- LOCATION_HUB ---
  hub_page_type_representation: {
    label: 'Page represented as WebPage or CollectionPage',
    evaluate: ctx => (ctx.schemaNames.includes('WebPage') || ctx.schemaNames.includes('CollectionPage')) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? `This page is typed as ${ctx.schemaNames.includes('CollectionPage') ? 'CollectionPage' : 'WebPage'}.` : 'This page has no WebPage or CollectionPage schema at all.'
  },
  hub_collection_page_subtype: {
    label: 'CollectionPage subtype used',
    evaluate: ctx => ctx.schemaNames.includes('CollectionPage') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'CollectionPage subtype present.' : 'This hub page uses a generic WebPage type rather than the more specific CollectionPage subtype.'
  },
  hub_item_list_present: {
    label: 'ItemList of location pages',
    evaluate: ctx => ctx.schemaNames.includes('ItemList') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'ItemList schema present, structurally listing the linked location pages.' : 'No ItemList schema found (only checked for presence, not verified against the page\'s actual links).'
  },

  // --- SERVICE_AREA ---
  service_area_page_type_representation: {
    label: 'Page represented as WebPage or Service',
    evaluate: ctx => (ctx.schemaNames.includes('WebPage') || ctx.schemaNames.includes('Service')) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? `This page is typed as ${ctx.schemaNames.includes('Service') ? 'Service' : 'WebPage'}.` : 'This page has no WebPage or Service schema at all.'
  },
  service_area_service_schema_present: {
    label: 'Service schema present',
    evaluate: ctx => ctx.schemaNames.includes('Service') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'Service schema present.' : 'No Service schema found on this service-area landing page.'
  },
  service_area_provider_relationship: {
    label: 'provider relationship to the canonical entity',
    evaluate: ctx => (ctx.byType.Service || []).some(s => resolveEntityReference(s.provider, ctx.businessEntityNodes) === 'valid') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'Service.provider resolves to a real business entity this page carries.' : 'No Service.provider relationship connecting this page to the primary business entity.'
  },
  service_area_area_served_supported: {
    label: 'areaServed present',
    evaluate: ctx => (ctx.byType.Service || []).some(s => s.areaServed) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'areaServed present on the Service node.' : 'No areaServed found (only checked for presence, not verified against page copy).'
  },

  // --- PHYSICAL_LOCATION (fully implemented, never auto-selected this
  // pass -- see file header) ---
  physical_location_claims_valid: {
    label: 'Physical-location claims structurally valid',
    evaluate: ctx => {
      const claimTypes = BUSINESS_ENTITY_TYPES.filter(t => t !== 'Organization')
      const nodes = claimTypes.flatMap(t => ctx.byType[t] || [])
      if (nodes.length === 0) return 'fail_absent'
      const broken = nodes.some(n => n.address !== undefined && !hasWellFormedAddress(n))
      return broken ? 'fail_invalid' : 'pass'
    },
    evidence: (ctx, r) => {
      if (r === 'fail_absent') return 'No LocalBusiness-family node found at all -- this profile requires one to represent the physical location.'
      if (r === 'fail_invalid') return 'A LocalBusiness-family node declares an address that is not a well-formed shape. This is a structural check only and cannot confirm the address is real.'
      return 'LocalBusiness-family node present with a structurally well-formed address (not independently verified as real).'
    }
  },
  physical_location_subtype: {
    label: 'Specific LocalBusiness subtype (not generic)',
    evaluate: ctx => BUSINESS_ENTITY_TYPES.some(t => t !== 'Organization' && t !== 'LocalBusiness' && ctx.schemaNames.includes(t)) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'A specific LocalBusiness industry subtype is used.' : 'Only a generic LocalBusiness/Organization type is used, not a specific industry subtype.'
  },
  physical_location_address_present: {
    label: 'address present',
    evaluate: ctx => ctx.businessEntityNodes.some(n => hasWellFormedAddress(n)) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'A well-formed address is present.' : 'No well-formed address found on this location\'s business-entity node.'
  },
  physical_location_telephone_present: {
    label: 'telephone present',
    evaluate: ctx => ctx.businessEntityNodes.some(n => n.telephone) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'Telephone present.' : 'No telephone found on this location\'s business-entity node.'
  },
  physical_location_parent_org_relationship: {
    label: 'parentOrganization/branchOf relationship',
    evaluate: ctx => ctx.businessEntityNodes.some(n => resolveEntityReference(n.parentOrganization ?? n.branchOf, ctx.businessEntityNodes) === 'valid') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'parentOrganization/branchOf resolves to a real business entity this page carries.' : 'No parentOrganization/branchOf relationship linking this branch to the primary organization.'
  },
  physical_location_geo_hours: {
    label: 'geo or openingHoursSpecification present',
    evaluate: ctx => ctx.businessEntityNodes.some(n => n.geo || n.openingHoursSpecification) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'geo or openingHoursSpecification present.' : 'No geo coordinates or openingHoursSpecification found.'
  },

  // --- Article ---
  article_representation_valid_when_present: {
    label: 'Article/BlogPosting structurally identifiable when present',
    evaluate: ctx => {
      const nodes = [...(ctx.byType.Article || []), ...(ctx.byType.BlogPosting || [])]
      if (nodes.length === 0) return 'pass' // vacuous -- absence is Recommended, not Core
      const unidentified = nodes.some(n => !n.headline && !n.name && !n.url)
      return unidentified ? 'fail_invalid' : 'pass'
    },
    evidence: (ctx, r) => r === 'fail_invalid' ? 'An Article/BlogPosting node exists but has no headline, name, or url at all -- it cannot be identified as representing this page.' : 'No unidentifiable Article/BlogPosting node found.'
  },
  article_schema_present: {
    label: 'Article or BlogPosting schema present',
    evaluate: ctx => (ctx.schemaNames.includes('Article') || ctx.schemaNames.includes('BlogPosting')) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'Article/BlogPosting schema present.' : 'No Article/BlogPosting schema found.'
  },
  article_headline: {
    label: 'headline present',
    evaluate: ctx => ctx.articleLikeNodes.some(n => n.headline) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'headline present.' : 'No headline property found.'
  },
  article_author_supported: {
    label: 'author present',
    evaluate: ctx => ctx.articleLikeNodes.some(n => n.author) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'author present.' : 'No author property found (only checked for presence, not verified against a visible byline).'
  },
  article_date_published: {
    label: 'datePublished present',
    evaluate: ctx => ctx.articleLikeNodes.some(n => n.datePublished) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'datePublished present.' : 'No datePublished property found.'
  },
  article_publisher_relationship: {
    label: 'publisher relationship to the canonical entity',
    evaluate: ctx => ctx.articleLikeNodes.some(n => resolveEntityReference(n.publisher, ctx.businessEntityNodes) === 'valid') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'publisher resolves to a real business entity this page carries.' : 'No publisher relationship connecting this article to the primary business entity.'
  },
  article_image: {
    label: 'image present',
    evaluate: ctx => ctx.articleLikeNodes.some(n => n.image) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'image present.' : 'No image property found.'
  },
  article_main_entity_of_page: {
    label: 'mainEntityOfPage present',
    evaluate: ctx => ctx.articleLikeNodes.some(n => n.mainEntityOfPage) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'mainEntityOfPage present.' : 'No mainEntityOfPage property found.'
  },

  // --- Case Study (Article-family, per correction #7) ---
  case_study_representation_valid_when_present: {
    label: 'Article/CreativeWork structurally identifiable when present',
    evaluate: ctx => {
      const nodes = [...(ctx.byType.Article || []), ...(ctx.byType.BlogPosting || []), ...(ctx.byType.CreativeWork || [])]
      if (nodes.length === 0) return 'pass'
      const unidentified = nodes.some(n => !n.headline && !n.name && !n.url)
      return unidentified ? 'fail_invalid' : 'pass'
    },
    evidence: (ctx, r) => r === 'fail_invalid' ? 'An Article/CreativeWork node exists but has no headline, name, or url at all -- it cannot be identified as representing this case study.' : 'No unidentifiable case-study node found.'
  },
  case_study_article_schema_present: {
    label: 'Article schema present (preferred over generic CreativeWork)',
    evaluate: ctx => (ctx.schemaNames.includes('Article') || ctx.schemaNames.includes('BlogPosting')) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'Article/BlogPosting schema present.' : (ctx.schemaNames.includes('CreativeWork') ? 'Only a generic CreativeWork node found -- Article is the preferred, more specific representation for a case study.' : 'No Article/BlogPosting/CreativeWork schema found.')
  },
  case_study_headline: {
    label: 'headline present',
    evaluate: ctx => ctx.articleLikeNodes.some(n => n.headline || n.name) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'headline/name present.' : 'No headline or name property found.'
  },
  case_study_publisher_relationship: {
    label: 'publisher relationship to the canonical entity',
    evaluate: ctx => ctx.articleLikeNodes.some(n => resolveEntityReference(n.publisher, ctx.businessEntityNodes) === 'valid') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'publisher resolves to a real business entity this page carries.' : 'No publisher relationship connecting this case study to the primary business entity.'
  },
  case_study_author_or_date_supported: {
    label: 'author or datePublished present',
    evaluate: ctx => ctx.articleLikeNodes.some(n => n.author || n.datePublished) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'author and/or datePublished present.' : 'Neither author nor datePublished found.'
  },
  case_study_about_subject: {
    label: 'about (the genuine case-study subject)',
    evaluate: ctx => ctx.articleLikeNodes.some(n => n.about !== undefined) ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'about property present, naming the case study\'s subject.' : 'No about property naming the case study\'s subject (only checked for presence, not verified as a genuine subject).'
  },

  // --- Generic / unmapped page types ---
  generic_webpage_representation: {
    label: 'Page represented as WebPage',
    evaluate: ctx => ctx.schemaNames.includes('WebPage') ? 'pass' : 'fail_absent',
    evidence: (ctx, r) => r === 'pass' ? 'WebPage schema present.' : 'No WebPage schema found.'
  }
}

// ---------------------------------------------------------------------
// TARGET PROFILES
// ---------------------------------------------------------------------
// { core: [...ids], recommended: [...ids], avoid: [...ids] }. Every id not
// in one of these three lists for a given profile is NOT_APPLICABLE for it
// -- evaluated never, reported explicitly, never silently dropped.
//
// Deliberately NOT present anywhere below, per correction #12's "do not
// recommend" rules (satisfied by never creating the check at all, rather
// than creating one we'd then have to remember to skip): FAQPage presence,
// Review/AggregateRating presence, and (Case Study) `mentions` -- valid
// schema.org constructs, simply never nudged toward by this platform.
// `notApplicable` is a small, CURATED cross-reference list per profile --
// not "every other id in the whole catalog." With the catalog now mostly
// namespaced per profile (about_*, service_*, hub_*, ...), scanning the
// full catalog would just list dozens of concepts nobody would ever expect
// on that page type (e.g. "article_headline: Not Applicable" on a Contact
// page is noise, not information). What IS genuinely useful to call out
// explicitly -- the same value the old design's NOT_APPLICABLE list had --
// is a concept an AM might plausibly expect for "a Location page" in
// general but that this SPECIFIC location sub-profile deliberately does
// not check for (most importantly: physical-address/telephone concepts on
// the two non-physical location profiles).
const TARGET_PROFILES = {
  HOME: {
    core: ['home_structured_data_present', 'home_business_entity_schema', 'home_same_as_links', 'home_address_telephone', 'home_website_search_action', 'home_breadcrumb_list', 'home_required_properties'],
    recommended: [],
    avoid: [],
    notApplicable: []
  },
  ABOUT: {
    core: ['structured_data_parses', 'about_page_type_representation', 'about_entity_relationship_valid_when_present'],
    recommended: ['about_page_subtype', 'about_entity_relationship_present', 'breadcrumb_present', 'required_properties_valid'],
    avoid: [],
    notApplicable: []
  },
  CONTACT: {
    core: ['structured_data_parses', 'contact_page_type_representation', 'contact_no_fabricated_claims'],
    recommended: ['contact_page_subtype', 'contact_entity_relationship_present', 'contact_point_present', 'breadcrumb_present', 'required_properties_valid'],
    avoid: [],
    notApplicable: []
  },
  SERVICE: {
    core: ['structured_data_parses', 'service_schema_valid_when_present'],
    recommended: ['service_schema_present', 'service_provider_relationship', 'service_name_type', 'service_description_supported', 'service_area_served_supported', 'breadcrumb_present', 'required_properties_valid'],
    avoid: [],
    notApplicable: []
  },
  LOCATION_HUB: {
    core: ['structured_data_parses', 'hub_page_type_representation'],
    recommended: ['hub_collection_page_subtype', 'hub_item_list_present', 'breadcrumb_present'],
    avoid: ['location_no_physical_business_claim'],
    notApplicable: ['physical_location_address_present', 'physical_location_telephone_present']
  },
  SERVICE_AREA: {
    core: ['structured_data_parses', 'service_area_page_type_representation'],
    recommended: ['service_area_service_schema_present', 'service_area_provider_relationship', 'service_area_area_served_supported', 'breadcrumb_present'],
    avoid: ['location_no_physical_business_claim'],
    notApplicable: ['physical_location_address_present', 'physical_location_telephone_present']
  },
  PHYSICAL_LOCATION: {
    core: ['structured_data_parses', 'physical_location_claims_valid'],
    recommended: ['physical_location_subtype', 'physical_location_address_present', 'physical_location_telephone_present', 'physical_location_parent_org_relationship', 'physical_location_geo_hours', 'breadcrumb_present'],
    avoid: [],
    notApplicable: []
  },
  LOCATION_UNCONFIRMED: {
    // Deliberately minimal Core -- we don't yet know which real profile
    // applies, so we don't impose any other profile's bar. See
    // computeFinalStatus: this profile's final status is forced to
    // COULD_NOT_VERIFY (unless a Core check genuinely fails), never
    // NO_ACTION_NEEDED, so "we don't know yet" is never silently reported
    // as "nothing to do."
    core: ['structured_data_parses'],
    recommended: [],
    avoid: ['location_no_physical_business_claim'],
    notApplicable: ['physical_location_address_present', 'physical_location_telephone_present']
  },
  ARTICLE: {
    core: ['structured_data_parses', 'article_representation_valid_when_present'],
    recommended: ['article_schema_present', 'article_headline', 'article_author_supported', 'article_date_published', 'article_publisher_relationship', 'article_image', 'article_main_entity_of_page', 'breadcrumb_present', 'required_properties_valid'],
    avoid: [],
    notApplicable: []
  },
  CASE_STUDY: {
    core: ['structured_data_parses', 'case_study_representation_valid_when_present'],
    recommended: ['case_study_article_schema_present', 'case_study_headline', 'case_study_publisher_relationship', 'case_study_author_or_date_supported', 'case_study_about_subject', 'breadcrumb_present'],
    avoid: [],
    notApplicable: []
  },
  GENERIC: {
    core: ['structured_data_parses'],
    recommended: ['generic_webpage_representation', 'breadcrumb_present'],
    avoid: [],
    notApplicable: []
  }
}

const PAGE_TYPE_TO_PROFILE = {
  Home: 'HOME', About: 'ABOUT', Contact: 'CONTACT', Service: 'SERVICE',
  Article: 'ARTICLE', 'Case Study': 'CASE_STUDY'
}

// isLocationHubPath(path) -> true iff `path` IS the bare location-index
// segment itself (no leaf beneath it) -- real, structural, sitemap-shape
// evidence, not a guess about what the page contains.
function isLocationHubPath(path) {
  if (!path) return false
  return /^\/(locations?|service-areas?|areas-we-serve)\/?$/i.test(path)
}

// resolveLocationProfile(path, ctx) -> one of LOCATION_HUB, SERVICE_AREA,
// LOCATION_UNCONFIRMED. See file header for the full reasoning -- in short:
// hub path -> LOCATION_HUB (structural fact); an unverified physical-
// business claim already on the page -> LOCATION_UNCONFIRMED (flagged for
// review, never silently trusted); otherwise -> SERVICE_AREA, the
// conservative default for a geography-targeted leaf page with no physical
// claim to begin with. PHYSICAL_LOCATION is never returned here -- see
// header for why.
function resolveLocationProfile(path, ctx) {
  if (isLocationHubPath(path)) return 'LOCATION_HUB'
  const claimTypes = BUSINESS_ENTITY_TYPES.filter(t => t !== 'Organization')
  const hasPhysicalClaim = claimTypes.some(t => (ctx.byType[t] || []).some(inst => hasWellFormedAddress(inst)))
  return hasPhysicalClaim ? 'LOCATION_UNCONFIRMED' : 'SERVICE_AREA'
}

// resolveTargetProfile(pageType, ctx) -> a TARGET_PROFILES key.
function resolveTargetProfile(pageType, ctx) {
  if (pageType === 'Location') return resolveLocationProfile(ctx.path, ctx)
  return PAGE_TYPE_TO_PROFILE[pageType] || 'GENERIC'
}

// ---------------------------------------------------------------------
// EXECUTION
// ---------------------------------------------------------------------

// runChecksForProfile(profileName, ctx) -> the full diagnostic result for
// an EXPLICITLY named profile -- the primitive resolveTargetProfile-based
// auto-selection (runPageTypeChecks, below) is built on. Exposed directly
// so a profile the auto-resolver never selects on its own this pass
// (PHYSICAL_LOCATION) is still fully runnable and testable.
function scoreCheck(id, tier, ctx) {
  const { label, evaluate, evidence } = CHECK_CATALOG[id]
  const result = evaluate(ctx)
  return { id, label, tier, status: result === 'pass' ? 'pass' : 'fail', state: stateFor(tier, result), evidence: evidence(ctx, result) }
}

function runChecksForProfile(profileName, ctx) {
  const profile = TARGET_PROFILES[profileName] || TARGET_PROFILES.GENERIC

  const coreChecks = profile.core.map(id => scoreCheck(id, 'core', ctx))
  const recommendedChecks = profile.recommended.map(id => scoreCheck(id, 'recommended', ctx))

  const avoidFindings = []
  profile.avoid.forEach(id => {
    const { label, evaluate, evidence } = CHECK_CATALOG[id]
    const result = evaluate(ctx)
    if (result !== 'pass') avoidFindings.push({ id, label, evidence: evidence(ctx, result) })
  })

  const notApplicable = (profile.notApplicable || []).map(id => ({ id, label: CHECK_CATALOG[id].label, state: 'NOT_APPLICABLE' }))

  const finalStatus = computeFinalStatus(profileName, coreChecks, recommendedChecks)

  return {
    targetProfile: profileName,
    currentSchema: ctx.schemaNames,
    coreChecks,
    recommendedChecks,
    avoidFindings,
    notApplicable,
    finalStatus
  }
}

// computeFinalStatus -- correction #10's exact rule, plus the
// LOCATION_UNCONFIRMED override (see that profile's own comment above):
// "do not guess" means this profile can report ACTION_REQUIRED (a real,
// confirmable defect, e.g. broken JSON-LD) but never NO_ACTION_NEEDED or
// IMPROVEMENT_AVAILABLE, since both would imply we know enough about this
// page's true identity to conclude anything past "we can't tell yet."
function computeFinalStatus(profileName, coreChecks, recommendedChecks) {
  if (coreChecks.some(c => c.status === 'fail')) return 'ACTION_REQUIRED'
  if (profileName === 'LOCATION_UNCONFIRMED') return 'COULD_NOT_VERIFY'
  if (recommendedChecks.some(c => c.status === 'fail')) return 'IMPROVEMENT_AVAILABLE'
  return 'NO_ACTION_NEEDED'
}

// runPageTypeChecks(pageType, { byType, schemaNames, failed, scriptCount,
//   parseFailureCount, path }) -> the auto-resolving entry point
// lib/pageAnalysis.js calls. Resolves the target profile from the page's
// classified type (+ path, for Location) and runs it.
function runPageTypeChecks(pageType, rawCtxInput = {}) {
  const ctx = buildContext(rawCtxInput)
  const profileName = resolveTargetProfile(pageType, ctx)
  return runChecksForProfile(profileName, ctx)
}

module.exports = {
  CHECK_CATALOG,
  TARGET_PROFILES,
  PRESENCE_QUALITY_STATES,
  buildContext,
  resolveEntityReference,
  resolveTargetProfile,
  resolveLocationProfile,
  isLocationHubPath,
  runChecksForProfile,
  runPageTypeChecks,
  computeFinalStatus
}
