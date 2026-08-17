const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { classifyClientIndustryProfile, getClientIndustryProfile } = require('../../../../../lib/clientIndustryIntelligence')

// Runs (or re-runs -- "Re-detect") one Client/Industry Intelligence
// classification pass for a single client: bounded evidence gathering (one
// homepage fetch, one Ahrefs organic-keywords call where configured), one
// forced-tool-use Anthropic classification call, then persistence through
// Phase 1a's pinning-aware write path. Mirrors app/api/clients/[id]/audit/
// route.js's exact pattern (fetch client, call orchestrator, Response.json).
//
// POST body: { dryRun?: boolean } -- dryRun predicts what would be written
// (insert / update / no-op / conflict-recommendation-created / etc.)
// without touching the database at all. Used by the real-client validation
// pass and available to any future admin tooling that wants a safe preview
// before committing a batch of real writes.
//
// maxDuration: classification does at most 3 bounded external calls (site
// fetch, Ahrefs, Anthropic) -- generous but well under audit/route.js's
// 120s, since there's no per-engine Cloro fan-out here.
const maxDuration = 60

async function POST(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const dryRun = body.dryRun === true

  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('*').eq('id', id).single()
  if (error) return Response.json({ error: error.message }, { status: 404 })

  try {
    const result = await classifyClientIndustryProfile(client, { dryRun })
    if (!result.ok) {
      // Honest failure -- classification could not complete, but this is
      // not a server error: the client page must keep working and nothing
      // was written. 200 with ok:false, not 500, so the UI can render a
      // clear "couldn't classify" state rather than a generic error toast.
      return Response.json(result)
    }
    const profile = dryRun ? null : await getClientIndustryProfile(id)
    return Response.json({ ...result, profile })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

module.exports = { POST, maxDuration }
