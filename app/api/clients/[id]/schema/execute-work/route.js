const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { decrypt } = require('../../../../../../lib/wpCredentials')
const { publishPageSchemaToWordPress } = require('../../../../../../lib/wpPublish')
const { resolvePageUrl } = require('../../../../../../lib/pageAnalysis')
const { buildDeployableSchema, EXECUTION_BLOCKED_MESSAGE } = require('../../../../../../lib/schemaDeployableArtifact')
const { getPageWorkRow } = require('../../../../../../lib/schemaPageWork')
const { normalizeSchemaPagePath } = require('../../../../../../lib/schemaPageIdentity')
const { executeOpportunity } = require('../../../../../../lib/opportunityLifecycle')

// A single external WordPress REST call -- same order of magnitude as the
// existing sitewide publish route's own maxDuration.
const maxDuration = 30

// POST { path } -> Phase 7 (2026-09-04): "DEPLOY TO WORDPRESS" -- the first
// real WordPress-execution action for one page's ALREADY-APPROVED schema
// prepared work. Never called automatically; only ever from an AM's
// explicit click in SchemaWizard.js.
//
// PROVENANCE (instruction #2): this route reads exactly ONE payload --
// the CURRENT opportunity.approved_prepared_work_id's own row, read fresh
// from the database every time -- and never accepts a payload, prepared-
// work id, or JSON-LD from the request body. There is no way for a client
// request to specify what gets deployed; the only input is which page
// (`path`) to execute for THIS client.
//
// APPROVAL GATE (instruction #9): every one of these is checked here,
// server-side, and a request fails outright (never silently downgrades to
// "manual") if any is not true:
//   - a schema_page_work row exists for this path and is linked to an opportunity
//   - that opportunity belongs to this client
//   - its originating_pillar is schema_structure
//   - its own recorded page (detail.path) matches the page being executed
//   - approval_status is 'approved' AND approved_prepared_work_id is set
//   - the referenced prepared-work row is itself still 'approved' (not superseded)
//   - the client has a WordPress connection on file
// A disabled UI button is not this gate -- every check above runs
// regardless of what the browser sends.
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

  let client
  try {
    const { data, error } = await supabase.from('clients').select('id, url, wp_username, wp_app_password_encrypted').eq('id', id).single()
    if (error) return Response.json({ error: error.message }, { status: 404 })
    client = data
  } catch (e) {
    return Response.json({ error: 'Could not look up this client.' }, { status: 500 })
  }
  if (!client?.url) return Response.json({ error: 'This client has no site URL on file.' }, { status: 400 })
  if (!client.wp_username || !client.wp_app_password_encrypted) {
    return Response.json({ error: 'This client isn\'t connected to WordPress yet -- add a username and Application Password first.' }, { status: 400 })
  }

  let pageWork
  try {
    pageWork = await getPageWorkRow(id, path)
  } catch (e) {
    return Response.json({ error: 'Could not look up this page\'s schema work.' }, { status: 500 })
  }
  if (!pageWork || !pageWork.opportunity_id) {
    return Response.json({ error: 'No approved schema opportunity exists for this page yet -- prepare and approve schema work first.' }, { status: 400 })
  }

  const { data: opportunity, error: oppError } = await supabase
    .from('opportunities').select('*').eq('id', pageWork.opportunity_id).eq('client_id', id).single()
  if (oppError || !opportunity) {
    return Response.json({ error: oppError?.message || 'Opportunity not found for this client.' }, { status: 404 })
  }
  if (opportunity.originating_pillar !== 'schema_structure') {
    return Response.json({ error: 'This opportunity does not belong to the Schema & Structure pillar.' }, { status: 400 })
  }

  // Target-page alignment (instruction #9's "target page matches the
  // Schema page-work record") -- the opportunity's OWN recorded page
  // (set once, at qualification time, by lib/schemaOpportunity.js) must be
  // the same page schema_page_work resolved `path` to. This is a defense-
  // in-depth cross-check, not the primary lookup (getPageWorkRow above is
  // what actually finds the opportunity) -- it exists so a future bug that
  // ever mislinks a page-work row to the wrong opportunity fails loudly
  // here instead of silently deploying to the wrong page's opportunity.
  const opportunityPath = opportunity.detail && typeof opportunity.detail.path === 'string' ? opportunity.detail.path : null
  if (!opportunityPath || normalizeSchemaPagePath(opportunityPath) !== normalizeSchemaPagePath(path)) {
    return Response.json({ error: 'EXECUTION BLOCKED — target page mismatch: this opportunity is not recorded against the page being executed.' }, { status: 409 })
  }

  if (opportunity.approval_status !== 'approved' || !opportunity.approved_prepared_work_id) {
    return Response.json({ error: 'This page\'s schema work is not approved yet -- execution requires an approved prepared-work version.' }, { status: 409 })
  }

  // IDEMPOTENCY (instruction #20) -- the exact approved version already
  // successfully deployed is never redeployed. A NEWER approved version
  // (a different approved_prepared_work_id than what was last recorded as
  // deployed) is always treated as a new execution, below.
  const priorResult = opportunity.execution_state && opportunity.execution_state.result
  if (opportunity.execution_status === 'executed' && priorResult && priorResult.ok && priorResult.approvedPreparedWorkId === opportunity.approved_prepared_work_id) {
    return Response.json({
      ok: true, alreadyDeployed: true,
      postId: priorResult.postId, deployedAt: priorResult.deployedAt, jsonLd: priorResult.deployedJsonLd
    })
  }

  const { data: preparedWorkRow, error: pwError } = await supabase
    .from('opportunity_prepared_work').select('*').eq('id', opportunity.approved_prepared_work_id).eq('opportunity_id', opportunity.id).single()
  if (pwError || !preparedWorkRow) {
    return Response.json({ error: pwError?.message || 'Approved prepared work could not be found.' }, { status: 404 })
  }
  if (preparedWorkRow.status !== 'approved') {
    return Response.json({ error: 'The approved prepared-work version is not currently in an approved state -- it may have been superseded by a newer edit.' }, { status: 409 })
  }
  if (preparedWorkRow.artifact_type !== 'schema_jsonld') {
    return Response.json({ error: `Unsupported artifact type "${preparedWorkRow.artifact_type}" for WordPress schema execution.` }, { status: 400 })
  }

  // TRANSFORM (instruction #3) -- approved prepared work -> final
  // deployable JSON-LD. A block here is a validation outcome, not a
  // WordPress-execution attempt -- executeOpportunity is never called for
  // this, so the approved work is left exactly as it was, available for
  // manual execution or a future prepared-work version.
  const deployable = buildDeployableSchema(preparedWorkRow.payload)
  if (!deployable.ok) {
    return Response.json({ error: EXECUTION_BLOCKED_MESSAGE, reason: deployable.reason, code: deployable.code, blocked: true }, { status: 409 })
  }

  const absoluteUrl = resolvePageUrl(client.url, path)
  if (!absoluteUrl) {
    return Response.json({ error: 'Could not resolve an absolute URL for this page.' }, { status: 400 })
  }

  let wpAppPassword
  try {
    wpAppPassword = decrypt(client.wp_app_password_encrypted)
  } catch (e) {
    return Response.json({ error: `Could not decrypt the stored WordPress credential: ${e.message}` }, { status: 500 })
  }

  // EXECUTE -- the real WordPress write. Everything above only ever
  // validated; this is the one call that can actually change the client's
  // site.
  const publishResult = await publishPageSchemaToWordPress({
    url: absoluteUrl, wpUsername: client.wp_username, wpAppPassword, jsonLd: deployable.jsonLd
  })

  // RECORD -- via the SAME shared Phase 3 execution primitive every future
  // pillar uses (lib/opportunityLifecycle.js#executeOpportunity), passing
  // the REAL outcome this route's own call just produced (never fabricated,
  // per that function's own contract). This is what actually flips
  // execution_status to 'executed'/'execution_failed' and appends the
  // opportunity_history event -- this route never writes that status
  // itself.
  const executionResult = {
    ok: publishResult.ok,
    path,
    postId: publishResult.ok ? (publishResult.postId ?? null) : null,
    approvedPreparedWorkId: opportunity.approved_prepared_work_id,
    approvedPreparedWorkVersion: preparedWorkRow.version,
    deployedJsonLd: publishResult.ok ? deployable.jsonLd : null,
    deployedAt: publishResult.ok ? new Date().toISOString() : null,
    error: publishResult.ok ? null : publishResult.error
  }

  try {
    await executeOpportunity(opportunity.id, { method: 'wordpress_rest', result: executionResult, actor: 'am' })
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 409 })
  }

  if (!publishResult.ok) {
    return Response.json({ ok: false, error: publishResult.error, pageNotResolved: !!publishResult.pageNotResolved }, { status: 502 })
  }

  return Response.json({ ok: true, postId: publishResult.postId, deployedAt: executionResult.deployedAt, jsonLd: deployable.jsonLd })
}

module.exports = { POST, maxDuration }
