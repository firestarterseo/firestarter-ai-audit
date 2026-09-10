const { getSupabaseServerClient } = require('../../../../../../../lib/supabaseServer')
const { generateExecutionPlan } = require('../../../../../../../lib/promptGapPreparedWork')
const { getPreparedWork } = require('../../../../../../../lib/opportunityLifecycle')

// GET -> { preparedWork: [...] }. Pure read -- every prepared-work version
// ever generated for this opportunity, newest first per artifact type
// (same shape SchemaWizard.js's own prepared-work review already consumes).
async function GET(request, { params }) {
  const { id, opportunityId } = await params
  const supabase = getSupabaseServerClient()
  const { data: opportunity, error: oppError } = await supabase
    .from('opportunities').select('id, client_id').eq('id', opportunityId).eq('client_id', id).single()
  if (oppError || !opportunity) {
    return Response.json({ error: oppError?.message || 'Opportunity not found for this client.' }, { status: 404 })
  }
  try {
    const preparedWork = await getPreparedWork(opportunityId)
    return Response.json({ preparedWork })
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 400 })
  }
}

// POST -> generates a real execution plan (a content brief, or a relevance/
// entity page-edit proposal) for an ALREADY-EXISTING, already-validated
// Opportunity and stores it as a new opportunity_prepared_work version --
// never creates an Opportunity, never touches prompt_gap_analysis or gap
// analysis. Schema/Technical opportunities are explicitly routed to the
// existing Schema Wizard instead (see lib/promptGapPreparedWork.js).
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
    const result = await generateExecutionPlan(id, opportunityId, { client, actor: 'am' })
    return Response.json({ result })
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 400 })
  }
}

module.exports = { GET, POST }
