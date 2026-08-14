const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')

// Opportunities -- durable, individually-trackable findings (see
// lib/opportunities.js and ROADMAP.md's "audit -> execution" architecture).
// v1 only populates content_brief rows sourced from Competitive Position's
// missing-keyword opportunities, synced on every audit run -- this route
// is the strategist-facing read/status-update surface for whatever rows
// exist, regardless of which pillar/type they came from, so it doesn't
// need updating as more sources get wired in later.

const VALID_STATUSES = ['open', 'in_progress', 'done', 'dismissed']

// GET -> { opportunities: [...] } for this client, highest priority_score
// first (nulls last). Returns everything regardless of status -- same
// "return it all, UI decides what to show" pattern as the competitors
// route -- OpportunitiesManager.js groups open/in_progress vs done/
// dismissed client-side.
async function GET(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('opportunities')
    .select('*')
    .eq('client_id', id)
    .order('priority_score', { ascending: false, nullsFirst: false })
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ opportunities: data || [] })
}

// PATCH { opportunityId, status } -> a strategist manually moving an
// opportunity through open -> in_progress -> done, or dismissing one
// that isn't worth pursuing. Once set here, the next audit run's
// lib/opportunities.js sync will NOT override this status (see that
// file's header) -- a manual call always wins over auto-refresh/auto-close.
async function PATCH(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const opportunityId = body.opportunityId
  const status = body.status
  if (!opportunityId) return Response.json({ error: 'opportunityId is required.' }, { status: 400 })
  if (!VALID_STATUSES.includes(status)) return Response.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 })

  const now = new Date().toISOString()
  const updates = {
    status,
    updated_at: now,
    closed_at: (status === 'done' || status === 'dismissed') ? now : null
  }

  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('opportunities')
    .update(updates)
    .eq('id', opportunityId)
    .eq('client_id', id)
    .select()
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ opportunity: data })
}

module.exports = { GET, PATCH }
