const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { analyzePage, resolvePageUrl } = require('../../../../../../lib/pageAnalysis')
const { isEligibleForPreparedWork, qualifySchemaPageOpportunity, buildSchemaOpportunityFingerprint } = require('../../../../../../lib/schemaOpportunity')
const { buildPreparedSchemaWork } = require('../../../../../../lib/schemaPreparedWork')
const { prepareWork, submitForApproval, getPreparedWork, getOpportunityHistory } = require('../../../../../../lib/opportunityLifecycle')

// Live page fetch (twice -- see lib/schemaPreparedWork.js's own header on
// why buildPreparedSchemaWork does its own independent fetch rather than
// reusing analyzePage()'s -- both single, bounded, AM-triggered fetches of
// one small page, same cost profile as the existing analyze-page route).
const maxDuration = 30

// POST { path, page } -> the full ANALYZE -> QUALIFY -> PREPARE -> SUBMIT-
// FOR-APPROVAL flow for one page's schema opportunity (Phase 6,
// 2026-09-03), triggered ONLY by an AM's explicit "Prepare Schema Work"
// click in SchemaWizard.js -- mirrors analyze-page/route.js's own
// path-validation and page-classification-metadata conventions exactly
// (same "server fetches, browser never does" reasoning: CORS, and this
// project's consistent server-fetches-the-client's-site convention).
//
// USES THE EXISTING PHASE 3 LIFECYCLE ONLY -- no parallel schema-specific
// approval system. This route's only writes are: (1) a durable
// `opportunities` row via lib/opportunityLifecycle.js#qualifyOpportunity
// (through lib/schemaOpportunity.js, which supplies the stable fingerprint
// and eligibility gate -- see that file's header for why NO_ACTION_NEEDED/
// COULD_NOT_VERIFY pages, or a page that is merely queued/opened/analyzed,
// never reach this far), (2) a durable `opportunity_prepared_work` row via
// that same lifecycle's prepareWork(), and (3) approval_status: 'pending'
// via submitForApproval() -- ONLY when preparation actually produced a
// real, content-defensible proposal (see below). execution_capability is
// always 'red' (set inside lib/schemaOpportunity.js) -- this route never
// sets yellow/green and never calls executeOpportunity/requestHandoff/
// requestVerification/recordVerification. Never touches WordPress, never
// publishes anything.
async function POST(request, { params }) {
  const { id } = await params
  let body
  try {
    body = await request.json()
  } catch (e) {
    return Response.json({ error: 'Request body must be JSON with a "path" field.' }, { status: 400 })
  }

  const path = typeof body?.path === 'string' ? body.path : null
  if (!path || !path.startsWith('/')) {
    return Response.json({ error: 'path must be a site-relative path starting with "/".' }, { status: 400 })
  }

  const supabase = getSupabaseServerClient()
  const { data: client, error: clientError } = await supabase.from('clients').select('url').eq('id', id).single()
  if (clientError) return Response.json({ error: clientError.message }, { status: 404 })
  if (!client?.url) return Response.json({ error: 'This client has no site URL on file.' }, { status: 400 })

  // Same trust boundary as analyze-page/route.js: `page` classification
  // metadata travels from the client's already-in-memory sitemap dossier
  // (never used to bypass the path-must-be-site-relative check above).
  const page = {
    type: typeof body?.page?.type === 'string' ? body.page.type : 'Other',
    classificationSource: typeof body?.page?.classificationSource === 'string' ? body.page.classificationSource : 'unknown',
    classificationConfidence: typeof body?.page?.classificationConfidence === 'string' ? body.page.classificationConfidence : 'low'
  }

  const analysis = await analyzePage({ path, page, siteUrl: client.url })

  if (!isEligibleForPreparedWork(analysis)) {
    return Response.json({
      error: `This page's diagnosis (${analysis.finalStatus}) does not qualify for prepared work. Only ACTION_REQUIRED, or IMPROVEMENT_AVAILABLE with a real Recommended gap, is eligible -- see lib/schemaOpportunity.js.`,
      analysis
    }, { status: 400 })
  }

  const pageUrl = resolvePageUrl(client.url, path)
  const qualifyResult = await qualifySchemaPageOpportunity({ clientId: id, path, pageUrl, analysis, actor: 'am' })
  if (!qualifyResult.eligible) {
    // Defensive only -- isEligibleForPreparedWork already gated this above
    // using the identical logic qualifySchemaPageOpportunity re-checks.
    return Response.json({ error: 'Eligibility check failed unexpectedly.', analysis }, { status: 400 })
  }
  const { opportunityId } = qualifyResult

  const prepared = await buildPreparedSchemaWork({
    path,
    siteUrl: client.url,
    targetProfile: analysis.targetProfile,
    coreChecks: analysis.coreChecks,
    recommendedChecks: analysis.recommendedChecks
  })

  const preparedWorkResult = await prepareWork({
    opportunityId,
    artifactType: 'schema_jsonld',
    payload: prepared,
    generationMethod: prepared.supported ? 'system_generated' : 'system_failed',
    evidenceContext: (prepared.unresolvedDependencies || []).map(text => ({ text, source: 'schema_prepared_work' })),
    supportsAutomatedExecution: false,
    createdBy: 'system',
    actor: 'am'
  })

  // Only submit for AM approval when there is real prepared work to
  // approve/reject -- a preparation_failed version (nothing
  // content-defensible could be proposed) has nothing for an AM to act on
  // yet, so approval_status correctly stays at its default rather than
  // presenting empty Approve/Reject controls for no real content.
  if (preparedWorkResult.status === 'ready_for_review') {
    await submitForApproval(opportunityId, { preparedWorkId: preparedWorkResult.preparedWorkId, actor: 'am' })
  }

  const [preparedWorkVersions, opportunityRow] = await Promise.all([
    getPreparedWork(opportunityId, { artifactType: 'schema_jsonld' }),
    supabase.from('opportunities').select('*').eq('id', opportunityId).single()
  ])
  if (opportunityRow.error) return Response.json({ error: opportunityRow.error.message }, { status: 500 })

  return Response.json({
    analysis,
    opportunity: opportunityRow.data,
    preparedWork: preparedWorkVersions,
    action: qualifyResult.action
  })
}

// GET ?path=/about/ -> the current opportunity + prepared-work versions +
// history for one page, WITHOUT re-fetching the client's live site or
// re-running diagnosis/qualification/preparation. Read-only -- exists so
// SchemaWizard.js can refresh its AM Review UI (e.g. after an
// approve/reject/edit_then_approve call through the existing shared
// app/api/clients/[id]/opportunities/[opportunityId]/lifecycle/route.js)
// without re-triggering a live fetch + re-qualification every time.
async function GET(request, { params }) {
  const { id } = await params
  const { searchParams } = new URL(request.url)
  const path = searchParams.get('path')
  if (!path || !path.startsWith('/')) {
    return Response.json({ error: 'path query parameter must be a site-relative path starting with "/".' }, { status: 400 })
  }

  const fingerprint = buildSchemaOpportunityFingerprint(path)
  const supabase = getSupabaseServerClient()
  const { data: opportunity, error } = await supabase
    .from('opportunities').select('*').eq('client_id', id).eq('fingerprint', fingerprint).maybeSingle()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!opportunity) return Response.json({ opportunity: null, preparedWork: [], history: [] })

  const [preparedWork, history] = await Promise.all([
    getPreparedWork(opportunity.id, { artifactType: 'schema_jsonld' }),
    getOpportunityHistory(opportunity.id, { limit: 50 })
  ])
  return Response.json({ opportunity, preparedWork, history })
}

module.exports = { POST, GET, maxDuration }
