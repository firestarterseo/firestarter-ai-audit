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
//
// Deterministic realistic_tier (added 2026-08-15, see
// computeRealisticTier below): a fair complaint from Skyler on the same
// day the SERP-landscape/domain-rating fixes shipped -- even with real
// SERP domains and a real client domain rating, realistic_tier was still
// an LLM's judgment call, not something you could check. Ahrefs has a
// purpose-built metric for exactly this that this project wasn't using:
// Keyword Difficulty (see lib/keywordDifficulty.js), computed from the
// real backlink profiles of the pages currently ranking. Whenever both
// KD and the client's domain rating are available, this file now
// OVERRIDES whatever the LLM returned for realistic_tier with a real
// calculation, and rewrites tier_reason to cite the actual numbers --
// the LLM still owns relevance/funnel-stage/serp_landscape (those
// genuinely need judgment/world-knowledge a raw number can't provide),
// but the near_term-vs-aspirational call itself is now math, not a
// guess, whenever the real data exists. Falls back to the LLM's own
// tier/reason (unchanged prior behavior) only when KD or domain rating
// is unavailable.

const { callAnthropicTool } = require('./llm/anthropic')

// ASPIRATIONAL_GAP_THRESHOLD: if Ahrefs' real Keyword Difficulty exceeds
// the client's own real domain rating by more than this many points, the
// term is aspirational; otherwise near_term. Both KD and domain rating
// are the same 0-100 scale, so a direct point-gap comparison is
// meaningful. This is a STARTING heuristic (roughly matching the common
// SEO rule of thumb that a realistic ranking shot needs your DR within
// ~10-20 points of KD), not settled science -- it's a real, visible,
// adjustable number Skyler can tune against actual outcomes over time,
// which is the whole point: not a black-box LLM read of brand names.
const ASPIRATIONAL_GAP_THRESHOLD = 15

// computeRealisticTier({ keywordDifficulty, clientDomainRating }) ->
// 'near_term' | 'aspirational' | null (null = insufficient real data,
// caller should fall back to the LLM's own guess).
function computeRealisticTier({ keywordDifficulty, clientDomainRating }) {
  if (typeof keywordDifficulty !== 'number' || typeof clientDomainRating !== 'number') return null
  const gap = keywordDifficulty - clientDomainRating
  return gap > ASPIRATIONAL_GAP_THRESHOLD ? 'aspirational' : 'near_term'
}

// formatComputedTierReason(...) -> a tier_reason string that cites the
// real numbers, replacing whatever text the LLM wrote (which was judging
// a tier we're about to override anyway -- showing the LLM's original
// reasoning next to a DIFFERENT computed tier would just recreate the
// exact "label contradicts its own reasoning" bug found earlier today).
function formatComputedTierReason({ keywordDifficulty, clientDomainRating, tier, suggestedLocalVariant }) {
  const gap = Math.round((keywordDifficulty - clientDomainRating) * 10) / 10
  const gapDescriptor = gap === 1 || gap === -1 ? 'point' : 'points'
  const base = `Ahrefs Keyword Difficulty is ${keywordDifficulty}/100 vs. your domain rating of ${clientDomainRating}/100 (gap of ${gap} ${gapDescriptor}).`
  const verdict = tier === 'near_term'
    ? ' Within realistic reach with focused content effort.'
    : ' The authority gap makes this a longer-term target.'
  // Honest limitation: KD is only measured for the exact keyword given --
  // Ahrefs has no volume/difficulty data for a variant this tool invented,
  // so this can't also claim the local variant is independently easier,
  // only that it wasn't measured.
  const variantNote = suggestedLocalVariant
    ? ` (Reflects the exact keyword as given -- "${suggestedLocalVariant}" would likely be easier but its difficulty wasn't independently measured.)`
    : ''
  return base + verdict + variantNote
}

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
              description: 'Who actually holds the top Google results for this exact keyword. Ignore any domain that also appears in serp_known_non_competitor_domains when making this call -- those are directories, review platforms, or press/agency-listing pages (e.g. Clutch, G2, a SEMrush or Built In directory subdomain), not real competing businesses, and count as evidence of neither landscape. "peer_agency_competitive" when the REMAINING top results are businesses structurally similar to this client (other agencies, local competitors) -- a real, buildable content gap. "publisher_dominated" when the remaining top results are large media/reference publishers (e.g. Search Engine Journal, SEMrush, HubSpot, Moz, WordStream, Healthline, NerdWallet -- whatever is standard for this client\'s industry) with far more domain authority than any peer competitor -- ranking #1 there is not a realistic content play regardless of effort; the real move is earning a citation/mention INSIDE that publisher\'s content, not out-ranking it. "mixed" when both appear. "unknown" ONLY when serp_top_domains was not provided for this keyword (Cloro check unavailable) -- in that case, infer as best you can from competitor_domain alone and say so in tier_reason, but prefer "unknown" over guessing confidently with no real evidence.'
            },
            realistic_tier: {
              type: 'string',
              enum: ['near_term', 'aspirational', 'citation_target'],
              description: 'CRITICAL: judge whichever SPECIFIC query you are actually recommending the client pursue, not the broad head term by default. If geo_recommendation is "suggest_local_variant", realistic_tier and tier_reason must describe suggested_local_variant\'s winnability (the narrower, local query) -- NOT the national head term\'s. The mere existence of a plausible local variant does NOT make the unmodified national term near_term; if a well-known, well-funded, nationally-recognized agency or brand (e.g. a company you\'d recognize as a large, established player, not a small local shop) holds a top position for the UNMODIFIED term in serp_top_domains, that specific unmodified term is aspirational regardless of how easy the local variant would be. "near_term": winnable with realistic content effort given the actual authority/resource gap to the real competing domains in serp_top_domains (excluding anything in serp_known_non_competitor_domains, which are directories/aggregators, not real competitors) -- only applies when serp_landscape is peer_agency_competitive or mixed. "aspirational": the gap to the real competing businesses shown makes ranking (for whichever specific query is being judged) a long-shot, but it is still fundamentally a ranking/content play. "citation_target": serp_landscape is publisher_dominated -- the realistic path is getting mentioned/cited/quoted inside the dominant publisher\'s existing content, not writing a page to out-rank it.'
            },
            tier_reason: { type: 'string', description: 'One sentence, naming which exact query (the original keyword, or the suggested_local_variant if one was proposed) this tier applies to, and why -- e.g. \'"seo agency" nationally is aspirational (Coalition Technologies, Thrive Agency, and other well-funded national players hold the top spots); "seo agency Denver" is a realistic near-term target instead.\' If serp_landscape is publisher_dominated, name which kind of publisher (e.g. "dominated by SEO/marketing media sites like Search Engine Journal and SEMrush") and suggest the citation angle instead of a ranking angle.' }
          },
          required: ['keyword', 'relevant', 'relevance_reason', 'funnel_stage', 'geo_recommendation', 'serp_landscape', 'realistic_tier', 'tier_reason']
        }
      }
    },
    required: ['classifications']
  }
}

const SYSTEM_PROMPT = `You are a senior local/regional SEO strategist reviewing candidate keyword opportunities for a client business. You will be given the client's business context and a list of keywords a tracked competitor ranks well for that the client does not rank for at all. Each candidate may also include serp_top_domains -- the REAL, live top Google results for that exact keyword (from a direct search, not a guess) -- and serp_known_non_competitor_domains, the subset of those that are directories/aggregators/review platforms rather than real businesses, when that data was available. Judge each keyword on its own merits -- a high-volume keyword a competitor ranks for is NOT automatically relevant or realistically winnable for this client, and the tracked competitor's own position is NOT the whole picture: many informational/top-of-funnel keywords are actually dominated by large media/reference publishers that aren't even the tracked competitor. When serp_top_domains is present, ground your serp_landscape judgment in those actual domains (minus anything in serp_known_non_competitor_domains) rather than guessing from the competitor's brand name alone; when it's absent, say so and use "unknown" rather than presenting a guess as certain.

Be especially careful with realistic_tier: judge whichever specific query you are actually recommending, not the broad head term by default. If you suggest a local variant (geo_recommendation: suggest_local_variant), realistic_tier/tier_reason must describe THAT variant's realism, not the unmodified national term's -- a plausible local variant existing does not make the national term near_term. If serp_top_domains for the unmodified term includes a well-known, well-funded, nationally-established agency or brand, the unmodified term is aspirational (or citation_target/publisher_dominated), full stop, regardless of how winnable a narrower local version would be. Do not let "there's an easier variant" become an excuse to rate the harder term as achievable.

Be skeptical of generic head terms and off-topic matches. Return a classification for every candidate keyword given, in the same order.`

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
    ...(o.serpChecked ? {
      serp_top_domains: o.serpTopDomains || [],
      // Real fix for a bug caught 2026-08-15 on a live run: without this,
      // the model counted directory/aggregator pages that happen to rank
      // (clutch.co, agencies.semrush.com) as if they were real competing
      // agencies, inflating how "peer_agency_competitive" a term looked.
      // lib/serpLandscape.js already computes this via the existing
      // lib/nonCompetitorDomains.js list -- it just wasn't being sent.
      serp_known_non_competitor_domains: o.serpKnownNonCompetitorDomains || []
    } : {}),
    // Populated by lib/keywordDifficulty.js's annotateWithKeywordDifficulty,
    // called BEFORE this function in lib/runAudit.js. Given to the model
    // for context/its own reasoning, but the FINAL realistic_tier choice
    // gets overridden below by computeRealisticTier whenever this and
    // client_context.client_domain_rating are both real numbers -- see
    // this file's header.
    ...(o.keywordDifficultyChecked ? { keyword_difficulty: o.keywordDifficulty } : {})
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

      const serpLandscape = c.serp_landscape || 'unknown'
      // Deterministic override -- skip only when serp_landscape is
      // publisher_dominated (citation_target is about WHO to target, not
      // how hard ranking is, so KD/DR math doesn't apply there) or when
      // real KD/domain-rating data isn't available, in which case this is
      // null and the LLM's own guess is used unchanged (prior behavior).
      const computedTier = serpLandscape === 'publisher_dominated'
        ? null
        : computeRealisticTier({ keywordDifficulty: o.keywordDifficulty, clientDomainRating: clientContext.client_domain_rating })
      const realisticTier = computedTier || c.realistic_tier || null
      const tierReason = computedTier
        ? formatComputedTierReason({
            keywordDifficulty: o.keywordDifficulty,
            clientDomainRating: clientContext.client_domain_rating,
            tier: computedTier,
            suggestedLocalVariant: c.suggested_local_variant || null
          })
        : (c.tier_reason || null)

      return {
        ...o,
        llmRefined: true,
        relevant: c.relevant !== false,
        relevanceReason: c.relevance_reason || null,
        funnelStage: c.funnel_stage || null,
        geoRecommendation: c.geo_recommendation || 'none',
        suggestedLocalVariant: c.suggested_local_variant || null,
        serpLandscape,
        realisticTier,
        tierReason,
        // Transparency flag for the UI -- 'computed' means realisticTier
        // came from the real KD-vs-domain-rating formula above, not an
        // LLM guess. Surfaced directly so a strategist can tell the two
        // apart at a glance rather than trusting silently.
        tierSource: computedTier ? 'computed' : 'llm_judgment'
      }
    })
    // Only ever drops an item the model actively classified as NOT
    // relevant -- anything it failed to classify (llmRefined: false)
    // stays in, per this function's header.
    .filter(o => o.llmRefined === false || o.relevant !== false)
}

module.exports = { refineKeywordOpportunities, RELEVANCE_TOOL, computeRealisticTier, ASPIRATIONAL_GAP_THRESHOLD }
