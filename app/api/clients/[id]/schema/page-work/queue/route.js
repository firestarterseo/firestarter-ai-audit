const { getSupabaseServerClient } = require('../../../../../../../lib/supabaseServer')
const { resolvePageUrl } = require('../../../../../../../lib/pageAnalysis')
const { upsertQueueState } = require('../../../../../../../lib/schemaPageWork')

// POST { path, queued, page? } -> the current schema_page_work row (or
// null, if this was an unqueue of a page with no durable row -- see
// lib/schemaPageWork.js#upsertQueueState) for the AM's explicit queue/
// unqueue action on one page.
//
// Same trust boundary as analyze-page/route.js and prepare-work/route.js:
// `path` must be site-relative and is resolved into a real page URL
// SERVER-SIDE via lib/pageAnalysis.js#resolvePageUrl(client.url, path) --
// never trusted from the request body -- and `page` classification
// metadata (if present) is used only as a display hint on first creation,
// never to bypass that resolution.
//
// This route is the ONLY caller of upsertQueueState -- it never touches
// analysis/final_status/opportunity_id (those are analyze-page/route.js's
// and prepare-work/route.js's jobs respectively), matching
// lib/schemaPageWork.js's own documented queue/analysis field boundary.
async function POST(request, { params }) {
  const { id } = await params
  let body
  try {
    body = await request.json()
  } catch (e) {
    return Response.json({ error: 'Request body must be JSON with "path" and "queued" fields.', errorClass: 'validation' }, { status: 400 })
  }

  const path = typeof body?.path === 'string' ? body.path : null
  if (!path || !path.startsWith('/')) {
    return Response.json({ error: 'path must be a site-relative path starting with "/".', errorClass: 'validation' }, { status: 400 })
  }
  if (typeof body?.queued !== 'boolean') {
    return Response.json({ error: 'queued must be a boolean.', errorClass: 'validation' }, { status: 400 })
  }

  const supabase = getSupabaseServerClient()
  let client
  try {
    const { data, error: clientError } = await supabase.from('clients').select('url').eq('id', id).single()
    if (clientError) return Response.json({ error: clientError.message, errorClass: 'validation' }, { status: 404 })
    client = data
  } catch (e) {
    return logAndClassify(e, 'client_lookup', 'Could not look up this client to update the Schema queue.')
  }
  if (!client?.url) return Response.json({ error: 'This client has no site URL on file.', errorClass: 'validation' }, { status: 400 })

  const pageUrl = resolvePageUrl(client.url, path)
  if (!pageUrl) {
    return Response.json({ error: 'This path could not be resolved to a page on the client\'s site.', errorClass: 'validation' }, { status: 400 })
  }

  const classification = body?.page && typeof body.page.type === 'string' ? { type: body.page.type } : null

  try {
    const row = await upsertQueueState({ clientId: id, path, pageUrl, classification, queued: body.queued, actor: 'am' })
    return Response.json({
      row: row ? {
        normalizedPath: row.normalized_path,
        queueStatus: row.queue_status,
        queuedAt: row.queued_at
      } : null
    })
  } catch (e) {
    return logAndClassify(e, 'upsert_queue_state', 'Could not save this queue change. It was not persisted -- try again.')
  }
}

// logAndClassify -- same contract as prepare-work/route.js's own helper:
// never echoes a raw error message/stack/SQL, always a safe fixed message
// plus a Postgres SQLSTATE `code` when available.
function logAndClassify(error, phase, safeMessage) {
  console.error(`[schema/page-work/queue] ${phase} failed:`, error)
  return Response.json({
    error: safeMessage,
    errorClass: 'persistence',
    phase,
    code: (error && typeof error.code === 'string') ? error.code : null
  }, { status: 500 })
}

module.exports = { POST }
