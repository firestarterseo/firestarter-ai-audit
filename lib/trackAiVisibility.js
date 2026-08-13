// Recurring AI-visibility tracking job (task #8) -- the piece
// ai-visibility-checker.js has been waiting on since it was written: that
// module reads rows from ai_visibility_tracked_runs, but until this file
// existed nothing ever wrote rows there, so every 'tracked' client
// legitimately showed "no data yet" (correctly excluded from the overall
// score, not a fake F -- see that module's header comment).
//
// This is called on a schedule by Vercel Cron (see vercel.json + the route
// at app/api/cron/track-ai-visibility/route.js), not by the dashboard UI.
// Cadence is weekly by design -- every run is live Cloro calls across every
// tracked client x their prompt set x 5 engines, so cadence is a real cost
// lever, not just a UX choice (confirmed with the client before building
// this, same as the earlier Supabase cost confirmation).
//
// Reuses the exact same multi-prompt-basket-aware snapshot logic already
// proven for 'lead' clients (checkAiVisibilitySnapshot) rather than a
// separate "tracked mode" implementation -- the only difference here is
// that every prompt x engine result gets logged as its own row instead of
// being aggregated into a single one-off grade.

const { getSupabaseServerClient } = require('./supabaseServer')
const { checkAiVisibilitySnapshot } = require('./checkers/ai-visibility-snapshot-checker')
const { extractBusinessProfile, generatePromptCandidates, enrichProfileWithAhrefs } = require('./checkers/business-profile')

async function fetchHomepageHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'FirestarterAIAudit/1.0' } })
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`)
  return res.text()
}

// trackClientAiVisibility(client) -> { clientId, skipped, ... }
// Runs one live snapshot for a single tracked client and inserts one row
// per prompt x engine result. Exported separately from trackAllClients so
// it's independently testable/callable (e.g. a future "track this client
// now" button could call this directly).
async function trackClientAiVisibility(client) {
  const supabase = getSupabaseServerClient()

  let homepageHtml = ''
  try {
    homepageHtml = await fetchHomepageHtml(client.url)
  } catch (e) {
    // A fetch failure isn't fatal here -- extractBusinessProfile can still
    // build a usable profile from the client record's own name/city/
    // region/category fields alone (same fallback the test-prompts GET
    // route already relies on).
  }

  const profile = extractBusinessProfile(homepageHtml, client.url, {
    name: client.name,
    city: client.city,
    region: client.region,
    category: client.category
  })

  if (!profile) {
    return { clientId: client.id, clientName: client.name, skipped: true, reason: 'No usable business profile -- no name from page schema or from the client record.' }
  }

  // Prefer the client's own confirmed 3-7 term set; otherwise the same
  // auto-generated basket every lead snapshot uses (Ahrefs-first when
  // configured -- see business-profile.js). Never a single prompt -- that
  // was the entire reason this feature has a confirm/review UI at all.
  const prompts = (client.test_prompts && client.test_prompts.length > 0)
    ? client.test_prompts
    : generatePromptCandidates(await enrichProfileWithAhrefs(profile, { apiKey: process.env.AHREFS_API_KEY }))

  const result = await checkAiVisibilitySnapshot(profile, prompts, {
    apiKey: process.env.CLORO_API_KEY
  })

  const runAt = new Date().toISOString()
  const engineResults = (result._raw && result._raw.engineResults) || []
  const rows = engineResults.map(er => ({
    client_id: client.id,
    engine: er.engine,
    run_at: runAt,
    ok: !!er.ok,
    brand_mentioned: er.ok ? !!er.mentioned : null,
    brand_cited: er.ok ? !!er.cited : null,
    // The live Cloro caller doesn't expose a clean "answer rank" today (see
    // extractEngineSignal in ai-visibility-snapshot-checker.js) -- leaving
    // these null is accurate, not a shortcut: ai-visibility-checker.js
    // already treats a null avgPosition as "0 of 20 position points
    // earned," never as an error or a missing-data flag.
    answer_position: null,
    total_named: null,
    sentiment: er.ok ? (er.sentiment || null) : null,
    error: er.ok ? null : (er.error || 'unknown error'),
    // responseSnippet/sourceUrls/ownDomainSourceUrls (added 2026-08-11): the
    // same transparency data the snapshot path now captures (see
    // ai-visibility-snapshot-checker.js) -- lets ai-visibility-checker.js's
    // dashboard breakdown show what each engine actually said for a tracked
    // client, not just the mentioned/cited booleans. ownDomainSourceUrls is
    // kept separate from the full sourceUrls list so the UI never presents
    // a competitor's URL as if it were citing this client (see that
    // module's header comment on why that distinction matters).
    // thirdPartySourceUrls (added 2026-08-13): everything cited that ISN'T
    // the client's own domain -- persisted explicitly rather than making
    // ai-visibility-checker.js re-derive it later by subtracting
    // ownDomainSourceUrls from sourceUrls, since those two arrays are
    // independently truncated (top 3 / top 5) and subtracting them back
    // apart after truncation isn't guaranteed exact. Rows logged before
    // this field existed fall back to that subtraction as a best-effort
    // approximation -- see ai-visibility-checker.js's rowCitationTier().
    raw: {
      prompt: er.prompt,
      responseSnippet: er.ok ? (er.responseSnippet || null) : null,
      sourceUrls: er.ok ? (er.sourceUrls || []) : [],
      ownDomainSourceUrls: er.ok ? (er.ownDomainSourceUrls || []) : [],
      thirdPartySourceUrls: er.ok ? (er.thirdPartySourceUrls || []) : []
    }
  }))

  if (rows.length > 0) {
    const { error } = await supabase.from('ai_visibility_tracked_runs').insert(rows)
    if (error) throw error
  }

  return {
    clientId: client.id,
    clientName: client.name,
    skipped: false,
    promptsUsed: prompts.length,
    rowsInserted: rows.length,
    mentionShare: (result._raw && result._raw.mentionShare) ?? null
  }
}

// trackAllClients() -> { clientCount, results: [...] }
// Runs every 'tracked' client one at a time (each client's own prompt x
// engine matrix already runs fully concurrently inside
// checkAiVisibilitySnapshot) so one client's failure can't take down
// another client's insert, and errors are captured per-client rather than
// aborting the whole cron invocation.
async function trackAllClients() {
  const supabase = getSupabaseServerClient()
  const { data: clients, error } = await supabase.from('clients').select('*').eq('status', 'tracked')
  if (error) throw error

  const results = []
  for (const client of clients || []) {
    try {
      results.push(await trackClientAiVisibility(client))
    } catch (err) {
      results.push({ clientId: client.id, clientName: client.name, skipped: true, reason: `Error: ${err.message}` })
    }
  }

  return { clientCount: (clients || []).length, results }
}

module.exports = { trackAllClients, trackClientAiVisibility }
