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
const { checkCompetitivePosition, MIN_COMPETITORS_TO_GRADE } = require('./checkers/competitive-position-checker')
const { trackClientAiVisibility } = require('./trackAiVisibility')
const { detectAndSyncCompetitors, fetchKeywordCountMetrics, fetchMissingKeywordOpportunities } = require('./competitorDetection')
const { getSupabaseServerClient } = require('./supabaseServer')
const { syncOpportunities, keywordOpportunitiesToItems } = require('./opportunities')
const { refineKeywordOpportunities } = require('./keywordRelevance')

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

// runCompetitivePositionPillar(client, detection) -> pillar output contract.
// detection = { competitors, ahrefsCompetitorData, ahrefsError }, already
// fetched once in runAudit() below (see its own comment on why detection
// runs exactly once per audit, not once per pillar -- Content Authority's
// competitor gap analysis needs the same active-competitor list). Reads
// this client's own ai_visibility_tracked_runs rows (same table AI & GEO
// Visibility reads, queried again here rather than threaded through -- a
// free Supabase read, not worth coupling the two pillars' code over), and
// hands both to the checker. Never throws -- callers should still guard
// with .catch() since this still touches Ahrefs for the keyword-count
// metrics, and a failure here shouldn't take down the rest of the audit.
async function runCompetitivePositionPillar(client, { competitors, ahrefsCompetitorData, ahrefsError }) {
  // Only worth the extra N+1 Ahrefs metrics calls when the pillar can
  // actually grade -- checkCompetitivePosition returns "not yet graded"
  // outright below MIN_COMPETITORS_TO_GRADE, so there's no reason to spend
  // that Ahrefs cost on a run whose keyword-count sub-check output would
  // never be read.
  const keywordMetrics = competitors.length >= MIN_COMPETITORS_TO_GRADE
    ? await fetchKeywordCountMetrics(client, competitors, { apiKey: process.env.AHREFS_API_KEY })
    : null

  // Missing-keyword opportunities (added 2026-08-14) -- needs keywordMetrics
  // first, since it reuses that call's per-competitor org_keywords totals to
  // pick which competitors are worth diffing the actual keyword LIST against
  // (see fetchMissingKeywordOpportunities's header). Never throws on its own
  // (getOrganicKeywords never throws), but guarded anyway since this is
  // still an extra Ahrefs round-trip that shouldn't take down the rest of
  // the pillar if something upstream misbehaves.
  const keywordOpportunityData = await fetchMissingKeywordOpportunities(client, keywordMetrics, {
    apiKey: process.env.AHREFS_API_KEY
  }).catch(() => null)

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
    ahrefsError,
    keywordMetrics,
    keywordOpportunityData
  })
}

async function runAudit(client, { triggerSource = 'manual' } = {}) {
  const supabase = getSupabaseServerClient()

  // Homepage fetch and competitor detection/sync are independent of each
  // other, so they run concurrently. Detection runs exactly ONCE per audit
  // here (not once per pillar) -- both Competitive Position and Content
  // Authority's competitor gap analysis (added 2026-08-14) need the same
  // active tracked-competitor list, and detectAndSyncCompetitors performs
  // real DB writes (pruning stale rows, upserting new candidates) that
  // should only happen once per audit, not twice.
  const [homepageOutcome, detectionOutcome] = await Promise.all([
    fetchHomepageHtml(client.url).then(html => ({ html, error: null })).catch(err => ({ html: null, error: err })),
    detectAndSyncCompetitors(client, { ahrefsApiKey: process.env.AHREFS_API_KEY }).catch(err => ({
      competitors: [],
      ahrefsCompetitorData: [],
      ahrefsError: { status: null, message: err && err.message ? err.message : String(err) }
    }))
  ])
  const homepageHtml = homepageOutcome.html
  const fetchError = homepageOutcome.error
  const { competitors, ahrefsCompetitorData, ahrefsError } = detectionOutcome

  const [schemaResult, technicalResult, contentResult, aiVisibilityResult, competitivePositionResult] = await Promise.all([
    fetchError
      ? Promise.resolve({ grade: 'F', score: 0, finding: 'Could not fetch the page to check for structured data.', recommendation: 'Confirm the URL is reachable and returns full server-rendered HTML, then re-run.', evidence: [`Error: ${fetchError.message}`] })
      : checkSchemaAndStructure(homepageHtml),
    checkTechnicalFoundation(client.url, {
      pageSpeedApiKey: process.env.PAGESPEED_API_KEY || null,
      homepageHtml: fetchError ? null : homepageHtml
    }),
    checkContentAuthority(client.url, {
      backlinkApiKey: process.env.AHREFS_API_KEY || null,
      competitors
    }),
    fetchError
      ? Promise.resolve({ grade: 'F', score: 0, finding: 'Could not fetch the page to derive a business profile for a snapshot check.', recommendation: 'Confirm the URL is reachable, then re-run.', evidence: [`Error: ${fetchError.message}`], snapshot: client.status !== 'tracked' })
      : runAiGeoVisibilityPillar(client, homepageHtml),
    runCompetitivePositionPillar(client, { competitors, ahrefsCompetitorData, ahrefsError }).catch(err => ({
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

  // Sync Competitive Position's missing-keyword opportunities into the
  // durable `opportunities` table (added 2026-08-15 -- see
  // lib/opportunities.js for the fingerprint/status/auto-close policy).
  // Gated on keywordOpportunitiesChecked, NOT just "array is non-empty" --
  // an empty array can mean "genuinely zero gaps this run" (fine, sync and
  // let auto-close run) or "couldn't check this run" (must NOT sync, or
  // every previously-open opportunity would get incorrectly auto-closed
  // just because this run's Ahrefs calls failed/were skipped). Non-
  // essential: a failure here shouldn't fail an otherwise-successful audit
  // run, same convention as fetchMissingKeywordOpportunities itself.
  if (competitivePositionResult?._raw?.keywordOpportunitiesChecked) {
    // LLM relevance/realism refinement (wired in 2026-08-15, see
    // lib/keywordRelevance.js) -- runs on the deterministic candidate list
    // BEFORE it's persisted, so junk like "erp"/"b2b" showing up for an
    // SEO agency gets filtered out at the source rather than tracked as a
    // real opportunity. Client context is built from what's already on
    // the `clients` row today; refineKeywordOpportunities degrades
    // gracefully (returns the original list untouched) if
    // ANTHROPIC_API_KEY isn't configured or the call fails for any
    // reason -- this must never block the rest of an otherwise-
    // successful audit run.
    const refinedOpportunities = await refineKeywordOpportunities(
      competitivePositionResult._raw.keywordOpportunities,
      {
        business_name: client.name,
        domain: client.domain || client.url,
        city: client.city || null,
        region: client.region || null,
        category: client.category || null,
        client_domain_rating: competitivePositionResult._raw.clientDomainRating ?? null
      },
      { apiKey: process.env.ANTHROPIC_API_KEY }
    ).catch(() => competitivePositionResult._raw.keywordOpportunities)

    await syncOpportunities({
      clientId: client.id,
      auditRunId: auditRun.id,
      pillar: 'competitive_position',
      type: 'content_brief',
      items: keywordOpportunitiesToItems(refinedOpportunities)
    }).catch(() => null)
  }

  return { auditRun, pillars: pillarRows }
}

module.exports = { runAudit }
