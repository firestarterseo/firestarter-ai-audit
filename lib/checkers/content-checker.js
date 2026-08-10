// Content Authority pillar checker.
//
// Per the roadmap, this pillar is explicitly "hybrid": hard numbers first,
// LLM narrative layered on top of those later (not invented from search
// snippets, which is what the old Grader effectively did). This module
// covers the hard-numbers half:
//   1. Word count / thin-content detection across a sample of key pages
//   2. Content freshness (most recent sitemap lastmod / blog publish date)
//   3. Referring domains — requires a backlink-data API (Ahrefs/Moz/SEMrush/
//      Google Search Console); none is configured yet, so — same pattern as
//      the PageSpeed Insights check in technical-checker.js — this is
//      reported as "not verified" and excluded from the score rather than
//      silently scored as zero.
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
    return { possible, earned: 0, evidence, findings, recommendations }
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
  }

  return { possible, earned, evidence, findings, recommendations }
}

// --- Check 2: content freshness (sitemap lastmod + blog datePublished) ---
async function checkFreshness(sitemapUrl, blogUrl, fetcher, { now = new Date() } = {}) {
  const possible = 30
  const evidence = []
  const findings = []
  const recommendations = []

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
    return { possible, earned: 0, evidence, findings, recommendations }
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
  } else if (daysSince > 180) {
    findings.push(`Most recent detectable content update was ${daysSince} days ago — cadence has slowed.`)
    recommendations.push('Publish more regularly; aim for at least quarterly updates to demonstrate an active site.')
  }

  return { possible, earned, evidence, findings, recommendations }
}

// --- Check 3: referring domains (requires a backlink data API) ---
async function checkReferringDomains(domain, fetcher, backlinkApiKey) {
  const possible = 40
  const evidence = []
  const findings = []
  const recommendations = []

  if (!backlinkApiKey) {
    findings.push('Referring domains not verified — no backlink-data API configured (Ahrefs, Moz, SEMrush, or Google Search Console would all work; none is wired up yet).')
    recommendations.push('Pick a backlink data source and get API access configured so this check can run — this is the single biggest unscored chunk of the Content Authority pillar right now.')
    return { possible: 0, earned: 0, evidence, findings, recommendations }
  }

  // Left as an integration point: whichever backlink API gets chosen, it
  // plugs in here. Intentionally not implemented against a specific vendor
  // until that decision is made.
  findings.push('Backlink API key provided, but no vendor integration has been implemented yet.')
  return { possible: 0, earned: 0, evidence, findings, recommendations }
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
  const score = totalPossible > 0 ? Math.round((totalEarned / totalPossible) * 100) : 0

  const evidence = parts.flatMap(p => p.evidence)
  const findings = parts.flatMap(p => p.findings)
  const recommendations = parts.flatMap(p => p.recommendations)

  const unverifiedNote = totalPossible < 100 ? ` (Score reflects ${totalPossible}/100 possible points — the rest could not be verified this run.)` : ''

  return {
    grade: scoreToGrade(score),
    score,
    // See technical-checker.js for why this exists: a score rescaled from
    // an incomplete points pool (e.g. no backlink API configured) should
    // never display identically to a fully-verified grade.
    partial: totalPossible < 100,
    possiblePoints: totalPossible,
    finding: (findings.length > 0 ? findings.join(' ') : 'No content authority issues detected in the checks that ran.') + unverifiedNote,
    recommendation: recommendations.length > 0 ? recommendations.join(' ') : 'No action needed on the checks that ran.',
    evidence,
    _raw: { totalPossible, totalEarned }
  }
}

module.exports = { checkContentAuthority, scoreToGrade, htmlToWordCount }
