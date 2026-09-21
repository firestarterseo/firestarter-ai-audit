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
const { extractPageContentEvidence } = require('./schemaPageContentEvidence')

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

// ---------------------------------------------------------------------
// EVIDENCE-BACKED SERVICE GENERATION (Phase B, 2026-09-21). Unblocks the
// exact live case the investigation traced (a Service-profile page with
// ZERO pre-existing Service node, previously an unconditional "cannot
// fabricate" failure -- see dispatchProposal's SERVICE branch below) using
// only real, citable evidence from lib/schemaPageContentEvidence.js. This
// is deliberately conservative and narrow: it can establish Service.name
// (from a single, non-generic H1, or a defensibly page-specific <title> as
// a fallback) and Service.description (from a real <meta name="description">
// tag only), and reuses the EXISTING canonical-entity mechanism for
// provider unchanged. serviceType and areaServed are NEVER populated here
// -- see the approved design (sections 8/9): no safe evidence source for
// either exists yet, and this phase does not add one.
// ---------------------------------------------------------------------

// GENERIC_HEADING_DENYLIST -- small, deterministic, EXACT match (after
// normalization: trim/lowercase/collapse whitespace) rejection list for
// heading/title text too generic to safely become a Service.name.
// Deliberately not fuzzy/substring matching -- a real, specific service
// name that happens to CONTAIN one of these words (e.g. "Home Services
// SEO") must never be rejected just because of that; only an exact,
// whole-string match against this short list disqualifies a candidate.
const GENERIC_HEADING_DENYLIST = new Set([
  'services', 'our services', 'service', 'home', 'welcome',
  'welcome to our website', 'welcome to our site'
])
const MIN_SERVICE_NAME_LENGTH = 3

function normalizeForDenylist(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// isUsableServiceNameText(text) -> boolean. The one, deterministic quality
// gate on a name candidate -- never LLM/inference-based. Rejects empty/too-
// short text and an exact denylist match; everything else (including text
// this heuristic can't judge either way) passes through as usable, on the
// theory that a real H1/<title> string an AM can see and reject in review
// is safer than this platform silently refusing to ever propose anything.
function isUsableServiceNameText(text) {
  const normalized = normalizeForDenylist(text)
  if (normalized.length < MIN_SERVICE_NAME_LENGTH) return false
  if (GENERIC_HEADING_DENYLIST.has(normalized)) return false
  return true
}

// resolveServiceNameEvidence(contentEvidence) -> { name, evidence,
// rejectionReasons }. Preferred: exactly one H1, if usable. Fallback:
// <title>, only if also usable -- attempted whenever H1 is missing,
// ambiguous (2+), or generic/too-short, per the approved design. `name`/
// `evidence` are both null when neither source is usable; `rejectionReasons`
// is always populated in that case so the caller can report EXACTLY what
// was checked and why it was insufficient, never a generic refusal.
function resolveServiceNameEvidence(contentEvidence) {
  const rejectionReasons = []
  const h1s = (contentEvidence?.headings || []).filter(h => h.level === 1)
  const h1Count = contentEvidence?.headingCounts?.h1 || 0

  if (h1Count === 1 && h1s.length === 1) {
    const h1 = h1s[0]
    if (isUsableServiceNameText(h1.value)) {
      return { name: h1.value, evidence: h1, rejectionReasons: [] }
    }
    rejectionReasons.push(`This page's single H1 ("${h1.value}") is too generic/short to safely use as a Service name.`)
  } else if (h1Count === 0) {
    rejectionReasons.push('This page has no H1 at all.')
  } else {
    rejectionReasons.push(`This page has ${h1Count} H1 elements -- which one is the service name is ambiguous, so none was used.`)
  }

  const title = contentEvidence?.documentMetadata?.title
  const titleUsable = title && title.evidenceClass !== 'UNAVAILABLE' && isUsableServiceNameText(title.value)
  if (titleUsable) {
    return { name: title.value, evidence: title, rejectionReasons: [] }
  }
  rejectionReasons.push((title && title.evidenceClass !== 'UNAVAILABLE')
    ? `This page's <title> ("${title.value}") is also too generic/short to safely use as a Service name.`
    : 'This page has no usable <title> either.')

  return { name: null, evidence: null, rejectionReasons }
}

// buildServiceNodeProposal({pageUrl, canonical, contentEvidence}) ->
// {add, modify, unresolvedDependencies}. The evidence-backed replacement
// for dispatchProposal's old unconditional "no Service schema exists ->
// cannot fabricate" branch, used ONLY when the page has zero pre-existing
// Service node. Still refuses outright (identical failure shape to before)
// when no usable name evidence exists at all -- this narrows WHEN the
// refusal fires, it does not remove it.
//
// @id CONVENTION: `${pageUrl}#service`, identical to buildSubtypePageProposal's
// established `${pageUrl}#${type.toLowerCase()}` pattern above (see e.g. the
// live AboutPage node's real `#aboutpage` @id) -- reusing the one convention
// already in use rather than inventing a second one. Deterministic and
// stable across repeated preparation since it is derived only from the
// page's own resolved URL.
function buildServiceNodeProposal({ pageUrl, canonical, contentEvidence }) {
  const { name, evidence: nameEvidence, rejectionReasons } = resolveServiceNameEvidence(contentEvidence)
  if (!name) {
    return {
      add: [], modify: [],
      unresolvedDependencies: [
        'No Service schema exists on this page, and no evidence-backed Service name could be established. ' +
        rejectionReasons.join(' ') +
        ' This platform does not fabricate a Service name from the URL slug, the client\'s confirmed service category, or inference.'
      ]
    }
  }

  const node = { '@context': 'https://schema.org', '@type': 'Service' }
  if (pageUrl) {
    node['@id'] = `${pageUrl}#service`
    node.url = pageUrl
  }
  node.name = name

  const unresolvedDependencies = []
  const evidenceUsed = { name: nameEvidence }
  let providerReferenced = false

  if (canonical.resolved) {
    node.provider = { '@id': canonical.id }
    providerReferenced = true
    evidenceUsed.provider = {
      value: canonical.id, evidenceClass: 'OBSERVED_STRUCTURED_DATA',
      sourceType: 'existing_schema_canonical_entity', sourceIndex: null, exactText: canonical.id
    }
  } else {
    // Ambiguous (multiple conflicting candidates) and absent are both
    // reported the SAME way as the existing About/Contact path already
    // does -- "do not choose silently" (section 7) is exactly what
    // detectCanonicalEntityRef already guarantees; this reuses that
    // guarantee rather than re-deciding it here.
    unresolvedDependencies.push(unresolvedCanonicalMessage(canonical, 'provider', 'new Service node'))
  }

  const descriptionEvidence = contentEvidence?.documentMetadata?.metaDescription
  let descriptionIncluded = false
  if (descriptionEvidence && descriptionEvidence.evidenceClass !== 'UNAVAILABLE') {
    node.description = descriptionEvidence.value
    descriptionIncluded = true
    evidenceUsed.description = descriptionEvidence
  } else {
    unresolvedDependencies.push('description omitted -- insufficient approved evidence')
  }

  // serviceType / areaServed -- NEVER populated this phase (sections 8/9).
  // Reported honestly as unresolved rather than silently missing, so an AM
  // reviewing this proposal sees exactly what was and wasn't established,
  // not just what happens to be present on the node.
  unresolvedDependencies.push('serviceType unresolved -- not inferred in this phase; add the specific service classification manually if desired.')
  unresolvedDependencies.push('areaServed unresolved -- page-level geographic evidence has not yet been approved for automatic mapping.')

  const descriptionParts = [`name from this page's ${nameEvidence.sourceType === 'title_tag' ? '<title>' : `<${nameEvidence.sourceType}>`} ("${name}")`]
  if (providerReferenced) descriptionParts.push('provider referencing the canonical Organization')
  if (descriptionIncluded) descriptionParts.push('description from this page\'s meta description')

  return {
    add: [{
      description: `Service node, ${descriptionParts.join(', ')}`,
      node,
      // PREPARED-WORK PROVENANCE (section 12) -- per-property evidence
      // actually used, not just the final JSON-LD. Persisted verbatim into
      // opportunity_prepared_work.payload (see prepare-work/route.js's
      // `payload: prepared`) since this whole buildPreparedSchemaWork()
      // result is stored as-is.
      evidence: evidenceUsed
    }],
    modify: [],
    unresolvedDependencies
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
function dispatchProposal(targetProfile, { pageUrl, canonical, gaps, byType, schemaNames, contentEvidence }) {
  if (SUBTYPE_SPEC[targetProfile]) {
    return buildSubtypePageProposal({ profile: targetProfile, pageUrl, canonical, gaps })
  }

  if (targetProfile === 'SERVICE' || targetProfile === 'SERVICE_AREA') {
    const services = byType.Service || []
    const providerGapId = targetProfile === 'SERVICE' ? 'service_provider_relationship' : 'service_area_provider_relationship'
    if (services.length === 0) {
      // 2026-09-21 Phase B -- was an unconditional "cannot fabricate"
      // refusal; now attempts an evidence-backed Service node first (see
      // buildServiceNodeProposal above), and only falls back to the same
      // honest refusal when no usable name evidence exists either.
      return buildServiceNodeProposal({ pageUrl, canonical, contentEvidence })
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
  // Same already-fetched HTML, same real page, second independent read --
  // see lib/schemaPageContentEvidence.js's own header for why this is a
  // separate module from parseJsonLd rather than folded into it (JSON-LD
  // vs. visible-content evidence are different questions with different
  // safety rules on what may be generated from them).
  const contentEvidence = extractPageContentEvidence(fetchResult.html)

  const { add, modify, unresolvedDependencies } = dispatchProposal(targetProfile, { pageUrl, canonical, gaps, byType, schemaNames, contentEvidence })

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
  buildPreparedSchemaWork,
  GENERIC_HEADING_DENYLIST,
  isUsableServiceNameText,
  resolveServiceNameEvidence,
  buildServiceNodeProposal
}
