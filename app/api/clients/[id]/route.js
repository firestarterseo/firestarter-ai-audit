const { getClientWithRuns, sanitizeClient } = require('../../../../lib/data')
const { getSupabaseServerClient } = require('../../../../lib/supabaseServer')
const { resolveSchemaType } = require('../../../../lib/schemaGenerator')
const { encrypt } = require('../../../../lib/wpCredentials')

async function GET(request, { params }) {
  try {
    const { id } = await params
    const result = await getClientWithRuns(id)
    return Response.json({ ...result, client: sanitizeClient(result.client) })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 404 })
  }
}

// PATCH -- originally just { status }, now also accepts the Schema
// Generator's business-detail fields (street_address, postal_code, phone,
// description, same_as, schema_type). All fields are optional and only the
// ones actually present in the body get updated, so the existing
// status-toggle caller (ClientActions.js, which only ever sends { status })
// keeps working unchanged.
async function PATCH(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))

  const update = { updated_at: new Date().toISOString() }

  if ('status' in body) {
    if (body.status !== 'lead' && body.status !== 'tracked') {
      return Response.json({ error: 'status must be "lead" or "tracked".' }, { status: 400 })
    }
    update.status = body.status
  }

  // Schema Generator fields -- see lib/schemaGenerator.js. Plain strings,
  // trimmed and nulled-out-if-empty so clearing a field in the form
  // actually clears it in the DB rather than saving an empty string.
  // city/region are included here too (not just the fields added in the
  // schema-generator migration) since the Schema Generator's live-site
  // auto-detection can now fill them in when a client was created without
  // them -- this is the only save path that touches them besides the
  // "new client" form, which sets them once at creation and never again.
  ;['street_address', 'city', 'region', 'postal_code', 'phone', 'description'].forEach(field => {
    if (field in body) {
      const value = typeof body[field] === 'string' ? body[field].trim() : ''
      update[field] = value || null
    }
  })

  if ('same_as' in body) {
    update.same_as = Array.isArray(body.same_as)
      ? body.same_as.map(u => String(u).trim()).filter(Boolean)
      : []
  }

  if ('schema_type' in body) {
    // resolveSchemaType falls back to 'LocalBusiness' for anything not in
    // checker.js's own recognized BUSINESS_ENTITY_TYPES list -- generated
    // schema must only ever use a type this project's own checker can
    // actually grade, per schemaGenerator.js's header comment.
    update.schema_type = resolveSchemaType({ schema_type: body.schema_type })
  }

  // WordPress connection -- see lib/wpCredentials.js and the publish route
  // (schema/publish/route.js). wp_username is stored as plain text (just an
  // identifier); wp_app_password is a real site credential (a WordPress
  // Application Password) and is encrypted before it ever touches the
  // database. Sending an empty wp_app_password disconnects the site
  // (clears both the username and the stored credential) rather than
  // silently keeping a stale one around with nothing to pair it with.
  if ('wp_username' in body || 'wp_app_password' in body) {
    const appPassword = typeof body.wp_app_password === 'string' ? body.wp_app_password.trim() : ''
    if (!appPassword) {
      update.wp_username = null
      update.wp_app_password_encrypted = null
      update.wp_connected_at = null
    } else {
      const username = typeof body.wp_username === 'string' ? body.wp_username.trim() : ''
      if (!username) {
        return Response.json({ error: 'wp_username is required when setting a WordPress Application Password.' }, { status: 400 })
      }
      update.wp_username = username
      update.wp_app_password_encrypted = encrypt(appPassword)
      update.wp_connected_at = new Date().toISOString()
    }
  }

  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('clients')
    .update(update)
    .eq('id', id)
    .select()
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ client: sanitizeClient(data) })
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
