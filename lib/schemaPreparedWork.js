// PAGE-TYPE-DISPATCHED PREPARED SCHEMA WORK GENERATOR (Phase 6,
// 2026-09-03). Turns a page's diagnosed gaps into a content-defensible,
// KEEP/ADD/MODIFY/REMOVE-categorized proposal an AM can review, edit, and
// approve -- see lib/opportunityLifecycle.js's prepareWork() for the
// durable-versioning primitive this feeds. Deliberately NOT
// lib/schemaGenerator.js reused blindly -- that generator is homepage/
// business-entity-specific (a single LocalBusiness/Organization node built
// from the `clients` table's own confirmed fields) and has no concept of
// an arbitrary page's existing schema, a page-specific subtype, or a
// canonical-entity cross-reference. This file is the generalized version
// correction #3 asked for.
//
// CONTENT-DEFENSIBILITY DISCIPLINE (explicit instruction: "do not fabricate
// properties"): this generator only ever proposes two kinds of thing --
// (1) a page-specific TYPE/subtype node built from real, already-fetched
// evidence (the page's own URL, its own existing schema types) plus a
// REFERENCE to a business entity already declared elsewhere on the SAME
// page (never inventing the business entity's own facts -- name/phone/
// address/etc. are never synthesized here, only pointed to via @id), and
// (2) a structural MODIFY to a node that already exists on the page,
// adding a relationship property that resolves to that same real,
// page-declared entity. It never invents Service.serviceType, Article
// headline/author/datePublished, or an ItemList of location links --
// those require real page CONTENT (not just JSON-LD) this pipeline does
// not extract, and fabricating them would violate the approved
// methodology's "no fabrication" rule. Where evidence is insufficient,
// this reports why (`unresolvedDependencies`) rather than guessing.
//
// CANONICAL ENTITY HANDLING (correction #8): detectCanonicalEntityRef
// inspects the page's OWN existing schema for a real, already-in-use @id.
// It never invents `${origin}/#organization}` or any other synthetic id --
// lib/schemaGenerator.js's generateBusinessSchema() does not emit an @id
// today, so on a real, currently-live Firestarter page the canonical
// entity is expected to come back UNRESOLVED, and that is reported
// honestly as an unresolved dependency rather than silently fabricated.
//
// CURRENT SCHEMA PRESERVATION (correction #4): `keep` is always the full,
// real list of schema type names already on the page (from a fresh parse
// of the actual live HTML -- never invented, never a stale cached value).
// Every proposal in this file is additive/conservative by default: `add`
// for a brand-new page-specific node (Yoast/RankMath/plugin-generated
// nodes are never touched), `modify` only for a narrowly-scoped structural
// patch to an existing node (adding one missing relationship property),
// and `remove` is always empty this pass -- no covered profile's Core/
// Recommended gap this pass ever calls for deleting existing markup.

const { resolvePageUrl } = require('./pageAnalysis')
const { fetchWebPage } = require('./webPageFetch')
const { parseJsonLd } = require('./checkers/lightweight-jsonld')
const { buildContext } = require('./schemaPageTypeChecks')

function nowIso() { return new Date().toISOString() }

// detectCanonicalEntityRef(businessEntityNodes) -> { id, resolved, source,
// entityName? , candidates? }. "Prefer reusing the real canonical
// Organization @id already present. If none can be confidently
// identified: surface that as an unresolved dependency rather than
// fabricating one" (correction #8) -- implemented literally: exactly one
// distinct @id among the page's real business-entity nodes -> resolved;
// zero, or more than one distinct @id (ambiguous -- we cannot confidently
// pick) -> unresolved, with the reason recorded.
function detectCanonicalEntityRef(businessEntityNodes) {
  const withId = (businessEntityNodes || []).filter(n => n && typeof n['@id'] === 'string' && n['@id'].trim())
  const distinctIds = [...new Set(withId.map(n => n['@id']))]
  if (distinctIds.length === 1) {
    const node = withId.find(n => n['@id'] === distinctIds[0])
    return { id: distinctIds[0], resolved: true, source: 'existing_schema', entityName: node.name || null }
  }
  if (distinctIds.length > 1) {
    return { id: null, resolved: false, source: 'ambiguous_multiple_ids', candidates: distinctIds }
  }
  return { id: null, resolved: false, source: 'no_id_present' }
}

function unresolvedCanonicalMessage(canonical, relationshipProp, nodeLabel) {
  return `A canonical Organization @id could not be confidently identified on this page (${canonical.source}). ` +
    `The "${relationshipProp}" reference on the ${nodeLabel} was left out rather than fabricated -- resolve a stable, ` +
    'reused canonical Organization @id (e.g. on the homepage schema) before this relationship can be added.'
}

// SUBTYPE_SPEC -- the About/Contact pattern: a more specific WebPage
// subtype, plus an about/mainEntity relationship to the canonical entity
// (correction #9's entity-graph discipline). About is this pass's
// end-to-end reference implementation (instruction #9); Contact reuses the
// identical, already-generalized shape, verifying the architecture
// extends beyond a single hardcoded page type.
const SUBTYPE_SPEC = {
  ABOUT: { pageSchemaType: 'AboutPage', subtypeCheckId: 'about_page_subtype', relationshipCheckId: 'about_entity_relationship_present', relationshipProp: 'about' },
  CONTACT: { pageSchemaType: 'ContactPage', subtypeCheckId: 'contact_page_subtype', relationshipCheckId: 'contact_entity_relationship_present', relationshipProp: 'about' }
}

function failingCheckIds(coreChecks, recommendedChecks) {
  return new Set(
    [...(coreChecks || []), ...(recommendedChecks || [])]
      .filter(c => c.status === 'fail')
      .map(c => c.id)
  )
}

// buildSubtypePageProposal -- About/Contact ADD proposal. Never fabricates
// the business entity's own facts -- the relationship property is always
// a bare {"@id": ...} reference, never an inlined copy of the entity.
function buildSubtypePageProposal({ profile, pageUrl, canonical, gaps }) {
  const spec = SUBTYPE_SPEC[profile]
  const needsSubtype = gaps.has(spec.subtypeCheckId)
  const needsRelationship = gaps.has(spec.relationshipCheckId)
  const add = []
  const unresolvedDependencies = []

  if (needsSubtype || needsRelationship) {
    const node = { '@context': 'https://schema.org', '@type': spec.pageSchemaType }
    if (pageUrl) {
      node['@id'] = `${pageUrl}#${spec.pageSchemaType.toLowerCase()}`
      node.url = pageUrl
    }
    let referenced = false
    if (needsRelationship) {
      if (canonical.resolved) {
        node[spec.relationshipProp] = { '@id': canonical.id }
        referenced = true
      } else {
        unresolvedDependencies.push(unresolvedCanonicalMessage(canonical, spec.relationshipProp, `new ${spec.pageSchemaType} node`))
      }
    }
    add.push({
      description: `${spec.pageSchemaType} node${referenced ? `, with "${spec.relationshipProp}" referencing the canonical Organization` : ''}`,
      node
    })
  }
  return { add, modify: [], unresolvedDependencies }
}

// buildEntityRelationshipModifyProposal -- shared fallback for a profile
// whose primary construct (Service, Article/BlogPosting/CreativeWork)
// ALREADY exists on the page but is missing its relationship to the
// canonical entity. Only ever proposes attaching a real reference to an
// already-present node (structural, not content fabrication) -- never
// invents the node itself, since its name/serviceType/headline cannot be
// safely derived from JSON-LD alone.
function buildEntityRelationshipModifyProposal({ relationshipProp, canonical, nodeLabel }) {
  if (!canonical.resolved) {
    return { modify: [], unresolvedDependencies: [unresolvedCanonicalMessage(canonical, relationshipProp, `existing ${nodeLabel} node`)] }
  }
  return {
    modify: [{
      description: `Add "${relationshipProp}": {"@id": "${canonical.id}"} to the existing ${nodeLabel} node`,
      node: { [relationshipProp]: { '@id': canonical.id } }
    }],
    unresolvedDependencies: []
  }
}

function nodeTypeLabel(node) {
  if (!node) return 'node'
  const t = node['@type']
  return Array.isArray(t) ? t.join('/') : (t || 'node')
}

// dispatchProposal(targetProfile, {pageUrl, canonical, gaps, byType,
// schemaNames}) -> {add, modify, unresolvedDependencies}. One function per
// profile family; profiles this pass does not have a real, defensible
// generator for (PHYSICAL_LOCATION, LOCATION_UNCONFIRMED, GENERIC, HOME)
// fall through to the default "nothing proposed" branch -- honest, not
// fabricated, and consistent with those profiles never producing
// ACTION_REQUIRED/IMPROVEMENT_AVAILABLE-with-a-real-gap in a way this
// generator would be asked to act on in practice this pass.
function dispatchProposal(targetProfile, { pageUrl, canonical, gaps, byType, schemaNames }) {
  if (SUBTYPE_SPEC[targetProfile]) {
    return buildSubtypePageProposal({ profile: targetProfile, pageUrl, canonical, gaps })
  }

  if (targetProfile === 'SERVICE' || targetProfile === 'SERVICE_AREA') {
    const services = byType.Service || []
    const providerGapId = targetProfile === 'SERVICE' ? 'service_provider_relationship' : 'service_area_provider_relationship'
    if (services.length === 0) {
      return { add: [], modify: [], unresolvedDependencies: ['No Service schema exists on this page. This platform does not fabricate Service name/serviceType from page content it has not extracted -- generating a defensible Service node requires the actual service description, which is not yet part of this analysis pipeline.'] }
    }
    if (gaps.has(providerGapId)) {
      return buildEntityRelationshipModifyProposal({ relationshipProp: 'provider', canonical, nodeLabel: 'Service' })
    }
    return { add: [], modify: [], unresolvedDependencies: [] }
  }

  if (targetProfile === 'LOCATION_HUB') {
    const add = []
    const modify = []
    const unresolvedDependencies = []
    if (gaps.has('hub_collection_page_subtype') && schemaNames.includes('WebPage') && !schemaNames.includes('CollectionPage')) {
      modify.push({ description: 'Broaden the existing WebPage node\'s @type to also include CollectionPage', node: { '@type': ['WebPage', 'CollectionPage'] } })
    }
    if (gaps.has('hub_item_list_present')) {
      unresolvedDependencies.push('An ItemList of this hub\'s linked location pages cannot be generated without extracting the page\'s actual link structure -- not yet part of this analysis pipeline. No ItemList was fabricated.')
    }
    return { add, modify, unresolvedDependencies }
  }

  if (targetProfile === 'ARTICLE' || targetProfile === 'CASE_STUDY') {
    const articleNodes = [...(byType.Article || []), ...(byType.BlogPosting || []), ...(byType.CreativeWork || [])]
    const publisherGapId = targetProfile === 'ARTICLE' ? 'article_publisher_relationship' : 'case_study_publisher_relationship'
    if (articleNodes.length === 0) {
      return { add: [], modify: [], unresolvedDependencies: ['No Article/BlogPosting/CreativeWork schema exists on this page. This platform does not fabricate headline/author/datePublished from page content it has not extracted.'] }
    }
    if (gaps.has(publisherGapId)) {
      return buildEntityRelationshipModifyProposal({ relationshipProp: 'publisher', canonical, nodeLabel: nodeTypeLabel(articleNodes[0]) })
    }
    return { add: [], modify: [], unresolvedDependencies: [] }
  }

  return { add: [], modify: [], unresolvedDependencies: [] }
}

// toPreparedScriptSnippet(add) -> a paste-ready <script> block per ADD
// node, same convention as lib/schemaGenerator.js#toScriptSnippet -- only
// ADD nodes are rendered as standalone scripts (a MODIFY is a patch to an
// existing node, not a new script tag).
function toPreparedScriptSnippet(add) {
  return add.map(a => `<script type="application/ld+json">\n${JSON.stringify(a.node, null, 2)}\n</script>`).join('\n\n')
}

// buildPreparedSchemaWork({path, siteUrl, targetProfile, coreChecks,
// recommendedChecks, fetcher}) -> the full KEEP/ADD/MODIFY/REMOVE result,
// via a fresh, real fetch+parse of the live page (never trusts a
// possibly-stale cached diagnosis for the raw schema nodes it needs --
// canonical-@id detection and the current KEEP list must reflect the
// page's actual current markup). `coreChecks`/`recommendedChecks` are the
// caller's already-computed diagnosis (from the SAME analyzePage() call
// that established eligibility) -- only their check ids/status are used,
// to decide WHAT to propose; the raw schema nodes used to decide HOW are
// always freshly fetched here.
async function buildPreparedSchemaWork({ path, siteUrl, targetProfile, coreChecks = [], recommendedChecks = [], fetcher } = {}) {
  const preparedAt = nowIso()
  const pageUrl = resolvePageUrl(siteUrl, path)
  if (!pageUrl) {
    return {
      supported: false, reason: 'Could not resolve an absolute, same-origin URL for this page.',
      pageUrl: null, currentSchema: [], keep: [], add: [], modify: [], remove: [],
      canonicalEntity: { id: null, resolved: false, source: 'no_url' },
      unresolvedDependencies: [], scriptSnippet: '', preparedAt
    }
  }

  const fetchResult = await fetchWebPage(pageUrl, { fetcher, requireHtml: true })
  if (fetchResult.fetchState !== 'success') {
    return {
      supported: false,
      reason: `Could not fetch this page to prepare schema work (${fetchResult.failureCategory}: ${fetchResult.failureDetail}).`,
      pageUrl, currentSchema: [], keep: [], add: [], modify: [], remove: [],
      canonicalEntity: { id: null, resolved: false, source: 'fetch_failed' },
      unresolvedDependencies: [], scriptSnippet: '', preparedAt
    }
  }

  const { byType, schemaNames } = parseJsonLd(fetchResult.html)
  const ctx = buildContext({ byType, schemaNames, path })
  const canonical = detectCanonicalEntityRef(ctx.businessEntityNodes)
  const keep = [...schemaNames]
  const gaps = failingCheckIds(coreChecks, recommendedChecks)

  const { add, modify, unresolvedDependencies } = dispatchProposal(targetProfile, { pageUrl, canonical, gaps, byType, schemaNames })

  return {
    supported: add.length > 0 || modify.length > 0,
    reason: (add.length === 0 && modify.length === 0) ? 'No content-defensible schema change could be generated for this page\'s diagnosed gaps without fabricating evidence this pipeline does not have.' : null,
    pageUrl,
    currentSchema: keep,
    keep,
    add,
    modify,
    remove: [],
    canonicalEntity: canonical,
    unresolvedDependencies,
    scriptSnippet: toPreparedScriptSnippet(add),
    preparedAt
  }
}

module.exports = {
  detectCanonicalEntityRef,
  buildSubtypePageProposal,
  buildEntityRelationshipModifyProposal,
  dispatchProposal,
  toPreparedScriptSnippet,
  buildPreparedSchemaWork
}
