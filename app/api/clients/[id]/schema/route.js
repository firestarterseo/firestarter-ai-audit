const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { generateSchemaWithHints } = require('../../../../../lib/schemaGenerator')

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
//
// The actual fetch -> hint-extraction -> merge -> generate -> preview chain
// lives in lib/schemaGenerator.js's generateSchemaWithHints -- shared with
// the WordPress publish route (see schema/publish/route.js) so what a
// strategist previews here is exactly what gets published, never a
// second, possibly-drifted computation of the same thing.
async function GET(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('*').eq('id', id).single()
  if (error) return Response.json({ error: error.message }, { status: 404 })

  const { jsonLd, scriptSnippet, missingFields, suggested, preview } = await generateSchemaWithHints(client)

  return Response.json({
    jsonLd,
    scriptSnippet,
    missingFields,
    suggested,
    preview: { grade: preview.grade, score: preview.score, checks: preview.checks, issues: preview.issues }
  })
}

module.exports = { GET, maxDuration }
