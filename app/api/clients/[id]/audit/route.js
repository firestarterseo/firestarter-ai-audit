const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { runAudit } = require('../../../../../lib/runAudit')

// A full audit fetches the live site AND queries 5 AI engines through Cloro
// concurrently -- but Cloro's per-engine sync calls have no timeout of
// their own (see defaultCloroCaller in ai-visibility-snapshot-checker.js),
// and real-world latency on the slowest engine can run well past 60s.
// Vercel's Hobby-plan default/max function duration is actually 300s (5
// min) as of mid-2026 -- an earlier maxDuration=60 here was a
// self-imposed limit well under what the platform allows, and was the
// actual cause of runs appearing to "freeze": the function got killed by
// THIS number, not by Vercel's real ceiling. Set generously below the
// platform max, not below what the slowest real Cloro call needs.
const maxDuration = 120

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
