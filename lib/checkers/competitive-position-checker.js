// Competitive Position pillar checker.
//
// Per the locked design (2026-08-13): two sub-checks, both built on
// infrastructure this project already pays for --
//   1. AI-citation head-to-head (60 pts) -- reuses the SAME confirmed
//      AI-visibility test prompts/tracked runs already being collected for
//      the AI & GEO Visibility pillar. Zero new Cloro cost.
//   2. Total organic keyword-count standing vs tracked competitors (40 pts)
//      -- rebuilt 2026-08-14. Originally reused the Ahrefs organic-
//      competitors call's keywords_target/keywords_competitor fields, but
//      those are scoped to one specific target-vs-competitor pairing
//      ("keywords target ranks for that this ONE competitor doesn't"), NOT
//      a site-wide total keyword count -- averaging them across several
//      competitors compared numbers that were never meant to be compared
//      that way (caught via a client-reported "17 vs 7189" ratio that
//      looked obviously wrong). Now calls Ahrefs' metrics endpoint
//      (org_keywords -- a genuine total) once for the client and once per
//      tracked competitor (capped, see lib/competitorDetection.js's
//      fetchKeywordCountMetrics) -- costs more Ahrefs calls per audit, but
//      the number now means what it says.
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
//     during detection (lib/competitorDetection.js) -- used here only for
//     an informational, non-scored note about competitor-detection
//     coverage, NOT for the keyword-count sub-check itself (see
//     opts.keywordMetrics for that).
//   opts.ahrefsError: null on a clean Ahrefs organic-competitors call (even
//     one that legitimately found zero competitors), or { status, message }
//     describing why that detection call failed -- surfaced as an
//     informational note distinct from the keyword-count sub-check's own
//     evidence, so a real API/permission problem on the detection side
//     doesn't get confused with the scored comparison below.
//   opts.keywordMetrics: result of lib/competitorDetection.js's
//     fetchKeywordCountMetrics -- { clientOrgKeywords, clientError,
//     competitors: [{domain, orgKeywords, error}], checkedCount,
//     totalActiveCount }, or null when the pillar didn't have enough
//     competitors to bother fetching it. This is the actual data source for
//     the keyword-count sub-check (40 pts).
function checkCompetitivePosition(client, competitors, { aiVisibilityRows = [], ahrefsCompetitorData = [], ahrefsError = null, keywordMetrics = null } = {}) {
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

  // --- Sub-check 2: total organic keyword-count standing (40 pts) ---
  // Rebuilt 2026-08-14 to use keywordMetrics (Ahrefs' metrics endpoint,
  // one genuine total-keyword-count call per domain) instead of the old
  // organic-competitors keywords_target/keywords_competitor fields, which
  // are pairwise-scoped, not site-wide totals -- see this file's header
  // and lib/competitorDetection.js's fetchKeywordCountMetrics for the full
  // story on why that changed.
  let keywordEarned = 0
  let keywordVerified = false
  const km = keywordMetrics

  if (!km) {
    checks.push({ label: 'Total organic keyword count vs tracked competitors (Ahrefs)', status: 'not_verified' })
    evidence.push('Organic keyword-count comparison was not run this audit.')
  } else if (km.clientError) {
    checks.push({ label: 'Total organic keyword count vs tracked competitors (Ahrefs)', status: 'not_verified' })
    const statusPart = km.clientError.status ? `HTTP ${km.clientError.status}` : 'call failed'
    evidence.push(`Ahrefs metrics call failed for this client's own domain (${statusPart}: ${km.clientError.message}) -- keyword-count component not verified this run. Check AHREFS_API_KEY and whether the account's plan includes the metrics report.`)
  } else if (typeof km.clientOrgKeywords !== 'number') {
    checks.push({ label: 'Total organic keyword count vs tracked competitors (Ahrefs)', status: 'not_verified' })
    evidence.push('Ahrefs returned no total organic keyword count for this client\'s domain this run (a clean, error-free response) -- this domain likely doesn\'t yet rank for enough organic keywords for Ahrefs to compute a total from.')
  } else {
    const comparableCompetitors = (km.competitors || []).filter(c => typeof c.orgKeywords === 'number' && !c.error)
    const failedCompetitors = (km.competitors || []).filter(c => c.error)

    if (comparableCompetitors.length > 0) {
      const clientKeywords = km.clientOrgKeywords
      const avgCompetitorKeywords = comparableCompetitors.reduce((s, c) => s + c.orgKeywords, 0) / comparableCompetitors.length
      const ratio = avgCompetitorKeywords > 0 ? clientKeywords / avgCompetitorKeywords : 1
      keywordEarned = Math.round(Math.min(1, ratio) * 40)
      keywordVerified = true
      const cappedNote = km.checkedCount < km.totalActiveCount
        ? ` (checked ${km.checkedCount} of ${km.totalActiveCount} active tracked competitors)`
        : ''
      evidence.push(`Ranking for ${clientKeywords} total organic keyword(s) (Ahrefs) vs an average of ${Math.round(avgCompetitorKeywords)} across ${comparableCompetitors.length} tracked competitor(s)${cappedNote}.`)
      checks.push({ label: 'Total organic keyword count vs tracked competitors (Ahrefs)', status: ratio >= 1 ? 'pass' : 'fail' })
      if (ratio < 0.5) {
        findings.push(`Ranking for meaningfully fewer total organic keywords than tracked competitors on average (${clientKeywords} vs ~${Math.round(avgCompetitorKeywords)}).`)
        recommendations.push('See Content Authority for content-depth recommendations -- organic keyword count is largely a function of indexed, substantive content volume.')
        issues.push({
          severity: 'minor',
          message: `Ranking for fewer total organic keywords than tracked competitors on average (${clientKeywords} vs ~${Math.round(avgCompetitorKeywords)}, per Ahrefs).`,
          why: 'Fewer ranking keywords generally means less indexed, substantive content for Google and AI engines to draw from relative to named competitors.',
          recommendation: 'See the Content Authority pillar for content-depth recommendations.'
        })
      }
      if (failedCompetitors.length > 0) {
        evidence.push(`Ahrefs metrics call failed for ${failedCompetitors.length} tracked competitor domain(s) (${failedCompetitors.map(c => c.domain).join(', ')}) -- excluded from the average above, not counted as zero.`)
      }
    } else {
      checks.push({ label: 'Total organic keyword count vs tracked competitors (Ahrefs)', status: 'not_verified' })
      evidence.push(`Got this client's own total organic keyword count (${km.clientOrgKeywords}) from Ahrefs, but the metrics call failed or returned no data for every tracked competitor checked (${km.checkedCount} of ${km.totalActiveCount} active) -- keyword-count component not verified this run.`)
    }
  }

  // Informational only, not scored: the organic-competitors call is still
  // used for competitor *detection* (lib/competitorDetection.js), which is
  // a separate concern from the keyword-count sub-check above. Surfaced
  // here so a real detection-side API/permission problem doesn't go
  // unnoticed just because it doesn't affect this run's score.
  if (ahrefsError) {
    const statusPart = ahrefsError.status ? `HTTP ${ahrefsError.status}` : 'call failed'
    evidence.push(`Note: Ahrefs organic-competitors call (used for competitor auto-detection, not for the keyword-count score above) failed this run (${statusPart}: ${ahrefsError.message}) -- new competitors won't be auto-detected from that signal until this is resolved, though AI-citation-based detection is unaffected.`)
  }

  // Same "partial run" contract as every other checker in this project
  // (see technical-checker.js) -- an unverified sub-check counts its
  // points as not-yet-earned, NOT excluded from the 100-point scale.
  // Getting 30/30 verified points right is a 30, not a rescaled 100 --
  // same reasoning as a school test where 30 answered questions being all
  // correct isn't a perfect score if 70 more questions were never
  // attempted. Missing this flag was the actual bug behind an "F" that
  // read as contradictory next to "holding steady, no major gaps" -- the
  // grade was correct BY THIS PROJECT'S OWN RULE (0 points earned toward
  // the 40 Ahrefs points that were never verified), it just never told
  // the strategist that's what happened, unlike every other pillar.
  const headToHeadPossible = totalWeighted > 0 ? 60 : 0
  const keywordPossible = keywordVerified ? 40 : 0
  const totalPossible = headToHeadPossible + keywordPossible
  const score = headToHeadEarned + keywordEarned
  const grade = scoreToGrade(score)

  const unverifiedNote = totalPossible < 100
    ? ` (Only ${totalPossible}/100 possible points could be verified this run -- the other ${100 - totalPossible} count as not-yet-earned toward the grade, not skipped. This is usually the Ahrefs keyword-count sub-check having no overlapping tracked-competitor data yet -- see the evidence above.)`
    : ''

  const finding = (findings.length > 0
    ? findings.join(' ')
    : `Holding steady against ${activeCompetitors.length} tracked competitor(s) with no major gaps found this run.`) + unverifiedNote
  const recommendation = recommendations.length > 0
    ? recommendations.join(' ')
    : 'No action needed -- keep monitoring as competitors and AI-visibility data accumulate.'

  return {
    grade,
    score,
    // Same dashboard flag every other pillar already uses (see
    // PillarsBoard.js's "partial -- N/100 checked" badge) -- a grade
    // computed from an incomplete points pool should never render
    // identically to a fully-verified one.
    partial: totalPossible < 100,
    possiblePoints: totalPossible,
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
      keywordEarned,
      totalPossible,
      totalEarned: score
    }
  }
}

module.exports = { checkCompetitivePosition, scoreToGrade, MIN_COMPETITORS_TO_GRADE }
