// PROMPT-LEVEL GAP ANALYSIS -- v1 rebuild (the original V1/V2 work referenced
// in this project's history was lost with no recoverable git history; this is
// a clean rebuild against the current architecture, not a line-for-line
// recreation). Answers, for ONE specific tracked prompt this client is
// losing: which competitor is winning, why (which specific dimension), and
// what to do about it.
//
//   PROMPT -> WINNING COMPETITOR -> GAP -> CAUSE -> RECOMMENDED ACTION
//
// EVERY CONCLUSION MUST HAVE EVIDENCE. Any dimension this module can't
// actually check (missing API key, fetch failure, no data) reports
// 'insufficient_data' -- never a guess, never generic advice.
//
// COST DISCIPLINE (same principle as lib/pageAnalysis.js's header --
// "fetch only when the AM analyzes a queued/open page"): analyzePromptGap
// runs ON DEMAND, one prompt at a time, triggered by an explicit AM action
// (see app/api/clients/[id]/prompt-gaps/route.js). It is never called from
// an audit run, a cron job, or a batch loop over every tracked prompt --
// each call can fire one live Cloro SERP call + up to two live page
// fetches + two live Ahrefs calls, real ongoing cost if run unbounded.
//
// DELIBERATELY NOT WIRED INTO OPPORTUNITIES (per explicit product
// direction): this module never calls anything in lib/opportunityLifecycle.js
// or lib/opportunities.js, and never writes to the `opportunities` table.
// Results persist only to `prompt_gap_analyses`, their own dedicated table
// (already live in Supabase with a schema that matches this module's output
// shape exactly), read back by PromptGapAnalysisPanel.js as its own,
// separate surface.
//
// REUSES, DOES NOT REINVENT:
//   - client_competitors / the win-tie-loss classification shape already in
//     lib/checkers/competitive-position-checker.js's sub-check 1 (this
//     module's classifyPromptOutcome is the same idea, applied to ONE
//     specific prompt instead of aggregated across all tracked runs).
//   - lib/checkers/ai-visibility-snapshot-checker.js's defaultCloroCaller/
//     extractEngineSignal (same Cloro "google" call lib/serpLandscape.js
//     already uses for keyword opportunities, applied to the prompt text
//     itself to find the client's own ranking URL, if any).
//   - lib/webPageFetch.js for the two live page fetches.
//   - lib/checkers/content-checker.js#htmlToWordCount for the content gap.
//   - lib/checkers/lightweight-jsonld.js#parseJsonLd for the technical gap.
//   - lib/checkers/ahrefs.js#getAuthorityBacklinks (curated authority-domain
//     backlinks, NOT raw Domain Rating -- see this project's ROADMAP.md,
//     "Domain authority (DR) is NOT a useful proxy for AI-citation
//     likelihood") for the authority gap.
//   - lib/sourceCitation.js's already-synced `client_sources` rows for the
//     third-party-proof gap -- read-only here, never re-synced by this
//     module (syncing is syncSourceCitationPillar's job, run separately).

const { getSupabaseServerClient } = require('./supabaseServer')
const { hostnameOf, normalizeDomain } = require('./nonCompetitorDomains')
const { fetchWebPage } = require('./webPageFetch')
const { htmlToWordCount } = require('./checkers/content-checker')
const { parseJsonLd } = require('./checkers/lightweight-jsonld')
const { getAuthorityBacklinks } = require('./checkers/ahrefs')
const { defaultCloroCaller, extractEngineSignal } = require('./checkers/ai-visibility-snapshot-checker')

const AI_RUNS_TABLE = 'ai_visibility_tracked_runs'
const COMPETITORS_TABLE = 'client_competitors'
const CLIENTS_TABLE = 'clients'
const SOURCES_TABLE = 'client_sources'
const GAP_TABLE = 'prompt_gap_analyses'

const MAX_TRACKED_ROWS = 500

// ---------------------------------------------------------------------
// PURE LOGIC -- no DB, no network. Each dimension always returns
// { status: 'gap' | 'no_gap' | 'insufficient_data', evidence: string[], ... }
// ---------------------------------------------------------------------

// A short, genuinely generic stopword list -- same discipline as
// lib/entityBrandAuthorityTargets.js's OVERLAP_STOPWORDS, reimplemented
// locally rather than imported so this module stays independently testable
// (that file is deliberately zero-require, per its own header).
const STOPWORDS = new Set(['and', 'the', 'of', 'for', 'a', 'an', 'in', 'on', 'at', 'to', 'with', 'is', 'are', 'best', 'near', 'me'])
function tokenize(text) {
  return new Set(
    String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t))
  )
}
function overlapTerms(promptTokens, pageTokens) {
  return [...promptTokens].filter(t => pageTokens.has(t))
}

// extractTitleAndH1(html) -> {title, h1}. Regex-only, same "no new HTML
// parser dependency" convention as lib/citedPageInspection.js's
// extractPageText and lib/checkers/lightweight-jsonld.js's SCRIPT_RE.
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

// classifyPromptOutcome(rows, promptText, competitorDomainSet) -> the
// single most recent tracked run matching this exact prompt text, and
// whether the client is winning/tied/losing/has-no-signal for it. Mirrors
// lib/checkers/competitive-position-checker.js's per-row win/tie/loss logic
// (sub-check 1), applied to one prompt instead of aggregated.
function classifyPromptOutcome(rows, promptText, competitorDomainSet) {
  const matching = (rows || []).filter(r => r && r.raw && r.raw.prompt === promptText)
  if (matching.length === 0) return { status: 'no_data', row: null, competitorHits: [], thirdPartyUrls: [] }

  const row = matching.reduce((latest, r) => (
    !latest || (r.run_at && new Date(r.run_at) > new Date(latest.run_at)) ? r : latest
  ), null)

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

  const clientMentioned = !!row.brand_mentioned
  let status
  if (clientMentioned && competitorHits.length === 0) status = 'winning'
  else if (clientMentioned && competitorHits.length > 0) status = 'tied'
  else if (!clientMentioned && competitorHits.length > 0) status = 'losing'
  else status = 'no_signal'

  return { status, row, competitorHits, thirdPartyUrls, ownUrls }
}

// computeContentGap({promptText, competitorPage, clientPage}) -> the
// "competitor page most relevant to this exact prompt" comparison. A null
// clientPage means no client-owned page was found ranking for this prompt
// at all (see findClientPageForPrompt) -- an honest, reportable finding on
// its own, not a blocker.
function computeContentGap({ competitorPage, clientPage }) {
  if (!competitorPage || competitorPage.fetchFailed) {
    return { status: 'insufficient_data', evidence: ['Could not fetch the competitor page cited in the AI response.'], competitorWordCount: null, clientWordCount: null }
  }
  if (!clientPage) {
    return {
      status: 'gap',
      evidence: [
        `Competitor page (${competitorPage.url}) is ${competitorPage.wordCount} words.`,
        'No client-owned page was found ranking for this exact prompt in a live search -- the client has no discoverable equivalent page.'
      ],
      competitorWordCount: competitorPage.wordCount,
      clientWordCount: null
    }
  }
  if (clientPage.fetchFailed) {
    return { status: 'insufficient_data', evidence: ['A candidate client page was found in search results but could not be fetched to compare.'], competitorWordCount: competitorPage.wordCount, clientWordCount: null }
  }
  const gapExists = competitorPage.wordCount > clientPage.wordCount * 1.3 && (competitorPage.wordCount - clientPage.wordCount) > 150
  return {
    status: gapExists ? 'gap' : 'no_gap',
    evidence: [
      `Competitor page (${competitorPage.url}): ${competitorPage.wordCount} words.`,
      `Client page (${clientPage.url}): ${clientPage.wordCount} words.`
    ],
    competitorWordCount: competitorPage.wordCount,
    clientWordCount: clientPage.wordCount
  }
}

// computeRelevanceGap({promptText, competitorPage, clientPage}) -> does the
// competitor's page title/H1 more directly address the prompt's own key
// terms than the client's? Conservative, mechanical token-overlap -- same
// discipline as lib/entityBrandAuthorityTargets.js's tokensConservativelyOverlap
// (no semantic/synonym matching invented).
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
      competitorMatchedTerms: competitorMatches,
      clientMatchedTerms: clientMatches
    }
  }
  return {
    status: 'no_gap',
    evidence: [`Client title/heading matches the same or more of this prompt's key terms (client: ${clientMatches.join(', ') || 'none'}; competitor: ${competitorMatches.join(', ') || 'none'}).`],
    competitorMatchedTerms: competitorMatches,
    clientMatchedTerms: clientMatches
  }
}

// computeTechnicalGap({competitorPage, clientPage}) -> business-entity
// JSON-LD presence, page-specific (not the whole-domain Schema & Structure
// pillar). Only meaningful when a real client page exists to check.
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
      evidence: [
        `Competitor page has JSON-LD structured data (${competitorSchema.schemaNames.join(', ')}).`,
        'Client page has no JSON-LD structured data.'
      ]
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

// computeAuthorityGap({clientAuthority, competitorAuthority}) -> topic-
// relevant authority backlinks (lib/checkers/ahrefs.js#getAuthorityBacklinks,
// a curated authority-domain list), NEVER whole-domain DR/referring-domain
// totals -- see this project's ROADMAP.md on why DR isn't a useful proxy
// for AI-citation likelihood.
function computeAuthorityGap({ clientAuthority, competitorAuthority }) {
  if (!clientAuthority || clientAuthority.error || !competitorAuthority || competitorAuthority.error) {
    return { status: 'insufficient_data', evidence: ['Authority-backlink data unavailable for the client and/or competitor domain (Ahrefs call failed or AHREFS_API_KEY not configured).'] }
  }
  const clientDomains = new Set((clientAuthority.authorityReferringDomains || []).map(d => d.domain))
  const competitorOnly = (competitorAuthority.authorityReferringDomains || []).filter(d => !clientDomains.has(d.domain))

  if (competitorOnly.length > 0) {
    return {
      status: 'gap',
      evidence: [
        `Competitor has recognized-authority backlinks the client does not: ${competitorOnly.map(d => d.domain).join(', ')}.`
      ],
      competitorOnlyAuthorityDomains: competitorOnly.map(d => d.domain)
    }
  }
  return {
    status: 'no_gap',
    evidence: [`No recognized-authority domain links to the competitor that doesn't also link to the client (client: ${clientAuthority.authorityReferringDomains.length}, competitor: ${competitorAuthority.authorityReferringDomains.length}).`]
  }
}

// computeThirdPartyGap({thirdPartyHostnames, excludeDomains, clientSourcesByDomain})
// -> cross-references the OTHER sources cited alongside the competitor in
// THIS SAME AI response against the client's own already-synced
// client_sources rows (lib/sourceCitation.js) -- read-only reuse, no new
// sync triggered here.
function computeThirdPartyGap({ thirdPartyHostnames, excludeDomains, clientSourcesByDomain }) {
  const candidateHostnames = [...new Set(thirdPartyHostnames)].filter(h => h && !excludeDomains.has(h))
  if (candidateHostnames.length === 0) {
    return { status: 'insufficient_data', evidence: ['No other third-party sources were cited alongside the competitor in this specific AI response.'] }
  }
  if (!clientSourcesByDomain || clientSourcesByDomain.size === 0) {
    return { status: 'insufficient_data', evidence: [`Sources cited alongside the competitor (${candidateHostnames.join(', ')}), but this client's own source-citation presence has not been synced yet (see AI Source & Citation Presence pillar) -- cannot confirm whether the client is present on them.`] }
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
        `Source(s) cited in the same AI response as the winning competitor: ${candidateHostnames.join(', ')}.`,
        `Client has no verified presence on: ${absent.join(', ')}.`,
        ...(present.length > 0 ? [`Client IS verified-present on: ${present.join(', ')}.`] : [])
      ],
      absentSources: absent
    }
  }
  return { status: 'no_gap', evidence: [`Client already has verified presence on every source cited alongside the competitor in this response (${candidateHostnames.join(', ')}).`] }
}

// rankGaps(dims) -> {primary, secondary, confidence}. Preference order
// reflects this project's own research (see ROADMAP.md's "Pillar-
// architecture review"): off-page third-party proof and real content
// depth are the best-evidenced levers; technical/schema is a floor, not a
// differentiator, so it ranks last when multiple real gaps are found.
const DIMENSION_PRIORITY = ['third_party', 'content', 'authority', 'relevance', 'technical']
function rankGaps(dims) {
  const realGaps = DIMENSION_PRIORITY.filter(key => dims[key] && dims[key].status === 'gap')
  const confidence = realGaps.length >= 2 ? 'high' : realGaps.length === 1 ? 'medium' : 'insufficient_data'
  return { primary: realGaps[0] || null, secondary: realGaps[1] || null, confidence }
}

const ACTION_BUILDERS = {
  third_party: dim => `Pursue inclusion on: ${(dim.absentSources || []).join(', ')} -- these sources were directly cited by the AI answer alongside the winning competitor.`,
  content: dim => dim.clientWordCount == null
    ? 'Create a page directly addressing this prompt -- none currently exists.'
    : `Expand the client's page (${dim.clientWordCount} words) to more thoroughly cover this topic -- the winning competitor's page is ${dim.competitorWordCount} words.`,
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
    .from(AI_RUNS_TABLE).select('engine, run_at, brand_mentioned, brand_cited, raw')
    .eq('client_id', clientId).order('run_at', { ascending: false }).limit(MAX_TRACKED_ROWS)
  if (rowsError) throw rowsError

  const competitorDomainSet = new Set(competitorRows.map(c => normalizeDomain(c.domain)).filter(Boolean))
  return { client, competitorRows, rows: rows || [], competitorDomainSet }
}

// getPromptCandidates(clientId) -> every real tracked prompt (clients.test_prompts)
// classified by current outcome, losing prompts first -- no live fetches, no
// cost, safe to call on every page render.
async function getPromptCandidates(clientId) {
  const supabase = getSupabaseServerClient()
  const { client, rows, competitorDomainSet } = await loadClientContext(supabase, clientId)
  const prompts = Array.isArray(client.test_prompts) ? client.test_prompts : []

  const STATUS_RANK = { losing: 0, tied: 1, no_data: 2, no_signal: 2, winning: 3 }
  const candidates = prompts.map(promptText => {
    const outcome = classifyPromptOutcome(rows, promptText, competitorDomainSet)
    return {
      promptText,
      status: outcome.status,
      lastRunAt: outcome.row ? outcome.row.run_at : null,
      competitorDomains: outcome.competitorHits.map(h => h.domain)
    }
  })
  candidates.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9))
  return candidates
}

// getPersistedPromptGapAnalyses(clientId) -> every prompt_gap_analyses row
// for this client, most recent first. Pure read, no cost.
async function getPersistedPromptGapAnalyses(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(GAP_TABLE).select('*').eq('client_id', clientId).order('analyzed_at', { ascending: false })
  if (error) throw error
  return data || []
}

// fetchPage(url) -> {url, html, wordCount, title, h1, fetchFailed} | null.
// Never throws.
async function fetchPage(url, { fetcher } = {}) {
  if (!url) return null
  const result = await fetchWebPage(url, { fetcher, redirect: 'follow' }).catch(() => null)
  if (!result || result.fetchState !== 'success' || !result.html) {
    return { url, html: null, wordCount: null, title: null, h1: null, fetchFailed: true }
  }
  const { title, h1 } = extractTitleAndH1(result.html)
  return { url, html: result.html, wordCount: htmlToWordCount(result.html), title, h1, fetchFailed: false }
}

// findClientPageForPrompt(promptText, clientDomain, {apiKey}) -> live Cloro
// "google" call for the prompt text itself (same mechanism/cost as
// lib/serpLandscape.js#fetchSerpTopDomains, just keeping the full URL, not
// only the hostname) -> the client's own ranking URL, if any appears in the
// real, current organic results. Never throws; a failed/unconfigured call
// just means "no client page found," honestly reported as such by the
// calling dimension functions (never asserted as a positive absence).
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

async function loadClientSourcesByDomain(supabase, clientId) {
  const { data, error } = await supabase.from(SOURCES_TABLE).select('domain, client_presence_status').eq('client_id', clientId)
  if (error) return new Map()
  return new Map((data || []).map(r => [r.domain, r]))
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
// See module header for the cost-discipline reasoning on why this is never
// called in a loop.
async function analyzePromptGap(clientId, promptText, { actor = 'am_manual', fetcher, cloroApiKey = process.env.CLORO_API_KEY, ahrefsApiKey = process.env.AHREFS_API_KEY } = {}) {
  const supabase = getSupabaseServerClient()
  const { client, rows, competitorDomainSet } = await loadClientContext(supabase, clientId)

  const prompts = Array.isArray(client.test_prompts) ? client.test_prompts : []
  if (!prompts.includes(promptText)) {
    throw new Error('promptText is not one of this client\'s tracked test_prompts.')
  }

  const clientDomain = normalizeDomain(client.domain) || normalizeDomain(client.url)
  const outcome = classifyPromptOutcome(rows, promptText, competitorDomainSet)

  const baseRow = {
    client_id: clientId,
    prompt_text: promptText,
    client_visible: false,
    analyzed_at: new Date().toISOString()
  }

  // Not losing (or no data at all): honestly report that and skip every
  // live fetch/API call -- there is no gap to diagnose yet.
  if (outcome.status !== 'losing') {
    const note = outcome.status === 'winning'
      ? 'Client is already winning this prompt (mentioned, no tracked competitor cited) -- no gap to diagnose.'
      : outcome.status === 'tied'
        ? 'Client is mentioned for this prompt alongside a tracked competitor (tie) -- no clear loss to diagnose.'
        : 'No tracked AI-visibility run yet exists for this exact prompt text.'
    const insufficient = { status: 'insufficient_data', evidence: [note] }
    return upsertGapAnalysis(supabase, {
      ...baseRow,
      winning_competitors: outcome.competitorHits.map(h => h.domain),
      content_gap: insufficient, relevance_gap: insufficient, authority_gap: insufficient,
      third_party_gap: insufficient, technical_gap: insufficient,
      primary_gap: null, secondary_gap: null, confidence: 'not_applicable',
      recommended_actions: []
    })
  }

  const primaryCompetitorDomain = outcome.competitorHits[0].domain
  const competitorUrl = outcome.competitorHits[0].url

  const [clientPageLookup, clientAuthority, competitorAuthority, clientSourcesByDomain] = await Promise.all([
    findClientPageForPrompt(promptText, clientDomain, { apiKey: cloroApiKey }),
    getAuthorityBacklinks(clientDomain, { apiKey: ahrefsApiKey }).catch(() => null),
    getAuthorityBacklinks(primaryCompetitorDomain, { apiKey: ahrefsApiKey }).catch(() => null),
    loadClientSourcesByDomain(supabase, clientId)
  ])

  const [competitorPage, clientPage] = await Promise.all([
    fetchPage(competitorUrl, { fetcher }),
    clientPageLookup.url ? fetchPage(clientPageLookup.url, { fetcher }) : Promise.resolve(null)
  ])

  const thirdPartyHostnames = outcome.thirdPartyUrls.map(hostnameOf).filter(Boolean)
  const excludeDomains = new Set([primaryCompetitorDomain, clientDomain].filter(Boolean))

  const dims = {
    content: computeContentGap({ competitorPage, clientPage }),
    relevance: computeRelevanceGap({ promptText, competitorPage, clientPage }),
    authority: computeAuthorityGap({ clientAuthority, competitorAuthority }),
    third_party: computeThirdPartyGap({ thirdPartyHostnames, excludeDomains, clientSourcesByDomain }),
    technical: computeTechnicalGap({ competitorPage, clientPage })
  }

  const { primary, secondary, confidence } = rankGaps(dims)
  const recommendedActions = buildRecommendedActions(primary, secondary, dims)

  return upsertGapAnalysis(supabase, {
    ...baseRow,
    winning_competitors: outcome.competitorHits.map(h => h.domain),
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
}

module.exports = {
  GAP_TABLE,
  DIMENSION_PRIORITY,
  // pure logic
  tokenize, overlapTerms, extractTitleAndH1, classifyPromptOutcome,
  computeContentGap, computeRelevanceGap, computeTechnicalGap,
  computeAuthorityGap, computeThirdPartyGap, rankGaps, buildRecommendedActions,
  // I/O
  getPromptCandidates, getPersistedPromptGapAnalyses, analyzePromptGap
}
