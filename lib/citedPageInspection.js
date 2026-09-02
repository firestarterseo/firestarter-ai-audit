// CITED-PAGE INSPECTION -- added as part of the AI SOURCE & CITATION
// PRESENCE evidence-strength correction (2026-08-17).
//
// WHY THIS FILE EXISTS: the original implementation of the pillar inferred
// "the client appears in cited content" purely from CO-OCCURRENCE -- an AI
// response mentioned the client AND cited a third-party source in the same
// response. That proves the two things showed up together in one answer;
// it does NOT prove the cited page itself contains the client. This module
// is the real, page-level check: fetch the actual cited URL, inspect its
// text, and determine whether the client entity genuinely appears on it.
//
// SCOPE DISCIPLINE (explicit correction instructions, followed literally):
//   - Reuse the existing safe-fetch convention already used across this
//     project (lib/checkers/technical-checker.js#safeFetch,
//     lib/checkers/content-checker.js#safeFetch -- both take an injectable
//     `fetcher` for testability). This file follows the same shape rather
//     than inventing a new one.
//   - No new HTML-parsing dependency. lib/checkers/checker.js's header
//     already documents a deliberate decision to avoid cheerio/jsdom for
//     npm-audit reasons -- extraction here is regex-only, same convention.
//   - No new vendor/third-party integration -- this only ever calls
//     `fetch()` (or an injected equivalent) against the URL AI itself
//     cited. Nothing new to configure, no new API key.
//   - Entity resolution is case-insensitive substring matching only -- no
//     alias/`same_as` infrastructure exists anywhere in this codebase to
//     reuse (confirmed via audit), and fuzzy matching would risk false
//     positives the correction explicitly warns against.
//
// FAILURE HANDLING (the correction's central point): a page that can't be
// fetched or inspected -- robots-blocked, auth-required, JS-rendering-
// required, rate-limited, network failure, blocked access, or deleted --
// is NEVER treated as evidence the client is absent. It comes back
// 'unverifiable', full stop. Only an actual successful fetch + inspection
// that does NOT find the client produces 'verified_absent'.

// Phase 2A (2026-09-01): transport/access/evidence retrieval for the real
// I/O function below (inspectCitedUrl) is now delegated to the shared
// lib/webPageFetch.js primitive rather than this file hand-rolling its own
// fetch/AbortController/robots logic. See that file's header for the full
// rationale (this was one of at least seven near-duplicate fetch
// implementations in this codebase). This migration is deliberately
// conservative: inspectCitedUrl's public contract, evidence semantics, and
// every exact failureReason string it can return are UNCHANGED -- see
// mapFetchFailureCategory() below for how the two failure vocabularies are
// reconciled.
const { checkRobotsAllowed, fetchWebPage } = require('./webPageFetch')

const DEFAULT_TIMEOUT_MS = 8000

// ---------------------------------------------------------------------
// PURE LOGIC -- no fetch, no DB. See lib/citedPageInspection.pure.test.js
// (colocated correction tests live in lib/sourceCitation.pure.test.js).
// ---------------------------------------------------------------------

// extractPageText(html) -> {text, textLower}. Strips script/style/comment
// blocks and tags via regex (no parser dependency -- see module header),
// decodes the handful of entities real-world pages actually use, and
// collapses whitespace. Good enough for substring entity matching and a
// human-readable snippet; not a general-purpose HTML sanitizer.
function extractPageText(html) {
  if (!html || typeof html !== 'string') return { text: '', textLower: '' }
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  cleaned = cleaned
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return { text: cleaned, textLower: cleaned.toLowerCase() }
}

// matchesClientEntity(textLower, {name, domain}) -> {matched, matchedTerm}.
// Case-insensitive substring match against the client's name and/or bare
// domain -- deliberately not fuzzy (see module header). Very short names
// (<3 chars) are skipped to avoid nonsense matches (e.g. a client
// literally named "Go").
function matchesClientEntity(textLower, { name, domain } = {}) {
  if (!textLower) return { matched: false, matchedTerm: null }
  const candidates = []
  if (name && name.trim().length >= 3) {
    candidates.push({ term: name.trim(), needle: name.trim().toLowerCase() })
  }
  if (domain) {
    const bare = String(domain).replace(/^www\./i, '').trim().toLowerCase()
    if (bare.length >= 3) candidates.push({ term: domain, needle: bare })
  }
  for (const c of candidates) {
    if (c.needle && textLower.includes(c.needle)) return { matched: true, matchedTerm: c.term }
  }
  return { matched: false, matchedTerm: null }
}

// buildSnippet(text, matchedTerm) -> a short human-readable excerpt around
// the match, for an AM to eyeball without re-opening the source URL.
function buildSnippet(text, matchedTerm, radius = 160) {
  if (!text || !matchedTerm) return null
  const idx = text.toLowerCase().indexOf(matchedTerm.toLowerCase())
  if (idx === -1) return text.slice(0, radius).trim() || null
  const start = Math.max(0, idx - Math.floor(radius / 2))
  const end = Math.min(text.length, idx + matchedTerm.length + Math.floor(radius / 2))
  const slice = text.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`
}

// classifyPageRelationshipType(url, textLower, {fallbackRelationshipType}) ->
// one of RELATIONSHIP_TYPES (see lib/sourceCitation.js). A light content
// heuristic first (does the page itself look like a ranking, a review page,
// an association-membership page, etc.), falling back to whatever the
// caller passed in (normally lib/sourceCitation.js#classifyRelationshipType
// applied to the domain) when content gives no signal. Takes the fallback
// as a parameter rather than importing lib/sourceCitation.js directly, to
// avoid a circular require (sourceCitation.js requires this file).
function classifyPageRelationshipType(url, textLower, { fallbackRelationshipType = 'Other' } = {}) {
  if (textLower) {
    if (/\btop\s*\d+\b|\bbest\s*\d+\b|\branking(s)?\b|\branked\b/.test(textLower)) return 'Ranking / List'
    if (/\breview(s)?\b/.test(textLower) && /\brating(s)?\b|\bstars?\b/.test(textLower)) return 'Review Page'
    if (/\bmembership\b/.test(textLower) && /\bassociation\b|\bchamber\b|\bguild\b|\bsociety\b/.test(textLower)) return 'Association Membership'
    if (/\bguest post\b|\bexpert contributor\b|\bcontributed by\b/.test(textLower)) return 'Expert Contribution'
  }
  return fallbackRelationshipType || 'Other'
}

// looksLikeJsRenderedShell(textLower) -> true only on an explicit signal
// that the page requires JS to render its real content. Deliberately
// narrow (an exact-phrase check, not a length heuristic) -- a false
// positive here just means an extra 'unverifiable' instead of a real
// verified_absent, which is the safe direction per the correction's
// fetch-failure rule; a length-based heuristic risks the opposite (falsely
// treating a real, short, legitimate page as absent evidence).
function looksLikeJsRenderedShell(textLower) {
  if (!textLower) return false
  return /enable javascript|requires javascript|please turn on javascript|javascript is disabled/i.test(textLower)
}

// categorizeFetchFailure(error, response) -> one of the disclosed failure-
// reason buckets. Never returns anything that implies absence.
function categorizeFetchFailure(error, response) {
  if (error) {
    if (error.name === 'AbortError') return 'network_failure'
    return 'network_failure'
  }
  if (response) {
    const status = response.status
    if (status === 404 || status === 410) return 'deleted_page'
    if (status === 401) return 'auth_required'
    if (status === 403) return 'blocked_access'
    if (status === 429) return 'rate_limited'
    if (status >= 500) return 'network_failure'
  }
  return 'unknown_failure'
}

// isPathAllowedByRobots -- Phase 2A (2026-09-01): this was moved verbatim
// into lib/webPageFetch.js as checkRobotsAllowed (identical logic, byte-
// for-byte), and this is now a thin re-export under its original name.
// Kept as a named export here, unchanged, because lib/sourceCitation.pure.
// test.js imports it directly by this name, and this file's own
// inspectCitedUrl below still calls it as its own separate pre-check step
// (rather than opting into lib/webPageFetch.js's fetchWebPage({respectRobots:
// true}) path) so that behavior here is provably identical to before this
// migration.
const isPathAllowedByRobots = checkRobotsAllowed

// ---------------------------------------------------------------------
// I/O -- the one real fetch-and-inspect function. Never throws; every
// failure mode returns a normal {verificationStatus: 'unverifiable', ...}
// object instead, same "degrade to an honest result, don't blow up the
// caller" convention as every other checker in this project.
// ---------------------------------------------------------------------

// mapFetchFailureCategory(category) -> this file's own legacy failure-
// reason vocabulary. Phase 2A (2026-09-01): lib/webPageFetch.js's
// fetchWebPage() distinguishes a couple of states -- 'timeout' and
// 'server_error' -- that this file's own categorizeFetchFailure has ALWAYS
// folded into 'network_failure' (see that function, unchanged, above).
// Rather than changing categorizeFetchFailure's decision table (and risking
// lib/sourceCitation.pure.test.js's exact-string assertions, e.g.
// correctionTest5's failureReason === 'network_failure' checks), this maps
// the shared primitive's richer vocabulary back down to the exact strings
// this file has always produced. Every other category name is shared
// verbatim between the two modules, so this is the only translation needed.
function mapFetchFailureCategory(category) {
  if (category === 'timeout' || category === 'server_error') return 'network_failure'
  return category
}

// inspectCitedUrl(url, {name, domain}, {fetcher, timeoutMs, fallbackRelationshipType})
// -> { url, verificationStatus: 'verified_present'|'verified_absent'|'unverifiable',
//      matchedEntity, relationshipType, snippet, httpStatus, failureReason, checkedAt }
async function inspectCitedUrl(url, { name, domain } = {}, { fetcher = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, fallbackRelationshipType = null } = {}) {
  const checkedAt = new Date().toISOString()
  const base = { url, checkedAt, matchedEntity: null, relationshipType: null, snippet: null, httpStatus: null, failureReason: null }

  let origin
  try { origin = new URL(url).origin } catch (e) {
    return { ...base, verificationStatus: 'unverifiable', failureReason: 'invalid_url' }
  }

  const robotsAllowed = await isPathAllowedByRobots(origin, url, fetcher, timeoutMs).catch(() => true)
  if (!robotsAllowed) {
    return { ...base, verificationStatus: 'unverifiable', failureReason: 'robots_blocked' }
  }

  // Phase 2A (2026-09-01): raw transport mechanics (AbortController/timeout,
  // the actual fetch call, bounded body reading) now live in lib/
  // webPageFetch.js's fetchWebPage(). respectRobots stays OFF here --
  // deliberately -- because the robots pre-check above already ran as this
  // file's own separate step; asking fetchWebPage to check again would just
  // re-fetch robots.txt a second time for no behavioral difference.
  // headers: {} (rather than omitting the option) preserves this file's
  // exact prior request shape -- fetcher(url, {signal, redirect:'follow'}),
  // no User-Agent or other header set -- since lib/webPageFetch.js's own
  // default would otherwise add a 'FirestarterAIAudit/1.0' User-Agent header
  // that this caller never sent before this migration.
  const fetchResult = await fetchWebPage(url, { fetcher, timeoutMs, redirect: 'follow', headers: {} })

  if (fetchResult.fetchState !== 'success') {
    return {
      ...base,
      httpStatus: fetchResult.status,
      verificationStatus: 'unverifiable',
      failureReason: mapFetchFailureCategory(fetchResult.failureCategory)
    }
  }

  const { text, textLower } = extractPageText(fetchResult.html)

  if (looksLikeJsRenderedShell(textLower)) {
    return { ...base, httpStatus: fetchResult.status, verificationStatus: 'unverifiable', failureReason: 'js_rendering_required' }
  }

  const match = matchesClientEntity(textLower, { name, domain })
  const relationshipType = classifyPageRelationshipType(url, textLower, { fallbackRelationshipType })

  if (!match.matched) {
    return { ...base, httpStatus: fetchResult.status, verificationStatus: 'verified_absent', relationshipType }
  }

  return {
    ...base,
    httpStatus: fetchResult.status,
    verificationStatus: 'verified_present',
    matchedEntity: match.matchedTerm,
    relationshipType,
    snippet: buildSnippet(text, match.matchedTerm)
  }
}

// runWithConcurrency(items, limit, worker) -> Promise<result[]> (nulls
// filtered out). A hand-rolled bounded queue -- no new npm dependency, per
// the correction's architecture constraints. A single item throwing never
// aborts the others.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let idx = 0
  async function runNext() {
    while (idx < items.length) {
      const current = idx++
      try {
        results[current] = await worker(items[current], current)
      } catch (e) {
        results[current] = null
      }
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, runNext))
  return results.filter(Boolean)
}

function cachedRowToInspection(row) {
  return {
    url: row.url,
    verificationStatus: row.verification_status,
    matchedEntity: row.matched_entity,
    relationshipType: row.relationship_type,
    snippet: row.snippet,
    httpStatus: row.http_status,
    failureReason: row.failure_reason,
    checkedAt: row.checked_at
  }
}

const CITED_PAGE_INSPECTIONS_TABLE = 'cited_page_inspections'
const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14 // 14 days
const DEFAULT_MAX_URLS_PER_DOMAIN = 3
const DEFAULT_CONCURRENCY = 4

// inspectCitedUrlsForClient(supabase, {clientId, client, urlsByDomain, ...})
// -> Map<domain, inspection[]>. The bounded, deduped, persisted
// orchestration layer -- this is what actually runs during audit/research
// processing (never on wizard render; see lib/sourceCitation.js's
// syncClientSources, the only caller). Dedupes by (client_id, url) against
// a real cache table, honors a staleness window so a URL already verified
// recently isn't re-fetched every audit, caps how many cited URLs per
// domain get inspected (a heavily-cited domain doesn't need every single
// URL checked to establish the pattern), and runs fetches with bounded
// concurrency so this scales to 70+ clients instead of serially fetching
// dozens of URLs per client per audit.
async function inspectCitedUrlsForClient(supabase, {
  clientId, client, urlsByDomain,
  fetcher = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAgeMs = DEFAULT_MAX_AGE_MS, maxUrlsPerDomain = DEFAULT_MAX_URLS_PER_DOMAIN,
  concurrency = DEFAULT_CONCURRENCY, classifyRelationshipType = () => 'Other'
} = {}) {
  const name = client && client.name
  const domain = client && (client.domain || client.url)

  const { data: existingRows, error } = await supabase
    .from(CITED_PAGE_INSPECTIONS_TABLE).select('*').eq('client_id', clientId)
  if (error) throw error
  const cacheByUrl = new Map((existingRows || []).map(r => [r.url, r]))

  const now = Date.now()
  const resultsByDomain = new Map()
  const toInspect = []

  for (const [srcDomain, urlSetOrArray] of urlsByDomain.entries()) {
    const urls = [...urlSetOrArray].slice(0, maxUrlsPerDomain)
    const domainResults = []
    for (const url of urls) {
      const cached = cacheByUrl.get(url)
      const isFresh = cached && cached.checked_at && (now - new Date(cached.checked_at).getTime()) < maxAgeMs
      if (isFresh) {
        domainResults.push(cachedRowToInspection(cached))
      } else {
        toInspect.push({ url, domain: srcDomain })
      }
    }
    resultsByDomain.set(srcDomain, domainResults)
  }

  const freshInspections = await runWithConcurrency(toInspect, concurrency, async ({ url, domain: srcDomain }) => {
    const fallbackRelationshipType = classifyRelationshipType(srcDomain)
    const inspection = await inspectCitedUrl(url, { name, domain }, { fetcher, timeoutMs, fallbackRelationshipType })
    return { ...inspection, domain: srcDomain }
  })

  for (const insp of freshInspections) {
    const arr = resultsByDomain.get(insp.domain) || []
    arr.push(insp)
    resultsByDomain.set(insp.domain, arr)
  }

  if (freshInspections.length > 0) {
    const nowIso = new Date().toISOString()
    const upsertRows = freshInspections.map(insp => ({
      client_id: clientId,
      domain: insp.domain,
      url: insp.url,
      verification_status: insp.verificationStatus,
      matched_entity: insp.matchedEntity,
      relationship_type: insp.relationshipType,
      snippet: insp.snippet,
      http_status: insp.httpStatus,
      failure_reason: insp.failureReason,
      checked_at: insp.checkedAt,
      provenance: { method: 'fetch_and_regex_inspect' },
      updated_at: nowIso
    }))
    const { error: upsertError } = await supabase
      .from(CITED_PAGE_INSPECTIONS_TABLE).upsert(upsertRows, { onConflict: 'client_id,url' })
    if (upsertError) throw upsertError
  }

  return resultsByDomain
}

module.exports = {
  CITED_PAGE_INSPECTIONS_TABLE,
  DEFAULT_MAX_AGE_MS, DEFAULT_MAX_URLS_PER_DOMAIN, DEFAULT_CONCURRENCY,
  // pure logic
  extractPageText, matchesClientEntity, buildSnippet, classifyPageRelationshipType,
  looksLikeJsRenderedShell, categorizeFetchFailure, isPathAllowedByRobots,
  cachedRowToInspection, runWithConcurrency,
  // I/O
  inspectCitedUrl, inspectCitedUrlsForClient
}
