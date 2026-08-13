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

const NON_COMPETITOR_DOMAINS = new Set([...AUTHORITY_DOMAINS, ...SOCIAL_AND_GENERIC_PLATFORM_DOMAINS])

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e) {
    return null
  }
}

// isNonCompetitorDomain(url) -> true if this URL's hostname is a known
// directory/press/social/review platform (or a subdomain of one) -- i.e.
// NOT a candidate for "this is a competing business's own site."
function isNonCompetitorDomain(url) {
  const host = hostnameOf(url)
  if (!host) return true // an unparseable URL can't be a usable competitor domain either
  if (NON_COMPETITOR_DOMAINS.has(host)) return true
  for (const d of NON_COMPETITOR_DOMAINS) {
    if (host.endsWith(`.${d}`)) return true
  }
  return false
}

module.exports = { NON_COMPETITOR_DOMAINS, isNonCompetitorDomain, hostnameOf }
