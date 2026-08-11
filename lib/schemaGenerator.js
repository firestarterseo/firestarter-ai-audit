// Schema Generator -- Phase 2 of the original "AI-Ready Roadmap" plan (see
// ROADMAP.md), built from the shared core out to the manual delivery path
// first (Phase 3b: downloadable JSON / copy-ready <script> snippet), not
// the WordPress plugin path (Phase 3a) -- the plugin needs its own install/
// distribution/auth story and is a separate, later build.
//
// Why this, now: cross-referencing the old Grader's 85-client baseline
// spreadsheet (AI Audits 3.xlsx), a schema-related recommendation shows up
// in 83 of 85 clients' "Top Opportunities," 59 specifically flagging a
// missing LocalBusiness/Organization entity -- the single most common gap
// across the whole roster. This closes that gap directly instead of just
// reporting it.
//
// FAQPage is deliberately NOT generated here, even though 62/85 of those
// same old recommendations mention it. Two independent reasons, not one:
// (1) it needs real per-page Q&A content, not just business facts, so it's
// a fundamentally different (bigger) generator than this one; (2) research
// done for this decision (2026-08-11) found no confirmed AI-citation
// benefit for FAQPage markup specifically -- a matched-control Ahrefs study
// (~1,885 pages, 30 days, published days after Google's May 2026 FAQ
// rich-result deprecation) found no significant ChatGPT/AI-Mode citation
// change from adding it, and Otterly.ai's parallel test found no AI
// platform could answer a question whose answer existed ONLY in FAQ schema
// -- consistent with this project's own earlier finding (see ROADMAP.md)
// that LLMs tokenize JSON-LD as plain text rather than parsing it
// specially. The generator only builds schema types with a confirmed real
// payoff: the business entity itself, which both Google rich results and
// entity disambiguation genuinely depend on.
//
// Only ever builds types this project's OWN checker (checker.js) actually
// recognizes and scores -- BUSINESS_ENTITY_TYPES is imported, not
// duplicated, specifically so generated schema and graded schema can never
// drift out of sync (unlike ai-visibility-checker.js's deliberate
// ENGINE_WEIGHTS duplication, which exists for a different reason --
// decoupling two independent checkers, not round-tripping through the same
// one).

const { checkSchemaAndStructure, BUSINESS_ENTITY_TYPES } = require('./checkers/checker')

function resolveSchemaType(client) {
  return BUSINESS_ENTITY_TYPES.includes(client?.schema_type) ? client.schema_type : 'LocalBusiness'
}

// buildAddress(client) -> PostalAddress node | null
// null (not an empty object) when there's nothing to put in it at all --
// an empty PostalAddress node would be worse than no address property,
// since checker.js's contact-completeness check just looks for `address`
// truthiness, not whether it's actually populated.
function buildAddress(client) {
  const hasAny = client.street_address || client.city || client.region || client.postal_code
  if (!hasAny) return null
  const address = { '@type': 'PostalAddress' }
  if (client.street_address) address.streetAddress = client.street_address
  if (client.city) address.addressLocality = client.city
  if (client.region) address.addressRegion = client.region
  if (client.postal_code) address.postalCode = client.postal_code
  // Every client in this roster is a US-based local business (Denver-area
  // agency) -- there's no country field to ask for, and defaulting here is
  // lower-friction than adding one for a value that's never actually
  // varied in practice. Worth revisiting if a non-US client ever shows up.
  address.addressCountry = 'US'
  return address
}

// generateBusinessSchema(client) -> { jsonLd, missingFields }
// `client` is a row from the `clients` table (name, url, city, region,
// street_address, postal_code, phone, description, same_as, schema_type).
// missingFields is deliberately advisory, not blocking -- even a bare
// name+url Organization node is valid, real schema and strictly better
// than the "no structured data at all" state 83/85 clients started in; the
// UI uses this list to nudge toward a more complete node, not to refuse to
// generate one.
function generateBusinessSchema(client) {
  const type = resolveSchemaType(client)
  const address = buildAddress(client)
  const sameAs = Array.isArray(client.same_as) ? client.same_as.filter(Boolean) : []

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': type,
    name: client.name,
    url: client.url
  }
  if (client.description) jsonLd.description = client.description
  if (client.phone) jsonLd.telephone = client.phone
  if (address) jsonLd.address = address
  if (sameAs.length > 0) jsonLd.sameAs = sameAs

  const missingFields = []
  if (!address) missingFields.push('street address / city / region')
  if (!client.phone) missingFields.push('phone number')
  if (sameAs.length === 0) missingFields.push('sameAs links (Google Business Profile, social profiles)')

  return { jsonLd, missingFields }
}

// toScriptSnippet(jsonLd) -> string
// Exactly what a developer pastes into WPCode / Insert Headers & Footers /
// Wix Custom Code per the original plan's manual delivery path -- ready to
// use as-is, no reformatting needed.
function toScriptSnippet(jsonLd) {
  return `<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>`
}

// previewGrade(jsonLd) -> shared pillar output contract (grade/score/checks/...)
// "Checked before it ever ships," per the original plan -- runs the exact
// generated markup through this project's own Schema & Structure checker
// (wrapped in the minimal HTML shell it expects) so a strategist sees the
// real grade this schema would earn before handing it to a client, using
// the same verify-don't-guess logic as every other pillar rather than a
// second, separate validator that could drift from what actually gets
// graded later.
async function previewGrade(jsonLd) {
  const html = `<html><head>${toScriptSnippet(jsonLd)}</head><body></body></html>`
  return checkSchemaAndStructure(html)
}

module.exports = { generateBusinessSchema, toScriptSnippet, previewGrade, resolveSchemaType }
