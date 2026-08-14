// Content Authority pillar checker.
//
// Per the roadmap, this pillar is explicitly "hybrid": hard numbers first,
// LLM narrative layered on top of those later (not invented from search
// snippets, which is what the old Grader effectively did). This module
// covers the hard-numbers half:
//   1. Word count / thin-content detection across a sample of key pages
//   2. Content freshness (most recent sitemap lastmod / blog publish date)
//   3. Referring domains — via Ahrefs' Site Explorer backlinks-stats report
//      (lib/checkers/ahrefs.js), when AHREFS_API_KEY is configured. Same
//      pattern as the PageSpeed Insights check in technical-checker.js:
//      reported as "not verified" and excluded from the score, never
//      silently scored as zero, when the key isn't configured yet.
//
// Competitor gap analysis (added 2026-08-14, per direct request: "if we are
// showing content authority I think we need to show what the gap is and
// what are our biggest wins to close that gap"): when 2+ active tracked
// competitors exist (the same client_competitors list Competitive Position
// uses), this also fetches each competitor's equivalent homepage word
// count, content-freshness date, and Ahrefs referring-domain count (capped
// at MAX_CONTENT_GAP_COMPETITORS -- same accepted cost tradeoff as
// Competitive Position's keyword-count rebuild), and ranks all three
// sub-checks by how large the competitive gap actually is -- not just
// whether this site cleared its own fixed threshold. A site can clear
// checkReferringDomains' 50-live-domain bar for full marks and still be
// getting crushed by competitors averaging 500 -- the ranked gap list is
// what surfaces that, which the fixed-threshold score alone can't.
//
// Zero dependencies otherwise, same shared output contract as the other
// two checkers.

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

// checkStatus(part) -> 'pass' | 'partial' | 'not_verified'
// possible === 0 means the check couldn't run at all (e.g. no backlink API
// key configured) -- that's a data gap, not a failure.
function checkStatus({ possible, earned }) {
  if (!possible) return 'not_verified'
  return earned >= possible ? 'pass' : 'partial'
}

function htmlToWordCount(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return 0
  return stripped.split(' ').filter(Boolean).length
}

async function safeFetch(fetcher, url) {
  try {
    const res = await fetcher(url)
    return { ok: res.ok, status: res.status, res }
  } catch (err) {
    return { ok: false, status: null, error: err.message }
  }
}

// --- Check 1: word count / thin-content sample ---
async function checkWordCount(pages, fetcher, { thinThreshold = 150, goodThreshold = 300 } = {}) {
  const possible = 30
  const evidence = []
  const findings = []
  const recommendations = []
  const issues = []
  const results = []

  for (const page of pages) {
    const res = await safeFetch(fetcher, page)
    if (!res.ok) {
      results.push({ page, error: true })
      continue
    }
    const html = await res.res.text()
    const wordCount = htmlToWordCount(html)
    results.push({ page, wordCount })
  }

  const valid = results.filter(r => !r.error)
  if (valid.length === 0) {
    findings.push('Could not load any sampled pages to check content depth.')
    return { possible, earned: 0, avg: null, evidence, findings, recommendations, issues }
  }

  const avg = Math.round(valid.reduce((s, r) => s + r.wordCount, 0) / valid.length)
  const thin = valid.filter(r => r.wordCount < thinThreshold)
  evidence.push(`Sampled ${valid.length} page(s), average ${avg} words/page: ${valid.map(r => `${r.page} (${r.wordCount}w)`).join(', ')}`)

  let earned
  if (avg >= goodThreshold) earned = possible
  else if (avg <= 20) earned = 0
  else earned = Math.round((avg / goodThreshold) * possible)

  if (thin.length > 0) {
    findings.push(`${thin.length} of ${valid.length} sampled page(s) are thin content (under ${thinThreshold} words): ${thin.map(r => `${r.page} (${r.wordCount}w)`).join(', ')}.`)
    recommendations.push('Expand thin pages with substantive, specific content — not filler. Resource/hub pages that are just link lists should either link out to real articles or be merged into a page that has actual content.')
    issues.push({
      severity: avg < 100 ? 'critical' : avg < 200 ? 'moderate' : 'minor',
      message: `${thin.length} of ${valid.length} sampled page(s) are thin content (under ${thinThreshold} words): ${thin.map(r => `${r.page} (${r.wordCount}w)`).join(', ')}.`,
      why: 'Thin pages give Google and AI answer engines very little to work with -- they read as low-effort and are less likely to be cited or ranked well, especially against competitors with substantive pages on the same topic.',
      recommendation: 'Expand thin pages with substantive, specific content -- not filler. Resource/hub pages that are just link lists should either link out to real articles or be merged into a page that has actual content.'
    })
  }

  return { possible, earned, avg, evidence, findings, recommendations, issues }
}

// fetchMostRecentContentDate(sitemapUrl, blogUrl, fetcher) -> Promise<Date | null>
// Shared date-extraction core of checkFreshness below -- factored out so
// fetchCompetitorContentSignals (competitor gap analysis, see this file's
// header) can compute the exact same "most recent dated content" signal
// for a competitor's own domain, not just this client's.
async function fetchMostRecentContentDate(sitemapUrl, blogUrl, fetcher) {
  const dates = []

  const sitemapRes = await safeFetch(fetcher, sitemapUrl)
  if (sitemapRes.ok) {
    const text = await sitemapRes.res.text()
    const lastmods = Array.from(text.matchAll(/<lastmod>([^<]+)<\/lastmod>/gi)).map(m => new Date(m[1]))
    dates.push(...lastmods.filter(d => !isNaN(d)))
  }

  if (blogUrl) {
    const blogRes = await safeFetch(fetcher, blogUrl)
    if (blogRes.ok) {
      const html = await blogRes.res.text()
      const published = Array.from(html.matchAll(/datePublished["']?\s*[:=]?\s*(?:content=)?["']([^"']+)["']/gi)).map(m => new Date(m[1]))
      dates.push(...published.filter(d => !isNaN(d)))
    }
  }

  if (dates.length === 0) return null
  return new Date(Math.max(...dates.map(d => d.getTime())))
}

// --- Check 2: content freshness (sitemap lastmod + blog datePublished) ---
async function checkFreshness(sitemapUrl, blogUrl, fetcher, { now = new Date() } = {}) {
  const possible = 30
  const evidence = []
  const findings = []
  const recommendations = []
  const issues = []

  const mostRecent = await fetchMostRecentContentDate(sitemapUrl, blogUrl, fetcher)

  if (!mostRecent) {
    findings.push('Could not find any dated content (sitemap lastmod or blog publish dates) to assess freshness.')
    recommendations.push('Ensure sitemap.xml includes <lastmod> dates and blog posts expose a publish date.')
    return { possible, earned: 0, daysSince: null, evidence, findings, recommendations, issues }
  }

  const daysSince = Math.round((now.getTime() - mostRecent.getTime()) / 86400000)
  evidence.push(`Most recent dated content found: ${mostRecent.toISOString().slice(0, 10)} (${daysSince} days ago).`)

  let earned
  if (daysSince <= 90) earned = possible
  else if (daysSince <= 180) earned = 20
  else if (daysSince <= 365) earned = 10
  else earned = 0

  if (daysSince > 365) {
    const years = (daysSince / 365).toFixed(1)
    findings.push(`No detectable content update in over a year — most recent dated content is ${years} years old.`)
    recommendations.push('Establish a regular publishing cadence. Stale content is a real signal both to Google and to AI systems evaluating whether a site is actively maintained.')
    issues.push({
      severity: 'critical',
      message: `No detectable content update in over a year -- most recent dated content is ${years} years old.`,
      why: 'Stale content is a real signal both to Google and to AI systems evaluating whether a site is actively maintained -- a site that looks abandoned is less likely to be trusted or cited.',
      recommendation: 'Establish a regular publishing cadence.'
    })
  } else if (daysSince > 180) {
    findings.push(`Most recent detectable content update was ${daysSince} days ago — cadence has slowed.`)
    recommendations.push('Publish more regularly; aim for at least quarterly updates to demonstrate an active site.')
    issues.push({
      severity: 'moderate',
      message: `Most recent detectable content update was ${daysSince} days ago -- cadence has slowed.`,
      why: 'Not yet a red flag, but the gap is wide enough to be worth tightening before it becomes one.',
      recommendation: 'Publish more regularly; aim for at least quarterly updates to demonstrate an active site.'
    })
  }

  return { possible, earned, daysSince, evidence, findings, recommendations, issues }
}

// --- Check 3: referring domains, via Ahrefs' backlinks-stats report ---
//
// Thresholds below are a documented first-pass heuristic (same spirit as
// checkWordCount's 150/300-word bands and checkFreshness's 90/180/365-day
// bands elsewhere in this file), not a scientifically derived scale --
// good enough to seed a meaningful score; tune later against real client
// data if it turns out to be too generous or too harsh in practice.
async function checkReferringDomains(domain, fetcher, backlinkApiKey) {
  const possible = 40
  const evidence = []
  const findings = []
  const recommendations = []
  const issues = []

  if (!backlinkApiKey) {
    findings.push('Referring domains not verified — no backlink-data API configured (Ahrefs, Moz, SEMrush, or Google Search Console would all work).')
    recommendations.push('Configure AHREFS_API_KEY (or another backlink data source) so this check can run.')
    issues.push({
      severity: 'info',
      message: 'Referring domains not verified.',
      why: 'No backlink-data API is configured -- this is a data gap, not a finding about the site itself.',
      recommendation: 'Configure AHREFS_API_KEY (or another backlink data source) so this check can run.'
    })
    return { possible: 0, earned: 0, liveRefDomains: null, evidence, findings, recommendations, issues }
  }

  const { getBacklinksStats } = require('./ahrefs')
  const stats = await getBacklinksStats(domain, { apiKey: backlinkApiKey })
  if (!stats) {
    findings.push('Referring domains not verified — the Ahrefs backlinks-stats request failed or returned no data for this domain.')
    recommendations.push('Confirm AHREFS_API_KEY is valid and this domain is reachable via Ahrefs, then re-run.')
    issues.push({
      severity: 'info',
      message: 'Referring domains not verified.',
      why: 'The Ahrefs backlinks-stats request failed or returned no data for this domain -- a data gap, not a finding about the site itself.',
      recommendation: 'Confirm AHREFS_API_KEY is valid and this domain is reachable via Ahrefs, then re-run.'
    })
    return { possible: 0, earned: 0, liveRefDomains: null, evidence, findings, recommendations, issues }
  }

  const { liveRefDomains, allTimeRefDomains } = stats
  evidence.push(`${liveRefDomains} live referring domain(s) currently link to this site (${allTimeRefDomains} all-time, via Ahrefs).`)

  let earned
  if (liveRefDomains >= 50) earned = possible
  else if (liveRefDomains >= 20) earned = 30
  else if (liveRefDomains >= 5) earned = 20
  else if (liveRefDomains >= 1) earned = 10
  else earned = 0

  if (liveRefDomains < 20) {
    findings.push(`Only ${liveRefDomains} referring domain(s) currently link to this site — link authority is thin.`)
    recommendations.push('Pursue local citations, partnerships, and press/guest-content opportunities to build referring domains -- this is one of the strongest ranking signals Google and most AI answer engines both weigh.')
    issues.push({
      severity: liveRefDomains < 5 ? 'critical' : 'moderate',
      message: `Only ${liveRefDomains} referring domain(s) currently link to this site -- link authority is thin.`,
      why: 'Referring domains are one of the strongest signals both Google and most AI answer engines weigh when deciding which business to trust and recommend.',
      recommendation: 'Pursue local citations, partnerships, and press/guest-content opportunities to build referring domains.'
    })
  }

  return { possible, earned, liveRefDomains, evidence, findings, recommendations, issues }
}

// MAX_CONTENT_GAP_COMPETITORS: capped per-audit cost for the competitor gap
// analysis, same reasoning as Competitive Position's
// MAX_KEYWORD_METRIC_COMPETITORS (lib/competitorDetection.js) -- fetching a
// competitor's homepage, sitemap, and blog page (plus one Ahrefs call each)
// for every single tracked competitor doesn't scale to a client with 25
// competitors; this bounds it while still comparing against a meaningful
// sample.
const MAX_CONTENT_GAP_COMPETITORS = 10

// fetchCompetitorContentSignals(activeCompetitors, opts) -> Promise<{
//   competitors: Array<{ domain, wordCount: number|null, daysSinceUpdate: number|null, liveRefDomains: number|null }>,
//   checkedCount, totalActiveCount
// }>
// Fetches each tracked competitor's own equivalent of this file's three
// signals -- homepage word count, most-recent-dated-content freshness, and
// Ahrefs live referring domains -- so checkContentAuthority can compare
// this client's own numbers against a real competitive baseline instead of
// only a fixed threshold. Homepage-only (not a multi-page sample) to match
// what this client's own checkWordCount actually compares against by
// default (runAudit.js calls checkContentAuthority without samplePages, so
// its own sample is just the homepage too -- an apples-to-apples
// comparison, not homepage-vs-multi-page-average). Never throws -- a
// per-competitor fetch failure just leaves that field null for that
// competitor, same "data gap, not fatal" contract as everywhere else in
// this project.
async function fetchCompetitorContentSignals(activeCompetitors, { fetcher = fetch, backlinkApiKey = null, maxCompetitors = MAX_CONTENT_GAP_COMPETITORS } = {}) {
  const { getBacklinksStats } = require('./ahrefs')
  const totalActiveCount = (activeCompetitors || []).length
  const competitorsToCheck = (activeCompetitors || []).slice(0, maxCompetitors)

  const results = await Promise.all(competitorsToCheck.map(async c => {
    const base = `https://${c.domain}`
    const [wordCountResult, mostRecentDate, backlinkStats] = await Promise.all([
      safeFetch(fetcher, base).then(async r => {
        if (!r.ok) return null
        try { return htmlToWordCount(await r.res.text()) } catch (e) { return null }
      }),
      fetchMostRecentContentDate(`${base}/sitemap.xml`, `${base}/blog/`, fetcher).catch(() => null),
      backlinkApiKey ? getBacklinksStats(c.domain, { apiKey: backlinkApiKey }).catch(() => null) : Promise.resolve(null)
    ])
    return {
      domain: c.domain,
      wordCount: typeof wordCountResult === 'number' ? wordCountResult : null,
      daysSinceUpdate: mostRecentDate ? Math.round((Date.now() - mostRecentDate.getTime()) / 86400000) : null,
      liveRefDomains: backlinkStats ? backlinkStats.liveRefDomains : null
    }
  }))

  return { competitors: results, checkedCount: competitorsToCheck.length, totalActiveCount }
}

// buildContentGaps(parts, competitorSignals) -> Array<gap entry>, ranked
// worst-gap-first.
// parts = { wordCountResult, freshnessResult, backlinkResult } -- this
// client's own already-computed numbers, reused rather than re-fetched.
// For each of the three signals where at least one competitor has a
// comparable (non-null) number, computes a "relative performance" ratio --
// clientValue/competitorAvg for higher-is-better signals (word count,
// referring domains), competitorAvg/clientValue for freshness (lower
// days-since-update is better, so the ratio direction has to flip or a
// stale client would look artificially "ahead"). Ranked ascending by that
// ratio -- the metric where this client is comparatively worst off sorts
// first, i.e. "biggest win available." A metric with no comparable
// competitor data (every competitor fetch for it failed, or the Ahrefs key
// isn't configured) is simply omitted from the ranking, not scored as a
// zero -- same "data gap, not a finding" contract as the rest of this
// project.
function buildContentGaps(parts, competitorSignals) {
  if (!competitorSignals) return []
  const { wordCountResult, freshnessResult, backlinkResult } = parts
  const gaps = []

  const wcComparable = competitorSignals.competitors.filter(c => typeof c.wordCount === 'number')
  if (typeof wordCountResult.avg === 'number' && wcComparable.length > 0) {
    const competitorAvg = Math.round(wcComparable.reduce((s, c) => s + c.wordCount, 0) / wcComparable.length)
    const ratio = competitorAvg > 0 ? wordCountResult.avg / competitorAvg : 1
    gaps.push({
      key: 'word_count',
      label: 'Homepage word count',
      clientValue: wordCountResult.avg,
      competitorAvg,
      comparedCount: wcComparable.length,
      ratio,
      unit: 'words'
    })
  }

  const freshComparable = competitorSignals.competitors.filter(c => typeof c.daysSinceUpdate === 'number')
  if (typeof freshnessResult.daysSince === 'number' && freshComparable.length > 0) {
    const competitorAvg = Math.round(freshComparable.reduce((s, c) => s + c.daysSinceUpdate, 0) / freshComparable.length)
    // Inverted -- fewer days since the last update is better, so a client
    // updating more often than competitors should still rank as "ahead"
    // (ratio > 1), not behind.
    const ratio = freshnessResult.daysSince > 0 ? competitorAvg / freshnessResult.daysSince : 1
    gaps.push({
      key: 'freshness',
      label: 'Days since last content update',
      clientValue: freshnessResult.daysSince,
      competitorAvg,
      comparedCount: freshComparable.length,
      ratio,
      unit: 'days',
      lowerIsBetter: true
    })
  }

  const refComparable = competitorSignals.competitors.filter(c => typeof c.liveRefDomains === 'number')
  if (typeof backlinkResult.liveRefDomains === 'number' && refComparable.length > 0) {
    const competitorAvg = Math.round(refComparable.reduce((s, c) => s + c.liveRefDomains, 0) / refComparable.length)
    const ratio = competitorAvg > 0 ? backlinkResult.liveRefDomains / competitorAvg : 1
    gaps.push({
      key: 'referring_domains',
      label: 'Live referring domains',
      clientValue: backlinkResult.liveRefDomains,
      competitorAvg,
      comparedCount: refComparable.length,
      ratio,
      unit: 'domains'
    })
  }

  return gaps.sort((a, b) => a.ratio - b.ratio)
}

// Same floor Competitive Position uses for its own "enough competitors to
// bother comparing" gate (MIN_COMPETITORS_TO_GRADE in
// competitive-position-checker.js) -- kept as its own literal rather than a
// cross-import, since this file is otherwise zero-dependency and the two
// numbers are allowed to diverge later if one pillar's needs change.
const MIN_COMPETITORS_FOR_GAP_ANALYSIS = 2

const GAP_RECOMMENDATIONS = {
  word_count: 'Expand key page content -- word count is meaningfully behind tracked competitors, which likely means less substantive material for Google and AI engines to draw from relative to them.',
  freshness: 'Publish more often -- tracked competitors are updating more recently on average, and content freshness is a real signal of an actively maintained site to both Google and AI systems.',
  referring_domains: 'Prioritize link building (local citations, partnerships, press/guest content) -- referring domains are meaningfully behind tracked competitors, and this is one of the strongest authority signals both Google and AI answer engines weigh.'
}

async function checkContentAuthority(url, { fetcher = fetch, samplePages = null, blogUrl = null, backlinkApiKey = null, now = new Date(), competitors = [] } = {}) {
  const base = url.replace(/\/$/, '')
  const pages = samplePages || [url]
  const sitemapUrl = `${base}/sitemap.xml`
  const effectiveBlogUrl = blogUrl === undefined ? `${base}/blog/` : blogUrl

  const [wordCountResult, freshnessResult, backlinkResult] = await Promise.all([
    checkWordCount(pages, fetcher),
    checkFreshness(sitemapUrl, effectiveBlogUrl, fetcher, { now }),
    checkReferringDomains(base, fetcher, backlinkApiKey)
  ])

  // Competitor gap analysis -- only worth the added competitor site
  // fetches/Ahrefs calls when there's a meaningful set of tracked
  // competitors to compare against. See this file's header and
  // fetchCompetitorContentSignals/buildContentGaps above for the full
  // design; this is purely additive evidence/narrative layered on top of
  // the three fixed-threshold checks above, not a replacement for them --
  // the score/grade is unchanged by this.
  const activeCompetitors = (competitors || []).filter(c => c.active !== false)
  const competitorSignals = activeCompetitors.length >= MIN_COMPETITORS_FOR_GAP_ANALYSIS
    ? await fetchCompetitorContentSignals(activeCompetitors, { fetcher, backlinkApiKey })
    : null
  const contentGaps = buildContentGaps({ wordCountResult, freshnessResult, backlinkResult }, competitorSignals)

  const parts = [wordCountResult, freshnessResult, backlinkResult]
  const totalPossible = parts.reduce((s, p) => s + p.possible, 0)
  const totalEarned = parts.reduce((s, p) => s + p.earned, 0)
  // Graded on the full 100-point scale, not rescaled to whatever subset of
  // checks actually ran -- see technical-checker.js's comment on this same
  // fix. Earning every point on 30/100 possible checks is a 30, not a 100.
  const score = totalEarned

  const checks = [
    { label: 'Content depth (word count sample)', status: checkStatus(wordCountResult) },
    { label: 'Content freshness (recent updates)', status: checkStatus(freshnessResult) },
    { label: 'Referring domains (backlinks)', status: checkStatus(backlinkResult) }
  ]

  const evidence = parts.flatMap(p => p.evidence)
  const findings = parts.flatMap(p => p.findings)
  const recommendations = parts.flatMap(p => p.recommendations)
  const SEVERITY_RANK = { critical: 0, moderate: 1, minor: 2, info: 3 }
  const issues = parts.flatMap(p => p.issues || []).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

  // Ranked gap list -- worst gap (lowest ratio) first, per direct request:
  // "show what the gap is and what are our biggest wins to close that
  // gap." The single worst gap also leads the finding/recommendation text
  // (unless this client is actually ahead on every comparable signal, in
  // which case that's the more useful thing to say).
  let gapFinding = null
  let gapRecommendation = null
  if (contentGaps.length > 0) {
    const lines = contentGaps.map((g, i) => {
      const isAhead = g.ratio >= 1
      const pct = Math.round(g.ratio * 100)
      const comparison = isAhead
        ? `ahead of the ${g.comparedCount}-competitor average`
        : `only ${pct}% of the ${g.comparedCount}-competitor average`
      return `${i + 1}) ${g.label}: ${g.clientValue} ${g.unit} vs ${g.competitorAvg} ${g.unit} (${comparison})`
    })
    evidence.push(`Vs tracked competitors, ranked biggest opportunity first: ${lines.join('; ')}.`)

    const worst = contentGaps[0]
    if (worst.ratio < 0.9) {
      const pct = Math.round(worst.ratio * 100)
      gapFinding = `Biggest content-authority opportunity vs tracked competitors: ${worst.label.toLowerCase()} (${worst.clientValue} ${worst.unit} vs a ${worst.competitorAvg}-${worst.unit} competitor average -- only ${pct}%).`
      gapRecommendation = GAP_RECOMMENDATIONS[worst.key] || 'Close this gap relative to tracked competitors.'
    } else {
      gapFinding = `Ahead of or in line with tracked competitors on all ${contentGaps.length} comparable content-authority signal(s) this run.`
    }
  } else if (activeCompetitors.length >= MIN_COMPETITORS_FOR_GAP_ANALYSIS) {
    evidence.push(`${activeCompetitors.length} tracked competitor(s) exist, but none had comparable data for any of the three content-authority signals this run (competitor site fetches/Ahrefs calls may have failed) -- gap ranking not available.`)
  }

  const unverifiedNote = totalPossible < 100 ? ` (Only ${totalPossible}/100 possible points could be verified this run -- the other ${100 - totalPossible} count as not-yet-earned toward the grade, not skipped.)` : ''

  // Gap narrative leads (it's the most actionable, competitor-grounded
  // signal), with the existing absolute-threshold findings/recommendations
  // following -- neither replaces the other.
  const combinedFindings = gapFinding ? [gapFinding, ...findings] : findings
  const combinedRecommendations = gapRecommendation ? [gapRecommendation, ...recommendations] : recommendations

  return {
    grade: scoreToGrade(score),
    score,
    // A grade computed from an incomplete points pool (e.g. no backlink API
    // configured) should never display identically to a fully-verified
    // grade.
    partial: totalPossible < 100,
    possiblePoints: totalPossible,
    finding: (combinedFindings.length > 0 ? combinedFindings.join(' ') : 'No content authority issues detected in the checks that ran.') + unverifiedNote,
    recommendation: combinedRecommendations.length > 0 ? combinedRecommendations.join(' ') : 'No action needed on the checks that ran.',
    evidence,
    checks,
    issues,
    _raw: { totalPossible, totalEarned, contentGaps }
  }
}

module.exports = { checkContentAuthority, scoreToGrade, htmlToWordCount }
