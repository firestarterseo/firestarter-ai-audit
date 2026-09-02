// PAGE SEARCH FOOTPRINT -- Page Leverage Intelligence Audit follow-up
// (2026-09-02). Pure, network-free, Supabase-free, LLM-free. Zero
// dependencies other than lib/urlIdentity.js (itself pure/zero-dependency),
// per explicit instruction to reuse that primitive rather than invent
// another normalization system.
//
// WHY THIS FILE EXISTS: the Page Leverage Intelligence Audit found that
// this app's Ahrefs organic-keywords call is domain-aggregate only --
// every ranking keyword row it returns describes the DOMAIN, never a
// specific page. lib/checkers/ahrefs.js was just extended to also request
// Ahrefs' own `best_position_url` field (a real, existing field on the
// SAME report -- confirmed against Ahrefs' docs, not assumed -- see that
// file's header) at ZERO additional API cost. This file is the smallest
// pure primitive that takes that newly-available per-row ranking URL and
// this app's already-discovered sitemap page list
// (lib/sitemapDiscovery.js's output) and answers, for each sitemap page:
// "what organic-search evidence do we already observe for this exact
// page?" -- nothing more.
//
// RAW EVIDENCE FIRST, INTERPRETATION LATER -- deliberate. This file NEVER
// computes a composite score, NEVER labels a page "high opportunity" or
// "worth analyzing," and NEVER assumes higher volume or a stronger
// position means a page is more valuable to the business. A page that
// already ranks well may need PROTECTION, not improvement -- that judgment
// belongs to a later, separate Page Leverage interpretation layer (not yet
// built), which will also need to weigh business relevance, AI-citation
// evidence, and effort/risk -- none of which this file touches. This file
// only describes WHAT IS OBSERVED.
//
// THREE FACTS THIS FILE DELIBERATELY KEEPS SEPARATE FROM ITSELF (do not
// fold them in here -- see the audit's explicit instruction on each):
//   CLIENT INTELLIGENCE MATCH -- "this path likely represents a confirmed
//     service/geography" (lib/schemaPagePriority.js's matchClientIntelligence).
//     A page ranking for a keyword does not prove it represents any
//     particular confirmed business fact, and vice versa.
//   TOPIC INTELLIGENCE -- benchmark topic clusters (lib/topicClusters.js).
//     A page ranking for a keyword does NOT prove it represents a benchmark
//     topic cluster; no page<->topic relationship is created here.
//   AI CITATION FOOTPRINT -- whether an AI engine has cited this page
//     (lib/sourceCitation.js's analyzeOwnSiteCitations). This file is
//     ORGANIC SEARCH FOOTPRINT only.
// A future Page Leverage assembly step may consider all of these together;
// this file does not, and must not, do that combining itself.
//
// CONSERVATIVE URL JOINING -- this file does not invent a new URL-matching
// scheme. It calls lib/urlIdentity.js#normalizeUrlIdentity() on both the
// Ahrefs ranking URL and each sitemap page's own `url`, and joins only when
// their normalized identity keys are IDENTICAL. Per that file's own
// documented limitations (never modified here, per instruction), this
// means: http and https versions of the same path are NEVER matched (kept
// distinct); a redirect's true destination is never resolved (this file
// has no fetch capability and never guesses); a `rel=canonical` pointing
// elsewhere is invisible to it; a meaningful (non-tracking) query parameter
// keeps two URLs distinct. When a ranking URL cannot be safely joined to a
// discovered sitemap page, it is NEVER silently dropped -- it is preserved
// in `unmatchedRankingEvidence` with an honest, specific reason. Every
// match is exactly one of: MATCHED (single, safe join), UNMATCHED (no safe
// join found, evidence preserved), or AMBIGUOUS (more than one sitemap page
// shares the same normalized identity -- a caller/input-data problem, not
// something this file will guess its way through).
//
// NO FABRICATED SIGNALS -- this file only ever surfaces fields Ahrefs'
// organic-keywords report actually returns today (keyword, volume,
// position, rankingUrl, branded, local -- see lib/checkers/ahrefs.js). It
// never fabricates traffic, impressions, clicks, CTR, conversions, search
// intent, page authority, or business value -- none of those exist in the
// current Ahrefs response this app requests, and inventing them here would
// misrepresent domain-aggregate-report data as something it isn't.

const { normalizeUrlIdentity } = require('./urlIdentity')

const POSITION_BANDS = ['TOP_3', 'POSITIONS_4_10', 'POSITIONS_11_20', 'POSITIONS_21_PLUS', 'POSITION_DATA_UNAVAILABLE', 'NO_OBSERVED_RANKINGS']

// UNMATCHED_REASONS -- every reason a ranking observation could not be
// safely attached to a specific discovered sitemap page. Never a bare
// "unmatched" -- an AM or engineer reading this later must be able to tell
// "this ranking URL simply wasn't in the sitemap" apart from "this looks
// like the same page but over http instead of https" apart from "Ahrefs
// didn't return a URL for this keyword at all."
const UNMATCHED_REASONS = {
  NO_RANKING_URL_RETURNED: 'no_ranking_url_returned',
  MALFORMED_RANKING_URL: 'malformed_ranking_url',
  NOT_IN_SITEMAP: 'ranking_url_not_in_sitemap',
  PROTOCOL_MISMATCH_WITH_SITEMAP_PAGE: 'protocol_mismatch_with_sitemap_page',
  AMBIGUOUS_SITEMAP_IDENTITY: 'ambiguous_sitemap_identity'
}

// classifyPositionBand(position) -> one of POSITION_BANDS (except
// NO_OBSERVED_RANKINGS, which is only ever assigned at the page level when
// there are zero ranking observations at all -- see buildPageEntry below).
// Deterministic, categorical, standard SEO-convention bands -- never a
// claim about movement, trend, or improvement potential (the audit
// explicitly ruled that out; this is a snapshot description only).
function classifyPositionBand(position) {
  if (typeof position !== 'number' || !Number.isFinite(position)) return 'POSITION_DATA_UNAVAILABLE'
  if (position <= 3) return 'TOP_3'
  if (position <= 10) return 'POSITIONS_4_10'
  if (position <= 20) return 'POSITIONS_11_20'
  return 'POSITIONS_21_PLUS'
}

// keywordSortKey(observation) -- deterministic ordering for a page's
// rankingObservations list: strongest (lowest) position first, nulls last,
// then alphabetical by keyword as a stable tiebreaker. Ensures the same set
// of observations always produces the same output list regardless of the
// order organicKeywordRows was supplied in.
function compareObservations(a, b) {
  const aPos = typeof a.position === 'number' ? a.position : Infinity
  const bPos = typeof b.position === 'number' ? b.position : Infinity
  if (aPos !== bPos) return aPos - bPos
  return a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0
}

// rawObservationFrom(row) -- the raw evidence fields preserved verbatim
// from an Ahrefs organic-keyword row, on both matched and unmatched
// observations. Never adds a field Ahrefs didn't actually return.
function rawObservationFrom(row) {
  return {
    keyword: row.keyword,
    volume: typeof row.volume === 'number' ? row.volume : null,
    position: typeof row.position === 'number' ? row.position : null,
    branded: !!row.branded,
    local: !!row.local,
    rankingUrl: row.rankingUrl || null
  }
}

// buildSitemapIdentityIndex(sitemapPages) -> Map<identityKey, page[]>
// Groups discovered sitemap pages by their normalized URL identity. A key
// mapping to more than one page means the input data itself is ambiguous
// (two distinct sitemap page entries that normalize to the same identity)
// -- this file will never guess which one a ranking URL meant in that case.
function buildSitemapIdentityIndex(sitemapPages) {
  const index = new Map()
  for (const page of sitemapPages || []) {
    if (!page || typeof page.url !== 'string') continue
    const identity = normalizeUrlIdentity(page.url)
    if (!identity.valid) continue // a sitemap page with an unparseable URL simply cannot be joined to -- it still appears in `pages` below via its own path, just with no possible ranking evidence.
    const bucket = index.get(identity.key) || []
    bucket.push(page)
    index.set(identity.key, bucket)
  }
  return index
}

// buildProtocolAgnosticIndex(sitemapPages) -> Map<hostname+port+path+query, true>
// Diagnostic-only index (hostname/port/path/query, protocol excluded) used
// SOLELY to give a more specific, honest reason when a ranking URL fails to
// match -- "this looks like the same page but over the other protocol" is
// far more actionable for an engineer/AM than a bare "not in sitemap." This
// NEVER changes match outcome and never broadens lib/urlIdentity.js's own
// behavior -- http and https stay genuinely distinct identities; this index
// only improves the unmatched reason string.
function buildProtocolAgnosticIndex(sitemapPages) {
  const index = new Set()
  for (const page of sitemapPages || []) {
    if (!page || typeof page.url !== 'string') continue
    const identity = normalizeUrlIdentity(page.url)
    if (!identity.valid) continue
    const { hostname, port, path, query } = identity.normalized
    index.add(`${hostname}${port ? `:${port}` : ''}${path}${query ? `?${query}` : ''}`)
  }
  return index
}

// buildPageSearchFootprint({ sitemapPages, organicKeywordRows }) ->
//   { pages, unmatchedRankingEvidence, meta }
//
// sitemapPages: the already-discovered candidate pages from
//   lib/sitemapDiscovery.js#fetchSitemapPages (only `.path`/`.url` are
//   read here -- every other field, e.g. `.type`, passes through
//   unexamined and untouched).
// organicKeywordRows: the already-fetched rows from
//   lib/checkers/ahrefs.js#getOrganicKeywords -- NOT fetched by this file;
//   this file performs no network request, no Ahrefs call, no Supabase
//   read/write, and no LLM call of any kind.
//
// Returns:
//   pages: one entry per input sitemap page (same order as `sitemapPages`,
//     never reordered), each carrying only descriptive/categorical facts
//     -- no composite score, no "opportunity" label, no recommendation.
//   unmatchedRankingEvidence: every organic-keyword row that could not be
//     safely attached to exactly one sitemap page, each with an honest
//     `reason` and its raw evidence fully preserved -- never silently
//     dropped.
//   meta: simple counts, for sanity-checking coverage.
function buildPageSearchFootprint({ sitemapPages, organicKeywordRows } = {}) {
  const pagesInput = Array.isArray(sitemapPages) ? sitemapPages : []
  const rowsInput = Array.isArray(organicKeywordRows) ? organicKeywordRows : []

  const identityIndex = buildSitemapIdentityIndex(pagesInput)
  const protocolAgnosticIndex = buildProtocolAgnosticIndex(pagesInput)

  // observationsByPage: identityKey -> rankingObservation[]. Keyed by
  // identity rather than by page object/index so a page's observations can
  // be looked up regardless of where in `pagesInput` it appears.
  const observationsByPage = new Map()
  const unmatchedRankingEvidence = []
  let skippedInvalidRowCount = 0
  let matchedRowCount = 0

  for (const row of rowsInput) {
    if (!row || !row.keyword) { skippedInvalidRowCount += 1; continue }
    const rawObservation = rawObservationFrom(row)

    if (!row.rankingUrl) {
      unmatchedRankingEvidence.push({ ...rawObservation, reason: UNMATCHED_REASONS.NO_RANKING_URL_RETURNED })
      continue
    }

    const identity = normalizeUrlIdentity(row.rankingUrl)
    if (!identity.valid) {
      unmatchedRankingEvidence.push({ ...rawObservation, reason: UNMATCHED_REASONS.MALFORMED_RANKING_URL })
      continue
    }

    const matchingPages = identityIndex.get(identity.key) || []
    if (matchingPages.length > 1) {
      unmatchedRankingEvidence.push({ ...rawObservation, reason: UNMATCHED_REASONS.AMBIGUOUS_SITEMAP_IDENTITY })
      continue
    }
    if (matchingPages.length === 1) {
      const bucket = observationsByPage.get(identity.key) || []
      bucket.push(rawObservation)
      observationsByPage.set(identity.key, bucket)
      matchedRowCount += 1
      continue
    }

    // No exact identity match -- check the protocol-agnostic index purely
    // to give a more specific, honest reason. This NEVER matches the
    // observation to a page; http/https stay distinct per
    // lib/urlIdentity.js's own documented, unmodified behavior.
    const { hostname, port, path, query } = identity.normalized
    const protocolAgnosticKey = `${hostname}${port ? `:${port}` : ''}${path}${query ? `?${query}` : ''}`
    const reason = protocolAgnosticIndex.has(protocolAgnosticKey)
      ? UNMATCHED_REASONS.PROTOCOL_MISMATCH_WITH_SITEMAP_PAGE
      : UNMATCHED_REASONS.NOT_IN_SITEMAP
    unmatchedRankingEvidence.push({ ...rawObservation, reason })
  }

  const pages = pagesInput.map(page => {
    const identity = (page && typeof page.url === 'string') ? normalizeUrlIdentity(page.url) : { valid: false }
    // A page whose own identity is ambiguous (shares a key with another
    // sitemap page) never receives observations either -- consistent with
    // never guessing which of the colliding pages a ranking URL meant.
    const isAmbiguousIdentity = identity.valid && (identityIndex.get(identity.key) || []).length > 1
    const rawObservations = (identity.valid && !isAmbiguousIdentity) ? (observationsByPage.get(identity.key) || []) : []
    const rankingObservations = [...rawObservations].sort(compareObservations)

    const positionsWithData = rankingObservations.map(o => o.position).filter(p => typeof p === 'number')
    const strongestPosition = positionsWithData.length ? Math.min(...positionsWithData) : null
    const positionBand = rankingObservations.length === 0 ? 'NO_OBSERVED_RANKINGS' : classifyPositionBand(strongestPosition)

    const volumesWithData = rankingObservations.map(o => o.volume).filter(v => typeof v === 'number')
    const observedVolume = {
      totalVolume: volumesWithData.length ? volumesWithData.reduce((sum, v) => sum + v, 0) : null,
      keywordsWithVolumeDataCount: volumesWithData.length
    }

    return {
      path: page.path,
      url: page.url,
      hasObservedRankings: rankingObservations.length > 0,
      keywordCount: rankingObservations.length,
      rankingObservations,
      strongestPosition,
      positionBand,
      observedVolume
    }
  })

  return {
    pages,
    unmatchedRankingEvidence,
    meta: {
      totalOrganicKeywordRows: rowsInput.length,
      matchedRowCount,
      unmatchedRowCount: unmatchedRankingEvidence.length,
      skippedInvalidRowCount
    }
  }
}

module.exports = {
  buildPageSearchFootprint,
  classifyPositionBand,
  POSITION_BANDS,
  UNMATCHED_REASONS
}
