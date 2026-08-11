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

const BUSINESS_ENTITY_TYPES = [
  'LocalBusiness', 'Organization', 'AccountingService', 'ProfessionalService',
  'Attorney', 'Dentist', 'Physician', 'Restaurant', 'Store', 'HomeAndConstructionBusiness',
  'LegalService', 'FinancialService', 'InsuranceAgency', 'RealEstateAgent',
  'AutoRepair', 'MedicalBusiness', 'Plumber', 'Electrician', 'HVACBusiness',
  'RoofingContractor', 'GeneralContractor'
]

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

async function resolveHtml(htmlOrUrl) {
  const trimmed = htmlOrUrl.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    const res = await fetch(trimmed, { headers: { 'User-Agent': 'FirestarterAIAudit/1.0' } })
    if (!res.ok) {
      const err = new Error(`Fetch failed: HTTP ${res.status}`)
      err.type = 'FETCH_FAILED'
      throw err
    }
    return res.text()
  }
  return trimmed
}

async function checkSchemaAndStructure(htmlOrUrl) {
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

  const evidence = []
  const findings = []
  const recommendations = []
  const checks = []
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
    _raw: { schemasFound: schemaNames, failed: failed.length }
  }
}

module.exports = { checkSchemaAndStructure, scoreToGrade }
