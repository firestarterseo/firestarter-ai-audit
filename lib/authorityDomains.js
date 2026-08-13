// Curated list of third-party domains treated as "high-authority" for AI &
// GEO Visibility scoring.
//
// Per direct client feedback: an independent third party saying good things
// about a business ("Forbes rates us the best SEO company") is a stronger
// signal than the business saying it about itself, and a citation from a
// widely-recognized authority is stronger still than a citation from some
// arbitrary third-party page. This list is the "recognized authority" tier
// -- see ai-visibility-checker.js / ai-visibility-snapshot-checker.js for
// how it's used (any non-owned domain still counts as SOME third-party
// credit even if it's not on this list; matching this list just earns the
// top tier).
//
// Deliberately general-business-leaning to start, since Firestarter's
// clients span many industries and this list can't realistically enumerate
// every industry-specific authority up front (Avvo for attorneys,
// Healthgrades for medical, HomeAdvisor for home services, etc.). Expand
// this list over time as real client citations surface sources worth
// recognizing, rather than trying to guess exhaustively now.
const AUTHORITY_DOMAINS = new Set([
  // General press / business authority
  'forbes.com', 'inc.com', 'entrepreneur.com', 'businessinsider.com',
  'usnews.com', 'nytimes.com', 'wsj.com', 'bloomberg.com', 'reuters.com',
  'techcrunch.com', 'fastcompany.com',
  // Review / ratings platforms
  'yelp.com', 'trustpilot.com', 'g2.com', 'clutch.co', 'bbb.org',
  'angi.com', 'homeadvisor.com', 'avvo.com', 'healthgrades.com',
  'glassdoor.com', 'capterra.com', 'goodfirms.co', 'expertise.com',
  // Reference / directory authority
  'wikipedia.org', 'google.com' // Google Business Profile / Maps listings
])

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e) {
    return null
  }
}

// isAuthorityDomain(url) -> true if the URL's hostname is a recognized
// authority domain, or a subdomain of one (e.g. "maps.google.com").
function isAuthorityDomain(url) {
  const host = hostnameOf(url)
  if (!host) return false
  if (AUTHORITY_DOMAINS.has(host)) return true
  for (const d of AUTHORITY_DOMAINS) {
    if (host.endsWith(`.${d}`)) return true
  }
  return false
}

module.exports = { AUTHORITY_DOMAINS, isAuthorityDomain, hostnameOf }
