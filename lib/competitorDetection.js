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
const { isNonCompetitorDomain, hostnameOf, normalizeDomain } = require('./nonCompetitorDomains')

const MAX_TRACKED_ROWS = 500

// Generic business-name suffixes stripped when deriving a "brand slug" from
// a client's own domain -- e.g. "firestarterseo.com" -> label
// "firestarterseo" -> strip "seo" -> "firestarter". Without stripping,
// "firestarterseo" wouldn't match a citation path like
// "firestarter-search-engine-optimization" the same way "firestarter" does
// (it would, actually, via the substring check below -- but the shorter,
// more distinctive core token is a better anchor generally, and stripping
// a generic suffix reduces the odds of the FULL label failing to match a
// citation that only uses the client's name without "SEO"/"Agency"/etc.
// tacked on).
const GENERIC_BUSINESS_SUFFIXES = ['seo', 'agency', 'marketing', 'digital', 'group', 'consulting', 'studio', 'company', 'inc', 'llc', 'co']
const MIN_BRAND_SLUG_LENGTH = 5

// brandSlugFor(client) -> a lowercase, alphanumeric-only token derived from
// the client's own domain, used by urlMentionsClientBrand below to
// recognize "this citation is ABOUT the client" (a directory profile page,
// a press feature) rather than evidence of a distinct competing business.
function brandSlugFor(client) {
  const domain = normalizeDomain(client.domain) || normalizeDomain(client.url)
  if (!domain) return null
  const label = domain.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!label) return null
  for (const suffix of GENERIC_BUSINESS_SUFFIXES) {
    if (label.length > suffix.length + 3 && label.endsWith(suffix)) {
      const core = label.slice(0, -suffix.length)
      if (core.length >= MIN_BRAND_SLUG_LENGTH) return core
    }
  }
  return label.length >= MIN_BRAND_SLUG_LENGTH ? label : null
}

// urlMentionsClientBrand(url, brandSlug) -> true if this citation URL
// (hostname + full path, hyphens/slashes ignored) contains the client's
// own brand slug -- e.g. "designrush.com/agency/profile/firestarter",
// "techfinder.net/listing/firestarter-seo/", "zoominfo.com/c/firestarter-
// search-engine-optimization/...". Found 2026-08-13: several "competitors"
// auto-detected from real citation data were actually the client's OWN
// profile/press mention on a directory or news site, not a distinct
// competing business -- this is the generalizable half of that fix (the
// other half is expanding lib/nonCompetitorDomains.js's static list for
// roundup-article domains where the client's name never appears in the
// URL at all, e.g. a "top 10 agencies in Denver" listicle).
function urlMentionsClientBrand(url, brandSlug) {
  if (!brandSlug) return false
  const normalized = String(url).toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized.includes(brandSlug)
}

// detectFromAiCitations(client) -> Promise<Array<{domain, source: 'ai_citation', occurrences, detectionNote}>>
// Reads this client's own ai_visibility_tracked_runs and tallies every
// third-party domain that's ever shown up as a citation, excluding known
// non-competitor domains, the client's own domain, and any citation URL
// that mentions the client's own brand (see urlMentionsClientBrand above).
// Also flags (via detectionNote, not exclusion) domains that have NEVER
// once been cited alone or alongside just one other outside domain --
// i.e. every single time they showed up, so did 2+ OTHER candidate
// domains in that same AI answer. That pattern is more consistent with a
// roundup/"top agencies" answer citing several sources at once than with
// a single competing business's own site being cited on its own, but it's
// surfaced as a note for a strategist to weigh, not auto-excluded --
// unlike the brand-mention check above, this one isn't reliable enough on
// its own to risk silently dropping a genuine competitor (verified
// against real data: a confirmed real competitor in this client's own
// list also co-occurred with 2 others in one run, but NOT in every run,
// so it correctly does not get flagged).
// Never throws -- returns [] on any query failure, same "data gap, not
// fatal" contract used throughout this project.
async function detectFromAiCitations(client) {
  const supabase = getSupabaseServerClient()
  const { data: rows, error } = await supabase
    .from('ai_visibility_tracked_runs')
    .select('raw')
    .eq('client_id', client.id)
    .order('run_at', { ascending: false })
    .limit(MAX_TRACKED_ROWS)
  if (error) throw error

  const clientDomain = normalizeDomain(client.domain)
  const brandSlug = brandSlugFor(client)
  const domainStats = new Map() // domain -> { occurrences, roundupRowCount }

  ;(rows || []).forEach(row => {
    const raw = row.raw || {}
    const ownUrls = Array.isArray(raw.ownDomainSourceUrls) ? raw.ownDomainSourceUrls : []
    const urls = Array.isArray(raw.thirdPartySourceUrls)
      ? raw.thirdPartySourceUrls
      : (Array.isArray(raw.sourceUrls) ? raw.sourceUrls.filter(u => !ownUrls.includes(u)) : [])

    const rowDomains = new Set()
    urls.forEach(u => {
      if (isNonCompetitorDomain(u)) return
      if (urlMentionsClientBrand(u, brandSlug)) return
      const host = hostnameOf(u)
      if (!host || host === clientDomain) return
      rowDomains.add(host)
    })

    rowDomains.forEach(d => {
      const entry = domainStats.get(d) || { occurrences: 0, roundupRowCount: 0 }
      entry.occurrences++
      if (rowDomains.size >= 3) entry.roundupRowCount++
      domainStats.set(d, entry)
    })
  })

  return Array.from(domainStats.entries()).map(([domain, stats]) => ({
    domain,
    source: 'ai_citation',
    occurrences: stats.occurrences,
    detectionNote: stats.roundupRowCount > 0 && stats.roundupRowCount === stats.occurrences
      ? 'Every AI-visibility run that cited this domain also cited 2+ other outside domains in the same answer -- worth verifying this is a single competing business’s own site, not a roundup/"top agencies" list page.'
      : null
  }))
}

// detectFromAhrefs(client, opts) -> Promise<Array<{domain, source: 'ahrefs', share, keywordsTarget, keywordsCompetitor, domainRating}>>
// Keeps the full comparison fields (not just domain+share) so
// detectAndSyncCompetitors can hand them straight to
// competitive-position-checker.js's keyword-count sub-check -- one Ahrefs
// call serves both detection and scoring, no second paid call needed.
async function detectFromAhrefs(client, { apiKey } = {}) {
  const rows = await getOrganicCompetitors(client.domain, { apiKey })
  const clientDomain = normalizeDomain(client.domain)
  return rows
    .filter(r => r.domain && normalizeDomain(r.domain) !== clientDomain && !isNonCompetitorDomain(`https://${r.domain}`))
    .map(r => ({
      domain: r.domain,
      source: 'ahrefs',
      share: r.share,
      keywordsTarget: r.keywordsTarget,
      keywordsCompetitor: r.keywordsCompetitor,
      domainRating: r.domainRating,
      detectionNote: null
    }))
}

// pruneStaleCompetitors(client, supabase) -> Promise<number> (rows removed)
// Self-healing cleanup, run at the start of every sync: re-checks every
// EXISTING auto-detected (source != 'manual') competitor row against the
// CURRENT exclusion rules -- the non-competitor domain list and the
// client's own (normalized) domain -- and hard-deletes any that now fail.
// Needed because, before this existed, updating the exclude list or
// fixing a detection bug only affected brand-new candidates going
// forward; a row inserted before the fix just sat there forever unless
// someone manually ran SQL against it -- which is exactly what happened
// 2026-08-13 (the self-domain bug and 6 directory domains both needed a
// one-off manual DB cleanup even after the code fix shipped, and the
// self-domain row came right back on the next audit that ran before the
// fix deployed). These are hard-deleted, not deactivated -- a domain that
// matches the static exclude list or the client's own domain has zero
// chance of ever being a real competitor, unlike the "maybe a roundup"
// detectionNote case, which stays a soft, reviewable flag. Manual entries
// (source: 'manual') are never touched here -- a strategist who added one
// on purpose decides whether to remove it, not this function.
async function pruneStaleCompetitors(client, supabase) {
  const { data: rows, error } = await supabase
    .from('client_competitors')
    .select('id, domain')
    .eq('client_id', client.id)
    .neq('source', 'manual')
  if (error) throw error

  const clientDomain = normalizeDomain(client.domain)
  const staleIds = (rows || [])
    .filter(r => r.domain === clientDomain || isNonCompetitorDomain(`https://${r.domain}`))
    .map(r => r.id)

  if (staleIds.length > 0) {
    const { error: deleteError } = await supabase.from('client_competitors').delete().in('id', staleIds)
    if (deleteError) throw deleteError
  }
  return staleIds.length
}

// detectAndSyncCompetitors(client, opts) -> Promise<{ competitors, ahrefsCompetitorData }>
// Runs both detection signals, merges by domain (AI-citation candidates take
// priority when a domain is found by both -- it's the more directly
// relevant signal for this tool), inserts any brand-new domains, and bumps
// last_seen_at + detection_note on every candidate found this run WITHOUT
// touching existing rows' source/name/confirmed_at/active -- a strategist's
// manual edits or an earlier detection's provenance are never silently
// overwritten by a later run (detection_note is the one exception -- it's
// derived evidence, not a strategist's own input, so it's always kept
// current). Also prunes stale rows (see pruneStaleCompetitors above) before
// reading back the active list, so a strategist never has to hand-run SQL
// to clean up after an exclude-list update or bug fix. Returns the
// client's current active competitor list PLUS the raw Ahrefs comparison
// rows already fetched, so runAudit.js can pass both straight into
// competitive-position-checker.js without a second Ahrefs call.
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

  await pruneStaleCompetitors(client, supabase)

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
      .map(c => ({ client_id: client.id, domain: c.domain, source: c.source, detection_note: c.detectionNote || null }))
    if (toInsert.length > 0) {
      const { error: insertError } = await supabase.from('client_competitors').insert(toInsert)
      if (insertError) throw insertError
    }

    // last_seen_at and detection_note both get refreshed every run --
    // detection_note is derived evidence, not a strategist's own input, so
    // keeping it current (including clearing it back to null if a domain
    // stops looking like a roundup source) is more useful than leaving it
    // stuck at whatever it said the first time. This has to be a per-domain
    // update (not one bulk .update().in(...)) since each domain can have a
    // different note; source/name/confirmed_at/active are deliberately
    // left untouched here, same as before.
    const now = new Date().toISOString()
    const touchErrors = (await Promise.all(candidates.map(c =>
      supabase
        .from('client_competitors')
        .update({ last_seen_at: now, detection_note: c.detectionNote || null })
        .eq('client_id', client.id)
        .eq('domain', c.domain)
    ))).map(r => r.error).filter(Boolean)
    if (touchErrors.length > 0) throw touchErrors[0]
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
