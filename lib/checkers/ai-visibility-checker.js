// AI & GEO Visibility pillar checker -- "tracked" mode.
//
// This module is a pure function: given rows already fetched from this
// project's OWN `ai_visibility_tracked_runs` table (see runAudit.js), it
// scores mention rate, citation rate, answer position, sentiment, and
// per-engine blind spots, plus a per-engine breakdown that the old
// single-number Grader never surfaced.
//
// Infra-separation note: this project is deliberately independent of
// sourcehq (its own Supabase project, its own tables) even though an
// earlier design considered reading sourcehq's ai_visibility_* tables
// directly. That was reversed -- this checker has no dependency on
// sourcehq's codebase or data, only on the row shape produced by this
// project's own recurring tracking job (built -- see lib/trackAiVisibility.js):
// run_at, engine, brand_mentioned, brand_cited, answer_position,
// total_named, sentiment, raw (jsonb: {prompt, responseSnippet, sourceUrls}).
// run_at is required for the freshness check below — without it a client's
// data is treated as unverifiable and flagged stale. If this job has never
// run for a client, "tracked" clients will legitimately have zero rows here
// and this pillar will read as empty (not a real F on AI visibility).
//
// ENGINE_WEIGHTS (added 2026-08-11, per direct client feedback): Google,
// ChatGPT, and Gemini count more toward mention/citation/sentiment rates
// than Perplexity -- same weighting the snapshot checker uses, kept
// identical here so a client's "tracked" score and "snapshot" score are
// computed the same way and stay comparable. Copilot has been dropped from
// the engines this project actively queries (see trackAiVisibility.js /
// ai-visibility-snapshot-checker.js); any historical Copilot rows already
// in the table still get read and weighted (falls through to
// DEFAULT_ENGINE_WEIGHT) rather than silently dropped.

function scoreToGrade(score) {
  if (score >= 97) return 'A+'
  if (score >= 93) return 'A'
  if (score >= 90) return 'A-'
  if (score >= 87) return 'B+'
  if (score >= 83) return 'B'
  if (score >= 80) return 'B-'
  if (score >= 77) return 'C+'
  if (score >= 73) return 'C'
  if (score >= 70) return 'C-'
  if (score >= 67) return 'D+'
  if (score >= 63) return 'D'
  if (score >= 60) return 'D-'
  return 'F'
}

function groupByEngine(rows) {
  const byEngine = {}
  rows.forEach(row => {
    if (!byEngine[row.engine]) byEngine[row.engine] = []
    byEngine[row.engine].push(row)
  })
  return byEngine
}

// Same weighting scheme as ai-visibility-snapshot-checker.js -- see that
// file's header comment for why. Kept as a literal duplicate rather than a
// shared import: these two checkers are intentionally decoupled (see the
// "Infra-separation note" above), and a 4-entry constant isn't worth
// introducing a cross-module dependency for.
const ENGINE_WEIGHTS = { chatgpt: 2, google: 2, gemini: 2, perplexity: 1 }
const DEFAULT_ENGINE_WEIGHT = 1
function weightOf(engine) {
  return ENGINE_WEIGHTS[engine] ?? DEFAULT_ENGINE_WEIGHT
}

// weightedShare(rows, predicate) -> fraction of total row weight matching
// predicate, not fraction of row count. An empty list or all-zero-weight
// list returns 0 rather than NaN/dividing by zero.
function weightedShare(rows, predicate) {
  if (!rows.length) return 0
  const totalWeight = rows.reduce((sum, r) => sum + weightOf(r.engine), 0)
  if (totalWeight === 0) return 0
  const matchWeight = rows.filter(predicate).reduce((sum, r) => sum + weightOf(r.engine), 0)
  return matchWeight / totalWeight
}

function checkAiGeoVisibility(rows, { minSampleForBlindSpot = 5, blindSpotThreshold = 0.15, staleDays = 14, now = new Date() } = {}) {
  const evidence = []
  const findings = []
  const recommendations = []

  if (!rows || rows.length === 0) {
    // No rows means nothing has been checked yet -- this is NOT the same as
    // "checked and failed." grade/score are explicitly null (not 'F'/0) so
    // this never gets averaged into the overall score as a fake failing
    // grade, and the dashboard renders it as an ungraded/neutral card
    // instead of a red F.
    return {
      grade: null,
      score: null,
      noData: true,
      stale: true,
      daysSinceLastRun: null,
      finding: 'Not yet graded -- no AI-visibility tracking data exists for this client. The recurring tracking job that would populate this pillar has not run for this client (or has not been built yet).',
      recommendation: 'Once the recurring AI-visibility tracking job is wired up (querying ChatGPT/Gemini/Perplexity/Copilot/Google via Cloro on a schedule and logging results), this pillar will populate automatically for "tracked" clients. Until then, it is correctly excluded from the overall score rather than counted as a failure.',
      evidence: [],
      _raw: { rowCount: 0 }
    }
  }

  // --- Freshness check: this pillar reads someone else's data pipeline, so
  // before trusting any of it, confirm that pipeline is actually still
  // running. sourcehq has real precedent for this failing silently: the
  // dataforseo and perplexity engines stopped updating entirely on
  // 2026-06-29 with no error, and two full pilot accounts (Bird Golf, JDI
  // Windows) stopped receiving ANY engine's data on that same date. A score
  // computed from that data would look normal and be quietly wrong.
  const runDates = rows.map(r => (r.run_at ? new Date(r.run_at) : null)).filter(d => d && !isNaN(d))
  let daysSinceLastRun = null
  let stale = false
  if (runDates.length > 0) {
    const mostRecentRun = new Date(Math.max(...runDates.map(d => d.getTime())))
    daysSinceLastRun = Math.round((now.getTime() - mostRecentRun.getTime()) / 86400000)
    stale = daysSinceLastRun > staleDays
    evidence.push(`Most recent AI-visibility run: ${mostRecentRun.toISOString().slice(0, 10)} (${daysSinceLastRun} days ago).`)
  } else {
    evidence.push('Rows had no run_at timestamp — cannot verify data freshness.')
    stale = true
  }

  if (stale) {
    const ageDesc = daysSinceLastRun !== null ? `${daysSinceLastRun} days` : 'an unknown amount of time'
    findings.push(`⚠ STALE DATA: no new AI-visibility run in ${ageDesc}. This score reflects a snapshot that may no longer be current — tracking may have silently stopped.`)
    recommendations.push(`Before acting on this pillar's score, confirm sourcehq is still actively running AI-visibility jobs for this client. If tracking has stopped, this data needs to be treated as historical, not current.`)
  }

  const total = rows.length
  const mentioned = rows.filter(r => r.brand_mentioned)
  // Weighted: a Google/ChatGPT/Gemini mention (or non-mention) moves this
  // rate more than a Perplexity one -- see ENGINE_WEIGHTS above.
  const mentionRate = weightedShare(rows, r => r.brand_mentioned)

  const citedAmongMentioned = mentioned.filter(r => r.brand_cited)
  const citationRate = mentioned.length > 0 ? weightedShare(mentioned, r => r.brand_cited) : 0

  const positioned = mentioned.filter(r => r.answer_position && r.answer_position > 0)
  const avgPosition = positioned.length > 0
    ? positioned.reduce((s, r) => s + r.answer_position, 0) / positioned.length
    : null

  const sentimented = mentioned.filter(r => r.sentiment && r.sentiment !== 'n/a')
  const positiveSentiment = sentimented.filter(r => r.sentiment === 'positive')
  const positiveRate = sentimented.length > 0 ? weightedShare(sentimented, r => r.sentiment === 'positive') : null

  evidence.push(`${total} AI-engine runs analyzed; mentioned in ${mentioned.length} (${Math.round(mentionRate * 100)}%).`)
  evidence.push(`Of runs where mentioned, cited/sourced in ${citedAmongMentioned.length} (${Math.round(citationRate * 100)}%).`)
  if (avgPosition !== null) evidence.push(`Average answer position when mentioned: ${avgPosition.toFixed(1)} (of up to ${Math.max(...mentioned.map(r => r.total_named || 0))} named).`)
  if (positiveRate !== null) evidence.push(`Sentiment positive in ${Math.round(positiveRate * 100)}% of mentions with a sentiment recorded.`)

  // --- Score: mention rate (30 pts) ---
  const mentionEarned = Math.round(mentionRate * 30)

  // --- Score: citation rate (20 pts) ---
  const citationEarned = Math.round(citationRate * 20)

  // --- Score: average position (20 pts) ---
  let positionEarned = 0
  if (avgPosition !== null) {
    if (avgPosition <= 3) positionEarned = 20
    else if (avgPosition <= 6) positionEarned = 14
    else if (avgPosition <= 10) positionEarned = 8
    else positionEarned = 0
  }

  // --- Score: sentiment (15 pts) ---
  const sentimentEarned = positiveRate !== null ? Math.round(positiveRate * 15) : 0

  // --- Score: per-engine coverage / blind spots (15 pts) ---
  const byEngine = groupByEngine(rows)
  const engineSummaries = Object.entries(byEngine).map(([engine, engineRows]) => {
    const engineMentioned = engineRows.filter(r => r.brand_mentioned).length
    return { engine, count: engineRows.length, mentionRate: engineMentioned / engineRows.length }
  })
  const blindSpots = engineSummaries.filter(e => e.count >= minSampleForBlindSpot && e.mentionRate < blindSpotThreshold)
  const coverageEarned = blindSpots.length === 0 ? 15 : Math.max(0, 15 - blindSpots.length * 15)

  engineSummaries.forEach(e => {
    const tier = weightOf(e.engine) >= 2 ? 'high priority' : 'lower priority'
    evidence.push(`${e.engine} (${tier}): mentioned in ${Math.round(e.mentionRate * 100)}% of ${e.count} run(s).`)
  })

  if (blindSpots.length > 0) {
    const desc = blindSpots.map(b => `${b.engine} (${Math.round(b.mentionRate * 100)}% of ${b.count})`).join(', ')
    findings.push(`Near-total blind spot on ${desc} — mention rate under ${Math.round(blindSpotThreshold * 100)}%, despite strong performance elsewhere.`)
    recommendations.push(`Investigate why the brand rarely surfaces on ${blindSpots.map(b => b.engine).join(', ')} specifically — this is a structural, engine-specific gap, not noise, and likely needs targeted content/citation work rather than a general content push.`)
  }

  if (mentionRate < 0.5) {
    findings.push(`Overall mention rate is low (${Math.round(mentionRate * 100)}%) — the brand is more often absent than present across the AI engines sampled.`)
    recommendations.push('Prioritize entity disambiguation and authoritative citations (sameAs links, consistent NAP, third-party mentions) to improve baseline mention rate.')
  }

  const possible = 100
  const earned = mentionEarned + citationEarned + positionEarned + sentimentEarned + coverageEarned
  const score = Math.round((earned / possible) * 100)

  const finding = findings.length > 0 ? findings.join(' ') : 'Solid AI-visibility performance across the engines sampled, no structural blind spots.'
  const recommendation = recommendations.length > 0 ? recommendations.join(' ') : 'No action needed — maintain current entity signals and monitor for drift.'

  // Transparency breakdown for the dashboard's "verify these results" view --
  // just the most recent tracking pass (all rows sharing the latest run_at
  // timestamp), not the full history, so this stays a manageable size to
  // read even after months of weekly runs. Each entry carries enough detail
  // to manually re-run the same prompt on the same engine and sanity-check
  // the checker: the prompt used, whether it was mentioned/cited, the
  // sentiment guess, and a snippet of what the engine actually said (see
  // trackAiVisibility.js, which is what populates raw.responseSnippet/
  // raw.sourceUrls on each row).
  const mostRecentRunRows = runDates.length > 0
    ? rows.filter(r => r.run_at && new Date(r.run_at).getTime() === Math.max(...runDates.map(d => d.getTime())))
    : []
  const latestBreakdown = mostRecentRunRows.map(r => ({
    engine: r.engine,
    weight: weightOf(r.engine),
    prompt: (r.raw && r.raw.prompt) || null,
    ok: r.ok !== false,
    error: r.error || null,
    mentioned: !!r.brand_mentioned,
    cited: !!r.brand_cited,
    sentiment: r.sentiment || null,
    responseSnippet: (r.raw && r.raw.responseSnippet) || null,
    sourceUrls: (r.raw && r.raw.sourceUrls) || [],
    ownDomainSourceUrls: (r.raw && r.raw.ownDomainSourceUrls) || []
  }))

  return {
    grade: scoreToGrade(score),
    score,
    stale,
    daysSinceLastRun,
    finding,
    recommendation,
    evidence,
    _raw: { totalRuns: total, mentionRate, citationRate, avgPosition, positiveRate, engineSummaries, engineWeights: ENGINE_WEIGHTS, latestBreakdown }
  }
}

module.exports = { checkAiGeoVisibility, scoreToGrade }
