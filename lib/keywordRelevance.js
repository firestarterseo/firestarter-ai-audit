// Refines competitive-position-checker.js's missing-keyword opportunities
// with an actual relevance/realism judgment call -- replacing what a
// static blocklist + raw-volume ranking structurally can't do across a
// varied client roster. Real trigger: a live run surfaced "erp" and "b2b"
// as top opportunities for Firestarter (an SEO agency, where both are
// pure noise) -- but "erp" is a perfectly legitimate, high-value keyword
// for a different client that actually sells ERP software. A hardcoded
// blocklist can never be safe across 85 clients in different verticals;
// this prompt is the real fix (drafted 2026-08-14, wired in 2026-08-15
// using Anthropic -- see lib/llm/anthropic.js).
//
// Purely additive/refining -- never changes competitive-position-
// checker.js's SCORE (same "informational, not scored" convention as the
// rest of this feature; see that file's header). Runs AFTER
// buildKeywordOpportunities, on its already-capped candidate list (max
// `MAX_KEYWORD_OPPORTUNITIES`, currently 15) -- one cheap Anthropic call
// per audit run, not per keyword.
//
// Client context is built from what's ALREADY on the `clients` row today
// (name, domain, city, region, category) plus this run's own Ahrefs
// domain rating -- NOT yet the richer service_area_type/ymyl_sensitive
// fields discussed in ROADMAP.md's "Client context profile fields" (that
// migration hasn't shipped yet). Enrich buildClientContext once those
// land; this still works reasonably without them.
//
// SERP-landscape evidence (added 2026-08-15, see lib/serpLandscape.js):
// each candidate now ALSO carries the real, live Google-SERP top domains
// for its exact keyword text (via Cloro's "google" engine, already paid
// for elsewhere in this project) when that call succeeded. Real trigger:
// Skyler pointed out that a lot of these candidates are informational,
// top-of-funnel terms actually dominated by marketing/SEO media
// publishers (Search Engine Journal, SEMrush, HubSpot...), not by the
// tracked competitor Ahrefs happened to diff against -- judging
// "realistic_tier" off thriveagency.com's position when the real #1-3
// results are publishers Thrive isn't even among was misleading. This
// gives the model REAL evidence to ground serp_landscape/realistic_tier
// in, rather than inferring everything from the tracked competitor's
// brand name alone. Falls back gracefully to the old brand-name-inference
// behavior when serpChecked is false (Cloro call failed or
// CLORO_API_KEY missing) -- same "a non-essential enrichment failing
// never blocks the judgment" contract as everything else here.

const { callAnthropicTool } = require('./llm/anthropic')

const RELEVANCE_TOOL = {
  name: 'classify_keyword_opportunities',
  description: 'Judge each candidate keyword opportunity for topical relevance, funnel stage, local-intent fit, and realistic winnability for this specific client.',
  input_schema: {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            keyword: { type: 'string' },
            relevant: {
              type: 'boolean',
              description: 'Does this genuinely relate to what THIS specific client sells/does? False for off-topic matches regardless of search volume (e.g. "erp" for an SEO agency).'
            },
            relevance_reason: { type: 'string', description: 'One sentence.' },
            funnel_stage: { type: 'string', enum: ['informational', 'commercial', 'transactional'] },
            geo_recommendation: {
              type: 'string',
              enum: ['none', 'suggest_local_variant'],
              description: '"suggest_local_variant" when this client appears to be a local/regional business and the keyword is an unmodified national head term (e.g. "seo agency" instead of "seo agency denver").'
            },
            suggested_local_variant: { type: ['string', 'null'], description: 'A realistic local-modified version of the keyword, or null if geo_recommendation is "none".' },
            serp_landscape: {
              type: 'string',
              enum: ['peer_agency_competitive', 'publisher_dominated', 'mixed', 'unknown'],
              description: 'Who actually holds the top Google results for this exact keyword. "peer_agency_competitive" when the top results are businesses structurally similar to this client (other agencies, local competitors) -- a real, buildable content gap. "publisher_dominated" when the top results are large media/reference publishers (e.g. Search Engine Journal, SEMrush, HubSpot, Moz, WordStream, Healthline, NerdWallet -- whatever is standard for this client\'s industry) with far more domain authority than any peer competitor -- ranking #1 there is not a realistic content play regardless of effort; the real move is earning a citation/mention INSIDE that publisher\'s content, not out-ranking it. "mixed" when both appear in the top results. "unknown" ONLY when serp_top_domains was not provided for this keyword (Cloro check unavailable) -- in that case, infer as best you can from competitor_domain alone and say so in tier_reason, but prefer "unknown" over guessing confidently with no real evidence.'
            },
            realistic_tier: {
              type: 'string',
              enum: ['near_term', 'aspirational', 'citation_target'],
              description: '"near_term" if winnable with realistic content effort given the scale gap to the competitor -- only applies when serp_landscape is peer_agency_competitive or mixed. "aspirational" if the gap (competitor size/authority) makes ranking a long-shot but it is still fundamentally a ranking/content play. "citation_target" when serp_landscape is publisher_dominated -- the realistic path for this keyword is getting mentioned/cited/quoted inside the dominant publisher\'s existing content (PR/relationship-building), not writing a page to try to out-rank it.'
            },
            tier_reason: { type: 'string', description: 'One sentence. If serp_landscape is publisher_dominated, name which kind of publisher (e.g. "dominated by SEO/marketing media sites like Search Engine Journal and SEMrush") and suggest the citation angle instead of a ranking angle.' }
          },
          required: ['keyword', 'relevant', 'relevance_reason', 'funnel_stage', 'geo_recommendation', 'serp_landscape', 'realistic_tier', 'tier_reason']
        }
      }
    },
    required: ['classifications']
  }
}

const SYSTEM_PROMPT = `You are a senior local/regional SEO strategist reviewing candidate keyword opportunities for a client business. You will be given the client's business context and a list of keywords a tracked competitor ranks well for that the client does not rank for at all. Each candidate may also include serp_top_domains -- the REAL, live top Google results for that exact keyword (from a direct search, not a guess) -- when that data was available. Judge each keyword on its own merits -- a high-volume keyword a competitor ranks for is NOT automatically relevant or realistically winnable for this client, and the tracked competitor's own position is NOT the whole picture: many informational/top-of-funnel keywords are actually dominated by large media/reference publishers that aren't even the tracked competitor. When serp_top_domains is present, ground your serp_landscape judgment in those actual domains rather than guessing from the competitor's brand name alone; when it's absent, say so and use "unknown" rather than presenting a guess as certain. Be skeptical of generic head terms and off-topic matches. Return a classification for every candidate keyword given, in the same order.`

// refineKeywordOpportunities(keywordOpportunities, clientContext, opts) ->
// Promise<Array<opportunity & {
//   llmRefined: boolean, llmError?: string,
//   relevant?, relevanceReason?, funnelStage?, geoRecommendation?,
//   serpLandscape? ('peer_agency_competitive'|'publisher_dominated'|
//     'mixed'|'unknown'),
//   suggestedLocalVariant?, realisticTier?, tierReason?
// }>>
//
// On ANY failure (no API key, network error, malformed/missing response,
// or the model not returning a classification for a given keyword),
// that item passes through UNFILTERED with llmRefined: false -- this
// judgment layer can only ever REMOVE an item it explicitly marked
// irrelevant, never silently zero out a real, deterministically-computed
// opportunity just because the refinement call had a bad moment. Same
// "a non-essential side effect failing shouldn't break the audit"
// principle as every other optional enrichment in this project.
async function refineKeywordOpportunities(keywordOpportunities, clientContext, { apiKey } = {}) {
  if (!Array.isArray(keywordOpportunities) || keywordOpportunities.length === 0) return keywordOpportunities || []

  const candidates = keywordOpportunities.map(o => ({
    keyword: o.keyword,
    monthly_search_volume: o.volume,
    competitor_domain: o.competitorDomain,
    competitor_position: o.competitorPosition,
    // Populated by lib/serpLandscape.js's annotateWithSerpLandscape,
    // called BEFORE this function in lib/runAudit.js. Only included when
    // that Cloro check actually succeeded for this keyword (serpChecked)
    // -- omitted entirely rather than sent as an empty array, so the
    // model can tell "checked, found nothing" apart from "not checked" (see
    // SYSTEM_PROMPT's instruction to say "unknown" rather than guess when
    // this is absent).
    ...(o.serpChecked ? { serp_top_domains: o.serpTopDomains || [] } : {})
  }))

  const userPayload = JSON.stringify({ client_context: clientContext, candidate_keywords: candidates }, null, 2)

  const { result, error } = await callAnthropicTool({
    system: SYSTEM_PROMPT,
    user: userPayload,
    tool: RELEVANCE_TOOL,
    apiKey
  })

  if (error || !result || !Array.isArray(result.classifications)) {
    const message = error ? error.message : 'No classifications returned.'
    return keywordOpportunities.map(o => ({ ...o, llmRefined: false, llmError: message }))
  }

  const byKeyword = new Map(
    result.classifications
      .filter(c => c && typeof c.keyword === 'string')
      .map(c => [c.keyword.toLowerCase().trim(), c])
  )

  return keywordOpportunities
    .map(o => {
      const c = byKeyword.get(String(o.keyword || '').toLowerCase().trim())
      if (!c) return { ...o, llmRefined: false, llmError: 'Model did not return a classification for this keyword.' }
      return {
        ...o,
        llmRefined: true,
        relevant: c.relevant !== false,
        relevanceReason: c.relevance_reason || null,
        funnelStage: c.funnel_stage || null,
        geoRecommendation: c.geo_recommendation || 'none',
        suggestedLocalVariant: c.suggested_local_variant || null,
        serpLandscape: c.serp_landscape || 'unknown',
        realisticTier: c.realistic_tier || null,
        tierReason: c.tier_reason || null
      }
    })
    // Only ever drops an item the model actively classified as NOT
    // relevant -- anything it failed to classify (llmRefined: false)
    // stays in, per this function's header.
    .filter(o => o.llmRefined === false || o.relevant !== false)
}

module.exports = { refineKeywordOpportunities, RELEVANCE_TOOL }
