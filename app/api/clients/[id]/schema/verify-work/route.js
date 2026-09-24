const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { resolvePageUrl } = require('../../../../../../lib/pageAnalysis')
const { fetchWebPage } = require('../../../../../../lib/webPageFetch')
const { verifyApprovedSchemaLive } = require('../../../../../../lib/schemaLiveVerification')
const { buildApprovedNodes } = require('../../../../../../lib/schemaArtifactIntegrity')
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
// "what schema should be live" from a fresh diagnosis -- that stays
// honestly a different question (a future re-analysis, not this route, is
// where it belongs; see instruction #22).
//
// THREE-WAY ARTIFACT CHAIN (2026-09-24 correction, Part 2): APPROVED,
// DEPLOYED, and LIVE are three separate facts, each preserved as its own
// evidence -- the currently-approved opportunity_prepared_work row (the
// authoritative intent), execution_state.result.deployedJsonLd (evidence
// of what execution CLAIMS it sent -- still checked for existence below,
// still never deleted), and this route's own live fetch (evidence of what
// actually exists). This route's actual comparison is APPROVED -> LIVE --
// it re-reads the CURRENT approved prepared-work row fresh (never trusts
// deployedJsonLd alone as ground truth for what should be live -- a stale
// or, hypothetically, mismatched deployedJsonLd copy must never be able to
// produce a false VERIFIED for content the AM never actually approved).
// See lib/schemaLiveVerification.js#verifyApprovedSchemaLive's own header.
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

  // APPROVED -> LIVE INTEGRITY (2026-09-24 correction, Part 2/section 5):
  // deployedJsonLd (just confirmed to exist above) is EVIDENCE of what
  // execution claims it sent, never trusted alone as the ground truth for
  // "what should be live." The one authoritative source of intent is the
  // CURRENTLY APPROVED prepared-work row, re-read fresh here -- exactly
  // the same lookup execute-work/route.js uses at deploy time -- so
  // verification can never be fooled by a stale or (hypothetically)
  // mismatched deployedJsonLd copy into reporting VERIFIED for content the
  // AM never actually approved.
  if (!opportunity.approved_prepared_work_id) {
    const evidence = [{ text: 'No currently-approved prepared-work version is on record for this opportunity -- cannot verify against approved intent.' }]
    await recordVerification(opportunity.id, { result: 'inconclusive', evidence, method: 'live_fetch', actor: 'am' })
    return Response.json({ verificationStatus: 'inconclusive', message: 'No currently-approved prepared-work version is on record for this opportunity.' })
  }
  const { data: approvedRow, error: approvedRowError } = await supabase
    .from('opportunity_prepared_work').select('payload').eq('id', opportunity.approved_prepared_work_id).eq('opportunity_id', opportunity.id).maybeSingle()
  if (approvedRowError || !approvedRow) {
    const evidence = [{ text: 'The currently-approved prepared-work row could not be read back -- cannot verify against approved intent.' }]
    await recordVerification(opportunity.id, { result: 'inconclusive', evidence, method: 'live_fetch', actor: 'am' })
    return Response.json({ verificationStatus: 'inconclusive', message: 'The approved prepared-work version could not be read back.' })
  }
  const approvedNodes = buildApprovedNodes(approvedRow.payload)

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

  // APPROVED -> LIVE (not merely DEPLOYED -> LIVE): compared against
  // approvedNodes (the currently-approved artifact, re-read fresh above),
  // never deployedJsonLd -- see lib/schemaLiveVerification.js#verifyApprovedSchemaLive's
  // own header for the full root-cause writeup of the gap this closes. A
  // VERIFIED result is impossible unless the live page matches what the AM
  // actually approved, property for property.
  const check = verifyApprovedSchemaLive({ approvedNodes, html: fetchResult.html })
  if (check.ok) {
    await recordVerification(opportunity.id, { result: 'verified', evidence: check.matched, method: 'live_fetch', actor: 'am' })
    return Response.json({ verificationStatus: 'verified', matched: check.matched })
  }

  // Live page loaded fine, but the expected schema is absent/mismatched --
  // this IS a real "VERIFICATION FAILED," never silently retried until
  // green (instruction #13). `missing` now carries per-property `diffs`
  // (section 7) -- e.g. {path:'description', kind:'removed', expected:'...',
  // actual: undefined} -- so a caller/UI can show the AM exactly what
  // failed, not just that something did.
  await recordVerification(opportunity.id, { result: 'failed_verification', evidence: check.missing, method: 'live_fetch', actor: 'am' })
  return Response.json({ verificationStatus: 'failed_verification', reason: check.reason, missing: check.missing })
}

module.exports = { POST, maxDuration }
