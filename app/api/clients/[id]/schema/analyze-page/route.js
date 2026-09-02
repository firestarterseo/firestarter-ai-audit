const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { analyzePage } = require('../../../../../../lib/pageAnalysis')

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
// same as schema/route.js's own live homepage fetch). No result is
// persisted anywhere -- see lib/schemaPageLifecycle.js's header on why
// this phase's page states are current-run / UI-state-only.
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
  return Response.json(result)
}

module.exports = { POST, maxDuration }
