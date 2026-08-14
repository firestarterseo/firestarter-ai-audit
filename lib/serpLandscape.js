// Real, live Google-SERP evidence for keyword-opportunity candidates --
// answers "who ACTUALLY ranks for this keyword right now," which Ahrefs'
// tracked-competitor diffing structurally can't (it only ever reports
// positions for domains already on the tracked-competitor list). Added
// 2026-08-15 per a direct question from Skyler: for a lot of the
// informational, top-of-funnel candidates ("what is seo"), the real
// competition for the SERP isn't a tracked peer agency at all -- it's a
// small handful of marketing/SEO media publishers (Search Engine Journal,
// SEMrush, HubSpot, Moz...) running 10x this project's typical client's
// domain rating. Judging "realistic_tier" against thriveagency.com's
// position when the actual #1-3 results are publishers Thrive isn't even
// among misses the real opponent entirely.
//
// Reuses Cloro's "google" engine (lib/checkers/ai-visibility-snapshot-
// checker.js's defaultCloroCaller/extractEngineSignal) -- ALREADY paid
// for and called weekly for AI & GEO Visibility, and verified 2026-08-10
// against a real live capture to actually return organic SERP results
// (result.organicResults[].link + result.localResults[].links.website),
// not just an AI-generated answer string. This is the exact same
// infrastructure, just called with the keyword text itself as the query
// instead of an AI-visibility test prompt -- no new provider, no new key.
//
// Cost tradeoff (confirmed with Skyler 2026-08-15 before building this):
// this fires one ADDITIONAL live Cloro "google" call per candidate
// keyword, capped at MAX_KEYWORD_OPPORTUNITIES (15), on EVERY audit run,
// across all clients. That's real, ongoing Cloro usage on top of the
// existing weekly AI-visibility tracking, not a one-time cost -- chosen
// deliberately over the free-but-guessed LLM-only version because real
// SERP evidence is worth it for a judgment this consequential.
//
// Fails safe per keyword, same convention as every other optional
// enrichment in this project: a failed/timed-out Cloro call for one
// keyword just leaves that keyword's serpTopDomains empty and
// serpChecked: false -- lib/keywordRelevance.js's LLM call falls back to
// judging it without real SERP evidence (same as before this file
// existed), never blocks or drops the opportunity itself.

const { defaultCloroCaller, extractEngineSignal } = require('./checkers/ai-visibility-snapshot-checker')
const { isNonCompetitorDomain, hostnameOf } = require('./nonCompetitorDomains')

const MAX_SERP_DOMAINS_PER_KEYWORD = 10

// fetchSerpTopDomains(keyword, opts) -> Promise<{ topDomains: string[], error: string|null }>
// topDomains: deduped hostnames from Cloro's live Google organicResults/
// localResults/AI-Overview citations for this exact keyword text,
// position order preserved, capped at MAX_SERP_DOMAINS_PER_KEYWORD. Never
// throws -- same "never throws, return {value, error}" contract every
// other external-API wrapper in this project follows (see
// lib/checkers/ahrefs.js, lib/llm/anthropic.js).
async function fetchSerpTopDomains(keyword, { apiKey, country = 'US' } = {}) {
  if (!apiKey) return { topDomains: [], error: 'CLORO_API_KEY is not configured.' }
  try {
    const raw = await defaultCloroCaller('google', keyword, { apiKey, country })
    if (!raw || raw.success === false) {
      return { topDomains: [], error: (raw && raw.error) || 'Cloro call failed.' }
    }
    const { sourceUrls } = extractEngineSignal('google', raw)
    const domains = []
    const seen = new Set()
    for (const url of (sourceUrls || [])) {
      const host = hostnameOf(url)
      if (!host || seen.has(host)) continue
      seen.add(host)
      domains.push(host)
      if (domains.length >= MAX_SERP_DOMAINS_PER_KEYWORD) break
    }
    return { topDomains: domains, error: null }
  } catch (e) {
    return { topDomains: [], error: e.message || String(e) }
  }
}

// annotateWithSerpLandscape(keywordOpportunities, opts) -> Promise<Array<
//   opportunity & {
//     serpTopDomains: string[], serpChecked: boolean, serpError?: string,
//     serpKnownNonCompetitorDomains: string[]
//   }
// >>
// One Cloro call per opportunity, run concurrently -- the candidate list
// is already capped at 15 by buildKeywordOpportunities, so no extra
// throttling machinery yet; revisit if that cap ever grows. Never throws;
// a failed keyword just gets serpChecked: false and an empty
// topDomains/serpKnownNonCompetitorDomains, same graceful-degradation
// contract as lib/keywordRelevance.js.
async function annotateWithSerpLandscape(keywordOpportunities, { apiKey, country = 'US' } = {}) {
  if (!Array.isArray(keywordOpportunities) || keywordOpportunities.length === 0) return keywordOpportunities || []
  return Promise.all(
    keywordOpportunities.map(async o => {
      const { topDomains, error } = await fetchSerpTopDomains(o.keyword, { apiKey, country })
      return {
        ...o,
        serpTopDomains: topDomains,
        serpChecked: !error,
        serpError: error || undefined,
        // Free, already-existing signal -- no new curated list needed for
        // the general-press/directory case (Forbes, Wikipedia, etc. --
        // lib/nonCompetitorDomains.js). lib/keywordRelevance.js's LLM call
        // still makes the final serp_landscape judgment using the full
        // topDomains list, since it also recognizes industry-specific
        // publishers (Search Engine Journal, SEMrush, Moz...) that aren't
        // on that general list -- this just hands it one piece of real,
        // pre-verified evidence instead of leaving it to infer everything
        // from domain names alone.
        serpKnownNonCompetitorDomains: topDomains.filter(d => isNonCompetitorDomain(`https://${d}`))
      }
    })
  )
}

module.exports = { fetchSerpTopDomains, annotateWithSerpLandscape, MAX_SERP_DOMAINS_PER_KEYWORD }
