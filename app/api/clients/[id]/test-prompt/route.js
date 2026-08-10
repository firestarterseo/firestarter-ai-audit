const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { checkAiVisibilitySnapshot, DEFAULT_ENGINES } = require('../../../../../lib/checkers/ai-visibility-snapshot-checker')

// Ad-hoc, non-graded prompt tester -- separate from the main "Run audit
// now" flow. Lets a strategist type any exact phrasing ("Denver SEO",
// "best SEO Denver", etc.) and see live per-engine results immediately,
// without waiting on prompt auto-generation from page schema (see
// business-profile.js) and without it being scored/stored as part of the
// client's graded history. Same live 5-engine Cloro call under the hood,
// same CLORO_API_KEY (only ever read from the server env, never touched
// or logged here).
const maxDuration = 60

async function POST(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) return Response.json({ error: 'A prompt is required.' }, { status: 400 })

  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('*').eq('id', id).single()
  if (error) return Response.json({ error: error.message }, { status: 404 })

  let domain = null
  try {
    domain = new URL(client.url).hostname.replace(/^www\./, '')
  } catch (e) {
    // leave domain null -- citation matching just won't fire, mention
    // matching (name-based) still works fine.
  }

  const profile = { name: client.name, domain, category: client.category, city: client.city, region: client.region }

  try {
    const result = await checkAiVisibilitySnapshot(profile, [prompt], {
      apiKey: process.env.CLORO_API_KEY,
      engines: DEFAULT_ENGINES
    })
    return Response.json({ prompt, result })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

module.exports = { POST, maxDuration }
