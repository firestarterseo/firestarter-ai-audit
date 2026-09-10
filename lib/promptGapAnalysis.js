// PROMPT-LEVEL GAP ANALYSIS -- v1 rebuild (2026-09-10), corrected 2026-09-11
// after live validation against real JDI Windows data exposed four issues.
// See git history for the original header; this revision's changes:
//
//   1. MULTI-ENGINE ANALYSIS. The original classifyPromptOutcome picked one
//      arbitrary row per prompt (whichever engine's row a Supabase query
//      happened to return first for the latest run_at). Live validation
//      showed this silently discarded real losses visible on OTHER engines
//      in the exact same run batch. Every engine present in the latest
//      batch for a prompt is now classified independently, and gap
//      analysis runs against the POOLED evidence from every engine that
//      shows a loss -- not just whichever engine was checked first.
//   2. OUTCOME STATES. Six honest states: NO_DATA (literally zero tracked
//      rows for this exact prompt text, ever), NO_SIGNAL (a real row/rows
//      exist but neither the client nor a tracked competitor was named),
//      WIN, LOSS, TIE (all uniform across every engine with real data), and
//      MIXED (real per-engine outcomes disagree). An engine whose own row
//      is missing, errored (row.ok === false / row.error set), or has a
//      null brand_mentioned is that ENGINE's own 'no_data' -- never
//      collapsed into the prompt-level NO_DATA/NO_SIGNAL message, and never
//      allowed to make the module claim "no tracked data exists" when real
//      rows plainly do.
//   3. CLIENT-PAGE DISCOVERY. A client absent from a live SERP check does
//      NOT mean no relevant client page exists -- it may simply not be
//      ranking. discoverClientPage() now falls back to the client's own
//      sitemap (lib/sitemapDiscovery.js#fetchSitemapPages, the same
//      candidate-universe primitive Schema & Structure already uses) and
//      looks for the best token-overlap match before ever concluding no
//      page exists. Three distinct, honestly-labeled outcomes:
//      'relevant_page_ranks', 'relevant_page_exists_not_ranking',
//      'no_relevant_page', and a fourth non-conclusion,
//      'unable_to_identify' (sitemap unreachable/unparseable -- a data gap,
//      never treated as "no page"). "Create a new page" is only ever
//      recommended for the genuine 'no_relevant_page' case.
//   4. THIRD-PARTY PROOF DATA AVAILABILITY. Previously this dimension was
//      permanently insufficient_data for any client whose separate AI
//      Source & Citation Presence pillar had never been manually synced.
//      ensureClientSourcesFresh() now reuses lib/sourceCitation.js's
//      already-built syncClientSources() on demand -- if client_sources has
//      no rows, or its most recent row is older than
//      CLIENT_SOURCES_FRESHNESS_MS, a real sync runs inline before this
//      dimension is evaluated. Real, existing infrastructure, not
//      reinvented; see that module's own header for what the sync does.
//
// Everything else from the original header still applies: on-demand only
// (one prompt at a time, AM-triggered), never wired into Opportunities,
// every conclusion still has real evidence or is explicitly
// insufficient_data.

const { getSupabaseServerClient } = require('./supabaseServer')
const { hostnameOf, normalizeDomain } = require('./nonCompetitorDomains')
const { fetchWebPage } = require('./webPageFetch')
const { htmlToWordCount } = require('./checkers/content-checker')
const { parseJsonLd } = require('./checkers/lightweight-jsonld')
const { getAuthorityBacklinks } = require('./checkers/ahrefs')
const { defaultCloroCaller, extractEngineSignal } = require('./checkers/ai-visibility-snapshot-checker')
const { fetchSitemapPages } = require('./sitemapDiscovery')
const { syncClientSources } = require('./sourceCitation')

const AI_RUNS_TABLE = 'ai_visibility_tracked_runs'
const COMPETITORS_TABLE = 'client_competitors'
const CLIENTS_TABLE = 'clients'
const SOURCES_TABLE = 'client_sources'
const GAP_TABLE = 'prompt_gap_analyses'

const MAX_TRACKED_ROWS = 500
const CLIENT_SOURCES_FRESHNESS_MS = 1000 * 60 * 60 * 24 * 14 // 14 days, matching lib/citedPageInspection.js's own staleness window

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
//
// 'NO_DATA' at the prompt level ONLY ever means one of two honest things:
// (a) literally zero rows match this exact prompt text, ever, or (b) real
// rows exist for the latest batch but every single engine's own row is
// itself 'no_data' (all failed/errored/null this run). It is NEVER used
// just because one particular engine's row didn't show a loss -- that
// distinction is exactly what the live-validation fix requires.
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

// computeContentGap({competitorPage, clientPage, clientPageDiscovery}) -> the
// "competitor page most relevant to this exact prompt" comparison.
// clientPageDiscovery.status distinguishes a genuine "no page exists" from
// "exists but isn't ranking" and "couldn't check" -- see discoverClientPage.
function computeContentGap({ competitorPage, clientPage, clientPageDiscovery }) {
  if (!competitorPage || competitorPage.fetchFailed) {
    return { status: 'insufficient_data', evidence: ['Could not fetch the competitor page cited in the AI response.'], competitorWordCount: null, clientWordCount: null, clientPageStatus: clientPageDiscovery ? clientPageDiscovery.status : null }
  }
  const discoveryStatus = clientPageDiscovery ? clientPageDiscovery.status : 'unable_to_identify'

  if (!clientPage) {
    if (discoveryStatus === 'unable_to_identify') {
      return {
        status: 'insufficient_data',
        evidence: [
          `Competitor page (${competitorPage.url}) is ${competitorPage.wordCount} words.`,
          'Could not check the client\'s own site inventory (sitemap unreachable or unrecognized) to confirm whether a relevant page exists -- not treated as "no page."'
        ],
        competitorWordCount: competitorPage.wordCount, clientWordCount: null, clientPageStatus: discoveryStatus
      }
    }
    // discoveryStatus === 'no_relevant_page' -- checked both a live SERP AND
    // the client's own sitemap; neither found anything relevant.
    return {
      status: 'gap',
      evidence: [
        `Competitor page (${competitorPage.url}) is ${competitorPage.wordCount} words.`,
        'No relevant page was found for this client in a live search OR in the client\'s own sitemap/page inventory -- the client has no equivalent page at all.'
      ],
      competitorWordCount: competitorPage.wordCount, clientWordCount: null, clientPageStatus: discoveryStatus
    }
  }
  if (clientPage.fetchFailed) {
    return { status: 'insufficient_data', evidence: ['A candidate client page was found but could not be fetched to compare.'], competitorWordCount: competitorPage.wordCount, clientWordCount: null, clientPageStatus: discoveryStatus }
  }

  const gapExists = competitorPage.wordCount > clientPage.wordCount * 1.3 && (competitorPage.wordCount - clientPage.wordCount) > 150
  const clientLine = discoveryStatus === 'relevant_page_exists_not_ranking'
    ? `Client page (${clientPage.url}) EXISTS but is not ranking for this prompt in a live search right now: ${clientPage.wordCount} words.`
    : `Client page (${clientPage.url}): ${clientPage.wordCount} words.`
  return {
    status: gapExists ? 'gap' : 'no_gap',
    evidence: [`Competitor page (${competitorPage.url}): ${competitorPage.wordCount} words.`, clientLine],
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

// computeThirdPartyGap({thirdPartyHostnames, excludeDomains, clientSourcesByDomain, sourcesEverSynced})
// -> cross-references every source cited alongside a losing competitor
// (pooled across every losing engine, not just one) against the client's
// own client_sources presence data. `sourcesEverSynced` distinguishes "we
// just checked and this client genuinely has zero observed sources" from
// the old, misleading "never synced" message -- see ensureClientSourcesFresh.
function computeThirdPartyGap({ thirdPartyHostnames, excludeDomains, clientSourcesByDomain, sourcesEverSynced }) {
  const candidateHostnames = [...new Set(thirdPartyHostnames)].filter(h => h && !excludeDomains.has(h))
  if (candidateHostnames.length === 0) {
    return { status: 'insufficient_data', evidence: ['No other third-party sources were cited alongside the competitor in the losing engine response(s).'] }
  }
  if (!sourcesEverSynced) {
    return { status: 'insufficient_data', evidence: [`Sources cited alongside the competitor (${candidateHostnames.join(', ')}), but this client's source-citation presence could not be synced (see AI Source & Citation Presence pillar) -- cannot confirm whether the client is present on them.`] }
  }
  const VERIFIED_PRESENT = new Set(['appears_in_cited_content_verified', 'client_owned_page_cited'])
  const absent = []
  const present = []
  for (const host of candidateHostnames) {
    const sourceRow = clientSourcesByDomain.get(host)
    if (sourceRow && VERIFIED_PRESENT.has(sourceRow.client_presence_status)) present.push(host)
    else absent.push(host)
  }
  if (absent.length > 0) {
    return {
      status: 'gap',
      evidence: [
        `Source(s) cited in the losing engine response(s) alongside the competitor: ${candidateHostnames.join(', ')}.`,
        `Client has no verified presence on: ${absent.join(', ')}.`,
        ...(present.length > 0 ? [`Client IS verified-present on: ${present.join(', ')}.`] : [])
      ],
      absentSources: absent
    }
  }
  return { status: 'no_gap', evidence: [`Client already has verified presence on every source cited alongside the competitor in the losing response(s) (${candidateHostnames.join(', ')}).`] }
}

const DIMENSION_PRIORITY = ['third_party', 'content', 'authority', 'relevance', 'technical']
function rankGaps(dims) {
  const realGaps = DIMENSION_PRIORITY.filter(key => dims[key] && dims[key].status === 'gap')
  const confidence = realGaps.length >= 2 ? 'high' : realGaps.length === 1 ? 'medium' : 'insufficient_data'
  return { primary: realGaps[0] || null, secondary: realGaps[1] || null, confidence }
}

const ACTION_BUILDERS = {
  third_party: dim => `Pursue inclusion on: ${(dim.absentSources || []).join(', ')} -- these sources were directly cited by the AI answer alongside the winning competitor.`,
  content: dim => {
    if (dim.clientWordCount == null) return 'Create a page directly addressing this prompt -- none was found in a live search or in the client\'s own sitemap/page inventory.'
    if (dim.clientPageStatus === 'relevant_page_exists_not_ranking') {
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
  return { client, competitorRows, rows: rows || [], competitorDomainSet }
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

// discoverClientPage(promptText, client, opts) -> { url, source, status,
//   matchedTerms? }. source: 'serp' | 'sitemap' | null. status:
//   'relevant_page_ranks' | 'relevant_page_exists_not_ranking' |
//   'no_relevant_page' | 'unable_to_identify'.
//
// Live search (existing behavior) is checked first -- if the client already
// ranks, that's the strongest possible evidence and no further check is
// needed. Only when that comes back empty does this fall back to the
// client's OWN sitemap (lib/sitemapDiscovery.js#fetchSitemapPages, real
// site inventory, not a guess) and look for the best token-overlap match
// against the prompt text. A sitemap that can't be fetched/parsed is an
// honest 'unable_to_identify' -- never silently treated as "no page."
const MIN_OVERLAP_RATIO = 0.5
async function discoverClientPage(promptText, client, { cloroApiKey, fetcher } = {}) {
  const clientDomain = normalizeDomain(client.domain) || normalizeDomain(client.url)
  const serp = await findClientPageForPrompt(promptText, clientDomain, { apiKey: cloroApiKey })
  if (serp.url) return { url: serp.url, source: 'serp', status: 'relevant_page_ranks' }

  const siteUrl = client.url || (client.domain ? `https://${client.domain}` : null)
  if (!siteUrl) return { url: null, source: null, status: 'unable_to_identify' }

  const sitemapUrl = `${siteUrl.replace(/\/$/, '')}/sitemap.xml`
  const sitemapResult = await fetchSitemapPages(sitemapUrl, { fetcher }).catch(() => null)
  if (!sitemapResult || !Array.isArray(sitemapResult.pages) || sitemapResult.pages.length === 0) {
    return { url: null, source: null, status: 'unable_to_identify' }
  }

  const promptTokens = tokenize(promptText)
  let best = null
  for (const page of sitemapResult.pages) {
    const pageTokens = tokenize(`${page.path || ''} ${page.type || ''}`)
    const overlap = overlapTerms(promptTokens, pageTokens)
    if (!best || overlap.length > best.overlap.length) best = { page, overlap }
  }
  const minRequired = Math.max(1, Math.ceil(promptTokens.size * MIN_OVERLAP_RATIO))
  if (best && best.overlap.length >= minRequired) {
    return { url: best.page.url, source: 'sitemap', status: 'relevant_page_exists_not_ranking', matchedTerms: best.overlap }
  }
  return { url: null, source: null, status: 'no_relevant_page' }
}

// ensureClientSourcesFresh(supabase, clientId, opts) -> { byDomain: Map,
// everSynced: boolean }. Reuses lib/sourceCitation.js#syncClientSources
// (real, already-built infrastructure -- see that module's own header) on
// demand: if client_sources has no rows for this client, or its freshest
// row is older than CLIENT_SOURCES_FRESHNESS_MS, a real sync runs inline
// before this dimension is evaluated. Degrades to whatever existed before
// (possibly empty) if the sync itself fails for any reason -- never blocks
// the rest of the prompt-gap analysis. `everSynced` lets
// computeThirdPartyGap tell "we checked and there's genuinely nothing" apart
// from "we couldn't check at all."
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

  if (!isStale) {
    return { byDomain: new Map(existing.map(r => [r.domain, r])), everSynced: true }
  }

  try {
    await syncClientSources(clientId, { inspectPages: true, fetcher })
  } catch (e) {
    // Sync failed (e.g. no client.domain, network error) -- fall back to
    // whatever existed before rather than blocking the rest of the analysis.
    return { byDomain: new Map(existing.map(r => [r.domain, r])), everSynced: existing.length > 0 }
  }

  const refreshed = await readCurrent()
  if (refreshed === null) return { byDomain: new Map(existing.map(r => [r.domain, r])), everSynced: existing.length > 0 }
  return { byDomain: new Map(refreshed.map(r => [r.domain, r])), everSynced: true }
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
// The returned object also carries `engineOutcomes`/`promptStatus`
// (non-persisted, diagnostic-only fields) so a caller can see the full
// per-engine breakdown behind the stored row.
async function analyzePromptGap(clientId, promptText, { actor = 'am_manual', fetcher, cloroApiKey = process.env.CLORO_API_KEY, ahrefsApiKey = process.env.AHREFS_API_KEY } = {}) {
  const supabase = getSupabaseServerClient()
  const { client, rows, competitorDomainSet } = await loadClientContext(supabase, clientId)

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

  const clientDomain = normalizeDomain(client.domain) || normalizeDomain(client.url)

  const [clientPageDiscovery, clientAuthority, competitorAuthority, sourcesResult] = await Promise.all([
    discoverClientPage(promptText, client, { cloroApiKey, fetcher }),
    getAuthorityBacklinks(clientDomain, { apiKey: ahrefsApiKey }).catch(() => null),
    getAuthorityBacklinks(primaryCompetitorDomain, { apiKey: ahrefsApiKey }).catch(() => null),
    ensureClientSourcesFresh(supabase, clientId, { fetcher })
  ])

  const [competitorPage, clientPage] = await Promise.all([
    fetchPage(competitorUrl, { fetcher }),
    clientPageDiscovery.url ? fetchPage(clientPageDiscovery.url, { fetcher }) : Promise.resolve(null)
  ])

  const thirdPartyHostnames = []
  for (const { thirdPartyUrls } of outcome.losingEngines) {
    thirdPartyHostnames.push(...thirdPartyUrls.map(hostnameOf).filter(Boolean))
  }
  const excludeDomains = new Set([...outcome.competitorTally.map(t => t.domain), clientDomain].filter(Boolean))

  const dims = {
    content: computeContentGap({ competitorPage, clientPage, clientPageDiscovery }),
    relevance: computeRelevanceGap({ promptText, competitorPage, clientPage }),
    authority: computeAuthorityGap({ clientAuthority, competitorAuthority }),
    third_party: computeThirdPartyGap({ thirdPartyHostnames, excludeDomains, clientSourcesByDomain: sourcesResult.byDomain, sourcesEverSynced: sourcesResult.everSynced }),
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
  pickUrlForDomain, formatEngineOutcomes,
  computeContentGap, computeRelevanceGap, computeTechnicalGap,
  computeAuthorityGap, computeThirdPartyGap, rankGaps, buildRecommendedActions,
  // I/O
  getPromptCandidates, getPersistedPromptGapAnalyses, analyzePromptGap,
  discoverClientPage, ensureClientSourcesFresh
}
