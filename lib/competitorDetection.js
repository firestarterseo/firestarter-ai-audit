// Competitive Position: competitor auto-detection + sync.
//
// Per direct client feedback, this does NOT require a strategist to
// manually confirm competitors before the pillar can grade -- same
// "auto-populated, confirmation is optional refinement" philosophy already
// used for AI-visibility test prompts. Detection runs on every audit
// (see runAudit.js) and upserts into client_competitors; a strategist can
// review/add/remove afterward via the Competitive Position UI, but that's
// polish, not a gate.
//
// Two independent, zero-marginal-cost-or-cheap signals, merged:
//   1. AI-citation "cited instead" data -- third-party domains already
//      captured in this client's own ai_visibility_tracked_runs rows
//      (raw.thirdPartySourceUrls), which cost nothing extra to read: this
//      data already exists from AI & GEO Visibility tracking. Literally
//      "who showed up in the exact AI-answer context we're trying to win."
//   2. Ahrefs organic-competitors overlap -- domains that rank for the same
//      keywords this client does (see lib/checkers/ahrefs.js). One Ahrefs
//      call, reused later for the keyword-count comparison sub-check in
//      lib/checkers/competitive-position-checker.js.
//
// Both are filtered through lib/nonCompetitorDomains.js so directories,
// review platforms, press, and social networks never get mistaken for an
// actual competing business.

const { getSupabaseServerClient } = require('./supabaseServer')
const { getOrganicCompetitors, getDomainMetrics, getOrganicKeywords } = require('./checkers/ahrefs')
const { isNonCompetitorDomain, hostnameOf, normalizeDomain } = require('./nonCompetitorDomains')

const MAX_TRACKED_ROWS = 500

// Capped per-audit cost for the keyword-count rebuild (2026-08-14): the
// metrics endpoint is one domain per call (unlike organic-competitors,
// which returns many domains in one call), so a genuine total-keyword
// comparison against every tracked competitor costs N+1 Ahrefs calls. This
// caps N so a client with, say, 25 tracked competitors doesn't fire 26
// Ahrefs calls on every single audit run -- accepted cost/coverage
// tradeoff per direct client instruction ("capped at, say, the top 5-10").
const MAX_KEYWORD_METRIC_COMPETITORS = 10

// Generic business-name suffixes stripped when deriving a "brand slug" from
// a client's own domain -- e.g. "firestarterseo.com" -> label
// "firestarterseo" -> strip "seo" -> "firestarter". Without stripping,
// "firestarterseo" wouldn't match a citation path like
// "firestarter-search-engine-optimization" the same way "firestarter" does
// (it would, actually, via the substring check below -- but the shorter,
// more distinctive core token is a better anchor generally, and stripping
// a generic suffix reduces the odds of the FULL label failing to match a
// citation that only uses the client's name without "SEO"/"Agency"/etc.
// tacked on).
const GENERIC_BUSINESS_SUFFIXES = ['seo', 'agency', 'marketing', 'digital', 'group', 'consulting', 'studio', 'company', 'inc', 'llc', 'co']
const MIN_BRAND_SLUG_LENGTH = 5

// brandSlugFor(client) -> a lowercase, alphanumeric-only token derived from
// the client's own domain, used by urlMentionsClientBrand below to
// recognize "this citation is ABOUT the client" (a directory profile page,
// a press feature) rather than evidence of a distinct competing business.
function brandSlugFor(client) {
  const domain = normalizeDomain(client.domain) || normalizeDomain(client.url)
  if (!domain) return null
  const label = domain.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!label) return null
  for (const suffix of GENERIC_BUSINESS_SUFFIXES) {
    if (label.length > suffix.length + 3 && label.endsWith(suffix)) {
      const core = label.slice(0, -suffix.length)
      if (core.length >= MIN_BRAND_SLUG_LENGTH) return core
    }
  }
  return label.length >= MIN_BRAND_SLUG_LENGTH ? label : null
}

// urlMentionsClientBrand(url, brandSlug) -> true if this citation URL
// (hostname + full path, hyphens/slashes ignored) contains the client's
// own brand slug -- e.g. "designrush.com/agency/profile/firestarter",
// "techfinder.net/listing/firestarter-seo/", "zoominfo.com/c/firestarter-
// search-engine-optimization/...". Found 2026-08-13: several "competitors"
// auto-detected from real citation data were actually the client's OWN
// profile/press mention on a directory or news site, not a distinct
// competing business -- this is the generalizable half of that fix (the
// other half is expanding lib/nonCompetitorDomains.js's static list for
// roundup-article domains where the client's name never appears in the
// URL at all, e.g. a "top 10 agencies in Denver" listicle).
function urlMentionsClientBrand(url, brandSlug) {
  if (!brandSlug) return false
  const normalized = String(url).toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized.includes(brandSlug)
}

// detectFromAiCitations(client) -> Promise<Array<{domain, source: 'ai_citation', occurrences, detectionNote}>>
// Reads this client's own ai_visibility_tracked_runs and tallies every
// third-party domain that's ever shown up as a citation, excluding known
// non-competitor domains, the client's own domain, and any citation URL
// that mentions the client's own brand (see urlMentionsClientBrand above).
// Also flags (via detectionNote, not exclusion) domains that have NEVER
// once been cited alone or alongside just one other outside domain --
// i.e. every single time they showed up, so did 2+ OTHER candidate
// domains in that same AI answer. That pattern is more consistent with a
// roundup/"top agencies" answer citing several sources at once than with
// a single competing business's own site being cited on its own, but it's
// surfaced as a note for a strategist to weigh, not auto-excluded --
// unlike the brand-mention check above, this one isn't reliable enough on
// its own to risk silently dropping a genuine competitor (verified
// against real data: a confirmed real competitor in this client's own
// list also co-occurred with 2 others in one run, but NOT in every run,
// so it correctly does not get flagged).
// Never throws -- returns [] on any query failure, same "data gap, not
// fatal" contract used throughout this project.
async function detectFromAiCitations(client) {
  const supabase = getSupabaseServerClient()
  const { data: rows, error } = await supabase
    .from('ai_visibility_tracked_runs')
    .select('raw')
    .eq('client_id', client.id)
    .order('run_at', { ascending: false })
    .limit(MAX_TRACKED_ROWS)
  if (error) throw error

  const clientDomain = normalizeDomain(client.domain)
  const brandSlug = brandSlugFor(client)
  const domainStats = new Map() // domain -> { occurrences, roundupRowCount }

  ;(rows || []).forEach(row => {
    const raw = row.raw || {}
    const ownUrls = Array.isArray(raw.ownDomainSourceUrls) ? raw.ownDomainSourceUrls : []
    const urls = Array.isArray(raw.thirdPartySourceUrls)
      ? raw.thirdPartySourceUrls
      : (Array.isArray(raw.sourceUrls) ? raw.sourceUrls.filter(u => !ownUrls.includes(u)) : [])

    const rowDomains = new Set()
    urls.forEach(u => {
      if (isNonCompetitorDomain(u)) return
      if (urlMentionsClientBrand(u, brandSlug)) return
      const host = hostnameOf(u)
      if (!host || host === clientDomain) return
      rowDomains.add(host)
    })

    rowDomains.forEach(d => {
      const entry = domainStats.get(d) || { occurrences: 0, roundupRowCount: 0 }
      entry.occurrences++
      if (rowDomains.size >= 3) entry.roundupRowCount++
      domainStats.set(d, entry)
    })
  })

  return Array.from(domainStats.entries()).map(([domain, stats]) => ({
    domain,
    source: 'ai_citation',
    occurrences: stats.occurrences,
    detectionNote: stats.roundupRowCount > 0 && stats.roundupRowCount === stats.occurrences
      ? 'Every AI-visibility run that cited this domain also cited 2+ other outside domains in the same answer -- worth verifying this is a single competing business’s own site, not a roundup/"top agencies" list page.'
      : null
  }))
}

// detectFromAhrefs(client, opts) -> Promise<{ candidates: Array<{domain, source: 'ahrefs', share, keywordsTarget, keywordsCompetitor, domainRating}>, error: null | { status, message } }>
// Keeps the full comparison fields (not just domain+share) so
// detectAndSyncCompetitors can hand them straight to
// competitive-position-checker.js's keyword-count sub-check -- one Ahrefs
// call serves both detection and scoring, no second paid call needed.
// Passes `error` straight through from getOrganicCompetitors -- see that
// function's header for why this doesn't just collapse to [] on failure.
async function detectFromAhrefs(client, { apiKey } = {}) {
  const { competitors, error } = await getOrganicCompetitors(client.domain, { apiKey })
  const clientDomain = normalizeDomain(client.domain)
  const candidates = competitors
    .filter(r => r.domain && normalizeDomain(r.domain) !== clientDomain && !isNonCompetitorDomain(`https://${r.domain}`))
    .map(r => ({
      domain: r.domain,
      source: 'ahrefs',
      share: r.share,
      keywordsTarget: r.keywordsTarget,
      keywordsCompetitor: r.keywordsCompetitor,
      domainRating: r.domainRating,
      detectionNote: null
    }))
  return { candidates, error }
}

// pruneStaleCompetitors(client, supabase) -> Promise<number> (rows removed)
// Self-healing cleanup, run at the start of every sync: re-checks every
// EXISTING auto-detected (source != 'manual') competitor row against the
// CURRENT exclusion rules -- the non-competitor domain list and the
// client's own (normalized) domain -- and hard-deletes any that now fail.
// Needed because, before this existed, updating the exclude list or
// fixing a detection bug only affected brand-new candidates going
// forward; a row inserted before the fix just sat there forever unless
// someone manually ran SQL against it -- which is exactly what happened
// 2026-08-13 (the self-domain bug and 6 directory domains both needed a
// one-off manual DB cleanup even after the code fix shipped, and the
// self-domain row came right back on the next audit that ran before the
// fix deployed). These are hard-deleted, not deactivated -- a domain that
// matches the static exclude list or the client's own domain has zero
// chance of ever being a real competitor, unlike the "maybe a roundup"
// detectionNote case, which stays a soft, reviewable flag. Manual entries
// (source: 'manual') are never touched here -- a strategist who added one
// on purpose decides whether to remove it, not this function.
async function pruneStaleCompetitors(client, supabase) {
  const { data: rows, error } = await supabase
    .from('client_competitors')
    .select('id, domain')
    .eq('client_id', client.id)
    .neq('source', 'manual')
  if (error) throw error

  const clientDomain = normalizeDomain(client.domain)
  const staleIds = (rows || [])
    .filter(r => r.domain === clientDomain || isNonCompetitorDomain(`https://${r.domain}`))
    .map(r => r.id)

  if (staleIds.length > 0) {
    const { error: deleteError } = await supabase.from('client_competitors').delete().in('id', staleIds)
    if (deleteError) throw deleteError
  }
  return staleIds.length
}

// detectAndSyncCompetitors(client, opts) -> Promise<{ competitors, ahrefsCompetitorData, ahrefsError }>
// Runs both detection signals, merges by domain (AI-citation candidates take
// priority when a domain is found by both -- it's the more directly
// relevant signal for this tool), inserts any brand-new domains, and bumps
// last_seen_at + detection_note on every candidate found this run WITHOUT
// touching existing rows' source/name/confirmed_at/active -- a strategist's
// manual edits or an earlier detection's provenance are never silently
// overwritten by a later run (detection_note is the one exception -- it's
// derived evidence, not a strategist's own input, so it's always kept
// current). Also prunes stale rows (see pruneStaleCompetitors above) before
// reading back the active list, so a strategist never has to hand-run SQL
// to clean up after an exclude-list update or bug fix. Returns the
// client's current active competitor list PLUS the raw Ahrefs comparison
// rows already fetched, so runAudit.js can pass both straight into
// competitive-position-checker.js without a second Ahrefs call. ahrefsError
// is null on a clean call (even if it legitimately found zero competitors)
// or a { status, message } describing why the call itself failed --
// competitive-position-checker.js surfaces this directly instead of a
// generic "no data" message when it's present.
async function detectAndSyncCompetitors(client, { ahrefsApiKey } = {}) {
  const [fromCitations, ahrefsResult] = await Promise.all([
    detectFromAiCitations(client).catch(() => []),
    detectFromAhrefs(client, { apiKey: ahrefsApiKey }).catch(err => ({
      candidates: [],
      error: { status: null, message: err && err.message ? err.message : String(err) }
    }))
  ])
  const fromAhrefs = ahrefsResult.candidates
  const ahrefsError = ahrefsResult.error

  const merged = new Map()
  fromCitations.forEach(c => merged.set(c.domain, c))
  fromAhrefs.forEach(c => { if (!merged.has(c.domain)) merged.set(c.domain, c) })
  const candidates = Array.from(merged.values())

  const supabase = getSupabaseServerClient()

  await pruneStaleCompetitors(client, supabase)

  if (candidates.length > 0) {
    const candidateDomains = candidates.map(c => c.domain)
    const { data: existing, error: existingError } = await supabase
      .from('client_competitors')
      .select('domain')
      .eq('client_id', client.id)
      .in('domain', candidateDomains)
    if (existingError) throw existingError
    const existingDomains = new Set((existing || []).map(r => r.domain))

    const toInsert = candidates
      .filter(c => !existingDomains.has(c.domain))
      .map(c => ({ client_id: client.id, domain: c.domain, source: c.source, detection_note: c.detectionNote || null }))
    if (toInsert.length > 0) {
      const { error: insertError } = await supabase.from('client_competitors').insert(toInsert)
      if (insertError) throw insertError
    }

    // last_seen_at and detection_note both get refreshed every run --
    // detection_note is derived evidence, not a strategist's own input, so
    // keeping it current (including clearing it back to null if a domain
    // stops looking like a roundup source) is more useful than leaving it
    // stuck at whatever it said the first time. This has to be a per-domain
    // update (not one bulk .update().in(...)) since each domain can have a
    // different note; source/name/confirmed_at/active are deliberately
    // left untouched here, same as before.
    const now = new Date().toISOString()
    const touchErrors = (await Promise.all(candidates.map(c =>
      supabase
        .from('client_competitors')
        .update({ last_seen_at: now, detection_note: c.detectionNote || null })
        .eq('client_id', client.id)
        .eq('domain', c.domain)
    ))).map(r => r.error).filter(Boolean)
    if (touchErrors.length > 0) throw touchErrors[0]
  }

  const { data: active, error: activeError } = await supabase
    .from('client_competitors')
    .select('*')
    .eq('client_id', client.id)
    .eq('active', true)
    .order('detected_at', { ascending: true })
  if (activeError) throw activeError
  return { competitors: active || [], ahrefsCompetitorData: fromAhrefs, ahrefsError }
}

// fetchKeywordCountMetrics(client, activeCompetitors, opts) -> Promise<{
//   clientOrgKeywords: number | null,
//   clientError: null | { status, message },
//   competitors: Array<{ domain, orgKeywords: number | null, error: null | { status, message } }>,
//   checkedCount: number,
//   totalActiveCount: number
// }>
// Added 2026-08-14 to replace the old organic-competitors-based keyword
// comparison (see checkers/ahrefs.js's getDomainMetrics header for exactly
// why that was wrong -- keywords_target/keywords_competitor are scoped to
// one specific target-vs-competitor pairing, not a site-wide total, so
// comparing them across several competitors compared numbers that were
// never meant to be compared that way).
//
// Calls Ahrefs' metrics endpoint once for the client's own domain and once
// per active tracked competitor (capped at MAX_KEYWORD_METRIC_COMPETITORS,
// oldest-detected-first -- same order client_competitors is already read
// in, no extra sort worth adding for a cap this small), all concurrently.
// competitive-position-checker.js's keyword-count sub-check consumes this
// directly; checkedCount/totalActiveCount let it note when the comparison
// only covered a subset of a client's full tracked-competitor list.
//
// Never throws -- getDomainMetrics itself never throws (see its own
// header), so this only needs to await the concurrent calls.
async function fetchKeywordCountMetrics(client, activeCompetitors, { apiKey, maxCompetitors = MAX_KEYWORD_METRIC_COMPETITORS } = {}) {
  const totalActiveCount = (activeCompetitors || []).length
  const competitorsToCheck = (activeCompetitors || []).slice(0, maxCompetitors)

  const [clientResult, competitorResults] = await Promise.all([
    getDomainMetrics(client.domain, { apiKey }),
    Promise.all(competitorsToCheck.map(c =>
      getDomainMetrics(c.domain, { apiKey }).then(r => ({ domain: c.domain, orgKeywords: r.orgKeywords, domainRating: r.domainRating, error: r.error }))
    ))
  ])

  return {
    clientOrgKeywords: clientResult.orgKeywords,
    clientDomainRating: clientResult.domainRating,
    clientError: clientResult.error,
    competitors: competitorResults,
    checkedCount: competitorsToCheck.length,
    totalActiveCount
  }
}

// selectScaleComparableCompetitors(clientDomainRating, competitors, opts)
// -> Array<competitor>
//
// Added 2026-08-15 -- real client complaint reviewing the first live
// keyword-opportunity list: "almost all of these keywords are from
// Thrive [Agency]... many are worthless [too]." Root cause: both the
// keyword-count score's competitor average AND the missing-keyword-
// opportunity diffing previously picked competitors by raw keyword count
// (biggest wins) -- which structurally favors whichever tracked
// competitor is the LARGEST, not whichever is actually a fair-scale
// peer. A boutique local business's real "closeable gap" is against
// similarly-scaled competitors, not a much bigger national player (same
// reasoning already logged in ROADMAP.md for the score fix). This sorts
// by proximity to the CLIENT's own Ahrefs domain_rating (closest first)
// and takes the top `max` -- guarantees a non-empty result whenever at
// least one competitor has domain-rating data, unlike a fixed +/- band
// cutoff which can legitimately yield zero matches for a client at
// either extreme of the scale.
//
// Falls back to returning `competitors` UNCHANGED (caller's own prior
// sort/order, just sliced to `max`) when clientDomainRating is null (e.g.
// the client's own Ahrefs metrics call failed) -- there's nothing to
// measure proximity against, so scale-aware selection degrades to the
// old behavior rather than silently misbehaving.
function selectScaleComparableCompetitors(clientDomainRating, competitors, { max } = {}) {
  const list = competitors || []
  if (typeof clientDomainRating !== 'number') return typeof max === 'number' ? list.slice(0, max) : list

  const withDr = list.filter(c => typeof c.domainRating === 'number')
  const withoutDr = list.filter(c => typeof c.domainRating !== 'number')
  const sorted = [...withDr].sort((a, b) => Math.abs(a.domainRating - clientDomainRating) - Math.abs(b.domainRating - clientDomainRating))
  // Competitors with no domain_rating data at all go last (in their
  // original order) rather than being dropped outright -- still usable
  // if there aren't enough DR-ranked ones to fill `max`.
  const ordered = [...sorted, ...withoutDr]
  return typeof max === 'number' ? ordered.slice(0, max) : ordered
}

// Capped per-audit cost for the keyword-count score's competitor average
// (2026-08-15) -- a small "nearest-scale peer group" rather than every
// checked competitor regardless of size. See
// selectScaleComparableCompetitors above for why.
const MAX_SCALE_COMPARABLE_COMPETITORS = 5

// Capped per-audit cost for the missing-keyword-opportunities feature
// (added 2026-08-14, per direct feedback: "89 vs 2538" told a client THAT
// they were behind on keywords, never WHAT to actually go target -- this
// pulls the real keyword lists so competitive-position-checker.js can diff
// them and surface specific missing terms). Diffing against every tracked
// competitor's full keyword list would be both expensive (one more Ahrefs
// call per competitor) and noisy (weaker competitors contribute mostly
// irrelevant long-tail matches) -- capping to the strongest few keeps both
// the cost and the result list meaningful.
const MAX_KEYWORD_OPPORTUNITY_COMPETITORS = 3
const KEYWORD_OPPORTUNITY_SAMPLE_SIZE = 200

// fetchMissingKeywordOpportunities(client, keywordMetrics, opts) -> Promise<{
//   clientKeywords: Array<{keyword, volume, position, branded, local}>,
//   competitorKeywordSets: Array<{ domain, keywords: Array<{...}> }>
// } | null>
// Picks the top MAX_KEYWORD_OPPORTUNITY_COMPETITORS active competitors by
// PROXIMITY to the client's own Ahrefs domain rating (see
// selectScaleComparableCompetitors above), reusing keywordMetrics.competitors
// (already fetched by fetchKeywordCountMetrics, no extra Ahrefs call spent
// just to rank them) -- REVISED 2026-08-15, previously ranked by raw
// organic-keyword count (biggest wins), which is exactly what caused a
// real client complaint: the resulting opportunity list was almost
// entirely sourced from whichever tracked competitor happened to be the
// largest (Thrive Agency, a much bigger national player), not a fair-
// scale peer, and included several off-topic/irrelevant terms that
// slipped through because a huge, unrelated competitor's total keyword
// list is noisier than a similarly-scaled one's. Falls back to the old
// keyword-count-desc ranking when the client's own domainRating is
// unavailable (see selectScaleComparableCompetitors's fallback). Then
// pulls each selected domain's actual organic-keywords LIST (not just the
// total count fetchKeywordCountMetrics already has) via Ahrefs' organic-
// keywords report -- the same report business-profile.js already uses for
// AI-visibility prompt generation, reused here for a different purpose.
// Returns null when keywordMetrics itself is null (not enough competitors
// to bother) or none of its competitor entries have usable keyword-count
// data to rank by.
//
// Deliberately returns raw keyword lists, not a diffed/filtered result --
// competitive-position-checker.js's buildKeywordOpportunities does the
// actual diffing, relevance filtering, and ranking, keeping that judgment
// call in the same file as the rest of this pillar's scoring logic rather
// than split across the fetch layer too.
async function fetchMissingKeywordOpportunities(client, keywordMetrics, { apiKey, maxCompetitors = MAX_KEYWORD_OPPORTUNITY_COMPETITORS, sampleSize = KEYWORD_OPPORTUNITY_SAMPLE_SIZE } = {}) {
  if (!keywordMetrics) return null

  // Pre-sorted by orgKeywords desc so the fallback path inside
  // selectScaleComparableCompetitors (when clientDomainRating is null)
  // reproduces the OLD ranking exactly, not an arbitrary/detection-order
  // slice -- the DR-proximity sort below overrides this order entirely
  // when clientDomainRating IS available.
  const withUsableCounts = (keywordMetrics.competitors || [])
    .filter(c => typeof c.orgKeywords === 'number' && !c.error)
    .sort((a, b) => b.orgKeywords - a.orgKeywords)
  const ranked = selectScaleComparableCompetitors(keywordMetrics.clientDomainRating, withUsableCounts, { max: maxCompetitors })

  if (ranked.length === 0) return null

  const [clientKeywords, competitorKeywordSets] = await Promise.all([
    getOrganicKeywords(client.domain, { apiKey, limit: sampleSize }),
    Promise.all(ranked.map(async c => ({
      domain: c.domain,
      keywords: await getOrganicKeywords(c.domain, { apiKey, limit: sampleSize })
    })))
  ])

  return { clientKeywords, competitorKeywordSets }
}

module.exports = { detectAndSyncCompetitors, detectFromAiCitations, detectFromAhrefs, fetchKeywordCountMetrics, fetchMissingKeywordOpportunities, selectScaleComparableCompetitors, MAX_SCALE_COMPARABLE_COMPETITORS }
