// PROMPT GAP ANALYSIS -> OPPORTUNITIES (2026-09-11).
//
// Connects validated lib/promptGapAnalysis.js findings into the EXISTING
// Opportunities system (lib/opportunityLifecycle.js + the `opportunities`
// table) -- no new lifecycle, no new statuses, no new UI beyond a one-line
// result surfaced on the existing PromptGapAnalysisPanel. Every write here
// goes through qualifyOpportunity(), the same shared entry point
// lib/sourceCitation.js and lib/schemaOpportunity.js already use -- this
// module invents no parallel approval/execution/verification machinery.
//
// CRITICAL RULE (explicit product direction): a prompt loss does NOT
// automatically create an Opportunity. This module only ever calls
// qualifyOpportunity for a dimension that is BOTH (a) the prompt's
// primary_gap or secondary_gap (rankGaps already only ever sets those from
// a dimension with status: 'gap' -- see lib/promptGapAnalysis.js) and
// (b) backed by real evidence and a concrete recommended_actions entry.
// confidence 'insufficient_data'/'not_applicable' can never reach here,
// because rankGaps only produces those confidences when primary/secondary
// are both null. INSUFFICIENT_DATA dimensions (content/relevance/authority/
// third_party/technical alike) are never even considered.
//
// PILLAR/TYPE REUSE (no schema migration): opportunities.pillar/type are
// both DB CHECK-constrained to a fixed, existing vocabulary (confirmed
// directly against production: pillar/originating_pillar allow
// schema_structure/technical_foundation/ai_geo_visibility/content_authority/
// competitive_position/entity_citation_authority/ai_source_citation_presence/
// entity_brand_authority; type allows content_brief/citation_target/
// schema_fix/technical_fix/entity_verification/brand_association_gap). Every
// gap dimension below maps onto whichever of those EXISTING values already
// fits, rather than adding a new one:
//   content     -> pillar content_authority,          type content_brief
//   relevance   -> pillar entity_citation_authority,   type entity_verification
//   authority   -> pillar content_authority,           type citation_target
//   third_party -> pillar ai_source_citation_presence, type citation_target
//     (same pillar+type lib/sourceCitation.js already uses for its own,
//     separately-fingerprinted per-source opportunities -- this is a
//     different question, evidenced differently, so it gets its own
//     fingerprint namespace rather than risking overwriting that module's
//     own detail shape at a shared key.)
//   technical   -> handled ENTIRELY differently, see below.
//
// TECHNICAL GAP -> THE REAL SCHEMA WIZARD PIPELINE, NOT A PARALLEL CHECK:
// lib/promptGapAnalysis.js's own Technical dimension is a deliberately
// shallow check (does ANY JSON-LD exist at all -- see computeTechnicalGap).
// The real Schema & Structure methodology (lib/pageAnalysis.js's page-type-
// dispatched Core/Recommended/Avoid checks, the same one SchemaWizard.js's
// "Analyze page" button calls) is far more rigorous, and writes a very
// specific `detail` shape (classification, targetProfile, coreChecks,
// recommendedChecks...) that SchemaWizard.js's own UI depends on. Writing a
// prompt-gap-computed detail at the SAME fingerprint
// (buildSchemaOpportunityFingerprint) would risk silently corrupting
// whatever the Wizard renders for that page. So a Technical Gap finding
// here is only ever a TRIGGER: it calls the REAL analyzePage() +
// qualifySchemaPageOpportunity() pipeline on that exact page, and an
// opportunity is created/updated ONLY if that real, existing methodology
// independently agrees a genuine gap exists -- using its own real
// fingerprint, so a same-page finding from either path is the exact same
// durable opportunity, and any future "Analyze page" click in the Wizard
// sees it too. If the real pipeline disagrees (the shallow check flagged
// missing JSON-LD but the real Core/Recommended methodology finds nothing
// actionable), NO opportunity is created -- the more rigorous,
// already-existing methodology always wins the disagreement.
//
// DEDUPLICATION: fingerprints are built from the UNDERLYING ACTION/TARGET
// (the affected page URL, or the specific competitor+source/authority-domain
// set) -- NEVER from the prompt text. Two different prompts pointing at the
// same page/target collapse into the exact same fingerprint, and therefore
// the exact same opportunities row (qualifyOpportunity's own (client_id,
// fingerprint) idempotency + decideReobservation handle the actual
// dedup/reopen/preserve-dismissed mechanics -- reused, not reinvented).
// This module's own job is just computing a STABLE, CORRECT fingerprint and
// merging supporting-prompt evidence across repeated observations (see
// mergeSupportingPrompts) before calling qualifyOpportunity, since that
// function's own refresh path replaces detail/evidence with whatever the
// caller passes -- accumulation across prompts is this module's
// responsibility, same as every other qualifyOpportunity caller recomputes
// its own full current state each time (see lib/sourceCitation.js).

const { getSupabaseServerClient } = require('./supabaseServer')
const { qualifyOpportunity, attachEvidence } = require('./opportunityLifecycle')
const { analyzePage } = require('./pageAnalysis')
const { qualifySchemaPageOpportunity } = require('./schemaOpportunity')

const OPPORTUNITIES_TABLE = 'opportunities'

const GAP_OPPORTUNITY_MAPPING = {
  content: { pillar: 'content_authority', type: 'content_brief', label: 'Content' },
  relevance: { pillar: 'entity_citation_authority', type: 'entity_verification', label: 'Relevance / Entity' },
  authority: { pillar: 'content_authority', type: 'citation_target', label: 'Authority' },
  third_party: { pillar: 'ai_source_citation_presence', type: 'citation_target', label: 'Third-Party Proof' }
  // 'technical' is intentionally absent -- see module header.
}

// ---------------------------------------------------------------------
// PURE LOGIC
// ---------------------------------------------------------------------

// normalizePageKey(url) -> a stable, case/trailing-slash-insensitive key
// for using a page URL as (part of) a fingerprint.
function normalizePageKey(url) {
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${u.pathname.replace(/\/+$/, '') || '/'}`
  } catch (e) {
    return String(url || '').toLowerCase()
  }
}

// buildOpportunityFingerprint(dimensionKey, ctx) -> string | null. Pure --
// the ONE place every dimension's "what counts as the same underlying
// action" rule lives, so it's independently testable without a DB. Returns
// null when a dimension genuinely has no stable target to key off of (that
// dimension is then reported as not_qualified, never given a made-up key).
function buildOpportunityFingerprint(dimensionKey, ctx = {}) {
  const { clientPageUrl, noPageTopicKey, competitorDomain, authorityDomains, absentSources } = ctx
  if (dimensionKey === 'content' || dimensionKey === 'relevance') {
    if (clientPageUrl) return `promptgap:${dimensionKey}:${normalizePageKey(clientPageUrl)}`
    if (dimensionKey === 'content' && noPageTopicKey) return `promptgap:content:no_page:${noPageTopicKey}`
    return null
  }
  if (dimensionKey === 'authority') {
    if (!competitorDomain || !Array.isArray(authorityDomains) || authorityDomains.length === 0) return null
    return `promptgap:authority:${competitorDomain}:${[...authorityDomains].map(d => d.toLowerCase()).sort().join(',')}`
  }
  if (dimensionKey === 'third_party') {
    if (!competitorDomain || !Array.isArray(absentSources) || absentSources.length === 0) return null
    return `promptgap:third_party:${competitorDomain}:${[...absentSources].map(d => d.toLowerCase()).sort().join(',')}`
  }
  return null
}

// mergeSupportingPrompts(existingPrompts, newEntry) -> new array, deduped by
// prompt_text. Preserves first_detected_at across re-observations; only
// last_detected_at/gap_analysis_id/losing_engines/winning_competitors move.
function mergeSupportingPrompts(existingPrompts, newEntry) {
  const list = Array.isArray(existingPrompts) ? existingPrompts : []
  const idx = list.findIndex(p => p.prompt_text === newEntry.prompt_text)
  if (idx === -1) return [...list, newEntry]
  const merged = [...list]
  merged[idx] = { ...newEntry, first_detected_at: list[idx].first_detected_at || newEntry.first_detected_at }
  return merged
}

function buildOpportunityTitle(dimensionKey, { clientPageUrl, promptText, competitorDomain, authorityDomains, absentSources }) {
  const mapping = GAP_OPPORTUNITY_MAPPING[dimensionKey]
  const label = mapping ? mapping.label : dimensionKey
  if (dimensionKey === 'content' && !clientPageUrl) return `${label}: create a page for "${promptText}"`
  if (clientPageUrl) {
    try { return `${label}: ${new URL(clientPageUrl).pathname || clientPageUrl}` } catch (e) { return `${label}: ${clientPageUrl}` }
  }
  if (dimensionKey === 'authority') return `${label}: pursue ${(authorityDomains || []).join(', ')} (vs ${competitorDomain})`
  if (dimensionKey === 'third_party') return `${label}: pursue ${(absentSources || []).join(', ')} (vs ${competitorDomain})`
  return `${label} gap for "${promptText}"`
}

// ---------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------

async function findExistingOpportunity(supabase, clientId, fingerprint) {
  const { data, error } = await supabase.from(OPPORTUNITIES_TABLE).select('*').eq('client_id', clientId).eq('fingerprint', fingerprint).maybeSingle()
  if (error) throw error
  return data
}

// qualifyStandardGapOpportunity(...) -> the shared path for content/
// relevance/authority/third_party (everything except technical). Reads any
// existing opportunity at this fingerprint first (to merge supporting
// prompts/competitors/engines across repeated observations -- see module
// header), then calls the real qualifyOpportunity with the FULL merged
// state, same convention every other qualifyOpportunity caller in this
// codebase already follows.
async function qualifyStandardGapOpportunity({
  clientId, dimensionKey, dim, fingerprint, promptText, gapAnalysisId,
  winningCompetitors = [], losingEngines = [], recommendedAction, confidence,
  clientPageUrl = null, actor = 'system'
}) {
  const mapping = GAP_OPPORTUNITY_MAPPING[dimensionKey]
  if (!mapping) return { status: 'not_qualified', reason: `No opportunity mapping exists for the "${dimensionKey}" dimension.` }

  const supabase = getSupabaseServerClient()
  const existing = await findExistingOpportunity(supabase, clientId, fingerprint)

  const nowIso = new Date().toISOString()
  const newPromptEntry = { prompt_text: promptText, gap_analysis_id: gapAnalysisId, losing_engines: losingEngines, winning_competitors: winningCompetitors, first_detected_at: nowIso, last_detected_at: nowIso }
  const mergedPrompts = mergeSupportingPrompts(existing?.detail?.supporting_prompts, newPromptEntry)
  const mergedCompetitors = [...new Set([...(existing?.detail?.winning_competitors || []), ...winningCompetitors])]
  const mergedEngines = [...new Set([...(existing?.detail?.losing_engines || []), ...losingEngines])]
  const mergedGapAnalysisIds = [...new Set([...(existing?.detail?.source_gap_analysis_ids || []), gapAnalysisId])]

  const detail = {
    source_engine: 'prompt_gap_analysis',
    gap_category: dimensionKey,
    affected_page_url: clientPageUrl,
    supporting_prompts: mergedPrompts,
    winning_competitors: mergedCompetitors,
    losing_engines: mergedEngines,
    recommended_action: recommendedAction,
    confidence,
    gap_evidence: dim.evidence || [],
    // gap_diagnosis (2026-09-11): the STRUCTURED deficits behind the prose
    // evidence above, when the dimension computed them (today: only
    // computeRelevanceGap's deepened check -- see lib/promptGapAnalysis.js).
    // A fresh snapshot from THIS run each time, same as recommended_action/
    // confidence above -- never merged/accumulated across prompts, since it
    // describes the current diagnosis, not a running history. Read directly
    // by lib/promptGapPreparedWork.js's execution-plan generator so it acts
    // on exactly what was diagnosed, never inventing gaps beyond this list.
    gap_diagnosis: dim.deficits ? {
      deficits: dim.deficits, pageIntent: dim.pageIntent || null,
      locationSpecificity: dim.locationSpecificity || null,
      internalLinkSupport: dim.internalLinkSupport || null,
      headingMatches: dim.headingMatches || null, bodyCoverage: dim.bodyCoverage || null
    } : null,
    source_gap_analysis_ids: mergedGapAnalysisIds,
    first_detected_at: existing?.detail?.first_detected_at || nowIso,
    last_detected_at: nowIso
  }

  // Evidence entries use the shared {text, source} shape OpportunityCard.js
  // and every other pillar (lib/sourceCitation.js, lib/schemaOpportunity.js)
  // already render -- one entry per supporting prompt, naming the prompt
  // itself so an AM can see exactly which real losses justify this.
  const evidence = mergedPrompts.map(p => ({
    text: `Prompt "${p.prompt_text}" (losing engines: ${(p.losing_engines || []).join(', ') || 'n/a'}; winning: ${(p.winning_competitors || []).join(', ') || 'n/a'}): ${(dim.evidence || []).join(' ')}`,
    source: 'prompt_gap_analysis'
  }))
  const relatedRefs = mergedGapAnalysisIds.map(id => ({ type: 'prompt_gap_analysis', id }))
  const title = buildOpportunityTitle(dimensionKey, { clientPageUrl, promptText: mergedPrompts[0].prompt_text, competitorDomain: winningCompetitors[0], authorityDomains: dim.competitorOnlyAuthorityDomains, absentSources: dim.absentSources })

  const { opportunityId, action } = await qualifyOpportunity({
    clientId,
    owningPillar: mapping.pillar,
    originatingPillar: mapping.pillar,
    opportunityType: mapping.type,
    fingerprint,
    title,
    detail,
    evidence,
    relatedRefs,
    executionCapability: 'red', // human execution/handoff required, same conservative default lib/schemaOpportunity.js and lib/sourceCitation.js both already use for real third-party/content work this project has no automation for yet.
    actor
  })

  const status = action === 'created' ? 'created' : (action === 'reobserved_terminal_preserved' ? 'preserved_dismissed' : 'attached_existing')
  return { status, opportunityId, title, action }
}

// qualifyTechnicalGapOpportunity(...) -> see module header. Never writes a
// prompt-gap-shaped detail into a schema_fix row -- it triggers the REAL
// existing Schema pipeline and only creates/updates an opportunity if THAT
// pipeline (independently) agrees.
async function qualifyTechnicalGapOpportunity({ clientId, client, promptText, gapAnalysisId, clientPageUrl, fetcher, actor = 'system' }) {
  if (!clientPageUrl) return { status: 'not_qualified', reason: 'No client page URL available to run the real Schema diagnostic against.' }
  let path
  try { path = new URL(clientPageUrl).pathname || '/' } catch (e) { return { status: 'not_qualified', reason: 'Client page URL could not be parsed.' } }

  const analysis = await analyzePage({ path, page: {}, siteUrl: client.url, fetcher })
  const { eligible, opportunityId, action } = await qualifySchemaPageOpportunity({ clientId, path, pageUrl: clientPageUrl, analysis, actor })

  if (!eligible) {
    return {
      status: 'not_qualified',
      reason: analysis.fetchState !== 'success'
        ? `Could not fetch ${path} to run the real Schema diagnostic.`
        : `The real Schema & Structure diagnostic (Core/Recommended checks) did not confirm a genuine gap on ${path}, even though the prompt-gap engine's shallower check flagged missing JSON-LD -- the more rigorous, already-existing methodology governs.`
    }
  }

  await attachEvidence(opportunityId, [{
    text: `Also surfaced by Prompt Gap Analysis for the prompt "${promptText}".`,
    source: 'prompt_gap_analysis'
  }], { actor, clientId }).catch(() => null) // purely additive; never blocks on failure

  const status = action === 'created' ? 'created' : (action === 'reobserved_terminal_preserved' ? 'preserved_dismissed' : 'attached_existing')
  return { status, opportunityId, action }
}

// processGapOpportunities(...) -> { [dimensionKey]: {status, opportunityId?,
// title?, reason?} } for whichever of primary_gap/secondary_gap are
// non-null. Never called for a dimension that isn't primary/secondary --
// see module header's critical rule. Each dimension's failure to qualify is
// caught and reported as 'not_qualified' with a reason, never thrown --
// this is a purely additive step onto an already-complete, already-
// persisted gap analysis.
async function processGapOpportunities({
  clientId, client, promptText, gapAnalysisId, dims, primary, secondary,
  clientPageUrl, noPageTopicKey, winningCompetitors, losingEngines,
  primaryCompetitorDomain, recommendedActions, confidence, fetcher, actor = 'am_manual'
}) {
  const keys = [...new Set([primary, secondary].filter(Boolean))]
  const results = {}
  const actionByGap = new Map((recommendedActions || []).map(a => [a.gap, a.action]))

  for (const key of keys) {
    const dim = dims[key]
    try {
      if (key === 'technical') {
        results[key] = await qualifyTechnicalGapOpportunity({ clientId, client, promptText, gapAnalysisId, clientPageUrl, fetcher, actor })
        continue
      }
      const fingerprint = buildOpportunityFingerprint(key, {
        clientPageUrl, noPageTopicKey, competitorDomain: primaryCompetitorDomain,
        authorityDomains: dim.competitorOnlyAuthorityDomains, absentSources: dim.absentSources
      })
      if (!fingerprint) {
        results[key] = { status: 'not_qualified', reason: 'No stable affected URL/entity/source could be identified for this gap.' }
        continue
      }
      results[key] = await qualifyStandardGapOpportunity({
        clientId, dimensionKey: key, dim, fingerprint, promptText, gapAnalysisId,
        winningCompetitors, losingEngines, recommendedAction: actionByGap.get(key) || null,
        confidence, clientPageUrl, actor
      })
    } catch (e) {
      results[key] = { status: 'not_qualified', reason: `Opportunity qualification failed: ${e.message || e}` }
    }
  }
  return results
}

module.exports = {
  GAP_OPPORTUNITY_MAPPING,
  normalizePageKey, buildOpportunityFingerprint, mergeSupportingPrompts, buildOpportunityTitle,
  qualifyStandardGapOpportunity, qualifyTechnicalGapOpportunity, processGapOpportunities
}
