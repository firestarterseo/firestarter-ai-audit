// ENTITY & BRAND AUTHORITY -- Phase 1: TARGET SELECTION PRIMITIVE
// (2026-09-02).
//
// Answers "what brand-association targets should this client actually be
// evaluated for?" -- deterministically, from Client/Industry Intelligence
// (lib/clientProfileFields.js / lib/clientIndustryIntelligence.js) and
// Prompt/Topic Intelligence's benchmark topic clusters
// (lib/topicClusters.js). This is Phase 1 ONLY: target selection. It does
// not fetch pages, does not call an LLM, does not touch Supabase, does not
// create opportunities, and is not wired into any pillar, navigation, or
// runAudit.js. Standing product status: entity_citation_authority is LIVE
// LEGACY and untouched by this file; entity_brand_authority is
// APPROVED / NOT IMPLEMENTED beyond this primitive.
//
// DB-INDEPENDENT AND PURE, DELIBERATELY: this file has ZERO require()
// statements. It never imports lib/clientProfileFields.js,
// lib/clientIndustryIntelligence.js, or lib/topicClusters.js, even though
// each of those exports a vocabulary constant (CONFIDENCE_VALUES,
// BUSINESS_PRIORITY_VALUES, ...) this file needs. Those constants are
// mirrored below as local literals instead of imported, for the same
// reason app/clients/[id]/SchemaWizard.js hardcodes PAGE_TYPE_OPTIONS/
// PRIORITY_TIER_OPTIONS rather than importing lib/sitemapDiscovery.js's
// PAGE_TYPES: importing any of those three modules pulls
// lib/supabaseServer.js (and therefore @supabase/supabase-js) into this
// module's require graph, even though calling that code is never
// necessary here. "DB-independent and pure" is enforced at the
// require-graph level, not just at the call-site level -- if this file
// required zero DB-touching modules but happened to call one of their
// functions, that would still violate the phase's own charter the moment
// someone else called this file from a context without Supabase env
// vars configured. Zero requires makes that structurally impossible.
// (Tests 14-16 below assert this directly by scanning this file's own
// source text.) If clientProfileFields.js's CONFIDENCE_VALUES or
// topicClusters.js's BUSINESS_PRIORITY_VALUES/TOPIC_CLUSTER_STATUSES ever
// change, the mirrored literals immediately below must be updated to
// match -- there is no automatic sync, by design (same tradeoff
// SchemaWizard.js already accepted for its own literal duplicates).
//
// INPUT SHAPES -- traced from the real code, not assumed from the
// methodology report (see the Phase 1 report's section A for the full
// trace). This module's two inputs:
//
//   profile: the object lib/clientIndustryIntelligence.js's
//     getClientIndustryProfile(clientId) actually returns. Only these
//     properties are read (everything else on that object -- businessModel,
//     industry, verticalSubindustry, primaryCustomerUseCase,
//     openRecommendations, legacyCategory, summary, hasAnyProfileData -- is
//     ignored, since none of them are one of the 4 approved target
//     sources):
//       profile.specialty                  -> { value, confidence,
//         evidence, confirmationStatus, lastVerifiedAt } | null
//       profile.primaryProductsServices     -> array of { itemIndex, value,
//         confidence, evidence, confirmationStatus, lastVerifiedAt }
//       profile.secondaryProductsServices   -> same list shape
//       profile.primaryGeographyMarkets     -> same list shape
//     `evidence` on every one of those items is already an ARRAY (of
//     evidence objects, e.g. { text, source, collectedAt } for
//     LLM-classified items) -- confirmed by reading
//     clientIndustryIntelligence.js's persistClassification, which always
//     writes evidence as an array via writeSystemDetectedField. `confidence`
//     is one of 'confirmed_by_direct_evidence' | 'likely' | 'uncertain' |
//     null (lib/clientProfileFields.js's CONFIDENCE_VALUES). `confirmationStatus`
//     is one of 'unconfirmed' | 'confirmed' | 'overridden' |
//     'stale_recommendation_pending' (no shared exported enum exists for
//     this anywhere in the codebase -- confirmed by grep; the values above
//     are mirrored from clientProfileFields.js's own DB-function branch
//     names and app/clients/[id]/ClientIntelligenceCard.js's STATUS_STYLE
//     keys, the only two places that enumerate them today).
//     getClientIndustryProfile's own listField()/scalarField() projections
//     already filter out value===null items before this module ever sees
//     them, so every item this module receives is expected to carry a
//     real, non-null value -- this file still defensively re-checks that,
//     since a caller could pass a differently-shaped object.
//
//   topicClusters: the RAW array lib/topicClusters.js's
//     getTopicClustersForClient(clientId) / getTopicClustersWithVariations
//     actually returns -- i.e. `select('*')` rows straight from the
//     topic_clusters table, in snake_case (NOT the camelCase shape
//     getClientIndustryProfile uses -- these are two genuinely different
//     read models in the real code, confirmed by reading both files; this
//     module must not assume one shape covers both). Only these columns
//     are read:
//       cluster.status            -> 'benchmark' | 'candidate' | 'retired'
//       cluster.id                -> topic_clusters.id (uuid)
//       cluster.name              -> string
//       cluster.business_priority -> 'none' | 'strategic'
//       cluster.evidence          -> array of { type, detail } (confirmed
//         by reading topicClusters.js's insertCandidateTopicCluster and
//         promptTopicIntelligence.js's DISCOVERY_TOOL schema)
//     ONLY status === 'benchmark' rows ever become targets -- per Product
//     Decision and TARGET SOURCES section 3 ("Do not allow unreviewed
//     candidate topic clusters to become Entity & Brand Authority
//     targets"), enforced inside buildTopicTargets below regardless of
//     what the caller passes in, not trusted to have been pre-filtered.
//     topic_clusters has NO confidence column at all (confirmed by reading
//     every INSERT/RPC call site in lib/topicClusters.js and
//     lib/promptTopicIntelligence.js) -- see "confidence: null" in
//     buildTopicTargets below for why this is left honestly absent rather
//     than invented from an unrelated signal.

// -----------------------------------------------------------------------
// Mirrored vocabulary (see header for why these are literals, not imports)
// -----------------------------------------------------------------------

// Mirrors lib/clientProfileFields.js's exported CONFIDENCE_VALUES exactly.
const CONFIDENCE_VALUES = ['confirmed_by_direct_evidence', 'likely', 'uncertain']

// Mirrors the real confirmation_status values used throughout
// lib/clientProfileFields.js (DB-function branch names) and
// app/clients/[id]/ClientIntelligenceCard.js's STATUS_STYLE keys -- no
// shared exported enum exists for this today. 'legacy_unconfirmed_category'
// (a synthetic status clientIndustryIntelligence.js invents only for the
// `industry` field's legacy-category fallback) is deliberately excluded:
// it can never appear on specialty/products/geography fields, the only
// fields this module reads.
const CONFIRMATION_STATUSES = ['unconfirmed', 'confirmed', 'overridden', 'stale_recommendation_pending']

// Mirrors lib/topicClusters.js's exported BUSINESS_PRIORITY_VALUES exactly.
const BUSINESS_PRIORITY_VALUES = ['none', 'strategic']

// -----------------------------------------------------------------------
// Target contract
// -----------------------------------------------------------------------

const TARGET_TYPES = ['service', 'specialty', 'geography', 'topic']

const DEFAULT_SOFT_CAP = 8

// normalizeConfidence/normalizeConfirmationStatus -- defensive against a
// caller passing a differently-shaped or stale object; never throws.
// Unknown/missing confidence maps to null (honestly "no confidence data"),
// unknown/missing confirmation status maps to 'unconfirmed' (the least-
// trusted bucket -- never silently upgrade a status this module doesn't
// recognize).
function normalizeConfidence(value) {
  return CONFIDENCE_VALUES.includes(value) ? value : null
}
function normalizeConfirmationStatus(value) {
  return CONFIRMATION_STATUSES.includes(value) ? value : 'unconfirmed'
}

function hasRealValue(item) {
  return !!item && item.value != null && String(item.value).trim() !== ''
}

// buildServiceTargets(profile) -> target[] for both primary and secondary
// products/services. sourceRef.fieldKey is what later lets ranking apply
// "primary over secondary where the real data distinguishes this" -- see
// serviceOriginRank below. businessPriority is null for every service
// target: client_profile_fields has no business-priority concept at all
// (that only exists on topic_clusters) -- left honestly absent rather than
// invented from primary-vs-secondary status, which is a different axis
// (evidence provenance, not strategic importance).
function buildServiceTargets(profile) {
  const sources = [
    { items: profile && profile.primaryProductsServices, fieldKey: 'primary_products_services' },
    { items: profile && profile.secondaryProductsServices, fieldKey: 'secondary_products_services' }
  ]
  const out = []
  for (const { items, fieldKey } of sources) {
    for (const item of items || []) {
      if (!hasRealValue(item)) continue
      out.push({
        targetType: 'service',
        canonicalLabel: String(item.value).trim(),
        aliases: [],
        sourceRef: { store: 'client_profile_fields', fieldKey, itemIndex: item.itemIndex },
        confidence: normalizeConfidence(item.confidence),
        confirmationStatus: normalizeConfirmationStatus(item.confirmationStatus),
        evidence: Array.isArray(item.evidence) ? item.evidence : [],
        businessPriority: null
      })
    }
  }
  return out
}

// buildSpecialtyTarget(profile) -> target | null. Specialty is a scalar
// field (always item_index 0) -- see clientProfileFields.js's FIELD_KEYS /
// SCALAR_FIELD_KEYS. Returns null (no target) when no meaningful specialty
// is evidenced, exactly mirroring clientIndustryIntelligence.js's own
// "return null when no meaningful specialty exists" contract for this
// field -- this module never invents a specialty that upstream classification
// declined to assert.
function buildSpecialtyTarget(profile) {
  const item = profile && profile.specialty
  if (!hasRealValue(item)) return null
  return {
    targetType: 'specialty',
    canonicalLabel: String(item.value).trim(),
    aliases: [],
    sourceRef: { store: 'client_profile_fields', fieldKey: 'specialty', itemIndex: 0 },
    confidence: normalizeConfidence(item.confidence),
    confirmationStatus: normalizeConfirmationStatus(item.confirmationStatus),
    evidence: Array.isArray(item.evidence) ? item.evidence : [],
    businessPriority: null
  }
}

// buildGeographyTargets(profile) -> target[] from primary_geography_markets.
function buildGeographyTargets(profile) {
  const out = []
  for (const item of (profile && profile.primaryGeographyMarkets) || []) {
    if (!hasRealValue(item)) continue
    out.push({
      targetType: 'geography',
      canonicalLabel: String(item.value).trim(),
      aliases: [],
      sourceRef: { store: 'client_profile_fields', fieldKey: 'primary_geography_markets', itemIndex: item.itemIndex },
      confidence: normalizeConfidence(item.confidence),
      confirmationStatus: normalizeConfirmationStatus(item.confirmationStatus),
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      businessPriority: null
    })
  }
  return out
}

// buildTopicTargets(topicClusters) -> target[] from BENCHMARK topic
// clusters only -- candidate/retired clusters are excluded unconditionally
// here, never trusting the caller to have pre-filtered (Product Decision:
// "Do not allow unreviewed candidate topic clusters to become Entity &
// Brand Authority targets").
//
// confirmationStatus is hardcoded to 'confirmed' for every topic target --
// not a guess, but an accurate description of real state: the ONLY path
// a topic_clusters row ever reaches status='benchmark' is
// fn_approve_topic_cluster, an explicit AM action (see topicClusters.js's
// header: "Discovery may NEVER silently create a benchmark row"). A
// benchmark cluster is, by construction, already AM-approved -- so
// 'confirmed' here reuses the real existing state (approved_at is set),
// not business_priority_status (a different question: whether the AM
// confirmed the SUGGESTED business-priority flag, not whether the topic
// itself was approved).
//
// confidence is honestly null: topic_clusters has no confidence column at
// all (see this file's header). Deriving a pseudo-confidence from an
// unrelated signal (evidence array length, discovery_method, etc.) would
// itself be "creating a second confidence system merely for this pillar,"
// exactly what's disallowed -- so it's left absent rather than invented.
function buildTopicTargets(topicClusters) {
  const out = []
  for (const cluster of topicClusters || []) {
    if (!cluster || cluster.status !== 'benchmark') continue
    if (!cluster.name || !String(cluster.name).trim()) continue
    out.push({
      targetType: 'topic',
      canonicalLabel: String(cluster.name).trim(),
      aliases: [],
      sourceRef: { store: 'topic_cluster', clusterId: cluster.id },
      confidence: null,
      confirmationStatus: 'confirmed',
      evidence: Array.isArray(cluster.evidence) ? cluster.evidence : [],
      businessPriority: BUSINESS_PRIORITY_VALUES.includes(cluster.business_priority) ? cluster.business_priority : null
    })
  }
  return out
}

// -----------------------------------------------------------------------
// Service / specialty overlap -- conservative, deterministic, no LLM.
// -----------------------------------------------------------------------

// A short, genuinely generic stopword list -- same discipline as
// lib/schemaPagePriority.js's own STOPWORDS (a proven, already-approved
// pattern in this codebase), reimplemented locally rather than imported so
// this module stays fully decoupled from the unrelated Schema & Structure
// pillar (see this file's header on why it imports nothing at all).
const OVERLAP_STOPWORDS = new Set(['and', 'the', 'of', 'for', 'a', 'an', 'in', 'on', 'at', 'to', 'with', 'services', 'service'])
const OVERLAP_MIN_TOKEN_LENGTH = 3

function tokenize(label) {
  return new Set(
    String(label || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= OVERLAP_MIN_TOKEN_LENGTH && !OVERLAP_STOPWORDS.has(t))
  )
}

function isSubset(smaller, larger) {
  for (const token of smaller) if (!larger.has(token)) return false
  return true
}

// tokensConservativelyOverlap(a, b) -> boolean. True only for an EXACT
// token-set match or a full-subset relation in either direction -- never a
// partial/fuzzy/substring match, and never true when either side tokenizes
// to nothing (an empty token set means "no distinctive evidence either
// way," so no determination is made, per "omit the flag ... rather than
// pretending certainty"). This is a mechanical, reused-in-spirit technique
// (the same full-token-subset rule lib/schemaPagePriority.js already uses
// for client-intelligence slug matching) -- not a synonym/semantic system.
// It will NOT catch "SEO" vs. "search engine optimization" (correct, per
// the Aliases section: that relationship isn't evidenced anywhere in this
// codebase's data, so this module must not assume it).
function tokensConservativelyOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return false
  if (a.size === b.size && isSubset(a, b)) return true
  return isSubset(a, b) || isSubset(b, a)
}

// applyOverlapFlags(targets) -> new array, same order, with possibleOverlap:
// true added to any specialty/service pair whose canonical labels
// conservatively overlap (see above). Only ever compares specialty <->
// service pairs, per section 6's own title ("SERVICE / SPECIALTY
// OVERLAP") -- geography and topic targets are never involved in this
// check. Both flagged targets keep their separate, distinct identities
// (targetType, sourceRef, evidence all remain their own) -- this NEVER
// merges the two into one target, exactly as required.
function applyOverlapFlags(targets) {
  const specialties = targets.filter(t => t.targetType === 'specialty')
  const services = targets.filter(t => t.targetType === 'service')
  if (specialties.length === 0 || services.length === 0) return targets

  const flagged = new Set()
  for (const specialty of specialties) {
    const specialtyTokens = tokenize(specialty.canonicalLabel)
    for (const service of services) {
      const serviceTokens = tokenize(service.canonicalLabel)
      if (tokensConservativelyOverlap(specialtyTokens, serviceTokens)) {
        flagged.add(specialty)
        flagged.add(service)
      }
    }
  }
  if (flagged.size === 0) return targets
  return targets.map(t => (flagged.has(t) ? { ...t, possibleOverlap: true } : t))
}

// -----------------------------------------------------------------------
// Ranking -- deterministic comparator, no hidden numeric score.
// -----------------------------------------------------------------------

// Priority order, exactly as specified, left-to-right (each level only
// breaks ties from the level(s) before it):
//   1. confirmed/overridden intelligence outranks unconfirmed/likely
//   2. stronger confidence
//   3. primary over secondary service, where the data distinguishes this
//      (only ever compares two SERVICE targets against each other --
//      applying this to a service-vs-specialty pair would be inventing a
//      cross-type judgment the spec never asked for)
//   4. strategic business priority (only ever compares two targets that
//      both actually carry a business-priority value -- i.e. two topics;
//      service/specialty/geography targets have no such concept and are
//      never penalized for lacking one)
//   5. deterministic alphabetical tiebreaker on canonicalLabel, so the
//      final order never depends on input/array order.
// "Benchmark topic status" from the spec's ranking list is not a separate
// 6th criterion here: every topic target is, by construction, already
// benchmark-approved (see buildTopicTargets), so that signal is already
// fully captured by criterion 1 (confirmationStatus === 'confirmed') and
// criterion 4 (business_priority) -- adding a distinct "benchmark-ness"
// tier on top would be inventing a criterion with nothing left to
// differentiate on, since every topic candidate here is equally benchmark.
const CONFIRMATION_RANK = { confirmed: 0, overridden: 0, stale_recommendation_pending: 1, unconfirmed: 2 }
const CONFIDENCE_RANK = { confirmed_by_direct_evidence: 0, likely: 1, uncertain: 2 }

function confirmationRankOf(target) {
  return CONFIRMATION_RANK[target.confirmationStatus] ?? 2
}
function confidenceRankOf(target) {
  return CONFIDENCE_RANK[target.confidence] ?? 3
}
function serviceOriginRankOf(target) {
  if (target.targetType !== 'service') return null
  if (target.sourceRef && target.sourceRef.fieldKey === 'primary_products_services') return 0
  if (target.sourceRef && target.sourceRef.fieldKey === 'secondary_products_services') return 1
  return null
}
function businessPriorityRankOf(target) {
  if (target.businessPriority === 'strategic') return 0
  if (target.businessPriority === 'none') return 1
  return null
}

function compareTargets(a, b) {
  const confirmationDiff = confirmationRankOf(a) - confirmationRankOf(b)
  if (confirmationDiff !== 0) return confirmationDiff

  const confidenceDiff = confidenceRankOf(a) - confidenceRankOf(b)
  if (confidenceDiff !== 0) return confidenceDiff

  const serviceRankA = serviceOriginRankOf(a)
  const serviceRankB = serviceOriginRankOf(b)
  if (serviceRankA !== null && serviceRankB !== null && serviceRankA !== serviceRankB) {
    return serviceRankA - serviceRankB
  }

  const priorityRankA = businessPriorityRankOf(a)
  const priorityRankB = businessPriorityRankOf(b)
  if (priorityRankA !== null && priorityRankB !== null && priorityRankA !== priorityRankB) {
    return priorityRankA - priorityRankB
  }

  if (a.canonicalLabel < b.canonicalLabel) return -1
  if (a.canonicalLabel > b.canonicalLabel) return 1
  return 0
}

// -----------------------------------------------------------------------
// Soft cap -- ~8, never a quota, never padded, deterministically
// exceedable only for materially distinct, high-confidence dimensions.
// -----------------------------------------------------------------------

// isSoftCapOverflowEligible(target) -> boolean. The ONE deterministic rule
// for exceeding the soft cap: a target must be BOTH AM-confirmed/overridden
// (confirmationStatus) AND backed by the single strongest evidence tier
// this codebase has (confidence === 'confirmed_by_direct_evidence').
// Anything less -- 'likely', 'uncertain', or unconfirmed -- respects the
// cap and is simply not selected once the cap is reached; there is no
// scenario in which a weak target is padded in. Topic targets can NEVER
// satisfy this (topic_clusters has no confidence column at all -- see
// buildTopicTargets -- so target.confidence is always null there), which
// is an intentional, honest consequence: a topic's benchmark approval
// alone is not "high-confidence business-dimension evidence" strong enough
// to justify exceeding the cap on its own, since there is no confidence
// signal to point to.
function isSoftCapOverflowEligible(target) {
  const confirmed = target.confirmationStatus === 'confirmed' || target.confirmationStatus === 'overridden'
  return confirmed && target.confidence === 'confirmed_by_direct_evidence'
}

// applySoftCap(sortedTargets, softCap) -> { targets, overflowCount }.
// Takes the top `softCap` targets from the already fully-ranked list, then
// appends any REMAINING target (rank position beyond the cap) that passes
// isSoftCapOverflowEligible -- in the same relative order ranking already
// established, never re-sorted or re-prioritized differently for the
// overflow set. A client with fewer than `softCap` legitimate targets
// simply gets fewer; nothing here ever pads toward the cap.
function applySoftCap(sortedTargets, softCap) {
  const primary = sortedTargets.slice(0, softCap)
  const overflow = sortedTargets.slice(softCap).filter(isSoftCapOverflowEligible)
  return { targets: primary.concat(overflow), overflowCount: overflow.length }
}

// -----------------------------------------------------------------------
// Top-level entry point
// -----------------------------------------------------------------------

// selectEntityBrandAuthorityTargets({ profile, topicClusters, softCap }) ->
//   { targets, meta }
//
// Pure and deterministic: the same profile + topicClusters input always
// produces the same targets in the same order, regardless of input array
// order (ranking is a full deterministic sort, never insertion order) and
// regardless of how many times it's called (no hidden state, no caching,
// no I/O of any kind).
function selectEntityBrandAuthorityTargets({ profile = null, topicClusters = [], softCap = DEFAULT_SOFT_CAP } = {}) {
  const candidates = []
    .concat(buildServiceTargets(profile))
    .concat(buildGeographyTargets(profile))
    .concat(buildTopicTargets(topicClusters))

  const specialtyTarget = buildSpecialtyTarget(profile)
  if (specialtyTarget) candidates.push(specialtyTarget)

  const withOverlap = applyOverlapFlags(candidates)
  const sorted = withOverlap.slice().sort(compareTargets)
  const { targets, overflowCount } = applySoftCap(sorted, softCap)

  return {
    targets,
    meta: {
      totalCandidates: candidates.length,
      softCap,
      selectedCount: targets.length,
      exceededSoftCap: targets.length > softCap,
      overflowCount
    }
  }
}

module.exports = {
  TARGET_TYPES,
  DEFAULT_SOFT_CAP,
  buildServiceTargets,
  buildSpecialtyTarget,
  buildGeographyTargets,
  buildTopicTargets,
  applyOverlapFlags,
  compareTargets,
  isSoftCapOverflowEligible,
  applySoftCap,
  selectEntityBrandAuthorityTargets
}
