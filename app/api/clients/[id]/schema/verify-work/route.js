const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { resolvePageUrl } = require('../../../../../../lib/pageAnalysis')
const { fetchWebPage } = require('../../../../../../lib/webPageFetch')
const { verifyDeployedSchema } = require('../../../../../../lib/schemaLiveVerification')
const { getPageWorkRow, linkOpportunity } = require('../../../../../../lib/schemaPageWork')
const { buildSchemaOpportunityFingerprint } = require('../../../../../../lib/schemaPageIdentity')
const { requestVerification, recordVerification } = require('../../../../../../lib/opportunityLifecycle')

// A single live page fetch -- same order of magnitude as every other
// live-fetch route in this pillar (analyze-page, prepare-work).
const maxDuration = 30

// POST { path } -> Phase 7 (2026-09-04): "VERIFY LIVE" / "RECHECK LIVE" --
// the SAME action serves both (calling this again after a first
// verification is exactly what "Recheck Live" means; see instruction #14).
//
// SEPARATION OF CONCERNS (instruction #11/#13): this route NEVER calls
// executeOpportunity and never changes execution_status -- a successful
// WordPress write (execute-work/route.js) and a confirmed-live page (this
// route) are deliberately independent facts. It also never re-derives
// "what schema should be live" from a fresh diagnosis or the current
// approved prepared-work payload -- it checks against
// opportunity.execution_state.result.deployedJsonLd, the EXACT artifact
// execute-work/route.js actually sent to WordPress, so verification always
// answers "is what we deployed actually live," never "does the page now
// happen to satisfy today's diagnosis" (those are honestly different
// questions -- a future re-analysis, not this route, is where the second
// one belongs; see instruction #22).
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
    const { data, error } = await supabase.from('clients').select('id, url').eq('id', id).single()
    if (error) return Response.json({ error: error.message }, { status: 404 })
    client = data
  } catch (e) {
    return Response.json({ error: 'Could not look up this client.' }, { status: 500 })
  }
  if (!client?.url) return Response.json({ error: 'This client has no site URL on file.' }, { status: 400 })

  // OPPORTUNITY RESOLUTION (2026-09-04c HOTFIX) -- resolve by FINGERPRINT,
  // the SAME authoritative lookup GET /prepare-work (and execute-work/
  // route.js, after the same hotfix there) use, rather than through
  // schema_page_work.opportunity_id -- see execute-work/route.js's own
  // header for the full root-cause writeup. That link is a best-effort
  // secondary pointer that can legitimately be null even when a real,
  // approved-and-executed opportunity exists, so it is never the primary
  // lookup for whether this page can be verified.
  const fingerprint = buildSchemaOpportunityFingerprint(path)
  const { data: opportunity, error: oppError } = await supabase
    .from('opportunities').select('*').eq('client_id', id).eq('fingerprint', fingerprint).maybeSingle()
  if (oppError) {
    return Response.json({ error: 'Could not look up this page\'s schema opportunity.' }, { status: 500 })
  }
  if (!opportunity) {
    return Response.json({ error: 'No schema opportunity exists for this page yet.' }, { status: 400 })
  }

  // RECONCILIATION -- best-effort backfill of schema_page_work's own link,
  // exactly as execute-work/route.js does (see that file for the full
  // rationale): never blocking, never creates a duplicate opportunity,
  // only ever points the existing page-work row at the exact opportunity
  // already resolved above via the existing, idempotent linkOpportunity().
  try {
    const pageWork = await getPageWorkRow(id, path)
    if (!pageWork || pageWork.opportunity_id !== opportunity.id) {
      await linkOpportunity({ clientId: id, path, pageUrl: resolvePageUrl(client.url, path), opportunityId: opportunity.id, actor: 'system' })
    }
  } catch (e) {
    console.error('[schema/verify-work] page-work reconciliation failed:', e)
  }

  if (opportunity.originating_pillar !== 'schema_structure') {
    return Response.json({ error: 'This opportunity does not belong to the Schema & Structure pillar.' }, { status: 400 })
  }

  // GATE -- requestVerification() itself enforces (via
  // lib/opportunityLifecycle.js#validateExecutionGate) that real execution
  // actually completed (execution_status 'executed' or 'human_completed')
  // before verification can even be requested. No duplicate gate logic
  // here -- a rejection here IS that shared rule firing, surfaced as-is.
  try {
    await requestVerification(opportunity.id, { actor: 'am' })
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 409 })
  }

  const deployedJsonLd = opportunity.execution_state?.result?.deployedJsonLd || null
  if (!deployedJsonLd) {
    // execution_status can be 'human_completed' via the RED handoff path
    // (a human did the work outside this tool entirely) -- this route's
    // WordPress-specific live-diff check has nothing of ours to compare
    // against in that case. Honestly inconclusive, never guessed.
    const evidence = [{ text: 'No Firestarter-deployed JSON-LD is on record for this opportunity -- it may have been executed manually rather than through Deploy to WordPress.' }]
    await recordVerification(opportunity.id, { result: 'inconclusive', evidence, method: 'live_fetch', actor: 'am' })
    return Response.json({ verificationStatus: 'inconclusive', message: 'No Firestarter-deployed schema is on record for this opportunity.' })
  }

  const absoluteUrl = resolvePageUrl(client.url, path)
  if (!absoluteUrl) {
    const evidence = [{ text: 'Could not resolve an absolute URL for this page.' }]
    await recordVerification(opportunity.id, { result: 'inconclusive', evidence, method: 'live_fetch', actor: 'am' })
    return Response.json({ verificationStatus: 'inconclusive', message: 'Could not resolve an absolute URL for this page.' })
  }

  const fetchResult = await fetchWebPage(absoluteUrl, { requireHtml: true })
  if (fetchResult.fetchState !== 'success') {
    // A failed FETCH is never reported as "execution failed" or "schema
    // absent" -- instruction #13's explicit distinction: DEPLOYED — LIVE
    // VERIFICATION COULD NOT BE COMPLETED. Cache/CDN propagation delay
    // (instruction #14) is one honest possible cause among several
    // (timeout, robots, a transient site issue) -- this never guesses
    // which, it only reports the real fetch failure category.
    const evidence = [{ text: `Live fetch failed (${fetchResult.failureCategory}): ${fetchResult.failureDetail}` }]
    await recordVerification(opportunity.id, { result: 'inconclusive', evidence, method: 'live_fetch', actor: 'am' })
    return Response.json({
      verificationStatus: 'inconclusive',
      message: 'DEPLOYED — LIVE VERIFICATION COULD NOT BE COMPLETED',
      failureCategory: fetchResult.failureCategory,
      failureDetail: fetchResult.failureDetail
    })
  }

  const check = verifyDeployedSchema({ jsonLd: deployedJsonLd, html: fetchResult.html })
  if (check.ok) {
    await recordVerification(opportunity.id, { result: 'verified', evidence: check.matched, method: 'live_fetch', actor: 'am' })
    return Response.json({ verificationStatus: 'verified', matched: check.matched })
  }

  // Live page loaded fine, but the expected schema is absent/mismatched --
  // this IS a real "VERIFICATION FAILED," never silently retried until
  // green (instruction #13).
  await recordVerification(opportunity.id, { result: 'failed_verification', evidence: check.missing, method: 'live_fetch', actor: 'am' })
  return Response.json({ verificationStatus: 'failed_verification', reason: check.reason, missing: check.missing })
}

module.exports = { POST, maxDuration }
