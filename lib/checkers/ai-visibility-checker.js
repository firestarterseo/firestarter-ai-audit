// AI & GEO Visibility pillar checker.
//
// Unlike the other three pillars, this one is NOT rebuilt from scratch —
// per the roadmap decision, sourcehq's ai_visibility_* tables already run
// real Perplexity/ChatGPT/Gemini/Google AI Overview/Copilot queries and log
// mentions, citations, positions, sentiment, and named competitors per
// engine. This module is a read-only connector: it takes the rows that
// system already produced for a client and maps them into the shared pillar
// output contract, plus a per-engine breakdown that the old single-number
// Grader never surfaced.
//
// This project owns none of that data collection — it just reads it. Kept
// as its own project/repo per the infra-separation decision; this file has
// no dependency on sourcehq's codebase, only on the shape of rows it
// produces (run_at, engine, brand_mentioned, brand_cited, answer_position,
// total_named, sentiment). run_at is required for the freshness check below
// — without it a client's data is treated as unverifiable and flagged stale.

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

function checkAiGeoVisibility(rows, { minSampleForBlindSpot = 5, blindSpotThreshold = 0.15, staleDays = 14, now = new Date() } = {}) {
  const evidence = []
  const findings = []
  const recommendations = []

  if (!rows || rows.length === 0) {
    return {
      grade: 'F',
      score: 0,
      stale: true,
      daysSinceLastRun: null,
      finding: 'No AI-visibility runs found for this client in sourcehq — tracking may not be set up yet.',
      recommendation: 'Add this client to sourcehq\'s ai_visibility tracking (prompts + engines) before grading this pillar.',
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
  const mentionRate = mentioned.length / total

  const citedAmongMentioned = mentioned.filter(r => r.brand_cited)
  const citationRate = mentioned.length > 0 ? citedAmongMentioned.length / mentioned.length : 0

  const positioned = mentioned.filter(r => r.answer_position && r.answer_position > 0)
  const avgPosition = positioned.length > 0
    ? positioned.reduce((s, r) => s + r.answer_position, 0) / positioned.length
    : null

  const sentimented = mentioned.filter(r => r.sentiment && r.sentiment !== 'n/a')
  const positiveSentiment = sentimented.filter(r => r.sentiment === 'positive')
  const positiveRate = sentimented.length > 0 ? positiveSentiment.length / sentimented.length : null

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
    evidence.push(`${e.engine}: mentioned in ${Math.round(e.mentionRate * 100)}% of ${e.count} run(s).`)
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

  return {
    grade: scoreToGrade(score),
    score,
    stale,
    daysSinceLastRun,
    finding,
    recommendation,
    evidence,
    _raw: { totalRuns: total, mentionRate, citationRate, avgPosition, positiveRate, engineSummaries }
  }
}

module.exports = { checkAiGeoVisibility, scoreToGrade }
