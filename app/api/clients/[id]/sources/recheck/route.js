const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { syncSourceCitationPillar } = require('../../../../../../lib/sourceCitation')

// POST -- explicit, AM-triggered re-check of the AI Source & Citation
// Presence pillar for one client. Added as part of the evidence-strength
// correction (2026-08-17): cited-page inspection (lib/citedPageInspection.js)
// is real network I/O with a staleness cache, so it normally only runs as
// part of a full audit (see lib/runAudit.js). This route exists for the
// case where an AM wants a fresh check RIGHT NOW (e.g. right after
// submitting a directory profile) without waiting for the next scheduled
// audit. It is the ONLY other place this pillar's cited-page inspection
// runs -- never from a page render, never automatically on a timer beyond
// the normal audit cadence.
async function POST(request, { params }) {
  const { id } = await params

  const supabase = getSupabaseServerClient()
  const { data: client, error: clientError } = await supabase.from('clients').select('id').eq('id', id).single()
  if (clientError || !client) {
    return Response.json({ error: clientError?.message || 'Client not found.' }, { status: 404 })
  }

  try {
    const result = await syncSourceCitationPillar({ id }, { actor: 'am_manual_recheck' })
    return Response.json({ result })
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 400 })
  }
}

module.exports = { POST }
