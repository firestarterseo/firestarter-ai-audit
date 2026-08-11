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
// Zero dependencies, same shared output contract as the other two checkers.

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
    return { possible, earned: 0, evidence, findings, recommendations, issues }
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

  return { possible, earned, evidence, findings, recommendations, issues }
}

// --- Check 2: content freshness (sitemap lastmod + blog datePublished) ---
async function checkFreshness(sitemapUrl, blogUrl, fetcher, { now = new Date() } = {}) {
  const possible = 30
  const evidence = []
  const findings = []
  const recommendations = []
  const issues = []

  const dates = []

  const sitemapRes = await safeFetch(fetcher, sitemapUrl)
  if (sitemapRes.ok) {
    const text = await sitemapRes.res.text()
    const lastmods = Array.from(text.matchAll(/<lastmod>([^<]+)<\/lastmod>/gi)).map(m => new Date(m[1]))
    dates.push(...lastmods.filter(d => !isNaN(d)))
    if (lastmods.length > 0) evidence.push(`${lastmods.length} <lastmod> date(s) found in sitemap.xml.`)
  }

  if (blogUrl) {
    const blogRes = await safeFetch(fetcher, blogUrl)
    if (blogRes.ok) {
      const html = await blogRes.res.text()
      const published = Array.from(html.matchAll(/datePublished["']?\s*[:=]?\s*(?:content=)?["']([^"']+)["']/gi)).map(m => new Date(m[1]))
      dates.push(...published.filter(d => !isNaN(d)))
      if (published.length > 0) evidence.push(`Most recent detectable blog post date: ${published[0].toISOString().slice(0, 10)}.`)
    }
  }

  if (dates.length === 0) {
    findings.push('Could not find any dated content (sitemap lastmod or blog publish dates) to assess freshness.')
    recommendations.push('Ensure sitemap.xml includes <lastmod> dates and blog posts expose a publish date.')
    return { possible, earned: 0, evidence, findings, recommendations, issues }
  }

  const mostRecent = new Date(Math.max(...dates.map(d => d.getTime())))
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

  return { possible, earned, evidence, findings, recommendations, issues }
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
    return { possible: 0, earned: 0, evidence, findings, recommendations, issues }
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
    return { possible: 0, earned: 0, evidence, findings, recommendations, issues }
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

  return { possible, earned, evidence, findings, recommendations, issues }
}

async function checkContentAuthority(url, { fetcher = fetch, samplePages = null, blogUrl = null, backlinkApiKey = null, now = new Date() } = {}) {
  const base = url.replace(/\/$/, '')
  const pages = samplePages || [url]
  const sitemapUrl = `${base}/sitemap.xml`
  const effectiveBlogUrl = blogUrl === undefined ? `${base}/blog/` : blogUrl

  const [wordCountResult, freshnessResult, backlinkResult] = await Promise.all([
    checkWordCount(pages, fetcher),
    checkFreshness(sitemapUrl, effectiveBlogUrl, fetcher, { now }),
    checkReferringDomains(base, fetcher, backlinkApiKey)
  ])

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

  const unverifiedNote = totalPossible < 100 ? ` (Only ${totalPossible}/100 possible points could be verified this run -- the other ${100 - totalPossible} count as not-yet-earned toward the grade, not skipped.)` : ''

  return {
    grade: scoreToGrade(score),
    score,
    // A grade computed from an incomplete points pool (e.g. no backlink API
    // configured) should never display identically to a fully-verified
    // grade.
    partial: totalPossible < 100,
    possiblePoints: totalPossible,
    finding: (findings.length > 0 ? findings.join(' ') : 'No content authority issues detected in the checks that ran.') + unverifiedNote,
    recommendation: recommendations.length > 0 ? recommendations.join(' ') : 'No action needed on the checks that ran.',
    evidence,
    checks,
    issues,
    _raw: { totalPossible, totalEarned }
  }
}

module.exports = { checkContentAuthority, scoreToGrade, htmlToWordCount }
