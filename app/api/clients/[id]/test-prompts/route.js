const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { extractBusinessProfile, generatePromptCandidates, enrichProfileWithAhrefs } = require('../../../../../lib/checkers/business-profile')

const MIN_PROMPTS = 3
const MAX_PROMPTS = 7

// Ahrefs adds one more live network call on top of the homepage fetch --
// generous but bounded, same reasoning as the other live-data routes in
// this project (see app/api/clients/[id]/audit/route.js's maxDuration
// comment).
const maxDuration = 30

// GET -> { candidates: string[], saved: string[], usedAhrefs: boolean }
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
  // Ahrefs-first when AHREFS_API_KEY is configured -- real, ranking- and
  // volume-validated terms this domain already earns traffic from, ahead
  // of anything guessed from title/meta/schema type. Falls through to
  // those on its own (see business-profile.js) if there's no key yet, or
  // this domain has no organic rankings at all (e.g. a brand-new lead).
  const enriched = await enrichProfileWithAhrefs(profile, { apiKey: process.env.AHREFS_API_KEY })
  const candidates = generatePromptCandidates(enriched)
  const usedAhrefs = Array.isArray(enriched?.ahrefsTerms) && enriched.ahrefsTerms.length > 0

  return Response.json({ candidates, saved: client.test_prompts || [], min: MIN_PROMPTS, max: MAX_PROMPTS, usedAhrefs })
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

module.exports = { GET, POST, MIN_PROMPTS, MAX_PROMPTS, maxDuration }
