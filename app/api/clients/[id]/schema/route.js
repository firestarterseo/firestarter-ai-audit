const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { generateBusinessSchema, toScriptSnippet, previewGrade } = require('../../../../../lib/schemaGenerator')

// GET -> { jsonLd, scriptSnippet, missingFields, preview: { grade, score, checks, issues } }
// Generates fresh from whatever's currently saved on the client record --
// there's nothing to cache here, generation is pure/instant (no live
// network calls, unlike every other checker in this project).
async function GET(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('*').eq('id', id).single()
  if (error) return Response.json({ error: error.message }, { status: 404 })

  const { jsonLd, missingFields } = generateBusinessSchema(client)
  const scriptSnippet = toScriptSnippet(jsonLd)
  const preview = await previewGrade(jsonLd)

  return Response.json({
    jsonLd,
    scriptSnippet,
    missingFields,
    preview: { grade: preview.grade, score: preview.score, checks: preview.checks, issues: preview.issues }
  })
}

module.exports = { GET }
