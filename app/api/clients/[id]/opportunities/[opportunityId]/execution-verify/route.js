const { getSupabaseServerClient } = require('../../../../../../../lib/supabaseServer')
const { verifyExecutionReview } = require('../../../../../../../lib/promptGapExecution')

// POST -> the real "Re-fetch & verify" step: re-fetches the live page and
// checks whether the APPROVED content plan's title/H1 are actually
// present, then records the result via lib/opportunityLifecycle.js's
// requestVerification/recordVerification (same gate Schema's verify-work
// route relies on -- throws unless execution_status is already 'executed'
// or 'human_completed', i.e. the AM has already published the change).
// Never accepts a payload from the request body -- always re-reads the
// opportunity's approved_prepared_work_id fresh from the DB, same anti-
// tamper provenance rule as schema/execute-work/route.js.
async function POST(request, { params }) {
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
    const result = await verifyExecutionReview(id, opportunityId, { client, actor: 'am' })
    return Response.json({ result })
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 400 })
  }
}

module.exports = { POST }
