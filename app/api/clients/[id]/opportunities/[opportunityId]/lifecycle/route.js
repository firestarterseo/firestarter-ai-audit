const { getSupabaseServerClient } = require('../../../../../../../lib/supabaseServer')
const {
  approveOpportunity, rejectOpportunity, requestHandoff, recordHandoff,
  recordHumanCompleted, requestVerification, recordVerification, prepareWork
} = require('../../../../../../../lib/opportunityLifecycle')

// POST -- Phase 3 shared-lifecycle dispatcher for one opportunity
// (added 2026-09-01, Phase 1 "Source & Citation Lifecycle Connective
// Tissue"). This is the route app/clients/[id]/SourceCitationWizard.js's
// runLifecycleAction() calls; it is deliberately a THIN DISPATCHER only:
//
//   - it never re-implements a lifecycle rule itself (every rule --
//     approval gating, the RED/YELLOW/GREEN execution gate, disposition
//     reasons, verification result handling -- lives entirely in
//     lib/opportunityLifecycle.js, and this route calls straight into
//     those exported functions);
//   - it never introduces a second status model (no locally-defined
//     status enum/shape -- the response is just whatever the lifecycle
//     function itself returns);
//   - it validates client/opportunity ownership BEFORE dispatching any
//     action, because none of the lib/opportunityLifecycle.js write
//     functions take or check a clientId themselves (they look a row up
//     by opportunityId alone) -- so this route is the one place that
//     guards against client A's request ever mutating client B's
//     opportunity.
//
// ACTION SET -- intentionally the exact subset SourceCitationWizard.js's
// runLifecycleAction() calls today, plus 'edit_then_approve' (added Phase
// 1.1, 2026-09-01) and 'prepare_edited_version' (added Phase 6, 2026-09-03
// -- see below; SchemaWizard.js's prepared-work review card is its first
// real caller), not the full lib/opportunityLifecycle.js surface.
// qualifyOpportunity, submitForApproval, executeOpportunity, requestRetest
// and recordRetestResult are all real exports with no caller through THIS
// route yet, so they are deliberately NOT exposed here -- adding them
// would be inventing API surface ahead of any real caller (a pillar's own
// prepare-work route, such as app/api/clients/[id]/schema/prepare-work/
// route.js, calls qualifyOpportunity/prepareWork/submitForApproval
// directly for its own system-generated flow; only the AM-edit path goes
// through this shared dispatcher). Every handler passes actor: 'am', since
// every one of these actions only ever fires from an explicit AM button
// click in the wizard -- never from an automated/system path -- so the
// opportunity_history ledger should reflect that honestly.
//
// 'edit_then_approve' (Phase 1.1): OpportunityCard.js's edited-approval
// button calls approveOpportunity(..., {edited: true}) -- the ONLY
// difference from plain 'approve' is which history event gets logged
// (edited_then_approved vs approved). Per lib/opportunityLifecycle.js's
// own approveOpportunity doc comment, "edited: true" is only ever honest
// when a genuinely edited prepared-work version already exists (created
// via prepareWork({createdBy:'am', previousVersionId, ...}) BEFORE this
// call) -- the edit itself must be durably preserved as its own version,
// never inlined into the approval event. This route therefore REQUIRES
// preparedWorkId for this action (unlike plain 'approve', where it's
// optional) -- it's the caller's proof that a specific version is being
// approved as the edited one. SourceCitationWizard.js does NOT wire
// OpportunityCard's onEditThenApprove to this action yet, and deliberately
// so: the wizard has no content-editing UI to actually produce an edited
// prepared-work version, and fabricating one here (or silently treating
// "edit then approve" as identical to "approve") would write a false
// edited_then_approved history event for content nobody edited. This
// primitive is exposed and tested now so a future prepared-work editing
// UI can wire straight into it without touching this route again.
//
// 'prepare_edited_version' (Phase 6, 2026-09-03): the future editing UI the
// comment above anticipated -- Schema Prepared Work + AM Review is its
// first real caller (app/clients/[id]/SchemaWizard.js's prepared-work
// review card). Generic, not schema-specific: it is a thin pass-through to
// lib/opportunityLifecycle.js#prepareWork() with createdBy: 'am' always
// forced (never trusts the request body for this), so ANY pillar's AM-
// edited prepared-work version goes through the exact same call -- a
// system-generated regeneration is each pillar's own prepare-work route
// calling prepareWork() directly with createdBy: 'system' (e.g.
// app/api/clients/[id]/schema/prepare-work/route.js), never this action.
// Requires previousVersionId (unlike prepareWork's own optional default)
// so every edited version is durably, traceably linked to the version it
// replaced -- an untethered "edit" with no previousVersionId would be
// indistinguishable from a first-time system generation in the history
// ledger.
const ACTIONS = {
  approve: {
    // approveOpportunity() defaults preparedWorkId to null and edited to
    // false -- both correct here, since the wizard's plain "Approve"
    // button never supplies either.
    run: (opportunityId, body) => approveOpportunity(opportunityId, {
      preparedWorkId: body.preparedWorkId || null,
      notes: body.notes || null,
      actor: 'am'
    })
  },
  edit_then_approve: {
    validate: (body) => (body.preparedWorkId ? null : 'edit_then_approve requires "preparedWorkId" -- the id of the prepared-work version containing the actual edit, created beforehand via the prepare-work step. This route never edits content itself.'),
    run: (opportunityId, body) => approveOpportunity(opportunityId, {
      preparedWorkId: body.preparedWorkId,
      edited: true,
      notes: body.notes || null,
      actor: 'am'
    })
  },
  reject: {
    validate: (body) => (body.reason ? null : 'reject requires a "reason" (one of DISPOSITION_REASONS).'),
    run: (opportunityId, body) => rejectOpportunity(opportunityId, {
      reason: body.reason,
      detail: body.detail || null,
      actor: 'am'
    })
  },
  request_verification: {
    run: (opportunityId) => requestVerification(opportunityId, { actor: 'am' })
  },
  request_handoff: {
    run: (opportunityId, body) => requestHandoff(opportunityId, {
      instructions: body.instructions || null,
      actor: 'am'
    })
  },
  record_handoff: {
    validate: (body) => (body.method ? null : 'record_handoff requires a "method".'),
    run: (opportunityId, body) => recordHandoff(opportunityId, {
      method: body.method,
      reference: body.reference || null,
      actor: 'am'
    })
  },
  record_human_completed: {
    run: (opportunityId, body) => recordHumanCompleted(opportunityId, {
      notes: body.notes || null,
      actor: 'am'
    })
  },
  record_verification: {
    validate: (body) => (body.result ? null : 'record_verification requires a "result".'),
    run: (opportunityId, body) => recordVerification(opportunityId, {
      result: body.result,
      evidence: Array.isArray(body.evidence) ? body.evidence : [],
      actor: 'am'
    })
  },
  prepare_edited_version: {
    validate: (body) => {
      if (!body.artifactType) return 'prepare_edited_version requires "artifactType".'
      if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return 'prepare_edited_version requires a "payload" object -- the edited artifact content.'
      if (!body.previousVersionId) return 'prepare_edited_version requires "previousVersionId" -- the prepared-work version this edit is based on.'
      return null
    },
    run: (opportunityId, body) => prepareWork({
      opportunityId,
      artifactType: body.artifactType,
      payload: body.payload,
      generationMethod: 'system_generated',
      evidenceContext: Array.isArray(body.evidenceContext) ? body.evidenceContext : [],
      supportsAutomatedExecution: false,
      createdBy: 'am',
      previousVersionId: body.previousVersionId,
      actor: 'am'
    })
  }
}

async function POST(request, { params }) {
  const { id, opportunityId } = await params
  const body = await request.json().catch(() => ({}))
  const action = body.action

  if (!action || typeof action !== 'string') {
    return Response.json({ error: 'action is required.' }, { status: 400 })
  }
  const actionDef = ACTIONS[action]
  if (!actionDef) {
    return Response.json(
      { error: `Unsupported action "${action}". Must be one of: ${Object.keys(ACTIONS).join(', ')}.` },
      { status: 400 }
    )
  }

  // Ownership check FIRST, before any validation or dispatch -- this is
  // the guard lib/opportunityLifecycle.js itself does not provide (see
  // module header above). eq('client_id', id) means a mismatched pair
  // simply finds no row rather than ever touching another client's data.
  const supabase = getSupabaseServerClient()
  const { data: opportunity, error: oppError } = await supabase
    .from('opportunities')
    .select('id, client_id')
    .eq('id', opportunityId)
    .eq('client_id', id)
    .single()
  if (oppError || !opportunity) {
    return Response.json({ error: oppError?.message || 'Opportunity not found for this client.' }, { status: 404 })
  }

  if (actionDef.validate) {
    const validationError = actionDef.validate(body)
    if (validationError) return Response.json({ error: validationError }, { status: 400 })
  }

  try {
    const result = await actionDef.run(opportunityId, body)
    return Response.json({ result })
  } catch (e) {
    // Lifecycle invariant violations (e.g. validateExecutionGate's RED/
    // YELLOW gating, assertOneOf on an invalid enum value) throw plain
    // Errors from lib/opportunityLifecycle.js -- surfaced as 400s, same
    // convention as the existing recheck route.
    return Response.json({ error: e.message || String(e) }, { status: 400 })
  }
}

module.exports = { POST }
