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

// checkStatus(part) -> 'pass' | 'partial' | 'not_verified'
// possible === 0 means the check couldn't run at all (e.g. no PageSpeed
// API key) -- that's a data gap, not a failure, and gets its own neutral
// status rather than counting against the site.
function checkStatus({ possible, earned }) {
  if (!possible) return 'not_verified'
  return earned >= possible ? 'pass' : 'partial'
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
  const issues = []

  const httpsRes = await safeFetch(fetcher, httpsUrl)
  if (httpsRes.ok) {
    earned += 10
    evidence.push(`HTTPS reachable (${httpsRes.status}).`)
  } else {
    findings.push('Site is not reachable over HTTPS.')
    recommendations.push('Install/renew an SSL certificate and ensure the site serves over HTTPS.')
    issues.push({
      severity: 'critical',
      message: 'Site is not reachable over HTTPS.',
      why: 'Every major browser actively warns visitors away from insecure sites, and Google won\'t rank an insecure site competitively -- this blocks everything else on this list from mattering.',
      recommendation: 'Install/renew an SSL certificate and ensure the site serves over HTTPS.'
    })
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
    issues.push({
      severity: 'moderate',
      message: 'HTTP does not redirect to HTTPS.',
      why: 'Visitors, bots, or old bookmarked links hitting the plain http:// version get served an unencrypted page instead of being sent to the secure one.',
      recommendation: 'Force an HTTP -> HTTPS redirect at the server/CDN level.'
    })
  }

  return { possible, earned, evidence, findings, recommendations, issues }
}

// --- Check 2 & 3: robots.txt + sitemap.xml ---
async function checkRobotsAndSitemap(url, fetcher) {
  const base = url.replace(/\/$/, '')
  const possible = 25
  let earned = 0
  const evidence = []
  const findings = []
  const recommendations = []
  const issues = []

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
      issues.push({
        severity: 'critical',
        message: 'robots.txt is telling every crawler not to index the site at all (Disallow: / for User-agent: *).',
        why: 'This overrides everything else on this list -- Google, Bing, and AI crawlers are all being told directly not to index this site, regardless of how good the rest of the technical setup is.',
        recommendation: 'Fix robots.txt immediately -- remove the sitewide Disallow.'
      })
    }
  } else {
    findings.push('robots.txt is not reachable.')
    recommendations.push('Add a robots.txt file at the site root.')
    issues.push({
      severity: 'moderate',
      message: 'robots.txt is not reachable.',
      why: 'Crawlers use robots.txt to know what they\'re allowed to index -- without one, behavior is less predictable, though most crawlers default to "allow everything" when it\'s simply missing.',
      recommendation: 'Add a robots.txt file at the site root.'
    })
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
      issues.push({
        severity: 'minor',
        message: 'Sitemap is referenced with an http:// (not https://) URL in robots.txt.',
        why: 'Small inconsistency -- crawlers will typically still follow it, but it\'s worth cleaning up.',
        recommendation: 'Update the Sitemap: line in robots.txt to use https://.'
      })
    }
  } else {
    findings.push('No Sitemap: line found in robots.txt.')
    recommendations.push('Add a Sitemap: line to robots.txt pointing at sitemap.xml.')
    issues.push({
      severity: 'moderate',
      message: 'No Sitemap: line found in robots.txt.',
      why: 'Without this, crawlers have to discover the sitemap on their own (usually at the default /sitemap.xml path) rather than being told exactly where it is.',
      recommendation: 'Add a Sitemap: line to robots.txt pointing at sitemap.xml.'
    })
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
      issues.push({
        severity: 'moderate',
        message: 'sitemap.xml is reachable but does not look like a valid XML sitemap.',
        why: 'An invalid sitemap is functionally the same as having none -- crawlers can\'t parse it, so pages don\'t get the discovery boost a real sitemap provides.',
        recommendation: 'Regenerate the sitemap (most SEO plugins, incl. Yoast, do this automatically) and confirm it validates.'
      })
    }
  } else {
    findings.push('sitemap.xml is not reachable.')
    recommendations.push('Generate and publish a sitemap.xml.')
    issues.push({
      severity: 'moderate',
      message: 'sitemap.xml is not reachable.',
      why: 'Without a sitemap, search engines have to discover pages purely by following links, which is slower and less complete, especially on larger sites.',
      recommendation: 'Generate and publish a sitemap.xml.'
    })
  }

  earned = Math.max(0, earned)
  return { possible, earned, evidence, findings, recommendations, issues }
}

// --- Check 4: broken-link sample crawl ---
async function checkBrokenLinks(url, fetcher, homepageHtml) {
  const possible = 20
  let earned = 0
  const evidence = []
  const findings = []
  const recommendations = []
  const issues = []

  let html = homepageHtml
  if (!html) {
    const res = await safeFetch(fetcher, url)
    if (res.ok) html = await res.res.text()
  }

  if (!html) {
    findings.push('Could not load the homepage to sample internal links.')
    recommendations.push('Confirm the homepage is reachable, then re-run this check.')
    return { possible, earned, evidence, findings, recommendations, issues }
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
    return { possible, earned, evidence, findings, recommendations, issues }
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
    issues.push({
      severity: broken.length >= 3 ? 'critical' : 'moderate',
      message: `${broken.length} broken internal link(s) found: ${broken.map(b => `${b.link} (${b.status || 'unreachable'})`).slice(0, 5).join(', ')}.`,
      why: 'Broken internal links waste crawl budget, create dead ends for visitors, and are one of the easiest "site quality" signals for Google to notice.',
      recommendation: 'Fix or remove the broken links listed above.'
    })
  }

  return { possible, earned, evidence, findings, recommendations, issues }
}

// sanitizeAuditDescription(text) -> string
// Lighthouse audit descriptions are genuinely well-written plain-English
// explanations (Google authors them for exactly this purpose) -- reusing
// them as the "why this matters" text means real explanatory copy per
// audit without hand-maintaining one for every possible Lighthouse check.
// They do carry markdown links (e.g. "[Learn more](https://...)"), which
// read as raw noise outside an actual markdown renderer, so those get
// stripped down to just the link text.
function sanitizeAuditDescription(text) {
  if (!text) return null
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
}

// A handful of Lighthouse audit titles already end in a period (e.g.
// "...contrast ratio."); appending another one for message punctuation
// would double it up.
function stripTrailingPeriod(s) {
  return s.replace(/\.+$/, '')
}

// collectPerformanceOpportunities(lhr) -> [{title, savingsMs, why}]
// Lighthouse's own "opportunity" audits (render-blocking resources,
// unused JS/CSS, unoptimized images, etc.) already carry an estimated
// millisecond savings per fix -- pulling these out by name is strictly
// better than a generic "review opportunities" pointer, which told a
// strategist nothing they couldn't already see by opening PageSpeed
// Insights themselves.
function collectPerformanceOpportunities(lhr, { max = 4 } = {}) {
  const auditRefs = lhr.categories?.performance?.auditRefs || []
  const opportunities = []
  for (const ref of auditRefs) {
    const audit = lhr.audits?.[ref.id]
    const savingsMs = audit?.details?.type === 'opportunity' ? audit.details.overallSavingsMs : null
    if (!audit || typeof savingsMs !== 'number' || savingsMs < 50) continue
    opportunities.push({ title: audit.title, savingsMs: Math.round(savingsMs), why: sanitizeAuditDescription(audit.description) })
  }
  return opportunities.sort((a, b) => b.savingsMs - a.savingsMs).slice(0, max)
}

// collectFailingAudits(lhr, categoryId) -> [{title, weight, why}]
// Same idea for SEO/Accessibility/Best Practices: name the specific
// audits actually failing in that category (weighted by how much each one
// counts toward the category score), not just "the score is low."
function collectFailingAudits(lhr, categoryId, { max = 4 } = {}) {
  const auditRefs = (lhr.categories?.[categoryId]?.auditRefs || []).filter(r => r.weight > 0)
  const failing = []
  for (const ref of auditRefs) {
    const audit = lhr.audits?.[ref.id]
    if (!audit || typeof audit.score !== 'number' || audit.score >= 0.9) continue
    failing.push({ title: audit.title, weight: ref.weight, why: sanitizeAuditDescription(audit.description) })
  }
  return failing.sort((a, b) => b.weight - a.weight).slice(0, max)
}

// describePsiFailure(res) -> { message, domain, status }
// safeFetch's failure branch only ever exposed the bare HTTP status code
// ("PageSpeed Insights request failed (500)") -- real, useless-in-practice
// information: a 500 from this specific endpoint means something very
// different from a 400/403/429, and a client reading "(500)" alone has no
// way to tell "your API key is wrong" apart from "Google's own Lighthouse
// run crashed on this page, unrelated to your setup." Google's error body
// for this API follows the standard googleapis shape --
// { error: { message, errors: [{ domain, reason }] } } -- and specifically
// tags Lighthouse-side failures with errors[].domain === 'lighthouse'
// (verified against documented PSI failure reports; auth/quota failures use
// 'global'/'usageLimits' instead). Reading that lets the report tell a
// strategist which kind of failure this actually is instead of leaving them
// to guess whether their own API key setup is the problem.
async function describePsiFailure(res) {
  let message = res.error || `HTTP ${res.status}`
  let domain = null
  if (res.res) {
    try {
      const body = await res.res.json()
      if (body?.error?.message) message = body.error.message
      domain = body?.error?.errors?.[0]?.domain || null
    } catch (e) {
      // Body wasn't JSON, or couldn't be read -- fall back to the bare
      // status/error already captured above rather than failing this check
      // a second way.
    }
  }
  return { message, domain, status: res.status }
}

// --- Checks 5 & 6: PageSpeed Insights (Core Web Vitals + category scores) ---
async function checkPageSpeed(url, fetcher, apiKey) {
  const cwvPossible = 25
  const categoryPossible = 15
  const evidence = []
  const findings = []
  const recommendations = []
  const issues = []

  if (!apiKey) {
    findings.push('Core Web Vitals and PageSpeed category scores not verified — no PageSpeed Insights API key configured. (Google\'s anonymous PSI quota is 0 requests/day; a free Google Cloud API key with the PageSpeed Insights API enabled is required.)')
    recommendations.push('Set up a PageSpeed Insights API key (free, Google Cloud Console → enable "PageSpeed Insights API" → create an API key) so this check can run.')
    issues.push({
      severity: 'info',
      message: 'Core Web Vitals and PageSpeed category scores not verified.',
      why: 'No PageSpeed Insights API key is configured -- this is a data gap, not a finding about the site itself.',
      recommendation: 'Set up a PageSpeed Insights API key (free, Google Cloud Console -> enable "PageSpeed Insights API" -> create an API key) so this check can run.'
    })
    return { cwv: { possible: 0, earned: 0 }, category: { possible: 0, earned: 0 }, evidence, findings, recommendations, issues }
  }

  const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=performance&category=seo&category=accessibility&category=best-practices&strategy=mobile&key=${apiKey}`
  const res = await safeFetch(fetcher, psiUrl)
  if (!res.ok) {
    const failure = await describePsiFailure(res)
    // errors[].domain === 'lighthouse' means Google's OWN Lighthouse run
    // failed server-side for this specific page (page load/render crash,
    // out-of-memory on a heavy page, an internal timeout) -- a 500 of this
    // kind is a known, often-transient PSI behavior, not a sign the API
    // key/setup is wrong. Auth/quota failures come back tagged 'global' or
    // 'usageLimits' instead, and still get pointed at the key/setup as
    // before.
    const isLighthouseSideFailure = failure.domain === 'lighthouse'
    // Google's own error messages usually already end in a period --
    // stripTrailingPeriod (same helper used for Lighthouse audit titles
    // below) avoids the same double-period cosmetic bug fixed there.
    const detail = failure.message && failure.message !== `HTTP ${failure.status}` ? `: ${stripTrailingPeriod(failure.message)}` : ''
    const guidance = isLighthouseSideFailure
      ? 'This is Google\'s own Lighthouse run failing server-side for this specific page (not an API key or quota problem) -- often transient. Re-run the audit; if it keeps failing, test the same URL directly at pagespeed.web.dev to confirm Google reproduces the same failure outside this tool.'
      : 'Confirm the API key is valid and the PageSpeed Insights API is enabled, then re-run.'

    findings.push(`PageSpeed Insights request failed (${failure.status || 'network error'})${detail}.`)
    recommendations.push(guidance)
    issues.push({
      severity: 'info',
      message: `PageSpeed Insights request failed (${failure.status || 'network error'})${detail}.`,
      why: 'A failed API call is a data gap, not a finding about the site itself.' + (isLighthouseSideFailure ? ' Specifically, this is Google\'s Lighthouse run failing on their end for this page, not an API key or quota issue.' : ''),
      recommendation: guidance
    })
    return { cwv: { possible: cwvPossible, earned: 0 }, category: { possible: categoryPossible, earned: 0 }, evidence, findings, recommendations, issues }
  }

  const data = await res.res.json()
  const lhr = data.lighthouseResult
  if (!lhr) {
    findings.push('PageSpeed Insights returned no Lighthouse result.')
    return { cwv: { possible: cwvPossible, earned: 0 }, category: { possible: categoryPossible, earned: 0 }, evidence, findings, recommendations, issues }
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

  const opportunities = collectPerformanceOpportunities(lhr)
  if (opportunities.length > 0) {
    evidence.push(`Top Performance opportunities, by estimated savings: ${opportunities.map(o => `${o.title} (~${o.savingsMs}ms)`).join('; ')}.`)
  }

  if (perfScore < 50) {
    findings.push(`Performance score is poor (${perfScore}/100).`)
    recommendations.push(opportunities.length > 0
      ? `Fix these first, ranked by estimated impact: ${opportunities.map(o => o.title).join('; ')}.`
      : 'Address the top Lighthouse opportunities (usually image optimization, render-blocking resources, and server response time).')
  } else if (perfScore < 90) {
    findings.push(`Performance score is mediocre (${perfScore}/100) — room to improve Core Web Vitals.`)
    recommendations.push(opportunities.length > 0
      ? `Fix these first, ranked by estimated impact: ${opportunities.map(o => o.title).join('; ')}.`
      : 'Review Lighthouse opportunities for the biggest remaining wins.')
  }

  // Severity by estimated impact: >=1000ms of savings is a real, felt slice
  // of load time; <300ms is real but minor. This is a first-pass band, same
  // spirit as the thresholds elsewhere in this codebase (checkWordCount,
  // checkFreshness) -- reasonable to start, easy to retune later.
  opportunities.forEach(o => {
    issues.push({
      severity: o.savingsMs >= 1000 ? 'critical' : o.savingsMs >= 300 ? 'moderate' : 'minor',
      message: `${o.title} (potential savings: ~${o.savingsMs}ms).`,
      why: o.why || 'A Lighthouse performance opportunity with measurable estimated savings.',
      recommendation: `Address "${o.title}" -- see PageSpeed Insights for this URL for the exact resources/elements involved.`
    })
  })

  const seoScore = Math.round((lhr.categories.seo?.score || 0) * 100)
  const a11yScore = Math.round((lhr.categories.accessibility?.score || 0) * 100)
  const bpScore = Math.round((lhr.categories['best-practices']?.score || 0) * 100)
  const avgCategory = Math.round((seoScore + a11yScore + bpScore) / 3)
  const categoryEarned = Math.round((avgCategory / 100) * categoryPossible)
  evidence.push(`Lighthouse SEO: ${seoScore}, Accessibility: ${a11yScore}, Best Practices: ${bpScore}.`)

  const failingAudits = [
    ...collectFailingAudits(lhr, 'seo').map(f => ({ ...f, category: 'SEO' })),
    ...collectFailingAudits(lhr, 'accessibility').map(f => ({ ...f, category: 'Accessibility' })),
    ...collectFailingAudits(lhr, 'best-practices').map(f => ({ ...f, category: 'Best Practices' }))
  ].sort((a, b) => b.weight - a.weight)
  if (failingAudits.length > 0) {
    evidence.push(`Specific failing audits, by category: ${failingAudits.map(f => `${f.category}: ${f.title}`).join('; ')}.`)
  }

  if (avgCategory < 80) {
    findings.push('SEO/Accessibility/Best Practices Lighthouse scores have room to improve.')
    recommendations.push(failingAudits.length > 0
      ? `Fix these specific audits, ranked by how much each counts toward its category score: ${failingAudits.map(f => `${f.category}: ${f.title}`).join('; ')}.`
      : 'Review the specific failing Lighthouse audits in each category for concrete fixes.')
  }

  // Severity by how much the audit counts toward its category score
  // (Lighthouse's own `weight`) -- a high-weight failure like missing
  // alt text or poor color contrast genuinely hurts real users and the
  // score; a weight-0/near-0 audit is closer to informational.
  failingAudits.forEach(f => {
    issues.push({
      severity: f.weight >= 7 ? 'critical' : f.weight >= 3 ? 'moderate' : 'minor',
      message: `${f.category}: ${stripTrailingPeriod(f.title)}.`,
      why: f.why || `A ${f.category} audit Lighthouse flagged as failing.`,
      recommendation: `Address "${f.title}" -- see PageSpeed Insights for this URL for the exact elements involved.`
    })
  })

  return {
    cwv: { possible: cwvPossible, earned: cwvEarned },
    category: { possible: categoryPossible, earned: categoryEarned },
    evidence, findings, recommendations, issues
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
  // Graded on the full 100-point scale, not rescaled to whatever subset of
  // checks actually ran -- a site that earns every point on 60/100
  // possible checks gets 60, not 100. Rescaling was producing an A+ for a
  // run that only verified 60% of the pillar, which is the same mistake as
  // a school test: getting 60/60 attempted questions right is not a 100,
  // it's a 60, because 40 questions were never answered.
  const score = totalEarned

  const checks = [
    { label: 'HTTPS served + HTTP redirects to it', status: checkStatus(httpsResult) },
    { label: 'robots.txt + sitemap.xml reachable & valid', status: checkStatus(robotsResult) },
    { label: 'No broken internal links (sample)', status: checkStatus(brokenLinksResult) },
    { label: 'Core Web Vitals (PageSpeed Insights)', status: checkStatus(psiResult.cwv) },
    { label: 'Lighthouse SEO / Accessibility / Best Practices', status: checkStatus(psiResult.category) }
  ]

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
  const SEVERITY_RANK = { critical: 0, moderate: 1, minor: 2, info: 3 }
  const issues = [
    ...httpsResult.issues,
    ...robotsResult.issues,
    ...brokenLinksResult.issues,
    ...psiResult.issues
  ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

  const unverifiedNote = totalPossible < 100 ? ` (Only ${totalPossible}/100 possible points could be verified this run -- the other ${100 - totalPossible} count as not-yet-earned toward the grade, not skipped.)` : ''

  return {
    grade: scoreToGrade(score),
    score,
    // A grade computed from an incomplete points pool (missing PSI key,
    // etc.) should never render identically to a fully-verified grade --
    // the dashboard uses this flag to show a "partial" badge rather than
    // letting an incomplete run look like a clean, fully-checked grade.
    partial: totalPossible < 100,
    possiblePoints: totalPossible,
    finding: (findings.length > 0 ? findings.join(' ') : 'No technical issues detected in the checks that ran.') + unverifiedNote,
    recommendation: recommendations.length > 0 ? recommendations.join(' ') : 'No action needed on the checks that ran.',
    evidence,
    checks,
    issues,
    _raw: { totalPossible, totalEarned }
  }
}

module.exports = { checkTechnicalFoundation, scoreToGrade }
