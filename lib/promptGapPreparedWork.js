// PROMPT GAP ANALYSIS -> EXECUTION PLAN (2026-09-11).
//
// Turns an ALREADY-VALIDATED, ALREADY-EXISTING Opportunity (created by
// lib/promptGapOpportunities.js) into a real, reviewable execution plan,
// using the exact same lib/opportunityLifecycle.js#prepareWork() +
// opportunity_prepared_work storage every other pillar already uses
// (lib/schemaPreparedWork.js for Schema, lib/contentBrief.js for
// Competitive Position's older content_brief COLUMN -- see below for why
// this module does NOT reuse that column). Never creates a new
// Opportunity, never touches gap analysis -- this only ever runs against
// an opportunityId that already exists.
//
// WHY NOT lib/contentBrief.js DIRECTLY: that module's generateContentBrief()
// reads a Competitive-Position-shaped `detail` (keyword, volume,
// competitorDomain, realisticTier...) and writes its result into the
// `opportunities.content_brief` COLUMN -- a mechanism that predates the
// opportunity_prepared_work table and exists specifically because
// syncOpportunities() (lib/opportunities.js) overwrites `detail` wholesale
// on every audit run, so competitive_position's own brief needed a column
// that survives that overwrite. Prompt Gap Analysis opportunities are
// qualified via qualifyOpportunity() (Phase 3), never syncOpportunities(),
// so they have no such overwrite problem -- opportunity_prepared_work
// (versioned, never silently overwritten, exactly built for "prepare ->
// review -> approve -> execute -> verify") is the correct, already-general
// home. Reused here: the SAME lib/llm/anthropic.js#callAnthropicTool
// wrapper and fail-safe {result, error} contract lib/contentBrief.js and
// lib/keywordRelevance.js already established -- a new tool schema/prompt
// fitted to this module's own real evidence shape, not a new provider or
// a new failure-handling convention.
//
// SCHEMA/TECHNICAL OPPORTUNITIES ARE EXPLICITLY OUT OF SCOPE HERE -- per
// product direction, those continue through the existing Schema Wizard
// (SchemaWizard.js -> app/api/clients/[id]/schema/prepare-work/route.js ->
// lib/schemaPreparedWork.js). generateExecutionPlan() below returns a
// clear 'skipped' result for any schema_fix opportunity rather than
// attempting to generate anything.

const { getSupabaseServerClient } = require('./supabaseServer')
const { prepareWork } = require('./opportunityLifecycle')
const { callAnthropicTool } = require('./llm/anthropic')
const { fetchWebPage } = require('./webPageFetch')
const { htmlToWordCount } = require('./checkers/content-checker')
const { extractTitleAndH1 } = require('./promptGapAnalysis')

// ---------------------------------------------------------------------
// CONTENT BRIEF (opportunity type: content_brief, source_engine:
// prompt_gap_analysis) -- grounded in the REAL evidence already attached
// to the opportunity by lib/promptGapOpportunities.js (supporting prompts,
// winning competitors, the gap engine's own evidence text) -- never a
// second live fetch of anything not already captured, since that evidence
// is exactly what justified creating this opportunity in the first place.
// ---------------------------------------------------------------------

const CONTENT_BRIEF_TOOL = {
  name: 'write_content_brief',
  description: 'Write a real, publish-ready content brief for a page this client currently lacks (or has too thin), based on real AI-visibility prompts a tracked competitor wins and this client loses.',
  input_schema: {
    type: 'object',
    properties: {
      page_title: { type: 'string', description: 'The <title>/H1, written to naturally target the real losing prompt(s) given.' },
      target_url_slug: { type: 'string', description: 'A realistic URL slug, e.g. "custom-windows-denver" (no leading/trailing slashes).' },
      meta_description: { type: 'string', description: 'Under 160 characters.' },
      angle: { type: 'string', description: '2-3 sentences: what this page needs to do differently than the winning competitor\'s page, citing the REAL evidence given (e.g. its word count, what topics it covers) -- not generic SEO advice.' },
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
      }
    },
    required: ['page_title', 'target_url_slug', 'meta_description', 'angle', 'sections']
  }
}

const CONTENT_BRIEF_SYSTEM_PROMPT = `You are a senior local SEO content strategist writing a real, ready-to-publish content brief for a client business. You are given the REAL prompts real people ask AI assistants (ChatGPT, Gemini, Google, Perplexity) where a specific tracked competitor is cited and this client is not, plus the gap-analysis engine's own real evidence about why (e.g. the competitor's actual page word count, confirmed absence of a comparable client page). Ground every recommendation in that real evidence. Never invent facts about the client (credentials, awards, client counts, pricing) that weren't given to you -- write around what's actually known. Write copy substantive enough to be a real first draft, not a stub.`

async function generateContentBrief(opportunity, client, { apiKey } = {}) {
  const detail = opportunity?.detail || {}
  const payload = {
    client_context: { name: client?.name || null, domain: client?.domain || client?.url || null, city: client?.city || null, region: client?.region || null, category: client?.category || null },
    losing_prompts: (detail.supporting_prompts || []).map(p => ({ prompt: p.prompt_text, losing_engines: p.losing_engines, winning_competitors: p.winning_competitors })),
    winning_competitors: detail.winning_competitors || [],
    gap_evidence: detail.gap_evidence || [],
    recommended_action: detail.recommended_action || null
  }
  const { result, error } = await callAnthropicTool({
    system: CONTENT_BRIEF_SYSTEM_PROMPT, user: JSON.stringify(payload, null, 2), tool: CONTENT_BRIEF_TOOL, apiKey, maxTokens: 4096
  })
  if (error || !result) return { brief: null, error: error || { status: null, message: 'No brief returned.' } }
  return { brief: result, error: null }
}

// ---------------------------------------------------------------------
// RELEVANCE / ENTITY PROPOSAL (opportunity type: entity_verification,
// source_engine: prompt_gap_analysis) -- proposed CHANGES to an EXISTING
// page (title, H1, sections to add, internal linking, entity/location
// signals), grounded in that page's REAL current title/H1/word count
// (fetched fresh here -- the opportunity's own evidence names which terms
// are missing, but not the page's full current copy) plus the same real
// prompt/competitor evidence as the content brief above.
// ---------------------------------------------------------------------

const RELEVANCE_PROPOSAL_TOOL = {
  name: 'write_relevance_proposal',
  description: 'Propose specific, concrete changes to an existing page to close a confirmed relevance/entity gap against a named competitor for specific real AI-visibility prompts.',
  input_schema: {
    type: 'object',
    properties: {
      proposed_title: { type: 'string', description: 'A rewritten <title>, incorporating the specific missing terms named in the gap evidence.' },
      proposed_h1: { type: 'string', description: 'A rewritten H1.' },
      sections_to_add: {
        type: 'array',
        description: 'New sections/content additions this page needs, in reading order.',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            content_html: { type: 'string', description: 'Real, substantive draft copy for this section, plain HTML (<p>,<ul>,<li>,<strong>,<em> only).' },
            reason: { type: 'string', description: 'One sentence: which specific missing term/entity/location this section addresses.' }
          },
          required: ['heading', 'content_html', 'reason']
        }
      },
      internal_linking_suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { anchor_text: { type: 'string' }, link_target_hint: { type: 'string', description: 'What kind of page this should link to (e.g. "the client\'s doors service page", "a dedicated Littleton location page if one exists").' }, reason: { type: 'string' } },
          required: ['anchor_text', 'link_target_hint', 'reason']
        }
      },
      entity_location_signals: {
        type: 'array',
        description: 'Specific entity/location associations to reinforce on this page (service area names, named services, business-entity mentions) -- only ones the given evidence actually supports as missing.',
        items: { type: 'object', properties: { signal: { type: 'string' }, reason: { type: 'string' } }, required: ['signal', 'reason'] }
      },
      summary_of_changes: { type: 'string', description: '2-3 sentences a strategist could read alone to understand what to do and why.' }
    },
    required: ['proposed_title', 'proposed_h1', 'sections_to_add', 'internal_linking_suggestions', 'entity_location_signals', 'summary_of_changes']
  }
}

const RELEVANCE_PROPOSAL_SYSTEM_PROMPT = `You are a senior local SEO strategist proposing SPECIFIC edits to an EXISTING client page that is losing to a named competitor for specific real AI-visibility prompts, because it isn't targeted enough (e.g. it's a generic/homepage version of a page that needs to be location- or service-specific). You are given: the page's real current title/H1/word count, the gap-analysis engine's own evidence naming exactly which terms the competitor's page matches that this client's page doesn't, the real losing prompts, and the winning competitor. Propose changes that specifically close the named gap -- do not propose a generic rewrite. Never invent facts about the client (credentials, awards, other locations, services) that weren't given to you. Every entity/location signal you propose must be directly justified by the evidence given (e.g. only propose adding "Littleton" if the evidence itself names Littleton as a missing term).`

async function generateRelevanceProposal(opportunity, client, { apiKey, fetcher } = {}) {
  const detail = opportunity?.detail || {}
  const pageUrl = detail.affected_page_url
  if (!pageUrl) return { proposal: null, error: { status: null, message: 'No affected_page_url on this opportunity.' } }

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
  const { result, error } = await callAnthropicTool({
    system: RELEVANCE_PROPOSAL_SYSTEM_PROMPT, user: JSON.stringify(payload, null, 2), tool: RELEVANCE_PROPOSAL_TOOL, apiKey, maxTokens: 4096
  })
  if (error || !result) return { proposal: null, error: error || { status: null, message: 'No proposal returned.' } }
  return { proposal: result, currentPage, error: null }
}

// ---------------------------------------------------------------------
// ORCHESTRATOR
// ---------------------------------------------------------------------

async function loadOpportunity(supabase, clientId, opportunityId) {
  const { data, error } = await supabase.from('opportunities').select('*').eq('id', opportunityId).eq('client_id', clientId).single()
  if (error || !data) return null
  return data
}

// generateExecutionPlan(clientId, opportunityId, opts) -> {status, ...}.
// status: 'prepared' (a new opportunity_prepared_work version was written),
// 'skipped' (schema/technical -- use the Schema Wizard; or an unmapped
// type), or 'failed' (the LLM call itself failed -- never partially
// written). NEVER creates an Opportunity and never touches
// prompt_gap_analyses/opportunities.detail/evidence -- purely additive.
async function generateExecutionPlan(clientId, opportunityId, { client, apiKey = process.env.ANTHROPIC_API_KEY, fetcher, actor = 'am' } = {}) {
  const supabase = getSupabaseServerClient()
  const opportunity = await loadOpportunity(supabase, clientId, opportunityId)
  if (!opportunity) return { status: 'failed', reason: 'Opportunity not found for this client.' }

  const fromPromptGap = opportunity.detail && opportunity.detail.source_engine === 'prompt_gap_analysis'

  if (opportunity.pillar === 'schema_structure' || opportunity.type === 'schema_fix') {
    return { status: 'skipped', reason: 'Schema/Technical opportunities continue through the existing Schema Wizard (Prepare Schema Work) -- no separate execution plan is generated here.' }
  }

  if (opportunity.type === 'content_brief' && fromPromptGap) {
    const { brief, error } = await generateContentBrief(opportunity, client, { apiKey })
    if (error || !brief) return { status: 'failed', reason: error?.message || 'Content brief generation failed.' }
    const { preparedWorkId, version } = await prepareWork({
      opportunityId, artifactType: 'content_brief', payload: brief,
      generationMethod: 'system_generated',
      evidenceContext: opportunity.evidence || [],
      supportsAutomatedExecution: false, createdBy: 'system', actor
    })
    return { status: 'prepared', preparedWorkId, version, artifactType: 'content_brief', output: brief }
  }

  if (opportunity.type === 'entity_verification' && fromPromptGap) {
    const { proposal, currentPage, error } = await generateRelevanceProposal(opportunity, client, { apiKey, fetcher })
    if (error || !proposal) return { status: 'failed', reason: error?.message || 'Relevance proposal generation failed.' }
    const payload = { ...proposal, current_page: currentPage, page_url: opportunity.detail.affected_page_url }
    const { preparedWorkId, version } = await prepareWork({
      opportunityId, artifactType: 'content_draft', payload,
      generationMethod: 'system_generated',
      evidenceContext: opportunity.evidence || [],
      supportsAutomatedExecution: false, createdBy: 'system', actor
    })
    return { status: 'prepared', preparedWorkId, version, artifactType: 'content_draft', output: payload }
  }

  return { status: 'skipped', reason: `No execution-plan generator is mapped for pillar "${opportunity.pillar}" / type "${opportunity.type}" yet.` }
}

module.exports = {
  generateContentBrief, generateRelevanceProposal, generateExecutionPlan,
  CONTENT_BRIEF_TOOL, RELEVANCE_PROPOSAL_TOOL
}
