const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { generateBusinessSchema, toScriptSnippet, previewGrade, extractContactHints } = require('../../../../../lib/schemaGenerator')

// Live homepage fetch (same as the test-prompts route) is what makes this
// worth its own maxDuration -- generation itself is instant.
const maxDuration = 30

// GET -> { jsonLd, scriptSnippet, missingFields, suggested, preview: {...} }
// Auto-fills whatever it can find on the client's own live homepage
// (existing partial schema, tel: links, social/profile links, meta
// description) for any field not already saved on the client record -- a
// strategist should review and confirm, not type these in from a blank
// form when the site already has the answer sitting in its own markup.
// `suggested` lists exactly which fields this call filled in (vs. what was
// already saved), so the UI can label them as auto-detected rather than
// presenting them as if the strategist had entered them. Never overrides a
// value that's already set, including one deliberately left blank on
// purpose after a prior save. city/region are included here (not just
// street_address/postal_code) because they're real `clients` columns used
// elsewhere in this project (AI-visibility prompt generation) -- if a
// client was created without them and the site's own JSON-LD has them,
// there's no reason to leave that gap unfilled.
async function GET(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('*').eq('id', id).single()
  if (error) return Response.json({ error: error.message }, { status: 404 })

  let homepageHtml = ''
  try {
    const res = await fetch(client.url, { headers: { 'User-Agent': 'FirestarterAIAudit/1.0' } })
    if (res.ok) homepageHtml = await res.text()
  } catch (e) {
    // A fetch failure just means no auto-detected hints this time -- the
    // generator still works fine from whatever's already saved, same as
    // every other live-fetch-dependent feature in this project degrading
    // to "no data" rather than failing outright.
  }

  const hints = extractContactHints(homepageHtml, { domain: client.domain })
  const suggested = {}
  if (!client.street_address && hints.address?.street_address) suggested.street_address = hints.address.street_address
  if (!client.city && hints.address?.city) suggested.city = hints.address.city
  if (!client.region && hints.address?.region) suggested.region = hints.address.region
  if (!client.postal_code && hints.address?.postal_code) suggested.postal_code = hints.address.postal_code
  if (!client.phone && hints.phone) suggested.phone = hints.phone
  if ((!client.same_as || client.same_as.length === 0) && hints.sameAs.length > 0) suggested.same_as = hints.sameAs
  if (!client.description && hints.description) suggested.description = hints.description

  // The live preview reflects what generation would actually produce if
  // the strategist saves as-is right now -- merging suggestions in here,
  // not just returning them inert, so the grade shown matches reality
  // instead of understating it before anything's even been saved.
  const mergedClient = { ...client, ...suggested }
  const { jsonLd, missingFields } = generateBusinessSchema(mergedClient)
  const scriptSnippet = toScriptSnippet(jsonLd)
  const preview = await previewGrade(jsonLd)

  return Response.json({
    jsonLd,
    scriptSnippet,
    missingFields,
    suggested,
    preview: { grade: preview.grade, score: preview.score, checks: preview.checks, issues: preview.issues }
  })
}

module.exports = { GET, maxDuration }
