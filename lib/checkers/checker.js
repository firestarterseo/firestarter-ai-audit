// Schema & Structure pillar checker.
//
// Fully deterministic: no LLM, no web_search budget, no variance between
// runs, and — as of this version — zero external dependencies. Given raw
// HTML or a URL, it:
//   1. Extracts and parses JSON-LD (flattening @graph blocks, which is how
//      Yoast, our most common client plugin, ships its default schema)
//   2. Scores specific, business-relevant checks that map to what actually
//      matters for local-business AI/Google visibility in 2026
//   3. Returns the shared pillar output contract:
//        { grade, score, finding, recommendation, evidence }
//
// This replaces the "ask Claude to look at the page and guess" approach that
// produced 0% detected improvement for Denver Tax Advisor despite a verified,
// valid, live AccountingService schema being present. It also replaces an
// earlier version of this file that depended on `structured-data-testing-tool`
// (which pulled in cheerio/web-auto-extractor/validator/nth-check/lodash.pick
// — 7 high-severity npm audit findings between them, for HTML/microdata/RDFa
// parsing capability we never actually use in practice).

const { parseJsonLd } = require('./lightweight-jsonld')
const { BUSINESS_ENTITY_TYPES } = require('../businessEntityTypes')
// Phase 2A (2026-09-01): both real fetches this file performs (the sitemap
// fetch below, and resolveHtml's URL-fetch branch, which is confirmed dead
// code in production -- every real caller here always passes pre-fetched
// HTML, never a raw URL) now go through the shared lib/webPageFetch.js
// primitive instead of a bare fetch() call. headers: {} is passed
// explicitly at each call site to preserve this file's exact prior request
// shape (no custom headers were sent before this migration) rather than
// picking up lib/webPageFetch.js's own default User-Agent.
const { fetchWebPage } = require('../webPageFetch')

function normalizeUrl(url) {
  let u = url.trim()
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  return u.replace(/\/$/, '')
}

// MAX_SITEMAP_PAGES_LISTED -- cap on how many real sitemap URLs get
// persisted for the Page coverage step's list (2026-08-17). This project's
// sitemaps can run into the hundreds/thousands of URLs; persisting every
// single one to pillar_scores for a step that only lists a handful is
// wasted storage for no benefit -- capped the same way keywordOpportunities
// and other "specific examples, not the whole dataset" lists already are
// elsewhere in this project.
const MAX_SITEMAP_PAGES_LISTED = 20

// classifySitemapPath(path) -> 'Home' | 'Article' | 'Contact' | 'Uncategorized'
// Cheap, real URL-pattern classification -- same "type-badge" categories
// workflow-mockup.html's #pane-schema Page coverage step uses, just derived
// from the actual sitemap URL instead of a fabricated example. This is
// intentionally coarse (it classifies what KIND of page it looks like, not
// whether it has valid schema -- this checker still only actually SCORES
// the homepage) -- see this file's header and SchemaWizard.js's own comment
// on why per-page schema scoring itself isn't real yet.
function classifySitemapPath(path) {
  if (path === '/' || path === '') return 'Home'
  if (/\/(blog|article|articles|news|post|posts)\//i.test(path) || /\/(blog|articles|news)$/i.test(path)) return 'Article'
  if (/contact/i.test(path)) return 'Contact'
  return 'Uncategorized'
}

// countSitemapPages(url, fetcher) -> Promise<{ count: number, pages: Array<{path, type}> } | null>
// Purely additive, non-scored signal (2026-08-16, extended 2026-08-17) --
// added specifically to make the Diagnosis step's "Site-wide" stat pill
// (see workflow-mockup.html's #pane-schema, stat-pill data-pill="sitewide")
// a real number instead of the illustrative "5 pages" the mockup shows, and
// extended so the Page coverage step (step 2) can list real page paths
// instead of either the mockup's 4 fabricated example rows or a single
// homepage-only row. technical-checker.js already fetches sitemap.xml for
// its own robots/sitemap check -- this is the same fetch, just also parsed
// here, since Schema & Structure needed its own real page list and
// re-fetching a small XML file is cheap. NEVER affects score/grade (same
// "additive evidence, not a scored check" convention as content-checker.js's
// competitor gap analysis) -- returns null (not a zero-length result) on
// any failure, so the UI can tell "confirmed zero pages" apart from
// "couldn't check," same "data gap, not a finding" contract as everywhere
// else in this project. Only classifies WHAT KIND of page each real URL
// looks like (Home/Article/Contact/Uncategorized) -- it does NOT claim to
// know whether that page's own schema passes or fails; only the homepage is
// actually run through this checker's 7 checks today.
async function countSitemapPages(url, fetcher = fetch) {
  if (!url) return null
  try {
    const result = await fetchWebPage(`${normalizeUrl(url)}/sitemap.xml`, { fetcher, headers: {} })
    if (result.fetchState !== 'success') return null
    const text = result.html
    // Matches both a plain <urlset> sitemap's <loc> entries and a sitemap
    // INDEX's own <loc> entries (a client with a sitemap index rather than
    // one flat file still gets a real, if less precise, count -- the
    // number of sub-sitemaps rather than pages -- rather than silently
    // returning null for what's actually a very common real setup).
    const locMatches = [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1])
    if (locMatches.length === 0) return null

    const base = normalizeUrl(url)
    const pages = locMatches.slice(0, MAX_SITEMAP_PAGES_LISTED).map(loc => {
      let path
      try {
        path = new URL(loc).pathname || '/'
      } catch (e) {
        path = loc.replace(base, '') || '/'
      }
      return { path, type: classifySitemapPath(path) }
    })

    return { count: locMatches.length, pages }
  } catch (e) {
    return null
  }
}

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

// resolveHtml(htmlOrUrl, fetcher) -- the URL-fetch branch here is confirmed
// dead code in production (grep across the repo: checkSchemaAndStructure is
// only ever called with pre-fetched HTML, never a raw URL, from
// lib/runAudit.js, lib/schemaGenerator.js, and lib/checkers/scripts/
// run-test.js). Migrated to lib/webPageFetch.js anyway for consistency and
// because a future direct-URL caller would otherwise inherit the old
// unbounded, no-timeout raw fetch() -- the error shape callers already
// depend on (a thrown Error with .type = 'FETCH_FAILED' and a
// "Fetch failed: HTTP <status>" message when an HTTP status is known) is
// preserved exactly; a network-level failure (no HTTP status at all) falls
// back to the underlying fetch error's own message, same as before.
async function resolveHtml(htmlOrUrl, fetcher = fetch) {
  const trimmed = htmlOrUrl.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    const result = await fetchWebPage(trimmed, { fetcher, headers: { 'User-Agent': 'FirestarterAIAudit/1.0' } })
    if (result.fetchState !== 'success') {
      const err = new Error(
        result.status != null ? `Fetch failed: HTTP ${result.status}` : (result.failureDetail || `Fetch failed: ${result.failureCategory}`)
      )
      err.type = 'FETCH_FAILED'
      throw err
    }
    return result.html
  }
  return trimmed
}

async function checkSchemaAndStructure(htmlOrUrl, { url = null, fetcher = fetch } = {}) {
  let html
  try {
    html = await resolveHtml(htmlOrUrl)
  } catch (err) {
    return {
      grade: 'F',
      score: 0,
      finding: 'Could not fetch the page to check for structured data.',
      recommendation: 'Confirm the URL is reachable and returns full server-rendered HTML, then re-run.',
      evidence: [`Error: ${err.message}`]
    }
  }

  const { byType, schemaNames, failed } = parseJsonLd(html)

  // Real page count + real page list for the Diagnosis step's "Site-wide"
  // stat pill and the Page coverage step's list -- see countSitemapPages's
  // header comment. `url` is only passed when the caller has it
  // (runAudit.js does); falls back to null (rendered as an honest "not
  // checked" in the UI, never a fake number/list) when it isn't.
  const sitemapResult = await countSitemapPages(url, fetcher)
  const sitemapPageCount = sitemapResult ? sitemapResult.count : null
  const sitemapPages = sitemapResult ? sitemapResult.pages : null

  const evidence = []
  const findings = []
  const recommendations = []
  const checks = []
  // Severity-tagged, plain-English version of the same findings, for the
  // dashboard's grouped Critical/Moderate/Minor view -- this is the
  // primary read now; findings/recommendations above stay as the flat
  // joined-string fallback (still used when issues is empty, i.e. nothing
  // failed).
  const issues = []
  let score = 0

  // --- Check 1: any structured data present at all (20 pts) ---
  if (schemaNames.length > 0) {
    score += 20
    evidence.push(`Structured data found: ${schemaNames.join(', ')}`)
    checks.push({ label: 'Structured data (JSON-LD) present', status: 'pass' })
  } else {
    findings.push('No structured data (JSON-LD) detected on the page at all.')
    recommendations.push('Add baseline JSON-LD: Organization/LocalBusiness + WebSite at minimum.')
    checks.push({ label: 'Structured data (JSON-LD) present', status: 'fail' })
    issues.push({
      severity: 'critical',
      message: 'No structured data (JSON-LD) found on the page at all.',
      why: 'Without any structured data, Google and AI assistants have no reliable way to know what kind of business this is, where it\'s located, or how to contact it -- they\'re left guessing from unstructured page text, which is exactly the kind of ambiguity that causes AI Overviews and chatbots to get local businesses wrong.',
      recommendation: 'Add baseline JSON-LD: Organization/LocalBusiness + WebSite at minimum.'
    })
  }

  // --- Check 2: a real business entity schema, not just WebPage/WebSite boilerplate (20 pts) ---
  const businessEntities = []
  schemaNames.forEach(name => {
    if (BUSINESS_ENTITY_TYPES.includes(name)) {
      businessEntities.push({ name, instances: byType[name] })
    }
  })
  if (businessEntities.length > 0) {
    score += 20
    businessEntities.forEach(e => evidence.push(`Business entity schema present: ${e.name} (${e.instances.length} instance(s))`))
    checks.push({ label: 'Business entity schema (LocalBusiness/Organization)', status: 'pass' })
  } else {
    findings.push('No LocalBusiness/Organization-family schema found — Google and LLMs have no structured entity to anchor to.')
    recommendations.push('Add an Organization or industry-specific LocalBusiness subtype (e.g. AccountingService, Attorney) with name, url, address, telephone.')
    checks.push({ label: 'Business entity schema (LocalBusiness/Organization)', status: 'fail' })
    issues.push({
      severity: 'critical',
      message: 'No LocalBusiness/Organization-style schema found.',
      why: 'This is the single biggest lever for showing up correctly in AI answers and local search -- without it, Google and LLMs have no structured entity to anchor the business to at all.',
      recommendation: 'Add an Organization or industry-specific LocalBusiness subtype (e.g. AccountingService, Attorney) with name, url, address, telephone.'
    })
  }

  // --- Check 3: sameAs entity-disambiguation links (15 pts) ---
  const sameAsFound = businessEntities.some(e => e.instances.some(inst => inst.sameAs))
  if (sameAsFound) {
    score += 15
    evidence.push('sameAs property present, linking the entity to external profiles (Google Business Profile, social, etc.)')
    checks.push({ label: 'sameAs entity-disambiguation links', status: 'pass' })
  } else {
    findings.push('No sameAs links found — the business entity is not explicitly connected to its Google Business Profile / social profiles / Wikidata, which weakens entity disambiguation for LLMs.')
    recommendations.push('Add sameAs: [] with links to Google Business Profile, LinkedIn, Facebook, and any other authoritative profile for the business.')
    checks.push({ label: 'sameAs entity-disambiguation links', status: 'fail' })
    issues.push({
      severity: 'moderate',
      message: 'No sameAs links connecting this schema to Google Business Profile / social profiles.',
      why: 'Without sameAs, Google and AI systems can\'t confidently confirm this page and your Google Business Profile / social accounts are the same business -- weaker entity trust, even with good schema otherwise.',
      recommendation: 'Add sameAs: [] with links to Google Business Profile, LinkedIn, Facebook, and any other authoritative profile for the business.'
    })
  }

  // --- Check 4: contact/address completeness on the business entity (15 pts) ---
  const contactComplete = businessEntities.some(e => e.instances.some(inst =>
    inst.address && inst.telephone
  ))
  if (contactComplete) {
    score += 15
    evidence.push('Business entity includes both address and telephone.')
    checks.push({ label: 'Address + telephone on business entity', status: 'pass' })
  } else {
    if (businessEntities.length > 0) {
      findings.push('Business entity schema exists but is missing address and/or telephone.')
      recommendations.push('Populate address (PostalAddress) and telephone on the business entity schema.')
      issues.push({
        severity: 'moderate',
        message: 'Business entity schema is missing address and/or telephone.',
        why: 'Missing contact details on the schema itself means AI assistants answering "where is this business" or "how do I contact them" can\'t pull a confirmed answer straight from structured data.',
        recommendation: 'Populate address (PostalAddress) and telephone on the business entity schema.'
      })
    }
    checks.push({ label: 'Address + telephone on business entity', status: 'fail' })
  }

  // --- Check 5: BreadcrumbList (10 pts) ---
  if (schemaNames.includes('BreadcrumbList')) {
    score += 10
    evidence.push('BreadcrumbList schema present.')
    checks.push({ label: 'BreadcrumbList schema', status: 'pass' })
  } else {
    findings.push('No BreadcrumbList schema — a low-effort, still-supported rich-result signal is being left on the table.')
    recommendations.push('Add BreadcrumbList schema (most SEO plugins, incl. Yoast, generate this automatically once breadcrumbs are enabled).')
    checks.push({ label: 'BreadcrumbList schema', status: 'fail' })
    issues.push({
      severity: 'minor',
      message: 'No BreadcrumbList schema found.',
      why: 'A low-effort, still-supported rich-result signal being left on the table -- not urgent, but free upside once the bigger items above are handled.',
      recommendation: 'Add BreadcrumbList schema (most SEO plugins, incl. Yoast, generate this automatically once breadcrumbs are enabled).'
    })
  }

  // --- Check 6: WebSite + SearchAction (5 pts) ---
  const hasSearchAction = (byType.WebSite || []).some(inst => inst.potentialAction)
  if (hasSearchAction) {
    score += 5
    evidence.push('WebSite schema includes a SearchAction (sitelinks searchbox eligibility).')
    checks.push({ label: 'WebSite + SearchAction', status: 'pass' })
  } else {
    checks.push({ label: 'WebSite + SearchAction', status: 'fail' })
  }

  // --- Check 7: required-property validity — no missing required fields (15 pts) ---
  if (failed.length === 0) {
    score += 15
    evidence.push('No missing required schema properties detected.')
    checks.push({ label: 'No missing required schema properties', status: 'pass' })
  } else {
    findings.push(`${failed.length} required schema propert${failed.length === 1 ? 'y' : 'ies'} missing.`)
    recommendations.push('Fill in the missing required properties flagged in evidence.')
    evidence.push(...failed.slice(0, 5).map(f => `MISSING: ${f.description}`))
    checks.push({ label: 'No missing required schema properties', status: 'fail' })
    issues.push({
      severity: failed.length >= 3 ? 'critical' : 'moderate',
      message: `${failed.length} required schema propert${failed.length === 1 ? 'y' : 'ies'} missing: ${failed.slice(0, 5).map(f => f.description).join('; ')}${failed.length > 5 ? ', and more' : ''}.`,
      why: 'A schema block missing required properties can be ignored outright by Google\'s validator rather than partially credited -- this isn\'t a small styling issue, it can invalidate the whole block.',
      recommendation: 'Fill in the missing required properties listed above.'
    })
  }

  score = Math.min(100, score)

  const finding = findings.length > 0
    ? findings.join(' ')
    : 'Valid, complete business-entity structured data detected with no failing checks.'

  const recommendation = recommendations.length > 0
    ? recommendations.join(' ')
    : 'No action needed — maintain current schema as site content changes.'

  return {
    grade: scoreToGrade(score),
    score,
    finding,
    recommendation,
    evidence,
    checks,
    issues,
    _raw: {
      schemasFound: schemaNames,
      failed: failed.length,
      // businessEntityCount/checksTotal/checksPassing back the Diagnosis
      // step's 3 real stat pills (SchemaWizard.js) -- see this function's
      // `checks` array above for checksTotal/checksPassing (always 7 total
      // today; see this file's header) and `businessEntities` for the count.
      businessEntityCount: businessEntities.length,
      checksTotal: checks.length,
      checksPassing: checks.filter(c => c.status === 'pass').length,
      sitemapPageCount,
      // Real sitemap page paths + a cheap real URL-pattern classification
      // (Home/Article/Contact/Uncategorized) -- backs SchemaWizard.js's
      // Page coverage step. null (not []) when the sitemap fetch failed or
      // predates this field, same "absent vs. confirmed empty" contract
      // sitemapPageCount already uses.
      sitemapPages
    }
  }
}

module.exports = { checkSchemaAndStructure, scoreToGrade, BUSINESS_ENTITY_TYPES }
