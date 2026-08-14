// Competitive Position pillar checker.
//
// Per the locked design (2026-08-13): two sub-checks, both built on
// infrastructure this project already pays for --
//   1. AI-citation head-to-head (60 pts) -- reuses the SAME confirmed
//      AI-visibility test prompts/tracked runs already being collected for
//      the AI & GEO Visibility pillar. Zero new Cloro cost.
//   2. Organic keyword-count standing vs tracked competitors (40 pts) --
//      reuses the Ahrefs organic-competitors call already made during
//      competitor detection (see lib/competitorDetection.js) -- no second
//      Ahrefs call needed just for scoring.
//
// Google Places/GBP ratings comparison (originally sketched as a third
// sub-check) is explicitly deferred to a later phase -- pending Google
// Cloud billing/application access -- and is NOT part of this v1.
//
// Grading rule: competitors are auto-detected, NOT manually confirmed, and
// that's enough to grade -- this pillar returns grade/score: null ("not yet
// graded," excluded from the overall average, same contract as every other
// pillar's empty-data case) only when fewer than MIN_COMPETITORS_TO_GRADE
// active competitors exist for this client. A strategist can still review,
// rename, add, or deactivate competitors at any time; none of that gates
// whether this pillar produces a grade.
//
// AI-citation win/loss/tie logic (locked 2026-08-13): a tracked run where
// the client is mentioned and no tracked competitor's domain shows up among
// that run's citations = a WIN. A run where a tracked competitor's domain
// shows up and the client is NOT mentioned = a LOSS. A run where NEITHER
// the client nor any tracked competitor is mentioned/cited is EXCLUDED from
// the tally entirely (an irrelevant AI answer shouldn't count against or
// for anyone). A run where BOTH the client is mentioned AND a competitor's
// domain also appears is treated as a TIE (half credit) -- this specific
// case wasn't explicitly locked with the client, so it's a reasonable
// default worth revisiting if it doesn't feel right in practice.

const { hostnameOf } = require('../nonCompetitorDomains')

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

// Same engine-importance weighting used by both AI-visibility checkers --
// kept as a literal duplicate rather than a shared import, same
// infra-separation reasoning as those two files.
const ENGINE_WEIGHTS = { chatgpt: 2, google: 2, gemini: 2, perplexity: 1 }
const DEFAULT_ENGINE_WEIGHT = 1
function weightOf(engine) {
  return ENGINE_WEIGHTS[engine] ?? DEFAULT_ENGINE_WEIGHT
}

const MIN_COMPETITORS_TO_GRADE = 2

// checkCompetitivePosition(client, competitors, opts) -> shared pillar
// output contract.
//   competitors: rows from client_competitors (active or not -- this
//     function filters to active itself).
//   opts.aiVisibilityRows: this client's own ai_visibility_tracked_runs
//     rows (same rows ai-visibility-checker.js reads for AI & GEO
//     Visibility) -- passed in rather than re-queried, since the caller
//     (runAudit.js) already has them.
//   opts.ahrefsCompetitorData: the organic-competitors rows already fetched
//     during detection (lib/competitorDetection.js) -- reused here instead
//     of a second paid Ahrefs call.
function checkCompetitivePosition(client, competitors, { aiVisibilityRows = [], ahrefsCompetitorData = [] } = {}) {
  const evidence = []
  const findings = []
  const recommendations = []
  const checks = []
  const issues = []

  const activeCompetitors = (competitors || []).filter(c => c.active !== false)

  if (activeCompetitors.length < MIN_COMPETITORS_TO_GRADE) {
    return {
      grade: null,
      score: null,
      noData: true,
      finding: activeCompetitors.length === 0
        ? 'Not yet graded -- no competitors have been detected or added for this client yet.'
        : `Not yet graded -- only ${activeCompetitors.length} competitor detected so far; at least ${MIN_COMPETITORS_TO_GRADE} are needed for a meaningful comparison.`,
      recommendation: 'Competitors are auto-detected from AI-visibility citation data and Ahrefs keyword overlap as audits run -- no action needed, though a strategist can add a known competitor manually at any time to speed this up.',
      evidence: [],
      checks: [],
      issues: [],
      _raw: { competitorCount: activeCompetitors.length }
    }
  }

  const competitorDomains = new Set(activeCompetitors.map(c => c.domain))

  // --- Sub-check 1: AI-citation head-to-head (60 pts) ---
  let wins = 0, ties = 0, losses = 0, excluded = 0
  let weightedWins = 0, weightedTies = 0, weightedLosses = 0
  const perCompetitorTally = {} // domain -> { ties, losses }

  aiVisibilityRows.forEach(row => {
    const raw = row.raw || {}
    const citedUrls = [
      ...(Array.isArray(raw.thirdPartySourceUrls) ? raw.thirdPartySourceUrls : []),
      ...(Array.isArray(raw.sourceUrls) ? raw.sourceUrls : [])
    ]
    const rowCompetitorDomains = new Set()
    citedUrls.forEach(u => {
      const host = hostnameOf(u)
      if (host && competitorDomains.has(host)) rowCompetitorDomains.add(host)
    })

    const clientMentioned = !!row.brand_mentioned
    const competitorPresent = rowCompetitorDomains.size > 0
    const w = weightOf(row.engine)

    if (!clientMentioned && !competitorPresent) {
      excluded++
      return
    }
    if (clientMentioned && !competitorPresent) {
      wins++
      weightedWins += w
    } else if (clientMentioned && competitorPresent) {
      ties++
      weightedTies += w
      rowCompetitorDomains.forEach(d => {
        perCompetitorTally[d] = perCompetitorTally[d] || { ties: 0, losses: 0 }
        perCompetitorTally[d].ties++
      })
    } else {
      losses++
      weightedLosses += w
      rowCompetitorDomains.forEach(d => {
        perCompetitorTally[d] = perCompetitorTally[d] || { ties: 0, losses: 0 }
        perCompetitorTally[d].losses++
      })
    }
  })

  const totalWeighted = weightedWins + weightedTies + weightedLosses
  const headToHeadRate = totalWeighted > 0 ? (weightedWins + weightedTies * 0.5) / totalWeighted : null
  const headToHeadEarned = headToHeadRate !== null ? Math.round(headToHeadRate * 60) : 0

  if (totalWeighted > 0) {
    evidence.push(`AI-citation head-to-head vs ${activeCompetitors.length} tracked competitor(s): ${wins} win(s), ${ties} tie(s), ${losses} loss(es) (${excluded} run(s) excluded -- neither the client nor a tracked competitor was mentioned).`)
    checks.push({ label: 'AI-citation head-to-head vs tracked competitors', status: headToHeadRate >= 0.5 ? 'pass' : 'fail' })
  } else {
    checks.push({ label: 'AI-citation head-to-head vs tracked competitors', status: 'not_verified' })
    evidence.push('No AI-visibility tracked runs yet mention either the client or a tracked competitor -- head-to-head component not verified this run.')
  }

  if (totalWeighted > 0 && losses > wins) {
    const worst = Object.entries(perCompetitorTally).sort((a, b) => b[1].losses - a[1].losses)[0]
    findings.push(`Losing the AI-citation head-to-head overall (${losses} loss(es) vs ${wins} win(s))${worst ? `, most often to ${worst[0]}` : ''}.`)
    recommendations.push('Strengthen entity signals and third-party citations (see AI & GEO Visibility and Schema & Structure pillars) specifically for the queries where a competitor is currently winning instead.')
    issues.push({
      severity: 'moderate',
      message: `Losing the AI-citation head-to-head against tracked competitors (${losses} loss(es) vs ${wins} win(s), ${ties} tie(s)).`,
      why: 'When an AI engine cites a named competitor instead of this business for a relevant query, that\'s a directly observed loss of a real customer touchpoint, not a hypothetical.',
      recommendation: 'Strengthen entity signals and third-party citations for the specific queries where a competitor is currently winning instead.'
    })
  }

  // --- Sub-check 2: organic keyword-count standing (40 pts) ---
  const comparableAhrefs = (ahrefsCompetitorData || []).filter(c =>
    competitorDomains.has(c.domain) && typeof c.keywordsTarget === 'number' && typeof c.keywordsCompetitor === 'number'
  )
  let keywordEarned = 0
  if (comparableAhrefs.length > 0) {
    const clientKeywords = comparableAhrefs[0].keywordsTarget
    const avgCompetitorKeywords = comparableAhrefs.reduce((s, c) => s + c.keywordsCompetitor, 0) / comparableAhrefs.length
    const ratio = avgCompetitorKeywords > 0 ? clientKeywords / avgCompetitorKeywords : 1
    keywordEarned = Math.round(Math.min(1, ratio) * 40)
    evidence.push(`Ranking for ${clientKeywords} organic keyword(s) vs an average of ${Math.round(avgCompetitorKeywords)} across ${comparableAhrefs.length} comparable tracked competitor(s) (Ahrefs).`)
    checks.push({ label: 'Organic keyword count vs tracked competitors (Ahrefs)', status: ratio >= 1 ? 'pass' : 'fail' })
    if (ratio < 0.5) {
      findings.push(`Ranking for meaningfully fewer organic keywords than tracked competitors on average (${clientKeywords} vs ~${Math.round(avgCompetitorKeywords)}).`)
      recommendations.push('See Content Authority for content-depth recommendations -- organic keyword count is largely a function of indexed, substantive content volume.')
      issues.push({
        severity: 'minor',
        message: `Ranking for fewer organic keywords than tracked competitors on average (${clientKeywords} vs ~${Math.round(avgCompetitorKeywords)}, per Ahrefs).`,
        why: 'Fewer ranking keywords generally means less indexed, substantive content for Google and AI engines to draw from relative to named competitors.',
        recommendation: 'See the Content Authority pillar for content-depth recommendations.'
      })
    }
  } else {
    checks.push({ label: 'Organic keyword count vs tracked competitors (Ahrefs)', status: 'not_verified' })
    // Distinguish "Ahrefs returned nothing at all this run" (missing/bad
    // API key, or this domain doesn't rank for enough keywords yet for
    // Ahrefs to compute competitors) from "Ahrefs found other domains,
    // just not any of the ones AI-citation detection tracked" -- these
    // read very differently to a strategist, and conflating them into one
    // generic message made a real gap (worth investigating) look
    // identical to an expected one (these two signals just don't overlap
    // yet). ahrefsCompetitorData is already filtered to exclude
    // non-competitor/self domains (see lib/competitorDetection.js) but
    // NOT filtered to tracked competitors, so its own length is exactly
    // "how many organic-competitor domains did Ahrefs surface, period."
    if (!ahrefsCompetitorData || ahrefsCompetitorData.length === 0) {
      evidence.push('Ahrefs returned no organic-competitor data for this domain at all this run -- either AHREFS_API_KEY isn\'t configured/working, or this domain doesn\'t yet rank for enough organic keywords for Ahrefs to compute competitors.')
    } else {
      const sample = ahrefsCompetitorData.slice(0, 5).map(c => c.domain).join(', ')
      evidence.push(`Ahrefs found ${ahrefsCompetitorData.length} organic-competitor domain(s) for this site (e.g. ${sample}), but none of them match a currently-tracked competitor -- keyword-count component not verified against the tracked set this run. Worth checking whether any of Ahrefs' own list should be added as a tracked competitor by hand.`)
    }
  }

  const score = headToHeadEarned + keywordEarned
  const grade = scoreToGrade(score)

  const finding = findings.length > 0
    ? findings.join(' ')
    : `Holding steady against ${activeCompetitors.length} tracked competitor(s) with no major gaps found this run.`
  const recommendation = recommendations.length > 0
    ? recommendations.join(' ')
    : 'No action needed -- keep monitoring as competitors and AI-visibility data accumulate.'

  return {
    grade,
    score,
    finding,
    recommendation,
    evidence,
    checks,
    issues,
    _raw: {
      competitorCount: activeCompetitors.length,
      competitors: activeCompetitors.map(c => ({ domain: c.domain, name: c.name, source: c.source })),
      wins,
      ties,
      losses,
      excluded,
      headToHeadRate,
      keywordEarned
    }
  }
}

module.exports = { checkCompetitivePosition, scoreToGrade, MIN_COMPETITORS_TO_GRADE }
