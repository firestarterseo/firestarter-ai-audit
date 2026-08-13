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
//
// Citation tiering (added 2026-08-13, per direct client feedback): a plain
// third-party mention, a self-citation, and a best/top/recommended-list
// placement are NOT equally valuable. Self-citation specifically outranks
// a plain third-party mention -- "if you own the mention you potentially
// get the click," a real practical benefit a passing name-drop elsewhere
// doesn't carry -- while a best-list placement or a citation from a
// recognized authority (see lib/authorityDomains.js) outranks both. The
// citation-rate component below is a weighted average of a per-row
// 0/0.5/0.75/1 tier (see rowCitationTier): no citation = 0, plain
// third-party mention = 0.5, self-citation = 0.75, best-list/authority
// citation = 1. A negative-sentiment row earns no citation credit
// regardless of source (a bad-press writeup isn't an endorsement just
// because it's third-party).

const { isAuthorityDomain } = require('../authorityDomains')

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

// weightedAverage(rows, valueFn) -> weighted mean of valueFn(row) across
// rows, weighted by each row's engine weight. Used for citation strength
// below, which is a graduated 0-1 value (self-citation vs third-party vs
// authority), not a plain boolean share.
function weightedAverage(rows, valueFn) {
  const totalWeight = rows.reduce((sum, r) => sum + weightOf(r.engine), 0)
  if (totalWeight === 0) return 0
  const weightedSum = rows.reduce((sum, r) => sum + valueFn(r) * weightOf(r.engine), 0)
  return weightedSum / totalWeight
}

// BEST_LIST_PATTERNS / hasBestListFraming(text) -- kept as a literal
// duplicate of the identical helper in ai-visibility-snapshot-checker.js
// (same "Infra-separation note" reasoning as ENGINE_WEIGHTS above). Used
// only as a fallback for rows logged before raw.bestListCited was
// persisted directly (see rowCitationTier below) -- current rows carry
// the already-computed value from trackAiVisibility.js instead of
// re-deriving it from a truncated 400-char responseSnippet here.
const BEST_LIST_PATTERNS = [
  /\btop\s*\d+\b/i,
  /\btop[- ]rated\b/i,
  /\bbest\b[\s\S]{0,30}\bin\b/i,
  /\brecommended\b/i,
  /\bhighly recommended\b/i,
  /\bmust[- ]try\b/i,
  /\bleading\b/i,
  /\bpremier\b/i
]
function hasBestListFraming(text) {
  if (!text) return false
  return BEST_LIST_PATTERNS.some(re => re.test(text))
}

// rowCitationTier(row) -> 0 to 1, how strong this row's citation was.
// Per direct client feedback: self-citation (3), a plain third-party
// mention (2), and being named in a best/top/recommended list (4) are NOT
// equally valuable -- self-citation specifically outranks a plain
// third-party mention, since "if you own the mention you potentially get
// the click," a real practical benefit a passing third-party name-drop
// doesn't carry. Mapped onto this checker's 0-1 scale (4 as the ceiling):
// no citation = 0, plain third-party mention = 0.5, self-citation = 0.75,
// a citation from a recognized authority domain (lib/authorityDomains.js)
// OR one using best-list framing = 1 (either signal alone is enough). A
// negative-sentiment row never earns citation credit even with a source
// present -- a lawsuit writeup citing the business isn't an endorsement
// just because it's third-party (sentiment already has its own score
// component below, so this isn't double-penalizing, just declining to
// double-reward it as a citation too).
//
// Falls back gracefully for rows that predate the source-URL breakdown
// (e.g. the sourcehq-shaped historical fixtures this checker was
// originally built against, which only ever had a plain brand_cited
// boolean) -- those get treated as self-citation tier rather than losing
// credit entirely, since there's no way to tell self vs third-party
// without the URL data.
function rowCitationTier(row) {
  if (!row.brand_mentioned) return 0
  if (row.sentiment === 'negative') return 0
  const raw = row.raw || {}
  const hasUrlBreakdown = Array.isArray(raw.sourceUrls) || Array.isArray(raw.ownDomainSourceUrls) || Array.isArray(raw.thirdPartySourceUrls)
  if (!hasUrlBreakdown) {
    return row.brand_cited ? 0.75 : 0
  }
  const ownUrls = Array.isArray(raw.ownDomainSourceUrls) ? raw.ownDomainSourceUrls : []
  const thirdPartyUrls = Array.isArray(raw.thirdPartySourceUrls)
    ? raw.thirdPartySourceUrls
    : (Array.isArray(raw.sourceUrls) ? raw.sourceUrls.filter(u => !ownUrls.includes(u)) : [])
  const hasThirdParty = thirdPartyUrls.length > 0
  const hasAuthority = thirdPartyUrls.some(isAuthorityDomain)
  // Prefer the persisted value; fall back to re-deriving from the
  // (truncated) responseSnippet for older rows that predate it.
  const hasBestList = hasThirdParty && (raw.bestListCited === true || (raw.bestListCited === undefined && hasBestListFraming(raw.responseSnippet)))
  if (hasAuthority || hasBestList) return 1
  if (ownUrls.length > 0) return 0.75
  if (hasThirdParty) return 0.5
  return 0
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
  // citationRate is now a weighted AVERAGE of each mentioned row's citation
  // tier (0/0.5/0.75/1 -- see rowCitationTier above), not a simple "was it
  // cited at all" share. Self-citation only tops out at 75% of this
  // component; a best/top/recommended list or recognized-authority
  // citation can reach 100%.
  const citationRate = mentioned.length > 0 ? weightedAverage(mentioned, rowCitationTier) : 0

  const positioned = mentioned.filter(r => r.answer_position && r.answer_position > 0)
  const avgPosition = positioned.length > 0
    ? positioned.reduce((s, r) => s + r.answer_position, 0) / positioned.length
    : null

  const sentimented = mentioned.filter(r => r.sentiment && r.sentiment !== 'n/a')
  const positiveSentiment = sentimented.filter(r => r.sentiment === 'positive')
  const positiveRate = sentimented.length > 0 ? weightedShare(sentimented, r => r.sentiment === 'positive') : null

  evidence.push(`${total} AI-engine runs analyzed; mentioned in ${mentioned.length} (${Math.round(mentionRate * 100)}%).`)
  evidence.push(`Of runs where mentioned, cited/sourced in ${citedAmongMentioned.length}; weighted citation strength ${Math.round(citationRate * 100)}% of max (best/top/recommended-list and authority-source citations score highest, self-citation next, a plain third-party mention least).`)
  if (mentioned.length > 0) {
    const bestOrAuthorityMentions = mentioned.filter(r => rowCitationTier(r) === 1).length
    const ownReferralMentions = mentioned.filter(r => rowCitationTier(r) === 0.75).length
    const thirdPartyOnlyMentions = mentioned.filter(r => rowCitationTier(r) === 0.5).length
    const noCitationMentions = mentioned.filter(r => rowCitationTier(r) === 0).length
    evidence.push(`Citation mix among mentions: ${bestOrAuthorityMentions} from a best/top/recommended list or recognized authority source, ${ownReferralMentions} self-referral (own site cited), ${thirdPartyOnlyMentions} from a plain third-party mention, ${noCitationMentions} with no citation credit (no citation at all, or negative sentiment).`)
  }
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

  if (mentioned.length > 0) {
    const bestOrAuthorityCount = mentioned.filter(r => rowCitationTier(r) === 1).length
    const ownReferralCount = mentioned.filter(r => rowCitationTier(r) === 0.75).length
    const thirdPartyOnlyCount = mentioned.filter(r => rowCitationTier(r) === 0.5).length
    if (bestOrAuthorityCount === 0 && (ownReferralCount > 0 || thirdPartyOnlyCount > 0)) {
      findings.push(`Cited in ${ownReferralCount + thirdPartyOnlyCount} mention(s) (${ownReferralCount} self-referral, ${thirdPartyOnlyCount} plain third-party), but none from a best/top/recommended list or recognized authority source yet.`)
      recommendations.push('Pursue placements in "best of" / "top" / recommended lists and citations from recognized authority sources (press, review platforms, industry publications) -- these carry the most weight with AI engines, more than either self-citation or a passing third-party mention.')
    }
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
