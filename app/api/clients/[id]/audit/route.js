const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { runAudit } = require('../../../../../lib/runAudit')

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

module.exports = { POST }
