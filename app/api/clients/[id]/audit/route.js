const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { runAudit } = require('../../../../../lib/runAudit')

// A full audit fetches the live site AND queries 5 AI engines through Cloro
// -- routinely 30-60s. Without this, Vercel's default function duration can
// cut the response off before the browser hears back, even though the run
// itself completes and writes to the DB fine (which is exactly what made
// the "Run audit now" button look frozen -- the work finished, the HTTP
// response just never made it back in time).
const maxDuration = 60

async function POST(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('*').eq('id', id).single()
  if (error) return Response.json({ error: error.message }, { status: 404 })

  try {
    const result = await runAudit(client, { triggerSource: 'manual' })
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

module.exports = { POST, maxDuration }
