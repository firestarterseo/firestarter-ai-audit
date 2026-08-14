// Shared data-access helpers, used by both the API routes (for the
// client-triggered "run audit now" button) and server components (for
// direct rendering, no network round-trip to our own API needed).

const { getSupabaseServerClient } = require('./supabaseServer')

// sanitizeClient(client) -> client, minus the encrypted WordPress
// Application Password, plus a derived `wp_connected` boolean. Used
// anywhere a client row crosses into a Client Component's props (Server
// Component -> 'use client', e.g. app/clients/[id]/page.js ->
// SchemaGenerator.js) or back out of an API route -- the ciphertext has no
// reason to ever reach the browser, even encrypted. Not needed for
// listClientsWithLatestRun below, since that page renders plain server-side
// HTML and never passes the raw client object into a Client Component.
function sanitizeClient(client) {
  if (!client) return client
  const { wp_app_password_encrypted, ...rest } = client
  return { ...rest, wp_connected: !!wp_app_password_encrypted }
}

async function listClientsWithLatestRun() {
  const supabase = getSupabaseServerClient()
  const { data: clients, error } = await supabase.from('clients').select('*').order('created_at', { ascending: false })
  if (error) throw error

  const { data: runs, error: runsError } = await supabase
    .from('audit_runs')
    .select('*')
    .order('run_at', { ascending: false })
  if (runsError) throw runsError

  const latestByClient = new Map()
  for (const run of runs || []) {
    if (!latestByClient.has(run.client_id)) latestByClient.set(run.client_id, run)
  }

  return (clients || []).map(c => ({ ...c, latestRun: latestByClient.get(c.id) || null }))
}

async function getClientWithRuns(clientId) {
  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('*').eq('id', clientId).single()
  if (error) throw error

  const { data: runs, error: runsError } = await supabase
    .from('audit_runs')
    .select('*')
    .eq('client_id', clientId)
    .order('run_at', { ascending: false })
  if (runsError) throw runsError

  const runIds = (runs || []).map(r => r.id)
  let pillarScores = []
  if (runIds.length) {
    const { data, error: pillarError } = await supabase.from('pillar_scores').select('*').in('audit_run_id', runIds)
    if (pillarError) throw pillarError
    pillarScores = data || []
  }

  const runsWithPillars = (runs || []).map(run => ({
    ...run,
    pillars: pillarScores.filter(p => p.audit_run_id === run.id)
  }))

  return { client, runs: runsWithPillars }
}

// getClientCompetitors(clientId) -> client_competitors rows (both active
// and inactive -- page.js/CompetitorsManager decides what to show), used
// to render the Competitive Position pillar's competitor-management UI.
// A plain read with no fallback-on-error: if this fails, the page itself
// should error loudly rather than silently show an empty competitor list,
// same as every other direct Supabase read in this file.
async function getClientCompetitors(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('client_competitors')
    .select('*')
    .eq('client_id', clientId)
    .order('detected_at', { ascending: true })
  if (error) throw error
  return data || []
}

// getClientOpportunities(clientId) -> opportunities rows (every status --
// page.js/OpportunitiesManager decides what to show), used to render the
// "keyword opportunities to close" list inside Competitive Position.
// Same "plain read, no fallback-on-error" convention as
// getClientCompetitors above.
async function getClientOpportunities(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('opportunities')
    .select('*')
    .eq('client_id', clientId)
    .order('priority_score', { ascending: false, nullsFirst: false })
  if (error) throw error
  return data || []
}

async function createClient(input) {
  const supabase = getSupabaseServerClient()
  const { name, domain, url, city, region, category, status, notes } = input
  if (!name || !url) throw new Error('name and url are required')
  const { data, error } = await supabase
    .from('clients')
    .insert({
      name,
      domain: domain || new URL(url).hostname,
      url,
      city: city || null,
      region: region || null,
      category: category || null,
      status: status === 'tracked' ? 'tracked' : 'lead',
      notes: notes || null
    })
    .select()
    .single()
  if (error) throw error
  return data
}

module.exports = { listClientsWithLatestRun, getClientWithRuns, createClient, sanitizeClient, getClientCompetitors, getClientOpportunities }
