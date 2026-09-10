// PROMPT GAP ANALYSIS -> EXECUTION PLAN (2026-09-11, corrected 2026-09-11
// after live review of the JDI Windows output).
//
// Turns an ALREADY-VALIDATED, ALREADY-EXISTING Opportunity (created by
// lib/promptGapOpportunities.js) into a real, reviewable execution plan,
// using the exact same lib/opportunityLifecycle.js#prepareWork() +
// opportunity_prepared_work storage every other pillar already uses
// (lib/schemaPreparedWork.js for Schema). Never creates a new Opportunity,
// never touches gap analysis -- this only ever runs against an
// opportunityId that already exists. See the original commit for why this
// module doesn't reuse lib/contentBrief.js's storage column directly.
//
// ACTION-TYPE DECISION (added this pass): live review of the first
// generated plans surfaced a real problem -- the relevance proposal for
// "replacement windows littleton co" retargeted the client's HOMEPAGE
// title/H1 to "Replacement Windows in Littleton, CO," which would have
// narrowed the one page representing the whole business down to a single
// suburb. determineActionType() now runs BEFORE any generation and
// decides one of: 'create_dedicated_new_page', 'improve_existing_page',
// 'expand_existing_page', 'fix_technical_schema' -- considering the
// AFFECTED PAGE'S ROLE, not just the gap category. A broad/core page (this
// pass's one concrete, evidenced rule: the homepage) is explicitly
// PROTECTED -- a relevance gap resolved against it always becomes
// 'create_dedicated_new_page' instead of a direct retarget, so the
// existing execution-plan storage/generation system is unchanged, but what
// gets generated and where it points is now role-aware.
//
// SEPARATE SITE-QUALITY ISSUES: fetching a page to prepare its execution
// plan can surface something real but UNRELATED to the specific prompt gap
// (live example: /doors/'s H1 read "Altius Windows and Doors," a different
// business name entirely). detectSiteQualityIssues() is a small,
// deterministic (no LLM) check kept structurally SEPARATE from the
// generated plan's own sections/proposal -- stored alongside it in the
// same prepared-work payload under its own key, never folded into the
// actionable content itself, so an AM sees "the Littleton fix" and "this
// unrelated branding thing worth a look" as two distinct facts.

const { getSupabaseServerClient } = require('./supabaseServer')
const { prepareWork } = require('./opportunityLifecycle')
const { callAnthropicTool } = require('./llm/anthropic')
const { fetchWebPage } = require('./webPageFetch')
const { htmlToWordCount } = require('./checkers/content-checker')
const { extractTitleAndH1 } = require('./promptGapAnalysis')

// ---------------------------------------------------------------------
// PURE LOGIC -- action-type decision + site-quality detection. No DB, no
// LLM, no network -- independently testable.
// ---------------------------------------------------------------------

// isHomepagePath(url) -> boolean. The one concrete, evidenced "broad/core
// page" rule this pass adds: the homepage's job is to represent the whole
// business, not one location/service combination. Deliberately narrow
// (not a guess at "is this page important-looking") -- broadened later
// only when real evidence calls for it, same "small, evolvable, evidence-
// driven list" discipline as lib/nonCompetitorDomains.js.
function isHomepagePath(url) {
  try {
    const path = new URL(url).pathname
    return path === '/' || path === ''
  } catch (e) {
    return false
  }
}

// determineActionType(opportunity) -> { actionType, reason, protectedPage }.
// Runs BEFORE any generation. gapCategory comes from
// lib/promptGapOpportunities.js's own detail.gap_category -- this function
// adds no new classification of the underlying gap, only decides WHERE and
// HOW to act on it given the affected page's role.
function determineActionType(opportunity) {
  const detail = opportunity?.detail || {}
  const gapCategory = detail.gap_category
  const pageUrl = detail.affected_page_url

  if (opportunity.pillar === 'schema_structure' || opportunity.type === 'schema_fix') {
    return { actionType: 'fix_technical_schema', reason: 'Schema/Technical opportunities continue through the existing Schema Wizard.', protectedPage: null }
  }

  if (gapCategory === 'content') {
    if (!pageUrl) {
      return { actionType: 'create_dedicated_new_page', reason: 'No relevant client page exists (verified via live SERP and sitemap inspection) -- a new page is the only real option.', protectedPage: null }
    }
    return {
      actionType: 'expand_existing_page',
      reason: `A relevant page exists (${pageUrl}) but is thinner than the winning competitor's -- expanding its content in place doesn't change the page's title/H1/core purpose, so it's safe to deepen directly.`,
      protectedPage: null
    }
  }

  if (gapCategory === 'relevance') {
    if (!pageUrl) return { actionType: 'create_dedicated_new_page', reason: 'No specific page was identified to retarget.', protectedPage: null }
    if (isHomepagePath(pageUrl)) {
      return {
        actionType: 'create_dedicated_new_page',
        reason: 'The page currently serving this prompt is the site\'s HOMEPAGE -- its role is to represent the business broadly, not one specific location/service combination. Narrowly retargeting its title/H1 would damage that broader purpose, so a dedicated supporting page is the correct action instead of retargeting it.',
        protectedPage: pageUrl
      }
    }
    return {
      actionType: 'improve_existing_page',
      reason: `${pageUrl} is a supporting page, not the homepage or another broad/core page -- retargeting its title/H1/content directly is safe and appropriate.`,
      protectedPage: null
    }
  }

  return { actionType: null, reason: `No action-type mapping exists for gap category "${gapCategory}".`, protectedPage: null }
}

// GENERIC_H1_WORDS -- common words that appear in almost any page H1 in
// this vertical/business-shape and therefore carry no brand-identity
// signal on their own. Deliberately small and evolvable (same discipline
// as lib/nonCompetitorDomains.js), not a claim of completeness.
const GENERIC_H1_WORDS = new Set([
  'and', 'the', 'for', 'of', 'in', 'at', 'a', 'an', 'to', 'with',
  'windows', 'window', 'doors', 'door', 'company', 'co', 'replacement',
  'patio', 'sliding', 'glass', 'home', 'homes', 'construction',
  'services', 'service', 'custom', 'quality', 'best', 'top'
])

// detectSiteQualityIssues({client, currentPage, pageUrl}) -> issue[].
// Deterministic, NOT an LLM judgment -- checks whether every "distinctive"
// (non-generic, real) word in the page's H1 is unrecognized against the
// client's own known name/domain/city/region. A page whose H1 reads as a
// coherent, entirely different business name (e.g. "Altius Windows and
// Doors" for a client named "JDI Windows") is flagged; a normal descriptive
// H1 that happens to include the client's own city (e.g. "Denver Window
// Company") is not, since "Denver" matches the client's known city.
function detectSiteQualityIssues({ client, currentPage, pageUrl }) {
  if (!currentPage || !currentPage.h1) return []
  const knownTerms = new Set(
    [client?.name, client?.domain, client?.url, client?.city, client?.region]
      .filter(Boolean).join(' ')
      .toLowerCase()
      .replace(/https?:\/\//g, '')
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3)
  )
  const words = currentPage.h1.split(/\s+/).map(w => w.replace(/[^a-zA-Z]/g, '')).filter(Boolean)
  const distinctiveWords = words.filter(w => w.length >= 3 && !GENERIC_H1_WORDS.has(w.toLowerCase()))
  const unrecognized = distinctiveWords.filter(w => !knownTerms.has(w.toLowerCase()))

  if (distinctiveWords.length > 0 && unrecognized.length === distinctiveWords.length) {
    return [{
      type: 'possible_stale_or_mismatched_branding',
      page_url: pageUrl,
      evidence: `This page's H1 is "${currentPage.h1}" -- none of its distinctive words (${distinctiveWords.join(', ')}) match the client's known name, domain, city, or region.`,
      note: 'Separate site-quality observation, surfaced only because this page was fetched to prepare the execution plan below -- not further investigated, and not part of the plan itself.'
    }]
  }
  return []
}

// ---------------------------------------------------------------------
// GENERATORS -- one shared tool schema for "write a new page" (used for
// both the genuine no-page case and the homepage-protection case), one for
// "propose edits to an existing page" (improve/expand).
// ---------------------------------------------------------------------

const NEW_PAGE_TOOL = {
  name: 'write_content_brief',
  description: 'Write a real, publish-ready content brief for a NEW dedicated page, based on real AI-visibility prompts a tracked competitor wins and this client loses.',
  input_schema: {
    type: 'object',
    properties: {
      page_title: { type: 'string', description: 'The <title> tag, written to naturally target the real losing prompt(s) given.' },
      h1: { type: 'string', description: 'The on-page H1 -- may differ slightly from page_title, but must target the same real prompt(s).' },
      target_url_slug: { type: 'string', description: 'A realistic URL slug, e.g. "custom-windows-denver" (no leading/trailing slashes).' },
      meta_description: { type: 'string', description: 'Under 160 characters.' },
      angle: { type: 'string', description: '2-3 sentences: what this page needs to do differently than the winning competitor\'s page, citing the REAL evidence given -- not generic SEO advice.' },
      sections: {
        type: 'array',
        description: 'Real, substantive, paste-ready draft copy, not placeholder text.',
        items: {
          type: 'object',
          properties: {
            heading_level: { type: 'string', enum: ['H1', 'H2', 'H3'] },
            heading: { type: 'string' },
            content_html: { type: 'string', description: 'Plain HTML using only <p>, <ul>, <li>, <strong>, <em> -- no wrapper tags.' }
          },
          required: ['heading_level', 'heading', 'content_html']
        }
      },
      internal_linking_suggestions: {
        type: 'array',
        description: 'Existing pages on this site that should link to the new page (and vice versa where relevant).',
        items: {
          type: 'object',
          properties: { anchor_text: { type: 'string' }, link_target_hint: { type: 'string' }, reason: { type: 'string' } },
          required: ['anchor_text', 'link_target_hint', 'reason']
        }
      },
      proof_requirements: {
        type: 'array',
        description: 'Real-world proof the client must actually supply before this page can honestly publish the claims it makes -- e.g. local project photos, a testimonial, a license/certification number. Never invented statistics or fabricated credentials.',
        items: {
          type: 'object',
          properties: { requirement: { type: 'string' }, reason: { type: 'string' } },
          required: ['requirement', 'reason']
        }
      },
      schema_recommendations: {
        type: 'array',
        description: 'Recommended schema.org JSON-LD types for this new page, using standard schema.org type names (e.g. "Service", "LocalBusiness", "BreadcrumbList"). This is a recommendation for the existing Schema Wizard to pick up on its next scan of this page -- it does not generate or publish the JSON-LD itself.',
        items: {
          type: 'object',
          properties: { schema_type: { type: 'string' }, reason: { type: 'string' } },
          required: ['schema_type', 'reason']
        }
      }
    },
    required: ['page_title', 'h1', 'target_url_slug', 'meta_description', 'angle', 'sections', 'internal_linking_suggestions', 'proof_requirements', 'schema_recommendations']
  }
}

const NO_PAGE_SYSTEM_PROMPT = `You are a senior local SEO content strategist writing a real, ready-to-publish content brief for a client business. You are given the REAL prompts real people ask AI assistants where a specific tracked competitor is cited and this client is not, plus the gap-analysis engine's own real evidence about why. Ground every recommendation in that real evidence. Never invent facts about the client (credentials, awards, client counts, pricing) that weren't given to you. Write copy substantive enough to be a real first draft, not a stub. Also propose internal_linking_suggestions (real, plausible existing pages on this site that should connect to this one), proof_requirements (real-world proof -- photos, testimonials, license/certification numbers -- the client must actually supply before the page's claims are honest; never invent the proof itself), and schema_recommendations (standard schema.org type names for this page, for the existing Schema Wizard to pick up separately -- do not write JSON-LD yourself).`

// DEDICATED_PAGE_SYSTEM_PROMPT -- used specifically for the homepage-
// protection case: the model is told explicitly that a broad/core page
// already exists and must NOT be duplicated or narrowed, and is given that
// page's own real current title/H1 so the new page reads as a distinct,
// complementary asset (a location/service landing page), not a rewrite of
// the homepage.
const DEDICATED_PAGE_SYSTEM_PROMPT = `You are a senior local SEO content strategist. This client's homepage already ranks broadly for the business as a whole and must NOT be narrowly retargeted or duplicated -- you are instead writing a NEW, dedicated supporting page for one specific location/service combination that the homepage is too broad to serve well. You are given the homepage's own real current title/H1 for context (write something distinct and complementary, not a copy of it), the real losing AI-visibility prompts, the winning competitor, and the gap engine's own evidence. Ground every recommendation in that real evidence; never invent facts about the client that weren't given to you. Also propose internal_linking_suggestions (including a link back to/from the homepage, since this page supplements it), proof_requirements (real-world proof the client must supply before publishing), and schema_recommendations (standard schema.org type names, for the existing Schema Wizard to pick up separately).`

async function generateNewPageBrief(opportunity, client, { apiKey, systemPrompt, protectedPageContext = null } = {}) {
  const detail = opportunity?.detail || {}
  const payload = {
    client_context: { name: client?.name || null, domain: client?.domain || client?.url || null, city: client?.city || null, region: client?.region || null, category: client?.category || null },
    ...(protectedPageContext ? { existing_broad_page_do_not_duplicate: protectedPageContext } : {}),
    losing_prompts: (detail.supporting_prompts || []).map(p => ({ prompt: p.prompt_text, losing_engines: p.losing_engines, winning_competitors: p.winning_competitors })),
    winning_competitors: detail.winning_competitors || [],
    gap_evidence: detail.gap_evidence || [],
    recommended_action: detail.recommended_action || null
  }
  const { result, error } = await callAnthropicTool({ system: systemPrompt, user: JSON.stringify(payload, null, 2), tool: NEW_PAGE_TOOL, apiKey, maxTokens: 4096 })
  if (error || !result) return { brief: null, error: error || { status: null, message: 'No brief returned.' } }
  return { brief: result, error: null }
}

const EXISTING_PAGE_PROPOSAL_TOOL = {
  name: 'write_page_edit_proposal',
  description: 'Propose specific, concrete changes to an existing page to close a confirmed gap against a named competitor for specific real AI-visibility prompts.',
  input_schema: {
    type: 'object',
    properties: {
      proposed_title: { type: 'string' },
      proposed_h1: { type: 'string' },
      sections_to_add: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            content_html: { type: 'string', description: 'Plain HTML (<p>,<ul>,<li>,<strong>,<em> only).' },
            reason: { type: 'string', description: 'One sentence: which specific missing term/entity/topic this addresses.' }
          },
          required: ['heading', 'content_html', 'reason']
        }
      },
      internal_linking_suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { anchor_text: { type: 'string' }, link_target_hint: { type: 'string' }, reason: { type: 'string' } },
          required: ['anchor_text', 'link_target_hint', 'reason']
        }
      },
      entity_location_signals: {
        type: 'array',
        description: 'Only ones the given evidence actually supports as missing.',
        items: { type: 'object', properties: { signal: { type: 'string' }, reason: { type: 'string' } }, required: ['signal', 'reason'] }
      },
      summary_of_changes: { type: 'string' }
    },
    required: ['proposed_title', 'proposed_h1', 'sections_to_add', 'internal_linking_suggestions', 'entity_location_signals', 'summary_of_changes']
  }
}

const IMPROVE_PAGE_SYSTEM_PROMPT = `You are a senior local SEO strategist proposing SPECIFIC edits to an EXISTING, non-homepage client page that is losing to a named competitor for specific real AI-visibility prompts. You are given the page's real current title/H1/word count, the gap-analysis engine's own evidence naming exactly which terms/depth are missing, the real losing prompts, and the winning competitor. Propose changes that specifically close the named gap -- do not propose a generic rewrite. Never invent facts about the client that weren't given to you. Every entity/location signal you propose must be directly justified by the evidence given.`

async function generateExistingPageProposal(opportunity, client, { apiKey, fetcher } = {}) {
  const detail = opportunity?.detail || {}
  const pageUrl = detail.affected_page_url
  if (!pageUrl) return { proposal: null, currentPage: null, error: { status: null, message: 'No affected_page_url on this opportunity.' } }

  const fetchResult = await fetchWebPage(pageUrl, { fetcher, redirect: 'follow' }).catch(() => null)
  const currentPage = (fetchResult && fetchResult.fetchState === 'success' && fetchResult.html)
    ? { ...extractTitleAndH1(fetchResult.html), wordCount: htmlToWordCount(fetchResult.html) }
    : null

  const payload = {
    client_context: { name: client?.name || null, domain: client?.domain || client?.url || null, city: client?.city || null, region: client?.region || null, category: client?.category || null },
    page_url: pageUrl,
    current_page: currentPage || { note: 'Could not re-fetch this page live -- proceed using only the gap evidence below.' },
    losing_prompts: (detail.supporting_prompts || []).map(p => ({ prompt: p.prompt_text, losing_engines: p.losing_engines, winning_competitors: p.winning_competitors })),
    winning_competitors: detail.winning_competitors || [],
    gap_evidence: detail.gap_evidence || [],
    recommended_action: detail.recommended_action || null
  }
  const { result, error } = await callAnthropicTool({ system: IMPROVE_PAGE_SYSTEM_PROMPT, user: JSON.stringify(payload, null, 2), tool: EXISTING_PAGE_PROPOSAL_TOOL, apiKey, maxTokens: 4096 })
  if (error || !result) return { proposal: null, currentPage, error: error || { status: null, message: 'No proposal returned.' } }
  return { proposal: result, currentPage, error: null }
}

// Fetches JUST title/h1/word count for a page, for read-only context (the
// homepage-protection case's "here's what the broad page already says,
// don't duplicate it"). Never used to justify modifying that page.
async function fetchPageContext(url, { fetcher } = {}) {
  const fetchResult = await fetchWebPage(url, { fetcher, redirect: 'follow' }).catch(() => null)
  if (!fetchResult || fetchResult.fetchState !== 'success' || !fetchResult.html) return null
  return { url, ...extractTitleAndH1(fetchResult.html), wordCount: htmlToWordCount(fetchResult.html) }
}

// ---------------------------------------------------------------------
// ORCHESTRATOR
// ---------------------------------------------------------------------

async function loadOpportunity(supabase, clientId, opportunityId) {
  const { data, error } = await supabase.from('opportunities').select('*').eq('id', opportunityId).eq('client_id', clientId).single()
  if (error || !data) return null
  return data
}

// generateExecutionPlan(clientId, opportunityId, opts) -> {
//   status: 'prepared' | 'skipped' | 'failed',
//   actionType, actionReason, protectedPage, siteQualityIssues, ...
// }
// Determines the action type FIRST (module header), then generates and
// stores the plan via the unchanged prepareWork()/opportunity_prepared_work
// mechanism. NEVER creates an Opportunity, never touches
// prompt_gap_analyses/opportunities.detail/evidence.
async function generateExecutionPlan(clientId, opportunityId, { client, apiKey = process.env.ANTHROPIC_API_KEY, fetcher, actor = 'am' } = {}) {
  const supabase = getSupabaseServerClient()
  const opportunity = await loadOpportunity(supabase, clientId, opportunityId)
  if (!opportunity) return { status: 'failed', reason: 'Opportunity not found for this client.' }

  const fromPromptGap = opportunity.detail && opportunity.detail.source_engine === 'prompt_gap_analysis'
  const { actionType, reason: actionReason, protectedPage } = determineActionType(opportunity)

  if (actionType === 'fix_technical_schema') {
    return { status: 'skipped', actionType, actionReason, reason: actionReason }
  }
  if (!fromPromptGap || !actionType) {
    return { status: 'skipped', actionType, actionReason, reason: actionReason || `No execution-plan generator is mapped for pillar "${opportunity.pillar}" / type "${opportunity.type}" yet.` }
  }

  let siteQualityIssues = []
  let generation

  if (actionType === 'create_dedicated_new_page') {
    let protectedPageContext = null
    if (protectedPage) {
      protectedPageContext = await fetchPageContext(protectedPage, { fetcher })
      siteQualityIssues = detectSiteQualityIssues({ client, currentPage: protectedPageContext, pageUrl: protectedPage })
    }
    const systemPrompt = protectedPage ? DEDICATED_PAGE_SYSTEM_PROMPT : NO_PAGE_SYSTEM_PROMPT
    const { brief, error } = await generateNewPageBrief(opportunity, client, { apiKey, systemPrompt, protectedPageContext })
    if (error || !brief) return { status: 'failed', actionType, actionReason, reason: error?.message || 'Content brief generation failed.' }
    generation = { artifactType: 'content_brief', output: brief }
  } else {
    // 'improve_existing_page' or 'expand_existing_page' -- both operate on
    // the SAME existing page, same generator; the distinction is which
    // gap category triggered it (see determineActionType), not a different
    // mechanism.
    const { proposal, currentPage, error } = await generateExistingPageProposal(opportunity, client, { apiKey, fetcher })
    if (error || !proposal) return { status: 'failed', actionType, actionReason, reason: error?.message || 'Page-edit proposal generation failed.' }
    siteQualityIssues = detectSiteQualityIssues({ client, currentPage, pageUrl: opportunity.detail.affected_page_url })
    generation = { artifactType: 'content_draft', output: { ...proposal, current_page: currentPage, page_url: opportunity.detail.affected_page_url } }
  }

  const payload = {
    action_type: actionType,
    action_reason: actionReason,
    protected_page: protectedPage,
    site_quality_issues: siteQualityIssues,
    ...generation.output
  }

  const { preparedWorkId, version } = await prepareWork({
    opportunityId, artifactType: generation.artifactType, payload,
    generationMethod: 'system_generated',
    evidenceContext: opportunity.evidence || [],
    supportsAutomatedExecution: false, createdBy: 'system', actor
  })

  return { status: 'prepared', preparedWorkId, version, artifactType: generation.artifactType, actionType, actionReason, protectedPage, siteQualityIssues, output: payload }
}

module.exports = {
  isHomepagePath, determineActionType, detectSiteQualityIssues,
  generateNewPageBrief, generateExistingPageProposal, generateExecutionPlan,
  NEW_PAGE_TOOL, EXISTING_PAGE_PROPOSAL_TOOL, loadOpportunity
}
