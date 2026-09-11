// PROMPT GAP EXECUTION PANEL (2026-09-10) -- the next step after
// lib/promptGapPreparedWork.js#generateExecutionPlan: lets an AM actually
// TAKE an already-prepared, already-reviewable execution plan and carry it
// through the same Prepare -> Review -> Approve -> Publish -> Re-fetch ->
// Verify sequence Schema Wizard already established
// (app/clients/[id]/SchemaWizard.js), reusing lib/opportunityLifecycle.js's
// shared state machine end to end. This module adds exactly the two pieces
// that don't already exist anywhere: (1) a real "current vs proposed"
// comparison built from a genuinely fresh page fetch, not the possibly-
// stale snapshot stored at generation time, and (2) a real post-publish
// verification that re-fetches the live page and checks whether the
// approved title/H1 changes are actually present -- not a manual
// attestation.
//
// WHY THIS DOES NOT AUTO-PUBLISH TO WORDPRESS: lib/wpPublish.js's
// WordPress REST integration (firestarter-ai-schema plugin) only exposes
// endpoints for JSON-LD schema injection (`/update`, `/page`) -- there is
// no endpoint anywhere for updating a post's title, H1, or body content.
// So for artifact_type content_brief/content_draft, "publish" genuinely
// has no automated path today, and this module does not invent a WordPress
// content-write feature that doesn't exist. Instead it reuses the EXACT
// same RED/handoff path app/clients/[id]/SourceCitationWizard.js already
// uses for its own manual-execution opportunities (requestHandoff ->
// recordHandoff -> recordHumanClaimedComplete, all via the existing
// generic app/api/clients/[id]/opportunities/[opportunityId]/lifecycle
// route) -- the AM applies the approved change in WordPress by hand, then
// RECORDS THE CLAIM (not a completion fact -- see recordHumanClaimedComplete's
// own header), then this module's verify step immediately re-fetches the
// live page for real. canAutoPublishToWordPress() is the one place that states this
// honestly so a future WordPress content-write endpoint has a single,
// obvious place to flip.

const { getSupabaseServerClient } = require('./supabaseServer')
const { getPreparedWork, requestVerification, recordVerification, getPriorityDimensions, computeStatusTrack, PREPARED_WORK_TABLE } = require('./opportunityLifecycle')
const { fetchWebPage } = require('./webPageFetch')
const { htmlToWordCount } = require('./checkers/content-checker')
const { extractTitleAndH1, extractHeadings } = require('./promptGapAnalysis')
const { loadOpportunity } = require('./promptGapPreparedWork')

const CONTENT_ARTIFACT_TYPES = ['content_brief', 'content_draft']

// ---------------------------------------------------------------------
// PURE LOGIC -- no DB, no network, no LLM. Independently testable.
// ---------------------------------------------------------------------

function normalizeText(s) {
  return typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : ''
}

// canAutoPublishToWordPress(artifactType) -> boolean. See module header --
// only schema_jsonld has a real WordPress write endpoint today
// (lib/wpPublish.js). Kept as its own named function (rather than an
// inline check at each call site) so the one place this is true is
// unambiguous and easy to find/update later.
function canAutoPublishToWordPress(_artifactType) {
  return false
}

// summarizeChangeSet(payload) -> a normalized, UI/API-friendly "current vs
// proposed" comparison, built from an opportunity_prepared_work payload
// (see lib/promptGapPreparedWork.js for the exact shapes stored for
// improve_existing_page/expand_existing_page vs create_dedicated_new_page).
// `livePage` (optional, {title,h1,wordCount}) overrides the payload's own
// stored current_page snapshot with a fresher fetch -- generation and
// review can happen at different times, and "current" should always mean
// "right now," not "whatever was true when this was generated."
function summarizeChangeSet(payload, { livePage } = {}) {
  const actionType = payload?.action_type || null

  if (actionType === 'improve_existing_page' || actionType === 'expand_existing_page') {
    const current = livePage || payload.current_page || null
    return {
      actionType,
      pageUrl: payload.page_url || null,
      protectedPage: payload.protected_page || null,
      title: { current: current?.title || null, proposed: payload.proposed_title || null },
      h1: { current: current?.h1 || null, proposed: payload.proposed_h1 || null },
      currentWordCount: typeof current?.wordCount === 'number' ? current.wordCount : null,
      currentHeadings: current?.headings || payload.current_page?.headings || [],
      headingsToChange: payload.headings_to_change || [],
      contentAdditions: payload.sections_to_add || [],
      internalLinks: payload.internal_linking_suggestions || [],
      entityLocationSignals: payload.entity_location_signals || [],
      summaryOfChanges: payload.summary_of_changes || null,
      siteQualityIssues: payload.site_quality_issues || [],
      completenessCheck: payload.completeness_check || null
    }
  }

  if (actionType === 'create_dedicated_new_page') {
    return {
      actionType,
      protectedPage: payload.protected_page || null,
      newPage: {
        url: payload.target_url_slug ? `/${payload.target_url_slug}` : null,
        title: payload.page_title || null,
        h1: payload.h1 || null,
        titleH1Reason: payload.title_h1_reason || null,
        metaDescription: payload.meta_description || null,
        angle: payload.angle || null,
        sections: payload.sections || []
      },
      internalLinks: payload.internal_linking_suggestions || [],
      proofRequirements: payload.proof_requirements || [],
      schemaRecommendations: payload.schema_recommendations || [],
      siteQualityIssues: payload.site_quality_issues || []
    }
  }

  return { actionType, raw: payload }
}

// compareLiveToApproved(actionType, payload, livePage) -> { matched, checks }
// The real post-publish verification logic: does the LIVE page (a fresh
// fetch, never the stored snapshot) actually reflect the approved
// title/H1? Content additions/internal links/entity signals are not
// mechanically diffable the same way (they're prose merged into a page, not
// a single field) -- verification here is intentionally scoped to the two
// concrete, checkable fields any of these artifact types propose changing,
// same discipline as lib/schemaLiveVerification.js scoping to exactly what
// was actually deployed rather than re-diagnosing everything.
function compareLiveToApproved(actionType, payload, livePage) {
  if (!livePage) return { matched: false, checks: [], reason: 'Could not fetch the live page.' }

  const checks = []
  if (actionType === 'improve_existing_page' || actionType === 'expand_existing_page') {
    if (payload.proposed_title) {
      checks.push({ field: 'title', expected: payload.proposed_title, actual: livePage.title || null, matches: normalizeText(livePage.title) === normalizeText(payload.proposed_title) })
    }
    if (payload.proposed_h1) {
      checks.push({ field: 'h1', expected: payload.proposed_h1, actual: livePage.h1 || null, matches: normalizeText(livePage.h1) === normalizeText(payload.proposed_h1) })
    }
  } else if (actionType === 'create_dedicated_new_page') {
    if (payload.page_title) {
      checks.push({ field: 'title', expected: payload.page_title, actual: livePage.title || null, matches: normalizeText(livePage.title) === normalizeText(payload.page_title) })
    }
    if (payload.h1) {
      checks.push({ field: 'h1', expected: payload.h1, actual: livePage.h1 || null, matches: normalizeText(livePage.h1) === normalizeText(payload.h1) })
    }
  }

  if (checks.length === 0) return { matched: false, checks: [], reason: 'Nothing checkable on this artifact type.' }
  return { matched: checks.every(c => c.matches), checks }
}

// ---------------------------------------------------------------------
// I/O -- read model + verification.
// ---------------------------------------------------------------------

// latestContentPreparedWork(opportunityId) -> the newest content_brief/
// content_draft prepared-work row for this opportunity, preferring the
// APPROVED one if one exists (an opportunity can accumulate draft/rejected
// versions across reruns -- the approved snapshot is the one that actually
// matters for review-after-approval and is the only one verify is allowed
// to use, per the anti-tamper convention schema/execute-work/route.js
// already established: never trust "whatever's newest," always the
// specific version that was actually approved).
async function latestContentPreparedWork(opportunity) {
  const rows = await getPreparedWork(opportunity.id)
  const contentRows = (rows || []).filter(r => CONTENT_ARTIFACT_TYPES.includes(r.artifact_type))
  if (contentRows.length === 0) return null
  if (opportunity.approved_prepared_work_id) {
    const approved = contentRows.find(r => r.id === opportunity.approved_prepared_work_id)
    if (approved) return approved
  }
  return contentRows.reduce((latest, r) => (!latest || r.version > latest.version) ? r : latest, null)
}

// buildExecutionReview(clientId, opportunityId, opts) -> {
//   opportunity, preparedWork: {id, version, status}, actionType,
//   canAutoPublish, changeSummary, existingPageAtTargetUrl
// }
// Read-only -- safe to call any time, including before approval. For
// improve/expand, re-fetches the live page NOW so "current" is genuinely
// current. For create_dedicated_new_page, does a cheap live check of the
// candidate URL so a stale plan never silently proposes "create" over a
// page that already exists there.
async function buildExecutionReview(clientId, opportunityId, { client, fetcher } = {}) {
  const supabase = getSupabaseServerClient()
  const opportunity = await loadOpportunity(supabase, clientId, opportunityId)
  if (!opportunity) return { error: 'Opportunity not found for this client.' }

  const preparedWork = await latestContentPreparedWork(opportunity)
  if (!preparedWork) return { error: 'No content execution plan has been generated for this opportunity yet.', opportunity }

  const payload = preparedWork.payload || {}
  const actionType = payload.action_type || null

  let livePage = null
  let existingPageAtTargetUrl = null

  if (actionType === 'improve_existing_page' || actionType === 'expand_existing_page') {
    const fetchResult = await fetchWebPage(payload.page_url, { fetcher, redirect: 'follow' }).catch(() => null)
    if (fetchResult && fetchResult.fetchState === 'success' && fetchResult.html) {
      livePage = { ...extractTitleAndH1(fetchResult.html), headings: extractHeadings(fetchResult.html), wordCount: htmlToWordCount(fetchResult.html) }
    }
  } else if (actionType === 'create_dedicated_new_page' && payload.target_url_slug && client?.url) {
    const candidateUrl = new URL(`/${payload.target_url_slug}`, client.url).toString()
    const fetchResult = await fetchWebPage(candidateUrl, { fetcher, redirect: 'follow' }).catch(() => null)
    if (fetchResult && fetchResult.fetchState === 'success' && fetchResult.html) {
      existingPageAtTargetUrl = { url: candidateUrl, ...extractTitleAndH1(fetchResult.html) }
    }
  }

  return {
    opportunity,
    preparedWork: { id: preparedWork.id, version: preparedWork.version, status: preparedWork.status, artifactType: preparedWork.artifact_type },
    actionType,
    canAutoPublish: canAutoPublishToWordPress(preparedWork.artifact_type),
    changeSummary: summarizeChangeSet(payload, { livePage }),
    existingPageAtTargetUrl
  }
}

// verifyExecutionReview(clientId, opportunityId, opts) -> { result, checks,
// livePage } | throws (validateExecutionGate's 'verify' gate, via
// requestVerification, rejects until execution_status is 'executed',
// 'human_completed', or 'human_claimed_complete' -- same enforcement
// Schema's verify-work route relies on; a prior failed_verification never
// blocks a retry, and retrying never requires regenerating the plan).
// Always re-reads the APPROVED prepared-work row fresh from the DB,
// never whatever version happens to be newest -- same anti-tamper
// provenance rule as schema/execute-work/route.js.
async function verifyExecutionReview(clientId, opportunityId, { client, fetcher, actor = 'am' } = {}) {
  const supabase = getSupabaseServerClient()
  const opportunity = await loadOpportunity(supabase, clientId, opportunityId)
  if (!opportunity) throw new Error('Opportunity not found for this client.')

  await requestVerification(opportunity.id, { actor })

  const rows = await getPreparedWork(opportunity.id)
  const approved = (rows || []).find(r => r.id === opportunity.approved_prepared_work_id)
  if (!approved) throw new Error('No approved prepared-work version found to verify against.')

  const payload = approved.payload || {}
  const actionType = payload.action_type || null
  const targetUrl = (actionType === 'create_dedicated_new_page' && client?.url)
    ? new URL(`/${payload.target_url_slug}`, client.url).toString()
    : payload.page_url

  const fetchResult = await fetchWebPage(targetUrl, { fetcher, redirect: 'follow' }).catch(() => null)
  const livePage = (fetchResult && fetchResult.fetchState === 'success' && fetchResult.html)
    ? { title: extractTitleAndH1(fetchResult.html).title, h1: extractTitleAndH1(fetchResult.html).h1 }
    : null

  const { matched, checks, reason } = compareLiveToApproved(actionType, payload, livePage)
  const result = matched ? 'verified' : 'failed_verification'
  await recordVerification(opportunity.id, { result, evidence: checks, actor, method: 'automated_refetch' })

  return { result, checks, reason: reason || null, livePage }
}

// getPromptGapExecutionOpportunities(clientId) -> opportunities rows
// originating from prompt-gap analysis (lib/promptGapOpportunities.js),
// each enriched with priorityDimensions/statusTrack/preparedWork -- the
// exact same read-model shape lib/sourceCitation.js#getSourceLandscape
// already builds for OpportunityCard.js, reused here rather than
// reinvented. Filters on detail.source_engine (not just pillar), since
// content_authority/entity_citation_authority are shared with other,
// non-prompt-gap opportunity sources -- the same discriminator
// lib/promptGapPreparedWork.js#generateExecutionPlan already relies on.
async function getPromptGapExecutionOpportunities(clientId) {
  const supabase = getSupabaseServerClient()
  const { data: rawOpportunities, error: oppError } = await supabase
    .from('opportunities').select('*').eq('client_id', clientId)
  if (oppError) throw oppError

  const promptGapOpportunities = (rawOpportunities || []).filter(o => o.detail?.source_engine === 'prompt_gap_analysis')
  const opportunityIds = promptGapOpportunities.map(o => o.id)

  const preparedWorkByOpportunityId = new Map()
  if (opportunityIds.length > 0) {
    const { data: preparedWorkRows, error: preparedWorkError } = await supabase
      .from(PREPARED_WORK_TABLE).select('*').in('opportunity_id', opportunityIds)
      .order('artifact_type').order('version', { ascending: false })
    if (preparedWorkError) throw preparedWorkError
    for (const pw of preparedWorkRows || []) {
      if (!preparedWorkByOpportunityId.has(pw.opportunity_id)) preparedWorkByOpportunityId.set(pw.opportunity_id, [])
      preparedWorkByOpportunityId.get(pw.opportunity_id).push(pw)
    }
  }

  return promptGapOpportunities.map(o => ({
    ...o,
    priorityDimensions: getPriorityDimensions(o),
    statusTrack: computeStatusTrack(o),
    preparedWork: preparedWorkByOpportunityId.get(o.id) || []
  }))
}

module.exports = {
  normalizeText, canAutoPublishToWordPress, summarizeChangeSet, compareLiveToApproved,
  buildExecutionReview, verifyExecutionReview, getPromptGapExecutionOpportunities
}
