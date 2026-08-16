const { getSupabaseServerClient } = require('../../../../../../../lib/supabaseServer')
const { generateContentBrief } = require('../../../../../../../lib/contentBrief')

// POST -- generate (or regenerate) a real content brief + paste-ready draft
// copy for one Competitive Position keyword opportunity, via Anthropic (see
// lib/contentBrief.js for the full design/scope notes). Saved to
// opportunities.content_brief, a dedicated column that the audit-run sync
// (lib/opportunities.js) never touches, so a generated brief survives every
// future audit run until a strategist explicitly regenerates it.
//
// No WordPress call here -- per direct confirmation that auto-publishing
// isn't the priority right now (a strategist can copy the returned HTML
// straight into a blog editor), this route only ever writes to Supabase.
async function POST(request, { params }) {
  const { id, opportunityId } = await params
  const supabase = getSupabaseServerClient()

  const { data: opportunity, error: oppError } = await supabase
    .from('opportunities')
    .select('*')
    .eq('id', opportunityId)
    .eq('client_id', id)
    .single()
  if (oppError || !opportunity) {
    return Response.json({ error: oppError?.message || 'Opportunity not found.' }, { status: 404 })
  }

  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('name, domain, url, city, region, category')
    .eq('id', id)
    .single()
  if (clientError || !client) {
    return Response.json({ error: clientError?.message || 'Client not found.' }, { status: 404 })
  }

  const clientContext = {
    business_name: client.name,
    domain: client.domain || client.url,
    city: client.city || null,
    region: client.region || null,
    category: client.category || null
  }

  const { brief, error } = await generateContentBrief(opportunity, clientContext, { apiKey: process.env.ANTHROPIC_API_KEY })
  if (error || !brief) {
    return Response.json({ error: error?.message || 'Content brief generation failed.' }, { status: 502 })
  }

  const now = new Date().toISOString()
  const contentBrief = { ...brief, generated_at: now }

  const { data: updated, error: updateError } = await supabase
    .from('opportunities')
    .update({ content_brief: contentBrief, updated_at: now })
    .eq('id', opportunityId)
    .select()
    .single()
  if (updateError) return Response.json({ error: updateError.message }, { status: 500 })

  return Response.json({ opportunity: updated })
}

module.exports = { POST }
