// Competitive Position: competitor auto-detection + sync.
//
// Per direct client feedback, this does NOT require a strategist to
// manually confirm competitors before the pillar can grade -- same
// "auto-populated, confirmation is optional refinement" philosophy already
// used for AI-visibility test prompts. Detection runs on every audit
// (see runAudit.js) and upserts into client_competitors; a strategist can
// review/add/remove afterward via the Competitive Position UI, but that's
// polish, not a gate.
//
// Two independent, zero-marginal-cost-or-cheap signals, merged:
//   1. AI-citation "cited instead" data -- third-party domains already
//      captured in this client's own ai_visibility_tracked_runs rows
//      (raw.thirdPartySourceUrls), which cost nothing extra to read: this
//      data already exists from AI & GEO Visibility tracking. Literally
//      "who showed up in the exact AI-answer context we're trying to win."
//   2. Ahrefs organic-competitors overlap -- domains that rank for the same
//      keywords this client does (see lib/checkers/ahrefs.js). One Ahrefs
//      call, reused later for the keyword-count comparison sub-check in
//      lib/checkers/competitive-position-checker.js.
//
// Both are filtered through lib/nonCompetitorDomains.js so directories,
// review platforms, press, and social networks never get mistaken for an
// actual competing business.

const { getSupabaseServerClient } = require('./supabaseServer')
const { getOrganicCompetitors } = require('./checkers/ahrefs')
const { isNonCompetitorDomain, hostnameOf } = require('./nonCompetitorDomains')

const MAX_TRACKED_ROWS = 500

// detectFromAiCitations(client) -> Promise<Array<{domain, source: 'ai_citation'}>>
// Reads this client's own ai_visibility_tracked_runs and tallies every
// third-party domain that's ever shown up as a citation, excluding known
// non-competitor domains and the client's own domain. Never throws --
// returns [] on any query failure, same "data gap, not fatal" contract used
// throughout this project.
async function detectFromAiCitations(client) {
  const supabase = getSupabaseServerClient()
  const { data: rows, error } = await supabase
    .from('ai_visibility_tracked_runs')
    .select('raw')
    .eq('client_id', client.id)
    .order('run_at', { ascending: false })
    .limit(MAX_TRACKED_ROWS)
  if (error) throw error

  const domainCounts = new Map()
  ;(rows || []).forEach(row => {
    const raw = row.raw || {}
    const ownUrls = Array.isArray(raw.ownDomainSourceUrls) ? raw.ownDomainSourceUrls : []
    const urls = Array.isArray(raw.thirdPartySourceUrls)
      ? raw.thirdPartySourceUrls
      : (Array.isArray(raw.sourceUrls) ? raw.sourceUrls.filter(u => !ownUrls.includes(u)) : [])
    urls.forEach(u => {
      if (isNonCompetitorDomain(u)) return
      const host = hostnameOf(u)
      if (!host || host === client.domain) return
      domainCounts.set(host, (domainCounts.get(host) || 0) + 1)
    })
  })

  return Array.from(domainCounts.entries()).map(([domain, occurrences]) => ({ domain, source: 'ai_citation', occurrences }))
}

// detectFromAhrefs(client, opts) -> Promise<Array<{domain, source: 'ahrefs', share, keywordsTarget, keywordsCompetitor, domainRating}>>
// Keeps the full comparison fields (not just domain+share) so
// detectAndSyncCompetitors can hand them straight to
// competitive-position-checker.js's keyword-count sub-check -- one Ahrefs
// call serves both detection and scoring, no second paid call needed.
async function detectFromAhrefs(client, { apiKey } = {}) {
  const rows = await getOrganicCompetitors(client.domain, { apiKey })
  return rows
    .filter(r => r.domain && r.domain !== client.domain && !isNonCompetitorDomain(`https://${r.domain}`))
    .map(r => ({
      domain: r.domain,
      source: 'ahrefs',
      share: r.share,
      keywordsTarget: r.keywordsTarget,
      keywordsCompetitor: r.keywordsCompetitor,
      domainRating: r.domainRating
    }))
}

// detectAndSyncCompetitors(client, opts) -> Promise<{ competitors, ahrefsCompetitorData }>
// Runs both detection signals, merges by domain (AI-citation candidates take
// priority when a domain is found by both -- it's the more directly
// relevant signal for this tool), inserts any brand-new domains, and bumps
// last_seen_at on every candidate found this run WITHOUT touching existing
// rows' source/name/confirmed_at/active -- a strategist's manual edits or
// an earlier detection's provenance are never silently overwritten by a
// later run. Returns the client's current active competitor list PLUS the
// raw Ahrefs comparison rows already fetched, so runAudit.js can pass both
// straight into competitive-position-checker.js without a second Ahrefs call.
async function detectAndSyncCompetitors(client, { ahrefsApiKey } = {}) {
  const [fromCitations, fromAhrefs] = await Promise.all([
    detectFromAiCitations(client).catch(() => []),
    detectFromAhrefs(client, { apiKey: ahrefsApiKey }).catch(() => [])
  ])

  const merged = new Map()
  fromCitations.forEach(c => merged.set(c.domain, c))
  fromAhrefs.forEach(c => { if (!merged.has(c.domain)) merged.set(c.domain, c) })
  const candidates = Array.from(merged.values())

  const supabase = getSupabaseServerClient()

  if (candidates.length > 0) {
    const candidateDomains = candidates.map(c => c.domain)
    const { data: existing, error: existingError } = await supabase
      .from('client_competitors')
      .select('domain')
      .eq('client_id', client.id)
      .in('domain', candidateDomains)
    if (existingError) throw existingError
    const existingDomains = new Set((existing || []).map(r => r.domain))

    const toInsert = candidates
      .filter(c => !existingDomains.has(c.domain))
      .map(c => ({ client_id: client.id, domain: c.domain, source: c.source }))
    if (toInsert.length > 0) {
      const { error: insertError } = await supabase.from('client_competitors').insert(toInsert)
      if (insertError) throw insertError
    }

    const { error: touchError } = await supabase
      .from('client_competitors')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('client_id', client.id)
      .in('domain', candidateDomains)
    if (touchError) throw touchError
  }

  const { data: active, error: activeError } = await supabase
    .from('client_competitors')
    .select('*')
    .eq('client_id', client.id)
    .eq('active', true)
    .order('detected_at', { ascending: true })
  if (activeError) throw activeError
  return { competitors: active || [], ahrefsCompetitorData: fromAhrefs }
}

module.exports = { detectAndSyncCompetitors, detectFromAiCitations, detectFromAhrefs }
