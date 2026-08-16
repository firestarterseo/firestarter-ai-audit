// Thin wrapper around Ahrefs API v3's Site Explorer "organic keywords"
// report -- real, ranking-validated search terms for a domain. This is a
// fundamentally better AI-visibility prompt source than anything guessed
// from a schema type or scraped from a single page's title/meta (see
// business-profile.js's generatePromptCandidates, which tries these first
// when they're available): a term like "denver seo agency" shows up here
// because the domain genuinely ranks for it, not because it happened to be
// written on whichever single page got fetched.
//
// Docs: https://docs.ahrefs.com/api/reference/site-explorer/get-organic-keywords
//
// The API key (AHREFS_API_KEY) is only ever read from the server env var
// added directly in Vercel -- same pattern as CLORO_API_KEY and
// SUPABASE_SERVICE_ROLE_KEY elsewhere in this project. Never logged, never
// returned to the client, never touched by this code beyond this one
// fetch call.

const ORGANIC_KEYWORDS_URL = 'https://api.ahrefs.com/v3/site-explorer/organic-keywords'
const BACKLINKS_STATS_URL = 'https://api.ahrefs.com/v3/site-explorer/backlinks-stats'
const ORGANIC_COMPETITORS_URL = 'https://api.ahrefs.com/v3/site-explorer/organic-competitors'
const METRICS_URL = 'https://api.ahrefs.com/v3/site-explorer/metrics'
// Dedicated domain-rating endpoint -- see getDomainRating() below for why
// this exists as its own function/URL rather than a `domain_rating` select
// field on METRICS_URL.
const DOMAIN_RATING_URL = 'https://api.ahrefs.com/v3/site-explorer/domain-rating'
// Keywords Explorer (a different Ahrefs product surface from Site
// Explorer above) -- see getKeywordDifficulty() below.
const KEYWORDS_EXPLORER_OVERVIEW_URL = 'https://api.ahrefs.com/v3/keywords-explorer/overview'
// Individual backlink records (not the aggregate counts getBacklinksStats
// above returns) -- see getAuthorityBacklinks() below, added for the
// Entity & Citation Authority pillar.
const ALL_BACKLINKS_URL = 'https://api.ahrefs.com/v3/site-explorer/all-backlinks'

// Only request fields actually used below. Ahrefs' own docs call out that
// several numeric metrics (volume, sum_traffic, keyword_difficulty) cost
// extra API units per request -- no reason to pay for fields nobody reads.
// is_branded/is_local are cheap boolean flags Ahrefs already computes,
// which is what lets topPromptCandidates() filter out branded queries
// ("firestarter seo") without us having to string-match against the
// business's own name.
const SELECT_FIELDS = ['keyword', 'volume', 'best_position', 'is_branded', 'is_local']

function todayIsoDate() {
  // Ahrefs requires a `date` param (their "as of" reporting date) -- this
  // has to be the real current date, not something bakeable at deploy
  // time.
  return new Date().toISOString().slice(0, 10)
}

// getOrganicKeywords(domain, opts) -> Promise<Array<{keyword, volume, position, branded, local}>>
// Returns [] -- never throws -- when the domain has no organic rankings
// yet (a brand-new lead's site that hasn't earned any rankings), the API
// key is missing/invalid, or the call itself fails for any other reason.
// Callers fall back to title/meta/schema-guessed terms in that case, same
// as every other data-source gap in this project (see runAudit.js's header
// comment on why a missing data source returns "no data," never a fake
// result).
async function getOrganicKeywords(domain, { apiKey, limit = 25, country = null } = {}) {
  if (!apiKey || !domain) return []

  const params = new URLSearchParams({
    target: domain,
    date: todayIsoDate(),
    select: SELECT_FIELDS.join(','),
    limit: String(limit),
    mode: 'domain',
    protocol: 'both',
    order_by: 'volume:desc'
  })
  if (country) params.set('country', country)

  try {
    const res = await fetch(`${ORGANIC_KEYWORDS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) return []
    const data = await res.json()
    const rows = Array.isArray(data?.keywords) ? data.keywords : []
    return rows
      .filter(r => r && r.keyword)
      .map(r => ({
        keyword: r.keyword,
        volume: typeof r.volume === 'number' ? r.volume : null,
        position: typeof r.best_position === 'number' ? r.best_position : null,
        branded: !!r.is_branded,
        local: !!r.is_local
      }))
  } catch (e) {
    // Network error, timeout, bad JSON, etc -- treated the same as "no
    // data," not a fatal error. An AI-visibility audit shouldn't fail
    // outright just because a third-party keyword API had a bad moment.
    return []
  }
}

// getBacklinksStats(domain, opts) -> Promise<{ liveRefDomains, allTimeRefDomains, liveBacklinks, allTimeBacklinks } | null>
// Ahrefs Site Explorer's "backlinks-stats" report -- the same real, live
// authority data content-checker.js's Referring Domains check has been
// waiting on since it was first written (that check has always accepted a
// backlinkApiKey param; nothing implemented it against a specific vendor
// until now, per its own header comment on that being an intentional,
// not-yet-resolved integration point).
//
// Docs: https://docs.ahrefs.com/en/api/reference/site-explorer/get-backlinks-stats
//
// Returns null -- never throws -- when the API key is missing or the call
// fails for any reason (bad domain, network error, quota, etc). Callers
// treat that exactly like "no backlink API configured" -- a data gap, not
// a fabricated zero.
async function getBacklinksStats(domain, { apiKey } = {}) {
  if (!apiKey || !domain) return null

  const params = new URLSearchParams({
    target: domain,
    date: todayIsoDate(),
    mode: 'domain',
    protocol: 'both'
  })

  try {
    const res = await fetch(`${BACKLINKS_STATS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) return null
    const data = await res.json()
    const metrics = data?.metrics
    if (!metrics) return null
    return {
      liveRefDomains: typeof metrics.live_refdomains === 'number' ? metrics.live_refdomains : 0,
      allTimeRefDomains: typeof metrics.all_time_refdomains === 'number' ? metrics.all_time_refdomains : 0,
      liveBacklinks: typeof metrics.live === 'number' ? metrics.live : 0,
      allTimeBacklinks: typeof metrics.all_time === 'number' ? metrics.all_time : 0
    }
  } catch (e) {
    return null
  }
}

// topPromptCandidates(rows, opts) -> string[]
// Branded queries ("firestarter seo") don't test competitive AI
// visibility -- the entire point of this feature is checking whether the
// business shows up for searches that AREN'T just its own name -- so those
// are filtered out entirely, not just deprioritized. What's left is
// sorted by real search volume and capped.
function topPromptCandidates(rows, { max = 5 } = {}) {
  if (!Array.isArray(rows)) return []
  return rows
    .filter(r => !r.branded)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, max)
    .map(r => r.keyword)
}

// getOrganicCompetitors(domain, opts) -> Promise<{ competitors: Array<{domain, keywordsCommon, keywordsTarget, keywordsCompetitor, share, domainRating}>, error: null | { status, message } }>
// Ahrefs Site Explorer's "organic competitors" report -- domains that share
// the most organic keyword overlap with the target domain. This is BOTH the
// data source for auto-detecting candidate Competitive Position competitors
// (lib/competitorDetection.js) AND, since `keywords_target` is the client's
// own keyword count on every row of the same response, the source for the
// keyword-count comparison sub-check in
// lib/checkers/competitive-position-checker.js -- one call serves both
// purposes, no separate fetch needed for the comparison.
//
// Docs (verified 2026-08-13): https://docs.ahrefs.com/en/api/reference/site-explorer/get-organic-competitors
// Endpoint requires `select`; `country` is accepted but -- same as
// getOrganicKeywords above -- only sent here if the caller provides one,
// since Ahrefs' own docs list a full-site default when omitted and every
// other call in this file already follows that convention.
//
// Unlike every other function in this file, this one does NOT just return
// [] and swallow the reason -- it returns { competitors, error }, where
// error carries the HTTP status/response body on a non-ok response or the
// caught exception message. Found 2026-08-14: `competitors: []` with no
// diagnostic made "Ahrefs genuinely has no competitor data for this site"
// indistinguishable from "the API call is silently failing" -- and
// surfacing the real error (rather than swallowing it) is exactly what
// caught the actual root cause, in two stages: this endpoint requires a
// `country` param at all (the OTHER Ahrefs endpoints this tool calls --
// organic-keywords, backlinks-stats -- do NOT), and then that Ahrefs'
// own docs page was WRONG about its casing -- it showed uppercase
// ("AD", "AE") but the live API's own 400 response spelled out its real
// allowed list as lowercase ("ad, ae, af, ..."), which is what fixed it.
// Every client in this tool is US-based today, so lowercase 'us' is a
// reasonable default when the caller doesn't supply one; this becomes
// wrong the day a non-US client is added and should be revisited then
// (ideally derived from the client's own region, once that's mapped to
// a country code somewhere).
// competitorDetection.js and competitive-position-checker.js surface
// `error` directly in the pillar's evidence when present, instead of the
// generic "no data" message.
async function getOrganicCompetitors(domain, { apiKey, limit = 20, country = 'us' } = {}) {
  if (!apiKey) return { competitors: [], error: { status: null, message: 'AHREFS_API_KEY is not configured.' } }
  if (!domain) return { competitors: [], error: { status: null, message: 'No domain provided.' } }

  const params = new URLSearchParams({
    target: domain,
    date: todayIsoDate(),
    // Ahrefs' own docs page claimed uppercase ("AD", "AE", ...) -- that
    // was wrong. The live API's own 400 response (2026-08-14) spelled out
    // its actual allowed list as all-lowercase ("ad, ae, af, ag, ...").
    // Trusting the real error over the docs summary here.
    country: (country || 'us').toLowerCase(),
    select: ['competitor_domain', 'keywords_common', 'keywords_target', 'keywords_competitor', 'share', 'domain_rating'].join(','),
    limit: String(limit),
    mode: 'domain',
    protocol: 'both',
    order_by: 'share:desc'
  })

  try {
    const res = await fetch(`${ORGANIC_COMPETITORS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return { competitors: [], error: { status: res.status, message: bodyText.slice(0, 300) || res.statusText || 'no response body' } }
    }
    const data = await res.json()
    const rows = Array.isArray(data?.competitors) ? data.competitors : []
    const competitors = rows
      .filter(r => r && (r.competitor_domain || r.competitor_url))
      .map(r => ({
        domain: r.competitor_domain || r.competitor_url,
        keywordsCommon: typeof r.keywords_common === 'number' ? r.keywords_common : null,
        keywordsTarget: typeof r.keywords_target === 'number' ? r.keywords_target : null,
        keywordsCompetitor: typeof r.keywords_competitor === 'number' ? r.keywords_competitor : null,
        share: typeof r.share === 'number' ? r.share : null,
        domainRating: typeof r.domain_rating === 'number' ? r.domain_rating : null
      }))
    return { competitors, error: null }
  } catch (e) {
    return { competitors: [], error: { status: null, message: e.message || String(e) } }
  }
}

// getDomainMetrics(domain, opts) -> Promise<{ orgKeywords: number | null, error: null | { status, message } }>
// Ahrefs Site Explorer's "metrics" report -- a genuine single total organic-
// keyword count for a domain (field `org_keywords`, per Ahrefs' own docs:
// "the total number of keywords that your target ranks for in the top 100
// organic search results"). Added 2026-08-14 to REPLACE the previous
// keyword-count comparison in competitive-position-checker.js, which had
// been comparing organic-competitors' `keywords_target`/`keywords_competitor`
// fields as if they were each domain's total keyword count -- they aren't:
// per Ahrefs' own field definitions, those are scoped to one specific
// target-vs-competitor pairing ("keywords target ranks for that this ONE
// competitor doesn't"), not a site-wide total, so averaging them across
// several competitors compared numbers that were never meant to be
// compared that way. This endpoint is the correct source for "how many
// keywords does this domain rank for, total" -- one domain per call,
// unlike organic-competitors which returns many domains in one call, so
// comparing against N tracked competitors costs N+1 calls here (see
// lib/competitorDetection.js's fetchKeywordCountMetrics, which caps how
// many competitors get checked to bound this cost).
//
// Docs (verified 2026-08-14): https://docs.ahrefs.com/en/api/reference/site-explorer/get-metrics
// Unlike organic-competitors, `country` is OPTIONAL here (confirmed
// against the docs directly, given organic-competitors' docs were wrong
// about country casing) -- omitted entirely rather than guessed at.
//
// Same { value, error } contract as getOrganicCompetitors -- a real API
// failure is never collapsed into a bare "no data" result.
//
// BUG FOUND AND FIXED 2026-08-15: domainRating was originally bolted onto
// THIS function's `select` as a `domain_rating` field, on the theory that
// it was just another metric alongside org_keywords on the same report.
// It isn't -- confirmed against Ahrefs' own docs
// (https://docs.ahrefs.com/en/api/reference/site-explorer/get-metrics):
// `domain_rating` is NOT a valid field on the /metrics report at all (its
// real fields are org_keywords/org_traffic/paid_* etc.), so the field
// silently never came back, `clientDomainRating` was `null` on every
// single audit run since this feature shipped, and the scale-matching
// competitor selection (lib/competitorDetection.js's
// selectScaleComparableCompetitors) was permanently falling back to its
// "no domain rating available" path -- i.e. comparing against every
// checked competitor regardless of size, the exact "89 vs 2538"-style gap
// this whole fix was supposed to have closed. Caught 2026-08-15 when a
// live run still showed the client's own keyword-count evidence
// unchanged after the fix had supposedly shipped. Domain rating lives on
// its own dedicated report, `getDomainRating()` below -- kept as a
// SEPARATE function/API call rather than trying to fold it back into this
// one, since it's a genuinely different Ahrefs endpoint, not an
// alternate field on this one.
//
// domainRating REMOVED from this function 2026-08-15 -- see the bug note
// above. This report only ever returns org_keywords now; domain rating
// comes from the dedicated getDomainRating() below.
async function getDomainMetrics(domain, { apiKey } = {}) {
  if (!apiKey) return { orgKeywords: null, error: { status: null, message: 'AHREFS_API_KEY is not configured.' } }
  if (!domain) return { orgKeywords: null, error: { status: null, message: 'No domain provided.' } }

  const params = new URLSearchParams({
    target: domain,
    date: todayIsoDate(),
    select: 'org_keywords',
    mode: 'domain',
    protocol: 'both'
  })

  try {
    const res = await fetch(`${METRICS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return { orgKeywords: null, error: { status: res.status, message: bodyText.slice(0, 300) || res.statusText || 'no response body' } }
    }
    const data = await res.json()
    const orgKeywords = typeof data?.metrics?.org_keywords === 'number' ? data.metrics.org_keywords : null
    return { orgKeywords, error: null }
  } catch (e) {
    return { orgKeywords: null, error: { status: null, message: e.message || String(e) } }
  }
}

// getDomainRating(domain, opts) -> Promise<{ domainRating: number | null, error: null | { status, message } }>
// Ahrefs Site Explorer's dedicated "domain-rating" report -- confirmed
// 2026-08-15 (see the bug note on getDomainMetrics above) against
// https://docs.ahrefs.com/en/api/reference/site-explorer/get-domain-rating
// as the actual source for this metric; response shape is
// { domain_rating: { domain_rating: <float>, ahrefs_rank: <int> } } (the
// field is nested one level deeper than getDomainMetrics' flat
// `data.metrics.*` shape -- easy to get wrong a second time, hence
// spelling out the exact path here). One call per domain, same "N+1
// calls to compare against N tracked competitors" cost shape as
// getDomainMetrics -- lib/competitorDetection.js's fetchKeywordCountMetrics
// calls both per domain now, so this doubles that sub-check's Ahrefs call
// count (was N+1, now 2*(N+1)). Same { value, error } / never-throws
// contract as every other function in this file.
async function getDomainRating(domain, { apiKey } = {}) {
  if (!apiKey) return { domainRating: null, error: { status: null, message: 'AHREFS_API_KEY is not configured.' } }
  if (!domain) return { domainRating: null, error: { status: null, message: 'No domain provided.' } }

  const params = new URLSearchParams({
    target: domain,
    date: todayIsoDate()
  })

  try {
    const res = await fetch(`${DOMAIN_RATING_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return { domainRating: null, error: { status: res.status, message: bodyText.slice(0, 300) || res.statusText || 'no response body' } }
    }
    const data = await res.json()
    const domainRating = typeof data?.domain_rating?.domain_rating === 'number' ? data.domain_rating.domain_rating : null
    return { domainRating, error: null }
  } catch (e) {
    return { domainRating: null, error: { status: null, message: e.message || String(e) } }
  }
}

// getKeywordDifficulty(keywords, opts) -> Promise<{ results: Array<{ keyword, difficulty: number | null }>, error: null | { status, message } }>
// Ahrefs KEYWORDS EXPLORER's "overview" report (a different product
// surface from every other function in this file, which all call Site
// Explorer) -- real Keyword Difficulty (0-100), computed by Ahrefs from
// the actual backlink profiles of the pages currently ranking for each
// keyword. Added 2026-08-15 as the direct answer to a fair complaint
// (Skyler): realistic_tier was an LLM's read of domain names and a
// position number, not a real calculation. See lib/keywordRelevance.js's
// computeRealisticTier for how this gets combined with the client's own
// (now-fixed) domain rating into an actual deterministic tier, replacing
// the LLM's discretion over that field whenever both real numbers are
// available.
//
// Docs: https://docs.ahrefs.com/en/api/reference/keywords-explorer/get-overview
// `keywords` accepts a comma-separated list -- ALL of a run's candidate
// keywords (capped at MAX_KEYWORD_OPPORTUNITIES, 15) go out in ONE call
// here, not one call per keyword; the endpoint's own default limit is
// 1000 keywords per request, far above anything this feature will ever
// send. `country` defaults to lowercase 'us', matching
// getOrganicCompetitors's already-learned lesson that Ahrefs' own docs
// examples (which show uppercase "US") don't necessarily match what the
// live API actually requires -- NOT yet verified against a live call for
// THIS specific endpoint, though; if `difficulty` comes back null across
// the board even for keywords that plainly have search volume, check
// country casing here first, same as that earlier bug.
async function getKeywordDifficulty(keywords, { apiKey, country = 'us' } = {}) {
  if (!apiKey) return { results: [], error: { status: null, message: 'AHREFS_API_KEY is not configured.' } }
  if (!Array.isArray(keywords) || keywords.length === 0) return { results: [], error: null }

  const params = new URLSearchParams({
    select: 'keyword,difficulty',
    country: (country || 'us').toLowerCase(),
    keywords: keywords.join(',')
  })

  try {
    const res = await fetch(`${KEYWORDS_EXPLORER_OVERVIEW_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return { results: [], error: { status: res.status, message: bodyText.slice(0, 300) || res.statusText || 'no response body' } }
    }
    const data = await res.json()
    const rows = Array.isArray(data?.keywords) ? data.keywords : []
    const results = rows
      .filter(r => r && typeof r.keyword === 'string')
      .map(r => ({ keyword: r.keyword, difficulty: typeof r.difficulty === 'number' ? r.difficulty : null }))
    return { results, error: null }
  } catch (e) {
    return { results: [], error: { status: null, message: e.message || String(e) } }
  }
}

// getAuthorityBacklinks(domain, opts) -> Promise<{ authorityReferringDomains: Array<{domain, exampleUrl}>, totalReferringDomainsChecked: number, error: null | { status, message } }>
// Added for the Entity & Citation Authority pillar (lib/checkers/entity-
// citation-authority-checker.js) -- getBacklinksStats above only ever
// returns aggregate counts (how many referring domains, total), which
// can't answer the actual question this pillar needs answered: are any of
// those referring domains a RECOGNIZED authority (Clutch, G2, Trustpilot,
// BBB, etc. -- see lib/authorityDomains.js), not just link volume. This
// calls Ahrefs' individual-backlink-records report instead, with
// aggregation=1_per_domain so each distinct referring domain appears once
// regardless of how many individual pages on it link here (we only care
// about DOMAIN-level authority presence, not per-page backlink count).
//
// Docs (verified 2026-08-16): https://docs.ahrefs.com/en/api/reference/site-explorer/get-all-backlinks
// select=url_from,name_source per that page's documented response fields
// (url_from = the linking page's URL, name_source = the full referring
// domain including subdomains -- this is the field filtered against
// isAuthorityDomain below).
//
// NOT YET VERIFIED against a live call, unlike every other function in
// this file -- this is the first time this project calls this specific
// endpoint. Two things in particular to confirm on the first real run,
// same "trust the live response over the docs" lesson getOrganicCompetitors
// and getKeywordDifficulty already learned the hard way for other Ahrefs
// endpoints: (1) whether a `date` param is actually required here (the
// docs excerpt used to write this didn't call one out, unlike
// getOrganicKeywords/getBacklinksStats which explicitly require it -- if
// every call 400s, try adding todayIsoDate() as `date` first), and (2) the
// exact top-level JSON key wrapping the array -- guessed as `backlinks`
// below, matching this file's existing keywords/competitors/metrics naming
// convention, but not confirmed. Both failure modes degrade to the normal
// { authorityReferringDomains: [], error } contract below, never a crash --
// but a strategist reviewing this pillar's first real results should
// sanity-check that `totalReferringDomainsChecked` isn't suspiciously 0 for
// a client getBacklinksStats already shows has real referring domains.
async function getAuthorityBacklinks(domain, { apiKey, limit = 200 } = {}) {
  if (!apiKey) return { authorityReferringDomains: [], totalReferringDomainsChecked: null, error: { status: null, message: 'AHREFS_API_KEY is not configured.' } }
  if (!domain) return { authorityReferringDomains: [], totalReferringDomainsChecked: null, error: { status: null, message: 'No domain provided.' } }

  const params = new URLSearchParams({
    target: domain,
    select: ['url_from', 'name_source'].join(','),
    mode: 'domain',
    aggregation: '1_per_domain',
    limit: String(limit)
  })

  try {
    const res = await fetch(`${ALL_BACKLINKS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return { authorityReferringDomains: [], totalReferringDomainsChecked: null, error: { status: res.status, message: bodyText.slice(0, 300) || res.statusText || 'no response body' } }
    }
    const data = await res.json()
    // Guessed response wrapper key -- see header comment. Checks the two
    // most plausible shapes given this file's existing conventions before
    // falling back to an empty list.
    const rows = Array.isArray(data?.backlinks) ? data.backlinks : (Array.isArray(data?.all_backlinks) ? data.all_backlinks : [])
    const { isAuthorityDomain } = require('../authorityDomains')
    const authorityReferringDomains = rows
      .filter(r => r && typeof r.name_source === 'string' && isAuthorityDomain(`https://${r.name_source}`))
      .map(r => ({ domain: r.name_source, exampleUrl: r.url_from || null }))
      // A single authority domain can still appear more than once if
      // aggregation didn't dedupe exactly as expected -- de-dupe by domain
      // name here too, defensively, rather than trusting the API's
      // aggregation param alone.
      .filter((r, i, arr) => arr.findIndex(x => x.domain === r.domain) === i)
    return { authorityReferringDomains, totalReferringDomainsChecked: rows.length, error: null }
  } catch (e) {
    return { authorityReferringDomains: [], totalReferringDomainsChecked: null, error: { status: null, message: e.message || String(e) } }
  }
}

module.exports = { getOrganicKeywords, topPromptCandidates, getBacklinksStats, getOrganicCompetitors, getDomainMetrics, getDomainRating, getKeywordDifficulty, getAuthorityBacklinks }
