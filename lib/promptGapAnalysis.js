// PROMPT-LEVEL GAP ANALYSIS -- v1 rebuild (2026-09-10), corrected 2026-09-11
// after live validation against real JDI Windows data. Two rounds of fixes
// so far; see git history for the first round's header (multi-engine
// analysis, outcome states, sitemap-based page discovery, on-demand
// Third-Party Proof sync). This revision's changes, both from a SECOND
// round of live validation:
//
//   5. INTENT-AWARE PAGE MATCHING (lib/pageIntentMatch.js). The sitemap
//      fallback added in the first round picked the client page with the
//      highest literal token overlap against the prompt -- which is not
//      the same as the right page. Real example that exposed this: for
//      "replacement windows denver" (JDI Windows), the highest-overlap
//      client page was "How To Measure Your Windows For Replacement: The
//      Complete Denver Homeowner's Guide" -- shares every key term, but is
//      an informational how-to article, not a commercial page a customer
//      would convert on. discoverClientPage now classifies the prompt's
//      likely intent and asks (heuristically, refined by one Anthropic
//      call when configured -- same fail-safe pattern as
//      lib/keywordRelevance.js) whether each candidate page, AND the
//      competitor's own page, actually satisfies that intent, before
//      picking one. "No appropriate page exists" is now a distinct,
//      explicit outcome from "no page shares any keywords at all."
//   6. THIRD-PARTY PROOF VALIDATION. Previously every third-party hostname
//      cited in the same AI response as a losing competitor was treated as
//      evidence supporting that competitor, with no check that the source
//      actually said anything about them. verifyThirdPartyHostnames now
//      fetches each cited URL and checks whether the competitor is
//      actually mentioned or linked on that specific page (reusing
//      lib/citedPageInspection.js's own extractPageText/matchesClientEntity
//      -- the same bar this codebase already established for the symmetric
//      "is the client really on this page" question -- plus a new href-link
//      check, since the existing text-only check can't see a bare hyperlink
//      whose anchor text doesn't include the domain/name). A source that's
//      merely cited for unrelated information no longer counts as Third-
//      Party Proof; a source that can't be fetched/checked stays
//      insufficient_data rather than being silently kept or dropped either
//      way.
//
// COST NOTE (both additions add real, bounded, on-demand cost): intent
// matching adds one Anthropic call per analysis (never per-candidate).
// Third-party validation adds up to ~2 live page fetches per distinct
// third-party hostname (capped, bounded concurrency) -- on top of the
// competitor/client page fetches, 2 Ahrefs calls, 1 Cloro call, and the
// on-demand source-citation sync already in place. Still one prompt at a
// time, AM-triggered only -- see the module's original header for why this
// is never called in a loop.
//
//   7. CLIENT-PAGE SELECTION PRIORITY (2026-09-11, THIRD round of live
//      validation). Round 2's intent classifier judged every candidate --
//      including a page that was ACTUALLY RANKING live in Google for this
//      exact prompt -- from URL/path metadata alone, and could reject a
//      real ranking page as "too generic" without ever reading its
//      content. That's backwards: a live ranking is strong relevance
//      evidence on its own and must never be silently discarded in favor
//      of "no page exists." discoverClientPage now follows a strict
//      priority order: (1) a client page ranking live in the SERP is
//      fetched and inspected FIRST and is ALWAYS selected -- intent
//      judgment is descriptive evidence here (page type, whether it's
//      well-targeted), never a rejection gate; (2) only when nothing
//      ranks does it fall back to the sitemap, and even then only the top
//      MAX_SHORTLIST_CANDIDATES (2-3) pages are actually FETCHED (not just
//      guessed from their URL) before intent judgment runs against their
//      real title/h1. discoverClientPageAndPage's result is now one of
//      four honest states -- 'relevant_ranking_page',
//      'relevant_nonranking_page', 'no_relevant_page', 'uncertain' --
//      and 'uncertain' (sitemap unreachable, a ranking page that can't be
//      fetched, or a shortlist that all failed to fetch) is never treated
//      as a content gap: computeContentGap only ever recommends "create a
//      page" for the genuine no_relevant_page case, and rankGaps can never
//      pick 'content' as primary/secondary off an insufficient_data
//      result -- so page-matching uncertainty can no longer masquerade as
//      a content gap. A too-broad/poorly-targeted ranking page (e.g. a
//      generic homepage where a competitor has a location-specific page)
//      still surfaces as a real finding -- via the RELEVANCE dimension,
//      which already compares real title/h1 term overlap -- with an action
//      to improve the existing page, never to create a new one.

const { getSupabaseServerClient } = require('./supabaseServer')
const { hostnameOf, normalizeDomain } = require('./nonCompetitorDomains')
const { fetchWebPage } = require('./webPageFetch')
const { htmlToWordCount } = require('./checkers/content-checker')
const { parseJsonLd } = require('./checkers/lightweight-jsonld')
const { getAuthorityBacklinks } = require('./checkers/ahrefs')
const { defaultCloroCaller, extractEngineSignal } = require('./checkers/ai-visibility-snapshot-checker')
const { fetchSitemapPages } = require('./sitemapDiscovery')
const { syncClientSources } = require('./sourceCitation')
const { extractPageText, matchesClientEntity, runWithConcurrency } = require('./citedPageInspection')
const { evaluatePageIntentMatch, safePathFromUrl } = require('./pageIntentMatch')

const AI_RUNS_TABLE = 'ai_visibility_tracked_runs'
const COMPETITORS_TABLE = 'client_competitors'
const CLIENTS_TABLE = 'clients'
const SOURCES_TABLE = 'client_sources'
const GAP_TABLE = 'prompt_gap_analyses'

const MAX_TRACKED_ROWS = 500
const CLIENT_SOURCES_FRESHNESS_MS = 1000 * 60 * 60 * 24 * 14 // 14 days, matching lib/citedPageInspection.js's own staleness window
const MAX_SHORTLIST_CANDIDATES = 3
const MAX_URLS_PER_THIRD_PARTY_HOSTNAME = 2
const THIRD_PARTY_VERIFICATION_CONCURRENCY = 3

// Fixed order used only to make competitor-URL/evidence selection
// deterministic when more than one losing engine cited the same competitor
// domain -- not a ranking of engine importance.
const ENGINE_PRIORITY = ['chatgpt', 'google', 'gemini', 'perplexity']

// ---------------------------------------------------------------------
// PURE LOGIC -- no DB, no network. Each dimension always returns
// { status: 'gap' | 'no_gap' | 'insufficient_data', evidence: string[], ... }
// ---------------------------------------------------------------------

const STOPWORDS = new Set(['and', 'the', 'of', 'for', 'a', 'an', 'in', 'on', 'at', 'to', 'with', 'is', 'are', 'best', 'near', 'me'])
function tokenize(text) {
  return new Set(
    String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t))
  )
}
function overlapTerms(promptTokens, pageTokens) {
  return [...promptTokens].filter(t => pageTokens.has(t))
}

function extractTitleAndH1(html) {
  if (!html) return { title: null, h1: null }
  const stripTags = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  return {
    title: titleMatch ? stripTags(titleMatch[1]) || null : null,
    h1: h1Match ? stripTags(h1Match[1]) || null : null
  }
}

// bestEffortDomainName(domain) -> a readable label derived from the domain
// itself (e.g. "303windows.com" -> "303Windows"). Small, deliberate literal
// duplicate of lib/sourceCitation.js's own private bestEffortSourceName --
// that function isn't exported, and this codebase's own established
// convention (see e.g. ENGINE_WEIGHTS duplicated across checkers) is a
// small literal duplicate over a cross-module coupling for a few lines.
function bestEffortDomainName(domain) {
  if (!domain) return null
  const base = domain.replace(/\.[a-z.]+$/i, '').split('.').pop()
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : domain
}

// classifyEngineRow(row, competitorDomainSet) -> this ONE engine's own
// outcome for this ONE row: 'no_data' | 'no_signal' | 'win' | 'loss' | 'tie'.
// 'no_data' covers every case where this engine's own result can't honestly
// support any of the other four: a missing row, an errored call
// (row.ok === false or row.error set), or a null brand_mentioned (logged
// but inconclusive) -- never conflated with 'no_signal', which means the
// engine DID answer and genuinely named neither the client nor a tracked
// competitor.
function classifyEngineRow(row, competitorDomainSet) {
  if (!row) return { outcome: 'no_data', competitorHits: [], thirdPartyUrls: [] }
  if (row.ok === false || row.error) return { outcome: 'no_data', competitorHits: [], thirdPartyUrls: [] }

  const raw = row.raw || {}
  const ownUrls = Array.isArray(raw.ownDomainSourceUrls) ? raw.ownDomainSourceUrls : []
  const allUrls = Array.isArray(raw.sourceUrls) ? raw.sourceUrls : []
  const thirdPartyUrls = Array.isArray(raw.thirdPartySourceUrls) ? raw.thirdPartySourceUrls : allUrls.filter(u => !ownUrls.includes(u))

  const competitorHits = []
  const seenDomains = new Set()
  for (const url of thirdPartyUrls) {
    const domain = hostnameOf(url)
    if (domain && competitorDomainSet.has(domain) && !seenDomains.has(domain)) {
      seenDomains.add(domain)
      competitorHits.push({ domain, url })
    }
  }

  if (row.brand_mentioned == null) return { outcome: 'no_data', competitorHits, thirdPartyUrls }

  const mentioned = !!row.brand_mentioned
  let outcome
  if (mentioned && competitorHits.length === 0) outcome = 'win'
  else if (mentioned && competitorHits.length > 0) outcome = 'tie'
  else if (!mentioned && competitorHits.length > 0) outcome = 'loss'
  else outcome = 'no_signal'
  return { outcome, competitorHits, thirdPartyUrls }
}

// classifyPromptOutcome(rows, promptText, competitorDomainSet) -> the FULL
// per-engine breakdown for the most recent tracked run batch matching this
// exact prompt text, plus the prompt-level aggregate status.
//
//   status: 'NO_DATA' | 'NO_SIGNAL' | 'WIN' | 'LOSS' | 'TIE' | 'MIXED'
//   engineOutcomes: { [engine]: 'NO_DATA'|'NO_SIGNAL'|'WIN'|'LOSS'|'TIE' }
//   losingEngines: [{ engine, competitorHits, thirdPartyUrls }] -- every
//     engine (in this same batch) classified as a LOSS, pooled together.
//   competitorTally: [{ domain, count, urls: Set, engines: Set }], ranked by
//     how many losing engines cited that domain (ties broken alphabetically).
function classifyPromptOutcome(rows, promptText, competitorDomainSet) {
  const matching = (rows || []).filter(r => r && r.raw && r.raw.prompt === promptText)
  if (matching.length === 0) {
    return { status: 'NO_DATA', latestRunAt: null, engineOutcomes: {}, engineDetail: {}, losingEngines: [], competitorTally: [] }
  }

  const latestRunAt = matching.reduce((max, r) => (!max || (r.run_at && new Date(r.run_at) > new Date(max))) ? r.run_at : max, null)
  const batchRows = matching.filter(r => r.run_at === latestRunAt)

  const engineDetail = {}
  for (const row of batchRows) {
    engineDetail[row.engine] = classifyEngineRow(row, competitorDomainSet)
  }
  const engineOutcomes = {}
  for (const [engine, detail] of Object.entries(engineDetail)) {
    engineOutcomes[engine] = detail.outcome.toUpperCase()
  }

  const realOutcomes = Object.values(engineDetail).map(d => d.outcome).filter(o => o !== 'no_data')
  let status
  if (realOutcomes.length === 0) {
    status = 'NO_DATA' // every engine in this batch failed/errored/inconclusive, even though the batch itself is real
  } else {
    const distinct = new Set(realOutcomes)
    status = distinct.size === 1 ? [...distinct][0].toUpperCase() : 'MIXED'
  }

  const losingEngines = Object.entries(engineDetail)
    .filter(([, d]) => d.outcome === 'loss')
    .map(([engine, d]) => ({ engine, competitorHits: d.competitorHits, thirdPartyUrls: d.thirdPartyUrls }))

  const tally = new Map()
  for (const { engine, competitorHits } of losingEngines) {
    for (const hit of competitorHits) {
      if (!tally.has(hit.domain)) tally.set(hit.domain, { domain: hit.domain, count: 0, urls: new Set(), engines: new Set() })
      const t = tally.get(hit.domain)
      t.count += 1
      t.urls.add(hit.url)
      t.engines.add(engine)
    }
  }
  const competitorTally = [...tally.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))

  return { status, latestRunAt, engineOutcomes, engineDetail, losingEngines, competitorTally }
}

// pickUrlForDomain(losingEngines, domain) -> {url, engine} | null.
// Deterministic: prefers whichever engine in ENGINE_PRIORITY order actually
// cited this domain, rather than an arbitrary Set-iteration order.
function pickUrlForDomain(losingEngines, domain) {
  const byEngine = new Map(losingEngines.map(l => [l.engine, l]))
  for (const engine of ENGINE_PRIORITY) {
    const entry = byEngine.get(engine)
    if (!entry) continue
    const hit = entry.competitorHits.find(h => h.domain === domain)
    if (hit) return { url: hit.url, engine }
  }
  for (const { engine, competitorHits } of losingEngines) {
    const hit = competitorHits.find(h => h.domain === domain)
    if (hit) return { url: hit.url, engine }
  }
  return null
}

function formatEngineOutcomes(engineOutcomes) {
  const entries = Object.entries(engineOutcomes)
  if (entries.length === 0) return 'no engines produced a usable result in the latest tracked run.'
  return entries.map(([engine, outcome]) => `${engine}=${outcome}`).join(', ')
}

// UNCERTAIN_REASON_TEXT -- computeContentGap must never assert "no page
// exists" (status: 'gap') for any of these; per explicit product direction,
// genuine matching uncertainty stays insufficient_data, so it can never be
// picked as primary/secondary by rankGaps and can never trigger a
// "create a page" recommendation.
const UNCERTAIN_REASON_TEXT = {
  ranks_but_unfetchable: 'A client page ranks live in a Google search for this exact prompt, but could not be fetched to inspect its content -- treated as unresolved, never as "no page."',
  sitemap_unreachable: 'Could not check the client\'s own site inventory (sitemap unreachable or unrecognized) to confirm whether a relevant page exists -- not treated as "no page."',
  candidates_unfetchable: 'The client\'s sitemap listed candidate pages for this prompt, but none of the shortlisted candidates could be fetched to inspect -- not treated as "no page."'
}

// computeContentGap({competitorPage, clientPage, clientPageDiscovery}) -> the
// "competitor page most relevant to this exact prompt" comparison.
// clientPageDiscovery.status is one of 'relevant_ranking_page' |
// 'relevant_nonranking_page' | 'no_relevant_page' | 'uncertain' (see
// discoverClientPage) -- 'uncertain' is ALWAYS insufficient_data here,
// never a gap, per explicit product direction (page-matching uncertainty
// must never masquerade as a content gap). "Create a page" is only ever
// reachable through the genuine no_relevant_page case.
function computeContentGap({ competitorPage, clientPage, clientPageDiscovery }) {
  if (!competitorPage || competitorPage.fetchFailed) {
    return { status: 'insufficient_data', evidence: ['Could not fetch the competitor page cited in the AI response.'], competitorWordCount: null, clientWordCount: null, clientPageStatus: clientPageDiscovery ? clientPageDiscovery.status : null }
  }
  const discoveryStatus = clientPageDiscovery ? clientPageDiscovery.status : 'uncertain'
  const intentLine = clientPageDiscovery && clientPageDiscovery.intent
    ? `Classified prompt intent: ${clientPageDiscovery.intent} (${clientPageDiscovery.intentReason}; ${clientPageDiscovery.intentSource === 'llm' ? 'Anthropic-judged' : 'heuristic fallback'}).`
    : null

  if (discoveryStatus === 'uncertain') {
    const reasonText = UNCERTAIN_REASON_TEXT[clientPageDiscovery && clientPageDiscovery.uncertainReason] || 'Could not confirm whether a relevant client page exists for this prompt.'
    return {
      status: 'insufficient_data',
      evidence: [`Competitor page (${competitorPage.url}) is ${competitorPage.wordCount} words.`, reasonText],
      competitorWordCount: competitorPage.wordCount, clientWordCount: null, clientPageStatus: discoveryStatus
    }
  }

  if (!clientPage) {
    // discoveryStatus === 'no_relevant_page' -- two distinct sub-reasons:
    // literally no candidate shared any keywords, or candidates were
    // fetched and inspected but NONE actually satisfied the classified
    // intent -- worded honestly differently. This is the ONLY discovery
    // status that ever produces a real content gap / "create a page."
    const reasonLine = clientPageDiscovery && clientPageDiscovery.noPageReason === 'no_candidate_satisfies_intent'
      ? `${clientPageDiscovery.candidatesConsidered || 0} client page(s) shared keywords with this prompt and were fetched/inspected, but none actually satisfy the classified intent (${clientPageDiscovery.intent}) -- no appropriate client page exists for this prompt, even though keyword-overlapping pages exist.`
      : 'No relevant page was found for this client in a live search OR in the client\'s own sitemap/page inventory -- the client has no equivalent page at all.'
    return {
      status: 'gap',
      evidence: [`Competitor page (${competitorPage.url}) is ${competitorPage.wordCount} words.`, ...(intentLine ? [intentLine] : []), reasonLine],
      competitorWordCount: competitorPage.wordCount, clientWordCount: null, clientPageStatus: discoveryStatus, noPageReason: clientPageDiscovery ? clientPageDiscovery.noPageReason : null
    }
  }

  const gapExists = competitorPage.wordCount > clientPage.wordCount * 1.3 && (competitorPage.wordCount - clientPage.wordCount) > 150
  const selectionLine = clientPageDiscovery
    ? `Selected as a "${clientPageDiscovery.pageType || 'candidate'}" page (match confidence: ${clientPageDiscovery.matchConfidence || 'unknown'}, ${clientPageDiscovery.intentSource === 'llm' ? 'Anthropic-judged' : 'heuristic fallback'}) -- ${clientPageDiscovery.selectionReason || 'no reason recorded.'}`
    : null
  const clientLine = discoveryStatus === 'relevant_ranking_page'
    ? `Client page (${clientPage.url}) RANKS live in a Google search for this exact prompt: ${clientPage.wordCount} words.`
    : `Client page (${clientPage.url}) exists but is not ranking for this prompt in a live search right now: ${clientPage.wordCount} words.`
  return {
    status: gapExists ? 'gap' : 'no_gap',
    evidence: [`Competitor page (${competitorPage.url}): ${competitorPage.wordCount} words.`, ...(intentLine ? [intentLine] : []), clientLine, ...(selectionLine ? [selectionLine] : [])],
    competitorWordCount: competitorPage.wordCount, clientWordCount: clientPage.wordCount, clientPageStatus: discoveryStatus
  }
}

function computeRelevanceGap({ promptText, competitorPage, clientPage }) {
  if (!competitorPage || competitorPage.fetchFailed) {
    return { status: 'insufficient_data', evidence: ['Could not fetch the competitor page to check title/heading relevance.'] }
  }
  if (!clientPage || clientPage.fetchFailed) {
    return { status: 'insufficient_data', evidence: ['No fetchable client page exists to compare relevance against.'] }
  }
  const promptTokens = tokenize(promptText)
  const competitorTokens = tokenize(`${competitorPage.title || ''} ${competitorPage.h1 || ''}`)
  const clientTokens = tokenize(`${clientPage.title || ''} ${clientPage.h1 || ''}`)
  const competitorMatches = overlapTerms(promptTokens, competitorTokens)
  const clientMatches = overlapTerms(promptTokens, clientTokens)

  if (competitorMatches.length > clientMatches.length) {
    return {
      status: 'gap',
      evidence: [
        `Competitor title/heading matches prompt terms: ${competitorMatches.join(', ') || '(none)'}.`,
        `Client title/heading matches prompt terms: ${clientMatches.join(', ') || '(none)'}.`
      ],
      competitorMatchedTerms: competitorMatches, clientMatchedTerms: clientMatches
    }
  }
  return {
    status: 'no_gap',
    evidence: [`Client title/heading matches the same or more of this prompt's key terms (client: ${clientMatches.join(', ') || 'none'}; competitor: ${competitorMatches.join(', ') || 'none'}).`],
    competitorMatchedTerms: competitorMatches, clientMatchedTerms: clientMatches
  }
}

function computeTechnicalGap({ competitorPage, clientPage }) {
  if (!competitorPage || competitorPage.fetchFailed) {
    return { status: 'insufficient_data', evidence: ['Could not fetch the competitor page to check for structured data.'] }
  }
  if (!clientPage || clientPage.fetchFailed) {
    return { status: 'insufficient_data', evidence: ['No fetchable client page exists to check for structured data.'] }
  }
  const competitorSchema = parseJsonLd(competitorPage.html || '')
  const clientSchema = parseJsonLd(clientPage.html || '')
  const competitorHasSchema = competitorSchema.nodes.length > 0
  const clientHasSchema = clientSchema.nodes.length > 0

  if (competitorHasSchema && !clientHasSchema) {
    return {
      status: 'gap',
      evidence: [`Competitor page has JSON-LD structured data (${competitorSchema.schemaNames.join(', ')}).`, 'Client page has no JSON-LD structured data.']
    }
  }
  return {
    status: 'no_gap',
    evidence: [
      `Competitor page schema: ${competitorHasSchema ? competitorSchema.schemaNames.join(', ') : 'none'}.`,
      `Client page schema: ${clientHasSchema ? clientSchema.schemaNames.join(', ') : 'none'}.`
    ]
  }
}

function computeAuthorityGap({ clientAuthority, competitorAuthority }) {
  if (!clientAuthority || clientAuthority.error || !competitorAuthority || competitorAuthority.error) {
    return { status: 'insufficient_data', evidence: ['Authority-backlink data unavailable for the client and/or competitor domain (Ahrefs call failed or AHREFS_API_KEY not configured).'] }
  }
  const clientDomains = new Set((clientAuthority.authorityReferringDomains || []).map(d => d.domain))
  const competitorOnly = (competitorAuthority.authorityReferringDomains || []).filter(d => !clientDomains.has(d.domain))

  if (competitorOnly.length > 0) {
    return {
      status: 'gap',
      evidence: [`Competitor has recognized-authority backlinks the client does not: ${competitorOnly.map(d => d.domain).join(', ')}.`],
      competitorOnlyAuthorityDomains: competitorOnly.map(d => d.domain)
    }
  }
  return {
    status: 'no_gap',
    evidence: [`No recognized-authority domain links to the competitor that doesn't also link to the client (client: ${clientAuthority.authorityReferringDomains.length}, competitor: ${competitorAuthority.authorityReferringDomains.length}).`]
  }
}

// partitionThirdPartySources(inspections) -> {associated, excluded,
// insufficient}. Pure grouping of the real, per-hostname verification
// results built by verifyThirdPartyHostnames (I/O, below).
function partitionThirdPartySources(inspections) {
  const list = inspections || []
  return {
    associated: list.filter(i => i.status === 'verified_present'),
    excluded: list.filter(i => i.status === 'verified_absent'),
    insufficient: list.filter(i => i.status === 'insufficient_data')
  }
}

// computeThirdPartyGap({hostnameInspections, clientSourcesByDomain,
// sourcesEverSynced}) -> only hostnames VERIFIED to actually mention/link
// the winning competitor (hostnameInspections, from
// verifyThirdPartyHostnames) ever count as Third-Party Proof evidence. A
// hostname cited in the same AI response but verified to have no real
// association with the competitor is reported as explicitly EXCLUDED, not
// silently dropped -- and never counted as a gap.
function computeThirdPartyGap({ hostnameInspections, clientSourcesByDomain, sourcesEverSynced }) {
  if (!hostnameInspections || hostnameInspections.length === 0) {
    return { status: 'insufficient_data', evidence: ['No other third-party sources were cited alongside the competitor in the losing engine response(s).'] }
  }

  const { associated, excluded, insufficient } = partitionThirdPartySources(hostnameInspections)

  if (associated.length === 0) {
    const notes = []
    if (excluded.length > 0) notes.push(`Cited alongside the competitor in the AI response, but NOT actually associated with them on inspection (no mention or link to the competitor found on the page itself): ${excluded.map(e => e.hostname).join(', ')}.`)
    if (insufficient.length > 0) notes.push(`Could not verify association for: ${insufficient.map(e => `${e.hostname} (${e.reason})`).join('; ')}.`)
    return { status: 'insufficient_data', evidence: notes.length ? notes : ['No third-party source could be verified as actually associated with the winning competitor.'] }
  }

  if (!sourcesEverSynced) {
    return { status: 'insufficient_data', evidence: [`Verified real association with the competitor for: ${associated.map(a => a.hostname).join(', ')}, but this client's own source-citation presence could not be synced -- cannot confirm whether the client is present on them.`] }
  }

  const VERIFIED_PRESENT = new Set(['appears_in_cited_content_verified', 'client_owned_page_cited'])
  const absent = []
  const present = []
  for (const a of associated) {
    const sourceRow = clientSourcesByDomain.get(a.hostname)
    if (sourceRow && VERIFIED_PRESENT.has(sourceRow.client_presence_status)) present.push(a.hostname)
    else absent.push(a.hostname)
  }

  const evidence = [`Source(s) verified as actually associated with the winning competitor (a mention or a direct link to them was found on the page itself): ${associated.map(a => a.hostname).join(', ')}.`]
  if (excluded.length > 0) evidence.push(`Excluded (cited in the same AI response, but NOT actually associated with the competitor on inspection -- likely cited for unrelated information): ${excluded.map(e => e.hostname).join(', ')}.`)
  if (insufficient.length > 0) evidence.push(`Could not verify: ${insufficient.map(e => e.hostname).join(', ')}.`)
  if (absent.length > 0) evidence.push(`Client has no verified presence on: ${absent.join(', ')}.`)
  if (present.length > 0) evidence.push(`Client IS verified-present on: ${present.join(', ')}.`)

  return { status: absent.length > 0 ? 'gap' : 'no_gap', evidence, absentSources: absent }
}

const DIMENSION_PRIORITY = ['third_party', 'content', 'authority', 'relevance', 'technical']
function rankGaps(dims) {
  const realGaps = DIMENSION_PRIORITY.filter(key => dims[key] && dims[key].status === 'gap')
  const confidence = realGaps.length >= 2 ? 'high' : realGaps.length === 1 ? 'medium' : 'insufficient_data'
  return { primary: realGaps[0] || null, secondary: realGaps[1] || null, confidence }
}

const ACTION_BUILDERS = {
  third_party: dim => `Pursue inclusion on: ${(dim.absentSources || []).join(', ')} -- these sources were verified to actually mention or link to the winning competitor, and the client has no verified presence on them.`,
  content: dim => {
    if (dim.clientWordCount == null) {
      return dim.noPageReason === 'no_candidate_satisfies_intent'
        ? 'Create a page that actually satisfies this prompt\'s intent -- the client has keyword-overlapping pages, but none of them are the right TYPE of page (e.g. an informational article instead of a commercial service page).'
        : 'Create a page directly addressing this prompt -- none was found in a live search or in the client\'s own sitemap/page inventory.'
    }
    if (dim.clientPageStatus === 'relevant_nonranking_page') {
      return `The client already has a relevant page (${dim.clientWordCount} words) that is not ranking for this prompt -- focus on strengthening/promoting the EXISTING page (expand toward the competitor's ${dim.competitorWordCount} words, improve internal links/freshness) rather than creating a new one.`
    }
    return `Expand the client's page (${dim.clientWordCount} words) to more thoroughly cover this topic -- the winning competitor's page is ${dim.competitorWordCount} words.`
  },
  authority: dim => `Pursue backlinks/mentions from: ${(dim.competitorOnlyAuthorityDomains || []).join(', ')}.`,
  relevance: dim => `Retarget the client page's title/heading to explicitly include: ${(dim.competitorMatchedTerms || []).join(', ')}.`,
  technical: () => 'Add JSON-LD structured data (matching the client\'s existing business-entity schema) to this specific page.'
}
function buildRecommendedActions(primary, secondary, dims) {
  const actions = []
  if (primary && ACTION_BUILDERS[primary]) actions.push({ gap: primary, action: ACTION_BUILDERS[primary](dims[primary]) })
  if (secondary && ACTION_BUILDERS[secondary]) actions.push({ gap: secondary, action: ACTION_BUILDERS[secondary](dims[secondary]) })
  return actions
}

// ---------------------------------------------------------------------
// I/O ORCHESTRATION
// ---------------------------------------------------------------------

async function loadClientContext(supabase, clientId) {
  const { data: client, error: clientError } = await supabase.from(CLIENTS_TABLE).select('*').eq('id', clientId).single()
  if (clientError) throw clientError

  const { data: competitorRows, error: compError } = await supabase
    .from(COMPETITORS_TABLE).select('domain, name').eq('client_id', clientId).eq('active', true)
  if (compError) throw compError

  const { data: rows, error: rowsError } = await supabase
    .from(AI_RUNS_TABLE).select('engine, run_at, brand_mentioned, brand_cited, ok, error, raw')
    .eq('client_id', clientId).order('run_at', { ascending: false }).limit(MAX_TRACKED_ROWS)
  if (rowsError) throw rowsError

  const competitorDomainSet = new Set(competitorRows.map(c => normalizeDomain(c.domain)).filter(Boolean))
  const competitorNameByDomain = new Map(competitorRows.map(c => [normalizeDomain(c.domain), c.name]).filter(([d]) => d))
  return { client, competitorRows, rows: rows || [], competitorDomainSet, competitorNameByDomain }
}

async function getPromptCandidates(clientId) {
  const supabase = getSupabaseServerClient()
  const { client, rows, competitorDomainSet } = await loadClientContext(supabase, clientId)
  const prompts = Array.isArray(client.test_prompts) ? client.test_prompts : []

  const STATUS_RANK = { LOSS: 0, MIXED: 1, TIE: 2, NO_SIGNAL: 3, NO_DATA: 3, WIN: 4 }
  const candidates = prompts.map(promptText => {
    const outcome = classifyPromptOutcome(rows, promptText, competitorDomainSet)
    return {
      promptText,
      status: outcome.status,
      lastRunAt: outcome.latestRunAt,
      engineOutcomes: outcome.engineOutcomes,
      competitorDomains: outcome.competitorTally.map(t => t.domain)
    }
  })
  candidates.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9))
  return candidates
}

async function getPersistedPromptGapAnalyses(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(GAP_TABLE).select('*').eq('client_id', clientId).order('analyzed_at', { ascending: false })
  if (error) throw error
  return data || []
}

async function fetchPage(url, { fetcher } = {}) {
  if (!url) return null
  const result = await fetchWebPage(url, { fetcher, redirect: 'follow' }).catch(() => null)
  if (!result || result.fetchState !== 'success' || !result.html) {
    return { url, html: null, wordCount: null, title: null, h1: null, fetchFailed: true }
  }
  const { title, h1 } = extractTitleAndH1(result.html)
  return { url, html: result.html, wordCount: htmlToWordCount(result.html), title, h1, fetchFailed: false }
}

async function findClientPageForPrompt(promptText, clientDomain, { apiKey } = {}) {
  if (!apiKey || !clientDomain) return { url: null, checked: false }
  try {
    const raw = await defaultCloroCaller('google', promptText, { apiKey })
    if (!raw || raw.success === false) return { url: null, checked: false }
    const { sourceUrls } = extractEngineSignal('google', raw)
    const match = (sourceUrls || []).find(u => hostnameOf(u) === clientDomain)
    return { url: match || null, checked: true }
  } catch (e) {
    return { url: null, checked: false }
  }
}

// discoverClientPage(promptText, client, competitorPage, opts) -> {
//   url, source, status, page, intent, intentReason, intentSource, pageType,
//   matchConfidence, selectionReason, competitorIntentMatch, llmUsed,
//   noPageReason?, uncertainReason?, candidatesConsidered?
// }
// status: 'relevant_ranking_page' | 'relevant_nonranking_page' |
//   'no_relevant_page' | 'uncertain'. `page` is the already-fetched page
//   object (see fetchPage) when one was selected -- the caller never needs
//   to fetch it again.
//
// STRICT PRIORITY ORDER (2026-09-11 correction -- see module header #7):
//   1. A client page that RANKS live in Google for this exact prompt is
//      fetched and inspected FIRST and is ALWAYS selected -- intent
//      judgment runs against its real content for descriptive evidence
//      only (page type, targeting quality), never as a rejection gate.
//      A live ranking is strong relevance evidence that must never be
//      silently overridden.
//   2. Only when nothing ranks does this fall back to the client's own
//      sitemap, shortlisting just the top MAX_SHORTLIST_CANDIDATES (2-3)
//      pages by keyword overlap and FETCHING those (not all of them, and
//      not zero of them) before intent judgment runs against their real
//      title/h1 -- not a URL-slug guess.
async function discoverClientPage(promptText, client, competitorPage, { cloroApiKey, fetcher, anthropicApiKey } = {}) {
  const clientDomain = normalizeDomain(client.domain) || normalizeDomain(client.url)
  const serp = await findClientPageForPrompt(promptText, clientDomain, { apiKey: cloroApiKey })

  // PRIORITY 1: live ranking evidence, fetched and inspected first, always
  // selected regardless of what intent judgment says about it.
  if (serp.url) {
    const page = await fetchPage(serp.url, { fetcher })
    if (!page || page.fetchFailed) {
      return { url: serp.url, source: 'serp', status: 'uncertain', page: null, uncertainReason: 'ranks_but_unfetchable' }
    }
    const evalResult = await evaluatePageIntentMatch({
      promptText, competitorPage,
      candidates: [{ url: page.url, path: safePathFromUrl(page.url), title: page.title, h1: page.h1, source: 'serp' }],
      apiKey: anthropicApiKey
    })
    const selfEval = evalResult.candidateEvaluations.find(e => e.index === 0) || {}
    return {
      url: page.url, source: 'serp', status: 'relevant_ranking_page', page,
      intent: evalResult.intent, intentReason: evalResult.intentReason, intentSource: evalResult.intentSource,
      pageType: selfEval.page_type || null, matchConfidence: selfEval.match_confidence || null,
      selectionReason: `Ranks live in a Google search for this exact prompt -- selected as the strongest available relevance evidence, regardless of intent-fit judgment.${selfEval.reason ? ` (${selfEval.reason})` : ''}`,
      competitorIntentMatch: evalResult.competitorEval, llmUsed: evalResult.llmUsed
    }
  }

  // PRIORITY 2: nothing ranks -- shortlist the sitemap, fetch ONLY the
  // shortlisted candidates, then judge intent from their real content.
  const siteUrl = client.url || (client.domain ? `https://${client.domain}` : null)
  let sitemapResult = null
  if (siteUrl) {
    const sitemapUrl = `${siteUrl.replace(/\/$/, '')}/sitemap.xml`
    sitemapResult = await fetchSitemapPages(sitemapUrl, { fetcher }).catch(() => null)
  }
  if (!siteUrl || !sitemapResult) {
    return { url: null, source: null, status: 'uncertain', page: null, uncertainReason: 'sitemap_unreachable' }
  }

  const promptTokens = tokenize(promptText)
  const shortlist = (Array.isArray(sitemapResult.pages) ? sitemapResult.pages : [])
    .map(p => ({ page: p, overlap: overlapTerms(promptTokens, tokenize(`${p.path || ''} ${p.type || ''}`)) }))
    .filter(s => s.overlap.length > 0)
    .sort((a, b) => b.overlap.length - a.overlap.length)
    .slice(0, MAX_SHORTLIST_CANDIDATES)

  if (shortlist.length === 0) {
    return { url: null, source: null, status: 'no_relevant_page', page: null, noPageReason: 'no_candidates', candidatesConsidered: 0 }
  }

  const fetchedShortlist = await Promise.all(
    shortlist.map(s => fetchPage(s.page.url, { fetcher }).then(page => ({ meta: s.page, page })))
  )
  const fetchable = fetchedShortlist.filter(c => c.page && !c.page.fetchFailed)

  if (fetchable.length === 0) {
    return { url: null, source: null, status: 'uncertain', page: null, uncertainReason: 'candidates_unfetchable', candidatesConsidered: shortlist.length }
  }

  const candidates = fetchable.map(c => ({ url: c.page.url, path: c.meta.path, type: c.meta.type, title: c.page.title, h1: c.page.h1, source: 'sitemap' }))
  const evalResult = await evaluatePageIntentMatch({ promptText, competitorPage, candidates, apiKey: anthropicApiKey })

  if (evalResult.bestIndex == null) {
    return {
      url: null, source: null, status: 'no_relevant_page', page: null, noPageReason: 'no_candidate_satisfies_intent',
      candidatesConsidered: candidates.length,
      intent: evalResult.intent, intentReason: evalResult.intentReason, intentSource: evalResult.intentSource,
      candidateEvaluations: evalResult.candidateEvaluations, competitorIntentMatch: evalResult.competitorEval,
      llmUsed: evalResult.llmUsed
    }
  }

  const chosen = fetchable[evalResult.bestIndex]
  const chosenEval = evalResult.candidateEvaluations.find(e => e.index === evalResult.bestIndex) || {}
  return {
    url: chosen.page.url, source: 'sitemap', status: 'relevant_nonranking_page', page: chosen.page,
    intent: evalResult.intent, intentReason: evalResult.intentReason, intentSource: evalResult.intentSource,
    pageType: chosenEval.page_type || null,
    matchConfidence: chosenEval.match_confidence || null,
    selectionReason: chosenEval.reason || null,
    competitorIntentMatch: evalResult.competitorEval,
    llmUsed: evalResult.llmUsed
  }
}

// ensureClientSourcesFresh(supabase, clientId, opts) -> { byDomain: Map,
// everSynced: boolean }. Reuses lib/sourceCitation.js#syncClientSources
// (real, already-built infrastructure) on demand: if client_sources has no
// rows for this client, or its freshest row is older than
// CLIENT_SOURCES_FRESHNESS_MS, a real sync runs inline before this
// dimension is evaluated. Degrades to whatever existed before (possibly
// empty) if the sync itself fails -- never blocks the rest of the analysis.
async function ensureClientSourcesFresh(supabase, clientId, { fetcher } = {}) {
  async function readCurrent() {
    const { data, error } = await supabase.from(SOURCES_TABLE).select('domain, client_presence_status, updated_at').eq('client_id', clientId)
    if (error) return null
    return data || []
  }

  const existing = await readCurrent()
  if (existing === null) return { byDomain: new Map(), everSynced: false }

  const newestUpdatedAt = existing.reduce((max, r) => (!max || (r.updated_at && new Date(r.updated_at) > new Date(max))) ? r.updated_at : max, null)
  const isStale = existing.length === 0 || !newestUpdatedAt || (Date.now() - new Date(newestUpdatedAt).getTime()) > CLIENT_SOURCES_FRESHNESS_MS

  if (!isStale) return { byDomain: new Map(existing.map(r => [r.domain, r])), everSynced: true }

  try {
    await syncClientSources(clientId, { inspectPages: true, fetcher })
  } catch (e) {
    return { byDomain: new Map(existing.map(r => [r.domain, r])), everSynced: existing.length > 0 }
  }

  const refreshed = await readCurrent()
  if (refreshed === null) return { byDomain: new Map(existing.map(r => [r.domain, r])), everSynced: existing.length > 0 }
  return { byDomain: new Map(refreshed.map(r => [r.domain, r])), everSynced: true }
}

// containsHrefToDomain(html, domain) -> boolean. lib/citedPageInspection.js's
// own matchesClientEntity only ever sees VISIBLE TEXT (extractPageText
// strips every tag, including attribute values) -- it is structurally blind
// to a plain hyperlink whose anchor text doesn't itself contain the target
// domain/name (e.g. `<a href="https://303windows.com">Visit their
// site</a>`). This small, additive check looks at the RAW html for an href
// actually pointing at the domain, so "links to the competitor" (one of the
// four association criteria asked for) is checked directly rather than only
// inferred from visible text.
function containsHrefToDomain(html, domain) {
  if (!html || !domain) return false
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`href=["'][^"']*${escaped}`, 'i').test(html)
}

// verifyCompetitorAssociationOnPage(url, {name, domain, fetcher}) -> {
//   status: 'verified_present'|'verified_absent'|'insufficient_data',
//   reason
// }
// Fetches ONE specific third-party URL and checks whether the WINNING
// COMPETITOR (not the client) is actually mentioned or linked on it --
// respects robots.txt (this is somebody else's site, unlike the client's
// own domain), same convention as lib/citedPageInspection.js's own
// inspectCitedUrl for the symmetric client-side question. A fetch failure
// (robots-blocked, timeout, deleted, etc.) is NEVER treated as "not
// associated" -- only a genuine successful fetch that finds neither a
// mention nor a link produces verified_absent.
async function verifyCompetitorAssociationOnPage(url, { name, domain, fetcher } = {}) {
  const result = await fetchWebPage(url, { fetcher, redirect: 'follow', respectRobots: true }).catch(() => null)
  if (!result || result.fetchState !== 'success' || !result.html) {
    return {
      status: 'insufficient_data',
      reason: result && result.failureCategory === 'robots_blocked' ? 'robots.txt disallows checking this page.' : 'Could not fetch this source to verify association.'
    }
  }
  const { textLower } = extractPageText(result.html)
  const textMatch = matchesClientEntity(textLower, { name, domain })
  const linked = containsHrefToDomain(result.html, domain)
  if (textMatch.matched || linked) {
    return { status: 'verified_present', reason: textMatch.matched ? `Page mentions "${textMatch.matchedTerm}".` : `Page links directly to ${domain}.` }
  }
  return { status: 'verified_absent', reason: 'Page was fetched but does not mention or link to this competitor -- likely cited for unrelated information.' }
}

// verifyThirdPartyHostnames(urlsByHostname, competitorName, competitorDomain,
// opts) -> [{hostname, status, reason}]. Bounded concurrency, capped URLs
// per hostname (a hostname cited via 3+ different pages doesn't need every
// one checked to establish the pattern) -- same shape of bound
// lib/citedPageInspection.js's own inspectCitedUrlsForClient already uses
// for the symmetric per-client check, reusing its exported
// runWithConcurrency rather than a new bounded-queue implementation.
async function verifyThirdPartyHostnames(urlsByHostname, competitorName, competitorDomain, { fetcher } = {}) {
  const tasks = [...urlsByHostname.entries()].map(([hostname, urls]) => ({ hostname, urls: [...urls].slice(0, MAX_URLS_PER_THIRD_PARTY_HOSTNAME) }))
  return runWithConcurrency(tasks, THIRD_PARTY_VERIFICATION_CONCURRENCY, async ({ hostname, urls }) => {
    let best = { status: 'insufficient_data', reason: 'No URL available to verify.' }
    for (const url of urls) {
      const insp = await verifyCompetitorAssociationOnPage(url, { name: competitorName, domain: competitorDomain, fetcher })
      if (insp.status === 'verified_present') { best = insp; break } // one confirmed association is enough
      if (best.status !== 'verified_present') best = insp // keep the most recent non-present result (verified_absent beats an earlier insufficient_data only if it's the last word -- either is honestly reported)
    }
    return { hostname, ...best }
  })
}

async function upsertGapAnalysis(supabase, row) {
  const { data: existing, error: findError } = await supabase
    .from(GAP_TABLE).select('id').eq('client_id', row.client_id).eq('prompt_text', row.prompt_text).maybeSingle()
  if (findError) throw findError

  if (existing) {
    const { data, error } = await supabase.from(GAP_TABLE).update({ ...row, updated_at: new Date().toISOString() }).eq('id', existing.id).select().single()
    if (error) throw error
    return data
  }
  const { data, error } = await supabase.from(GAP_TABLE).insert(row).select().single()
  if (error) throw error
  return data
}

// analyzePromptGap(clientId, promptText, opts) -> runs the full, real,
// ON-DEMAND analysis for ONE prompt and persists it to prompt_gap_analyses.
// The returned object also carries `engineOutcomes`/`promptStatus`/
// `clientPageDiscovery` (non-persisted, diagnostic-only fields) so a caller
// can see the full reasoning behind the stored row.
async function analyzePromptGap(clientId, promptText, {
  actor = 'am_manual', fetcher,
  cloroApiKey = process.env.CLORO_API_KEY,
  ahrefsApiKey = process.env.AHREFS_API_KEY,
  anthropicApiKey = process.env.ANTHROPIC_API_KEY
} = {}) {
  const supabase = getSupabaseServerClient()
  const { client, rows, competitorDomainSet, competitorNameByDomain } = await loadClientContext(supabase, clientId)

  const prompts = Array.isArray(client.test_prompts) ? client.test_prompts : []
  if (!prompts.includes(promptText)) {
    throw new Error('promptText is not one of this client\'s tracked test_prompts.')
  }

  const outcome = classifyPromptOutcome(rows, promptText, competitorDomainSet)

  const baseRow = {
    client_id: clientId,
    prompt_text: promptText,
    client_visible: false,
    analyzed_at: new Date().toISOString()
  }

  // No losing evidence anywhere in the latest batch (across ALL engines) --
  // honestly report the real per-engine breakdown, never a blanket "no
  // data exists" when real rows/outcomes are sitting right there.
  if (outcome.competitorTally.length === 0) {
    let note
    if (outcome.status === 'NO_DATA' && Object.keys(outcome.engineOutcomes).length === 0) {
      note = 'No tracked AI-visibility run yet exists for this exact prompt text.'
    } else if (outcome.status === 'NO_DATA') {
      note = `A tracked run exists for this prompt, but every engine's own result was inconclusive this run (${formatEngineOutcomes(outcome.engineOutcomes)}).`
    } else {
      note = `No engine in the latest tracked run shows the client losing to a tracked competitor for this prompt. Per-engine outcomes: ${formatEngineOutcomes(outcome.engineOutcomes)}.`
    }
    const insufficient = { status: 'insufficient_data', evidence: [note] }
    const persisted = await upsertGapAnalysis(supabase, {
      ...baseRow,
      winning_competitors: [],
      content_gap: insufficient, relevance_gap: insufficient, authority_gap: insufficient,
      third_party_gap: insufficient, technical_gap: insufficient,
      primary_gap: null, secondary_gap: null, confidence: 'not_applicable',
      recommended_actions: []
    })
    return { ...persisted, promptStatus: outcome.status, engineOutcomes: outcome.engineOutcomes }
  }

  // Real losing evidence exists (on one or more engines) -- run the full
  // deep-dive pooled across every losing engine's evidence.
  const primaryCompetitorDomain = outcome.competitorTally[0].domain
  const picked = pickUrlForDomain(outcome.losingEngines, primaryCompetitorDomain)
  const competitorUrl = picked ? picked.url : null
  const competitorName = competitorNameByDomain.get(primaryCompetitorDomain) || bestEffortDomainName(primaryCompetitorDomain)

  const clientDomain = normalizeDomain(client.domain) || normalizeDomain(client.url)
  const excludeDomains = new Set([...outcome.competitorTally.map(t => t.domain), clientDomain].filter(Boolean))

  // Competitor page is fetched FIRST (not in parallel with page discovery)
  // because lib/pageIntentMatch.js's intent-fit judgment needs its real
  // title/h1 to judge the competitor's own page against the classified
  // intent, alongside every client candidate.
  const [competitorPage, clientAuthority, competitorAuthority, sourcesResult] = await Promise.all([
    fetchPage(competitorUrl, { fetcher }),
    getAuthorityBacklinks(clientDomain, { apiKey: ahrefsApiKey }).catch(() => null),
    getAuthorityBacklinks(primaryCompetitorDomain, { apiKey: ahrefsApiKey }).catch(() => null),
    ensureClientSourcesFresh(supabase, clientId, { fetcher })
  ])

  const clientPageDiscovery = await discoverClientPage(promptText, client, competitorPage, { cloroApiKey, fetcher, anthropicApiKey })
  const clientPage = clientPageDiscovery.page || null

  // Pool every third-party hostname cited alongside a losing competitor
  // across every losing engine, then verify each one actually mentions or
  // links to the competitor before it can count as Third-Party Proof.
  const thirdPartyUrlsByHostname = new Map()
  for (const { thirdPartyUrls } of outcome.losingEngines) {
    for (const url of thirdPartyUrls) {
      const host = hostnameOf(url)
      if (!host || excludeDomains.has(host)) continue
      if (!thirdPartyUrlsByHostname.has(host)) thirdPartyUrlsByHostname.set(host, new Set())
      thirdPartyUrlsByHostname.get(host).add(url)
    }
  }
  const hostnameInspections = await verifyThirdPartyHostnames(thirdPartyUrlsByHostname, competitorName, primaryCompetitorDomain, { fetcher })

  const dims = {
    content: computeContentGap({ competitorPage, clientPage, clientPageDiscovery }),
    relevance: computeRelevanceGap({ promptText, competitorPage, clientPage }),
    authority: computeAuthorityGap({ clientAuthority, competitorAuthority }),
    third_party: computeThirdPartyGap({ hostnameInspections, clientSourcesByDomain: sourcesResult.byDomain, sourcesEverSynced: sourcesResult.everSynced }),
    technical: computeTechnicalGap({ competitorPage, clientPage })
  }

  const { primary, secondary, confidence } = rankGaps(dims)
  const recommendedActions = buildRecommendedActions(primary, secondary, dims)

  const persisted = await upsertGapAnalysis(supabase, {
    ...baseRow,
    winning_competitors: outcome.competitorTally.map(t => t.domain),
    content_gap: dims.content,
    relevance_gap: dims.relevance,
    authority_gap: dims.authority,
    third_party_gap: dims.third_party,
    technical_gap: dims.technical,
    primary_gap: primary,
    secondary_gap: secondary,
    confidence,
    recommended_actions: recommendedActions
  })

  return {
    ...persisted,
    promptStatus: outcome.status,
    engineOutcomes: outcome.engineOutcomes,
    competitorUrlEngine: picked ? picked.engine : null,
    clientPageDiscovery
  }
}

module.exports = {
  GAP_TABLE,
  DIMENSION_PRIORITY,
  ENGINE_PRIORITY,
  // pure logic
  tokenize, overlapTerms, extractTitleAndH1, classifyEngineRow, classifyPromptOutcome,
  pickUrlForDomain, formatEngineOutcomes, bestEffortDomainName, containsHrefToDomain,
  computeContentGap, computeRelevanceGap, computeTechnicalGap,
  computeAuthorityGap, computeThirdPartyGap, partitionThirdPartySources,
  rankGaps, buildRecommendedActions,
  // I/O
  getPromptCandidates, getPersistedPromptGapAnalyses, analyzePromptGap,
  discoverClientPage, ensureClientSourcesFresh, verifyThirdPartyHostnames,
  verifyCompetitorAssociationOnPage
}
