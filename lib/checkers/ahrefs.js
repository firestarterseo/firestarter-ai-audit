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

const BASE_URL = 'https://api.ahrefs.com/v3/site-explorer/organic-keywords'

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
    const res = await fetch(`${BASE_URL}?${params.toString()}`, {
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

module.exports = { getOrganicKeywords, topPromptCandidates }
