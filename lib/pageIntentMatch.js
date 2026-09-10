// INTENT-AWARE PAGE MATCHING -- added 2026-09-11 to lib/promptGapAnalysis.js's
// client-page discovery, per live-validation feedback: literal keyword/title
// overlap is not the same as intent match. Real example that motivated this
// (JDI Windows, "replacement windows denver"): the highest token-overlap
// client page was "How To Measure Your Windows For Replacement: The
// Complete Denver Homeowner's Guide" -- shares every key term, but is an
// informational how-to article, not a commercial service page a customer
// would convert on. The old token-overlap-only selection would have picked
// it anyway.
//
// Same layering convention as lib/keywordRelevance.js (the project's other
// LLM-judgment module, see that file's own header): a real, deterministic,
// ALWAYS-AVAILABLE heuristic layer first (classifyPromptIntentHeuristic,
// heuristicPageFit -- pure, no network, no API key needed), refined by one
// Anthropic call (lib/llm/anthropic.js -- same provider/wrapper, same
// forced-tool-use contract) when ANTHROPIC_API_KEY is configured. Fails
// safe on ANY failure (missing key, network error, malformed response) by
// falling back to the heuristic layer's own judgment -- never blocks the
// rest of the prompt-gap analysis, same "a judgment layer hiccupping should
// never take down a deterministic run" principle as keywordRelevance.js.

const { callAnthropicTool } = require('./llm/anthropic')

const INTENT_TYPES = [
  'local_commercial_service', 'product_service_category', 'comparison',
  'pricing', 'informational_how_to', 'reputation_best_provider', 'other'
]

// ---------------------------------------------------------------------
// PURE, DETERMINISTIC LAYER -- always available, zero cost.
// ---------------------------------------------------------------------

// classifyPromptIntentHeuristic(promptText) -> {intent, reason}. Pattern-
// based, not semantic -- this is the honest baseline every prompt gets
// regardless of whether Anthropic is configured, not a replacement for
// real judgment. Order matters: more specific signals (comparison/pricing/
// how-to/reputation) are checked before the generic local-service/category
// fallback.
function classifyPromptIntentHeuristic(promptText) {
  const t = String(promptText || '').toLowerCase()
  if (/\bvs\.?\b|\bversus\b|\bcompared? to\b|\bcomparison\b/.test(t)) {
    return { intent: 'comparison', reason: 'Contains a comparison term ("vs"/"versus"/"compare").' }
  }
  if (/\bprice(s|d|ing)?\b|\bcost(s)?\b|\bhow much\b|\bcheap(est)?\b|\bquote\b/.test(t)) {
    return { intent: 'pricing', reason: 'Contains a pricing/cost term.' }
  }
  if (/\bhow (to|do|does|can)\b|\bguide\b|\bwhat is\b|\btips\b|\bmeasure\b|\bdiy\b|\bsteps\b/.test(t)) {
    return { intent: 'informational_how_to', reason: 'Contains an informational/how-to phrasing.' }
  }
  if (/\bbest\b|\btop\b|\brated\b|\breview(s)?\b|\brecommended\b/.test(t)) {
    return { intent: 'reputation_best_provider', reason: 'Contains a "best/top/rated/reviews" phrasing.' }
  }
  if (/\b(denver|littleton|colorado|co)\b/.test(t) && /\b(compan(y|ies)|near me|contractor|service|install(er|ers)?)\b/.test(t)) {
    return { intent: 'local_commercial_service', reason: 'Combines a location term with a business/service noun.' }
  }
  if (/\b(denver|littleton|colorado)\b/.test(t)) {
    return { intent: 'local_commercial_service', reason: 'Contains a location term -- defaulting to local-service intent.' }
  }
  return { intent: 'product_service_category', reason: 'No comparison/pricing/how-to/reputation/location signal found -- defaulting to a general product/service category intent.' }
}

function safePathFromUrl(url) {
  try { return new URL(url).pathname || '/' } catch (e) { return url || '' }
}

const HOWTO_SLUG_PATTERN = /how-to|\bguide\b|measure|\btips\b|\blearn\b|what-is|checklist|steps/i
const PRICING_SLUG_PATTERN = /\bprice|pricing|\bcost\b|quote/i
const COMPARISON_SLUG_PATTERN = /-vs-|versus|compare/i

// heuristicPageFit(candidate, intent, index) -> the fallback per-candidate
// judgment used ONLY when Anthropic is unavailable/fails. Combines the
// URL-slug pattern with the real page-type classification
// lib/sitemapDiscovery.js already computed (candidate.type, e.g. 'Article'
// strongly suggests an informational page, 'Service'/'Location'/'Landing
// Page'/'Product' suggest a commercial page) -- free, already-computed
// signal -- plus the page's REAL fetched title/h1 when the caller already
// has it (candidate.title/candidate.h1), which is a much stronger signal
// than the URL slug alone and is checked the same way. Deliberately
// conservative: match_confidence is always 'low' here, since this is a
// pattern fallback, not real judgment.
function heuristicPageFit(candidate, intent, index) {
  const path = candidate.path || safePathFromUrl(candidate.url)
  const type = candidate.type || null
  const textSignal = `${path} ${candidate.title || ''} ${candidate.h1 || ''}`
  const looksHowTo = HOWTO_SLUG_PATTERN.test(textSignal) || type === 'Article' || type === 'Case Study'
  const looksPricing = PRICING_SLUG_PATTERN.test(textSignal)
  const looksComparison = COMPARISON_SLUG_PATTERN.test(textSignal)
  const looksCommercial = type === 'Service' || type === 'Location' || type === 'Landing Page' || type === 'Product'

  let pageType
  if (looksHowTo) pageType = 'how-to / informational article'
  else if (looksPricing) pageType = 'pricing page'
  else if (looksComparison) pageType = 'comparison page'
  else if (path === '/' || type === 'Home') pageType = 'homepage'
  else if (looksCommercial) pageType = 'commercial service/location page'
  else pageType = 'other page'

  let satisfiesIntent
  if (intent === 'informational_how_to') satisfiesIntent = looksHowTo
  else if (intent === 'pricing') satisfiesIntent = looksPricing
  else if (intent === 'comparison') satisfiesIntent = looksComparison
  else satisfiesIntent = !looksHowTo // local_commercial_service / product_service_category / reputation_best_provider / other: conservatively require a non-how-to page

  return {
    index, url: candidate.url, page_type: pageType, satisfies_intent: satisfiesIntent,
    match_confidence: 'low',
    reason: `Heuristic URL/page-type fallback (Anthropic unavailable) -- classified as "${pageType}" from the URL slug${type ? ` and page type "${type}"` : ''}, not real judgment.`
  }
}

// ---------------------------------------------------------------------
// LLM REFINEMENT LAYER
// ---------------------------------------------------------------------

const PAGE_INTENT_TOOL = {
  name: 'classify_prompt_intent_and_page_fit',
  description: 'Classify the search intent behind a prompt, then judge whether the competitor page and each candidate client page actually satisfy that intent.',
  input_schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: INTENT_TYPES },
      intent_reason: { type: 'string', description: 'One sentence.' },
      competitor_page: {
        type: 'object',
        properties: {
          page_type: { type: 'string', description: 'Short label, e.g. "commercial service page", "how-to article", "category page", "homepage".' },
          satisfies_intent: { type: 'boolean' },
          reason: { type: 'string' }
        },
        required: ['page_type', 'satisfies_intent', 'reason']
      },
      client_candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            page_type: { type: 'string' },
            satisfies_intent: { type: 'boolean' },
            match_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            reason: { type: 'string' }
          },
          required: ['index', 'page_type', 'satisfies_intent', 'match_confidence', 'reason']
        }
      },
      best_client_candidate_index: {
        type: ['integer', 'null'],
        description: 'Index (from client_candidates) of the single best client page that genuinely satisfies the intent, or null if none of them do -- even if one has strong keyword overlap.'
      }
    },
    required: ['intent', 'intent_reason', 'competitor_page', 'client_candidates', 'best_client_candidate_index']
  }
}

const SYSTEM_PROMPT = `You are a local SEO strategist judging whether specific web pages actually satisfy the intent behind a search prompt. You will be given the prompt text, a heuristic first guess at its intent, the competitor's page (the one an AI engine actually cited as the reason it's winning this prompt), and a short list of candidate pages from the client's own site (from their sitemap, ranked by keyword overlap with the prompt -- NOT by whether they're actually relevant).

Judge intent as one of: local_commercial_service (a page selling/offering the service in a specific place), product_service_category (a general page about the product/service, not location-specific), comparison, pricing, informational_how_to (a guide/article, not a page trying to sell the service), reputation_best_provider (a "best of"/ranking/review-style query), other.

CRITICAL: literal keyword overlap is NOT the same as intent match. A page can share every word in the prompt and still be the wrong page -- e.g. for "replacement windows denver" (a local_commercial_service prompt), an article titled "How To Measure Your Windows For Replacement: The Complete Denver Homeowner's Guide" shares all three key terms but is an informational how-to guide, not a commercial service page a customer would actually convert on. That page does NOT satisfy the intent, even though its title overlaps almost perfectly. Judge based on what kind of page each URL/title/path actually represents, not on term overlap.

For each candidate client page, decide page_type (a short label), whether it satisfies_intent, a match_confidence (high/medium/low), and a one-sentence reason naming what specifically makes it fit or not fit. Do the same for the competitor's page. Then pick best_client_candidate_index -- the single client candidate that most genuinely satisfies the classified intent -- or null if none of them do, even if one has high keyword overlap. Being honest that no good page exists is more useful than picking a technically-overlapping but wrong page.`

// evaluatePageIntentMatch({promptText, competitorPage, candidates, apiKey}) ->
//   { intent, intentReason, intentSource: 'llm'|'heuristic', competitorEval,
//     candidateEvaluations, bestIndex, llmUsed, llmError? }
// `candidates`: [{url, path, type?, source: 'serp'|'sitemap'}]. Never
// throws; degrades to the heuristic layer on any failure.
async function evaluatePageIntentMatch({ promptText, competitorPage, candidates, apiKey } = {}) {
  const heuristic = classifyPromptIntentHeuristic(promptText)

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { intent: heuristic.intent, intentReason: heuristic.reason, intentSource: 'heuristic', competitorEval: null, candidateEvaluations: [], bestIndex: null, llmUsed: false }
  }

  function fallback(errorMessage) {
    const candidateEvaluations = candidates.map((c, i) => heuristicPageFit(c, heuristic.intent, i))
    const best = candidateEvaluations.find(e => e.satisfies_intent)
    const competitorEval = competitorPage
      ? heuristicPageFit({ url: competitorPage.url, path: safePathFromUrl(competitorPage.url), title: competitorPage.title, h1: competitorPage.h1 }, heuristic.intent, -1)
      : null
    return {
      intent: heuristic.intent, intentReason: heuristic.reason, intentSource: 'heuristic',
      competitorEval, candidateEvaluations, bestIndex: best ? best.index : null,
      llmUsed: false, ...(errorMessage ? { llmError: errorMessage } : {})
    }
  }

  if (!apiKey) return fallback('ANTHROPIC_API_KEY is not configured.')

  const payload = {
    prompt: promptText,
    heuristic_intent_guess: heuristic.intent,
    competitor_page: competitorPage ? { url: competitorPage.url, title: competitorPage.title, h1: competitorPage.h1 } : null,
    client_candidates: candidates.map((c, i) => ({
      index: i, url: c.url, path: c.path || safePathFromUrl(c.url), page_type_classification: c.type || null, source: c.source,
      // title/h1 are the page's REAL fetched content when the caller
      // already has it (see lib/promptGapAnalysis.js#discoverClientPage --
      // shortlisted sitemap candidates and any live-ranking page are now
      // fetched BEFORE this call, not judged from the URL alone).
      ...(c.title || c.h1 ? { title: c.title || null, h1: c.h1 || null } : {})
    }))
  }

  const { result, error } = await callAnthropicTool({ system: SYSTEM_PROMPT, user: JSON.stringify(payload, null, 2), tool: PAGE_INTENT_TOOL, apiKey })

  if (error || !result || !Array.isArray(result.client_candidates)) {
    return fallback(error ? error.message : 'No usable result returned.')
  }

  const candidateEvaluations = result.client_candidates
  const bestIndex = (typeof result.best_client_candidate_index === 'number' && candidateEvaluations.some(e => e.index === result.best_client_candidate_index))
    ? result.best_client_candidate_index
    : null

  return {
    intent: INTENT_TYPES.includes(result.intent) ? result.intent : heuristic.intent,
    intentReason: result.intent_reason || heuristic.reason,
    intentSource: 'llm',
    competitorEval: result.competitor_page || null,
    candidateEvaluations,
    bestIndex,
    llmUsed: true
  }
}

module.exports = {
  INTENT_TYPES, PAGE_INTENT_TOOL,
  classifyPromptIntentHeuristic, heuristicPageFit, safePathFromUrl,
  evaluatePageIntentMatch
}
