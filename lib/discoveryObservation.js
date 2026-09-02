// DISCOVERY OBSERVATION PRIMITIVES -- Phase 2B ("Discovery Observation +
// URL Identity Primitives", 2026-09-02). Pure, application-layer,
// DB-INDEPENDENT: nothing in this file queries or writes Supabase, fetches
// a page, or persists anything. See lib/urlIdentity.js's header for the
// companion pre-fetch URL-identity concept this file builds on.
//
// WHY THIS FILE EXISTS: the Phase 2A "Source Discovery & Evidence
// Architecture Audit" found a real, confirmed provenance gap -- by the time
// a cited URL reaches lib/citedPageInspection.js's cited_page_inspections
// row, there is no way to answer "why was this URL discovered" (which
// tracked AI run, which prompt, which engine). This file is the fix: a
// small, shared shape for "channel X surfaced URL Y for subject Z at time
// T, with this raw context" -- an append-only OBSERVATION, not a candidate
// page, not evidence, not an opportunity. A future persistence writer can
// store these verbatim (see FUTURE PERSISTENCE CONTRACT below) without this
// file ever having to know how or whether that happens.
//
// SCOPE DISCIPLINE (explicit, load-bearing -- this is a primitive, not a
// pillar). This file MUST NOT:
//   - fetch the page (that's lib/webPageFetch.js, called later, downstream
//     of this file, by a pillar -- never from here)
//   - determine evidence strength, whether the client appears, or classify
//     association (that's pillar-specific interpretation -- see
//     lib/sourceCitation.js's determineClientPresence/computeObservedImportance
//     for how Source & Citation already does this for ITS OWN evidence,
//     entirely separately from discovery)
//   - create opportunities (lib/opportunityLifecycle.js's job)
//   - persist anything (no Supabase import anywhere in this file)
//   - infer competitor identity from arbitrary text -- subjectType/
//     subjectId are ALWAYS supplied by the caller, explicitly, as real
//     identifiers (a clientId, or a client_competitors.id) -- this file
//     never guesses "this URL looks like it's about a competitor" from a
//     URL or page text
//
// RELATIONSHIP TO SOURCE & CITATION (per the approved Phase 2B plan):
// lib/sourceCitation.js and lib/citedPageInspection.js are NOT modified by
// this phase. buildAiCitationObservations below is written and tested
// against the exact same ai_visibility_tracked_runs raw-row shape
// lib/sourceCitation.js#buildRowSourceView already consumes (raw.sourceUrls/
// raw.ownDomainSourceUrls) -- see lib/discoveryObservation.pure.test.js's
// compatibility tests, which build rows the same way
// lib/sourceCitation.pure.test.js's own rowView() helper does. This proves
// the shape is compatible without touching syncClientSources, without
// changing what it persists, and without risking any of the 30 existing
// Source & Citation pure tests.
//
// RELATIONSHIP TO lib/webPageFetch.js: not modified, no defect found.
// Documented future flow (not built this phase):
//   raw discovery (this file) -> normalizeUrlIdentity() (lib/urlIdentity.js)
//     -> lib/webPageFetch.js#fetchWebPage() -> pillar-specific page
//     inspection/extraction. `finalUrl` from a real fetch is a separate,
//     later fact and is never conflated with this file's pre-fetch grouping.
//
// FUTURE PERSISTENCE CONTRACT (documented, NOT implemented -- no fake DB
// layer exists in this file):
//   MUST eventually persist: individual discovery observations, verbatim,
//     append-only (one row per buildDiscoveryObservation() result) -- this
//     is the actual fix for the provenance gap; without it, "why was this
//     URL discovered" stays unanswerable exactly as it is today.
//   CAN be recomputed, never persisted as its own source of truth:
//     normalized-candidate grouping (groupObservationsByPageIdentity's
//     output), channel counts, first/last-discovered timestamps -- all of
//     these are pure derivations FROM the persisted observations, cheap to
//     recompute, and must never drift into being hand-edited or treated as
//     more authoritative than the raw observations they're derived from.
//   A future persistence writer would be a function shaped roughly like
//   `writeDiscoveryObservations(observations)` accepting exactly the plain
//   objects buildDiscoveryObservation() returns -- deliberately not
//   stubbed out here, since a fake DB layer with no real backing would be
//   exactly the kind of infrastructure this application doesn't need yet
//   (see lib/webPageFetch.js's own header on the same discipline).

const { normalizeUrlIdentity } = require('./urlIdentity')

// SUBJECT_TYPES -- who is being investigated. 'client' and 'competitor'
// only, per the approved Phase 2B scope; deliberately not open-ended (e.g.
// no 'unknown' value) -- every observation MUST know whose association
// question it's evidence for. A competitor's own identity is always a real
// client_competitors.id supplied by the caller, never inferred here.
const SUBJECT_TYPES = ['client', 'competitor']

// CHANNELS -- grounded only in real/planned discovery channels traced
// during the Phase 2A audit: 'ai_citation' is the only one with a real
// producer today (buildAiCitationObservations below); 'serp' (real
// infrastructure exists: lib/serpLandscape.js, not yet wired to produce
// observations), 'backlink' (real infrastructure exists:
// lib/checkers/ahrefs.js#getAuthorityBacklinks), 'known_profile' (real
// data exists: clients.same_as), and 'manual' (no producer or UI exists
// yet for any pillar) are all listed now, per the approved plan, so the
// shape doesn't need to change shape when those producers are added later
// -- but none of them are implemented this phase.
const CHANNELS = ['ai_citation', 'serp', 'backlink', 'known_profile', 'manual']

function assertOneOf(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(', ')} (got: ${JSON.stringify(value)})`)
  }
}

// ---------------------------------------------------------------------
// 1. DISCOVERY OBSERVATION PRIMITIVE
// ---------------------------------------------------------------------

// buildDiscoveryObservation(fields) -> a validated, plain discovery-
// observation object:
//   { clientId, subjectType, subjectId, channel, rawUrl, discoveredAt, rawContext }
//
// SHAPE VALIDATION ONLY (see module header's MUST NOT list) -- this
// function has no opinion about whether rawUrl is a real, fetchable,
// well-formed URL. A garbage-but-non-empty string (e.g. "not a url") is a
// perfectly valid OBSERVATION -- it genuinely is what some channel
// reported seeing -- and is accepted here without complaint. Whether that
// string yields a usable page identity is a separate, later question,
// answered safely (never by throwing) by lib/urlIdentity.js at grouping
// time. This function throws only on a structurally broken observation:
// missing clientId/subjectId, an unrecognized subjectType/channel, or a
// rawUrl that isn't even a non-empty string -- same "throw on invalid
// enum/shape" convention lib/opportunityLifecycle.js's assertOneOf already
// uses elsewhere in this project.
function buildDiscoveryObservation({
  clientId, subjectType, subjectId, channel, rawUrl, discoveredAt = null, rawContext = {}
} = {}) {
  if (!clientId) throw new Error('buildDiscoveryObservation requires clientId.')
  assertOneOf(subjectType, SUBJECT_TYPES, 'subjectType')
  if (subjectId === undefined || subjectId === null || subjectId === '') {
    throw new Error('buildDiscoveryObservation requires a non-empty subjectId (a real client or client_competitors identifier -- never inferred).')
  }
  assertOneOf(channel, CHANNELS, 'channel')
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw new Error('buildDiscoveryObservation requires a non-empty rawUrl string. URL validity/parseability is checked later by lib/urlIdentity.js, never here.')
  }
  if (rawContext !== null && typeof rawContext !== 'object') {
    throw new Error('rawContext must be a plain object (or omitted).')
  }

  return {
    clientId,
    subjectType,
    subjectId,
    channel,
    rawUrl,
    discoveredAt: discoveredAt || null,
    rawContext: rawContext || {}
  }
}

// ---------------------------------------------------------------------
// 2. AI CITATION OBSERVATION BUILDER -- the first real producer.
// ---------------------------------------------------------------------

// buildAiCitationObservations(row, {clientId}) -> discoveryObservation[]
//
// Converts one real ai_visibility_tracked_runs row (the exact shape
// lib/sourceCitation.js#buildRowSourceView already consumes: `row.id`,
// `row.engine`, `row.run_at`, `row.raw.{prompt, sourceUrls,
// ownDomainSourceUrls}`) into one discovery observation PER raw citation
// URL on that row. subjectType is always 'client' here -- this channel
// only ever tells us "AI cited this URL while discussing/answering about
// THIS client," never anything about a competitor (competitor discovery is
// a different future producer, out of scope for this phase).
//
// Preserves, per observation, everything Phase 2B's spec asks for that is
// actually available on the row: the tracked-run id (rawContext.trackedRunId),
// the prompt text (rawContext.prompt), the engine (rawContext.engine), the
// observed timestamp (the top-level `discoveredAt`, from `row.run_at`), the
// raw citation URL itself (`rawUrl`), and whether it was classified as
// own-domain or third-party AT OBSERVATION TIME, when that fact actually
// exists on the row (rawContext.observedOwnership: 'own_domain' |
// 'third_party' | 'unknown' -- 'unknown' only when `raw.ownDomainSourceUrls`
// itself is entirely absent from the row, i.e. the own/third-party split
// was never computed for it; NEVER guessed as 'third_party' by default in
// that case, per "do not fabricate unavailable fields").
//
// Mirrors buildRowSourceView's own precedent exactly rather than inventing
// a different fallback: a row with no `raw.sourceUrls` array produces ZERO
// observations (same as buildRowSourceView treating it as no third-party
// URLs at all) -- this file does not reconstruct a URL list from
// own+thirdParty when sourceUrls itself is missing, since the real
// consuming code never does that either.
function buildAiCitationObservations(row, { clientId } = {}) {
  if (!row || !clientId) return []
  const raw = row.raw || {}
  const allUrls = Array.isArray(raw.sourceUrls)
    ? raw.sourceUrls.filter(u => typeof u === 'string' && u.length > 0)
    : []
  if (allUrls.length === 0) return []

  // null (not []) means "this row never recorded an own/third-party
  // split at all" -- distinct from an empty array, which would mean
  // "recorded, and zero own-domain URLs." Only the former yields 'unknown'.
  const ownUrls = Array.isArray(raw.ownDomainSourceUrls) ? raw.ownDomainSourceUrls : null

  return allUrls.map(url => {
    const observedOwnership = ownUrls === null
      ? 'unknown'
      : (ownUrls.includes(url) ? 'own_domain' : 'third_party')

    return buildDiscoveryObservation({
      clientId,
      subjectType: 'client',
      subjectId: clientId,
      channel: 'ai_citation',
      rawUrl: url,
      discoveredAt: row.run_at || null,
      rawContext: {
        trackedRunId: row.id || null,
        engine: row.engine || null,
        prompt: raw.prompt || null,
        observedOwnership
      }
    })
  })
}

// ---------------------------------------------------------------------
// 4. MULTI-CHANNEL PROVENANCE MERGING
// ---------------------------------------------------------------------

// groupKeyFor(observation, identity) -- subjectType/subjectId are ALWAYS
// part of the grouping key (see SUBJECT IDENTITY below) -- a client
// observation and a competitor observation of the literal same URL must
// never merge. When the URL fails normalization (identity.valid === false),
// grouping falls back to the exact raw URL string rather than dropping the
// observation or guessing an identity -- this still safely merges two
// observations of the EXACT SAME malformed string (a real, if weak, signal
// that they refer to the same thing) without ever claiming two DIFFERENT
// malformed strings are the same page.
function groupKeyFor(observation, identity) {
  const pageKey = identity.valid ? `id:${identity.key}` : `raw:${observation.rawUrl}`
  return `${observation.subjectType}::${observation.subjectId}::${pageKey}`
}

// groupObservationsByPageIdentity(observations) -> group[]
//
//   { groupKey, subjectType, subjectId, identityValid, normalizedIdentity,
//     identityKey, channels, channelCount, observations, observationCount,
//     firstDiscoveredAt, lastDiscoveredAt }
//
// Groups discovery observations into ONE normalized-page candidate per
// (subjectType, subjectId, normalized page identity) WITHOUT losing any
// individual observation -- every observation that contributed to a group
// is preserved verbatim in `observations`, so "which exact observations"
// is always answerable, never collapsed into a summary string. This is
// PURE GROUPING ONLY -- see module header's MUST NOT list: it never scores
// evidence, never decides a page "counts," and never looks at rawContext
// beyond what SUBJECT IDENTITY (section 5) requires (subjectType/subjectId,
// which are always first-class fields here, never buried in rawContext).
function groupObservationsByPageIdentity(observations) {
  const groups = new Map()

  for (const obs of observations) {
    const identity = normalizeUrlIdentity(obs.rawUrl)
    const key = groupKeyFor(obs, identity)

    if (!groups.has(key)) {
      groups.set(key, {
        groupKey: key,
        subjectType: obs.subjectType,
        subjectId: obs.subjectId,
        identityValid: identity.valid,
        normalizedIdentity: identity.valid ? identity.normalized : null,
        identityKey: identity.valid ? identity.key : null,
        channels: new Set(),
        observations: [],
        firstDiscoveredAt: null,
        lastDiscoveredAt: null
      })
    }

    const group = groups.get(key)
    group.channels.add(obs.channel)
    group.observations.push(obs)
    if (obs.discoveredAt) {
      if (!group.firstDiscoveredAt || new Date(obs.discoveredAt) < new Date(group.firstDiscoveredAt)) group.firstDiscoveredAt = obs.discoveredAt
      if (!group.lastDiscoveredAt || new Date(obs.discoveredAt) > new Date(group.lastDiscoveredAt)) group.lastDiscoveredAt = obs.discoveredAt
    }
  }

  return [...groups.values()].map(g => ({
    ...g,
    channels: [...g.channels].sort(),
    channelCount: g.channels.size,
    observationCount: g.observations.length
  }))
}

module.exports = {
  SUBJECT_TYPES, CHANNELS,
  buildDiscoveryObservation,
  buildAiCitationObservations,
  groupObservationsByPageIdentity
}
