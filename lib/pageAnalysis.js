// ON-DEMAND PAGE-LEVEL SCHEMA ANALYSIS -- Phase B of the Schema
// page-workflow redesign (2026-09-02). This is PRODUCT DECISION #8's "main
// implementation goal": a real analysis primitive for an arbitrary QUEUED
// page, built from webPageFetch.js (transport) + lightweight-jsonld.js
// (extraction) + lib/schemaPageTypeChecks.js (page-type-dispatched
// evaluation) + the page's own sitemap-classification metadata. Nothing
// here is invented -- a page that can't be fetched is reported as an
// honest fetch failure, never silently scored as "no schema found."
//
// COST DISCIPLINE (explicit product direction): "Do not fetch every
// discovered page automatically. Fetch only when the AM analyzes a
// queued/open page." This module is called from exactly one place --
// app/api/clients/[id]/schema/analyze-page/route.js, itself only ever
// invoked by a strategist's explicit "Analyze page" click in
// SchemaWizard.js -- never from an audit run, a cron job, or a batch loop
// over the sitemap's full candidate universe.
//
// Zero Supabase/DB dependency: this module takes a plain page descriptor
// (the same shape lib/sitemapDiscovery.js already returns -- path, type,
// classificationSource, classificationConfidence) and a site base URL, and
// returns a plain result object. Persisting or interpreting that result
// (page-lifecycle state, queue membership) is the caller's job -- see
// lib/schemaPageLifecycle.js.

const { fetchWebPage } = require('./webPageFetch')
const { parseJsonLd } = require('./checkers/lightweight-jsonld')
const { runPageTypeChecks } = require('./schemaPageTypeChecks')

// resolvePageUrl(siteUrl, path) -> absolute URL string, or null if siteUrl
// doesn't parse OR the resolved URL doesn't stay on siteUrl's own origin.
// `path` is expected to be a site-relative path (as returned by
// lib/sitemapDiscovery.js), but a caller-supplied string like
// "//evil.example.com/x" is also, technically, a string starting with "/"
// -- and `new URL('//evil.example.com/x', 'https://good.example.com')`
// resolves to "https://evil.example.com/x" (a protocol-relative URL), NOT
// a path on the client's own site. The explicit same-origin check below is
// what actually prevents this route from being turned into an open fetch
// proxy for an arbitrary third-party host -- a plain `path.startsWith('/')`
// check alone (e.g. in the API route) is NOT sufficient on its own.
function resolvePageUrl(siteUrl, path) {
  let base
  try {
    base = new URL(siteUrl)
  } catch (e) {
    return null
  }
  let resolved
  try {
    resolved = new URL(path, base)
  } catch (e) {
    return null
  }
  if (resolved.origin !== base.origin) return null
  return resolved.toString()
}

// analyzePage({ path, page, siteUrl, fetcher }) -> analysis result object.
// NEVER throws -- a fetch failure is a normal, honestly-reported outcome
// (see webPageFetch.js's own FETCH FAILURE != ABSENCE OF EVIDENCE
// principle), not an exception a caller has to guard against.
//
// Returns, on fetch success:
//   { path, classification: { type, source, confidence }, fetchState: 'success',
//     targetProfile, currentSchema, coreChecks, recommendedChecks,
//     avoidFindings, notApplicable, finalStatus }
// Returns, on fetch failure:
//   { path, classification: { ... }, fetchState: 'failed', failureCategory,
//     failureDetail, targetProfile: null, currentSchema: [], coreChecks: [],
//     recommendedChecks: [], avoidFindings: [], notApplicable: [],
//     finalStatus: 'COULD_NOT_VERIFY' }
// `finalStatus: 'COULD_NOT_VERIFY'` on failure (DIAGNOSTIC METHODOLOGY pass,
// 2026-09-03; formerly `actionableGap: null`) is the same deliberate
// principle under its new name -- "we couldn't check" must never collapse
// into "nothing to fix." lib/schemaPageLifecycle.js's deriveStateFromAnalysis
// keeps a COULD_NOT_VERIFY page at UNANALYZED, never NO_ACTION_NEEDED.
async function analyzePage({ path, page = {}, siteUrl, fetcher } = {}) {
  const classification = {
    type: page.type || 'Other',
    source: page.classificationSource || 'unknown',
    confidence: page.classificationConfidence || 'low'
  }

  const failureResult = (failureCategory, failureDetail) => ({
    path, classification, fetchState: 'failed', failureCategory, failureDetail,
    targetProfile: null, currentSchema: [], coreChecks: [], recommendedChecks: [],
    avoidFindings: [], notApplicable: [], finalStatus: 'COULD_NOT_VERIFY'
  })

  const url = resolvePageUrl(siteUrl, path)
  if (!url) {
    return failureResult('invalid_url', 'Could not resolve an absolute URL for this page.')
  }

  const fetchResult = await fetchWebPage(url, { fetcher, requireHtml: true })
  if (fetchResult.fetchState !== 'success') {
    return failureResult(fetchResult.failureCategory, fetchResult.failureDetail)
  }

  const { byType, schemaNames, failed, scriptCount, parseFailureCount } = parseJsonLd(fetchResult.html)
  const checkResult = runPageTypeChecks(classification.type, { byType, schemaNames, failed, scriptCount, parseFailureCount, path })

  return {
    path, classification, fetchState: 'success',
    ...checkResult
  }
}

module.exports = { analyzePage, resolvePageUrl }
