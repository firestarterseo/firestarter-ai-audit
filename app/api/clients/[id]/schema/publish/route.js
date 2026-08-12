const { getSupabaseServerClient } = require('../../../../../../lib/supabaseServer')
const { generateSchemaWithHints } = require('../../../../../../lib/schemaGenerator')
const { decrypt } = require('../../../../../../lib/wpCredentials')
const { publishSchemaToWordPress } = require('../../../../../../lib/wpPublish')

// Live homepage fetch (via generateSchemaWithHints) plus a second live
// request to the client's own WordPress site -- same reasoning as the
// schema GET route's maxDuration.
const maxDuration = 30

// POST -> { ok: true, updatedAt } | { ok: false, error }
// The actual "Publish to WordPress" action. Generates the EXACT same
// schema the strategist already previewed in the UI (via
// generateSchemaWithHints -- shared with the GET route in ../route.js, so
// there's no second, possibly-different computation happening here) and
// pushes it to the client's own site via the Firestarter AI Schema plugin's
// REST endpoint, authenticated with the WordPress Application Password the
// strategist connected earlier (see the PATCH handler in
// app/api/clients/[id]/route.js). Records wp_last_published_at on success
// so the UI can show "last published" rather than just "connected."
async function POST(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('*').eq('id', id).single()
  if (error) return Response.json({ error: error.message }, { status: 404 })

  if (!client.wp_username || !client.wp_app_password_encrypted) {
    return Response.json({ ok: false, error: 'This client isn\'t connected to WordPress yet -- add a username and Application Password first.' }, { status: 400 })
  }

  let wpAppPassword
  try {
    wpAppPassword = decrypt(client.wp_app_password_encrypted)
  } catch (e) {
    return Response.json({ ok: false, error: `Could not decrypt the stored WordPress credential: ${e.message}` }, { status: 500 })
  }

  const { jsonLd } = await generateSchemaWithHints(client)

  const result = await publishSchemaToWordPress({
    url: client.url,
    wpUsername: client.wp_username,
    wpAppPassword,
    jsonLd
  })

  if (!result.ok) return Response.json(result, { status: 502 })

  await supabase
    .from('clients')
    .update({ wp_last_published_at: new Date().toISOString() })
    .eq('id', id)

  return Response.json(result)
}

module.exports = { POST, maxDuration }
