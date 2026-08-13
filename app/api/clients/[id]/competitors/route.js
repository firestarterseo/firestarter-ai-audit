const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { isNonCompetitorDomain, normalizeDomain } = require('../../../../../lib/nonCompetitorDomains')

// Competitive Position competitors -- list, manually add, and
// activate/deactivate/rename. Auto-detection itself (AI-citation +
// Ahrefs overlap) runs as part of every audit (see
// lib/competitorDetection.js, called from lib/runAudit.js) -- this route
// is for a strategist to review what was detected and, per direct
// feedback ("If we want to manually put in competitors later we can"),
// add a known competitor by hand at any time. Manual add/edit is always
// optional polish here, never a gate on grading (see
// lib/checkers/competitive-position-checker.js's header). normalizeDomain
// (shared with lib/competitorDetection.js) accepts either a bare domain
// ("rival.com") or a full URL ("https://www.rival.com/") -- either is a
// natural thing to paste in -- and strips "www." consistently, which
// matters here: client.domain is stored inconsistently across clients
// (some with "www.", some without), so comparing it to a normalized
// citation hostname without normalizing client.domain too would let a
// client's own site slip through as a "different domain" (a real bug
// found 2026-08-13).

// GET -> { competitors: [...] } (both active and inactive -- the UI
// itself decides what to show/hide, e.g. an "include deactivated"
// toggle) so a strategist can see and reactivate a previously removed
// entry rather than it just silently vanishing.
async function GET(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('client_competitors')
    .select('*')
    .eq('client_id', id)
    .order('detected_at', { ascending: true })
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ competitors: data || [] })
}

// POST { name?, domain } -> adds a competitor by hand, or -- if this
// domain was already detected/added before (unique on client_id+domain)
// -- reactivates it and marks it confirmed rather than erroring, since
// "add a competitor that's already there" most often means "bring back
// one I'd deactivated" or "confirm this one I noticed was auto-detected."
async function POST(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const domain = normalizeDomain(body.domain)
  if (!domain) return Response.json({ error: 'A valid domain is required (e.g. "rival.com" or "https://rival.com").' }, { status: 400 })
  if (isNonCompetitorDomain(`https://${domain}`)) {
    return Response.json({ error: `${domain} is a known directory/press/social platform, not a competing business -- not added.` }, { status: 400 })
  }

  const supabase = getSupabaseServerClient()

  const { data: client, error: clientError } = await supabase.from('clients').select('domain').eq('id', id).single()
  if (clientError) return Response.json({ error: clientError.message }, { status: 404 })
  if (normalizeDomain(client.domain) === domain) {
    return Response.json({ error: 'That domain matches the client\'s own site -- a competitor has to be a different business.' }, { status: 400 })
  }

  const name = body.name ? String(body.name).trim() : null
  const now = new Date().toISOString()

  const { data: existing, error: existingError } = await supabase
    .from('client_competitors')
    .select('id')
    .eq('client_id', id)
    .eq('domain', domain)
    .maybeSingle()
  if (existingError) return Response.json({ error: existingError.message }, { status: 500 })

  if (existing) {
    const { data, error } = await supabase
      .from('client_competitors')
      .update({ active: true, confirmed_at: now, last_seen_at: now, ...(name ? { name } : {}) })
      .eq('id', existing.id)
      .select()
      .single()
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ competitor: data })
  }

  const { data, error } = await supabase
    .from('client_competitors')
    .insert({ client_id: id, domain, name, source: 'manual', confirmed_at: now, active: true })
    .select()
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ competitor: data })
}

// PATCH { competitorId, active?, name? } -> deactivate/reactivate a
// competitor, or rename it. Deactivating is a soft-delete (active=false),
// not a row delete -- keeps last_seen_at/detected_at history intact and
// means auto-detection re-touching the same domain later just flips
// last_seen_at without silently un-deactivating a strategist's choice
// (see lib/competitorDetection.js -- it only ever inserts NEW domains and
// touches last_seen_at, never active).
async function PATCH(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const competitorId = body.competitorId
  if (!competitorId) return Response.json({ error: 'competitorId is required.' }, { status: 400 })

  const updates = {}
  if (typeof body.active === 'boolean') updates.active = body.active
  if (typeof body.name === 'string') updates.name = body.name.trim() || null
  if (Object.keys(updates).length === 0) return Response.json({ error: 'Nothing to update -- pass active and/or name.' }, { status: 400 })

  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('client_competitors')
    .update(updates)
    .eq('id', competitorId)
    .eq('client_id', id)
    .select()
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ competitor: data })
}

module.exports = { GET, POST, PATCH }
