// Zero-dependency JSON-LD extractor + minimal Google-requirements validator.
//
// Replaces `structured-data-testing-tool` (which pulled in cheerio,
// web-auto-extractor, validator, nth-check, lodash.pick -- 7 high-severity
// npm audit findings between them) with plain regex + JSON.parse, which is
// all we actually need: every client site we've checked (Yoast, Rank Math,
// WPCode/Insert-Headers-and-Footers injections) ships schema as
// <script type="application/ld+json">, never microdata or RDFa. If that
// changes for a given client we can add a parser for it later, but there's
// no reason to carry cheerio's dependency tree for a case we've never seen.

const SCRIPT_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

// Minimal required-property tables for the schema types we actually care
// about grading. Anything not listed here is extracted and reported, just
// not scored against a requirements list -- deliberately narrow rather than
// trying to reimplement Google's full documentation.
const REQUIRED_PROPS = {
  Organization: ['name', 'url'],
  LocalBusiness: ['name', 'address'],
  AccountingService: ['name', 'address'],
  ProfessionalService: ['name', 'address'],
  Attorney: ['name', 'address'],
  BreadcrumbList: ['itemListElement'],
  WebSite: ['name', 'url'],
  Article: ['headline', 'image', 'datePublished'],
  FAQPage: ['mainEntity'],
  Review: ['reviewRating', 'author'],
  AggregateRating: ['ratingValue', 'reviewCount']
}

function typesOf(node) {
  if (!node || !node['@type']) return []
  return Array.isArray(node['@type']) ? node['@type'] : [node['@type']]
}

function hasProp(node, prop) {
  return Object.prototype.hasOwnProperty.call(node, prop) && node[prop] !== null && node[prop] !== ''
}

// Flattens @graph arrays (Yoast's default output shape, among others) into
// standalone nodes so every type inside is checkable individually instead of
// getting lumped together.
//
// scriptCount/parseFailureCount (added 2026-09-03, DIAGNOSTIC METHODOLOGY
// pass) -- until now a malformed <script type="application/ld+json"> block
// silently vanished (the catch just `continue`s), which meant "this page's
// JSON-LD is broken" and "this page has no JSON-LD at all" were
// indistinguishable to every caller -- both just produced an empty `nodes`
// array. That distinction is exactly what the new page-type methodology's
// "structured data parses successfully" CORE check needs (a genuinely
// malformed block is a real, fixable defect; a page with no JSON-LD at all
// is a different, non-broken condition -- see lib/schemaPageTypeChecks.js).
// Purely additive: existing callers destructuring {byType, schemaNames,
// failed} (or anything else) are unaffected.
function extractNodes(html) {
  const nodes = []
  let scriptCount = 0
  let parseFailureCount = 0
  let match
  while ((match = SCRIPT_RE.exec(html)) !== null) {
    scriptCount++
    let parsed
    try {
      parsed = JSON.parse(match[1])
    } catch (e) {
      parseFailureCount++
      continue // skip malformed blocks rather than crash the whole check
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    entries.forEach(entry => {
      if (entry && Array.isArray(entry['@graph'])) {
        entry['@graph'].forEach(node => nodes.push(node))
      } else if (entry) {
        nodes.push(entry)
      }
    })
  }
  return { nodes, scriptCount, parseFailureCount }
}

function parseJsonLd(html) {
  const { nodes, scriptCount, parseFailureCount } = extractNodes(html)
  const byType = {}

  nodes.forEach(node => {
    typesOf(node).forEach(type => {
      if (!byType[type]) byType[type] = []
      byType[type].push(node)
    })
  })

  const failed = []
  const passed = []

  nodes.forEach(node => {
    typesOf(node).forEach(type => {
      const required = REQUIRED_PROPS[type]
      if (!required) return
      required.forEach(prop => {
        if (hasProp(node, prop)) {
          passed.push({ type, prop })
        } else {
          failed.push({ type, prop, test: `${type}."${prop}"`, description: `${type} is missing required property "${prop}"` })
        }
      })
    })
  })

  return {
    nodes,
    byType,
    schemaNames: Object.keys(byType),
    passed,
    failed,
    scriptCount,
    parseFailureCount
  }
}

module.exports = { parseJsonLd, typesOf, hasProp }
