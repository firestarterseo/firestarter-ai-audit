// Phase 3 -- Shared Opportunity, Prepared Work, Execution & Verification
// Architecture (2026-08-17).
//
// This file is the shared infrastructure every future diagnostic pillar
// (Schema & Structure, Technical Foundation, Content & Topical Relevance,
// Entity & Brand Authority, AI Source & Citation Presence, AI Visibility
// Outcome, Competitive Intelligence/Opportunity) will call into once each
// pillar's own methodology (WHAT is wrong, WHY it matters, WHAT evidence
// supports it) is built. Phase 3 itself builds none of those methodologies
// -- see ROADMAP.md and the Phase 3 spec for the explicit "do not build
// yet" list.
//
// Deliberately does NOT touch lib/opportunities.js. That file's
// syncOpportunities() is real, live production code serving the one
// pillar (Competitive Position) that's wired up today -- extending its
// exact batch-sync/auto-close contract mid-flight would be a needless risk
// to working behavior for zero benefit (no other pillar calls it yet).
// Instead, this file adds a PARALLEL, richer single-item lifecycle API
// that every *future* pillar should use directly. Both files write to the
// same `opportunities` table and are fully compatible: this file only
// ever WRITES to columns syncOpportunities never touches (see the Phase 3
// migration's header comment), and only ever READS/preserves
// syncOpportunities' own columns (status, detail, priority_score, closed_at,
// first/last_seen_audit_run_id) rather than overwriting their meaning.
//
// Core principle enforced throughout: OPPORTUNITIES ARE DURABLE OBJECTS.
// A qualified opportunity is inserted once per (client_id, fingerprint)
// and then only ever updated/appended to -- never regenerated as a
// disposable UI card. Every state transition writes one row to
// `opportunity_history` (append-only, same shape as this codebase's
// existing client_profile_field_history / topic_cluster_history ledgers)
// so the full lifecycle is reconstructable later.
//
// NO UNIVERSAL SCORE: priority_assessment intentionally keeps impact,
// effort, evidence_strength, and commercial_relevance as separate
// {level, reasoning} objects. "Automation capability" (the fifth
// dimension called out in the spec) is deliberately NOT a sixth field
// here -- it IS the `execution_capability` column (GREEN/YELLOW/RED),
// read as that dimension by getPriorityDimensions() below, so there is
// exactly one source of truth for it rather than two columns that could
// silently disagree.
//
// SCALE: every write here is a single-row upsert/update keyed by primary
// key or the (client_id, fingerprint) unique index -- no per-opportunity
// LLM calls, no full-table scans, no unbounded history fetches (history
// reads always take a limit). Designed for 70+ clients each with dozens
// of opportunities.

const { getSupabaseServerClient } = require('./supabaseServer')
const { PILLAR_IDS } = require('./pillarTaxonomy')

const OPPORTUNITY_TABLE = 'opportunities'
const PREPARED_WORK_TABLE = 'opportunity_prepared_work'
const HISTORY_TABLE = 'opportunity_history'

const PILLARS = PILLAR_IDS

const PRIORITY_TREATMENTS = ['highest_impact', 'easy_win', 'do_nothing', 'strength_protect']
const EXECUTION_CAPABILITIES = ['green', 'yellow', 'red']
const APPROVAL_STATUSES = ['not_required', 'pending', 'approved', 'rejected']
const EXECUTION_STATUSES = [
  'not_started', 'prepared', 'ready_to_execute', 'executed', 'execution_failed',
  'handoff_requested', 'handed_off', 'human_completed'
]
const VERIFICATION_STATUSES = [
  'not_ready', 'ready_to_verify', 'verifying', 'verified', 'failed_verification',
  'inconclusive', 'recheck_later'
]
const RETEST_STATUSES = ['not_eligible', 'eligible', 'requested', 'due', 'completed']
const DISPOSITION_REASONS = [
  'no_longer_observed', 'verified_fixed', 'am_do_nothing', 'am_rejected', 'duplicate',
  'weak_evidence', 'low_commercial_relevance', 'already_adequately_represented',
  'poor_eligibility', 'effort_outweighs_impact', 'no_legitimate_intervention',
  'manipulative_action_required', 'issue_no_longer_exists', 'am_decided_against_action'
]
const ARTIFACT_TYPES = [
  'schema_jsonld', 'content_brief', 'content_draft', 'technical_fix', 'source_submission',
  'outreach_pitch', 'directory_profile_update', 'wordpress_change', 'other'
]
const PREPARED_WORK_STATUSES = ['draft', 'preparation_failed', 'ready_for_review', 'approved', 'superseded', 'rejected']

const REASONS_THAT_ARE_AM_DO_NOTHING_STYLE = new Set([
  'am_do_nothing', 'am_rejected', 'duplicate', 'weak_evidence', 'low_commercial_relevance',
  'already_adequately_represented', 'poor_eligibility', 'effort_outweighs_impact',
  'no_legitimate_intervention', 'manipulative_action_required', 'am_decided_against_action'
])

function assertOneOf(value, allowed, label) {
  if (value != null && !allowed.includes(value)) {
    throw new Error(`Invalid ${label} "${value}". Must be one of: ${allowed.join(', ')} (or null).`)
  }
}

// ---------------------------------------------------------------------
// PURE LOGIC -- no DB, no LLM. Every rule the spec calls out as a
// governance/state-machine rule lives here so it can be unit-tested
// directly (see lib/opportunityLifecycle.pure.test.js) without needing
// SUPABASE_SERVICE_ROLE_KEY, which this sandbox never has.
// ---------------------------------------------------------------------

// buildPriorityAssessment({impact, effort, evidenceStrength, commercialRelevance,
//   treatmentReasoning, treatmentEvidence}) -> the jsonb payload stored in
// opportunities.priority_assessment. Each dimension is independently
// optional (a pillar may not have evidence for all of them yet) and never
// collapsed into a single number.
function buildPriorityAssessment({
  impact = null, effort = null, evidenceStrength = null, commercialRelevance = null,
  treatmentReasoning = null, treatmentEvidence = []
} = {}) {
  const dim = (level, reasoning) => (level == null && reasoning == null) ? null : { level: level || 'unknown', reasoning: reasoning || null }
  return {
    impact: dim(impact?.level, impact?.reasoning),
    effort: dim(effort?.level, effort?.reasoning),
    evidence_strength: dim(evidenceStrength?.level, evidenceStrength?.reasoning),
    commercial_relevance: dim(commercialRelevance?.level, commercialRelevance?.reasoning),
    treatment_reasoning: treatmentReasoning || null,
    treatment_evidence: Array.isArray(treatmentEvidence) ? treatmentEvidence : []
  }
}

// getPriorityDimensions(opportunityRow) -> the 5 dimensions the spec
// requires be kept separate, as a flat read-only view. This is the ONE
// place automation_capability is derived from execution_capability --
// never stored twice.
function getPriorityDimensions(row) {
  const pa = row?.priority_assessment || {}
  return {
    impact: pa.impact || { level: 'unknown', reasoning: null },
    effort: pa.effort || { level: 'unknown', reasoning: null },
    automation_capability: { level: row?.execution_capability || 'unknown', reasoning: null },
    evidence_strength: pa.evidence_strength || { level: 'unknown', reasoning: null },
    commercial_relevance: pa.commercial_relevance || { level: 'unknown', reasoning: null }
  }
}

// nextPreparedWorkVersion(existingVersions) -> next integer version number
// for a given (opportunity_id, artifact_type) pair. Pure so the
// version-numbering rule ("never overwrite, always increment") is
// independently testable.
function nextPreparedWorkVersion(existingVersions) {
  const list = Array.isArray(existingVersions) ? existingVersions : []
  if (list.length === 0) return 1
  return Math.max(...list) + 1
}

// validateExecutionGate(row, action) -> { ok: true } | { ok: false, reason }
// The single place the GREEN/YELLOW/RED governance rules live:
//   - YELLOW must have approval_status === 'approved' before 'execute'.
//   - RED can never 'execute' (automated) -- only handoff actions.
//   - GREEN may execute without a prior approval requirement.
//   - 'verify' (added 2026-09-01, Phase 1.1): real work must have actually
//     completed -- execution_status must be 'executed' (a successful
//     GREEN/YELLOW executeOpportunity call) or 'human_completed' (a RED
//     handoff a human confirmed was actually done) -- before an
//     opportunity is eligible to move into verification. This is the
//     shared gate requestVerification() itself now enforces (see below),
//     so no caller -- UI, route, or future pillar -- can move an
//     opportunity into ready_to_verify before the underlying work is
//     genuinely finished (not merely approved, handed off, or attempted-
//     and-failed).
// This does NOT decide impact/effort -- execution capability is
// deliberately orthogonal to the priority model (see module header).
function validateExecutionGate(row, action) {
  const capability = row?.execution_capability || null
  if (action === 'execute') {
    if (capability === 'red') {
      return { ok: false, reason: 'RED opportunities require human execution/handoff -- call requestHandoff/recordHandoff instead of executeOpportunity.' }
    }
    if (capability === 'yellow' && row?.approval_status !== 'approved') {
      return { ok: false, reason: 'YELLOW opportunities require AM approval (approval_status = "approved") before execution.' }
    }
    return { ok: true }
  }
  if (action === 'handoff') {
    if (capability !== 'red' && capability !== null) {
      return { ok: false, reason: 'Handoff actions are for RED (human-execution-required) opportunities.' }
    }
    return { ok: true }
  }
  if (action === 'verify') {
    const completedExecutionStatuses = ['executed', 'human_completed']
    if (!completedExecutionStatuses.includes(row?.execution_status)) {
      return {
        ok: false,
        reason: `Verification cannot be requested until execution actually completed (execution_status must be "executed" or "human_completed", was "${row?.execution_status || 'not_started'}"). Call executeOpportunity (GREEN/YELLOW) or recordHumanCompleted (RED, after handoff) first.`
      }
    }
    return { ok: true }
  }
  return { ok: true }
}

// decideReobservation(existingRow) -> what qualifyOpportunity should do
// when a fingerprint that already exists is observed again. Pure decision
// table, independently testable -- this is the "reopen/recur
// intelligently" logic the spec asks for, kept separate from the actual
// DB write so its rules can be verified without a database.
//
// Returns one of:
//   'refresh_only'              -- status open/in_progress: just refresh
//                                   detail/evidence/last_observed_at.
//   'preserve_dismissed_am_call' -- status dismissed for an AM-driven
//                                   reason (do_nothing/rejected/etc.):
//                                   never silently override a strategist's
//                                   "not worth it" call. Refresh evidence
//                                   only, log re_observed_while_dismissed.
//   'reopen_after_verified_regression' -- status done AND the prior
//                                   resolution was disposition_reason
//                                   'verified_fixed': this is a genuine
//                                   regression, not a false negative --
//                                   reopen and increment recurrence_count.
//   'reopen_after_reappeared'   -- status done for any other reason (e.g.
//                                   legacy auto-close 'no_longer_observed'):
//                                   it was never actually verified fixed,
//                                   so simply reopen -- no confusion about
//                                   overriding a real verification.
function decideReobservation(existingRow) {
  if (!existingRow) return 'insert'
  const status = existingRow.status
  if (status === 'open' || status === 'in_progress') return 'refresh_only'
  if (status === 'dismissed') {
    if (REASONS_THAT_ARE_AM_DO_NOTHING_STYLE.has(existingRow.disposition_reason)) {
      return 'preserve_dismissed_am_call'
    }
    // Dismissed with no AM-do-nothing reason on record (e.g. legacy rows
    // predating Phase 3, or dismissed via the old PATCH route with no
    // reason captured) -- still an AM's explicit call via the dismissed
    // status itself, so preserve it. Only a recorded do-nothing STYLE
    // reason changes this; ambiguity defaults to "don't silently override."
    return 'preserve_dismissed_am_call'
  }
  if (status === 'done') {
    if (existingRow.disposition_reason === 'verified_fixed') return 'reopen_after_verified_regression'
    return 'reopen_after_reappeared'
  }
  return 'refresh_only'
}

// computeStatusTrack(opportunityRow) -> ordered array of
// { stage, state: 'completed'|'current'|'pending'|'skipped' } for the
// shared Status Track UI: IDENTIFIED -> PREPARED -> APPROVED ->
// EXECUTED/HANDED OFF -> VERIFIED -> RETESTED. Pure/derived from the
// granular status columns, never stored redundantly, so it can never
// drift out of sync with the columns it summarizes, and never falsely
// marks a skipped stage as completed.
function computeStatusTrack(row) {
  const stages = []
  stages.push({ stage: 'identified', state: 'completed' })

  const hasPreparedWork = row?.approved_prepared_work_id != null || row?.execution_status !== 'not_started' || row?._hasPreparedWork
  stages.push({ stage: 'prepared', state: hasPreparedWork ? 'completed' : (stages.length === 1 ? 'current' : 'pending') })

  const approvalDone = row?.approval_status === 'approved'
  const approvalSkipped = row?.approval_status === 'not_required' && row?.execution_capability === 'green'
  stages.push({
    stage: 'approved',
    state: approvalDone ? 'completed' : approvalSkipped ? 'skipped' : (hasPreparedWork ? 'current' : 'pending')
  })

  const executedStates = ['executed', 'handed_off', 'human_completed']
  const executionDone = executedStates.includes(row?.execution_status)
  stages.push({
    stage: 'executed_or_handed_off',
    state: executionDone ? 'completed' : ((approvalDone || approvalSkipped) ? 'current' : 'pending')
  })

  const verifiedDone = row?.verification_status === 'verified'
  const verificationNotApplicable = row?.verification_status === 'not_ready' && !executionDone
  stages.push({
    stage: 'verified',
    state: verifiedDone ? 'completed' : (executionDone ? 'current' : (verificationNotApplicable ? 'pending' : 'pending'))
  })

  const retestDone = row?.retest_status === 'completed'
  const retestNotEligible = row?.retest_status === 'not_eligible'
  stages.push({
    stage: 'retested',
    state: retestDone ? 'completed' : (retestNotEligible ? 'pending' : (verifiedDone ? 'current' : 'pending'))
  })

  return stages
}

function nowIso() { return new Date().toISOString() }

async function insertHistory(supabase, { clientId, opportunityId, preparedWorkId = null, eventType, previousValue = null, newValue = null, actor, reason = null }) {
  const { error } = await supabase.from(HISTORY_TABLE).insert({
    client_id: clientId,
    opportunity_id: opportunityId,
    prepared_work_id: preparedWorkId,
    event_type: eventType,
    previous_value: previousValue,
    new_value: newValue,
    actor,
    reason
  })
  if (error) throw error
}

async function getOpportunityById(supabase, opportunityId) {
  const { data, error } = await supabase.from(OPPORTUNITY_TABLE).select('*').eq('id', opportunityId).single()
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------
// QUALIFY / RE-OBSERVE -- the shared "a pillar determined a real
// opportunity exists" entry point. One opportunity at a time (unlike
// lib/opportunities.js's batch syncOpportunities), since Phase 3 pillars
// qualify findings as they diagnose rather than syncing a full list per
// run. Idempotent by (client_id, fingerprint), same durable-identity
// philosophy as the existing table.
// ---------------------------------------------------------------------

// qualifyOpportunity(input) -> { opportunityId, action }
// input: { clientId, auditRunId, owningPillar, originatingPillar,
//   opportunityType, fingerprint, title, detail, evidence, relatedRefs,
//   topicClusterId, promptVariationId, priorityAssessment,
//   priorityTreatment, executionCapability, actor }
// This does NOT invent an opportunity from a bare observation -- the
// caller (a pillar's own methodology) must have already decided a
// meaningful gap + legitimate intervention + plausible value exist. This
// function only persists that qualified decision durably.
async function qualifyOpportunity(input) {
  const {
    clientId, auditRunId = null, owningPillar, originatingPillar = null,
    opportunityType, fingerprint, title, detail = {}, evidence = [],
    relatedRefs = [], topicClusterId = null, promptVariationId = null,
    priorityAssessment = null, priorityTreatment = null, executionCapability = null,
    actor = 'system'
  } = input || {}

  if (!clientId) throw new Error('qualifyOpportunity requires clientId.')
  if (!fingerprint) throw new Error('qualifyOpportunity requires a stable fingerprint.')
  assertOneOf(owningPillar, PILLARS, 'owningPillar')
  assertOneOf(originatingPillar, PILLARS, 'originatingPillar')
  assertOneOf(priorityTreatment, PRIORITY_TREATMENTS, 'priorityTreatment')
  assertOneOf(executionCapability, EXECUTION_CAPABILITIES, 'executionCapability')

  const supabase = getSupabaseServerClient()
  const { data: existing, error: findError } = await supabase
    .from(OPPORTUNITY_TABLE)
    .select('*')
    .eq('client_id', clientId)
    .eq('fingerprint', fingerprint)
    .maybeSingle()
  if (findError) throw findError

  const decision = decideReobservation(existing)
  const now = nowIso()

  if (decision === 'insert') {
    const { data: created, error } = await supabase.from(OPPORTUNITY_TABLE).insert({
      client_id: clientId,
      pillar: owningPillar,
      originating_pillar: originatingPillar,
      type: opportunityType,
      fingerprint,
      title,
      detail,
      evidence,
      related_refs: relatedRefs,
      topic_cluster_id: topicClusterId,
      prompt_variation_id: promptVariationId,
      status: 'open',
      priority_assessment: priorityAssessment || {},
      priority_treatment: priorityTreatment,
      execution_capability: executionCapability,
      first_seen_audit_run_id: auditRunId,
      last_seen_audit_run_id: auditRunId,
      last_observed_at: now,
      updated_at: now
    }).select().single()
    if (error) throw error
    await insertHistory(supabase, {
      clientId, opportunityId: created.id, eventType: 'qualified', actor,
      newValue: { title, opportunityType, owningPillar, originatingPillar }
    })
    return { opportunityId: created.id, action: 'created' }
  }

  const updates = {
    title, detail, evidence, related_refs: relatedRefs,
    last_observed_at: now, updated_at: now
  }
  if (auditRunId) updates.last_seen_audit_run_id = auditRunId

  if (decision === 'refresh_only') {
    const { error } = await supabase.from(OPPORTUNITY_TABLE).update(updates).eq('id', existing.id)
    if (error) throw error
    await insertHistory(supabase, { clientId, opportunityId: existing.id, eventType: 're_observed', actor })
    return { opportunityId: existing.id, action: 'reobserved_open' }
  }

  if (decision === 'preserve_dismissed_am_call') {
    const { error } = await supabase.from(OPPORTUNITY_TABLE).update({ evidence, related_refs: relatedRefs, last_observed_at: now, updated_at: now }).eq('id', existing.id)
    if (error) throw error
    await insertHistory(supabase, {
      clientId, opportunityId: existing.id, eventType: 're_observed_while_dismissed', actor,
      reason: 'Still observed, but an AM previously decided against action -- status left dismissed rather than silently reopened.'
    })
    return { opportunityId: existing.id, action: 'reobserved_terminal_preserved' }
  }

  if (decision === 'reopen_after_verified_regression' || decision === 'reopen_after_reappeared') {
    const previousSnapshot = {
      status: existing.status, disposition_reason: existing.disposition_reason,
      verification_status: existing.verification_status, verified_at: existing.verified_at
    }
    const reopenUpdates = {
      ...updates,
      status: 'open',
      closed_at: null,
      resolved_at: null,
      verification_status: 'not_ready',
      execution_status: existing.execution_status === 'executed' || existing.execution_status === 'human_completed' ? existing.execution_status : 'not_started',
      disposition_reason: null,
      recurrence_count: (existing.recurrence_count || 0) + 1
    }
    const { error } = await supabase.from(OPPORTUNITY_TABLE).update(reopenUpdates).eq('id', existing.id)
    if (error) throw error
    await insertHistory(supabase, {
      clientId, opportunityId: existing.id,
      eventType: decision === 'reopen_after_verified_regression' ? 'recurred' : 'reopened',
      actor, previousValue: previousSnapshot, newValue: { status: 'open' },
      reason: decision === 'reopen_after_verified_regression'
        ? 'Re-observed after a prior verified fix -- treated as a genuine regression, not a false negative.'
        : 'Re-observed after being auto-closed as no-longer-observed (never formally verified fixed) -- reopened.'
    })
    return { opportunityId: existing.id, action: decision === 'reopen_after_verified_regression' ? 'recurred' : 'reopened' }
  }

  throw new Error(`Unhandled reobservation decision: ${decision}`)
}

// attachEvidence(opportunityId, evidenceItems, {actor}) -> appends new
// evidence rather than silently discarding the prior array (the current
// list is REPLACED with previous+new, and the replacement itself is
// logged to history so the "before" state is never just lost).
async function attachEvidence(opportunityId, evidenceItems, { actor = 'system', clientId = null } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const merged = [...(row.evidence || []), ...(Array.isArray(evidenceItems) ? evidenceItems : [])]
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update({ evidence: merged, updated_at: nowIso() }).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, {
    clientId: clientId || row.client_id, opportunityId, eventType: 're_observed', actor,
    previousValue: { evidence: row.evidence }, newValue: { evidence: merged }, reason: 'Evidence attached.'
  })
  return { opportunityId, evidenceCount: merged.length }
}

// setPriorityTreatment(opportunityId, {...}) -> the AM-visible "why did
// this get Highest Impact / Easy Win / Do Nothing / Strength-Protect"
// record. Any pillar can call this after qualifyOpportunity with its own
// reasoning -- the shared layer never invents a treatment from a formula.
async function setPriorityTreatment(opportunityId, {
  treatment = null, impact = null, effort = null, evidenceStrength = null,
  commercialRelevance = null, executionCapability = null, reasoning = null,
  evidenceRefs = [], actor = 'system'
} = {}) {
  assertOneOf(treatment, PRIORITY_TREATMENTS, 'treatment')
  assertOneOf(executionCapability, EXECUTION_CAPABILITIES, 'executionCapability')
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const previousAssessment = { priority_treatment: row.priority_treatment, priority_assessment: row.priority_assessment, execution_capability: row.execution_capability }

  const priorityAssessment = buildPriorityAssessment({ impact, effort, evidenceStrength, commercialRelevance, treatmentReasoning: reasoning, treatmentEvidence: evidenceRefs })
  const updates = { priority_assessment: priorityAssessment, updated_at: nowIso() }
  if (treatment !== undefined) updates.priority_treatment = treatment
  if (executionCapability !== undefined) updates.execution_capability = executionCapability

  const { error } = await supabase.from(OPPORTUNITY_TABLE).update(updates).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, {
    clientId: row.client_id, opportunityId,
    eventType: row.priority_treatment ? 'priority_changed' : 'priority_set',
    actor, previousValue: previousAssessment, newValue: { treatment, priorityAssessment, executionCapability }, reason: reasoning
  })
  return { opportunityId, treatment, priorityAssessment }
}

// ---------------------------------------------------------------------
// PREPARED WORK
// ---------------------------------------------------------------------

// prepareWork({opportunityId, artifactType, payload, generationMethod,
//   evidenceContext, supportsAutomatedExecution, createdBy, actor}) ->
// { preparedWorkId, version }. Always inserts a NEW version row -- never
// updates a prior version's payload in place (spec: "Do not overwrite
// prior versions silently").
async function prepareWork({
  opportunityId, artifactType, payload = {}, generationMethod = 'system_generated',
  evidenceContext = [], supportsAutomatedExecution = false, createdBy = 'system',
  previousVersionId = null, actor = 'system'
}) {
  assertOneOf(artifactType, ARTIFACT_TYPES, 'artifactType')
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)

  const { data: existingVersions, error: verError } = await supabase
    .from(PREPARED_WORK_TABLE).select('version').eq('opportunity_id', opportunityId).eq('artifact_type', artifactType)
  if (verError) throw verError
  const version = nextPreparedWorkVersion((existingVersions || []).map(v => v.version))

  const status = generationMethod === 'system_failed' ? 'preparation_failed' : 'ready_for_review'

  const { data: created, error } = await supabase.from(PREPARED_WORK_TABLE).insert({
    opportunity_id: opportunityId,
    artifact_type: artifactType,
    version,
    payload,
    generation_method: generationMethod,
    evidence_context: evidenceContext,
    status,
    supports_automated_execution: supportsAutomatedExecution,
    previous_version_id: previousVersionId,
    created_by: createdBy
  }).select().single()
  if (error) throw error

  // Preparation failure NEVER closes or invalidates the opportunity --
  // qualification and preparation are separate states. Only
  // execution_status reflects "prepared" once a version is genuinely
  // ready_for_review.
  const oppUpdates = { updated_at: nowIso() }
  if (status === 'ready_for_review' && row.execution_status === 'not_started') {
    oppUpdates.execution_status = 'prepared'
  }
  const { error: oppError } = await supabase.from(OPPORTUNITY_TABLE).update(oppUpdates).eq('id', opportunityId)
  if (oppError) throw oppError

  await insertHistory(supabase, {
    clientId: row.client_id, opportunityId, preparedWorkId: created.id,
    eventType: status === 'preparation_failed' ? 'preparation_failed' : 'prepared',
    actor, newValue: { artifactType, version, status, generationMethod }
  })

  return { preparedWorkId: created.id, version, status }
}

// ---------------------------------------------------------------------
// APPROVAL
// ---------------------------------------------------------------------

// submitForApproval(opportunityId, {preparedWorkId, actor}) -> marks a
// specific prepared-work version ready_for_review and sets the
// opportunity's approval_status to 'pending' (idempotent).
async function submitForApproval(opportunityId, { preparedWorkId = null, actor = 'system' } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update({ approval_status: 'pending', updated_at: nowIso() }).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, {
    clientId: row.client_id, opportunityId, preparedWorkId, eventType: 'submitted_for_approval', actor
  })
  return { opportunityId, approvalStatus: 'pending' }
}

// approveOpportunity(opportunityId, {preparedWorkId, actor, edited}) ->
// approve, or edit-then-approve. "edited: true" only changes which
// history event is logged (edited_then_approved vs approved) -- the
// EDIT itself must already exist as its own prepared-work version
// (created via prepareWork({createdBy:'am', previousVersionId, ...})
// BEFORE calling this) so the edited content is durably preserved as a
// version in its own right, never inlined into the approval event.
async function approveOpportunity(opportunityId, { preparedWorkId = null, actor = 'am', edited = false, notes = null } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)

  const updates = { approval_status: 'approved', updated_at: nowIso() }
  if (preparedWorkId) updates.approved_prepared_work_id = preparedWorkId
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update(updates).eq('id', opportunityId)
  if (error) throw error

  if (preparedWorkId) {
    const { error: pwError } = await supabase.from(PREPARED_WORK_TABLE).update({ status: 'approved', updated_at: nowIso() }).eq('id', preparedWorkId)
    if (pwError) throw pwError
  }

  await insertHistory(supabase, {
    clientId: row.client_id, opportunityId, preparedWorkId,
    eventType: edited ? 'edited_then_approved' : 'approved',
    actor, reason: notes, previousValue: { approval_status: row.approval_status }, newValue: { approval_status: 'approved', preparedWorkId }
  })
  return { opportunityId, approvalStatus: 'approved' }
}

// rejectOpportunity(opportunityId, {reason, detail, actor}) -> the
// explicit Do Nothing / reject path. Never deletes the row -- Do Nothing
// is a legitimate, durable outcome with a stored reason.
async function rejectOpportunity(opportunityId, { reason, detail = null, actor = 'am' } = {}) {
  assertOneOf(reason, DISPOSITION_REASONS, 'reason')
  if (!reason) throw new Error('rejectOpportunity requires a disposition reason.')
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)

  const { error } = await supabase.from(OPPORTUNITY_TABLE).update({
    approval_status: 'rejected',
    status: 'dismissed',
    priority_treatment: 'do_nothing',
    disposition_reason: reason,
    disposition_detail: detail,
    closed_at: nowIso(),
    updated_at: nowIso()
  }).eq('id', opportunityId)
  if (error) throw error

  await insertHistory(supabase, {
    clientId: row.client_id, opportunityId, eventType: 'do_nothing', actor, reason,
    previousValue: { status: row.status, approval_status: row.approval_status }, newValue: { status: 'dismissed', reason }
  })
  return { opportunityId, status: 'dismissed', reason }
}

// markStrengthProtect(opportunityId, {reasoning, evidenceRefs, actor}) --
// preserves "this is currently strong, don't accidentally break it" as
// durable reference intelligence. Deliberately given priority_treatment
// 'strength_protect' (not 'do_nothing') and status left 'open' so future
// views can exclude it from the action queue (per spec, treatment !==
// do_nothing) while it stays queryable for future rechecks.
async function markStrengthProtect(opportunityId, { reasoning = null, evidenceRefs = [], actor = 'system' } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const priorityAssessment = buildPriorityAssessment({ treatmentReasoning: reasoning, treatmentEvidence: evidenceRefs })
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update({
    priority_treatment: 'strength_protect', priority_assessment: priorityAssessment, updated_at: nowIso()
  }).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, { clientId: row.client_id, opportunityId, eventType: 'strength_protect_set', actor, reason: reasoning })
  return { opportunityId, treatment: 'strength_protect' }
}

// ---------------------------------------------------------------------
// EXECUTION / HANDOFF -- honest states only. Never marks EXECUTED unless
// something real happened; never fabricates a handoff.
// ---------------------------------------------------------------------

// executeOpportunity(opportunityId, {method, result, actor}) -> for
// GREEN/YELLOW opportunities where the caller (a pillar's own execution
// integration, e.g. lib/wpPublish.js for schema) actually performed a
// real action. `result` must be the real outcome the integration
// returned -- this function does not call any integration itself, it
// only records the outcome durably and enforces the approval gate.
async function executeOpportunity(opportunityId, { method, result, actor = 'system' } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const gate = validateExecutionGate(row, 'execute')
  if (!gate.ok) throw new Error(gate.reason)

  const success = !!(result && result.ok !== false)
  const updates = {
    execution_status: success ? 'executed' : 'execution_failed',
    execution_state: { method, result, at: nowIso() },
    updated_at: nowIso()
  }
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update(updates).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, {
    clientId: row.client_id, opportunityId,
    eventType: success ? 'executed' : 'execution_failed',
    actor, newValue: { method, result }
  })
  return { opportunityId, executionStatus: updates.execution_status }
}

// requestHandoff(opportunityId, {instructions, actor}) -> RED path,
// step 1: the work is prepared and ready for a human, but nothing has
// been handed to anyone yet.
async function requestHandoff(opportunityId, { instructions = null, actor = 'system' } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const gate = validateExecutionGate(row, 'handoff')
  if (!gate.ok) throw new Error(gate.reason)
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update({
    execution_status: 'handoff_requested',
    execution_state: { ...(row.execution_state || {}), instructions, requested_at: nowIso() },
    updated_at: nowIso()
  }).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, { clientId: row.client_id, opportunityId, eventType: 'handoff_requested', actor, reason: instructions })
  return { opportunityId, executionStatus: 'handoff_requested' }
}

// recordHandoff(opportunityId, {method, reference, actor}) -> RED path,
// step 2: the work was ACTUALLY delivered to a human/external system
// (e.g. a real Asana task id, an email sent, a ticket filed). `reference`
// should be a real identifier/URL -- this function never claims a
// handoff happened on its own; the caller must supply proof. A preview
// card (see TechnicalDevAssignee.js's existing Asana-preview mock) is
// explicitly NOT a handoff -- do not call this for previews.
async function recordHandoff(opportunityId, { method, reference = null, actor = 'system' } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update({
    execution_status: 'handed_off',
    execution_state: { ...(row.execution_state || {}), method, reference, handed_off_at: nowIso() },
    updated_at: nowIso()
  }).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, { clientId: row.client_id, opportunityId, eventType: 'handed_off', actor, newValue: { method, reference } })
  return { opportunityId, executionStatus: 'handed_off' }
}

// recordHumanCompleted(opportunityId, {notes, actor}) -> a human (AM or
// external party) confirms the handed-off work is actually done. This is
// TASK/EXECUTION COMPLETION only -- it does not imply verification.
async function recordHumanCompleted(opportunityId, { notes = null, actor = 'am' } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update({
    execution_status: 'human_completed',
    execution_state: { ...(row.execution_state || {}), completed_notes: notes, completed_at: nowIso() },
    updated_at: nowIso()
  }).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, { clientId: row.client_id, opportunityId, eventType: 'human_completed', actor, reason: notes })
  return { opportunityId, executionStatus: 'human_completed' }
}

// ---------------------------------------------------------------------
// VERIFICATION -- independent of execution. Pillar supplies the
// mechanism (a real re-check); this layer stores state + evidence only.
// ---------------------------------------------------------------------

// requestVerification(opportunityId, {actor}) -> the ONE legitimate way an
// opportunity moves from verification_status 'not_ready' to
// 'ready_to_verify'. Gated by validateExecutionGate(row, 'verify') (added
// 2026-09-01, Phase 1.1): the underlying execution/handoff must have
// actually completed first -- this is not optional UI polish, it's
// enforced here so nothing (a route, a future pillar, a UI bug) can ever
// mark an opportunity ready to verify before real work happened.
async function requestVerification(opportunityId, { actor = 'system' } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const gate = validateExecutionGate(row, 'verify')
  if (!gate.ok) throw new Error(gate.reason)
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update({ verification_status: 'ready_to_verify', updated_at: nowIso() }).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, { clientId: row.client_id, opportunityId, eventType: 'verification_requested', actor })
  return { opportunityId, verificationStatus: 'ready_to_verify' }
}

// recordVerification(opportunityId, {result, evidence, actor}) -> result
// must be one of verified/failed_verification/inconclusive/recheck_later.
// Only 'verified' sets verified_at/resolved_at and the legacy `status`
// column to 'done' (kept in sync so existing UI reflects it) with
// disposition_reason 'verified_fixed'. Failed verification explicitly
// stays actionable -- status is NOT closed.
async function recordVerification(opportunityId, { result, evidence = [], actor = 'system', method = null } = {}) {
  assertOneOf(result, ['verified', 'failed_verification', 'inconclusive', 'recheck_later'], 'result')
  if (!result) throw new Error('recordVerification requires a result.')
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)

  const updates = {
    verification_status: result,
    verification_state: { ...(row.verification_state || {}), method, evidence, checked_at: nowIso() },
    updated_at: nowIso()
  }
  if (result === 'verified') {
    updates.verified_at = nowIso()
    updates.resolved_at = nowIso()
    updates.status = 'done'
    updates.closed_at = nowIso()
    updates.disposition_reason = 'verified_fixed'
    updates.retest_status = row.retest_status === 'not_eligible' ? 'eligible' : row.retest_status
  }

  const { error } = await supabase.from(OPPORTUNITY_TABLE).update(updates).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, {
    clientId: row.client_id, opportunityId,
    eventType: result === 'verified' ? 'verified' : result,
    actor, newValue: { result, evidence }
  })
  return { opportunityId, verificationStatus: result }
}

// ---------------------------------------------------------------------
// RETEST -- relationship/state only. The actual future AI-visibility
// measurement engine is explicitly out of Phase 3 scope; this just gives
// that future engine somewhere durable to attach a result.
// ---------------------------------------------------------------------

async function requestRetest(opportunityId, { dueAt = null, actor = 'system' } = {}) {
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const status = dueAt ? 'due' : 'requested'
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update({
    retest_status: status,
    retest_state: { ...(row.retest_state || {}), requested_at: nowIso(), due_at: dueAt },
    updated_at: nowIso()
  }).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, { clientId: row.client_id, opportunityId, eventType: 'retest_requested', actor })
  return { opportunityId, retestStatus: status }
}

// recordRetestResult(opportunityId, {outcome, notes, observationRef,
//   aiVisibilityOutcomeStatus, actor}) -> attaches WITHOUT overwriting
// verification_status/verified_at (the original verification record is a
// distinct, preserved fact from this later retest observation).
async function recordRetestResult(opportunityId, { outcome, notes = null, observationRef = null, aiVisibilityOutcomeStatus = null, actor = 'system' } = {}) {
  assertOneOf(aiVisibilityOutcomeStatus, ['not_applicable', 'pending_recheck', 'not_yet_cited', 'cited', 'regressed'], 'aiVisibilityOutcomeStatus')
  const supabase = getSupabaseServerClient()
  const row = await getOpportunityById(supabase, opportunityId)
  const updates = {
    retest_status: 'completed',
    retest_state: { ...(row.retest_state || {}), result: { outcome, notes, observationRef, completed_at: nowIso() } },
    updated_at: nowIso()
  }
  if (aiVisibilityOutcomeStatus) updates.ai_visibility_outcome_status = aiVisibilityOutcomeStatus
  const { error } = await supabase.from(OPPORTUNITY_TABLE).update(updates).eq('id', opportunityId)
  if (error) throw error
  await insertHistory(supabase, { clientId: row.client_id, opportunityId, eventType: 'retest_completed', actor, newValue: { outcome, observationRef, aiVisibilityOutcomeStatus } })
  return { opportunityId, retestStatus: 'completed' }
}

// ---------------------------------------------------------------------
// READ HELPERS -- indexed, bounded, zero LLM/API calls. Support the
// future views the spec calls out (Highest Impact / Easy Win / Awaiting
// Approval / Ready to Verify) without any schema redesign.
// ---------------------------------------------------------------------

async function getOpportunitiesByTreatment(clientId, treatment) {
  assertOneOf(treatment, PRIORITY_TREATMENTS, 'treatment')
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(OPPORTUNITY_TABLE).select('*').eq('client_id', clientId).eq('priority_treatment', treatment)
  if (error) throw error
  return data || []
}

async function getOpportunitiesAwaitingApproval(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(OPPORTUNITY_TABLE).select('*').eq('client_id', clientId).eq('approval_status', 'pending')
  if (error) throw error
  return data || []
}

async function getOpportunitiesReadyToVerify(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(OPPORTUNITY_TABLE).select('*').eq('client_id', clientId).eq('verification_status', 'ready_to_verify')
  if (error) throw error
  return data || []
}

async function getOpportunityHistory(opportunityId, { limit = 100 } = {}) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(HISTORY_TABLE).select('*').eq('opportunity_id', opportunityId)
    .order('created_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

async function getPreparedWork(opportunityId, { artifactType = null } = {}) {
  const supabase = getSupabaseServerClient()
  let query = supabase.from(PREPARED_WORK_TABLE).select('*').eq('opportunity_id', opportunityId).order('artifact_type').order('version', { ascending: false })
  if (artifactType) query = query.eq('artifact_type', artifactType)
  const { data, error } = await query
  if (error) throw error
  return data || []
}

module.exports = {
  // constants
  PILLARS, PRIORITY_TREATMENTS, EXECUTION_CAPABILITIES, APPROVAL_STATUSES,
  EXECUTION_STATUSES, VERIFICATION_STATUSES, RETEST_STATUSES, DISPOSITION_REASONS,
  ARTIFACT_TYPES, PREPARED_WORK_STATUSES,
  // table names (PREPARED_WORK_TABLE exported 2026-09-01, Phase 1.1, so
  // read-path composition layers like lib/sourceCitation.js#getSourceLandscape
  // can batch-query prepared work themselves without hardcoding/duplicating
  // this table name)
  PREPARED_WORK_TABLE,
  // pure logic (unit-testable without a DB)
  buildPriorityAssessment, getPriorityDimensions, nextPreparedWorkVersion,
  validateExecutionGate, decideReobservation, computeStatusTrack,
  // qualify / evidence / priority
  qualifyOpportunity, attachEvidence, setPriorityTreatment, markStrengthProtect,
  // prepared work
  prepareWork, getPreparedWork,
  // approval
  submitForApproval, approveOpportunity, rejectOpportunity,
  // execution / handoff
  executeOpportunity, requestHandoff, recordHandoff, recordHumanCompleted,
  // verification
  requestVerification, recordVerification,
  // retest
  requestRetest, recordRetestResult,
  // reads
  getOpportunitiesByTreatment, getOpportunitiesAwaitingApproval, getOpportunitiesReadyToVerify,
  getOpportunityHistory
}
