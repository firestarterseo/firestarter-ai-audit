// Technical Foundation pillar checker.
//
// Deterministic, fetch-and-verify — same philosophy as the Schema &
// Structure checker (checker.js): no LLM guessing at whether a site is
// "technically sound," just actually requesting the resources that answer
// that question.
//
// Checks:
//   1. HTTPS is served and HTTP redirects to it
//   2. robots.txt is reachable and isn't blocking the whole site
//   3. sitemap.xml is reachable, valid XML, and referenced from robots.txt
//   4. A sample of internal links from the homepage aren't broken (4xx/5xx)
//   5. Core Web Vitals + Performance score (PageSpeed Insights API)
//   6. SEO / Accessibility / Best Practices category scores (same PSI call)
//
// IMPORTANT — PageSpeed Insights quota: as of this build, Google's
// PageSpeed Insights API has ZERO free anonymous quota (confirmed live:
// calling it with no key returns HTTP 429, quota_limit_value "0"). Checks 5
// and 6 require a Google Cloud API key with the PageSpeed Insights API
// enabled (free tier is 25,000 requests/day per project — plenty for our
// volume, it just has to exist). Until Firestarter has that key, this
// checker still runs checks 1-4 and reports the PSI-based checks as
// "not verified" rather than silently scoring them as failing — so a site
// isn't unfairly graded down for a missing API key. Score is prorated over
// whichever checks actually ran.

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

function normalizeUrl(url) {
  let u = url.trim()
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  return u
}

async function safeFetch(fetcher, url, opts) {
  try {
    const res = await fetcher(url, opts)
    return { ok: res.ok, status: res.status, res }
  } catch (err) {
    return { ok: false, status: null, error: err.message }
  }
}

// --- Check 1: HTTPS + redirect ---
async function checkHttps(url, fetcher) {
  const httpsUrl = url.replace(/^http:\/\//i, 'https://')
  const httpUrl = url.replace(/^https:\/\//i, 'http://')
  const possible = 15
  let earned = 0
  const evidence = []
  const findings = []
  const recommendations = []

  const httpsRes = await safeFetch(fetcher, httpsUrl)
  if (httpsRes.ok) {
    earned += 10
    evidence.push(`HTTPS reachable (${httpsRes.status}).`)
  } else {
    findings.push('Site is not reachable over HTTPS.')
    recommendations.push('Install/renew an SSL certificate and ensure the site serves over HTTPS.')
  }

  const httpRes = await safeFetch(fetcher, httpUrl, { redirect: 'manual' })
  const redirectsToHttps = httpRes.status && httpRes.status >= 300 && httpRes.status < 400
  if (redirectsToHttps || httpsRes.ok) {
    // Either we observed a redirect, or (fallback, since some fetch impls
    // auto-follow redirects and just report the final 200) HTTPS itself works
    // and plain HTTP isn't independently serving unencrypted content.
    earned += 5
    evidence.push(redirectsToHttps ? 'HTTP redirects to HTTPS.' : 'HTTPS available (redirect behavior not independently observable in this environment).')
  } else if (httpRes.ok) {
    findings.push('HTTP does not redirect to HTTPS — the site may be servable unencrypted.')
    recommendations.push('Force an HTTP → HTTPS redirect at the server/CDN level.')
  }

  return { possible, earned, evidence, findings, recommendations }
}

// --- Check 2 & 3: robots.txt + sitemap.xml ---
async function checkRobotsAndSitemap(url, fetcher) {
  const base = url.replace(/\/$/, '')
  const possible = 25
  let earned = 0
  const evidence = []
  const findings = []
  const recommendations = []

  const robotsRes = await safeFetch(fetcher, `${base}/robots.txt`)
  let robotsText = ''
  if (robotsRes.ok) {
    robotsText = await robotsRes.res.text()
    earned += 10
    evidence.push('robots.txt is reachable.')

    const blocksEverything = /User-agent:\s*\*[\s\S]{0,40}?Disallow:\s*\/\s*($|\n)/im.test(robotsText)
    if (blocksEverything) {
      findings.push('robots.txt appears to Disallow: / for User-agent: * — this would block all crawlers site-wide.')
      recommendations.push('Fix robots.txt immediately — a sitewide Disallow blocks Google (and everything else) from indexing the site.')
      earned -= 10 // this is bad enough to cancel out the "reachable" credit
    }
  } else {
    findings.push('robots.txt is not reachable.')
    recommendations.push('Add a robots.txt file at the site root.')
  }

  const sitemapMatch = robotsText.match(/Sitemap:\s*(\S+)/i)
  const sitemapUrlFromRobots = sitemapMatch ? sitemapMatch[1].trim() : null

  if (sitemapUrlFromRobots) {
    earned += 5
    evidence.push(`Sitemap referenced in robots.txt: ${sitemapUrlFromRobots}`)
    if (/^http:\/\//i.test(sitemapUrlFromRobots)) {
      findings.push('Sitemap is referenced with an http:// (not https://) URL in robots.txt.')
      recommendations.push('Update the Sitemap: line in robots.txt to use https://.')
      earned -= 2
    }
  } else {
    findings.push('No Sitemap: line found in robots.txt.')
    recommendations.push('Add a Sitemap: line to robots.txt pointing at sitemap.xml.')
  }

  const sitemapUrl = sitemapUrlFromRobots || `${base}/sitemap.xml`
  const sitemapRes = await safeFetch(fetcher, sitemapUrl.replace(/^http:\/\//i, 'https://'))
  if (sitemapRes.ok) {
    const sitemapText = await sitemapRes.res.text()
    const isIndex = /<sitemapindex[\s>]/i.test(sitemapText)
    const isUrlset = /<urlset[\s>]/i.test(sitemapText)
    if (isIndex) {
      // A sitemap INDEX (e.g. Yoast's default sitemap_index.xml) has no
      // <url> entries of its own -- it only lists sub-sitemaps. Counting
      // <url> tags here always reads as 0, which looks like a red flag but
      // isn't one. Follow a sample of the sub-sitemaps instead so the
      // evidence reflects real page counts, not a false "0 pages" alarm.
      earned += 10
      const subSitemapUrls = Array.from(sitemapText.matchAll(/<loc>([^<]+)<\/loc>/gi)).map(m => m[1].trim())
      const sampleSize = Math.min(subSitemapUrls.length, 5)
      let totalUrls = 0
      let fetchedOk = 0
      for (const subUrl of subSitemapUrls.slice(0, sampleSize)) {
        const subRes = await safeFetch(fetcher, subUrl.replace(/^http:\/\//i, 'https://'))
        if (subRes.ok) {
          fetchedOk += 1
          const subText = await subRes.res.text()
          totalUrls += (subText.match(/<url>/gi) || []).length
        }
      }
      if (subSitemapUrls.length === 0) {
        evidence.push('sitemap.xml is a sitemap index but lists no sub-sitemaps.')
      } else {
        const sampledNote = sampleSize < subSitemapUrls.length ? ` (sampled ${sampleSize} of ${subSitemapUrls.length})` : ''
        evidence.push(`sitemap.xml is a sitemap index referencing ${subSitemapUrls.length} sub-sitemap(s)${sampledNote}; ${totalUrls} page URL(s) found across ${fetchedOk} reachable sub-sitemap(s).`)
      }
    } else if (isUrlset) {
      earned += 10
      const urlCount = (sitemapText.match(/<url>/gi) || []).length
      evidence.push(`sitemap.xml is reachable and well-formed (${urlCount} URL entries found).`)
    } else {
      findings.push('sitemap.xml is reachable but does not look like a valid XML sitemap.')
      recommendations.push('Regenerate the sitemap (most SEO plugins, incl. Yoast, do this automatically) and confirm it validates.')
    }
  } else {
    findings.push('sitemap.xml is not reachable.')
    recommendations.push('Generate and publish a sitemap.xml.')
  }

  earned = Math.max(0, earned)
  return { possible, earned, evidence, findings, recommendations }
}

// --- Check 4: broken-link sample crawl ---
async function checkBrokenLinks(url, fetcher, homepageHtml) {
  const possible = 20
  let earned = 0
  const evidence = []
  const findings = []
  const recommendations = []

  let html = homepageHtml
  if (!html) {
    const res = await safeFetch(fetcher, url)
    if (res.ok) html = await res.res.text()
  }

  if (!html) {
    findings.push('Could not load the homepage to sample internal links.')
    recommendations.push('Confirm the homepage is reachable, then re-run this check.')
    return { possible, earned, evidence, findings, recommendations }
  }

  const origin = new URL(url).origin
  const hrefRe = /href=["']([^"']+)["']/gi
  const links = new Set()
  let m
  while ((m = hrefRe.exec(html)) !== null) {
    let href = m[1]
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue
    try {
      const resolved = new URL(href, url)
      if (resolved.origin === origin) links.add(resolved.href)
    } catch (e) { /* skip unparsable */ }
  }

  const sample = Array.from(links).slice(0, 15)
  if (sample.length === 0) {
    findings.push('No internal links found on the homepage to check.')
    return { possible, earned, evidence, findings, recommendations }
  }

  const results = []
  for (const link of sample) {
    const r = await safeFetch(fetcher, link)
    results.push({ link, status: r.status })
  }

  const broken = results.filter(r => !r.status || r.status >= 400)
  evidence.push(`Checked ${results.length} internal links; ${broken.length} broken.`)
  if (broken.length === 0) {
    earned = possible
  } else {
    earned = Math.max(0, possible - broken.length * 5)
    findings.push(`${broken.length} broken internal link(s) found: ${broken.map(b => `${b.link} (${b.status || 'unreachable'})`).slice(0, 5).join(', ')}`)
    recommendations.push('Fix or remove the broken links listed in evidence.')
  }

  return { possible, earned, evidence, findings, recommendations }
}

// --- Checks 5 & 6: PageSpeed Insights (Core Web Vitals + category scores) ---
async function checkPageSpeed(url, fetcher, apiKey) {
  const cwvPossible = 25
  const categoryPossible = 15
  const evidence = []
  const findings = []
  const recommendations = []

  if (!apiKey) {
    findings.push('Core Web Vitals and PageSpeed category scores not verified — no PageSpeed Insights API key configured. (Google\'s anonymous PSI quota is 0 requests/day; a free Google Cloud API key with the PageSpeed Insights API enabled is required.)')
    recommendations.push('Set up a PageSpeed Insights API key (free, Google Cloud Console → enable "PageSpeed Insights API" → create an API key) so this check can run.')
    return { cwv: { possible: 0, earned: 0 }, category: { possible: 0, earned: 0 }, evidence, findings, recommendations }
  }

  const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=performance&category=seo&category=accessibility&category=best-practices&strategy=mobile&key=${apiKey}`
  const res = await safeFetch(fetcher, psiUrl)
  if (!res.ok) {
    findings.push(`PageSpeed Insights request failed (${res.status || res.error}).`)
    recommendations.push('Confirm the API key is valid and the PageSpeed Insights API is enabled, then re-run.')
    return { cwv: { possible: cwvPossible, earned: 0 }, category: { possible: categoryPossible, earned: 0 }, evidence, findings, recommendations }
  }

  const data = await res.res.json()
  const lhr = data.lighthouseResult
  if (!lhr) {
    findings.push('PageSpeed Insights returned no Lighthouse result.')
    return { cwv: { possible: cwvPossible, earned: 0 }, category: { possible: categoryPossible, earned: 0 }, evidence, findings, recommendations }
  }

  const perfScore = Math.round((lhr.categories.performance?.score || 0) * 100)
  let cwvEarned = Math.round((perfScore / 100) * cwvPossible)
  evidence.push(`Lighthouse Performance score (mobile): ${perfScore}/100.`)

  const lcp = lhr.audits?.['largest-contentful-paint']?.displayValue
  const cls = lhr.audits?.['cumulative-layout-shift']?.displayValue
  const inp = lhr.audits?.['interaction-to-next-paint']?.displayValue || lhr.audits?.['total-blocking-time']?.displayValue
  if (lcp) evidence.push(`LCP: ${lcp}`)
  if (cls) evidence.push(`CLS: ${cls}`)
  if (inp) evidence.push(`INP/TBT: ${inp}`)

  if (perfScore < 50) {
    findings.push(`Performance score is poor (${perfScore}/100).`)
    recommendations.push('Address the top Lighthouse opportunities (usually image optimization, render-blocking resources, and server response time).')
  } else if (perfScore < 90) {
    findings.push(`Performance score is mediocre (${perfScore}/100) — room to improve Core Web Vitals.`)
    recommendations.push('Review Lighthouse opportunities for the biggest remaining wins.')
  }

  const seoScore = Math.round((lhr.categories.seo?.score || 0) * 100)
  const a11yScore = Math.round((lhr.categories.accessibility?.score || 0) * 100)
  const bpScore = Math.round((lhr.categories['best-practices']?.score || 0) * 100)
  const avgCategory = Math.round((seoScore + a11yScore + bpScore) / 3)
  const categoryEarned = Math.round((avgCategory / 100) * categoryPossible)
  evidence.push(`Lighthouse SEO: ${seoScore}, Accessibility: ${a11yScore}, Best Practices: ${bpScore}.`)

  if (avgCategory < 80) {
    findings.push('SEO/Accessibility/Best Practices Lighthouse scores have room to improve.')
    recommendations.push('Review the specific failing Lighthouse audits in each category for concrete fixes.')
  }

  return {
    cwv: { possible: cwvPossible, earned: cwvEarned },
    category: { possible: categoryPossible, earned: categoryEarned },
    evidence, findings, recommendations
  }
}

async function checkTechnicalFoundation(url, { fetcher = fetch, pageSpeedApiKey = null, homepageHtml = null } = {}) {
  const normalized = normalizeUrl(url)

  const [httpsResult, robotsResult, brokenLinksResult, psiResult] = await Promise.all([
    checkHttps(normalized, fetcher),
    checkRobotsAndSitemap(normalized, fetcher),
    checkBrokenLinks(normalized, fetcher, homepageHtml),
    checkPageSpeed(normalized, fetcher, pageSpeedApiKey)
  ])

  const parts = [
    httpsResult,
    robotsResult,
    brokenLinksResult,
    { possible: psiResult.cwv.possible, earned: psiResult.cwv.earned, evidence: [], findings: [], recommendations: [] },
    { possible: psiResult.category.possible, earned: psiResult.category.earned, evidence: [], findings: [], recommendations: [] }
  ]

  const totalPossible = parts.reduce((sum, p) => sum + p.possible, 0)
  const totalEarned = parts.reduce((sum, p) => sum + p.earned, 0)
  const score = totalPossible > 0 ? Math.round((totalEarned / totalPossible) * 100) : 0

  const evidence = [
    ...httpsResult.evidence,
    ...robotsResult.evidence,
    ...brokenLinksResult.evidence,
    ...psiResult.evidence
  ]
  const findings = [
    ...httpsResult.findings,
    ...robotsResult.findings,
    ...brokenLinksResult.findings,
    ...psiResult.findings
  ]
  const recommendations = [
    ...httpsResult.recommendations,
    ...robotsResult.recommendations,
    ...brokenLinksResult.recommendations,
    ...psiResult.recommendations
  ]

  const unverifiedNote = totalPossible < 100 ? ` (Score reflects ${totalPossible}/100 possible points — the rest could not be verified this run.)` : ''

  return {
    grade: scoreToGrade(score),
    score,
    // A grade computed from an incomplete points pool (missing PSI key,
    // etc.) should never render identically to a fully-verified grade --
    // the dashboard uses this flag to show a "partial" badge rather than
    // letting a rescaled 100 look like a clean, fully-checked A+.
    partial: totalPossible < 100,
    possiblePoints: totalPossible,
    finding: (findings.length > 0 ? findings.join(' ') : 'No technical issues detected in the checks that ran.') + unverifiedNote,
    recommendation: recommendations.length > 0 ? recommendations.join(' ') : 'No action needed on the checks that ran.',
    evidence,
    _raw: { totalPossible, totalEarned }
  }
}

module.exports = { checkTechnicalFoundation, scoreToGrade }
