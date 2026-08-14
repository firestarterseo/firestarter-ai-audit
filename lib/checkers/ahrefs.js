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
// domainRating added 2026-08-15 (see lib/competitorDetection.js's
// scale-proximity competitor selection, built to stop the keyword-count
// score and missing-keyword opportunities from being dominated by
// whichever tracked competitor simply has the MOST keywords, regardless
// of whether it's actually a fair-scale peer -- a real client complaint,
// "almost all of these keywords are from Thrive," a much larger national
// agency). Rides along on the exact same per-domain call already being
// made for org_keywords, so this is zero extra Ahrefs cost. NOT yet
// verified against a live call the way organic-keywords/organic-
// competitors' `select` lists have been (see getOrganicCompetitors's
// header on the country-casing lesson) -- if `domainRating` comes back
// null in practice even for domains that plainly have one, check Ahrefs'
// actual field name/select requirement for this report before assuming
// the metric itself is unavailable. Failure mode either way is graceful:
// callers already treat a null domainRating as "fall back to the
// non-scale-aware behavior," never a crash.
async function getDomainMetrics(domain, { apiKey } = {}) {
  if (!apiKey) return { orgKeywords: null, domainRating: null, error: { status: null, message: 'AHREFS_API_KEY is not configured.' } }
  if (!domain) return { orgKeywords: null, domainRating: null, error: { status: null, message: 'No domain provided.' } }

  const params = new URLSearchParams({
    target: domain,
    date: todayIsoDate(),
    select: ['org_keywords', 'domain_rating'].join(','),
    mode: 'domain',
    protocol: 'both'
  })

  try {
    const res = await fetch(`${METRICS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return { orgKeywords: null, domainRating: null, error: { status: res.status, message: bodyText.slice(0, 300) || res.statusText || 'no response body' } }
    }
    const data = await res.json()
    const orgKeywords = typeof data?.metrics?.org_keywords === 'number' ? data.metrics.org_keywords : null
    const domainRating = typeof data?.metrics?.domain_rating === 'number' ? data.metrics.domain_rating : null
    return { orgKeywords, domainRating, error: null }
  } catch (e) {
    return { orgKeywords: null, domainRating: null, error: { status: null, message: e.message || String(e) } }
  }
}

module.exports = { getOrganicKeywords, topPromptCandidates, getBacklinksStats, getOrganicCompetitors, getDomainMetrics }
