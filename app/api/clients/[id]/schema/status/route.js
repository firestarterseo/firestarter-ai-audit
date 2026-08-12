const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { checkWordPressSchemaStatus } = require('../../../../../../lib/wpPublish')

const maxDuration = 30

// GET -> { connected: true, hasSchema, jsonLd, updatedAt } | { connected: false, error }
// Checks what's ACTUALLY live on the client's WordPress site right now, via
// the Firestarter AI Schema plugin's public /status route -- no credentials
// needed for this direction, since it only ever echoes what's already
// publicly rendered in the site's own <head>. This is the "doubles as the
// Schema pillar's live verification source" piece from the original plan:
// a strategist (or, later, the Schema & Structure pillar itself) can
// confirm a publish actually took, instead of just trusting a past
// "Publish" click succeeded.
async function GET(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('url').eq('id', id).single()
  if (error) return Response.json({ error: error.message }, { status: 404 })

  const status = await checkWordPressSchemaStatus({ url: client.url })
  return Response.json(status)
}

module.exports = { GET, maxDuration }
