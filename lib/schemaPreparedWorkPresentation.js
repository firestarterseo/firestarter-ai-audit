// AM-FACING PRESENTATION PRIMITIVES FOR PREPARED SCHEMA WORK (Phase C,
// 2026-09-23 -- Step 4 AM Review UI correction). Pure, network-free, zero
// dependencies, same discipline as every other lib/*.js module in this
// project.
//
// WHAT THIS FILE IS FOR: the UI audit found that a prepared page's real,
// correct evidence/provenance (payload.add[].evidence, already persisted by
// Phase B) was invisible to an AM -- SchemaWizard.js's SchemaChangeList only
// ever rendered a single prose sentence, and the per-property
// {value, evidenceClass, sourceType, exactText} shape was reachable only by
// reading the raw JSON-LD block. This file turns that EXISTING, ALREADY-
// CORRECT data into AM-readable presentation: which properties a prepared
// change actually sets, in what order, with a plain-language "where did
// this come from" caption -- and a generalized diagnosis summary/severity
// mapping for the Core-vs-Recommended distinction. It never changes what
// evidence exists or what was generated -- only how it's read out.
//
// SCOPE DISCIPLINE: nothing here re-derives a fact prepared-work generation
// already decided (a property's value, whether it was included, why
// something is unresolved). It only formats what's already in the payload.
// A property/kind this file doesn't have a nicer label for still renders
// (using its raw key/sourceType, humanized) -- never silently dropped.

// EVIDENCE_SOURCE_LABELS -- translates lib/schemaPageContentEvidence.js's
// engineering sourceType values (and the couple of sourceTypes
// lib/schemaPreparedWork.js's own canonical-entity mechanism uses) into a
// short, AM-readable phrase. Anything not listed here falls back to
// humanizeSourceType() -- a snake_case string turned into Title Case words
// -- rather than ever showing a raw enum-looking string in the primary view.
const EVIDENCE_SOURCE_LABELS = {
  h1: 'H1 on this page',
  h2: 'H2 on this page',
  h3: 'H3 on this page',
  title_tag: "This page's <title>",
  meta_description: 'Meta description on this page',
  meta_article_published_time: 'Published-date metadata on this page',
  meta_article_modified_time: 'Modified-date metadata on this page',
  meta_author: 'Author metadata on this page',
  existing_schema_canonical_entity: 'Existing canonical Organization schema',
  existing_schema: 'Existing schema already on this page'
}

// STRUCTURAL_PROPERTY_SOURCE_LABELS -- url/@id are never carried in
// payload.add[].evidence (they are deterministically derived from the
// page's own resolved URL, not sourced from a single page-content
// location -- see lib/schemaPreparedWork.js's `${pageUrl}#<type>`
// convention, used identically for every profile this pipeline generates).
// This is a fixed, architectural fact about HOW this pipeline builds these
// two properties, not a per-item claim -- safe to state generically for
// any node, new or legacy.
const STRUCTURAL_PROPERTY_SOURCE_LABELS = {
  url: "This page's resolved URL",
  '@id': "Derived from this page's canonical URL"
}

function humanizeSourceType(sourceType) {
  if (!sourceType) return null
  return sourceType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// describeEvidenceSource(sourceType) -> a short AM-readable phrase, or null
// for no sourceType at all. Never returns a raw enum-looking string
// (OBSERVED_PAGE_CONTENT, DOCUMENT_METADATA, ...) -- evidenceClass stays a
// machine-readable concept; sourceType is what gets translated here.
function describeEvidenceSource(sourceType) {
  if (!sourceType) return null
  return EVIDENCE_SOURCE_LABELS[sourceType] || humanizeSourceType(sourceType)
}

// ---------------------------------------------------------------------
// DIAGNOSIS SUMMARY -- "WHY WE'RE RECOMMENDING THIS" (section 3). Derived
// entirely from finalStatus/coreChecks/recommendedChecks -- the same real
// diagnosis every step already computes -- never a per-client hardcoded
// sentence. Only ACTION_REQUIRED and IMPROVEMENT_AVAILABLE are meaningful
// here (a review-stage item is never NO_ACTION_NEEDED/COULD_NOT_VERIFY --
// see lib/schemaPageLifecycle.js#classifyWorkStage -- but this stays honest
// rather than crashing if ever called with either).
// ---------------------------------------------------------------------
function summarizeDiagnosisForApproval({ finalStatus, coreChecks = [], recommendedChecks = [] } = {}) {
  const failingCore = (coreChecks || []).filter(c => c.status === 'fail')
  const failingRecommended = (recommendedChecks || []).filter(c => c.status === 'fail')

  if (finalStatus === 'ACTION_REQUIRED') {
    return {
      severity: 'core',
      headline: 'Core schema issue requires attention',
      detail: failingCore.length === 1
        ? failingCore[0].evidence
        : `${failingCore.length} core schema check${failingCore.length === 1 ? '' : 's'} failed on this page.`
    }
  }
  if (finalStatus === 'IMPROVEMENT_AVAILABLE') {
    return {
      severity: 'recommended',
      headline: 'Recommended enhancement, not a Core issue',
      detail: `This page's existing schema is structurally valid.${failingRecommended[0] ? ` ${failingRecommended[0].evidence}` : ''}`
    }
  }
  return { severity: 'neutral', headline: 'No actionable schema gap', detail: '' }
}

// checkSeverityTone(check) -> an `issue-badge` tone string. A FAILING Core
// check keeps the existing critical/red treatment (a real structural
// problem); a failing Recommended check gets a neutral/amber tone instead
// (an enhancement opportunity, never styled as identically alarming --
// section 5's presentation-only distinction, methodology/tier logic
// itself untouched). A passing check of either tier stays 'issue-passing'.
function checkSeverityTone(check) {
  if (!check) return 'issue-minor'
  if (check.status === 'pass') return 'issue-passing'
  return check.tier === 'core' ? 'issue-critical' : 'issue-minor'
}

// ---------------------------------------------------------------------
// WHAT WE'D ADD/MODIFY/REMOVE -- per-property, evidence-backed
// presentation (sections 6/7). Generalized over ANY prepared-work item
// shape this pipeline produces today (Service's evidence-backed ADD,
// About/Contact's SUBTYPE_SPEC ADD, the SERVICE/ARTICLE/CASE_STUDY
// relationship MODIFY) -- never Service-specific.
// ---------------------------------------------------------------------

// PROPERTY_LABELS -- schema.org property key -> AM-facing label. Anything
// not listed still renders under its own raw key (never dropped) -- this
// is a presentation nicety, not a completeness gate.
const PROPERTY_LABELS = {
  name: 'name', description: 'description', provider: 'provider',
  about: 'about', publisher: 'publisher', url: 'url', '@id': '@id',
  serviceType: 'serviceType', areaServed: 'areaServed'
}

// PROPERTY_ORDER -- the most-explanatory properties first (what/why),
// structural identity properties last (url/@id) -- matches the audit's own
// worked example ordering. Any property not in this list is appended
// after, in its original object-key order, so a future profile's new
// property is still shown, just without a curated position.
const PROPERTY_ORDER = ['name', 'description', 'provider', 'about', 'publisher', 'serviceType', 'areaServed', 'url', '@id']

function orderedPropertyKeys(node) {
  const keys = Object.keys(node || {}).filter(k => k !== '@context' && k !== '@type')
  const known = PROPERTY_ORDER.filter(k => keys.includes(k))
  const unknown = keys.filter(k => !PROPERTY_ORDER.includes(k))
  return [...known, ...unknown]
}

// buildPropertyPresentation(key, node, evidenceForItem, canonicalEntity) ->
// {key, label, value, supportingDetail, sourceLabel} | null (null only
// when the node genuinely has no value for this key -- never fabricated).
//
// PROVIDER/ABOUT/PUBLISHER SPECIAL CASE: these are always a bare
// {"@id": "..."} reference (never an inlined copy of the entity -- see
// lib/schemaPreparedWork.js's own "never fabricate the business entity's
// own facts" discipline). Showing the raw @id URL as the primary value
// would force an AM to recognize a URL as "the business," so when the
// SAME canonicalEntity this pipeline already resolved carries a real
// entityName (existing_schema-sourced, never invented), that name becomes
// the display value and the @id URL becomes supporting detail -- always
// shown, never hidden, just not the headline. This applies even to a
// LEGACY modify item with no per-property `evidence` at all, since
// canonicalEntity is a sibling of `add`/`modify` on every
// buildPreparedSchemaWork() result, old and new alike.
function buildPropertyPresentation(key, node, evidenceForItem, canonicalEntity) {
  const rawValue = node ? node[key] : undefined
  if (rawValue === undefined || rawValue === null) return null

  let value = typeof rawValue === 'object' ? (rawValue['@id'] || JSON.stringify(rawValue)) : String(rawValue)
  let supportingDetail = null

  if (typeof rawValue === 'object' && rawValue['@id'] && (key === 'provider' || key === 'about' || key === 'publisher')) {
    if (canonicalEntity && canonicalEntity.entityName) {
      value = canonicalEntity.entityName
      supportingDetail = rawValue['@id']
    } else {
      supportingDetail = null // no real name known -- the @id URL is already the primary value above, not repeated
    }
  }

  const evidence = evidenceForItem && evidenceForItem[key]
  const sourceLabel = evidence
    ? describeEvidenceSource(evidence.sourceType)
    : (STRUCTURAL_PROPERTY_SOURCE_LABELS[key] || null)

  return { key, label: PROPERTY_LABELS[key] || key, value, supportingDetail, sourceLabel }
}

// buildChangePresentation(item, kind, canonicalEntity) -> {
//   kind, nodeType, properties: [...], fallbackDescription
// }. `kind` is 'add' | 'modify' | 'remove' -- purely descriptive here
// (REMOVE items carry no node today; nothing in this pipeline produces
// one yet -- see lib/schemaPreparedWork.js's own header -- but this stays
// shape-agnostic rather than assuming ADD's shape). Every property the
// node actually carries is presented; a legacy item with no `.evidence`
// at all still renders its real properties, just without a sourceLabel on
// each -- graceful degradation, never a broken/empty view. Only when the
// item has NO presentable properties at all does this fall back to the
// item's own prose `description`.
function buildChangePresentation(item, kind, canonicalEntity) {
  if (!item) return null
  const node = item.node || {}
  const nodeTypeRaw = node['@type']
  const nodeType = Array.isArray(nodeTypeRaw) ? nodeTypeRaw.join(' / ') : (nodeTypeRaw || null)
  const evidenceForItem = item.evidence || null
  const properties = orderedPropertyKeys(node)
    .map(k => buildPropertyPresentation(k, node, evidenceForItem, canonicalEntity))
    .filter(Boolean)

  return {
    kind,
    nodeType,
    properties,
    fallbackDescription: properties.length === 0 ? (item.description || null) : null
  }
}

// ---------------------------------------------------------------------
// WHAT WE'RE DELIBERATELY LEAVING OUT (section 9). Best-effort parse of an
// unresolvedDependencies prose sentence into {property, reason} for a
// cleaner "<property> -- Not added -- <reason>" row. This is a DISPLAY-
// ONLY parse of the EXISTING string array -- lib/schemaPreparedWork.js's
// unresolvedDependencies shape is not changed by this file. A sentence
// that doesn't match this exact "<word> unresolved/omitted -- <reason>"
// shape (e.g. the canonical-entity-unresolved message, which names a
// property inside a longer sentence rather than leading with it) falls
// back to `property: null` -- rendered as a plain bullet, never a
// fabricated property name.
// ---------------------------------------------------------------------
const UNRESOLVED_DEPENDENCY_PATTERN = /^([a-zA-Z@][\w@]*) (?:unresolved|omitted) -- (.+)$/

function parseUnresolvedDependency(text) {
  const match = UNRESOLVED_DEPENDENCY_PATTERN.exec(text || '')
  if (!match) return { property: null, reason: text || '' }
  return { property: match[1], reason: match[2] }
}

module.exports = {
  EVIDENCE_SOURCE_LABELS,
  STRUCTURAL_PROPERTY_SOURCE_LABELS,
  PROPERTY_LABELS,
  PROPERTY_ORDER,
  describeEvidenceSource,
  summarizeDiagnosisForApproval,
  checkSeverityTone,
  orderedPropertyKeys,
  buildPropertyPresentation,
  buildChangePresentation,
  parseUnresolvedDependency
}
