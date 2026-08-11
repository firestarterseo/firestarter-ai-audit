const { getClientWithRuns } = require('../../../../lib/data')
const { getSupabaseServerClient } = require('../../../../lib/supabaseServer')

async function GET(request, { params }) {
  try {
    const { id } = await params
    const result = await getClientWithRuns(id)
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: err.message }, { status: 404 })
  }
}

// PATCH { status: 'lead' | 'tracked' } -- the only field this supports
// today. Moving a client to 'tracked' is what makes the weekly cron job
// (lib/trackAiVisibility.js) start picking them up; moving back to 'lead'
// stops that and reverts the AI & GEO Visibility pillar to one-off
// snapshot mode on the next audit. Before this endpoint existed, changing
// status required a direct SQL update against Supabase.
async function PATCH(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (body.status !== 'lead' && body.status !== 'tracked') {
    return Response.json({ error: 'status must be "lead" or "tracked".' }, { status: 400 })
  }

  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('clients')
    .update({ status: body.status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ client: data })
}

// DELETE -- permanently removes the client and, via the DB's own
// ON DELETE CASCADE foreign keys (confirmed directly against the schema,
// not assumed), every audit_runs / pillar_scores / ai_visibility_tracked_runs
// row for them too. Genuinely irreversible; the confirm step lives in the
// UI (ClientActions.js), not here -- this endpoint does exactly what it's
// told once called.
async function DELETE(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { error } = await supabase.from('clients').delete().eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ deleted: true })
}

module.exports = { GET, PATCH, DELETE }
