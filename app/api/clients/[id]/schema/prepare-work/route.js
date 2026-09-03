const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { analyzePage, resolvePageUrl } = require('../../../../../../lib/pageAnalysis')
const { isEligibleForPreparedWork, qualifySchemaPageOpportunity, buildSchemaOpportunityFingerprint } = require('../../../../../../lib/schemaOpportunity')
const { buildPreparedSchemaWork } = require('../../../../../../lib/schemaPreparedWork')
const { prepareWork, submitForApproval, getPreparedWork, getOpportunityHistory } = require('../../../../../../lib/opportunityLifecycle')
const { upsertAnalysisResult, linkOpportunity } = require('../../../../../../lib/schemaPageWork')

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
    return Response.json({ error: 'Request body must be JSON with a "path" field.', errorClass: 'validation' }, { status: 400 })
  }

  const path = typeof body?.path === 'string' ? body.path : null
  if (!path || !path.startsWith('/')) {
    return Response.json({ error: 'path must be a site-relative path starting with "/".', errorClass: 'validation' }, { status: 400 })
  }

  const supabase = getSupabaseServerClient()
  let client
  try {
    const { data, error: clientError } = await supabase.from('clients').select('url').eq('id', id).single()
    if (clientError) return Response.json({ error: clientError.message, errorClass: 'validation' }, { status: 404 })
    client = data
  } catch (e) {
    return logAndClassify(e, 'client_lookup', 'Could not look up this client to prepare schema work.')
  }
  if (!client?.url) return Response.json({ error: 'This client has no site URL on file.', errorClass: 'validation' }, { status: 400 })

  // Same trust boundary as analyze-page/route.js: `page` classification
  // metadata travels from the client's already-in-memory sitemap dossier
  // (never used to bypass the path-must-be-site-relative check above).
  const page = {
    type: typeof body?.page?.type === 'string' ? body.page.type : 'Other',
    classificationSource: typeof body?.page?.classificationSource === 'string' ? body.page.classificationSource : 'unknown',
    classificationConfidence: typeof body?.page?.classificationConfidence === 'string' ? body.page.classificationConfidence : 'low'
  }

  // ANALYZE -- a live fetch + diagnosis of the client's real page. Failures
  // here (the client's site unreachable, a timeout, an unexpected page
  // shape) are a PREPARATION failure, not a database problem -- classified
  // distinctly so the UI never conflates "their site didn't respond" with
  // "we couldn't save your work."
  let analysis
  try {
    analysis = await analyzePage({ path, page, siteUrl: client.url })
  } catch (e) {
    return logAndClassify(e, 'analyze', 'Could not fetch or diagnose this page right now. This is a page-analysis failure, not a database or connectivity problem -- try again shortly.')
  }

  if (!isEligibleForPreparedWork(analysis)) {
    return Response.json({
      error: `This page's diagnosis (${analysis.finalStatus}) does not qualify for prepared work. Only ACTION_REQUIRED, or IMPROVEMENT_AVAILABLE with a real Recommended gap, is eligible -- see lib/schemaOpportunity.js.`,
      errorClass: 'validation',
      analysis
    }, { status: 400 })
  }

  const pageUrl = resolvePageUrl(client.url, path)

  // QUALIFY -- the first durable write (lib/opportunityLifecycle.js#qualifyOpportunity
  // via lib/schemaOpportunity.js). A thrown error here is a PERSISTENCE
  // failure (e.g. a Postgres schema mismatch) -- the diagnosis itself
  // already succeeded, so `analysis` is still returned to the client
  // rather than discarded.
  let qualifyResult
  try {
    qualifyResult = await qualifySchemaPageOpportunity({ clientId: id, path, pageUrl, analysis, actor: 'am' })
  } catch (e) {
    return logAndClassify(e, 'qualify', 'This page was diagnosed, but saving its opportunity record failed. Prepared work was not created.', { analysis })
  }
  if (!qualifyResult.eligible) {
    // Defensive only -- isEligibleForPreparedWork already gated this above
    // using the identical logic qualifySchemaPageOpportunity re-checks.
    return Response.json({ error: 'Eligibility check failed unexpectedly.', errorClass: 'validation', analysis }, { status: 400 })
  }
  const { opportunityId } = qualifyResult

  // PAGE-WORK PERSISTENCE (Phase 5, 2026-09) -- best-effort/non-fatal. By
  // this point the real Phase 3 artifact (the opportunity) is already
  // durably saved, so a schema_page_work write failure must never fail
  // the overall Prepare Schema Work flow -- it is reported back via
  // `pageWorkPersistence` for transparency instead. Persists the fresh
  // diagnosis (same as analyze-page/route.js does) and then links this
  // page's durable row to the opportunity just qualified above -- both
  // idempotent, so repeated preparation of the same stable page/opportunity
  // never duplicates a row or a history event (lib/schemaPageWork.js).
  let pageWorkPersistence = { ok: true }
  try {
    const classification = page.type ? { type: page.type, source: page.classificationSource, confidence: page.classificationConfidence } : null
    await upsertAnalysisResult({ clientId: id, path, pageUrl, classification, targetProfile: analysis.targetProfile, analysis, actor: 'am' })
    await linkOpportunity({ clientId: id, path, pageUrl, opportunityId, actor: 'am' })
  } catch (e) {
    console.error('[schema/prepare-work] page-work persistence failed:', e)
    pageWorkPersistence = {
      ok: false,
      errorClass: 'persistence',
      phase: 'page_work_persistence',
      code: (e && typeof e.code === 'string') ? e.code : null
    }
  }

  // PREPARE -- builds the proposed JSON-LD. A thrown error here is also a
  // PREPARATION failure (not persistence): the opportunity above is
  // already durably saved regardless of what happens next.
  let prepared
  try {
    prepared = await buildPreparedSchemaWork({
      path,
      siteUrl: client.url,
      targetProfile: analysis.targetProfile,
      coreChecks: analysis.coreChecks,
      recommendedChecks: analysis.recommendedChecks
    })
  } catch (e) {
    return logAndClassify(e, 'build_prepared_work', 'The schema opportunity was saved, but generating the proposed schema failed. Try preparing this page again.', { analysis, opportunityId, pageWorkPersistence })
  }

  // SUBMIT-FOR-APPROVAL -- the second durable write. A thrown error here is
  // a PERSISTENCE failure -- distinct from the PREPARE step above, since the
  // proposed content was generated successfully but could not be saved.
  let preparedWorkResult
  try {
    preparedWorkResult = await prepareWork({
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
  } catch (e) {
    return logAndClassify(e, 'prepare_work', 'The schema opportunity was saved, but the prepared work could not be saved. Try preparing this page again.', { analysis, opportunityId, pageWorkPersistence })
  }

  let preparedWorkVersions, opportunityRow
  try {
    ;[preparedWorkVersions, opportunityRow] = await Promise.all([
      getPreparedWork(opportunityId, { artifactType: 'schema_jsonld' }),
      supabase.from('opportunities').select('*').eq('id', opportunityId).single()
    ])
    if (opportunityRow.error) throw opportunityRow.error
  } catch (e) {
    return logAndClassify(e, 'final_read', 'Preparation likely succeeded, but the result could not be read back. Refresh this page to check.', { opportunityId, pageWorkPersistence })
  }

  return Response.json({
    analysis,
    opportunity: opportunityRow.data,
    preparedWork: preparedWorkVersions,
    action: qualifyResult.action,
    pageWorkPersistence
  })
}

// logAndClassify(error, phase, safeMessage, extra) -> a Response.json(...)
// the caller returns immediately. Section 4 requirement: the UI's generic
// "Could not reach the server" message must ONLY ever come from the
// browser's own fetch() failing to reach the app at all (see
// SchemaWizard.js's prepareSchemaWorkNow) -- a real server-side exception,
// whatever its cause (a live-fetch failure, a Postgres schema mismatch, an
// unexpected shape), must always come back as a real HTTP status with a
// safe, classified JSON body instead of an uncaught 500 the client can't
// parse. `errorClass` distinguishes NETWORK (client-only, never set here),
// PREPARATION FAILED (analysis/generation), and PERSISTENCE (a durable
// write/read failed) per the AM-facing contract; `phase` and, when present,
// a Postgres SQLSTATE `code` are included for diagnosis without ever
// echoing the raw error message, stack trace, or SQL back to the browser.
function logAndClassify(error, phase, safeMessage, extra = {}) {
  console.error(`[schema/prepare-work] ${phase} failed:`, error)
  const errorClass = phase === 'analyze' || phase === 'build_prepared_work' ? 'preparation_failed' : 'persistence'
  const status = phase === 'analyze' ? 502 : 500
  return Response.json({
    error: safeMessage,
    errorClass,
    phase,
    code: (error && typeof error.code === 'string') ? error.code : null,
    ...extra
  }, { status })
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
  try {
    const { data: opportunity, error } = await supabase
      .from('opportunities').select('*').eq('client_id', id).eq('fingerprint', fingerprint).maybeSingle()
    if (error) throw error
    if (!opportunity) return Response.json({ opportunity: null, preparedWork: [], history: [] })

    const [preparedWork, history] = await Promise.all([
      getPreparedWork(opportunity.id, { artifactType: 'schema_jsonld' }),
      getOpportunityHistory(opportunity.id, { limit: 50 })
    ])
    return Response.json({ opportunity, preparedWork, history })
  } catch (e) {
    return logAndClassify(e, 'get_read', 'Could not load this page\'s prepared work right now.')
  }
}

module.exports = { POST, GET, maxDuration }
