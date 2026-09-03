// SCHEMA PREPARED WORK + AM REVIEW -- opportunity qualification layer
// (Phase 6, 2026-09-03). Turns a lib/pageAnalysis.js diagnosis into a
// durable lib/opportunityLifecycle.js opportunity, using the EXACT shared
// Phase 3 lifecycle every other pillar uses -- see lib/sourceCitation.js's
// qualifySourceOpportunities() for the real precedent this mirrors
// (fingerprint -> qualifyOpportunity -> prepareWork -> submitForApproval).
// No parallel schema-specific approval system is built here, and
// lib/opportunities.js#syncOpportunities is never called or touched, per
// explicit instruction.
//
// WHEN DOES A SCHEMA OPPORTUNITY EXIST (approved rule, this pass):
//   ACTION_REQUIRED         -> eligible for prepared work (a Core check
//                              genuinely fails)
//   IMPROVEMENT_AVAILABLE   -> eligible IFF it represents a real Recommended
//                              gap -- true by computeFinalStatus's own
//                              definition (see lib/schemaPageTypeChecks.js),
//                              re-derived here defensively rather than
//                              trusted blindly, so a future loosening of
//                              that definition can't silently start
//                              qualifying pages with nothing real to
//                              prepare.
//   NO_ACTION_NEEDED        -> never eligible, no opportunity created.
//   COULD_NOT_VERIFY        -> never eligible, no opportunity created.
// A page being merely queued, opened, or analyzed never creates a row on
// its own -- isEligibleForPreparedWork/qualifySchemaPageOpportunity are
// called from exactly one place, app/api/clients/[id]/schema/prepare-work/
// route.js, itself only ever invoked by an AM's explicit "Prepare Schema
// Work" click in SchemaWizard.js.
//
// FINGERPRINT / DUPLICATION: buildSchemaOpportunityFingerprint(path) is
// stable per (client, page) and deliberately excludes target profile and
// finalStatus -- a page's diagnosis changing on re-analysis (e.g. a
// Location page resolving from SERVICE_AREA to LOCATION_UNCONFIRMED) is
// still "the same page's schema opportunity" being re-observed, not a new
// one. qualifyOpportunity()'s own (client_id, fingerprint) idempotency and
// decideReobservation logic is what prevents duplicates and preserves the
// re-observation trail in opportunity_history -- this module supplies a
// correct, stable identity and otherwise invents no new dedup mechanism.

const { qualifyOpportunity } = require('./opportunityLifecycle')
// 2026-09 page-work persistence pass: normalizeSchemaPagePath/
// buildSchemaOpportunityFingerprint now live in lib/schemaPageIdentity.js
// (a pure, zero-dependency module) so SchemaWizard.js and
// lib/schemaPageWork.js can import the identity rule directly without
// pulling in this file's own lib/opportunityLifecycle.js -> lib/supabaseServer.js
// dependency chain into client code. Re-exported here, unchanged, so every
// existing caller of THIS file keeps working exactly as before.
const { normalizeSchemaPagePath, buildSchemaOpportunityFingerprint } = require('./schemaPageIdentity')

// OPPORTUNITY_TYPE -- 2026-09 production-verification pass: this MUST be
// one of the values production's `opportunities_type_check` CHECK
// constraint actually allows (content_brief, citation_target, schema_fix,
// technical_fix, entity_verification, brand_association_gap). The prior
// value, 'schema_page_diagnostic', was never a legal value -- it does not
// appear in that constraint, and every "Prepare Schema Work" insert was
// therefore guaranteed to fail with a Postgres 23514 check-violation
// (confirmed via read-only production introspection, not inferred).
// 'schema_fix' is the value lib/opportunityLifecycle.test.js's own Schema
// fixtures have used all along -- the intended value this should have
// matched from the start.
const OPPORTUNITY_TYPE = 'schema_fix'
const OWNING_PILLAR = 'schema_structure'

function nowIso() { return new Date().toISOString() }

// isEligibleForPreparedWork(analysis) -> boolean. `analysis` is a
// lib/pageAnalysis.js#analyzePage() result. Re-checks the underlying check
// arrays rather than trusting finalStatus alone (defense in depth -- see
// header).
function isEligibleForPreparedWork(analysis) {
  if (!analysis || analysis.fetchState !== 'success') return false
  if (analysis.finalStatus === 'ACTION_REQUIRED') {
    return Array.isArray(analysis.coreChecks) && analysis.coreChecks.some(c => c.status === 'fail')
  }
  if (analysis.finalStatus === 'IMPROVEMENT_AVAILABLE') {
    return Array.isArray(analysis.recommendedChecks) && analysis.recommendedChecks.some(c => c.status === 'fail')
  }
  return false
}

// buildSchemaOpportunityDetail(analysis, {path, pageUrl}) -> the `detail`
// payload preserved on the opportunity row -- every field the approved
// spec required: page URL/path, page classification, target profile,
// current detected schema, core findings, recommended enhancements,
// evidence (see buildSchemaOpportunityEvidence, stored separately per the
// shared lifecycle's own evidence column), diagnosis timestamp.
function buildSchemaOpportunityDetail(analysis, { path, pageUrl = null } = {}) {
  return {
    path,
    pageUrl,
    classification: analysis.classification,
    targetProfile: analysis.targetProfile,
    currentSchema: analysis.currentSchema,
    coreChecks: analysis.coreChecks,
    recommendedChecks: analysis.recommendedChecks,
    avoidFindings: analysis.avoidFindings,
    notApplicable: analysis.notApplicable,
    finalStatus: analysis.finalStatus,
    diagnosedAt: nowIso()
  }
}

// buildSchemaOpportunityEvidence(analysis) -> [{text, source, checkId,
// tier}], the shape OpportunityCard.js's "Finding & evidence" section
// already renders. Built only from real check evidence strings the
// diagnostic methodology already produced -- nothing fabricated, nothing
// summarized/paraphrased.
function buildSchemaOpportunityEvidence(analysis) {
  const failing = [
    ...(analysis.coreChecks || []),
    ...(analysis.recommendedChecks || [])
  ].filter(c => c.status === 'fail')
  return failing.map(c => ({ text: c.evidence, source: 'schema_diagnostic', checkId: c.id, tier: c.tier }))
}

function buildSchemaOpportunityTitle(analysis, path) {
  const profile = analysis.targetProfile || 'GENERIC'
  return `${path} -- ${profile} schema (${analysis.finalStatus})`
}

// qualifySchemaPageOpportunity({clientId, auditRunId, path, pageUrl,
//   analysis, actor}) -> { eligible: false } | { eligible: true,
//   opportunityId, action, fingerprint }. The only function in this module
// that writes anything. actor defaults to 'am' (not 'system') because,
// unlike lib/sourceCitation.js's audit-run-driven sync, this is only ever
// invoked from an AM's explicit "Prepare Schema Work" click -- the
// opportunity_history ledger should reflect that honestly (same reasoning
// as the lifecycle route's own actor: 'am' convention).
async function qualifySchemaPageOpportunity({ clientId, auditRunId = null, path, pageUrl = null, analysis, actor = 'am' } = {}) {
  if (!isEligibleForPreparedWork(analysis)) {
    return { eligible: false }
  }
  const fingerprint = buildSchemaOpportunityFingerprint(path)
  const detail = buildSchemaOpportunityDetail(analysis, { path, pageUrl })
  const evidence = buildSchemaOpportunityEvidence(analysis)
  const title = buildSchemaOpportunityTitle(analysis, path)

  const { opportunityId, action } = await qualifyOpportunity({
    clientId,
    auditRunId,
    owningPillar: OWNING_PILLAR,
    originatingPillar: OWNING_PILLAR,
    opportunityType: OPPORTUNITY_TYPE,
    fingerprint,
    title,
    detail,
    evidence,
    // RED per approved scope: "execution capability can remain RED /
    // manual handoff for non-homepage page-specific schema until per-page
    // WordPress publishing exists. Do not fake YELLOW/GREEN automation."
    // This route/module never sets anything else, and never calls
    // executeOpportunity/requestHandoff/requestVerification.
    executionCapability: 'red',
    actor
  })
  return { eligible: true, opportunityId, action, fingerprint }
}

module.exports = {
  OPPORTUNITY_TYPE,
  OWNING_PILLAR,
  normalizeSchemaPagePath,
  buildSchemaOpportunityFingerprint,
  isEligibleForPreparedWork,
  buildSchemaOpportunityDetail,
  buildSchemaOpportunityEvidence,
  buildSchemaOpportunityTitle,
  qualifySchemaPageOpportunity
}
