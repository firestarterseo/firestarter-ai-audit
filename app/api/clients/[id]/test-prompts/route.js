const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { extractBusinessProfile, generatePromptCandidates } = require('../../../../../lib/checkers/business-profile')

const MIN_PROMPTS = 3
const MAX_PROMPTS = 7

// GET -> { candidates: string[], saved: string[] }
// Fetches the live homepage fresh (same as a real audit would) so
// suggestions reflect the site as it is right now, not a stale profile.
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
    // A fetch failure just means candidates fall back to client-record
    // fields only (still works fine -- extractBusinessProfile handles a
    // missing/empty page).
  }

  const profile = extractBusinessProfile(homepageHtml, client.url, {
    name: client.name,
    city: client.city,
    region: client.region,
    category: client.category
  })
  const candidates = generatePromptCandidates(profile)

  return Response.json({ candidates, saved: client.test_prompts || [], min: MIN_PROMPTS, max: MAX_PROMPTS })
}

// POST { prompts: string[] } -> replaces the client's confirmed test-prompt
// set wholesale. Must be either empty (revert to fully automatic mode) or
// between MIN_PROMPTS and MAX_PROMPTS terms -- confirming "just 1" would
// recreate the exact single-guess problem this whole feature exists to fix.
async function POST(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const prompts = Array.isArray(body.prompts) ? body.prompts.map(p => String(p).trim()).filter(Boolean) : null
  if (prompts === null) return Response.json({ error: 'prompts must be an array of strings.' }, { status: 400 })

  const deduped = Array.from(new Set(prompts))
  if (deduped.length > 0 && (deduped.length < MIN_PROMPTS || deduped.length > MAX_PROMPTS)) {
    return Response.json({ error: `Save either 0 terms (fully automatic) or between ${MIN_PROMPTS} and ${MAX_PROMPTS} terms.` }, { status: 400 })
  }

  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('clients')
    .update({ test_prompts: deduped })
    .eq('id', id)
    .select('test_prompts')
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ test_prompts: data.test_prompts })
}

module.exports = { GET, POST, MIN_PROMPTS, MAX_PROMPTS }
