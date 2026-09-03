const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { analyzePage, resolvePageUrl } = require('../../../../../../lib/pageAnalysis')
const { upsertAnalysisResult } = require('../../../../../../lib/schemaPageWork')

// Live page fetch -- same reasoning as schema/route.js's maxDuration (a
// single external fetch, generous but bounded).
const maxDuration = 30

// POST { path } -> lib/pageAnalysis.js's analyzePage() result, verbatim.
//
// PRODUCT DECISION #8: "Do not fetch every discovered page automatically.
// Fetch only when the AM analyzes a queued/open page. That keeps cost
// bounded." This route is the ONLY place in the app that calls
// lib/pageAnalysis.js -- it exists specifically so SchemaWizard.js's
// "Analyze page" action has a server-side place to run a real fetch (the
// browser can't fetch an arbitrary client's live site directly -- CORS,
// and this project's consistent "server does the fetching" convention,
// same as schema/route.js's own live homepage fetch). The in-memory page
// LIFECYCLE state derived from this result (lib/schemaPageLifecycle.js) is
// still current-run / UI-state-only, unchanged -- but the raw diagnosis
// itself is now additionally persisted durably (Phase 5, 2026-09) via
// lib/schemaPageWork.js below, best-effort, so a page refresh doesn't lose
// it. See that call's own comment for the non-fatal error handling.
//
// `path` must be a site-relative path (as returned by
// lib/sitemapDiscovery.js's page classification, e.g. "/denver-seo-agency/")
// -- never a full URL, so this route can never be used to fetch an
// arbitrary third-party URL on the client's behalf.
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
  const { data: client, error } = await supabase.from('clients').select('url').eq('id', id).single()
  if (error) return Response.json({ error: error.message }, { status: 404 })
  if (!client?.url) return Response.json({ error: 'This client has no site URL on file.' }, { status: 400 })

  // The page's own sitemap-classification metadata (type, source,
  // confidence) travels with the request from the client -- SchemaWizard.js
  // already has this dossier in memory (it's part of `pillar.raw.sitemapPages`,
  // fetched once per audit run), and re-deriving it server-side here would
  // mean re-fetching and re-walking the ENTIRE sitemap just to analyze one
  // page, which is exactly the unbounded-cost behavior PRODUCT DECISION #8
  // rules out. `page` is trusted only for classification metadata, never
  // used to bypass the path-must-be-site-relative check above.
  const page = {
    type: typeof body?.page?.type === 'string' ? body.page.type : 'Other',
    classificationSource: typeof body?.page?.classificationSource === 'string' ? body.page.classificationSource : 'unknown',
    classificationConfidence: typeof body?.page?.classificationConfidence === 'string' ? body.page.classificationConfidence : 'low'
  }

  const result = await analyzePage({ path, page, siteUrl: client.url })

  // PERSIST (Phase 5, 2026-09) -- every completed analysis, regardless of
  // finalStatus (ACTION_REQUIRED, IMPROVEMENT_AVAILABLE, NO_ACTION_NEEDED,
  // or COULD_NOT_VERIFY including a genuine fetch failure -- analyzePage()
  // never throws, so `result` always exists), is saved durably so a page
  // refresh doesn't lose it. This is best-effort/non-fatal: the diagnosis
  // itself already succeeded above and must never be withheld from the AM
  // because of a database hiccup, so a persistence failure here is
  // reported alongside the real result rather than replacing it with an
  // error response.
  let persistence = { ok: true }
  try {
    const classification = page.type ? { type: page.type, source: page.classificationSource, confidence: page.classificationConfidence } : null
    const pageUrl = resolvePageUrl(client.url, path)
    await upsertAnalysisResult({ clientId: id, path, pageUrl, classification, analysis: result, actor: 'system' })
  } catch (e) {
    console.error('[schema/analyze-page] persistence failed:', e)
    persistence = {
      ok: false,
      errorClass: 'persistence',
      phase: 'upsert_analysis_result',
      code: (e && typeof e.code === 'string') ? e.code : null
    }
  }

  return Response.json({ ...result, persistence })
}

module.exports = { POST, maxDuration }
