// Domains that should NEVER be treated as a "competitor," regardless of how
// often they show up in AI-citation data or Ahrefs organic-competitors
// overlap -- directories, review platforms, press, and social networks are
// not competing businesses, they're places a competing business (or this
// client) might have a LISTING. A citation of yelp.com tells us "some
// business's Yelp profile got cited," not which business, so it's useless
// (and actively misleading) as a competitor-domain signal either way.
//
// This has heavy overlap with lib/authorityDomains.js on purpose -- most
// domains that are a strong THIRD-PARTY CITATION SOURCE (Forbes, G2, Yelp)
// are, for the same underlying reason, not a real competing business.
// Kept as a separate list rather than importing AUTHORITY_DOMAINS directly,
// since the two lists serve different questions ("is this citation
// authoritative" vs "is this domain a real business we should compare
// against") and may diverge over time -- e.g. a niche industry directory
// could reasonably be added here without belonging on the authority list,
// or vice versa.
const { AUTHORITY_DOMAINS } = require('./authorityDomains')

const SOCIAL_AND_GENERIC_PLATFORM_DOMAINS = new Set([
  // Social / video platforms -- a business's social profile, not its site
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'nextdoor.com', 'reddit.com',
  // Generic directories / search / mapping -- aggregators, not businesses
  'yellowpages.com', 'superpages.com', 'manta.com', 'mapquest.com',
  'bing.com', 'chamberofcommerce.com', 'foursquare.com', 'apple.com'
])

// Agency directories, B2B data brokers, and local press -- found 2026-08-13
// via real Firestarter SEO citation data. Each of these got auto-detected
// as a "competitor" even though the actual citation was either a roundup
// article naming several agencies (builtincolorado.com, agencies.semrush.com
// -- Semrush's own agency directory subdomain) or a directory/press PROFILE
// of Firestarter itself (designrush.com, zoominfo.com, techfinder.net,
// coloradoan.com's feature article) -- i.e. evidence the client showed up
// somewhere, not evidence of a distinct competing business at that domain.
// See competitorDetection.js's brand-slug-in-URL heuristic for the
// generalizable half of this fix -- it independently catches the
// profile/press-mention cases; this static list is still needed for
// roundup-article domains where the citation URL never contains the
// client's own name at all (builtincolorado.com, agencies.semrush.com).
// This list will need similar one-off additions as other clients in other
// cities surface their own local newspaper/directory -- there's no fully
// general way to detect "this is press/a directory" from the URL alone.
const AGENCY_DIRECTORY_AND_PRESS_DOMAINS = new Set([
  'designrush.com', 'zoominfo.com', 'techfinder.net',
  'agencies.semrush.com', 'coloradoan.com'
])

const NON_COMPETITOR_DOMAINS = new Set([
  ...AUTHORITY_DOMAINS,
  ...SOCIAL_AND_GENERIC_PLATFORM_DOMAINS,
  ...AGENCY_DIRECTORY_AND_PRESS_DOMAINS
])

// Domain-shaped patterns, not just exact hostnames -- "Built In" runs one
// tech-company/jobs directory per metro area (builtincolorado.com,
// builtinboston.com, builtinaustin.com, ...), all the same underlying
// directory, not a competing business. A flat list would need a new entry
// every time a client in a new city surfaces a different regional edition;
// this pattern catches the whole network at once.
const NON_COMPETITOR_DOMAIN_PATTERNS = [
  /^builtin[a-z]+\.com$/
]

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e) {
    return null
  }
}

// normalizeDomain(domain) -> hostname, accepting either a bare domain
// ("www.firestarterseo.com") or a full URL. Client records in this
// project store `domain` inconsistently -- sometimes with a leading
// "www.", sometimes without (confirmed directly against real rows:
// Firestarter SEO's is "www.firestarterseo.com", Denver SEO Pros' is
// "denverseopro.com") -- so any code comparing a citation's hostnameOf()
// (which always strips "www.") against a raw client.domain string has to
// normalize client.domain the same way first, or a client's own domain
// silently fails to match itself and gets detected as its own
// "competitor" (a real bug found 2026-08-13 via exactly that mismatch).
function normalizeDomain(domain) {
  if (!domain) return null
  const withProtocol = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
  return hostnameOf(withProtocol)
}

// isNonCompetitorDomain(url) -> true if this URL's hostname is a known
// directory/press/social/review platform (or a subdomain/pattern-match of
// one) -- i.e. NOT a candidate for "this is a competing business's own
// site."
function isNonCompetitorDomain(url) {
  const host = hostnameOf(url)
  if (!host) return true // an unparseable URL can't be a usable competitor domain either
  if (NON_COMPETITOR_DOMAINS.has(host)) return true
  for (const d of NON_COMPETITOR_DOMAINS) {
    if (host.endsWith(`.${d}`)) return true
  }
  return NON_COMPETITOR_DOMAIN_PATTERNS.some(p => p.test(host))
}

module.exports = { NON_COMPETITOR_DOMAINS, isNonCompetitorDomain, hostnameOf, normalizeDomain }
