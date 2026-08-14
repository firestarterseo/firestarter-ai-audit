// Orchestrates a full audit run for one client: fetches the homepage once,
// runs all five pillars against real live checkers (no mocks -- these hit
// the real internet, same modules verified in lib/checkers/scripts/), and
// persists the result to this tool's own Supabase project.
//
// Competitive Position (added 2026-08-13) does NOT require a Google
// Places/GBP ratings comparison to grade -- that sub-check is explicitly
// deferred to a later phase, pending Google Cloud billing/application
// access. v1 is two sub-checks: an AI-citation head-to-head (does the
// client or a tracked competitor get cited more often) and an Ahrefs
// organic-keyword-count comparison. Competitors are auto-detected (see
// lib/competitorDetection.js) from AI-visibility "cited instead" data and
// Ahrefs organic-competitors overlap -- NOT manually confirmed -- so this
// pillar grades as soon as 2+ competitors are detected, same "auto-
// populated, confirmation is optional" philosophy as AI-visibility test
// prompts. See lib/checkers/competitive-position-checker.js's header for
// the full scoring/locked-decisions writeup.
//
// AI & GEO Visibility mode depends on the client's status:
//   - 'tracked' clients read their own accumulated history from
//     ai_visibility_tracked_runs, which the weekly cron
//     (app/api/cron/track-ai-visibility) writes to on its own schedule --
//     but a manual "Run Audit" click also fires one live Cloro snapshot
//     right now and logs it into that same table (see
//     runAiGeoVisibilityPillar below), so a tracked client isn't stuck
//     showing "no data yet" until the next scheduled Monday run just
//     because a strategist wanted to check it today.
//   - 'lead' clients have no history to read, so this runs a live Cloro
//     snapshot instead, using a prompt auto-derived from their own schema.

const { checkSchemaAndStructure, scoreToGrade } = require('./checkers/checker')
const { checkTechnicalFoundation } = require('./checkers/technical-checker')
const { checkContentAuthority } = require('./checkers/content-checker')
const { checkAiGeoVisibility } = require('./checkers/ai-visibility-checker')
const { checkAiVisibilitySnapshot } = require('./checkers/ai-visibility-snapshot-checker')
const { extractBusinessProfile, generatePromptCandidates, enrichProfileWithAhrefs } = require('./checkers/business-profile')
const { checkCompetitivePosition } = require('./checkers/competitive-position-checker')
const { trackClientAiVisibility } = require('./trackAiVisibility')
const { detectAndSyncCompetitors } = require('./competitorDetection')
const { getSupabaseServerClient } = require('./supabaseServer')

async function fetchHomepageHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'FirestarterAIAudit/1.0' } })
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`)
  return res.text()
}

async function runAiGeoVisibilityPillar(client, homepageHtml) {
  if (client.status === 'tracked') {
    // A manual "Run Audit" click should actually run something, not just
    // read whatever the weekly cron happened to leave behind -- which can
    // legitimately be nothing for days (a client only starts accumulating
    // history from the next scheduled Monday run, however long that is
    // after it was marked "tracked"). So a manual run also fires one live
    // Cloro snapshot right now via the exact same trackClientAiVisibility
    // the cron itself uses, logging it into ai_visibility_tracked_runs --
    // same history table, same shape, just triggered by a person instead
    // of the schedule. This does spend one real round of Cloro calls per
    // manual "Run Audit," same cost as the client would otherwise wait a
    // week for; a failure here (e.g. no CLORO_API_KEY configured) doesn't
    // block the rest of the audit -- it falls through to reading whatever
    // history already exists, same as before this change.
    try {
      await trackClientAiVisibility(client)
    } catch (err) {
      // Swallow and fall through -- see comment above.
    }

    const supabase = getSupabaseServerClient()
    const { data: rows, error } = await supabase
      .from('ai_visibility_tracked_runs')
      .select('*')
      .eq('client_id', client.id)
      .order('run_at', { ascending: false })
      .limit(500)
    if (error) throw error
    // checkAiGeoVisibility expects sourcehq-shaped rows (run_at, engine,
    // mentioned, cited, position, sentiment) -- our own table uses the same
    // field names by design, so no adapter is needed here.
    return { ...checkAiGeoVisibility(rows || []), snapshot: false }
  }

  // 'lead' status, or a 'tracked' client with nothing recorded yet and no
  // reason to wait: fall back to a live one-shot snapshot.
  const profile = extractBusinessProfile(homepageHtml, client.url, {
    name: client.name,
    city: client.city,
    region: client.region,
    category: client.category
  })
  // Prefer the client's own confirmed test prompts (a strategist-reviewed
  // set of 3-7 real phrasings) over the auto-generated basket. Either way,
  // this is always MULTIPLE prompts now, never a single guess -- one
  // guessed phrase is not a reliable AI-visibility signal on its own
  // (verified: the same business scored 0/5 on one auto-generated phrase
  // and 3/5 on a more natural one, same day). Unconfirmed clients still
  // get the full auto-generated basket automatically, at zero effort --
  // confirming a curated subset is an optional refinement, not a
  // requirement to get a meaningful grade.
  // Only worth the extra Ahrefs call when we're about to auto-generate --
  // a client with confirmed test_prompts already has its final term set
  // and doesn't need it.
  const prompts = (client.test_prompts && client.test_prompts.length > 0)
    ? client.test_prompts
    : generatePromptCandidates(await enrichProfileWithAhrefs(profile, { apiKey: process.env.AHREFS_API_KEY }))
  const result = await checkAiVisibilitySnapshot(profile, prompts, {
    apiKey: process.env.CLORO_API_KEY
  })
  return result
}

// runCompetitivePositionPillar(client) -> pillar output contract.
// Detects/syncs competitors (cheap Supabase reads + one Ahrefs call, no
// Cloro cost), reads this client's own ai_visibility_tracked_runs rows
// (same table AI & GEO Visibility reads, queried again here rather than
// threaded through -- a free Supabase read, not worth coupling the two
// pillars' code over), and hands both to the checker. Never throws --
// callers should still guard with .catch() since this touches two
// external systems (Supabase, Ahrefs), and a failure here shouldn't take
// down the rest of the audit.
async function runCompetitivePositionPillar(client) {
  const { competitors, ahrefsCompetitorData, ahrefsError } = await detectAndSyncCompetitors(client, {
    ahrefsApiKey: process.env.AHREFS_API_KEY
  })

  const supabase = getSupabaseServerClient()
  const { data: rows, error } = await supabase
    .from('ai_visibility_tracked_runs')
    .select('engine, brand_mentioned, raw')
    .eq('client_id', client.id)
    .order('run_at', { ascending: false })
    .limit(500)
  if (error) throw error

  return checkCompetitivePosition(client, competitors, {
    aiVisibilityRows: rows || [],
    ahrefsCompetitorData,
    ahrefsError
  })
}

async function runAudit(client, { triggerSource = 'manual' } = {}) {
  const supabase = getSupabaseServerClient()

  let homepageHtml = null
  let fetchError = null
  try {
    homepageHtml = await fetchHomepageHtml(client.url)
  } catch (err) {
    fetchError = err
  }

  const [schemaResult, technicalResult, contentResult, aiVisibilityResult, competitivePositionResult] = await Promise.all([
    fetchError
      ? Promise.resolve({ grade: 'F', score: 0, finding: 'Could not fetch the page to check for structured data.', recommendation: 'Confirm the URL is reachable and returns full server-rendered HTML, then re-run.', evidence: [`Error: ${fetchError.message}`] })
      : checkSchemaAndStructure(homepageHtml),
    checkTechnicalFoundation(client.url, {
      pageSpeedApiKey: process.env.PAGESPEED_API_KEY || null,
      homepageHtml: fetchError ? null : homepageHtml
    }),
    checkContentAuthority(client.url, {
      backlinkApiKey: process.env.AHREFS_API_KEY || null
    }),
    fetchError
      ? Promise.resolve({ grade: 'F', score: 0, finding: 'Could not fetch the page to derive a business profile for a snapshot check.', recommendation: 'Confirm the URL is reachable, then re-run.', evidence: [`Error: ${fetchError.message}`], snapshot: client.status !== 'tracked' })
      : runAiGeoVisibilityPillar(client, homepageHtml),
    runCompetitivePositionPillar(client).catch(err => ({
      grade: null,
      score: null,
      noData: true,
      finding: 'Could not evaluate Competitive Position this run.',
      recommendation: 'Retry the audit; if this persists, check Supabase/Ahrefs connectivity.',
      evidence: [`Error: ${err.message}`]
    }))
  ])

  const pillars = [
    { pillar: 'schema_structure', result: schemaResult },
    { pillar: 'technical_foundation', result: technicalResult },
    { pillar: 'content_authority', result: contentResult },
    { pillar: 'ai_geo_visibility', result: aiVisibilityResult },
    { pillar: 'competitive_position', result: competitivePositionResult }
  ]

  const scoredPillars = pillars.filter(p => typeof p.result.score === 'number')
  const overallScore = scoredPillars.length
    ? Math.round(scoredPillars.reduce((sum, p) => sum + p.result.score, 0) / scoredPillars.length)
    : null
  const overallGrade = overallScore === null ? null : scoreToGrade(overallScore)

  const { data: auditRun, error: runError } = await supabase
    .from('audit_runs')
    .insert({
      client_id: client.id,
      trigger_source: triggerSource,
      overall_grade: overallGrade,
      overall_score: overallScore
    })
    .select()
    .single()
  if (runError) throw runError

  const pillarRows = pillars.map(({ pillar, result }) => ({
    audit_run_id: auditRun.id,
    pillar,
    grade: result.grade ?? null,
    score: typeof result.score === 'number' ? result.score : null,
    finding: result.finding ?? null,
    recommendation: result.recommendation ?? null,
    evidence: result.evidence ?? null,
    checks: Array.isArray(result.checks) ? result.checks : null,
    issues: Array.isArray(result.issues) ? result.issues : null,
    raw: result._raw ?? null,
    snapshot: !!result.snapshot,
    partial: !!result.partial,
    possible_points: typeof result.possiblePoints === 'number' ? result.possiblePoints : null
  }))

  const { error: pillarError } = await supabase.from('pillar_scores').insert(pillarRows)
  if (pillarError) throw pillarError

  return { auditRun, pillars: pillarRows }
}

module.exports = { runAudit }
