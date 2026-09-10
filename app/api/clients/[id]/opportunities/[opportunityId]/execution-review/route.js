const { getSupabaseServerClient } = require('../../../../../../../lib/supabaseServer')
const { buildExecutionReview } = require('../../../../../../../lib/promptGapExecution')

// GET -> read-only "current vs proposed" comparison for an already-
// generated content execution plan (see lib/promptGapExecution.js). Safe
// to call any time, including before approval -- never mutates the
// opportunity, never publishes anything. Re-fetches the live page fresh on
// every call so "current" always means "right now."
async function GET(request, { params }) {
  const { id, opportunityId } = await params
  const supabase = getSupabaseServerClient()

  const { data: opportunity, error: oppError } = await supabase
    .from('opportunities').select('id, client_id').eq('id', opportunityId).eq('client_id', id).single()
  if (oppError || !opportunity) {
    return Response.json({ error: oppError?.message || 'Opportunity not found for this client.' }, { status: 404 })
  }

  const { data: client, error: clientError } = await supabase.from('clients').select('*').eq('id', id).single()
  if (clientError || !client) {
    return Response.json({ error: clientError?.message || 'Client not found.' }, { status: 404 })
  }

  try {
    const review = await buildExecutionReview(id, opportunityId, { client })
    if (review.error) return Response.json({ error: review.error }, { status: 400 })
    return Response.json({ review })
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 400 })
  }
}

module.exports = { GET }
